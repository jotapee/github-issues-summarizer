// Shared shapes for the whole pipeline. Every LLM stage speaks JSON that
// matches one of these; see src/lib/llm/* for the prompts that produce them.

export interface RepoRef {
  owner: string;
  repo: string;
  /** Canonical KV key fragment, always lowercase: "owner/repo". */
  slug: string;
}

export interface RepoMeta {
  description: string | null;
  stars: number;
  language: string | null;
  openIssueCount: number;
}

export interface IssueComment {
  author: string;
  body: string;
  createdAt: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  url: string;
  author: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  commentCount: number;
  /** Capped at COMMENTS_PER_ISSUE; commentCount is the true total. */
  comments: IssueComment[];
}

export interface RepoSnapshot {
  ref: RepoRef;
  meta: RepoMeta;
  issues: Issue[];
  fetchedAt: string;
}

/** LLM 1 output, one entry per issue. */
export interface IssueDigest {
  number: number;
  gist: string;
  theme: string;
  kind: 'bug' | 'feature' | 'question' | 'docs' | 'chore' | 'other';
  severity: 'low' | 'medium' | 'high';
  /**
   * Set when this issue could not be summarised. The entry is kept so the
   * failure is recorded rather than silently dropped, but downstream stages
   * exclude it from verification and from the composed output.
   */
  failed?: boolean;
}

/** LLM 2 output, one entry per issue that has comments. */
export interface CommentDigest {
  number: number;
  discussion: string;
  consensus: string | null;
  blockers: string[];
  openQuestions: string[];
  /** See IssueDigest.failed. */
  failed?: boolean;
}

/** LLM 3 output. */
export interface CoherenceReport {
  ok: boolean;
  problems: Array<{
    stage: 'l1' | 'l2';
    number: number;
    problem: string;
  }>;
}

/** What the Updates Checker feeds forward on the cached path. */
export interface UpdateDelta {
  changedIssues: number[];
  newIssues: number[];
  narrative: string;
}

export interface Summary {
  markdown: string;
  html: string;
}

/** The full KV record for a repo. */
export interface StoredResult {
  slug: string;
  ref: RepoRef;
  meta: RepoMeta;
  generatedAt: string;
  /** ISO timestamp used as the `since` cursor on the next Updater run. */
  lastSyncedAt: string;
  issueCount: number;
  bodyDigests: IssueDigest[];
  commentDigests: CommentDigest[];
  summary: Summary;
}

/** Server-sent event payloads streamed to the browser. */
export type PipelineEvent =
  | { type: 'stage'; stage: string; detail: string }
  | { type: 'done'; result: StoredResult; cached: boolean }
  | { type: 'error'; message: string };
