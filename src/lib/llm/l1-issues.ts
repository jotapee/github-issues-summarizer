import type { Issue, IssueDigest } from '../types';
import { batch, callJson, runBatches } from './client';

/** Issues per prompt. Keeps each request well inside the context window. */
const BATCH_SIZE = 12;

const SYSTEM = `You are a triage analyst reading GitHub issue titles and bodies.

For every issue you are given, produce one compact digest. Rules:
- "gist": one sentence, max 25 words, describing what the issue is actually about. No preamble, no "This issue...". Write it so a maintainer skimming 100 of these understands the problem.
- "theme": 2-4 words naming the area of the codebase or product this touches (e.g. "auth flow", "windows build", "docs examples"). Reuse the same wording across issues that belong together, because themes are grouped downstream.
- "kind": one of bug, feature, question, docs, chore, other.
- "severity": low, medium, or high. Judge by user impact described in the issue, not by tone. Data loss, crashes, and security get high. Cosmetic and nice-to-haves get low.
- Never use em dashes. Use commas, colons, or separate sentences instead.
- Never invent detail that is not in the text. If a body is empty, base the digest on the title alone.
- Echo the issue "number" exactly as given.

Respond with JSON: {"digests": [{"number": int, "gist": str, "theme": str, "kind": str, "severity": str}]}
Return one entry for every issue given, in the same order.`;

function renderIssue(issue: Issue): string {
  const labels = issue.labels.length ? `\nLabels: ${issue.labels.join(', ')}` : '';
  const body = issue.body || '(empty body)';
  return `### Issue #${issue.number}
Title: ${issue.title}${labels}
Body:
${body}`;
}

const KINDS = new Set(['bug', 'feature', 'question', 'docs', 'chore', 'other']);
const SEVERITIES = new Set(['low', 'medium', 'high']);

function coerce(raw: unknown, known: Set<number>): IssueDigest[] {
  const list = (raw as { digests?: unknown }).digests;
  if (!Array.isArray(list)) return [];

  return list.flatMap((entry): IssueDigest[] => {
    const item = entry as Record<string, unknown>;
    const number = Number(item.number);
    // Guard against the model inventing issue numbers.
    if (!Number.isInteger(number) || !known.has(number)) return [];
    const kind = String(item.kind ?? '').toLowerCase();
    const severity = String(item.severity ?? '').toLowerCase();
    return [
      {
        number,
        gist: String(item.gist ?? '').trim() || '(no summary produced)',
        theme: String(item.theme ?? 'general').trim().toLowerCase() || 'general',
        kind: (KINDS.has(kind) ? kind : 'other') as IssueDigest['kind'],
        severity: (SEVERITIES.has(severity) ? severity : 'medium') as IssueDigest['severity'],
      },
    ];
  });
}

/**
 * Placeholder recorded when an issue produces no digest, either because its
 * batch failed or because the model omitted it from the response. DESIGN.md
 * section 8: record the failure and continue.
 */
function unavailable(issue: Issue): IssueDigest {
  return {
    number: issue.number,
    gist: 'Summary unavailable: this issue could not be processed.',
    theme: 'unclassified',
    kind: 'other',
    severity: 'medium',
    failed: true,
  };
}

/**
 * LLM 1, the title and body scout.
 * `feedback` carries corrections from the coherence checker on a retry pass.
 */
export async function summariseIssues(
  apiKey: string,
  issues: Issue[],
  feedback?: string,
): Promise<IssueDigest[]> {
  if (!issues.length) return [];

  const groups = batch(issues, BATCH_SIZE);
  const correction = feedback
    ? `\n\nA reviewer flagged problems with your previous attempt. Fix these:\n${feedback}`
    : '';

  const { results, failed, firstError } = await runBatches(groups, async (group) => {
    const known = new Set(group.map((i) => i.number));
    const raw = await callJson<unknown>({
      apiKey,
      stage: 'issues',
      system: SYSTEM,
      user: `Summarise these ${group.length} issues.${correction}\n\n${group.map(renderIssue).join('\n\n')}`,
      maxTokens: 2400,
    });
    return coerce(raw, known);
  });

  // Every batch failing is systemic (bad key, model outage) rather than a
  // per-issue problem, so it must surface instead of yielding empty summaries.
  if (failed.length === issues.length) {
    throw firstError instanceof Error
      ? firstError
      : new Error('Every issue batch failed to summarise.');
  }

  // Fill gaps for failed batches and for issues the model silently skipped.
  const covered = new Set(results.map((d) => d.number));
  const placeholders = issues.filter((i) => !covered.has(i.number)).map(unavailable);

  return [...results, ...placeholders];
}
