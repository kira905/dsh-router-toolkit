# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); this project uses 0.x semantics
(minor bumps may break compatibility — see the note below).

## 0.4.1

Two small correctness fixes, both of which had been shipping wrong for several releases:

* **The version string now follows `package.json`.** `router-act.mjs` and `router-guard.mjs` each used to
  declare their own `VERSION` constant, so bumping the package left both still printing `0.3.0` at 0.4.0.
  Both now read `package.json` at load time (one read, a fallback constant only if the file is missing),
  so a release bump has a single place to touch.
* **Bare `--help` exits 0.** `node router-act.mjs --help` (no verb) used to exit **2**, which reads as an
  error to every wrapper and CI harness; it now exits 0 like the rest of the ecosystem. Asking for help is
  success. Giving *neither* a verb nor `--help` still exits **2** — a missing verb is still an error.

## 0.4.0

Three new surfaces — none of them existed in this repo before, all three had been running on a live
instance first, and each one used to carry at least one private coupling that is now gone:

* **`router-lazy`** — "is this workstream actually idle, and what should be nudged" (four buckets +
  a *nudged N times today* column).
* **`yearring-index`** — a pure read-only index over a "one vision file per workstream" directory.
* **an optional web plugin** — an explicit *wrap up and compact* button (host route + input-toolbar half).

Nothing was removed: still seven verbs, still two delivery gates, still zero third-party runtime
dependencies. What changed about the private bits is the interesting part: a hard-coded home path became
`--dir` / `--profile` / `DSH_HOME` resolution, a private request header became `ROUTER_BOARD_HEADERS`
(this tool has always refused to guess private header names), a hard-coded route prefix became
`routePrefix`, and "where does the workstream name come from" became an injectable `resolveLine`.

**Per-file provenance** (distilled by hand — these are *not* copies; sha16 of the source each file was
brought level with, then sha16 of what this release ships):

| File | Distilled from | This release |
|---|---|---|
| `router-lazy.mjs` (new) | 61,300 B · sha16 `f6328f8976551804` · `--selftest` 29 assertions | 65,918 B · sha16 `4018332f07084ffa` · **32** assertions |
| `yearring-index.mjs` (new) | 11,736 B · sha16 `318b5b89c3899765` | 12,669 B · sha16 `b25d9aeacff12662` |
| `plugin/index.js` (new) | 16,567 B · sha16 `0b9b6b2e9fee5503` | 20,168 B · sha16 `f7da959c8600b17a` |
| `plugin/client.js` (new) | 8,493 B · sha16 `0c6153a02599684d` | 9,190 B · sha16 `7e1bdd17c23156fc` |
| `plugin/cordis.patch.yml` (new) | 312 B · sha16 `a67e8d0add7fa411` | 594 B · sha16 `348acdd6850776d8` |
| `test/test-yearring-index.mjs` (new) | 8,121 B · sha16 `72b57cc9eac59e66` · 34 assertions | 9,677 B · sha16 `c45c53d1cedc762c` · **38** assertions |
| `test/test-router-reset-plugin.mjs` (new) | **no tests at all** (0 assertions) | 14,412 B · sha16 `c0ebac9e67760c53` · **39** assertions, incl. 2 negative controls |

### Added

- **`dsh-router-lazy` (`router-lazy.mjs`)** — one command that answers "which workstream should be
  pushed, and about what". Reads session list + board state + relay ledger, and sorts every mainline
  session into four buckets — **`lazy`** (not running, but there is a `todo` card / an unfinished hand-off /
  the title says "to be continued"), **`backlog`** (only backlog cards: nudge *planning*, not *running*),
  **`handoff`** (the title says "handed off" and work remains: don't message that session, start a new
  one), **`stuck`** (idle past the threshold yet the board still has `running`/`review` cards). Cards with
  a **future** schedule are counted as `scheduledTodo` and never make a line `lazy` (waiting for a window
  is not slacking); already-due schedules still count as `todo` with an explicit "schedule is overdue"
  reason. Also prints **"nudged N times today"** per line, read from `<home>/router-ops.jsonl`
  (only real `say`/`wake` on the local day; dry-runs, failures and other verbs don't count) — a line
  nudged three times today and still idle should be escalated, not nudged a fourth time.
  🔴 Fetch failures are **fail-closed**: missing session list / board / ledger ⇒ `rc=3` and *not one word*
  suggesting "nobody is slacking".
  🟢 Workstream names are **injectable**: `analyze({ resolveLine })` replaces the default two-evidence
  resolver (relay ledger + title tokens) outright.
  🟢 Board request headers come from **`ROUTER_BOARD_HEADERS`** (JSON object); the default adds none, and
  the code names no private header.
- **`dsh-router-yearring` (`yearring-index.mjs`)** — index a directory of "one vision file per
  workstream" JSONs into one row per line: ask counts by tier, the top-ranked ask, whether the human
  doc exists, and the JSON status. `kind` → tier via a **default mapping that can be overridden**
  (`vision.kindTiers`); unknown kinds count as B *and* are named in `warnings`. Strictly read-only:
  broken JSON / missing fields / missing directory all **report yellow with `rc=0`** instead of throwing.
  Directory resolution: `--dir` > `ROUTER_VISION_DIR` > config `vision.dir` > `<cwd>/docs/vision`
  (same ladder as `brief --gaps` — deliberately not a second scheme).
- **Optional plugin `plugin/`** — an input-toolbar button that wraps up a Router session: **①** run
  `router-act reset --apply` (persist slots + open decisions first — this step is the safety net), **②**
  then `compaction.compactNow()` in place (same session id). Hard-coded failure semantics: reset failure ⇒
  **never compacts**; compaction failure / service absent / nothing to compact ⇒ reports
  "⚠️ already persisted, but did not compact (why)", never success. Human-triggered only (no timer, no
  subscription), non-Router sessions refused with a plain-language reason.
  🟢 `routePrefix` configurable; `router-act.mjs` resolved as `DSH_ROUTER_ACT` > beside the package >
  `<home>/tools/dsh-butler/`.
- **`test/test-router-reset-plugin.mjs`** — 39 assertions over the plugin's two hard rules (safety order,
  never silent) plus the client half rendered in a `vm` sandbox; **two negative controls** prove the
  assertions are not vacuous (flip the premise, the same check must go red).
- **`test/test-yearring-index.mjs`** — 38 assertions, all against data built under `os.tmpdir()`; the one
  assertion from the upstream fixture that read a real production directory was replaced by two that
  prove directory resolution works from `env` / a parent-directory relative doc (the deleted one could
  only pass on that one machine).

### Changed

- `package.json` gains `dsh.bundle.patch` + `dsh.client` (`platform: web`), `exports` (`./client`,
  `./plugin`, and the three CLI entry points), two new `bin` names, and the new files in `files`.
  Loading is split: plugin through `dsh.profile.bundles`, CLIs through `bin` — neither side needs the
  other.
- `README.md` documents the three new surfaces (including what each of the four buckets means and why
  mixing them up produces wrong nudges); `README.en.md` carries the same three sections so the two
  languages never state two different things.
- `test/test-router-act.mjs` wording only: 16 occurrences of a persona-specific pronoun → a neutral one,
  and one internal workstream name → a neutral example (3). Same 156 assertions, same expectations; the
  repo should not describe itself in two vocabularies at once.
## 0.3.0

Catch-up release: the distilled skeleton is brought up to the feature set the production tool grew over the
last six rounds — an **optional vision pointer** on conclusion rows, a **mechanical per-workstream digest**,
**slot-block refresh after every digest**, **active-workstream-first slot selection**, and
**stale-decision bookkeeping on the read side that fails open**. Nothing was removed: still seven verbs,
still two delivery gates before the preview, still zero third-party runtime dependencies.

**Per-file provenance** (distilled by hand — these are *not* copies; sha16 of the source each file was
brought level with):

| File | Source it was brought level with | This release |
|---|---|---|
| `router-act.mjs` | prod 141,907 B · sha16 `81bab67ab1c94e51` (v1.7.0) | 69,761 B · sha16 `aedd1c6d82c67197` |
| `router-guard.mjs` | prod 34,736 B · sha16 `a94684cebfda93bf` (v1.1.0, five checks) | 22,587 B · sha16 `19531a59e79bb6a0` (three checks + strict flags) |
| `test/test-router-act.mjs` | prod fixture 38,394 B · sha16 `e9447db58145606e` (136 assertions) | 43,709 B · sha16 `b7541707cec8c941` (**156 assertions**) |

### Added

- **`digest --ask <id>`** — notes a ≤6-character **vision pointer** on that workstream's conclusion row
  (`- date｜line｜conclusion｜ask=a1｜ref：…`), pointing at an `asks[].id` in that workstream's vision file.
  Omitting `--ask` adds **not one character** (byte-identical to the previous row shape); `--ask -` means
  "explicitly none". Parsing is tail-anchored, so a conclusion that merely mentions `ask=…` is not misread.
- **`digest --auto`** — one **mechanical** line per *active* workstream (zero model calls: fetch + string
  concat). Takes the most recent `done` card's title (truncated to the slot width) with the card id as ref;
  a workstream with no `done` card degrades to `「status word: most recent card」` instead of inventing a
  conclusion. Shares the single append path with `--line`, so idempotency (line + date) still holds.
- **`refreshResumeHeadSlots()`** — after a successful digest, the `#### 一行槽位` block of the *newest*
  handoff head is re-rendered in place. Only that block changes: timestamp, decision list, and every
  historical conclusion row stay byte-identical; older handoff heads are history and are left alone; if the
  file has no handoff head it is **not invented** (`reason: no-slot-section`). Idempotent (equal rendering ⇒
  no write, same sha).
- **`readSlots(max, dir, prefer)`** — third argument = the set of currently *active* workstreams. Active
  lines claim the 16 slots first; idle lines only backfill, and inside each group the date-descending order
  is preserved (stable). Without it, ordering is byte-identical to before (`reset` depends on this).
  `reset` and all three digest write paths pass the same set; if the board is unreachable it degrades to the
  plain date ordering rather than blocking the write.
- **Stale-decision bookkeeping (read side only, `fail-open`)** — `readAttentions()` splits unanswered
  attentions into `open` / `stale`: a card **absent from the ledger** (archived / deleted / never existed) or
  already **`done`** is no longer counted as "awaiting you". `brief` line 1 gains
  `（另有 N 件卡已归档/完成/不在板，不计入）`; `brief --json` gains
  `needsOwner.staleAttentions{count, cardIds, checked}` (keys added only).
  🔴 **If the ledger cannot be read/parsed, nothing is dropped** (`ledgerChecked:false`, open returned
  as-is, and the output says so: `陈旧账没核成：账本读不到，按原样全算`). Over-reporting is acceptable;
  silently dropping a decision that really waits for you is not. It never writes: no state file, no
  `answeredAt`, no attention deletion, no network.
- **`aggregate(tasks, threadLine, threads)` / `lineOfCardMap(tasks, threadLine)`** — optional card-grouping
  fallback for boards that put cards into threads; both extra arguments are optional and omitting them keeps
  the old behaviour exactly.
- **`renderJson()`** exported (the `status --json` shape, so fixtures no longer have to re-implement it).
- **`ROUTER_LEDGER_FILE`** (optional, read-only) and **`ROUTER_BOARD_HEADERS`** (JSON object of extra request
  headers for the board endpoint — this tool never guesses private header names).
- **`test/test-router-act.mjs`** — 156 offline assertions, wired into `npm test`. Covers the conclusion-row
  round trip, slot rendering/refresh (idempotence, dry-run, multi-head, cap), active-first slots, mechanical
  digest extraction, and the fail-open stale path including three negative controls.
- **`router-guard.mjs`** — read-back after a repair is now retried (`8×250ms`): the RPC returns before
  `workspace.json` is flushed, so an immediate read-back raised a false alarm.

### Changed

- **`brief` / `status` wording**: `待定 N 件` → `等拍板 N 件` (clearer about *who* is waiting), plus the stale
  note described above.
- **Line 3 numbering**: items are now separated by `①②③`; the previous fixed `②` separator rendered three
  items as `①②②` (duplicate mark). The folded-count wording now also states that failed cards are only
  counted (`失败卡 N 件只报数、不占你的板（没有自动重试，长期不动要点开看）`).
- **Slot lines carry `ask=`** (`· line｜conclusion｜ask=a1｜date｜ref：…`); rows written before this release
  render as `ask=-` — **not backfilled, not guessed**.
- **`router-guard.mjs` flags are whitelisted**: an unknown flag ⇒ `rc=2` with usage printed and **zero
  writes** (so `--aply` can no longer silently become a dry run). Same lesson as `router-act.mjs` 0.1.1,
  now applied to both bins. Version of both bins aligned to `0.3.0`.
  > 0.2.0's "guard's external contract is untouched" was the criterion *for that release*; this one is
  > **stricter, not different**: the four outcomes, exit codes `0`/`3`, idempotency and dedupe are unchanged —
  > all that is new is one more exit code (`2`) for a flag nobody should be passing.

### Deliberately not included

- **guard's "session-identity drift" and "inbound-channel bot ready" checks**: their inputs are deployment
  facts of one specific integration (a concrete platform appId, a local log directory) — on any other
  machine they are permanently `unknown` or permanently alarming. Reasoning is in the `router-guard.mjs`
  header; the two checks that matter generically are shipped.
- **`digest --replace`** (in-place rewrite of today's row) stayed out of the distilled skeleton: it needs a
  same-day row + concurrency assumptions this skeleton does not claim. Keep the dedupe-key behaviour and edit
  the file by hand if you must change a row.

## 0.2.0

Capability release: two new building blocks (vision-gap ranking, hand-off head compression), one shared
threshold resolver, and a stricter third line in `brief`. **Nothing was removed**: the verb whitelist is
still seven verbs, the two delivery gates still sit before the preview, and `router-guard.mjs`'s external
contract (flags, exit codes, four outcomes, idempotency) is untouched — that non-regression is a standing
acceptance criterion for this line.

### Added

- **`lib/vision-gaps.mjs`** — `brief --gaps` answers "which workstream should move next": one JSON per
  workstream (`{line, asks:[{id,kind,what}]}`, default dir `<cwd>/docs/vision`), `kind` → tier
  A/B/C through an overridable map, ranked by `wC·C + wI·inFlight + wD·min(idleDays,cap) + wA·A +
  wP·priorityHit`. Weights, Top-N, truncation width and the priority-list file/key are all configurable;
  unmapped kinds count as B **and are named in `warnings`** instead of being silently swallowed. Pure
  functions + a resolver split, so fixtures can feed explicit weights.
- **`lib/router-head.mjs`** (bin `dsh-router-head`) — hand-off head compression: `--from-session` picks the
  last human/assistant turns out of a real session file (multi-frame zstd), `--write` emits a 3–4 line,
  ≤400 code-point head, `--check` validates one (shape / code points / timestamps / reasoning leakage),
  `--selftest` ships 29 offline fixtures including **empty input / over-long input / exactly-at-the-limit**.
  Two design criteria are enforced by fixtures: the summary slot is never faked from an original-sentence
  prefix, and the original sentence is **dropped rather than truncated** when it does not fit.
- **`lib/config.mjs`** — the single "env > config file > default" resolver (`<home>/router-config.json`,
  `ROUTER_CONFIG_FILE` overrides). Missing file = no config; an invalid value falls back to the default and
  records a warning instead of producing `NaN`; `trace` reports which layer each value came from.
- **`brief --gaps`** (flag whitelisted like every other flag). `--json` gains `needsOwner{asks, reviews,
  failedAttentions, shownMax}` and, with `--gaps`, `visionGaps / visionView / visionWarnings / visionTotals`.
- **`npm test`** — the package finally has a test script:
  `node test/run-self-test.mjs && node test/run-unit-tests.mjs` (16 CLI items + 25 unit items, all green).

### Changed

- **`brief` line 3 is rendered by `renderNeedsOwner()`**: at most `askMax` (default 3) named items, the rest
  folded into a count, and **failed-card attention never becomes an item** — it only appears as
  `其中失败卡 N 件机器自管`. Three mechanical tests (board status / question wording / option set) decide
  what counts as a failed card, because a card may already be archived when its attention is still open.
  Ordering is stable: real open decisions first, then cards awaiting review, longest-waiting first.
- **Every previously hard-coded threshold is now configurable** (`env > config > default`): brief item cap,
  failed/review status names, failed-card question wording and option sets, vision dir, priority file/key,
  gap Top-N and width, six scoring weights, head `maxTotal` / `maxTopic`. See the README table.
- **`presets/router/agent.cordis.yml`** — the persona *skeleton* gained the two new behaviours (brief's
  third line, `--gaps`, the two kinds of "head") without importing any deployment's wording: it still
  contains zero private nouns, and states plainly that thresholds live in config, not code.

### Added fixtures

- `test/run-unit-tests.mjs` U0–U24: config precedence and invalid-value fallback, vision scanning (broken
  JSON, missing fields, unmapped kind), weight-as-parameter, owner-priority matching, brief partitioning and
  folding, head picking/empty/over-long/boundary cases, injection timestamp stripping, and three negative
  head shapes.
- `test/run-self-test.mjs` J7 / J8 / J9 / J9b: `brief` is still exactly three lines and keeps failed cards
  out of the item list; the head compressor works end to end (pick → write → check → bad head rc=1 →
  selftest) and `--help` is non-destructive; `brief --gaps` appends its own section while the three status
  lines stay byte-identical.

## 0.1.1

Small hardening release after the 0.1.0 acceptance run: one correctness fix (unknown flags used to be
swallowed) and one naming alignment (default conclusions-log directory). No new verbs, no capability
gained, no npm publish implied by this file — see the release notes for what was actually shipped.

### Fixed

- **Unknown flags are now fail-closed (`R-3`).** Before: `digest --apply --bogus-flag` exited **rc=0
  and wrote the conclusions log anyway**, because arguments were read lazily (`argvVal` /
  `argv.includes`) and unrecognised tokens simply fell through. Now each verb has an explicit flag
  whitelist (`lib/flags.mjs`) checked in `main()` **before any side effect**: an unknown flag ⇒ `rc=2`,
  the verb's usage line, and **not a single byte written** — write verbs are blocked the same way even
  with `--apply` present. A typo such as `--aply` can no longer pass as success. The three existing
  fail-closed paths (unknown verb / missing required argument / out-of-range enum) are unchanged.

### Changed

- **Default conclusions-log directory is now `docs/year-rings/` (`R-4`).** `digest` / `reset` used to
  write into `docs/router-log/`; the documented design choice is the English directory name, so the
  default moved to `<working dir>/docs/year-rings/` (`ROUTER_LOG_DIR` still overrides). `.gitignore`,
  `README.md` and `README.en.md` were updated to match — the old name is gone from code and docs
  (it survives only in this changelog entry, as history). Anyone who wants the previous location can
  set `ROUTER_LOG_DIR` (or move the old directory over).

### Added

- **`lib/flags.mjs`** — per-verb allowed-flag table, per-verb usage lines, `scanFlags()`, and the
  error renderer. Adding a flag is now a one-place change plus a fixture.
- **Fixture `J-extra4`** in `test/run-self-test.mjs` — asserts that four unknown-flag invocations
  (`digest --apply`, `say --apply`, read-only `status`, write verb `reset --apply`) plus a realistic
  `--aply` typo all return `rc=2` with the conclusions-log SHA, the action-log line count and the
  delivery counter **unchanged**. Suite is now 12 items, all green.

## 0.1.0

First public release: a distilled minimal skeleton, **not a copy** of any production version
(the production file of the same name is 1,263 non-blank lines; this one is ~460).

### Added

- **`router-act.mjs`** — controlled verb whitelist for an orchestrator-style main session:
  - `status` / `brief` / `card-show` — read-only (zero writes, never a board write request)
  - `say` — deliver one line to a named session; **dry-run by default**, `--apply` to send
  - `digest` — append one workstream conclusion to the conclusions log (idempotency key = line + date)
  - `reset` — render slots + open decisions as a resumable "handoff head" (**clears nothing**)
  - `wake` — explicit stub (no thread/card-group data plane here)
- **`lib/say.mjs`** — minimal delivery leg (`session/prompt`), with **two gates applied before the
  preview is printed**: not-yourself (rc=4) and not-an-archived-session (rc=5). Read failures are
  reported, never silently passed. A third "handed-off" gate exists as an opt-in (`ROUTER_SAY_HANDOFF_GATE=1`).
- **`lib/host-rpc.mjs`** — minimal host RPC client: signs its own `/api` cookie
  (`dsh-auth-<sha256(authority)>`, HMAC-SHA256), knows exactly four endpoints, no stack fallback magic.
- **`router-guard.mjs`** — three health checks (top-of-list repair / archive protection / cwd still
  exists) with dry-run default, `--apply`, `--json`, `--once`, idempotence, alarm dedupe (6h),
  fail-open (rc=3 yields), and a ttl-healing single-instance lock.
- **`presets/router/`** — agent preset template with a **neutral persona** ("operator / you") and a
  deliberately tightened tool surface: no ask-user tool, `tool-fs` with `write: false` / `edit: false`.
- **`docs/patch-snippet.yml`** — minimal snippet to mount the preset into a host composition, plus
  rollback instructions at both granularities.
- **`docs/DESIGN.md`** — nine non-goals and three design trade-offs, in writing.

### Deliberately not included

- No inbound messaging channels (IM / group bot / email). Channel implementations are deployment facts.
- No deployment facts: no drive letters, fixed ports, machine names, workspace UUIDs, or rollback paths.
- No thread-plane wake implementation (wake is a stub on purpose).
- No workflow-policy checks (DoD-style gates) from any particular shop.

### Notes

- 0.x: minor versions **may** break compatibility. JSON output fields are only added, never renamed —
  but treat them as unstable until 1.0.
- Zero third-party runtime dependencies. Node ≥ 20 (uses built-in `fetch`, `zlib.zstdDecompressSync`).
