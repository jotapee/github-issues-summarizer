import {
  dedupeThemeIssues,
  findNonSubjectThemes,
  linkIssueRefs,
  renderMarkdown,
  stripEmDashes,
} from '../markdown';
import type {
  CommentDigest,
  HealthScore,
  Issue,
  IssueDigest,
  RepoMeta,
  RepoRef,
  Summary,
  UpdateDelta,
} from '../types';
import { callJson } from './client';

const SYSTEM = `You are writing the assessment that a developer reads before depending on a repository. The question they are answering is "is this project being looked after, and what am I walking into".

You get a precomputed maintenance health score, per-issue digests and per-thread digests. Write Markdown with exactly these sections:

The two opening blocks have strictly separate jobs. Verdict is about the *health of the maintenance*. TL;DR is about the *content of the tracker*. They must not share a sentence or make the same point twice. If one of them has little to say, make it shorter rather than borrowing from the other.

## Verdict
Two or three sentences on maintenance health only. State the score and grade exactly as given, say whether the project is well looked after, and name the single biggest weakness using the component that lost the most points. Never recompute or adjust the score, and never invent component numbers. If a caveat is supplied, work the most important one into the prose rather than listing it.
Write only about upkeep: resolution, backlog movement, responsiveness, activity. Do not describe what the issues are about, do not name themes, and do not mention specific issue numbers. That is the TL;DR's job.

## TL;DR
Two or three sentences on what is actually happening in the tracker right now. Name the dominant themes and the single most pressing item. Do not restate the verdict, the score, the grade, or any judgement about how well maintained the project is. Assume the reader has just read the verdict and does not want it repeated. No bullet points here.

## Main themes
Four to six themes that genuinely partition the issues, each a "### " heading. Under each: two or three sentences synthesising the issues in it, then a line "Issues: #12, #34, #56" listing the relevant numbers. Order themes by how much of the tracker they account for.
This section is a partition, not a set of tags. Build it like this: choose four to six subject areas, then walk the issue list once and drop each issue into the single area that fits it best. An issue you have already placed is used up and cannot appear again. It is correct to leave an issue out of the themes entirely if it fits nowhere; it is never correct to list it twice.

These rules are strict:
- An issue number appears at most once in this entire section. Before you finish, read back the "Issues:" lines and confirm no number occurs twice. If one does, delete it from the weaker theme.
- Theme names describe a *subject area*: the part of the product, codebase or workflow the issues touch. Good names look like "TypeScript types", "CLI commands", "Vue integration", "Documentation", "Installation".
- Severity, urgency, status and issue type are attributes, never themes. Do not create a theme called "High-severity bugs", "Critical issues", "Bug fixes", "Blocked", "Stale", "Needs attention" or anything similar. If several serious bugs share a subject, they belong in that subject's theme, and you say inside it that they are severe. Urgency is what the "Needs attention" section is for.
- No theme may be a subset or a rewording of another. Never pair "Bugs" with "High-severity bugs", or "Features" with "CLI features".
- Prefer fewer, cleaner categories to more overlapping ones. Four sharp themes beat six blurred ones.

## Needs attention
A bulleted list of at most 8 issues that most warrant a human right now: high severity, blocked, or stalled. Format each as "- **#123**: one line on why it needs attention." These are cross-cutting callouts, so they may repeat issues that appear under a theme.

## Open questions
A bulleted list of at most 6 unresolved questions drawn from the discussions. These may also repeat issues that appear under a theme, but an issue must not appear in both "Needs attention" and "Open questions": pick whichever single section fits it better. Omit this section entirely if there are none.

Rules:
- Every issue number you cite anywhere must be copied from the digest list you were given. Do not adjust, round or guess a number, and if you are not certain a number is in that list, leave it out. A wrong number is worse than no number, because the reader will follow it.
- The health score, its grade and its component numbers are given to you as fact. Reproduce them exactly. Do not recalculate, round differently, or editorialise the number up or down.
- The score measures maintenance activity in the issue tracker. Never describe it as a judgement of code quality.
- Synthesise across issues; do not restate digests one by one.
- Before answering, check your own output against these four things and fix any that fail: (1) no issue number appears twice in "Main themes"; (2) no theme is named after severity, urgency, status or issue type; (3) the Verdict and TL;DR share no point; (4) every number you cite came from the digest list.
- Plain, direct prose. No filler, no "in conclusion", no hedging about being an AI.
- Never use em dashes. Use commas, colons, or separate sentences instead.
- Do not include a top-level "# " heading; the page adds its own.

Respond with JSON: {"markdown": "<the full markdown document>"}`;

function renderInput(bodyDigests: IssueDigest[], commentDigests: CommentDigest[]): string {
  const byNumber = new Map(
    commentDigests.filter((c) => !c.failed).map((c) => [c.number, c]),
  );
  return bodyDigests
    .map((d) => {
      const c = byNumber.get(d.number);
      const lines = [`#${d.number} [${d.kind}/${d.severity}] {${d.theme}} ${d.gist}`];
      if (c) {
        lines.push(`  discussion: ${c.discussion}`);
        if (c.consensus) lines.push(`  consensus: ${c.consensus}`);
        if (c.blockers.length) lines.push(`  blockers: ${c.blockers.join('; ')}`);
        if (c.openQuestions.length) lines.push(`  open: ${c.openQuestions.join('; ')}`);
      }
      return lines.join('\n');
    })
    .join('\n\n');
}

function header(
  ref: RepoRef,
  meta: RepoMeta,
  issueCount: number,
  health: HealthScore,
): string {
  const facts = [
    meta.language ? `${meta.language}` : null,
    `${meta.stars.toLocaleString('en-US')} stars`,
    `${meta.openIssueCount.toLocaleString('en-US')} open`,
    `${meta.closedIssueCount.toLocaleString('en-US')} closed`,
  ].filter(Boolean);

  const breakdown = health.components
    .map((c) => `| ${c.label} | ${c.earned} / ${c.max} | ${c.detail} |`)
    .join('\n');

  // The header count must equal the denominator every signal divides by,
  // otherwise the reader sees "read 100" alongside "14 of 99".
  const readNote =
    health.unavailable > 0
      ? `analysed the ${health.analysed} most recently updated open issues of ${issueCount} read (${health.unavailable} could not be summarised)`
      : `analysed the ${health.analysed} most recently updated open issues`;

  return `# ${ref.owner}/${ref.repo}

${meta.description ?? '_No repository description._'}

**Maintenance health: ${health.score}/100 (${health.grade})**

*${facts.join(' · ')} · ${readNote} on ${new Date().toISOString().slice(0, 10)}*

| Signal | Score | Basis |
| --- | --- | --- |
${breakdown}

`;
}

/** LLM 4, the composer. Produces the final Markdown, then the HTML rendering. */
export async function composeSummary(
  apiKey: string,
  ref: RepoRef,
  meta: RepoMeta,
  issues: Issue[],
  bodyDigests: IssueDigest[],
  commentDigests: CommentDigest[],
  health: HealthScore,
  delta?: UpdateDelta,
): Promise<Summary> {
  // Failed digests are recorded upstream but must never reach the reader.
  const usable = bodyDigests.filter((d) => !d.failed);
  const unavailable = bodyDigests.length - usable.length;
  const deltaNote = delta
    ? `\n\nThis is a refresh of an earlier summary. Recent movement to weave in:\n${delta.narrative}`
    : '';

  const healthBlock = [
    `SCORE: ${health.score}/100 (grade ${health.grade})`,
    'COMPONENTS:',
    ...health.components.map(
      (c) => `  ${c.label}: ${c.earned} of ${c.max}. ${c.detail}`,
    ),
    'CAVEATS:',
    ...health.caveats.map((c) => `  ${c}`),
  ].join('\n');

  // The subject areas LLM 1 already assigned. Offering them as a vocabulary
  // steers the composer towards subject themes and away from inventing
  // severity buckets like "High-severity bugs".
  const vocabulary = [...new Set(usable.map((d) => d.theme))].filter(Boolean).sort();

  const raw = await callJson<{ markdown?: unknown }>({
    apiKey,
    stage: 'composer',
    system: SYSTEM,
    user: `Repository: ${ref.owner}/${ref.repo}
${meta.description ? `Description: ${meta.description}` : ''}
MAINTENANCE HEALTH (precomputed, reproduce exactly):
${healthBlock}

Open issues in tracker: ${meta.openIssueCount}. Closed all time: ${meta.closedIssueCount}. Digested here: ${usable.length}.${
      unavailable > 0
        ? ` (${unavailable} issue(s) could not be processed and are excluded.)`
        : ''
    }${deltaNote}

SUBJECT AREAS already assigned to these issues by the extraction stage. Build your themes from these, merging near-duplicates into one theme. Do not invent a theme that is not a subject area:
${vocabulary.join(', ')}

DIGESTS:
${renderInput(usable, commentDigests)}`,
    maxTokens: 4000,
    temperature: 0.4,
  });

  const cleaned = stripEmDashes(String(raw.markdown ?? '').trim());
  // The prompt asks for a partition; this makes it certain.
  const { markdown: body, removed } = dedupeThemeIssues(cleaned);
  const nonSubject = findNonSubjectThemes(body);
  if (nonSubject.length) {
    // Reported, not rewritten. See findNonSubjectThemes for why.
    console.warn(JSON.stringify({ nonSubjectThemes: nonSubject }));
  }

  if (removed.length) {
    console.warn(
      JSON.stringify({
        themeOverlap: {
          removed: removed.length,
          entries: removed.map((r) => `#${r.number} from "${r.theme}"`),
        },
      }),
    );
  }
  if (!body) throw new Error('The composer returned an empty summary.');
  if (!usable.length) throw new Error('No issues could be summarised.');

  // Issue references become links to the source. Derived from `ref` plus the
  // number, so nothing extra needs storing, and restricted to issues we
  // actually digested so an invented number cannot become a link.
  const known = new Set(usable.map((d) => d.number));
  const markdown = header(ref, meta, issues.length, health) + linkIssueRefs(body, ref, known);
  const html = renderMarkdown(markdown);

  return { markdown, html };
}
