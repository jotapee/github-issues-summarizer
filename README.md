# GitHub Issues Summarizer

Paste a public GitHub repository URL and get a short, source-anchored briefing
on what its open issue tracker actually says: the dominant themes, what needs
attention, and what nobody has answered yet.

This is a worked example of **multi-stage LLM orchestration**. The interesting
part is not the summarising, it is the control flow around it: a deterministic
router, a parallel fan-out, a bounded evaluator/optimizer loop, and a
change-detection cache that makes a repeat run cost nothing.

[DESIGN.md](DESIGN.md) is the architecture document. It was written before the
code and updated as decisions changed during the build. Read it first if you
care about the "why".

## What it demonstrates

| Pattern | Where |
| --- | --- |
| Routing (deterministic conditional edge) | [`pipeline.ts`](src/lib/pipeline.ts) |
| Parallel fan-out of two independent LLM stages | [`l1-issues.ts`](src/lib/llm/l1-issues.ts), [`l2-comments.ts`](src/lib/llm/l2-comments.ts) |
| Evaluator/optimizer loop, bounded at 2 passes | [`l3-coherence.ts`](src/lib/llm/l3-coherence.ts) |
| Model routing by task type, with prices attached | [`models.ts`](src/lib/llm/models.ts) |
| Fault isolation so one bad batch cannot abort a run | [`client.ts`](src/lib/llm/client.ts) |
| Change-detection cache for cheap repeat runs | [`updater.ts`](src/lib/updater.ts) |
| Treating model output as untrusted input | [`markdown.ts`](src/lib/markdown.ts) |
| Source-linking issue refs without storing URLs | [`markdown.ts`](src/lib/markdown.ts) |

A deliberate framing from DESIGN.md: this is a **workflow, not an autonomous
agent**. The path is fixed at design time. No model decides what to do next.
Models are called at fixed points to do bounded tasks, which is the cheaper and
more predictable choice when the steps can be enumerated in advance.

## Stack

Next.js 16 (App Router), TypeScript, Tailwind CSS v4, OpenAI, and Cloudflare
Workers with KV via [OpenNext](https://opennext.js.org/cloudflare).

## How a request flows

```
POST /api/tldr  ──▶  Router          src/lib/pipeline.ts
                       │
        no stored entry │ stored entry
                       ▼             ▼
                     Scout        Updater + Updates Checker
                  src/lib/github.ts   src/lib/updater.ts
                       │             │
                       ▼             ▼
        LLM 1 titles/bodies    LLM 2 comment threads     (run concurrently)
                       └──────┬──────┘
                              ▼
                  LLM 3 Coherence Checker    src/lib/llm/l3-coherence.ts
                       │            │
                  problems?  ───────┘  re-summarises only the flagged issues
                       │                (max 2 passes)
                       ▼
                  LLM 4 Composer            src/lib/llm/l4-composer.ts
                       │
                       ├──▶ Markdown + HTML to the browser (streamed via SSE)
                       └──▶ Cloudflare KV   src/lib/storage.ts
```

Progress is streamed to the browser as server-sent events, so the user sees
each stage rather than staring at a spinner for two minutes.

### Model choice

DESIGN.md originally specified GPT-3.5, which OpenAI has retired. The pipeline
routes by task type instead:

| Stage | Model | Why |
| --- | --- | --- |
| LLM 1, titles and bodies | `gpt-4o-mini` | High volume, mechanical extraction |
| LLM 2, comment threads | `gpt-4o-mini` | Same profile |
| LLM 3, coherence checker | `gpt-4o-mini` | Matches `gpt-4o` at catching planted defects, at 1/17th the price |
| LLM 4, composer | `gpt-4o` | The only output a human reads, and it runs once per cold run |

Every stage is assigned in one place,
[`src/lib/llm/models.ts`](src/lib/llm/models.ts), which also carries each
model's price so a run can report what it cost.

Measured cost per cold run, before and after moving the coherence checker off
`gpt-4o`:

| Repo | Open issues | Before | After | Change |
| --- | --- | --- | --- | --- |
| `lukeed/clsx` | 8 | $0.0147 | $0.0096 | -35% |
| `developit/mitt` | 16 | $0.0241 | $0.0142 | -41% |
| `colinhacks/zod` | 56 | $0.1044 | $0.0341 | -67% |

Two results worth knowing before you copy this pattern. The extraction stages
were never the cost driver: they are 10% to 30% of a run, while the verifier
and composer are the rest. And newer or smaller does not mean cheaper.
`gpt-5.4-mini` is five times dearer than `gpt-4o-mini`, and `gpt-5-nano` spends
around 1,850 hidden reasoning tokens on a 180-token extraction, billed as
output. `gpt-4.1-nano` was tried and rejected for both jobs: as a verifier it
caught 0 of 4 planted defects, and as an extractor it silently dropped 3 to 4
of 56 issues. DESIGN.md section 7 records the full method.

### Scope and cost control

- Up to **100 open issues**, most recently updated first (`MAX_ISSUES`).
- Up to **20 most recent comments** per issue (`COMMENTS_PER_ISSUE`).
- Issue bodies truncated to 4,000 characters, comments to 1,500.
- Cached results live in KV for 7 days. A repeat run only re-summarises issues
  whose `updatedAt` moved, and drops digests for issues that have since closed.

The Scout uses GitHub's **GraphQL** API rather than REST. REST would need about
101 requests per repository (one for the issue list, one per issue for its
comments); GraphQL fetches issues and their comments together in two requests.
This is why a token is required, as described below.

## Setup

```bash
git clone https://github.com/jotapee/github-issues-summarizer.git
cd github-issues-summarizer
npm install
cp .dev.vars.example .dev.vars   # then fill in the three values
npm run dev
```

### Required secrets

Put these in `.dev.vars` for local development. That file is gitignored and
must never be committed.

| Variable | Notes |
| --- | --- |
| `GITHUB_TOKEN` | A PAT with `public_repo` read scope. This is the **operator's** token, not the visitor's; visitors never authenticate. Required because the Scout uses the GraphQL API, which rejects unauthenticated requests. |
| `OPENAI_API_KEY` | From <https://platform.openai.com/api-keys> |
| `AUTH_SECRET` | Signing key for the API tokens. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`. Never sent to the browser. |

In production these are Worker secrets, not files:

```bash
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put AUTH_SECRET
```

### KV namespace

```bash
npx wrangler kv namespace create TLDR_KV
```

Paste the returned `id` over `PLACEHOLDER_REPLACE_WITH_YOUR_KV_ID` in
[`wrangler.jsonc`](wrangler.jsonc). Without it the app still runs, it simply
never caches, so every request takes the full cold path.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Next dev server, with local KV via Miniflare |
| `npm test` | Sanitiser, URL parser, token and batch-isolation tests. No credentials needed |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | Next production build |
| `npm run preview` | Build for Workers and serve it on workerd locally |
| `npm run deploy` | Build and deploy to Cloudflare |
| `npm run cf-typegen` | Regenerate binding types from `wrangler.jsonc` |

## Protecting the endpoint

`/api/tldr` costs real money per cold run, so it sits behind three gates.

| Gate | Rejects with | What it stops |
| --- | --- | --- |
| Same-origin check | `403` | Another site driving your endpoint from a visitor's browser |
| Signed token | `401` | Direct calls, scrapers, anything that never loaded the page |
| Per-IP quota | `429` | Runaway spend, including from a leaked token |

The page mints a token per request: an expiry plus an HMAC-SHA256 signature
over `version.expiry.host`, signed with `AUTH_SECRET` and valid for two hours.
The API verifies it before doing any paid work. `AUTH_SECRET` itself never
leaves the server, and rotating it invalidates every outstanding token at once.

### Be clear about what this buys you

**The token is a speed bump, not a lock.** Because this is a public site with
no login, the browser has to be given a token, which means a person can open
developer tools, read it out of the page, and replay it until it expires. There
is no way around that short of real authentication.

The honest threat model:

- **Stopped:** bots, scrapers, someone who finds the endpoint, another site
  embedding it, and anyone replaying a token after two hours or against a
  different host.
- **Not stopped:** a person who loads the page, copies the token, and scripts
  against it within the window.

The **per-IP quota is what actually bounds the bill** in that last case. See
`COLD_RUNS_PER_HOUR` in [`src/lib/rate-limit.ts`](src/lib/rate-limit.ts),
default 5. Cache hits are free and deliberately do not consume quota, so a
repository that has already been summarised keeps working even when you are
over the limit.

If you need something a determined person cannot get past, the token has to be
tied to an identity: put Cloudflare Access in front of the Worker (SSO, no
application code) or add GitHub OAuth sign-in.

### Known limits

- The quota is a KV read-then-write, and KV is eventually consistent, so
  simultaneous requests from one IP can slip a run or two over the limit. That
  is fine for a spend guard. Use a Durable Object if you need an exact counter.
- If `TLDR_KV` is not bound, the quota **fails open** rather than taking the
  app down. Bind the namespace before making the site public.
- Quota is keyed on `CF-Connecting-IP`, so it is per-IP, not per-person.

## Notes

- **Issue references link to their source.** Every `#1234` in the briefing
  becomes a link to that issue on GitHub, in both the HTML and the Markdown
  download. The URL is derived from the repo reference and the issue number at
  compose time, so nothing extra is stored and no model tokens are spent on it.
  Only numbers that appear in the digests are linked, so an invented number
  cannot become a plausible-looking source link.
- **Output is sanitised.** The composer's Markdown derives from arbitrary
  GitHub issue text, so an issue titled `<img src=x onerror=...>` can reach the
  summary. [`src/lib/markdown.ts`](src/lib/markdown.ts) escapes raw HTML,
  restricts link schemes to `http(s)` and `mailto`, and renders images as alt
  text only. `marked` does not sanitise on its own.
- **Partial failures are recorded, not hidden.** If a batch fails, its issues
  get a `failed` digest, are excluded from verification and from the briefing,
  and the count is reported to the user. Only a total failure aborts the run.
- **Runtime.** A cold run over 100 issues is roughly 15 to 25 model calls and
  takes 1 to 3 minutes. The work is almost entirely I/O wait, so it sits well
  inside the Workers CPU limit, but a cold run on a very large tracker will
  want a paid plan's longer wall-clock allowance.
- **The coherence checker is deliberately conservative.** An empty problem list
  is the expected result, and the code derives `ok` from the problem list
  rather than trusting the model's own boolean.

## License

MIT
