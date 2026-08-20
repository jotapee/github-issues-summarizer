import type {
  CommentDigest,
  Issue,
  IssueDigest,
  StoredResult,
  UpdateDelta,
} from './types';

/**
 * The Updates Checker. Deterministic: it diffs a freshly fetched delta of
 * issues against what is already stored and describes the movement in prose
 * for the coherence checker and composer to consume.
 */
export function checkUpdates(stored: StoredResult, changed: Issue[]): UpdateDelta {
  const knownNumbers = new Set(stored.bodyDigests.map((d) => d.number));

  const newIssues = changed.filter((i) => !knownNumbers.has(i.number)).map((i) => i.number);
  const changedIssues = changed.filter((i) => knownNumbers.has(i.number)).map((i) => i.number);

  const parts: string[] = [];
  if (newIssues.length) {
    parts.push(`${newIssues.length} issue(s) opened since the last run: ${newIssues.map((n) => `#${n}`).join(', ')}.`);
  }
  if (changedIssues.length) {
    parts.push(`${changedIssues.length} existing issue(s) saw new activity: ${changedIssues.map((n) => `#${n}`).join(', ')}.`);
  }
  if (!parts.length) {
    parts.push('No issues changed since the last run.');
  }
  parts.push(`Previous summary generated ${stored.generatedAt.slice(0, 10)}.`);

  return { changedIssues, newIssues, narrative: parts.join(' ') };
}

/** Replaces stored digests for re-summarised issues, keeping the rest. */
export function mergeDigests<T extends { number: number }>(previous: T[], fresh: T[]): T[] {
  const byNumber = new Map(previous.map((d) => [d.number, d]));
  for (const item of fresh) byNumber.set(item.number, item);
  return [...byNumber.values()].sort((a, b) => b.number - a.number);
}

/** Drops digests for issues that are no longer open. */
export function pruneClosed<T extends { number: number }>(digests: T[], openNumbers: Set<number>): T[] {
  return digests.filter((d) => openNumbers.has(d.number));
}
