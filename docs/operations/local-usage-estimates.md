# Local subscription estimate storage

The server opens a dedicated local estimate database at startup. Existing Usage
scans record token usage and quota observations in it, using the existing readers
and provider registry snapshots. Codex weekly observations still come from the same
incremental transcript read; other windows use the latest successful quota probe.
There is no additional poller: opening or refreshing
Usage triggers collection, and a running server alone does not scan in the background.
Collection covers the transcript files selected by that scan, before model filters.
The Limits view on web, desktop and mobile reads those local estimates through the
existing usage summary. Refreshing limits also refreshes usage collection. No new
server process, remote upload or background timer is required.

## Cards and history

Each provider, account, device and quota window stays separate. Current cards use cycle-to-date local cost divided
by total consumed quota, assuming the cycle's usage took place on this device.
The start is the reported cycle start, or reset minus its reported window duration.
Without either, new probes build an observation interval, not an assumed calendar month. A rising
quota high-watermark closes each sample; repeated or regressive session-cache ticks
do not add an unsettled tail. Reset clocks within 60 seconds are treated as the same
cycle. At least five percentage points are required; incomplete prices, unknown
speed, invalid records or conflicting plans prevent a numeric estimate. Account
identity remains unconfirmed for legacy Codex logs. Generic sources bind to the
current login but still assume that login owns the cycle's local history. Multiple
different logins sharing one history directory block estimation. Explicit offline interval replay retains its original
strict continuous-interval calculation.

The card's remaining value uses the sample endpoint, not the live pooled quota.
After that cycle expires it hides the current amounts and retains history. It
shows recorded cycle cost separately from extrapolated full-cycle cost, with
the environment, device, directory, interval and model breakdown available.

Codex quota increases and fresh provider probes generate idempotent points in the same SQLite database.
They use a distinct calculation basis and identity from legacy interval results.
Existing stored rows are never rewritten; the chart prefers cumulative samples for
a cycle once they exist, while retaining older cycles and legacy rows in storage.
Historical points keep their original price version and result; the current card
can reflect newly imported records and newer API prices. Refreshing unchanged data
does not append points. The summary returns up to 2,000 points per source from the
last 92 days; older stored records are not deleted. Hour/day charts use the last
sample in each local calendar bucket, including an invalid last sample. Missing
buckets, invalid samples, calculation-basis changes, cycle resets and price changes break
the line. No points are synthesized for idle periods.

Pricing snapshots include built-in dated rules and explicit custom token prices, hashed
with the fetched price-table version and built-in rule revision. The current calculation
uses the latest snapshot; old result rows remain immutable. Unknown internal models are
still blockers, and zero custom prices are explicit user choices rather than missing-rate fallbacks.
Defaults are documented in `apps/server/src/usage/usageDefaultPrices.ts` with official
Google/Devin source URLs (verified 2026-11-11). Gemini 4 standard rates are $2/$10 per
million input/output tokens with $0.10 cache reads through the introductory period,
then $4/$20/$0.20. The precise transition uses December 1, 08:00 UTC as published by Devin.
SWE-2 has $3/$15/$0.30 API list rates; its self-serve Devin quota exemption ends then.
SWE-2 Flash has $0.10/$0.50/$0.01 list rates and $0.125 cache writes; its self-serve
exemption ends December 4, 18:00 UTC. Missing cache-write rates use the existing input-rate
convention. Free rules apply only to a matching provider and confirmed Free/Pro/Max/Teams plan;
cloud/API-only requests and unknown/enterprise plans do not inherit them. Ordinary cost
reports retain API list equivalent, while quota cards annotate excluded free requests.

`usageLimits.subscription.periodEndsAt` is optional and comes only from an actual plan or
billing period field (Devin `planEnd`, Cursor `billingCycleEnd`). Quota clocks never populate
it by inference. Clients show a seven-day reminder without asserting auto-renew or cancellation.
The same snapshot preserves the confirmed plan name even when ACP capability enrichment
omits the general auth label. Discovering a previously unknown plan does not imply a plan
change; two different known plans still invalidate the cycle. Antigravity's valid empty
SQLite placeholders are empty history; unreadable or populated unknown schemas remain errors.

## Local ownership

The production store is a separate `usage-estimates.sqlite` file in T3's configured
user data directory (`ServerConfig.stateDir`). On this installation its designated
path is `C:\Users\gh\.t3\userdata\usage-estimates.sqlite`. It follows the configured
T3 home rather than the program installation directory. Development follows the
configured development state directory. SQLite may create adjacent `-wal` and `-shm`
files while the database is open. The connection is private to estimate storage and
does not replace or add tables to `statev2.sqlite`.

Complete transcript lines commit before the scanner advances its cache. Unfinished
tails stay out of the database. Repeated scans and copied rollouts deduplicate by
origin event identity. A database identity in the checkpoint forces a fresh parse
if the estimate database is recreated; old usage caches retain their deleted-file
history. Schema version 2 upgrades version 1 replay databases without changing saved
results. Pricing snapshots use the server's model API rate table, without custom
prices or model aliases; unavailable prices are not invented.

Offline replay selects an isolated validation database with `--db`. The replay
command refuses the live T3 userdata directory and the application's state database
names. Validation databases stay separate from production data. The store also
refuses databases that belong to another feature. It never writes back to Codex
session files.

Local logs and future remote downloads use the same storage boundary:
`UsageEstimateStore.ingest({ source, events })`. Data is committed locally before
`evaluate` reads it. A download retains the original device and source identifiers;
the receiving machine must not relabel it as its own consumption. This workflow adds
no remote upload or authentication service. Cursor's existing account reader still
downloads account history into its local cache and marks that scope as account-wide.

Sources pin a device, account binding and coverage scope. A historical replay uses
an unknown account and selected-session coverage. Neither today's login nor a
matching reset time upgrades that binding. A future caller needs independently
verified identity information before supplying an account-bound source; the store
does not authenticate that assertion. Identity changes require a new source segment.
Legacy Codex collection keeps the account unconfirmed and coverage limited to
scanned sessions. Its source key includes the host, resolved directory and volume.
Generic source keys additionally bind the driver, login identity, instance and
window. Antigravity and Claude model groups are filtered independently; OpenCode
Go excludes direct API providers. Missing request billing allocation (Cursor),
unpriced models (including proprietary Devin models), partial readers and shared
account histories surface blockers rather than zero-priced estimates. Devin opens
its native SQLite database read-only and extracts only accounting fields. It
deduplicates request IDs across rendered assistant message copies.
Session-cached quota values remain marked as cached, even when stored during a live scan.

The database contains source identity/revisions, normalized usage and quota
observations, immutable price versions, and saved interval results. It contains no
chat transcript or login credentials. Origin event identifiers survive a log move
and repeat import. Conflicting content for the same identifier aborts the entire
import. New data advances the source revision; duplicate data does not. Results
reference that revision and price version, so old results remain unchanged after
late imports or repricing. Identical evaluation requests return the saved result.

## Initialize an installed home

An updated server creates the file automatically. To initialize only the estimate
database ahead of that update, without starting a server or importing test data:

```powershell
node apps/server/scripts/init-usage-estimates.ts --home 'C:\Users\you\.t3'
```

The command uses the same store layer as the server and can be repeated. It reports
the path and persistent database identity. It does not update or restart an installed
application; automatic collection requires an application build containing this code.

## Replay

From the repository root, run:

```powershell
node apps/server/scripts/replay-usage-estimates.ts `
  --db 'D:\UsageValidation\usage-estimates.sqlite' `
  --prices 'C:\Users\you\.t3\userdata\usage-model-rates.json' `
  --source 'workstation-codex-history' `
  --device 'workstation' `
  --from '2026-11-09T00:00:00Z' `
  --until '2026-11-10T00:00:00Z' `
  'C:\Users\you\.codex\sessions\2026\11\09\rollout-example.jsonl'
```

Supply the actual origin device/source IDs consistently across repeated reads.
Additional transcript paths can follow the first. Omit `--from` and `--until` to
inspect the complete imported source. Only explicitly supplied files are read;
this is bounded replay, not a background directory scanner. An unfinished final
line is excluded and reported. Malformed complete records fail visibly.

Pricing uses the named local cache and records its exact rates and fetch version.
Custom settings overrides are not loaded by this command. Changing rates under an
existing version is rejected; a different version creates a separate result.

## Interpreting a result

Bounds select the first and last weekly `codex` observations in that range.
Consumption uses `(first observation, last observation]`. Other window types are
not substituted. This convention is reproducible; it does not prove the account
service settled every request at those boundaries.

The calculation is recorded API-equivalent cost times 100 divided by consumed
percentage points. Remaining equivalent uses the last observation's percentage,
**not a current online balance**. Five points is the initial display threshold,
not a statistical confidence guarantee. No uncertainty bounds are fabricated.

- `collecting`: insufficient endpoints, usage or percentage movement; no estimate.
- `blocked`: a reset/plan change, raw percentage regression, expired observation,
  malformed usage, unknown speed, unsupported provider or unpriced model prevents
  this interval from being used. Narrow the bounds or repair the actual source;
  do not replace missing cost with zero or flatten regressions with a running max.
- `reference_only`: a numeric replay exists, but identity, coverage or cached
  quota observations prevent treating it as the current subscription estimate.
- `estimated`: the supplied metadata permits an estimate; it remains conditional
  on the interval's model mix and observed coverage, not an official dollar limit.

Codex historical replay normally returns `reference_only`, even if every selected
record was readable. Other sessions or devices can have contributed to the same
account percentage. Missing events and delayed quota updates can bias the result
in either direction. This command deliberately does not infer account ownership,
cross-device completeness or settlement from the file alone.

## Focused validation

```powershell
.\node_modules\.bin\vp.cmd test run apps/server/src/usage/usageEstimate.test.ts apps/server/src/usage/UsageEstimateStore.test.ts
```

These tests cover calculation boundaries, cached observations, missing prices,
window changes, persistence across reopen, duplicate imports, identity conflicts,
transaction rollback and price history. Runtime integration is covered by
`apps/server/src/usage/UsageService.test.ts` and streaming quota projection by
`apps/server/src/usage/usageTranscriptStreaming.test.ts`. Real-log replay is separate
evidence and does not establish account-wide coverage or validate a production usage card.
