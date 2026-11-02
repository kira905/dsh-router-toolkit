# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); this project uses 0.x semantics
(minor bumps may break compatibility — see the note below).

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
