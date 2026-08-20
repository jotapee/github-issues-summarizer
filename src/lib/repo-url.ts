import type { RepoRef } from './types';

/** GitHub account names are alphanumeric with hyphens: no dots, no underscores. */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
/** Repository names additionally allow dots and underscores. */
const REPO = /^[A-Za-z0-9._-]+$/;

/**
 * Accepts anything a user is plausibly going to paste:
 *   https://github.com/owner/repo, github.com/owner/repo.git,
 *   git@github.com:owner/repo.git, or a bare owner/repo.
 * Returns null for anything that is not a GitHub repository, including
 * well-formed URLs pointing at other hosts.
 */
export function parseRepoInput(raw: string): RepoRef | null {
  let input = raw.trim();
  if (!input) return null;

  // git@github.com:owner/repo(.git)
  const scp = input.match(/^git@github\.com:(.+)$/i);
  if (scp) {
    input = scp[1];
  } else {
    const scheme = input.match(/^([a-z][a-z0-9+.-]*):\/\//i);
    if (scheme) {
      if (!/^(https?|git|ssh)$/i.test(scheme[1])) return null;
      input = input.slice(scheme[0].length);
    }

    const host = input.match(/^(www\.)?github\.com\//i);
    if (host) {
      input = input.slice(host[0].length);
    } else if (scheme) {
      // An explicit URL pointing somewhere other than github.com.
      return null;
    } else if (input.split('/')[0].includes('.')) {
      // Host-like first segment (gitlab.com/a/b). Owners never contain dots.
      return null;
    }
  }

  input = input.replace(/[?#].*$/, '');
  input = input.replace(/^\/+|\/+$/g, '');

  // Tolerate deep links: owner/repo/issues/123 -> owner/repo
  const parts = input.split('/');
  if (parts.length < 2) return null;

  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');

  if (!OWNER.test(owner) || !REPO.test(repo)) return null;
  if (repo === '.' || repo === '..') return null;

  return { owner, repo, slug: `${owner.toLowerCase()}/${repo.toLowerCase()}` };
}
