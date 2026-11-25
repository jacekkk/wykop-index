# AI providers for the Appwrite functions

`wykop-index` uses OpenRouter first for sentiment analysis. If that request fails
or returns invalid output, it falls back to Gemini and its bounded retries.
The default OpenRouter sentiment model is `nvidia/nemotron-3.5-super-vl:free`.
All `wykop-post` mention replies
use Gemini, including text-only threads. Tomek YouTube analysis also stays on
Gemini and is optional: a video-analysis failure does not block the daily index.

The OpenRouter model is configurable. The automated tests verify the response
format and fallback behavior. Compare outputs on the same saved Wykop batch to
evaluate style and Polish financial slang.

## Configure and deploy after review

In the Appwrite console, configure the following environment variables for the
indicated functions. Store API keys as secret variables; do not commit them or
paste them into a pull request.

| Variable | Function | Value / behavior |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | `wykop-index` | Enables primary OpenRouter sentiment analysis. Without a nonblank key, sentiment uses Gemini directly. |
| `OPENROUTER_MODEL` | `wykop-index` | Optional Appwrite/local selector when deploying outside GitHub. The GitHub deployment workflow packages its repository-variable selection instead, taking precedence over this environment value. Only `:free` models are accepted. |
| `GEMINI_API_KEY` | Both | Used for fallback index sentiment analysis, mention replies, and Tomek video analysis. |
| `GEMINI_BACKUP_API_KEY` | `wykop-post` | Optional second Gemini key. When absent, the primary key is reused. |
| `GEMINI_MODEL` | Both | Optional; defaults to `gemini-3.8-flash`. |
| `GEMINI_FALLBACK_MODEL` | Both | Optional; defaults to `gemini-3.6-flash`. |

The provider order is fixed: OpenRouter first when its key is configured, then
Gemini. The legacy `AI_PROVIDER` variable is ignored and can be removed; an old
`AI_PROVIDER=gemini` setting cannot reverse that order. An invalid OpenRouter model
is a configuration error and fails before either provider receives a prompt.
The GitHub deployment workflow also validates the model before packaging it.

`wykop-post` always uses Gemini and ignores `OPENROUTER_*` variables. Keep the
existing Appwrite and Wykop credentials.

After configuring the variables, deploy both function directories using the
existing Appwrite deployment process. For verification, inspect provider logs and the next normal execution;
submission to Appwrite alone does not establish successful posting. For quality
evaluation, compare the same saved Wykop batch across models without running the
posting handlers.

## Deploy from GitHub

After review and merge, **Deploy Appwrite functions** automatically deploys both
functions when a push to `main` changes `functions/**`, `appwrite.config.json`,
or the deployment workflow. This includes PR merges and direct pushes. Changes
limited to the frontend or unrelated root documentation do not deploy functions.

1. To select a different free model, set **`OPENROUTER_MODEL`** under
   **Settings > Secrets and variables > Actions > Variables**. Leave the variable
   unset or empty to use `nvidia/nemotron-3.5-super-vl:free`.
2. Reuse the existing GitHub repository secret **`APPWRITE_API_KEY`**. The Appwrite
   project key it contains must have `functions.read`, `functions.write`, and
   `rules.read` for CLI deployment. If the CLI must create or update a function's
   default domain rule, it also needs `rules.write`. Retain `execution.write` if
   this key is also used by the execution workflows; that scope alone cannot
   deploy code. No additional deployment secret is required. The OpenRouter key
   stays in Appwrite.
3. Retain the existing repository variables `APPWRITE_ENDPOINT`,
   `APPWRITE_PROJECT_ID`, `APPWRITE_WYKOP_INDEX_FUNCTION_ID`, and
   `APPWRITE_WYKOP_POST_FUNCTION_ID`, pointing to the deployed functions.
4. Merge function changes into `main` to deploy automatically, or use
   **Actions > Deploy Appwrite functions > Run workflow** on the default branch
   for a manual deployment, including after a model-variable change.

The workflow runs the function tests and entrypoint syntax checks, validates
`OPENROUTER_MODEL`, and packages that
selection into `wykop-index` before uploading and activating both functions with the
pinned Appwrite CLI. Automatic and manual deployments share a concurrency group
so only one runs at a time. Existing Appwrite variables, including API keys, are
preserved: the CLI is not run with `--with-variables`. The workflow does not
invoke either function. Their deployed settings come from `appwrite.config.json`;
the existing Cloudflare scheduling configuration is unchanged.

The pinned CLI can print deployment errors while returning exit code zero. The
workflow therefore reads each function's active deployment before and after the
CLI push, requires a different active deployment ID, and verifies that deployment
has status `ready`. A missing permission, failed upload/build/activation, or failed
verification stops the job. An old ready deployment cannot produce a green run.
The second function is attempted only after the first passes verification.

If logs report `missing scopes (["rules.read"])`, the Appwrite key used by
`APPWRITE_API_KEY` needs that scope; changing the GitHub secret's name does not
change the key's permissions. Check the key in Appwrite and rerun deployment
after correcting its scopes. A successful workflow verifies deployment, not
successful Wykop posting.

Editing the GitHub variable alone does **not** update running sentiment analysis: rerun
the deployment workflow after each change. An empty/unset variable packages the
default `nvidia/nemotron-3.5-super-vl:free`. This selection takes precedence over
any older Appwrite `OPENROUTER_MODEL` value. Outside this workflow, the committed
`deployment-model.js` placeholder allows the Appwrite environment value to be
used instead. The functions deploy sequentially; if the second fails, the first
may already be updated.

Reference: [Appwrite non-interactive CLI deployments](https://appwrite.io/docs/tooling/command-line/non-interactive).

## Search, attachments, and response handling

- `wykop-index` tries OpenRouter for sentiment JSON, then Gemini if the OpenRouter
  request or output validation fails. Its optional Tomek analysis uses Gemini and can
  still be skipped on failure.
- `wykop-post` keeps its existing Tavily/Brave searches, retrieved sources, and
  Yahoo current-quote lookup. All mention batches send that context to Gemini;
  this does not enable paid Google Search grounding.
- Photos, YouTube embeds, and user-supplied HTTP URLs retain Gemini attachment
  and URL-context processing. Supported attachments elsewhere in the fetched
  thread are still included when the mentioning comment itself has no media.
  All mention replies remain dependent on Gemini availability.
- OpenRouter sentiment responses use a strict JSON-schema object. Gemini
  mention replies keep their existing flat JSON-array contract. Local response
  validation finishes before posting, and all replies pass through the
  current-price guard.
- At most one OpenRouter sentiment request is attempted, with a 45-second timeout
  and an 8,192-token output limit. HTTP failures (including quota/auth errors),
  refused or truncated completions, and invalid task JSON invoke the Gemini
  fallback. If Gemini also exhausts its retries, the execution fails with both
  provider errors preserved; it does not restart OpenRouter or Gemini.
  No paid OpenRouter models or search plugins are enabled: requests also set
  zero provider price caps for input, output, and per-request charges.
- Gemini retains three attempts for sentiment fallback and, independently, three
  for Tomek video analysis, plus four for mention replies, with five-second delays.
  Its per-request timeouts are 60 seconds for
  index and 45 seconds for replies. This bounds inference time before the
  Appwrite execution timeout; other network and processing work also consumes
  that execution budget.
- Generation and validation finish before any Wykop posting. Provider fallback
  does not repeat a Wykop POST. Existing Cloudflare schedules, the daily index's
  ten whole-run retries, and existing posting semantics are unchanged.

Free OpenRouter endpoints have account-level daily and per-minute request
limits and can still run out of capacity. Index sentiment generation uses that
allowance when a key is configured; Tomek analysis and mention replies do not
call OpenRouter. Requests in later executions count again.
Idle `wykop-post` polls make no Gemini request.
Tavily/Brave have their own quotas.

References: [OpenRouter free limits](https://openrouter.ai/collections/free-models),
[Nemotron 3.5 Super VL](https://openrouter.ai/nvidia/nemotron-3.5-super-vl:free),
[structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs),
[provider price caps](https://openrouter.ai/docs/guides/routing/provider-selection#max-price).

## Tests

With Node.js 22 or newer, run from the repository root:

```sh
node --test functions/test/*.test.mjs
node --check functions/wykop-index/src/main.js
node --check functions/wykop-post/src/main.js
```

The tests use mocked inference and do not publish Wykop replies or contact paid
services. They cover index provider routing and failures, packaged-model
selection, response contracts, and preservation of the current-price guard.
Mention-entrypoint tests verify Gemini routing with old OpenRouter configuration,
attachments elsewhere in a thread, and Gemini's model/key retry sequence.
Index-entrypoint tests verify OpenRouter sentiment alongside Gemini-only Tomek
analysis, including video retries and continuing when video analysis fails.
Deployment regression tests cover zero-exit CLI failures, unchanged activation,
non-ready builds, permission failures, and successful activation. The tests do
not measure Polish model quality or live provider availability.
