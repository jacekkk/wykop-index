# Cloudflare cron scheduler

This Worker submits asynchronous Appwrite executions for the existing functions:

| Function | Cron (UTC) | Time |
| --- | --- | --- |
| `wykop-index` | `10 19 * * 1-5` | Weekdays at 19:10 UTC |
| `wykop-post` | `*/5 * * * *` | Every five minutes |

These preserve the former GitHub workflow schedules. The GitHub `schedule`
triggers have been removed; both workflows retain `workflow_dispatch` for manual use.
Cloudflare Cron Triggers use UTC; daylight saving time does not shift these times.
At 19:10 on weekdays both functions are submitted independently, without ordering.

`wykop-index` is monitored and retried up to **ten times**, with a **10-minute
delay after each confirmed failure** (eleven executions maximum including the first).
`wykop-post` continues to submit once per five-minute cron event, without retries.

## Configuration

`wrangler.jsonc` contains the endpoint, project, and function IDs from the root
`appwrite.config.json`. Update them if you use a different Appwrite project.
`APPWRITE_ENDPOINT` must be an HTTPS API base URL including `/v1`, without URL
credentials, a query, or a fragment. Redirects are rejected to protect the API key.

`SCHEDULER_ENABLED` is `"true"` for the configured production Worker. For a new
installation, set it to `"false"` before the first deployment so you can configure
the secret before submissions start. Only the exact string `"true"` enables
submissions. Disabled invocations log `scheduler_disabled` and do not require an
Appwrite key.

Store `APPWRITE_API_KEY` as a Cloudflare Worker secret. Use an Appwrite project
API key with both `execution.write` and `execution.read` scopes and an appropriate
expiry date. Read access is required to monitor index completion before deciding
whether to retry. The key is for execution management, not the function's own
runtime API key. Do not put it
in `wrangler.jsonc`, commit it, or pass it on a command line. A local `.dev.vars`
file is ignored by Git, if needed for development.

## Test and deploy

Requirements: Node.js 22 or newer, npm, and a Cloudflare account with Workers
permissions. Wrangler 4 is included as a development dependency and locked in
`package-lock.json`. Index retries use one SQLite-backed Durable Object per UTC
date. The binding and initial class migration are included in `wrangler.jsonc`;
Wrangler creates the namespace during deployment. SQLite-backed Durable Objects
are available on Workers Free.

For a new installation, first set `SCHEDULER_ENABLED` to `"false"` as described
above. Keep an existing production installation enabled when redeploying it.

```sh
cd cloudflare/wykop-scheduler
npm ci
npm test
npm run check
npx wrangler login
npm run deploy
npx wrangler secret put APPWRITE_API_KEY
```

The last command securely prompts for the key. At this point cron events are
configured, but submissions remain disabled. No Appwrite function runs as part
of tests, bundle validation, or deployment with submissions disabled.
`workers_dev` and preview URLs are disabled, and HTTP requests return 404; there
is no HTTP endpoint for manually running production functions.

For local event routing without creating executions, set `SCHEDULER_ENABLED` to
`"false"`, run `npm run dev`, then in another terminal:

```sh
curl --get 'http://localhost:8787/__scheduled' --data-urlencode 'cron=*/5 * * * *'
```

Check for `scheduler_disabled` in the local Wrangler output. This verifies local
Cron routing only, not Appwrite access. The automated tests use fake credentials
and mocked HTTP responses. The tests cover the retry limit and exact delays with
a controllable clock, success, uncertain submissions, read failures, and recovery
after a crash. Runtime tests exercise real alarms and RPC, preserve SQLite state
across a complete runtime restart, and reject redirects without forwarding keys.

## Activate Cloudflare scheduling

1. Deploy with `SCHEDULER_ENABLED: "false"` and set the secret as above. Confirm
   the endpoint and function IDs against your deployed Appwrite functions.
2. Merge this change into the repository's default branch to remove the GitHub
   `schedule` triggers from **Run wykop-index** and **Run wykop-post**. Manual
   `workflow_dispatch` runs remain available. Wait for any running or queued
   GitHub runs and their Appwrite executions to finish. Also check that neither
   Appwrite function has its own active schedule. Avoid manual executions during
   this transition.
3. Change `SCHEDULER_ENABLED` to `"true"` in `wrangler.jsonc` and run
   `npm run deploy`. Cloudflare cron changes can take up to 15 minutes to propagate.
4. Ensure the Appwrite key has both `execution.read` and `execution.write`.
   Run `npx wrangler tail` and watch for `appwrite_execution_submitted`. Inspect
   each logged execution ID in the Appwrite console and confirm it finishes
   successfully (status `completed`, HTTP 2xx). Verify `wykop-post` on a five-minute
   interval and `wykop-index` at its next weekday 19:10 UTC slot. A submission log
   alone is not proof of a successful function run. The index coordinator logs
   `index_execution_succeeded` once it confirms successful completion, or
   `index_retry_scheduled` after a confirmed failure.
5. Commit the enabled Worker configuration so future deployments keep it active.

GitHub scheduling is deliberately removed in this change because of its reported
unreliability. Until the Worker is deployed, configured, and enabled, automatic
executions will be paused. Keeping two active schedulers can generate duplicate
Wykop replies. Manually dispatching a retained workflow can also overlap a
Cloudflare execution: check Appwrite first.

To roll back, deploy `SCHEDULER_ENABLED: "false"`, verify Cloudflare logs show
disabled events, and let outstanding Appwrite executions finish. Then restore
the GitHub schedules if desired. Changing the flag
does not cancel executions already submitted.

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
| Only `scheduler_disabled` logs | Set `SCHEDULER_ENABLED` to `"true"` and redeploy after pausing GitHub. |
| No cron logs | Worker account/name, deployed cron settings, propagation delay, and Cloudflare dashboard event history. `wrangler tail` shows live events only. |
| Missing configuration error | Worker variables and the `APPWRITE_API_KEY` secret on the correct account/Worker. |
| HTTP 401/403 | API key project, expiry, and both `execution.write` and `execution.read` scopes. |
| HTTP 404 | Appwrite API endpoint including `/v1` and the selected function ID. |
| HTTP 429/5xx, timeout, or malformed response | Inspect Appwrite executions before retrying to avoid duplicate posts. Check service health and quotas. |
| Submitted execution later fails | Inspect its Appwrite execution logs and function environment variables; successful submission does not mean successful execution. |
| `index_execution_read_failed` | Check Appwrite availability and the `execution.read` scope. The coordinator keeps the same execution ID and does not submit a retry while its outcome is unknown. |
| `index_submission_uncertain` | Inspect Appwrite manually; the run has stopped to avoid duplicating an unconfirmed submission. |
| `index_retries_exhausted` | All eleven index attempts failed. Inspect the last Appwrite execution; no more retries are scheduled for that day's run. |
