import type { CommentDigest, Issue } from '../types';
import { SCOUT_MODEL, batch, callJson, runBatches } from './client';

/** Comment threads are bulkier than bodies, so smaller batches than LLM 1. */
const BATCH_SIZE = 6;

const SYSTEM = `You are reading GitHub issue comment threads to extract what the discussion actually concluded.

For every thread you are given, produce one digest. Rules:
- "discussion": one or two sentences, max 40 words, on where the conversation went. Focus on decisions, diagnoses and workarounds, not on who was polite.
- "consensus": the agreed outcome if the thread reached one (e.g. "confirmed as a regression in 2.4, fix planned"), otherwise null. Do not manufacture agreement that is not there.
- "blockers": concrete things preventing progress, as short phrases. Empty array if none.
- "openQuestions": questions the thread raised and did not answer, as short phrases. Empty array if none.
- Never use em dashes. Use commas, colons, or separate sentences instead.
- Only report what the comments say. Never speculate about the fix.
- Echo the issue "number" exactly as given.

Respond with JSON: {"digests": [{"number": int, "discussion": str, "consensus": str|null, "blockers": [str], "openQuestions": [str]}]}
Return one entry for every thread given.`;

function renderThread(issue: Issue): string {
  const shown = issue.comments.length;
  const hidden = Math.max(0, issue.commentCount - shown);
  const note = hidden > 0 ? ` (showing the most recent ${shown} of ${issue.commentCount})` : '';
  const thread = issue.comments
    .map((c) => `@${c.author} (${c.createdAt.slice(0, 10)}): ${c.body}`)
    .join('\n---\n');

  return `### Issue #${issue.number}: ${issue.title}${note}
${thread}`;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter(Boolean).slice(0, 5);
}

function coerce(raw: unknown, known: Set<number>): CommentDigest[] {
  const list = (raw as { digests?: unknown }).digests;
  if (!Array.isArray(list)) return [];

  return list.flatMap((entry): CommentDigest[] => {
    const item = entry as Record<string, unknown>;
    const number = Number(item.number);
    if (!Number.isInteger(number) || !known.has(number)) return [];
    const consensus = item.consensus == null ? null : String(item.consensus).trim() || null;
    return [
      {
        number,
        discussion: String(item.discussion ?? '').trim() || '(no discussion summary produced)',
        consensus,
        blockers: toStringArray(item.blockers),
        openQuestions: toStringArray(item.openQuestions),
      },
    ];
  });
}

/** See the equivalent note in l1-issues.ts. */
function unavailable(issue: Issue): CommentDigest {
  return {
    number: issue.number,
    discussion: 'Discussion summary unavailable: this thread could not be processed.',
    consensus: null,
    blockers: [],
    openQuestions: [],
    failed: true,
  };
}

/**
 * LLM 2, the comment thread scout. Issues with no comments are skipped
 * entirely rather than sent as empty prompts.
 */
export async function summariseComments(
  apiKey: string,
  issues: Issue[],
  feedback?: string,
): Promise<CommentDigest[]> {
  const discussed = issues.filter((i) => i.comments.length > 0);
  if (!discussed.length) return [];

  const groups = batch(discussed, BATCH_SIZE);
  const correction = feedback
    ? `\n\nA reviewer flagged problems with your previous attempt. Fix these:\n${feedback}`
    : '';

  const { results, failed, firstError } = await runBatches(groups, async (group) => {
    const known = new Set(group.map((i) => i.number));
    const raw = await callJson<unknown>({
      apiKey,
      model: SCOUT_MODEL,
      system: SYSTEM,
      user: `Summarise these ${group.length} comment threads.${correction}\n\n${group.map(renderThread).join('\n\n')}`,
      maxTokens: 2400,
    });
    return coerce(raw, known);
  });

  if (failed.length === discussed.length) {
    throw firstError instanceof Error
      ? firstError
      : new Error('Every comment batch failed to summarise.');
  }

  const covered = new Set(results.map((d) => d.number));
  const placeholders = discussed.filter((i) => !covered.has(i.number)).map(unavailable);

  return [...results, ...placeholders];
}
