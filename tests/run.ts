/**
 * Dependency-free test suite. Run with `npm test`.
 *
 * Covers the pure, security-relevant logic: output sanitising, repo URL
 * parsing, and API token signing. The GitHub and OpenAI calls are not
 * exercised here, because those need live credentials and cost money.
 */
import { mintToken, verifyToken } from '../src/lib/auth.ts';
import { linkIssueRefs, renderMarkdown } from '../src/lib/markdown.ts';
import { parseRepoInput } from '../src/lib/repo-url.ts';
import { batch, runBatches } from '../src/lib/llm/batching.ts';
import { checkUpdates, mergeDigests, pruneClosed } from '../src/lib/updater.ts';
import type { StoredResult } from '../src/lib/types.ts';

let passed = 0;
let failed = 0;

function ok(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail === undefined ? '' : `\n        got: ${JSON.stringify(detail)}`}`);
  }
}

function group(name: string) {
  console.log(`\n${name}`);
}

// ---------------------------------------------------------------- sanitiser
group('markdown sanitiser');
{
  const cases: Array<[string, string, (html: string) => boolean]> = [
    ['script tag escaped', 'Hi <script>alert(1)</script>', (h) => !h.includes('<script') && h.includes('&lt;script')],
    ['img onerror escaped', '- **#1**: <img src=x onerror=alert(1)>', (h) => !h.includes('<img') && h.includes('&lt;img')],
    ['iframe escaped', '<iframe src="//evil.test"></iframe>', (h) => !h.includes('<iframe')],
    ['javascript: link dropped', '[click](javascript:alert(1))', (h) => !h.toLowerCase().includes('javascript:') && !h.includes('<a href')],
    ['data: link dropped', '[x](data:text/html,<script>alert(1)</script>)', (h) => !h.includes('<a href="data:')],
    ['vbscript: link dropped', '[x](vbscript:msgbox)', (h) => !h.includes('<a href')],
    ['control-char smuggling blocked', '[x](java\tscript:alert(1))', (h) => !h.includes('<a href')],
    ['https link kept and hardened', '[docs](https://example.com/a)', (h) => h.includes('href="https://example.com/a"') && h.includes('rel="noopener noreferrer nofollow"')],
    ['image becomes alt text', '![alt text](https://evil.test/p.gif)', (h) => !h.includes('<img') && h.includes('alt text')],
    ['headings render', '## Themes', (h) => h.includes('<h2>')],
    ['bold and lists render', '- **#12**: a bug', (h) => h.includes('<strong>#12</strong>') && h.includes('<li>')],
    ['inline code renders', 'use `npm run dev`', (h) => h.includes('<code>')],
  ];
  for (const [name, input, predicate] of cases) {
    const html = renderMarkdown(input);
    ok(name, predicate(html), html);
  }
}

// --------------------------------------------------------------- url parser
group('repo url parser');
{
  const cases: Array<[string, string | null]> = [
    ['https://github.com/vercel/next.js', 'vercel/next.js'],
    ['http://www.github.com/Vercel/Next.js/', 'vercel/next.js'],
    ['github.com/facebook/react.git', 'facebook/react'],
    ['git@github.com:cloudflare/workerd.git', 'cloudflare/workerd'],
    ['owner/repo', 'owner/repo'],
    ['some-org/my_repo.v2', 'some-org/my_repo.v2'],
    ['  https://github.com/a/b/issues/123?q=1#top  ', 'a/b'],
    ['https://github.com/cli/cli/pull/99', 'cli/cli'],
    // rejections
    ['https://gitlab.com/a/b', null],
    ['gitlab.com/a/b', null],
    ['git@gitlab.com:a/b.git', null],
    ['javascript://github.com/a/b', null],
    ['not a url', null],
    ['https://github.com/onlyowner', null],
    ['', null],
    ['../../etc/passwd', null],
    ['https://github.com/-bad/repo', null],
    ['https://github.com/ok/', null],
  ];
  for (const [input, expected] of cases) {
    const got = parseRepoInput(input)?.slug ?? null;
    ok(`parse ${JSON.stringify(input)}`, got === expected, got);
  }
}

// -------------------------------------------------------------- api tokens
group('api tokens');
{
  const secret = 'test-secret-value';
  const host = 'tldr.example.com';
  const token = await mintToken(secret, host);

  ok('valid token verifies', (await verifyToken(token, secret, host)).ok);

  const missing = await verifyToken(null, secret, host);
  ok('missing token rejected', !missing.ok && missing.reason === 'missing');

  const malformed = await verifyToken('garbage', secret, host);
  ok('malformed token rejected', !malformed.ok && malformed.reason === 'malformed');

  const wrongHost = await verifyToken(token, secret, 'evil.test');
  ok('token bound to host', !wrongHost.ok && wrongHost.reason === 'bad-signature');

  const wrongSecret = await verifyToken(token, 'other-secret', host);
  ok('token bound to secret', !wrongSecret.ok && wrongSecret.reason === 'bad-signature');

  const [, exp, sig] = token.split('.');
  const extended = await verifyToken(`v1.99999999999999.${sig}`, secret, host);
  ok('extending expiry breaks signature', !extended.ok && extended.reason === 'bad-signature');

  const flipped = await verifyToken(`v1.${exp}.${'X'}${sig.slice(1)}`, secret, host);
  ok('flipped signature rejected', !flipped.ok && flipped.reason === 'bad-signature');

  // An already-expired token, signed correctly.
  const past = Date.now() - 1000;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const rawSig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`v1.${past}.${host}`));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(rawSig)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const expired = await verifyToken(`v1.${past}.${b64}`, secret, host);
  ok('expired token rejected as expired', !expired.ok && expired.reason === 'expired', expired);
}

// ----------------------------------------------------------------- updater
group('updater');
{
  const stored = {
    generatedAt: '2026-08-01T00:00:00.000Z',
    bodyDigests: [{ number: 1 }, { number: 2 }, { number: 3 }],
  } as unknown as StoredResult;

  const delta = checkUpdates(stored, [{ number: 2 }, { number: 9 }] as never);
  ok('new issues detected', delta.newIssues.join() === '9', delta.newIssues);
  ok('changed issues detected', delta.changedIssues.join() === '2', delta.changedIssues);
  ok('narrative mentions both', delta.narrative.includes('#9') && delta.narrative.includes('#2'), delta.narrative);

  const empty = checkUpdates(stored, []);
  ok('no-change narrative', empty.narrative.startsWith('No issues changed'), empty.narrative);

  const merged = mergeDigests([{ number: 1, v: 'old' }, { number: 2, v: 'old' }], [{ number: 2, v: 'new' }]);
  ok('merge replaces by number', merged.find((d) => d.number === 2)?.v === 'new', merged);
  ok('merge keeps untouched', merged.find((d) => d.number === 1)?.v === 'old', merged);
  ok('merge sorts desc', merged.map((d) => d.number).join() === '2,1', merged);

  const pruned = pruneClosed([{ number: 1 }, { number: 2 }], new Set([2]));
  ok('prune drops closed', pruned.map((d) => d.number).join() === '2', pruned);
}

// --------------------------------------------------------- batch isolation
group('batch fault isolation');
{
  const groups = batch([1, 2, 3, 4, 5, 6], 2);
  ok('batches split evenly', JSON.stringify(groups) === '[[1,2],[3,4],[5,6]]', groups);

  // Middle batch fails; the other two must still deliver.
  const run = await runBatches(groups, async (g) => {
    if (g[0] === 3) throw new Error('batch boom');
    return g.map((n) => n * 10);
  });
  ok('surviving batches return results', run.results.sort((a, b) => a - b).join() === '10,20,50,60', run.results);
  ok('failed items are recorded', run.failed.join() === '3,4', run.failed);
  ok('first error captured', (run.firstError as Error)?.message === 'batch boom', run.firstError);

  const allFailed = await runBatches(groups, async () => {
    throw new Error('everything down');
  });
  ok('total failure reports every item', allFailed.failed.length === 6, allFailed.failed);
  ok('total failure yields no results', allFailed.results.length === 0, allFailed.results);

  const allOk = await runBatches(groups, async (g) => g);
  ok('no failures on happy path', allOk.failed.length === 0 && allOk.results.length === 6, allOk);
}

// ------------------------------------------------------ issue ref linking
group('issue reference linking');
{
  const repo = { owner: 'lukeed', repo: 'clsx' };
  const known = new Set([112, 97, 52]);
  const link = (n: number) => `https://github.com/lukeed/clsx/issues/${n}`;
  const L = (md: string) => linkIssueRefs(md, repo, known);

  ok('links a known issue', L('See #112 for detail') === `See [#112](${link(112)}) for detail`, L('See #112 for detail'));
  ok('links several in a list',
    L('Issues: #112, #97, #52') === `Issues: [#112](${link(112)}), [#97](${link(97)}), [#52](${link(52)})`,
    L('Issues: #112, #97, #52'));
  ok('leaves unknown numbers alone', L('See #999') === 'See #999', L('See #999'));
  ok('does not link a hex colour', L('colour #112233 here') === 'colour #112233 here', L('colour #112233 here'));
  ok('leaves inline code alone', L('use `#112` literally') === 'use `#112` literally', L('use `#112` literally'));
  ok('leaves fenced code alone',
    L('```\n#112\n```') === '```\n#112\n```', L('```\n#112\n```'));
  ok('does not double-link an existing link',
    L(`[#112](${link(112)})`) === `[#112](${link(112)})`, L(`[#112](${link(112)})`));
  ok('works at the start of a string', L('#97 opens') === `[#97](${link(97)}) opens`, L('#97 opens'));
  ok('survives bold markers', L('**#52** matters') === `**[#52](${link(52)})** matters`, L('**#52** matters'));
  ok('adjacent refs both link',
    L('#112,#97') === `[#112](${link(112)}),[#97](${link(97)})`, L('#112,#97'));
  ok('no known numbers is a no-op',
    linkIssueRefs('See #112', repo, new Set()) === 'See #112');

  // End to end: the linked Markdown must render as a real anchor.
  const html = renderMarkdown(L('Issues: #112'));
  ok('renders as an anchor', html.includes(`href="${link(112)}"`) && html.includes('rel="noopener noreferrer nofollow"'), html);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
