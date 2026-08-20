import type { CoherenceReport, CommentDigest, Issue, IssueDigest, UpdateDelta } from '../types';
import { REASONING_MODEL, callJson } from './client';

const SYSTEM = `You are a fact-checker sitting between two summarisation stages and a final composer.

You receive the ground-truth issue list (numbers, titles, labels) plus two sets of machine-generated digests:
- "l1" digests of issue titles and bodies
- "l2" digests of comment threads

Flag a problem ONLY when a digest is demonstrably wrong against the ground truth or contradicts the other stage. Report:
- a digest whose content clearly does not match the issue title/labels it claims to describe
- an l1 and l2 digest for the same issue that assert contradictory things
- a digest that asserts a specific fact (a version, a decision, a cause) that has no basis in the material shown
- a severity or kind that is plainly wrong given the title and labels

Do NOT flag: terseness, style, missing nuance, a null consensus, empty blockers, or a digest simply being brief. Those are correct behaviour.
Be conservative. An empty problems list is the expected result for a healthy run.

Respond with JSON: {"ok": bool, "problems": [{"stage": "l1"|"l2", "number": int, "problem": str}]}
"ok" is true exactly when "problems" is empty. Cap problems at 12, most serious first.`;

function renderGroundTruth(issues: Issue[]): string {
  return issues
    .map((i) => {
      const labels = i.labels.length ? ` [${i.labels.join(', ')}]` : '';
      return `#${i.number}: ${i.title}${labels} (${i.commentCount} comments)`;
    })
    .join('\n');
}

/** LLM 3, the coherence checker. */
export async function checkCoherence(
  apiKey: string,
  issues: Issue[],
  bodyDigests: IssueDigest[],
  commentDigests: CommentDigest[],
  delta?: UpdateDelta,
): Promise<CoherenceReport> {
  // Digests that failed to generate are already recorded as failures. Sending
  // them to the evaluator would only produce noise.
  const checkableBodies = bodyDigests.filter((d) => !d.failed);
  const checkableComments = commentDigests.filter((d) => !d.failed);
  if (!checkableBodies.length && !checkableComments.length) {
    return { ok: true, problems: [] };
  }

  const deltaNote = delta
    ? `\n\nThis run is an incremental update. What changed since the last summary:\n${delta.narrative}\nOnly issues ${delta.changedIssues.concat(delta.newIssues).join(', ') || '(none)'} were re-summarised; the rest are carried over from a previous verified run and should not be flagged.`
    : '';

  const raw = await callJson<unknown>({
    apiKey,
    model: REASONING_MODEL,
    system: SYSTEM,
    user: `GROUND TRUTH, open issues:
${renderGroundTruth(issues)}

L1 DIGESTS (title and body):
${JSON.stringify(checkableBodies)}

L2 DIGESTS (comment threads):
${JSON.stringify(checkableComments)}${deltaNote}`,
    maxTokens: 1500,
    temperature: 0,
  });

  const payload = raw as { ok?: unknown; problems?: unknown };
  const known = new Set(issues.map((i) => i.number));
  const problems = Array.isArray(payload.problems)
    ? payload.problems.flatMap((entry): CoherenceReport['problems'] => {
        const item = entry as Record<string, unknown>;
        const number = Number(item.number);
        const stage = String(item.stage ?? '').toLowerCase();
        const problem = String(item.problem ?? '').trim();
        if (!known.has(number) || (stage !== 'l1' && stage !== 'l2') || !problem) return [];
        return [{ stage: stage as 'l1' | 'l2', number, problem }];
      })
    : [];

  // Derive `ok` from the problems list rather than trusting the model's flag.
  return { ok: problems.length === 0, problems };
}

/** Turns flagged problems into a correction note for a re-run of LLM 1 or 2. */
export function feedbackFor(report: CoherenceReport, stage: 'l1' | 'l2'): string | undefined {
  const relevant = report.problems.filter((p) => p.stage === stage);
  if (!relevant.length) return undefined;
  return relevant.map((p) => `- Issue #${p.number}: ${p.problem}`).join('\n');
}
