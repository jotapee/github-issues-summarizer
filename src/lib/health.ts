import type { HealthComponent, HealthScore, Issue, IssueDigest, RepoMeta } from './types';

/**
 * Maintenance health scoring.
 *
 * This is deliberately ordinary code, not a model call. The score is the most
 * quotable number the tool produces, so it must be auditable: every point is
 * traceable to a named component with a stated basis. LLM 4 is given the score
 * and its breakdown and asked to explain it; it never derives the number. See
 * DESIGN.md section 2 on using the least autonomy that solves the problem.
 *
 * On reproducibility, precisely: this function is pure, so identical inputs
 * always give an identical score. 90 of the 100 points come from repo-wide
 * counts and timestamps and are stable between runs. The remaining 10, the
 * severity component, derive from LLM 1's judgement of each issue, so a cold
 * run can land a point or two from the previous one. A cached result is
 * byte-identical because it is not recomputed. That residual variance is the
 * price of reusing the severity work; it is bounded and visible, unlike a
 * score a model invents wholesale.
 *
 * What this measures is **maintenance**, not code quality. An issue tracker
 * shows whether maintainers respond and resolve. It cannot see the source. A
 * dormant repository with a quiet tracker and well-written code will score
 * badly here, and that is the honest answer to "is anyone looking after this".
 *
 * Counts are deliberately not scored directly. Popular projects attract more
 * issues, so raw volume measures adoption rather than health: at the time of
 * writing facebook/react had 822 open issues and was actively maintained,
 * while developit/mitt had 16 and had closed none in 90 days. Every component
 * below is a ratio or a recency measure for that reason.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Open issues untouched for longer than this count as stale. */
const STALE_DAYS = 365;
/** Closing this share of the open backlog within the window earns full marks. */
const BURNDOWN_TARGET = 0.5;
/** Below this many total issues, ratios are too noisy to trust. */
const MIN_ISSUES_FOR_CONFIDENCE = 10;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function daysSince(iso: string, now: number): number {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return Number.POSITIVE_INFINITY;
  return (now - then) / DAY_MS;
}

function component(
  key: string,
  label: string,
  ratio: number,
  max: number,
  detail: string,
): HealthComponent {
  return {
    key,
    label,
    earned: Math.round(clamp01(ratio) * max * 10) / 10,
    max,
    detail,
  };
}

export function gradeFor(score: number): string {
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

/**
 * `issues` and `digests` are the sampled open issues (up to MAX_ISSUES), so
 * components derived from them describe the sample, not the whole tracker.
 * Components derived from `meta` are repo-wide.
 */
export function scoreHealth(
  meta: RepoMeta,
  issues: Issue[],
  digests: IssueDigest[],
  now: number = Date.now(),
): HealthScore {
  const totalIssues = meta.openIssueCount + meta.closedIssueCount;

  // One canonical sample for every sample-based signal. An issue that failed
  // to summarise cannot be judged on severity, so it is excluded here rather
  // than counted by some components and not others, which is how the header
  // and the severity basis came to disagree.
  const usable = digests.filter((d) => !d.failed);
  const analysedNumbers = new Set(usable.map((d) => d.number));
  const sample = issues.filter((i) => analysedNumbers.has(i.number));
  const sampled = sample.length;
  const unavailable = issues.length - sampled;

  // 1. Do issues eventually get resolved at all? Repo-wide, lifetime.
  const resolutionRatio = totalIssues > 0 ? meta.closedIssueCount / totalIssues : 0;

  // 2. Is anyone working the backlog now? Recent closes against open backlog.
  const burndown =
    meta.openIssueCount > 0
      ? meta.closedInWindow / meta.openIssueCount
      : meta.closedInWindow > 0
        ? 1
        : 0;

  // 3. How much of the open backlog has simply been abandoned?
  const stale = sample.filter((i) => daysSince(i.updatedAt, now) > STALE_DAYS).length;
  const freshRatio = sampled > 0 ? 1 - stale / sampled : 0;

  // 4. Do reporters get any reply at all?
  const answered = sample.filter((i) => i.commentCount > 0).length;
  const answeredRatio = sampled > 0 ? answered / sampled : 0;

  // 5. Is the project itself still being worked on?
  const pushAge = daysSince(meta.pushedAt, now);
  const upkeepRatio = pushAge <= 30 ? 1 : pushAge >= 365 ? 0 : 1 - (pushAge - 30) / 335;

  // 6. How much of the open backlog is serious? Reuses the LLM 1 severities.
  const severe = usable.filter((d) => d.severity === 'high' && d.kind === 'bug').length;
  const severeRatio = sampled > 0 ? severe / sampled : 0;

  const components: HealthComponent[] = [
    component(
      'resolution',
      'Issues get resolved',
      resolutionRatio,
      25,
      `${meta.closedIssueCount.toLocaleString('en-US')} of ${totalIssues.toLocaleString('en-US')} issues ever opened are closed (${pct(resolutionRatio)}).`,
    ),
    component(
      'burndown',
      'Backlog is being worked',
      burndown / BURNDOWN_TARGET,
      25,
      `${meta.closedInWindow} closed in the last ${meta.windowDays} days against ${meta.openIssueCount} open.`,
    ),
    component(
      'freshness',
      'Open issues are not abandoned',
      freshRatio,
      15,
      sampled > 0
        ? `${stale} of the ${sampled} analysed issues have had no activity in over a year.`
        : 'No open issues analysed.',
    ),
    component(
      'responsiveness',
      'Reporters get a reply',
      answeredRatio,
      15,
      sampled > 0
        ? `${sampled - answered} of the ${sampled} analysed issues have no replies at all.`
        : 'No open issues analysed.',
    ),
    component(
      'upkeep',
      'Project is still active',
      upkeepRatio,
      10,
      Number.isFinite(pushAge)
        ? `Last push was ${Math.round(pushAge)} days ago.`
        : 'Last push date unavailable.',
    ),
    component(
      'severity',
      'Backlog is not dominated by serious bugs',
      1 - severeRatio,
      10,
      sampled > 0
        ? `${severe} of the ${sampled} analysed issues are high-severity bugs (${pct(severeRatio)}).`
        : 'No issues analysed.',
    ),
  ];

  const score = Math.round(components.reduce((sum, c) => sum + c.earned, 0));

  const caveats: string[] = [];
  if (totalIssues < MIN_ISSUES_FOR_CONFIDENCE) {
    caveats.push(
      `Only ${totalIssues} issues have ever been opened, so these ratios are not statistically meaningful.`,
    );
  }
  if (meta.openIssueCount > issues.length) {
    caveats.push(
      `Analysed the ${sampled} most recently updated of ${meta.openIssueCount} open issues, so staleness, reply rate and severity describe that sample.`,
    );
  }
  if (unavailable > 0) {
    caveats.push(
      `${unavailable} of the ${issues.length} issues read could not be summarised and are excluded from every signal above.`,
    );
  }
  caveats.push(
    'Measures maintenance activity in the issue tracker. It says nothing about the quality of the source code itself.',
  );

  return { score, grade: gradeFor(score), analysed: sampled, unavailable, components, caveats };
}
