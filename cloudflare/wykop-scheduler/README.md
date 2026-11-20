# Cloudflare cron schedulers

Two independently deployed Workers submit asynchronous Appwrite executions:

| Worker | Function | Configuration | Cron (UTC) |
| --- | --- | --- | --- |
| `wykop-scheduler` | `wykop-index` | `wrangler.jsonc` | `10 19 * * MON-FRI` — weekdays at 19:10 UTC |
| `wykop-post-scheduler` | `wykop-post` | `wrangler.post.jsonc` | `*/5 * * * *` — every five minutes |

The index Worker keeps the existing `wykop-scheduler` name, entrypoint, Durable
Object binding, class, and migration. Deploying this configuration to the same
Cloudflare account preserves its retry namespace and stored runs. Do not rename
or delete that Worker during the split. The post Worker has no Durable Objects.
Each entrypoint rejects the other function's cron, including a stale five-minute
event delivered to the index Worker during cron propagation.

The Workers have separate enable flags, secrets, deployments, and logs. Their
Appwrite request client and tests share this npm package. In this checkout the
existing index Worker remains enabled; the new post Worker starts **disabled**
until its secret is configured and the old post schedule is removed.

These preserve the intended former GitHub workflow schedules. Cloudflare numbers
Sunday as 1 and Saturday as 7, so its numeric `1-5` range means Sunday–Thursday.
Use explicit `MON-FRI` to include Friday and exclude Sunday. See
[Cloudflare's cron syntax](https://developers.cloudflare.com/workers/configuration/cron-triggers/#supported-cron-expressions).

The GitHub `schedule` triggers have already been removed; both workflows retain
`workflow_dispatch` for manual use.
Cloudflare Cron Triggers use UTC; daylight saving time does not shift these times.
At 19:10 on weekdays both functions are submitted independently, without ordering.

`wykop-index` is monitored and retried up to **ten times**, with a **10-minute
delay after each confirmed failure** (eleven executions maximum including the first).
`wykop-post` continues to submit once per five-minute cron event, without retries.

## Configuration

Each Wrangler configuration contains the endpoint, project, and its own function
ID from the root `appwrite.config.json`. Update them if you use a different project.
`APPWRITE_ENDPOINT` must be an HTTPS API base URL including `/v1`, without URL
credentials, a query, or a fragment. Redirects are rejected to protect the API key.

`SCHEDULER_ENABLED` applies only to the Worker whose configuration you deploy.
Only the exact string `"true"` enables submissions. Disabled invocations log
`scheduler_disabled` and do not require an Appwrite key. For a new installation,
set both configurations to `"false"` before deploying and adding secrets.

Store `APPWRITE_API_KEY` as a secret **on each Worker**. The existing index secret
is retained when redeploying the same Worker; it is not copied to a new Worker.
Enter the same Appwrite project key at the new Worker's secure prompt, or use a
separate key. Index needs `execution.write` and `execution.read` to monitor
completion before retrying; post only needs `execution.write`. Set an appropriate
expiry date. These keys manage executions, rather than supplying the functions'
own runtime keys. Do not commit a key, put it in a Wrangler configuration, or pass
it on a command line. A local `.dev.vars` file is ignored by Git.

## Test and bundle

Requirements: Node.js 22 or newer, npm, and a Cloudflare account with Workers
permissions. Wrangler 4 is included as a development dependency and locked in
`package-lock.json`. Index retries use one SQLite-backed Durable Object per UTC
date. The existing binding and class migration remain in `wrangler.jsonc`.
SQLite-backed Durable Objects are available on Workers Free.

```sh
cd cloudflare/wykop-scheduler
npm ci
npm test
npm run check
```

`npm run check` bundles **both** Workers without deploying them. GitHub's
**Test Cloudflare schedulers** workflow runs these checks and tests for changes
here. It does not deploy. The Appwrite deployment workflow also does not deploy
Cloudflare Workers; merging this PR alone does not change the live schedules.

| Action | Index | Post |
| --- | --- | --- |
| Local development | `npm run dev:index` (port 8787) | `npm run dev:post` (port 8788) |
| Bundle only | `npm run check:index` | `npm run check:post` |
| Deploy | `npm run deploy:index` | `npm run deploy:post` |
| Set secret | `npx wrangler secret put APPWRITE_API_KEY --config wrangler.jsonc` | `npx wrangler secret put APPWRITE_API_KEY --config wrangler.post.jsonc` |
| Live logs | `npx wrangler tail --config wrangler.jsonc` | `npx wrangler tail --config wrangler.post.jsonc` |

For compatibility, `npm run deploy` and `npm run dev` target index only. There is
no command that deploys both Workers together. Both have `workers_dev` and preview
URLs disabled, and HTTP requests return 404.

For local event routing without creating executions, put
`SCHEDULER_ENABLED="false"` in `.dev.vars`, start each local Worker, then:

```sh
curl --get 'http://localhost:8787/__scheduled' --data-urlencode 'cron=10 19 * * MON-FRI'
curl --get 'http://localhost:8788/__scheduled' --data-urlencode 'cron=*/5 * * * *'
```

Check for `scheduler_disabled` in the local Wrangler output. This verifies local
Cron routing only, not Appwrite access. The automated tests use fake credentials
and mocked HTTP responses. The tests cover the retry limit and exact delays with
a controllable clock, success, uncertain submissions, read failures, and recovery
after a crash. Runtime tests exercise real alarms and RPC, preserve SQLite state
across a complete runtime restart, reject redirects without forwarding keys,
and exercise the two entrypoints separately without the other function's binding.

## Split the existing production Worker

After review and merge, use this order in the same Cloudflare account as the
current `wykop-scheduler` Worker:

1. Run `npx wrangler login`. Keep `SCHEDULER_ENABLED: "false"` in
   `wrangler.post.jsonc`. Run `npm run deploy:post`, then
   `npx wrangler secret put APPWRITE_API_KEY --config wrangler.post.jsonc`.
   The new post Worker remains disabled while the existing Worker keeps running.
2. Run `npm run deploy:index`. This keeps the original Worker, secret, and retry
   namespace, fixes the weekday cron to `MON-FRI`, and removes its post cron and
   post event handler. Existing index retries retain their state and alarms.
3. Allow up to 15 minutes for cron changes to propagate. Confirm in Cloudflare
   that `wykop-scheduler` has only the weekday index trigger, and wait for any
   post executions submitted by the old Worker to finish in Appwrite.
4. Change `SCHEDULER_ENABLED` to `"true"` in `wrangler.post.jsonc` and run
   `npm run deploy:post`. Commit the enabled configuration so later deployments
   retain it. There is a short post scheduling pause between steps 2 and 4;
   keeping the new Worker disabled until then avoids two active post schedulers.
5. Watch each Worker's logs separately. Verify a post execution at the next
   five-minute slot and index at its next weekday 19:10 UTC slot. The log
   `appwrite_execution_submitted` means Appwrite accepted an execution, not that
   the function finished: check status `completed` with HTTP 2xx in Appwrite.
   Index additionally logs `index_execution_succeeded` or `index_retry_scheduled`.

Cron changes do not backfill a missed slot. Manual GitHub/Appwrite runs are
independent of the coordinator, so check for running executions first. GitHub
schedules should remain disabled, and neither Appwrite function should have a
second active schedule.

## New installation and pausing

For a fresh account, set `SCHEDULER_ENABLED: "false"` in **both** configurations,
deploy each Worker, and set `APPWRITE_API_KEY` separately using the commands above.
Confirm the Appwrite endpoint, function IDs, and key scopes. Disable any other
schedulers and let their in-flight executions finish before enabling the two
Workers. Change each flag to `"true"`, deploy that Worker, and commit the enabled
configuration. Tests, dry runs, and deployments with submissions disabled do not
invoke the functions.

To pause either function, set its flag to `"false"` and deploy only that Worker.
Verify `scheduler_disabled` in its logs. Pausing index also pauses pending index
attempts; post is unaffected. Existing Appwrite executions continue. Before
restoring another scheduler, wait for outstanding executions to finish. To undo
the split, disable the new post Worker first and drain its executions before
restoring post routing and its five-minute trigger on the original Worker.

## Index retry policy

- The weekday 19:10 UTC cron starts a persisted run for that UTC date. Repeated
  delivery of the same day's cron cannot create a second run.
- After submitting index, its Durable Object polls the same Appwrite execution
  every 30 seconds. `completed` with HTTP 2xx succeeds and stops the run. `failed`
  or `completed` with any other HTTP status counts as a confirmed failure.
- A failed attempt schedules the next submission for 10 minutes after the failure
  is observed. There are ten retries after the first attempt: eleven executions
  maximum. The delay starts after failure, rather than blindly starting jobs at
  19:20/19:30 while an earlier 15-minute execution might still be running.
- While Appwrite reports `waiting`, `processing`, or `scheduled`, the coordinator
  keeps reading the same ID and does not spend an execution retry. Read timeouts,
  malformed status responses, and HTTP errors also do not cause a new submission.
  HTTP 401/403/404 reads are rechecked after 10 minutes; other read errors after
  30 seconds. In particular, missing `execution.read` permission blocks retries
  until status reads work again.
- State and the next alarm are stored together. Restarting or redeploying the
  Worker preserves the attempt count, execution ID, and retry time. A crash during
  an unconfirmed POST stops that run as `uncertain`; it never automatically sends
  the POST again. Inspect Appwrite before manually retrying such a run.
- After increasing the retry limit, an exhausted run with remaining budget can
  be resumed through its internal `start(originalScheduledTime)` RPC. This keeps
  the attempt count and rechecks the last execution before scheduling another
  ten-minute delay. Redeploying alone does not resume an already exhausted run.
- `SCHEDULER_ENABLED: "false"` pauses pending attempts as well as new cron
  submissions. Paused index runs recheck the flag every 10 minutes. Re-enabling
  resumes persisted work; it does not reset the attempt count or cancel an
  execution already running in Appwrite.
- Logs include `index_run_scheduled`, `index_retry_scheduled`,
  `index_execution_succeeded`, `index_retries_exhausted`,
  `index_execution_read_failed`, `index_retry_budget_increased`, and
  `index_submission_uncertain`. After eleven failures, the run stops and the next
  weekday starts its own run.

## Behavior and limitations

- Every execution submission makes one POST to
  `/functions/{functionId}/executions` with `{ "async": true, "body": "{}" }`,
  using `X-Appwrite-Project` and `X-Appwrite-Key`. An accepted response must include
  an execution ID. The request times out after 30 seconds.
- Index completion polling and delays use persisted alarms instead of keeping
  a Worker invocation alive for the entire retry window. Post executions are not
  monitored or retried. Appwrite's function timeouts (900 seconds for index, 300 for post) are
  unchanged; long-running work continues in Appwrite after a Worker event exits.
- There are no automatic submission retries, including after HTTP 429/5xx,
  timeouts, malformed responses, or redirects. The scheduled handler calls
  `noRetry()` to disable platform retries. An uncertain response may still mean
  Appwrite created the execution. Inspect Appwrite before manually resubmitting.
  A later regular post cron event is an independent invocation.
- The index coordinator deduplicates a day's cron and prevents overlapping
  retries in that run. Separate days and manual executions are independent.
  Post executions have no distributed lock. GitHub's concurrency group does not
  apply to Cloudflare or Appwrite manual runs. This does not make Wykop posting
  exactly-once: a function that posts and then fails could post again on retry.
- Cron execution can be delayed; missed events are not backfilled by this Worker.
  Use Appwrite execution history to monitor actual function outcomes. Worker
  errors reject the `waitUntil` promise so Cloudflare can report failed events;
  logs include job/execution IDs, never API keys or upstream response bodies.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Only `scheduler_disabled` logs | Set `SCHEDULER_ENABLED` to `"true"` in that Worker's configuration and deploy it after completing the transition. |
| No cron logs | Worker account/name, deployed cron settings, propagation delay, and Cloudflare dashboard event history. `wrangler tail` shows live events only. |
| Missing configuration error | Worker variables and the `APPWRITE_API_KEY` secret on the correct account/Worker. |
| HTTP 401/403 | API key project, expiry, and both `execution.write` and `execution.read` scopes. |
| HTTP 404 | Appwrite API endpoint including `/v1` and the selected function ID. |
| HTTP 429/5xx, timeout, or malformed response | Inspect Appwrite executions before retrying to avoid duplicate posts. Check service health and quotas. |
| Submitted execution later fails | Inspect its Appwrite execution logs and function environment variables; successful submission does not mean successful execution. |
| `index_execution_read_failed` | Check Appwrite availability and the `execution.read` scope. The coordinator keeps the same execution ID and does not submit a retry while its outcome is unknown. |
| `index_submission_uncertain` | Inspect Appwrite manually; the run has stopped to avoid duplicating an unconfirmed submission. |
| `index_retries_exhausted` | All eleven index attempts failed. Inspect the last Appwrite execution; no more retries are scheduled for that day's run. |
