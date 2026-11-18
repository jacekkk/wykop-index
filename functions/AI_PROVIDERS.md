# AI providers for the Appwrite functions

Both functions can use OpenRouter's `baidu/ernie-5.5-flash-preview:free` for
structured text generation, with Gemini as fallback. This gives the daily index
and text-only mention replies a provider hosted outside Google. ERNIE is a
preview model; equivalent quality on Polish financial slang has not been
established by the automated tests.

## Configure and deploy after review

In the Appwrite console, add the following environment variables to **each** of
`wykop-index` and `wykop-post`. Store API keys as secret variables; do not commit
them or paste them into a pull request.

| Variable | Value / behavior |
| --- | --- |
| `OPENROUTER_API_KEY` | An OpenRouter API key. Required to activate OpenRouter. |
| `AI_PROVIDER` | Set to `openrouter` for explicit activation; `gemini` forces rollback. When unset, OpenRouter is selected if its key exists, otherwise Gemini is used. |
| `OPENROUTER_MODEL` | Optional Appwrite/local selector when deploying outside GitHub. The GitHub deployment workflow packages its repository-variable selection instead, taking precedence over this environment value. Only `:free` models are accepted. |
| `GEMINI_API_KEY` | Retain for inference fallback and Gemini media/URL processing. |
| `GEMINI_BACKUP_API_KEY` | Optional second Gemini key for `wykop-post`. When absent, the primary key is reused. |
| `GEMINI_MODEL` | Optional; defaults to `gemini-3.8-flash`. |
| `GEMINI_FALLBACK_MODEL` | Optional; defaults to `gemini-3.6-flash`. |

An explicitly configured OpenRouter provider with no key fails with a
configuration error. An installation with neither new variable keeps using
Gemini, so deploying the code before configuring the key does not disable it.
Keep the existing Appwrite and Wykop credentials.

After configuring the variables, deploy both function directories using the
existing Appwrite deployment process. For verification, inspect provider logs and the next normal execution;
submission to Appwrite alone does not establish successful posting. For quality
evaluation, compare the same saved Wykop batch across models without running the
posting handlers.

## Deploy from GitHub

After this PR is reviewed and merged, use the manual **Deploy Appwrite functions**
workflow to deploy both functions from the default branch.

1. In **Settings > Secrets and variables > Actions > Variables**, create the
   repository variable **`OPENROUTER_MODEL`**, for example
   `baidu/ernie-5.5-flash-preview:free`.
2. On the **Secrets** tab of the same settings page, add **`APPWRITE_FUNCTIONS_API_KEY`**: an Appwrite
   project API key with `functions.read` and `functions.write`. This is separate
   from the execution-only scheduler key. The OpenRouter key stays in Appwrite.
3. Retain the existing repository variables `APPWRITE_ENDPOINT`,
   `APPWRITE_PROJECT_ID`, `APPWRITE_WYKOP_INDEX_FUNCTION_ID`, and
   `APPWRITE_WYKOP_POST_FUNCTION_ID`, pointing to the deployed functions.
4. Run **Actions > Deploy Appwrite functions > Run workflow** on the default branch.

The workflow tests the functions, validates `OPENROUTER_MODEL`, and packages that
selection into each function before uploading and activating them with the
pinned Appwrite CLI. Existing Appwrite variables, including API keys, are
preserved: the CLI is not run with `--with-variables`. The workflow does not
invoke either function. Their deployed settings come from `appwrite.config.json`;
the existing Cloudflare scheduling configuration is unchanged.

Editing the GitHub variable alone does **not** update running functions: rerun
the deployment workflow after each change. An empty/unset variable packages the
default `baidu/ernie-5.5-flash-preview:free`. This selection takes precedence over
any older Appwrite `OPENROUTER_MODEL` value. Outside this workflow, the committed
`deployment-model.js` placeholder allows the Appwrite environment value to be
used instead. The functions deploy sequentially; if the second fails, the first
may already be updated.

Reference: [Appwrite non-interactive CLI deployments](https://appwrite.io/docs/tooling/command-line/non-interactive).

## Search, attachments, and response handling

- `wykop-index` uses the selected provider for the sentiment JSON. Its optional
  Tomek YouTube analysis remains on Gemini and can still be skipped on failure.
- `wykop-post` keeps its existing Tavily/Brave searches, retrieved sources, and
  Yahoo current-quote lookup. Text-only requests send that context to the selected
  model; this does not enable paid Google Search grounding.
- Mention batches containing photos, video embeds, or user-supplied HTTP URLs
  use Gemini directly, preserving its attachment and URL-context processing.
  These batches remain dependent on Gemini availability; attachments are not
  silently dropped to force a text-only provider call.
- OpenRouter returns a strict JSON-schema object. Reply arrays are wrapped as
  `{"replies": [...]}` for that API and unwrapped before the existing posting
  path. Both providers pass through local task validation. The current-price
  guard applies to replies from either provider.
- One OpenRouter request is attempted per generation, with a 45-second timeout
  and an 8,192-token output limit. HTTP failures (including quota/auth errors),
  refused or truncated completions, and invalid task JSON fall back to Gemini.
  No paid OpenRouter models or search plugins are enabled: requests also set
  zero provider price caps for input, output, and per-request charges.
- Gemini retains three attempts for index generation and four for mention
  replies, with five-second delays. Its per-request timeouts are 60 seconds for
  index and 45 seconds for replies. This bounds inference time before the
  Appwrite execution timeout; other network and processing work also consumes
  that execution budget.
- Generation and validation finish before any Wykop posting. Provider fallback
  does not repeat a Wykop POST. Existing Cloudflare schedules, the daily index's
  ten whole-run retries, and existing posting semantics are unchanged.

Free OpenRouter accounts normally have a shared allowance of 50 free-model
requests per day without purchasing credits. Both functions share the allowance
if they use the same account. Idle `wykop-post` polls make no model request;
generation attempts in later executions count again. Free endpoints can still
run out of capacity. Tavily/Brave have their own quotas.

References: [OpenRouter free limits](https://openrouter.ai/collections/free-models),
[ERNIE model](https://openrouter.ai/baidu/ernie-5.5-flash-preview:free),
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
services. They cover both adapters, free request routing, provider failures,
response contracts, media routing, and preservation of the current-price guard.
They also check the packaged model selection in both isolated function uploads.
They do not measure Polish model quality or live provider availability, and the
deployment workflow has not been run against production.

`ai-provider.js` is intentionally included in each function directory because
Appwrite uploads those directories independently. The tests check both copies
and ensure they remain identical.
