# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); this project uses 0.x semantics
(minor bumps may break compatibility — see the note below).

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
