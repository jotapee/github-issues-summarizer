import type { Issue, RepoMeta, RepoRef, RepoSnapshot } from './types';

export const MAX_ISSUES = 100;
/** Trailing window used for the recent-throughput health signals. */
export const HEALTH_WINDOW_DAYS = 90;
export const COMMENTS_PER_ISSUE = 20;
/** GraphQL page size. MAX_ISSUES / PAGE_SIZE = requests per repo. */
const PAGE_SIZE = 50;
/** Bodies are truncated before they ever reach an LLM. */
const MAX_BODY_CHARS = 4000;
const MAX_COMMENT_CHARS = 1500;

export class RepoNotFoundError extends Error {
  constructor(slug: string) {
    super(`Repository "${slug}" was not found, or it is private.`);
    this.name = 'RepoNotFoundError';
  }
}

export class GitHubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubError';
  }
}

const ISSUES_QUERY = `
query Issues($owner: String!, $name: String!, $first: Int!, $cursor: String, $since: DateTime, $window: DateTime!) {
  repository(owner: $owner, name: $name) {
    description
    stargazerCount
    pushedAt
    primaryLanguage { name }
    closedIssues: issues(states: CLOSED) { totalCount }
    closedInWindow: issues(states: CLOSED, filterBy: { since: $window }) { totalCount }
    issues(
      states: OPEN
      first: $first
      after: $cursor
      filterBy: { since: $since }
      orderBy: { field: UPDATED_AT, direction: DESC }
    ) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        title
        body
        url
        createdAt
        updatedAt
        author { login }
        labels(first: 10) { nodes { name } }
        comments(last: ${COMMENTS_PER_ISSUE}) {
          totalCount
          nodes { body createdAt author { login } }
        }
      }
    }
  }
}`;

interface GqlIssueNode {
  number: number;
  title: string | null;
  body: string | null;
  url: string;
  createdAt: string;
  updatedAt: string;
  author: { login: string } | null;
  labels: { nodes: Array<{ name: string }> };
  comments: {
    totalCount: number;
    nodes: Array<{ body: string | null; createdAt: string; author: { login: string } | null }>;
  };
}

function truncate(text: string, limit: number): string {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit)}\n…[truncated]`;
}

function toIssue(node: GqlIssueNode): Issue {
  return {
    number: node.number,
    title: (node.title ?? '').trim() || '(no title)',
    body: truncate(node.body ?? '', MAX_BODY_CHARS),
    url: node.url,
    author: node.author?.login ?? 'ghost',
    labels: node.labels.nodes.map((l) => l.name),
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    commentCount: node.comments.totalCount,
    comments: node.comments.nodes.map((c) => ({
      author: c.author?.login ?? 'ghost',
      body: truncate(c.body ?? '', MAX_COMMENT_CHARS),
      createdAt: c.createdAt,
    })),
  };
}

async function gql(token: string, variables: Record<string, unknown>) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'tldr-gen',
    },
    body: JSON.stringify({ query: ISSUES_QUERY, variables }),
  });

  if (res.status === 401) throw new GitHubError('GITHUB_TOKEN was rejected by GitHub (401).');
  if (res.status === 403 || res.status === 429) {
    throw new GitHubError('GitHub API rate limit reached. Try again shortly.');
  }
  if (!res.ok) throw new GitHubError(`GitHub API returned ${res.status}.`);

  const payload = (await res.json()) as {
    data?: { repository: null | Record<string, unknown> };
    errors?: Array<{ type?: string; message: string }>;
  };

  if (payload.errors?.length) {
    if (payload.errors.some((e) => e.type === 'NOT_FOUND')) return null;
    throw new GitHubError(payload.errors[0].message);
  }
  if (!payload.data?.repository) return null;
  return payload.data.repository as unknown as {
    description: string | null;
    stargazerCount: number;
    pushedAt: string;
    primaryLanguage: { name: string } | null;
    closedIssues: { totalCount: number };
    closedInWindow: { totalCount: number };
    issues: {
      totalCount: number;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: GqlIssueNode[];
    };
  };
}

/**
 * The Scout. Pulls open issues (newest-updated first) with their comments.
 * `since` restricts to issues updated after that timestamp, which is what the
 * Updater path uses to fetch only the delta.
 */
export async function fetchRepoSnapshot(
  ref: RepoRef,
  token: string,
  options: { since?: string; limit?: number } = {},
): Promise<RepoSnapshot> {
  const limit = options.limit ?? MAX_ISSUES;
  const windowStart = new Date(
    Date.now() - HEALTH_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const issues: Issue[] = [];
  let cursor: string | null = null;
  let meta: RepoMeta | null = null;

  while (issues.length < limit) {
    const repository = await gql(token, {
      owner: ref.owner,
      name: ref.repo,
      first: Math.min(PAGE_SIZE, limit - issues.length),
      cursor,
      since: options.since ?? null,
      window: windowStart,
    });

    // The Exit branch of the diagram: no such repo, stop the pipeline.
    if (!repository) throw new RepoNotFoundError(`${ref.owner}/${ref.repo}`);

    meta ??= {
      description: repository.description,
      stars: repository.stargazerCount,
      language: repository.primaryLanguage?.name ?? null,
      pushedAt: repository.pushedAt,
      openIssueCount: repository.issues.totalCount,
      closedIssueCount: repository.closedIssues.totalCount,
      closedInWindow: repository.closedInWindow.totalCount,
      windowDays: HEALTH_WINDOW_DAYS,
    };

    issues.push(...repository.issues.nodes.map(toIssue));

    if (!repository.issues.pageInfo.hasNextPage) break;
    cursor = repository.issues.pageInfo.endCursor;
    if (!cursor) break;
  }

  return {
    ref,
    meta: meta ?? {
      description: null,
      stars: 0,
      language: null,
      pushedAt: new Date(0).toISOString(),
      openIssueCount: 0,
      closedIssueCount: 0,
      closedInWindow: 0,
      windowDays: HEALTH_WINDOW_DAYS,
    },
    issues: issues.slice(0, limit),
    fetchedAt: new Date().toISOString(),
  };
}
