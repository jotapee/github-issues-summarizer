import { MAX_ISSUES, RepoNotFoundError, fetchRepoSnapshot } from './github';
import { scoreHealth } from './health';
import { checkCoherence, feedbackFor } from './llm/l3-coherence';
import { composeSummary } from './llm/l4-composer';
import { summariseIssues } from './llm/l1-issues';
import { summariseComments } from './llm/l2-comments';
import { parseRepoInput } from './repo-url';
import { getEnv, readStored, writeStored } from './storage';
import { checkUpdates, mergeDigests, pruneClosed } from './updater';
import type {
  CommentDigest,
  Issue,
  IssueDigest,
  PipelineEvent,
  RepoSnapshot,
  StoredResult,
  UpdateDelta,
} from './types';

/** How many times the coherence checker may bounce work back to LLM 1 / 2. */
const MAX_COHERENCE_PASSES = 2;

export class PipelineError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'PipelineError';
    this.status = status;
  }
}

type Emit = (event: PipelineEvent) => void;

interface Secrets {
  githubToken: string;
  openaiKey: string;
}

async function loadSecrets(): Promise<Secrets> {
  let cfEnv: { GITHUB_TOKEN?: string; OPENAI_API_KEY?: string } = {};
  try {
    cfEnv = await getEnv();
  } catch {
    // Fall through to process.env.
  }

  const githubToken = cfEnv.GITHUB_TOKEN ?? process.env.GITHUB_TOKEN ?? '';
  const openaiKey = cfEnv.OPENAI_API_KEY ?? process.env.OPENAI_API_KEY ?? '';

  if (!githubToken) {
    throw new PipelineError('GITHUB_TOKEN is not configured on the server.', 500);
  }
  if (!openaiKey) {
    throw new PipelineError('OPENAI_API_KEY is not configured on the server.', 500);
  }
  return { githubToken, openaiKey };
}

/**
 * LLM 1 and LLM 2 run concurrently, then LLM 3 checks them. Anything LLM 3
 * flags is re-summarised (only the flagged issues, not the whole batch)
 * and re-checked, up to MAX_COHERENCE_PASSES times.
 */
async function scoutAndVerify(
  openaiKey: string,
  issues: Issue[],
  emit: Emit,
  seed?: { bodyDigests: IssueDigest[]; commentDigests: CommentDigest[]; subset: Issue[] },
  delta?: UpdateDelta,
): Promise<{ bodyDigests: IssueDigest[]; commentDigests: CommentDigest[] }> {
  const target = seed?.subset ?? issues;

  emit({
    type: 'stage',
    stage: 'scout-llm',
    detail: `Summarising ${target.length} issue${target.length === 1 ? '' : 's'} and their discussions…`,
  });

  const [freshBodies, freshComments] = await Promise.all([
    summariseIssues(openaiKey, target),
    summariseComments(openaiKey, target),
  ]);

  let bodyDigests = seed ? mergeDigests(seed.bodyDigests, freshBodies) : freshBodies;
  let commentDigests = seed ? mergeDigests(seed.commentDigests, freshComments) : freshComments;

  for (let pass = 0; pass < MAX_COHERENCE_PASSES; pass++) {
    emit({ type: 'stage', stage: 'coherence', detail: 'Checking the summaries against the source…' });
    const report = await checkCoherence(openaiKey, issues, bodyDigests, commentDigests, delta);
    if (report.ok) break;

    const flagged = new Set(report.problems.map((p) => p.number));
    const toRedo = issues.filter((i) => flagged.has(i.number));
    if (!toRedo.length) break;

    emit({
      type: 'stage',
      stage: 'coherence-retry',
      detail: `Re-summarising ${toRedo.length} issue${toRedo.length === 1 ? '' : 's'} the checker flagged…`,
    });

    const l1Feedback = feedbackFor(report, 'l1');
    const l2Feedback = feedbackFor(report, 'l2');
    const [redoBodies, redoComments] = await Promise.all([
      l1Feedback ? summariseIssues(openaiKey, toRedo, l1Feedback) : Promise.resolve([]),
      l2Feedback ? summariseComments(openaiKey, toRedo, l2Feedback) : Promise.resolve([]),
    ]);

    bodyDigests = mergeDigests(bodyDigests, redoBodies);
    commentDigests = mergeDigests(commentDigests, redoComments);
  }

  const byNumberDesc = <T extends { number: number }>(list: T[]) =>
    [...list].sort((a, b) => b.number - a.number);

  // Partial failures are reported rather than hidden (DESIGN.md section 8).
  const unavailable = bodyDigests.filter((d) => d.failed).length;
  if (unavailable > 0) {
    emit({
      type: 'stage',
      stage: 'partial',
      detail: `${unavailable} issue${unavailable === 1 ? '' : 's'} could not be summarised and ${unavailable === 1 ? 'is' : 'are'} excluded from the briefing.`,
    });
  }

  return { bodyDigests: byNumberDesc(bodyDigests), commentDigests: byNumberDesc(commentDigests) };
}

async function build(
  secrets: Secrets,
  snapshot: RepoSnapshot,
  bodyDigests: IssueDigest[],
  commentDigests: CommentDigest[],
  emit: Emit,
  delta?: UpdateDelta,
): Promise<StoredResult> {
  // Scored in code before the composer runs, so the model explains a number
  // it cannot change (DESIGN.md section 7).
  const health = scoreHealth(snapshot.meta, snapshot.issues, bodyDigests);
  emit({
    type: 'stage',
    stage: 'score',
    detail: `Maintenance health scored ${health.score}/100 (${health.grade}).`,
  });

  emit({ type: 'stage', stage: 'compose', detail: 'Composing the TL;DR…' });

  const summary = await composeSummary(
    secrets.openaiKey,
    snapshot.ref,
    snapshot.meta,
    snapshot.issues,
    bodyDigests,
    commentDigests,
    health,
    delta,
  );

  const result: StoredResult = {
    slug: snapshot.ref.slug,
    ref: snapshot.ref,
    meta: snapshot.meta,
    generatedAt: new Date().toISOString(),
    lastSyncedAt: snapshot.fetchedAt,
    issueCount: snapshot.issues.length,
    health,
    bodyDigests,
    commentDigests,
    summary,
  };

  emit({ type: 'stage', stage: 'store', detail: 'Caching the result…' });
  await writeStored(result);

  return result;
}

/**
 * The Router. Decides between the Scout path (never seen this repo) and the
 * Updater path (we have a stored summary), then drives the LLM chain.
 */
export async function runPipeline(
  input: string,
  emit: Emit,
  options: { allowPaidWork?: boolean } = {},
): Promise<{ result: StoredResult; cached: boolean }> {
  const allowPaidWork = options.allowPaidWork ?? true;

  const ref = parseRepoInput(input);
  if (!ref) {
    throw new PipelineError('That does not look like a GitHub repository URL.', 400);
  }

  emit({ type: 'stage', stage: 'route', detail: `Looking up ${ref.owner}/${ref.repo}…` });
  const stored = await readStored(ref.slug);

  // Over quota: a stored summary costs nothing to serve, so serve it rather
  // than refusing. Anything that would call GitHub or a model is refused.
  if (!allowPaidWork) {
    if (stored) {
      emit({ type: 'stage', stage: 'unchanged', detail: 'Serving the stored summary.' });
      return { result: stored, cached: true };
    }
    throw new PipelineError(
      'Rate limit reached: too many new summaries this hour. Repositories already summarised still work.',
      429,
    );
  }

  const secrets = await loadSecrets();

  emit({
    type: 'stage',
    stage: stored ? 'updater' : 'scout',
    detail: stored
      ? 'Found a cached summary. Checking GitHub for new activity…'
      : `Fetching up to ${MAX_ISSUES} open issues from GitHub…`,
  });

  let snapshot: RepoSnapshot;
  try {
    snapshot = await fetchRepoSnapshot(ref, secrets.githubToken);
  } catch (error) {
    if (error instanceof RepoNotFoundError) throw new PipelineError(error.message, 404);
    throw new PipelineError((error as Error).message, 502);
  }

  if (!snapshot.issues.length) {
    throw new PipelineError(
      `${ref.owner}/${ref.repo} has no open issues to summarise.`,
      404,
    );
  }

  // --- Scout path: nothing stored, summarise everything. ---
  if (!stored) {
    const { bodyDigests, commentDigests } = await scoutAndVerify(
      secrets.openaiKey,
      snapshot.issues,
      emit,
    );
    const result = await build(secrets, snapshot, bodyDigests, commentDigests, emit);
    return { result, cached: false };
  }

  // --- Updater path: diff against what we already summarised. ---
  const changed = snapshot.issues.filter((i) => i.updatedAt > stored.lastSyncedAt);
  const openNumbers = new Set(snapshot.issues.map((i) => i.number));
  const carriedBodies = pruneClosed(stored.bodyDigests, openNumbers);
  const carriedComments = pruneClosed(stored.commentDigests, openNumbers);
  const closedCount = stored.bodyDigests.length - carriedBodies.length;

  if (!changed.length && !closedCount) {
    emit({ type: 'stage', stage: 'unchanged', detail: 'Nothing has changed, so serving the stored summary.' });
    return { result: stored, cached: true };
  }

  const delta = checkUpdates(stored, changed);
  emit({ type: 'stage', stage: 'delta', detail: delta.narrative });

  const { bodyDigests, commentDigests } = await scoutAndVerify(
    secrets.openaiKey,
    snapshot.issues,
    emit,
    { bodyDigests: carriedBodies, commentDigests: carriedComments, subset: changed },
    delta,
  );

  const result = await build(secrets, snapshot, bodyDigests, commentDigests, emit, delta);
  return { result, cached: false };
}
