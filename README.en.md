# dsh-router-toolkit

**A main session that issues commands but never executes them still needs a hand it can grip.**

This toolkit gives an "operator"-style orchestration session a set of **controlled verbs**: the only way
it can act is through a handful of named commands — send one line to a sub-session, sink one conclusion
into a log, render a status screen. It has no hands for editing code, creating tickets, or mutating state.

Three things it is trying to prove:

1. **"No hands, even if it wanted to" is verifiable, not a promise.** The tool surface loses `write`,
   `edit` and the ask-user tool at the composition layer, and every write surface has exactly one leg.
   Go read `presets/router/agent.cordis.yml` and count them yourself.
2. **One line per action, always attributable.** The action log carries `decidedBy`: was this a small
   call the session made itself, or something the human mandated? The two are recorded separately.
3. **Context that survives.** One-line slot per workstream + a conclusions log + a manual reset:
   process never enters the context, status is recomputed on every read.

> This is a **minimal distilled rewrite**, not a copy of any production version: the production file of
> the same name is 1,263 non-blank lines, this one is ~460. The goal is to make the shape legible and
> copy-able, not to drop it straight into production.

---

## What it is / is not

**Is**: a CLI (controlled verbs + a health check) plus an agent preset template. Zero third-party
dependencies — Node built-ins only.

**Is not**: a framework, a service, a board, or a scheduler. It does not schedule work for you and does
not store your tickets. It reads the state you already have and acts **within bounds**.

```
router-act.mjs     controlled verbs (the orchestrator's only action entry)
router-guard.mjs   three checks (top-of-list repair / archive protection / cwd still exists)
lib/say.mjs        minimal message delivery (two gates: not self / not archived)
lib/host-rpc.mjs   minimal host RPC client (signs its own /api cookie)
presets/router/    agent preset template (persona + plugin declarations)
docs/patch-snippet.yml   minimal snippet to mount it into a host composition
```

---

## Install

### Prerequisites

- Node.js ≥ 20 (uses built-in `fetch`, `AbortSignal.timeout`, `zlib.zstdDecompressSync`).
  **No third-party dependencies** — no `npm install` needed.
- A running DSH host instance (this tool talks to its `/api` RPC).
- **The `/api` cookie signing secret**: `DSH_RPC_COOKIE_SECRET` (32 bytes, Base64 or Base64URL).
  > Why: board state and RPC go through the host's `/api` auth gate (cookie named like
  > `dsh-auth-<sha256(authority)>`, HMAC-SHA256 signed). **Anonymous requests get 403** — that is the
  > gate working, not a defect. This skeleton **reads no local credential file and guesses no key
  > location**: explicit argument or this environment variable, nothing else.
- Optional: `DSH_WEB_URL` (default `http://127.0.0.1:3080`), `DSH_HOME` (default `~/.dsh`).

### Thirty-second check

```bash
node router-act.mjs --help            # the verb whitelist
node router-guard.mjs --help          # the three checks
node router-act.mjs status --json     # if this reads the board, your cookie is right
```

When it cannot work it **says why** (`状态取不到：HTTP 403 …`), rather than inventing data or returning
an empty table.

---

## The seven verbs

| Verb | What it does | Write surface |
|---|---|---|
| `status` | One-screen board (per workstream: running / queued / awaiting review / failed + open decisions) | **none** |
| `brief` | Three-line summary (status line + what to look at first + what needs you) | **none** |
| `card-show` | Read one card's one-line summary (including its "awaiting decision" section) | **none** |
| `say` | Send one line to a named session; dry-run by default | the only delivery leg = `lib/say.mjs` |
| `digest` | Append one workstream's conclusion to the log (idempotency key = line + date) | one appended line |
| `reset` | Render slots + open decisions as a resumable "handoff head", appended to the log | one appended block |
| `wake` | **stub**: this skeleton has no thread/card-group data plane | — |

```bash
node router-act.mjs brief
node router-act.mjs status --max-lines 30
node router-act.mjs say --to frontend --text "verify the release script version"            # preview only
node router-act.mjs say --to frontend --text "verify the release script version" --apply     # actually send
node router-act.mjs digest --line frontend --text "v0.3 shipped" --ref issues/42 --apply
node router-act.mjs reset --apply
```

### The two delivery gates

`say` is safe because it blocks **before printing the preview**:

1. **Not yourself** — target == the current session (`DSH_SESSION_ID`) ⇒ rc=4. Blocked even in dry-run.
   (A preview that looks perfectly normal while actually sending to yourself is the hardest mistake to
   notice.)
2. **Not an archived session** — target is in `<home>/storages/workspace.json#global.archivedSessionIds`
   ⇒ rc=5.

Gate 2 is not fussiness: delivering to an archived session is a **no-op with side effects**. The host
rejects the delivery at `agent/pre-step`, the loop ends as `blocked`, and **no model request is made** —
yet the delivery API still returns "accepted", so the sender believes a message was delivered that nobody
will ever read in the UI. That class of silent failure is exactly what a gate is for.

> ⚠️ Do not confuse this with "resuming a session makes it run again" — that is the `session.create`
> path, not the `session.prompt` path. This tool uses `session.prompt`.

**If it cannot read, it says so**: unreadable archive list ⇒ print
`⚠️ archive list unreadable, archive gate skipped this run` and continue; missing `DSH_SESSION_ID` ⇒
print `⚠️ no DSH_SESSION_ID, self-check skipped` and continue. **Never a silent pass.**

A third gate ("handed off" titles) is a **deployment-specific convention**, not a general capability ⇒
opt-in, off by default: `ROUTER_SAY_HANDOFF_GATE=1`.

---

## The three checks

```bash
node router-guard.mjs --router-cwd <your workspace dir>            # dry-run
node router-guard.mjs --router-cwd <your workspace dir> --apply    # repair
node router-guard.mjs --router-cwd <...> --json                    # machine-readable
```

| Check | Criterion | Self-repair |
|---|---|---|
| Top-of-list repair | target workspace is not first in `workspace.json#global.workspaceIds` | yes (RPC `workspace.insertBefore`; order **is** pinning — there is no hard pin field) |
| Archive protection | `archivedSessionIds` contains the current main session | yes (RPC `workspace.unarchiveSession`) — current session only, never resurrect history |
| cwd still exists | directory exists **and** the session's `header.cwd` still points at it | no, alarm only (**never auto-create the directory**) |

- Dry-run by default; four outcomes `ok` / `fixed` / `alarm` / `unknown`; a single failing item records
  `unknown` and the rest still run.
- **Idempotent**: run again after a repair ⇒ all ok, zero actions, zero new alarms.
- **Alarm dedupe**: a standing alarm is logged at most once per 6 hours (`--no-dedupe` to disable).
- **Fail-open**: unreadable `workspace.json` = environment not ready ⇒ exit code **3** (schedulers usually
  treat 3 as "yield this round, not a failure"). "Has alarms" is not a script failure ⇒ still 0.
- Single-instance lock with ttl self-healing: a manual run and a scheduled run yield to each other.

---

## Which design does this correspond to

This is not a new framework. Each of its building blocks is an **established industry practice** — an
orchestrator that issues commands but never executes them (write tools are disabled at the composition
level, and every write surface has exactly one leg), event triage computed on demand instead of modelled
as objects, a one-line-per-action disposition log, attention predicates instead of text scraping, mandates
carrying `decidedBy`, and subscription fan-out guarded by three explicit gates.

The DeepSeek Harness team's design note argues the same structure from first principles: it states that
it is "not an introduction to existing DeepSeek Harness product features" and that "similar design
constraints lead to similar architectural choices" — so this repo **does not represent the official
project, is not an official implementation, and makes no claim about who came first**.

> 📌 **Terminology note**: the proper nouns above (Sources / Assessor / Assignment / Attention / Mandate /
> Subscription …) come from **our own domain model naming**, **not from that article's vocabulary**. Those
> words do not appear in the article's body — it discusses the constraints and trade-offs of the same
> class of structure. Do not cite them as "concepts from that article".

What we deliberately did **not** copy: one session per thread, a full Trigger object model, and
side-effectful report codes. Reasoning in [docs/DESIGN.md](docs/DESIGN.md): **a session is a person's
entry point, not a container for a thread**; an orchestrator that can edit code is indistinguishable from
an ordinary workstream, only with an extra forwarding layer.

---

## Mounting it on your own instance (preset template)

```
presets/router/preset.yml        name / description / order
presets/router/agent.cordis.yml  persona + plugin declarations (the read-only tool surface lives here)
docs/patch-snippet.yml           minimal snippet to mount it into a host composition
```

**Steps (one restart to take effect)**

1. Drop the `presets/router/` directory into your instance's agent preset directory.
2. Open the host's cordis patch file, paste the `- insert:` block from `docs/patch-snippet.yml`, and fill
   `plugins:` with the contents of `agent.cordis.yml` **indented 4 more spaces** (the snippet inlines only
   the first two entries as a sample).
3. Restart the host once.
4. Verify: a new session can select the preset, and the tool surface really is tightened (ask it to edit a
   file — it should say it cannot).

**Rolling the whole thing back**

- Delete the `- insert:` block + delete the router preset directory → restart once. Back both files up first.
- To undo only the read-only tightening: remove the two `config:` lines (`write` / `edit`) under `tool-fs`,
  mirror it in the directory version → restart once.
  > ⚠️ `read` / `read_image` are registered on the same line as `write` / `edit` — **deleting the line
  > deletes reading too**. Use config to disable, never delete the row.

**Where it silently drifts**: the directory copy and the inlined patch copy are "the same thing in two
places". Change one without the other and it drifts quietly (symptom: the preset appears in the UI, but
its tool surface is not what you think). Self-check: extract the `- id:` line sequence from both and
compare as sets.

---

## Known limitations

- **`wake` is a stub**: waking cards inside a thread needs a card-group data plane plus three gates
  (per-message cap / per-card cooldown / one-switch kill). That is a different data contract; this
  skeleton does not pretend to have it. Use `say` for work that has no thread.
- **The conclusions log only grows**: one file per month, no automatic rotation (auto-truncation loses
  audit trail, contradicting the "one line per action" selling point). Archive by year.
- **Same line, same day, changed conclusion is skipped by idempotency**: that key is a **dedupe key**, not
  an update key. Edit the file by hand.
- **`--json` fields are not a contract**: 0.x, fields are only added, never renamed — but do not build on
  them.
- **Line count is not a criterion**: the value here is whether the shape is right, not how long it is.

---

## License

AGPL-3.0-or-later — see [LICENSE](LICENSE).

## See also

- 中文说明：[README.md](README.md)
- Trade-offs and non-goals: [docs/DESIGN.md](docs/DESIGN.md)
- Changelog: [CHANGELOG.md](CHANGELOG.md)
