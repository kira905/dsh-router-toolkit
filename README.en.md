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
   process never enters the context, status is recomputed on every read. For session-to-session hand-off
   there is also a **hand-off head** (3–4 lines: what was being discussed + one sentence that must not be
   paraphrased), so the next session does not re-read the whole transcript.

> This is a **minimal distilled rewrite**, not a copy of any production version: the production file of
> the same name is 2,525 non-blank lines, this one is ~1,150. The goal is to make the shape legible and
> copy-able, not to drop it straight into production.
>
> 0.4.0 adds three surfaces that were already running upstream but were never in this repo
> (`router-lazy` / `yearring-index` / the optional plugin); they are not part of those 2,525 lines.

---

## What it is / is not

**Is**: a CLI (controlled verbs + a health check + two read-only inspectors) plus an agent preset
template plus an **optional** web plugin. Zero third-party dependencies — Node built-ins only.

**Is not**: a framework, a service, a board, or a scheduler. It does not schedule work for you and does
not store your tickets. It reads the state you already have and acts **within bounds**.

```
router-act.mjs     controlled verbs (the orchestrator's only action entry)
router-guard.mjs   three checks (top-of-list repair / archive protection / cwd still exists)
lib/say.mjs        minimal message delivery (two gates: not self / not archived)
lib/router-head.mjs hand-off head compressor (last turns + one summary → a 3–4 line head)
lib/vision-gaps.mjs vision-gap ranking (declared goals vs board reality: "which line moves next")
router-lazy.mjs    four-bucket "is this workstream idle" judgement (read-only; who to nudge, about what)
yearring-index.mjs vision-directory index (one row per line: ask counts by tier + the top ask)
plugin/            optional web plugin ("wrap up and compact" button: persist first, then compact)
lib/config.mjs     threshold resolution (env > config file > default, one place)
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
| `brief` | Three-line summary (status line + what to look at first + what needs you); `--gaps` appends a vision-gap section | **none** |
| `card-show` | Read one card's one-line summary (including its "awaiting decision" section) | **none** |
| `say` | Send one line to a named session; dry-run by default | the only delivery leg = `lib/say.mjs` |
| `digest` | Append one workstream's conclusion to the log (idempotency key = line + date); `--ask` adds a ≤6-char vision pointer; `--auto` writes one mechanical line per active workstream | one appended line |
| `reset` | Render slots + open decisions as a resumable "handoff head", appended to the log | one appended block |
| `wake` | **stub**: this skeleton has no thread/card-group data plane | — |

```bash
node router-act.mjs brief
node router-act.mjs brief --gaps        # additionally: "which workstream should move next?"
node router-act.mjs status --max-lines 30
node router-act.mjs say --to frontend --text "verify the release script version"            # preview only
node router-act.mjs say --to frontend --text "verify the release script version" --apply     # actually send
node router-act.mjs digest --line frontend --text "v0.3 shipped" --ref issues/42 --apply
node router-act.mjs reset --apply
```

> The conclusions log lands in **`<working dir>/docs/year-rings/router-<YYYYMM>.md`** (one file per month;
> `ROUTER_LOG_DIR` overrides the directory). It is a runtime artifact, not part of the package — already
> covered by `.gitignore`.

**Flags are a whitelist too**: each verb accepts only its own set (the table lives in `lib/flags.mjs`).
An unrecognised flag ⇒ `rc=2` plus that verb's usage, and **not one byte is written** — write verbs are
blocked the same way even when `--apply` is present. A typo like `--aply` can never pass as success
(that is what 0.1.1 fixes: in 0.1.0 unknown flags were silently swallowed and `digest` wrote the log anyway).

### Line 3, "what needs you": failed cards stay off the table

The third `brief` line only lists what **genuinely needs your decision**:

- at most **3 items** (`ROUTER_BRIEF_ASK_MAX` / `brief.askMax`), the rest folded into a count;
- **failed-card attention items never appear as items** — retrying/attributing a failed execution is the
  machine's own job. They only show up as `其中失败卡 N 件机器自管` in the folded count.
  Three mechanical tests, any of which matches: the board card with the same id is `failed` / the question
  carries the fixed failure wording / the options are exactly that trio. (After a card is archived the
  board no longer knows it, which is why one test is not enough.) **All three are configurable** — see the
  threshold table below.
- ordering: real open decisions first, then cards awaiting review; inside each tier, longest-waiting first.

### Slots and the handoff head: one line per workstream, refreshed on every digest

The log has two kinds of content: the **conclusion area** (`- date｜line｜conclusion｜ask=…｜ref：…`, append-only)
and the **handoff head** written by `reset` (one slot line per workstream + open decisions + how to continue).
A slot is "the latest conclusion for that workstream"; the cap is **16 lines**.

```bash
# attach a vision pointer (an ask id from that workstream's vision file; ≤6 chars)
node router-act.mjs digest --line release --text "rollback drill added" --ask a1 --apply

# one mechanical line for every active workstream (zero model calls: fetch + string concat)
node router-act.mjs digest --auto --apply
```

Two things worth remembering:

1. **A successful digest also refreshes the slot block** of the newest handoff head — only the
   `#### 一行槽位` block is replaced; timestamp, decision list and every historical row stay byte-identical.
   If the rendered block equals what is already in the file, **nothing is written** (same-day re-runs keep the
   file's sha). If the file never had a handoff head, it does **not** invent one (`no-slot-section`).
2. **Active workstreams claim slots first**: slots are taken by date descending, but when you supply the
   "currently active" line set, active lines fill the quota and idle lines only backfill. Otherwise one idle
   line (digested earlier today, nothing in flight now) can push a running workstream out. Without the set,
   behaviour is **byte-identical** to the plain date ordering (`reset` relies on this).

### Stale decisions: read-side bookkeeping that **fails open**

`brief` / `status` count "awaiting your call" from `attentions[]` in the state file. After a card is
finished / archived / deleted, its attention may still be there — a **false signal**. This tool reconciles it
on the **read side only**:

- an unanswered attention whose card is **absent from the ledger** (archived / deleted / never existed) **or**
  is already **`done`** goes into `stale` and is **not counted**; line 1 gains
  `（另有 N 件卡已归档/完成/不在板，不计入）`.
- 🔴 **If the ledger cannot be read/parsed, nothing is dropped** (open is returned as-is and the output says
  `陈旧账没核成：账本读不到，按原样全算`). This **fail-open is deliberate**: better to over-report one item than
  to silently drop a decision that really is waiting for you. If the count looks higher than you expect,
  check whether that sentence appeared — it means the ledger path is wrong (`ROUTER_LEDGER_FILE`, default
  `<home>/task-board/ledger-v2.json`, **optional**).
- it is **read-only**: no state file writes, no `answeredAt`, no attention deletion, no network.

### Vision gaps: `brief --gaps`

The three lines answer "what is running now"; `--gaps` answers "**which workstream should move next**",
as an **extra section after** those three lines:

```bash
node router-act.mjs brief --gaps          # human
node router-act.mjs brief --gaps --json   # machine (visionGaps[] / visionView / visionWarnings)
```

Input: **one JSON per workstream** in a directory (default `<working dir>/docs/vision/`, `ROUTER_VISION_DIR`):

```json
{ "line": "release", "humanDoc": "docs/release.md",
  "asks": [ { "id": "a1", "kind": "self-todo", "what": "add the rollback drill" } ] }
```

- `kind` → tier (**A** = blocked on you / **B** = capability gap / **C** = you can do it yourself) via an
  overridable map (`vision.kindTiers`; three examples are shipped, and **unmapped kinds count as B and are
  named in `warnings`** — never silently swallowed).
- "top ask of a line" = **C > B > A**: only when the whole line has nothing but A does it render as
  "waiting on you" — work blocked on a human should not steal the "should move" slot.
- the six weights + Top-N + truncation width are all configurable (next section); ties break on line name,
  so the order is **reproducible**.
- read-only: it reads a directory, the board aggregate and an optional owner-priority list. **No writes.**

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

## Hand-off head compression (`lib/router-head.mjs` · bin `dsh-router-head`)

The most expensive step when work moves to a new session is re-reading the transcript just to learn what
was being discussed. This piece compresses that into a **head**:

```
# 接续头 · 2026-11-05 09:30
- 在聊：刚聊到版本号怎么升
- 原话：（无）
```

**3–4 lines, ≤400 code points total** (configurable). A new session reads this and continues.

```bash
node lib/router-head.mjs --from-session <file|dir|sessionId|id-prefix>   # print only, no write
node lib/router-head.mjs --from-session <...> --write ./heads           # write <dir>/<first 8 of session id>.md
node lib/router-head.mjs --check ./heads/1a2b3c4d.md                   # validate (rc=1 when it fails)
node lib/router-head.mjs --selftest                                    # 29 fixtures, offline
```

Two criteria (this is the design — do not "clean them up" later):

1. **"在聊" is a summary slot, not a prefix of the original sentence.** Test = "if I reword this, does the
   meaning change?" No ⇒ write a summary; yes ⇒ copy the whole sentence into "原话". Offline (no model) it
   writes `（离线：需模型判定）` **rather than pretending a prefix is a summary**.
2. **The "原话" line is never truncated.** If the whole sentence would blow the budget, it is **dropped
   entirely** (rendered as `（无）`) and `verbatimDropped` is recorded. Half a sentence is neither a summary
   nor an original — a reader will take it as the original, which is worse than writing nothing.

Three field notes baked into the code: assistant `reasoning` parts **also carry `text`** (filter on
`part.type === 'text'` or you copy the chain of thought); `user/message` messages are `event.data` itself
while `assistant/message` uses `event.data.message`; and the injection side must call `forInjection()` to
strip the timestamp line — otherwise the head changes every turn and prefix caching never hits.

**What it does not do**: no auto-compaction, no session deletion, no archiving (`--write` writes that one
head file); with no source material it returns `null` and the read side adds nothing at all.

---

## Is this workstream idle, and what should be nudged (`router-lazy.mjs` · bin `dsh-router-lazy`)

`brief` counts idle days; it cannot tell you *who* should be pushed or *about what*. This command puts the
session list, the board and the relay ledger side by side and prints "who to nudge". Four buckets — **do
not mix them up**, mixing them produces wrong nudges:

| bucket | when | what to do |
|---|---|---|
| `lazy` | not running, but the line has a `todo` card / an unfinished hand-off / the title says "to be continued" | nudge: message it about those cards |
| `backlog` | not running, the line only has `backlog` cards | nudge **planning**, not running: move them to `todo` or say why not |
| `handoff` | the title says "handed off" and work remains | don't message that session (a hand-off gate refuses it): start a new one, or message the successor |
| `stuck` | idle past the threshold, yet the line still has `running` / `review` cards | the cards are running but the session is dead: verify it is really dead, then re-run or re-route |

A **"nudged N times today"** column counts real `say`/`wake` on the local day from
`<home>/router-ops.jsonl` (dry-runs, failures and other verbs do not count). A line nudged three times
today and still idle should be escalated to a human, not nudged a fourth time.

`rc=3` on any fetch failure — session list, board or ledger — and **not one word** suggesting "nobody is
slacking". Workstream names are injectable (`analyze({ resolveLine })`), board headers come from
`ROUTER_BOARD_HEADERS` (JSON object, empty by default — the code names no private header).

```bash
node router-lazy.mjs --selftest     # 32 offline assertions, no production, no network
```

---

## Vision-directory index (`yearring-index.mjs` · bin `dsh-router-yearring`)

One JSON per workstream (`{ line, humanDoc, asks: [{ id, kind, what }] }`) in one directory → one row per
line: A/B/C ask counts, the top-ranked ask, whether the human doc exists, and the JSON status.
`kind` → tier: `blocked-by-owner` ⇒ A (waiting on the operator: listed, not pushed), `capability-gap` ⇒ B,
`self-todo` ⇒ C (do it yourself: push this first); unknown kinds count as B **and** are named.

Strictly read-only: broken JSON / missing fields / missing directory all **report yellow with `rc=0`** —
one bad file must not take down the index. Directory: `--dir` > `ROUTER_VISION_DIR` > config
`vision.dir` > `<cwd>/docs/vision` (the same ladder as `brief --gaps`).

---

## Optional plugin: wrap-up-and-compact button (`plugin/`)

An input-toolbar button for Router sessions. One click, two steps, **order matters**:

1. `router-act reset --apply` — persist slots and open decisions into the conclusions log (**this step is
   the safety net**: persist before clearing).
2. `compaction.compactNow()` — compact in place; the session id does not change.

Failure semantics are hard-coded: reset failure ⇒ **never compacts**; compaction failure / no compaction
service / nothing to compact ⇒ "⚠️ already persisted, but did not compact (why)", never success.
Human-triggered only (no timer, no subscription), non-Router sessions refused with a plain-language reason.

```bash
npm i @kira905/dsh-router-toolkit      # CLIs land in bin; the plugin loads via dsh.bundle.patch
```

`router-act.mjs` resolution: `DSH_ROUTER_ACT` > beside the package > `<home>/tools/dsh-butler/`.
The route prefix is configurable (`routePrefix`); the client half reads
`window.__DSH_ROUTER_RESET_PREFIX__`, so keep the two in sync (or leave both at the default).

---

## Every threshold is configurable (env > config file > default)

The config file defaults to `<home>/router-config.json` (`ROUTER_CONFIG_FILE` points elsewhere); **absent
file = no config** — nothing is created and nothing errors. An invalid value **falls back to the default
and records a warning** instead of returning `NaN`.

| Threshold | Environment variable | Config key | Default |
|---|---|---|---|
| "Needs you" item cap | `ROUTER_BRIEF_ASK_MAX` | `brief.askMax` | 3 |
| Failed-card status names | `ROUTER_FAILED_STATUSES` | `brief.failedStatuses` | `failed` |
| Failed-card question wording | `ROUTER_FAILED_Q_PATTERNS` | `brief.failedQuestionPatterns` | `执行失败（failed）` (ASCII-paren variant too) |
| Failed-card option sets | `ROUTER_FAILED_OPTION_SETS` (`;` groups / `/` items) | `brief.failedOptionSets` | `重试/归档/先放着` |
| Review status names | `ROUTER_REVIEW_STATUSES` | `brief.reviewStatuses` | `review` |
| Vision directory | `ROUTER_VISION_DIR` | `vision.dir` | `<cwd>/docs/vision` |
| Priority file / key | `ROUTER_PRIORITY_FILE` / `ROUTER_PRIORITY_KEY` | `vision.priorityFile` / `vision.priorityKey` | `<home>/router-state.json` / `ownerPriority.items` |
| Vision Top-N / text width | `ROUTER_GAP_TOP` / `ROUTER_GAP_TEXT_CHARS` | `vision.top` / `vision.textChars` | 3 / 40 |
| Weights: C / in-flight / per-day / cap / A / priority | `ROUTER_GAP_W_ASKC` / `_INFLIGHT` / `_ACTIVITY` / `ROUTER_GAP_ACTIVITY_CAP_DAYS` / `_ASKA` / `_PRIORITY` | `vision.weights.*` | 3 / 2 / 0.5 / 7 / −0.2 / 5 |
| Head: total / topic code points | `ROUTER_HEAD_MAX_TOTAL` / `ROUTER_HEAD_MAX_TOPIC` | `head.maxTotal` / `head.maxTopic` | 400 / 60 |

> Defaults work out of the box. To change one, change the config — **not the code** (`"changing code" is
> the most expensive kind of configuration`). `makeResolver().trace` reports, per value, which layer it came
> from (`env` / `config` / `default`).

A few **environment-only** entry points (paths / switches rather than thresholds):

| Variable | What it does | Default |
|---|---|---|
| `ROUTER_LEDGER_FILE` | card ledger (**read-only**), used to decide whether a card behind an unanswered attention still exists / is done | `<home>/task-board/ledger-v2.json`; unreadable ⇒ **nothing is dropped** |
| `ROUTER_BOARD_HEADERS` | JSON object of extra headers for the board state endpoint (this tool **never guesses** private header names) | none |
| `ROUTER_LOG_DIR` | conclusions-log directory (default `<working dir>/docs/year-rings`) | see left |

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
- **Read-back after a write is retried (settle)**: the RPC returns before `workspace.json` is flushed, so an
  immediate read-back raises a false alarm (waits up to 8×250ms).
- This piece ships **three** checks. The production variant has five; the other two (session-identity drift /
  inbound-channel "bot ready") inspect **deployment facts of one specific integration** (a concrete platform
  appId plus a local log directory) ⇒ not shipped here, with the reasoning in the `router-guard.mjs` header.

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

**⚠️ Which path actually takes effect (measured on DSH 0.2.1, 2026-11-03)**

Steps 1 and 2 are **two paths**, and **not every path works on every host**:

| Path | How | When it takes effect |
|---|---|---|
| **Inline** (step 2) | Paste the `- insert:` block into the host's cordis patch file | **Always** — it goes through the host composition and does not involve the preset directory |
| **Directory** (step 1) | Drop `presets/router/` into your instance's agent preset directory | **Only if the host composes `@deepseek-ai/dsh-agent-presets`** (the *plural* package, which scans directories). The singular package shipped inside the main package (`dsh-agent-preset-registry`) only accepts definitions passed to `register()` in code — **it does not scan directories** |

⇒ If unsure, **start with the inline path only** (step 2); it does not depend on the directory.
⇒ Never take "the files are all in the directory" as verification — that only proves you copied them, not
that the host read them. **Verify exactly two things**: a new session can select the preset; the tool
surface is really tightened (ask it to edit a file and it says it cannot).
⇒ And remember the flip side: once the host composes that plural package (or you switch to a main package
that scans directories), **the directory copy immediately becomes a second source of truth** — from then on
unsynced copies drift silently (the directory version wins while you think you edited the inline one). So
keep the same-source discipline below.

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
- **The head compresses, it does not judge**: offline there is no model, so the summary slot can only say
  `（离线：需模型判定）`. Who writes the summary, and how well, is the **write side's** job (host plugin /
  caller); this piece guarantees material is retrievable, the shape is valid, the size is bounded, and the
  chain of thought never leaks in.
- **Vision gaps do not invent goals for you**: it reads the vision files you wrote and ranks them; the
  goals themselves are yours to write.
- **The conclusions log only grows**: one file per month, no automatic rotation (auto-truncation loses
  audit trail, contradicting the "one line per action" selling point). Archive by year.
- **Same line, same day, changed conclusion is skipped by idempotency**: that key is a **dedupe key**, not
  an update key. Edit the file by hand.
- **`digest --auto` does not write opinions**: it takes card titles (the most recent `done` card; otherwise
  「status word: most recent card」) — a **mechanical extraction**, zero model calls. For a real sentence, use
  `--line` and write it yourself.
- **Slots are a hard 16 lines**: when full it scrolls, and `--auto` prints which workstreams left the window
  (no silent truncation). This is bookkeeping, not summarisation.
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
