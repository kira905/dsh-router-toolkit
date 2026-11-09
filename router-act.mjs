#!/usr/bin/env node
/**
 * router-act.mjs —— 一个「只下命令、不亲自施工」的主会话的**受控手**（最小骨架）。
 * 提炼重写的最小骨架，**不是任何生产版的副本**（同名生产件 1,263 行非空）。
 * 动词白名单（封闭；加一个动词 = 一次改动 + 一次评审）：`status` / `brief` / `card-show` 只读、
 * **零写入**；`say` 投话（**唯一投递腿 = lib/say.mjs**，两闸：不投自己 / 不投已归档）；
 * `digest` / `reset` 只写结论档（幂等追加，reset **不清空任何东西**）；`wake` 是 stub。
 * 参数同样是白名单（表在 `lib/flags.mjs`）：未知 flag ⇒ rc=2 + 该动词用法，写动词带 `--apply` 也拦。
 * ⇒ 三个写面各只有一条腿，本件**永远不发看板的写请求**（不建卡、不移卡、不验收、不改状态）——
 *   这是"想越界也没手"的机械证明，比人格里写十句禁令都硬。
 *
 * 动作流水（卖点：每个动作留一行，谁拍的都查得到）：每次 say / digest / reset（**含 dry-run、
 * 含失败**）追加一行到 `<home>/router-ops.jsonl` —— `{at, verb, target, sid, ok, source, dryRun,
 * decidedBy, id?, format?, extra?}`。`decidedBy`：`router` = 本会话自决的小决定 / `owner` = 用户定的。
 * 🔴 只增不改；写失败 ⇒ 告警 + rc≠0，但**不撤销已经真投出去的话**。
 *
 * 0.2.0 起 `brief` 多了两件事（**仍然只读、仍然三行**）：
 *   ③ 「要你定」明细 ≤3 条（可配），**执行失败卡只折叠成计数、一条都不进明细** —— 机器该自己重试的事不该占人的注意力；
 *   加 `--gaps` 时**另起一段**「愿景差距」（各条线声明的目标 vs 看板现状，回答"下一步该推哪条线"），
 *   不占那三行。阈值（明细条数 / 失败卡判定文案 / 六个权重 / Top-N）全部可配：`env > 配置文件 > 缺省`。
 *
 * 0.3.0 追平四件事（**全是增量；七个动词、两道投话闸、`--json` 老键一个不动**）：
 *   ① `digest --ask <askId>`：槽位那行加一个 ≤6 字符的**愿景指针**（指向该线愿景件里某条 ask）。
 *      不给 `--ask` ⇒ **一个字符都不加**，与改前逐字相同（「默认等价」由夹具钉着）。
 *      配套 `digest --dir <path>`：只换结论档目录（夹具/演练钩子），生产别带。
 *   ② `digest --auto`：把**每条有活的主线**机械写一行结论进槽位（**零模型调用**，只有取数与字符串拼接）。
 *      每条线取"最近一张已完成卡的标题"，没有已完成卡就退化成「状态词：最近一张卡」，**不编结论**。
 *      仍走 digest 那一条写盘路径（幂等键 = 线名 + 日期）。
 *   ③ 收口写完**顺手刷接续头的槽位段**（`refreshResumeHeadSlots`）：档里最新那段接续头的
 *      「#### 一行槽位」就地重渲染成当前槽位 —— 只换那一段，时间戳/待拍板/结论区历史行一个字节不动；
 *      渲染结果与档里相同就不写盘（同日重跑 sha 不变）。
 *      槽位取舍口径也一并统一：**有活的线优先**占满名额（`readSlots(max, dir, prefer)`），
 *      静线只在活线不满时补位 —— 不让一条"今天更早收口过、此刻无在途卡"的线把在跑的线挤出 16 名。
 *   ④ `brief` / `status` 的「等拍板 N 件」后面多一句**陈旧账说明**（见下）。
 *
 * 🔴 陈旧账兜底销账（**fail-open**，用户会以为"没销干净是 bug"，所以写在这里也说在 README）：
 *   未答 attention 的卡**已归档 / 已删 / 不在账本里**，或账本里**已完成（done）** ⇒ 归入 `stale`、
 *   **不计入 open**；`brief` 第 1 行会补一句「另有 N 件卡已归档/完成/不在板，不计入」。
 *   **账本读不到 / 解析失败 ⇒ 一条都不销**（open 原样返回、`ledgerChecked=false`，输出里如实写
 *   「陈旧账没核成：账本读不到，按原样全算」）——**宁可疑多报，不许误销**。
 *   🔴 这一条**只做读取侧**：不写 steward 状态件、不写 `answeredAt`、不删 attention、不联网。
 *
 * 前置条件：看板状态是插件端点（`GET /api/task-board/state`），**要 /api cookie** ——
 * 给 `DSH_RPC_COOKIE_SECRET`（32 字节 Base64）。不给 ⇒ 403，本件如实打印「状态取不到：<原因>」，
 * **绝不拿上次读数冒充**。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomInt, createHash } from 'node:crypto';
import { hostGet, hostRpc } from './lib/host-rpc.mjs';
import { resolveHome } from './lib/home.mjs';
import { readJsonSafe } from './lib/store.mjs';
import { say as sayViaLib, EXIT as SAY_EXIT } from './lib/say.mjs';
import { VERB_USAGE, scanFlags, renderUnknownFlags } from './lib/flags.mjs';
import { makeResolver } from './lib/config.mjs';
import { buildVisionGaps, renderVisionGaps, computeVisionGaps, readOwnerPriorityItems, ownerPriorityHit } from './lib/vision-gaps.mjs';

/**
 * 版本串 = **运行时读 `package.json`**（模块加载时读一次）。
 * 以前两处各写一个 `VERSION` 常数 ⇒ 升版必漏一处（0.4.0 时两件都还印 0.3.0）。
 * 兜底常数只在 `package.json` 读不到（被裁剪/损坏）时生效，正常路径永不使用。
 */
function readPkgVersion(fallback) {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
    return (typeof pkg.version === 'string' && pkg.version) ? pkg.version : fallback;
  } catch { return fallback; }
}
export const VERSION = readPkgVersion('0.4.1');
const BASE = (process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080').replace(/\/+$/, '');
const HOME = resolveHome(process.env.ROUTER_HOME);
const OPS_FILE = process.env.ROUTER_OPS_FILE || path.join(HOME, 'router-ops.jsonl');
const STATE_FILE = process.env.ROUTER_STATE_FILE || path.join(HOME, 'router-state.json');
/**
 * 卡账本（**可选**，只读）：用来判「这条未答 attention 的卡还在不在板、是不是已完成」。
 * 缺省 `<home>/task-board/ledger-v2.json`（`ROUTER_LEDGER_FILE` 可改）。
 * 🔴 读不到就**一条都不销**（fail-open，见文件头 ④）—— 这个件永远不是硬依赖。
 */
const LEDGER_FILE = process.env.ROUTER_LEDGER_FILE || path.join(HOME, 'task-board', 'ledger-v2.json');
/** 结论档目录：默认 `<cwd>/docs/year-rings`（`ROUTER_LOG_DIR` 覆盖；目录名口径 = 方案 P-3 甲） */
const LOG_DIR = process.env.ROUTER_LOG_DIR || path.join(process.cwd(), 'docs', 'year-rings');
const TIMEOUT_MS = Number(process.env.ROUTER_TIMEOUT_MS || 20_000);
/** 槽位上限（要调就同时调这两个常量与 preset 里那一段） */
export const SLOT_MAX = 16;
export const SLOT_CHARS = 120;

// ── 小工具（显示宽度：CJK 算 2；emoji 不追求精确）────────────────────────────
const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;
const widthOf = (s) => { let n = 0; for (const ch of String(s)) n += WIDE.test(ch) ? 2 : 1; return n; };
const padW = (s, w) => String(s) + ' '.repeat(Math.max(0, w - widthOf(s)));
function clipW(s, w) {
  const str = String(s);
  if (widthOf(str) <= w) return str;
  let out = '', n = 0;
  for (const ch of str) { const cw = WIDE.test(ch) ? 2 : 1; if (n + cw > w - 1) break; out += ch; n += cw; }
  return `${out}…`;
}
const norm = (v) => String(v ?? '').trim();
const p2 = (n) => String(n).padStart(2, '0');
const ymd = (ms = Date.now()) => { const d = new Date(ms); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };
const stamp = (ms = Date.now()) => { const d = new Date(ms); return `${ymd(ms)} ${p2(d.getHours())}:${p2(d.getMinutes())}`; };
const ago = (ms) => {
  if (!Number(ms)) return '—';
  const d = Date.now() - Number(ms);
  return d < 60_000 ? '刚刚' : d < 3_600_000 ? `${Math.floor(d / 60_000)}分钟前` : d < 86_400_000 ? `${Math.floor(d / 3_600_000)}小时前` : `${Math.floor(d / 86_400_000)}天前`;
};
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const argvVal = (argv) => (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };

// ── 封闭词表（**不许自造第五个**）────────────────────────────────────────────
export const CMD_WORDS = ['ask', 'do', 'report', 'notify'];
export const PRIO_WORDS = ['now', 'today', 'when-free'];
export const DECIDED_BY = ['router', 'owner'];

/** 短号：6 位 base36（配对用，不是安全用途）。 */
export function shortId(n = 6) {
  let s = '';
  while (s.length < n) s += randomInt(0, 36).toString(36);
  return s.slice(0, n);
}

/** 一行动作流水的标准形状（字段顺序固定，便于人看）。 */
export function opsRecord({ at = new Date().toISOString(), verb, target = '', sid = null, ok = true, dryRun = true, decidedBy = 'router', id = null, format = null, extra = null } = {}) {
  const rec = { at, verb, target, sid: sid || null, ok: ok === true, source: 'router-act', dryRun: dryRun !== false, decidedBy: DECIDED_BY.includes(decidedBy) ? decidedBy : 'router' };
  if (id) rec.id = id;
  if (format) rec.format = format;
  if (extra && typeof extra === 'object') rec.extra = extra;
  return rec;
}

/** 追加一行流水（只增不改）。写失败**不静默**：返回 ok:false + 原因。 */
export function appendOps(rec, file = OPS_FILE) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(rec)}\n`, 'utf8');
    return { ok: true, file, error: null };
  } catch (e) { return { ok: false, file, error: e?.message ?? String(e) }; }
}

/** 派活信封（两行制：第 1 行人话，第 2 行机器可判）。 */
export const buildEnvelope = ({ to = '', text = '', cmd = 'do', id = '', reply = 'router', prio = 'today', due = '-', ref = '-' } = {}) =>
  `【派·${reply}→${to}】${norm(text)}\n@@cmd=${cmd}; id=${id}; reply=${reply}; prio=${prio}; due=${due || '-'}; ref=${ref || '-'}`;

/** 回执**宽容解析**：有 `@@rep` 就解析，没有就整段当一句话收下（format:'free'），绝不报错。 */
export function parseReply(text) {
  const raw = String(text ?? '');
  const oneLine = raw.split(/\r?\n/).map((x) => x.trim()).find(Boolean) ?? '';
  const m = raw.match(/@@rep\b([^\n]*)/i);
  if (!m) return { format: 'free', id: null, state: null, out: null, oneLine };
  const kv = {};
  const re = /([A-Za-z_]+)=([^;]*)/g;
  let hit;
  while ((hit = re.exec(m[1]))) kv[hit[1].toLowerCase()] = hit[2].trim();
  const st = kv.state ?? null;
  return { format: 'envelope', id: kv.id ?? null, state: ['done', 'blocked', 'failed', 'need-decide'].includes(st) ? st : null, rawState: st, out: kv.out ?? null, oneLine };
}

// ── 看板取数（只读）与聚合 ────────────────────────────────────────────────

/**
 * 看板端点要自定义请求头时（有些看板的 state 端点按作用域过滤），把整份键值放进
 * `ROUTER_BOARD_HEADERS`（JSON 对象串）。缺省 = 不加任何头（**本件不猜任何私有头名**）。
 */
function boardHeaders() {
  const raw = String(process.env.ROUTER_BOARD_HEADERS ?? '').trim();
  if (!raw) return {};
  try {
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object' || Array.isArray(j)) return {};
    const out = {};
    for (const [k, v] of Object.entries(j)) if (k && v !== null && v !== undefined) out[String(k)] = String(v);
    return out;
  } catch { return {}; }
}

export async function fetchBoard(opts = {}) {
  const headers = { ...boardHeaders(), ...(opts.headers ?? {}) };
  const r = await hostGet(BASE, '/api/task-board/state', { timeoutMs: TIMEOUT_MS, ...opts, headers });
  if (!r.ok) throw new Error(`看板 state 取不到：${r.error?.message ?? 'unknown'}（${BASE}/api/task-board/state）`);
  const top = r.body?.result?.value ?? r.body;  // 插件端点两种外壳都见过
  if (!top || !Array.isArray(top.tasks)) throw new Error('看板 state 结构异常：缺 tasks[]');
  return top;
}

/** 未答 = `answeredAt` 为空（**不 grep 卡面文本猜**）。 */
export function openAttentions(all) {
  return (Array.isArray(all) ? all : []).filter((a) => a && !a.answeredAt);
}

/**
 * 读卡账本：`{tasks:[{id,status}]}` ⇒ `Map<cardId, status>`。
 * 🔴 **读不到 / 结构不对 ⇒ null**（调用方据此 fail-open：一条都不销）。
 */
export function readLedgerCardStatus(file = LEDGER_FILE) {
  const j = readJsonSafe(file);
  if (!j.ok) return null;
  const tasks = j.value?.tasks;
  if (!Array.isArray(tasks)) return null;
  const map = new Map();
  for (const t of tasks) {
    const id = String(t?.id ?? '');
    if (id) map.set(id, String(t?.status ?? ''));
  }
  return map;
}

/**
 * 卡已「收口」的状态：还在账本里，但那条 attention 不该再算「等拍板」。
 * done = 已完成（完成卡的老 attention 留着就是假信号）。
 * ⚠️ 其余状态（backlog/todo/running/review/failed/blocked）**一律保留 open** —— 宁可多报，不许误销。
 */
const CLOSED_CARD_STATUS = new Set(['done']);

/**
 * 读取侧兜底销账：把「卡已不在板」的未答 attention 拆出 `stale`（纯函数，夹具可测）。
 * 判据（任一命中即 stale，不计入 open）：
 *   ① cardId **不在**账本 `tasks[].id` 里（已归档 / 删卡 / 从来不存在）；
 *   ② cardId 在账本里但 `status=done`（完成卡不该再问「重试/归档/先放着」）。
 * 🔴 **fail-open**：`ledger` 为 null（没核成）⇒ 一条都不销：open 原样返回、stale=[]、checked=false。
 * 🔴 纯读：不写状态件、不写 `answeredAt`、不删 attention、不碰账本。
 *
 * @param {Array} open 未答 attention
 * @param {Map<string,string>|null} ledger readLedgerCardStatus 的结果
 * @returns {{open:Array, stale:Array, staleCount:number, checked:boolean}}
 */
export function splitStaleAttentions(open = [], ledger = null) {
  const list = Array.isArray(open) ? open : [];
  if (!ledger) return { open: list, stale: [], staleCount: 0, checked: false };
  const fresh = [];
  const stale = [];
  for (const a of list) {
    const st = ledger.get(String(a?.cardId ?? ''));
    if (st === undefined || CLOSED_CARD_STATUS.has(st)) stale.push(a);
    else fresh.push(a);
  }
  return { open: fresh, stale, staleCount: stale.length, checked: true };
}

/**
 * 「等拍板」只认未答的 + 读取侧兜底销账（**纯读本地文件，不联网**）。
 * @param {{stateFile?:string, ledgerFile?:string}} [opt] 夹具钩子；生产零参调用
 */
export function readAttentions(opt = {}) {
  const j = readJson(opt.stateFile ?? STATE_FILE);
  const all = Array.isArray(j?.attentions) ? j.attentions : [];
  const split = splitStaleAttentions(openAttentions(all), readLedgerCardStatus(opt.ledgerFile ?? LEDGER_FILE));
  return {
    open: split.open, all, stale: split.stale, staleCount: split.staleCount,
    ledgerChecked: split.checked, file: opt.stateFile ?? STATE_FILE,
  };
}

/**
 * 「没算进等拍板」的那句说明（`brief` 第 1 行 / `status` 的等拍板块共用）。
 * 三种情形：①有陈旧账被销掉 ⇒ 说清件数；②账本没核成 ⇒ 说清「没核成」（fail-open 必须露痕迹）；
 * ③都干净 ⇒ 空串（老输出一个字符都不多）。
 */
export function staleNoteOf(attn) {
  if (attn?.ledgerChecked === false) return '（陈旧账没核成：账本读不到，按原样全算）';
  if (Number(attn?.staleCount) > 0) return `（另有 ${attn.staleCount} 件卡已归档/完成/不在板，不计入）`;
  return '';
}

/** 状态 → 车况桶（done 与其它状态不进车况）。 */
export function bucketOf(status) {
  return ({ running: 'run', todo: 'todo', backlog: 'todo', review: 'review', failed: 'failed' })[String(status ?? '')] ?? null;
}

/**
 * 按线聚合（卡没写 line ⇒ 「(未归线)」）。
 *
 * 后两个参数**可选**，只给"看板把卡挂在 thread 上"的用法留门：
 *   `threadLine` = `Map<cardId, line>`（卡面 line 为空时兜底）
 *   `threads`    = `[{line}]`（thread 里一张卡都没有、但有人开过的本，也建一行 0 车况）
 * 不给 ⇒ 行为与只传 tasks 时**逐字相同**。
 */
export function aggregate(tasks, threadLine = new Map(), threads = []) {
  const rows = new Map();
  const tl = threadLine instanceof Map ? threadLine : new Map();
  const ensure = (line) => {
    const r = rows.get(line) ?? { line, run: 0, todo: 0, review: 0, failed: 0, done: 0, cards: 0, lastAt: 0 };
    rows.set(line, r);
    return r;
  };
  for (const t of Array.isArray(tasks) ? tasks : []) {
    const line = norm(t?.line) || norm(tl.get(String(t?.id ?? ''))) || '(未归线)';
    const r = ensure(line);
    r.cards += 1;
    const b = bucketOf(t?.status);
    if (b) r[b] += 1;
    if (String(t?.status) === 'done') r.done += 1;
    r.lastAt = Math.max(r.lastAt, Number(t?.updatedAt ?? 0));
  }
  for (const t of Array.isArray(threads) ? threads : []) {
    const line = norm(t?.line);
    if (line && !rows.has(line)) ensure(line);
  }
  return [...rows.values()];
}

/** cardId → 该卡所属的线（卡面 line 为空时走 thread 兜底；都没有 ⇒ 「(未归线)」）。 */
export function lineOfCardMap(tasks, threadLine = new Map()) {
  const tl = threadLine instanceof Map ? threadLine : new Map();
  const map = new Map();
  for (const t of Array.isArray(tasks) ? tasks : []) {
    const id = String(t?.id ?? '');
    map.set(id, norm(t?.line) || norm(tl.get(id)) || '(未归线)');
  }
  return map;
}

const activeCount = (r) => r.run + r.todo + r.review + r.failed;
const rankOf = (r) => (r.failed > 0 ? 0 : r.run > 0 ? 1 : r.review > 0 ? 2 : r.todo > 0 ? 3 : 4);
const sumOf = (rows) => rows.reduce((a, r) => ({ run: a.run + r.run, todo: a.todo + r.todo, review: a.review + r.review, failed: a.failed + r.failed }), { run: 0, todo: 0, review: 0, failed: 0 });
const sortedActive = (rows) => rows.filter((r) => activeCount(r) > 0).sort((a, b) => (rankOf(a) - rankOf(b)) || (b.lastAt - a.lastAt));

/** 一屏车况（硬上限 maxLines：宁可砍行，不许超）。 */
export function renderStatus(board, rows, attn, maxLines = 20) {
  const lineW = 24, attnMax = 3, active = sortedActive(rows), t = sumOf(active);
  const titleById = new Map((board?.tasks ?? []).map((x) => [String(x?.id ?? ''), String(x?.title ?? '')]));
  const L = [`Router 车况    ${stamp()}`, `${padW('线名', lineW)} 跑  待  卡  败   最后活动`];
  const budget = Math.max(1, maxLines - 8 - attnMax);
  for (const r of active.slice(0, budget)) L.push(`${padW(clipW(r.line, lineW + 1), lineW)} ${padW(r.run, 2)}  ${padW(r.todo, 2)}  ${padW(r.review, 2)}  ${padW(r.failed, 2)}   ${ago(r.lastAt)}`);
  if (active.length > budget) L.push(`…另有 ${active.length - budget} 条有活线（--json 看全）`);
  L.push('─'.repeat(48), !attn.open.length ? `等拍板 0 件${staleNoteOf(attn)}` : `等拍板 ${attn.open.length} 件（未答）${staleNoteOf(attn)}`);
  if (attn.open.length) {
    for (const a of attn.open.slice(0, attnMax)) {
      const real = titleById.get(String(a?.cardId ?? ''));
      L.push(` · ${clipW(real ? `${real} → ${Array.isArray(a?.options) && a.options.length ? a.options.join('/') : '等你定'}` : norm(a?.question), 72)}`);
    }
    if (attn.open.length > attnMax) L.push(` …还有 ${attn.open.length - attnMax} 件（--json 看全部）`);
  }
  L.push(`口径 跑=running 待=todo+backlog 卡=review 败=failed ｜ 合计 跑${t.run} 待${t.todo} 卡${t.review} 败${t.failed} ｜ 静线${rows.filter((r) => !activeCount(r)).length}条`);
  if (L.length > maxLines) return `${L.slice(0, maxLines - 1).join('\n')}\n…已截断（原始 ${L.length} 行，--max-lines 调）`;
  return L.join('\n');
}

/**
 * 「先看哪条」：有未答拍板 → 有失败 → 等验收 → 在跑；同档取等得最久的那条（`lastAt` 最早）。
 * 只有排队活的线 tier=4（不当首选，但仍会返回）；一条在途活都没有 ⇒ null。
 *
 * @param {Array} rows aggregate 的结果
 * @param {Array} open 未答的 attentions
 * @param {Map<string,string>} [lineOfCard] cardId → 线名（给了就按它认"哪条线在等拍板"；
 *   不给 ⇒ 退回读 attention 自带的 `line` 字段，老行为不变）
 */
export function pickFocus(rows, open, lineOfCard = null) {
  const active = rows.filter((r) => activeCount(r) > 0);
  if (!active.length) return null;
  const map = lineOfCard instanceof Map ? lineOfCard : null;
  const waiting = new Set((Array.isArray(open) ? open : [])
    .map((a) => (map ? map.get(String(a?.cardId ?? '')) : norm(a?.line)))
    .filter(Boolean));
  const why = (r) => (r.failed > 0 ? `${r.failed} 张失败卡` : r.review > 0 ? `${r.review} 张等验收` : r.run > 0 ? `${r.run} 张在跑` : `只有 ${r.todo} 张排队`);
  const cands = active.map((r) => ({ line: r.line, lastAt: r.lastAt, tier: waiting.has(r.line) ? 0 : r.failed > 0 ? 1 : r.review > 0 ? 2 : r.run > 0 ? 3 : 4, why: why(r) }));
  cands.sort((a, b) => (a.tier - b.tier) || (a.lastAt - b.lastAt));
  return cands[0].tier === 0 ? { ...cands[0], why: '在等拍板' } : cands[0];
}

// ── 第 3 行「要你定」：失败卡不上桌 ─────────────────────────────────────────
//   两条硬要求（口径写死、可测）：
//     ① 明细 ≤ askMax 条（缺省 3），超出折叠成计数 —— 不许一屏清单糊住人；
//     ② 🔴 **执行失败卡不当主项**：那是机器该自己重试/归因的事，不是操作者的板；
//        它们只进折叠计数（`失败卡 N 件机器自管`），一条都不进明细。
//   排序：① 真等操作者拍的（attentions 里未答、且不是失败卡派生）② 待验收的卡；
//         两档内部一律「等得最久的先摆」（稳定排序，同档不改原序）。
//   ⚠️ 三条判据的**文案与状态名都是可配的**（见 briefOptions()）：我们的看板叫 `failed` /
//      `重试/归档/先放着`，别人的看板可能叫 `error` / `retry/archive/leave` —— 不许写死在代码里。
export const BRIEF_DEFAULTS = {
  askMax: 3,
  failedStatuses: ['failed'],
  reviewStatuses: ['review'],
  // 失败卡派生的问句固定文案：卡被归档/删掉之后看板状态查不到，只剩这条线索
  failedQuestionPatterns: ['执行失败（failed）', '执行失败(failed)'],
  // 失败卡的选项组合（建 attention 时固定写的那几个选项）
  failedOptionSets: [['重试', '归档', '先放着']],
};

/** 字符串或 RegExp 混着喂都行（配置里是字符串，夹具里常直接给 RegExp）。 */
function asRegExps(list) {
  return (Array.isArray(list) ? list : []).flatMap((x) => {
    if (x instanceof RegExp) return [x];
    try { return [new RegExp(String(x), 'i')]; } catch { return []; }
  });
}

/** `[['a','b'],['x','y']]` 每一组算一个"选项组合" */
function asOptionSets(list) {
  return (Array.isArray(list) ? list : [])
    .filter((s) => Array.isArray(s) && s.length)
    .map((s) => s.map((x) => String(x ?? '').trim()));
}

/**
 * 解析第 3 行的口径（**env > 配置 > 缺省**）。
 * env：`ROUTER_BRIEF_ASK_MAX` · `ROUTER_FAILED_STATUSES` · `ROUTER_REVIEW_STATUSES` ·
 *      `ROUTER_FAILED_Q_PATTERNS`（逗号分条）· `ROUTER_FAILED_OPTION_SETS`（`;` 分组、`/` 分项）
 * 配置：`brief.askMax` / `brief.failedStatuses` / `brief.reviewStatuses` /
 *      `brief.failedQuestionPatterns`（字符串数组）/ `brief.failedOptionSets`（二维数组）
 */
export function briefOptions(r = makeResolver()) {
  const askMax = Math.max(1, r.int('ROUTER_BRIEF_ASK_MAX', 'brief.askMax', BRIEF_DEFAULTS.askMax));
  const failedStatuses = r.list('ROUTER_FAILED_STATUSES', 'brief.failedStatuses', BRIEF_DEFAULTS.failedStatuses);
  const reviewStatuses = r.list('ROUTER_REVIEW_STATUSES', 'brief.reviewStatuses', BRIEF_DEFAULTS.reviewStatuses);
  const questionPatterns = asRegExps(r.list('ROUTER_FAILED_Q_PATTERNS', 'brief.failedQuestionPatterns', BRIEF_DEFAULTS.failedQuestionPatterns));

  const envSets = String(process.env.ROUTER_FAILED_OPTION_SETS ?? '').trim();
  const cfgSets = r.cfg?.brief?.failedOptionSets;
  const optionSets = envSets
    ? envSets.split(';').map((g) => g.split('/').map((x) => x.trim()).filter(Boolean)).filter((g) => g.length)
    : asOptionSets(Array.isArray(cfgSets) ? cfgSets : BRIEF_DEFAULTS.failedOptionSets);

  return { askMax, failedStatuses, reviewStatuses, questionPatterns, optionSets, warnings: r.warnings };
}

/**
 * 这条 attention 是不是「执行失败卡」派生的？
 * 三条机械判据（任一命中即算 —— 卡可能已被归档/删掉，所以不能只靠看板状态）：
 *   ① 看板里同 id 的卡 status ∈ failedStatuses；
 *   ② 问句命中 failedQuestionPatterns；
 *   ③ 选项恰好等于某一组 failedOptionSets。
 */
export function isFailedCardAttention(a, statusById = new Map(), opts = {}) {
  const statuses = Array.isArray(opts.statuses) ? opts.statuses : BRIEF_DEFAULTS.failedStatuses;
  const st = statusById.get(String(a?.cardId ?? '')) ?? '';
  if (st && statuses.map(String).includes(String(st))) return true;

  const pats = asRegExps(opts.questionPatterns ?? BRIEF_DEFAULTS.failedQuestionPatterns);
  const q = String(a?.question ?? '');
  if (pats.some((re) => { re.lastIndex = 0; return re.test(q); })) return true;

  const sets = asOptionSets(opts.optionSets ?? BRIEF_DEFAULTS.failedOptionSets);
  const joined = Array.isArray(a?.options) ? a.options.map((x) => String(x ?? '').trim()).join('/') : '';
  return !!joined && sets.some((set) => set.join('/') === joined);
}

/**
 * 把「要操作者定的事」拆成三份（**纯函数**，夹具直接喂假数据）。
 * @returns {{asks:Array, reviews:Array, failed:Array, statusById:Map<string,string>}}
 */
export function partitionBriefAttn({ open = [], tasks = [], opts = {} } = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  const statusById = new Map(list.map((t) => [String(t?.id ?? ''), String(t?.status ?? '')]));
  const askOpts = {
    statuses: opts.failedStatuses ?? BRIEF_DEFAULTS.failedStatuses,
    questionPatterns: opts.questionPatterns ?? BRIEF_DEFAULTS.failedQuestionPatterns,
    optionSets: opts.optionSets ?? BRIEF_DEFAULTS.failedOptionSets,
  };
  const asks = [];
  const failed = [];
  for (const a of Array.isArray(open) ? open : []) (isFailedCardAttention(a, statusById, askOpts) ? failed : asks).push(a);
  const askedAt = (a) => Date.parse(String(a?.askedAt ?? '')) || 0;
  asks.sort((x, y) => askedAt(x) - askedAt(y));            // 等得最久的先摆
  const reviewStatuses = (opts.reviewStatuses ?? BRIEF_DEFAULTS.reviewStatuses).map(String);
  const reviews = list
    .filter((t) => reviewStatuses.includes(String(t?.status ?? '')))
    .map((t) => ({ cardId: String(t?.id ?? ''), title: String(t?.title ?? ''), at: Number(t?.updatedAt ?? 0) }))
    .sort((x, y) => x.at - y.at);                          // 同样：等得最久的先摆
  return { asks, reviews, failed, statusById };
}

/** attention 的人读标签：卡名（从看板回查真名）+ 选项；查不到就用问句原文。 */
export function attentionLabel(a, titleById = new Map()) {
  const real = titleById.get(String(a?.cardId ?? ''));
  if (real) {
    const opts = Array.isArray(a?.options) && a.options.length ? a.options.join('/') : '等你定';
    return `${real} → ${opts}`;
  }
  return String(a?.question ?? '').replace(/\s+/g, ' ').trim();
}

/** 第 3 行渲染（≤askMax 条明细 + 折叠计数）—— 纯函数，夹具可测。 */
export function renderNeedsOwner(board, attn = {}, opts = {}) {
  const tasks = board?.tasks ?? [];
  const askMax = Math.max(1, Number(opts.askMax) || BRIEF_DEFAULTS.askMax);
  const { asks, reviews, failed } = partitionBriefAttn({ open: attn?.open ?? [], tasks, opts });
  const titleById = new Map(tasks.map((t) => [String(t?.id ?? ''), String(t?.title ?? '')]));
  const items = [
    ...asks.map((a) => clipW(attentionLabel(a, titleById), 34)),
    ...reviews.map((r) => clipW(`卡「${r.title}」待验收`, 34)),
  ];
  const shown = items.slice(0, askMax);
  const foldedPrimary = items.length - shown.length;
  const failedN = failed.length;
  // 序号隔开（①②③；**不用固定「②」当分隔符** —— 那样三条明细会渲染成「①②②」重号）
  const MARKS = ['①', '②', '③'];
  const body = shown.length ? ` ${shown.map((s, i) => `${MARKS[i] ?? '·'} ${s}`).join(' ')}` : ' 0 件';
  const tail = (foldedPrimary + failedN) > 0
    ? `（另有 ${foldedPrimary + failedN} 件${failedN ? `：其中失败卡 ${failedN} 件只报数、不占你的板（没有自动重试，长期不动要点开看）` : ''}；brief --json 看全量）`
    : '';
  return `要你定${body}${tail}`;
}

/**
 * 三行摘要（硬上限 3 行）。
 *   ① 车况一行　② 建议先看哪条　③ 要你定（≤askMax 条明细；失败卡只折叠成计数）
 * 要「下一步该推哪条线」再看 `brief --gaps`（愿景缺口，另起一段，不占这三行）。
 */
export function renderBrief(board, rows, attn, opts = {}) {
  const t = sumOf(rows.filter((r) => activeCount(r) > 0));
  const focus = pickFocus(rows, attn.open, opts.lineOfCard ?? null);
  return [
    `车况 ${rows.filter((r) => activeCount(r) > 0).length} 线有活 · 跑${t.run} 待${t.todo} 卡${t.review} 败${t.failed} ｜ 等拍板 ${attn.open.length} 件${staleNoteOf(attn)}`,
    focus ? `先看 ${clipW(focus.line, 28)}（${focus.why}，${ago(focus.lastAt)}）` : '先看 — 没有在途活',
    renderNeedsOwner(board, attn, opts),
  ].join('\n');
}

// ── 结论档（digest / reset 的落点）────────────────────────────────────────
const logPath = (date, dir = LOG_DIR) => path.join(dir, `router-${String(date).slice(0, 7).replace('-', '')}.md`);
const logHeader = (ym) => [
  `# Router 结论档 · ${ym}`, '',
  '> **这份档只放结论**：哪条线 + 一句结论 + 指向卡/报告的链接。**过程一律不进**（过程留在子线自己那边）。',
  '> 写入口：`router-act.mjs digest --line <线名> --text "<一句结论>" [--ask <愿景指针>] [--ref <…>] --apply`',
  '> 幂等键 = **线名 + 日期** ⇒ 同一天同一条线重复收口不会重复追加（同日改结论 = 手工改档）。',
  `> 槽位口径：每条线 1 行、上限 ${SLOT_MAX} 行 × 每行 ≤${SLOT_CHARS} 显示宽；\`ask=\` 是可选的 ≤6 字符愿景指针。`,
  '> `reset` 把当前槽位 + 待办事项写成一段「接续头」追加到本档末尾；**清空上下文归宿主/人，本件不清**。', '', '---', '', '',
].join('\n');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
/** 原子写：**同目录** `.tmp` → `rename`（崩在中间也不会留半份）。 */
function writeFileAtomic(file, content) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}
/** 按原文行尾切行（CRLF / LF 各自保住；不统一成 LF）。 */
function splitLinesKeepEol(txt) {
  const eol = String(txt).includes('\r\n') ? '\r\n' : '\n';
  return { eol, lines: String(txt).split(eol) };
}

const ASK_SEG = '｜ask=';

/**
 * 从一行正文里把「`｜ask=<≤6 字>`」这一**整段**摘出来 —— 从右往左找，绝不全局贪婪。
 *   · 只认**紧跟正文尾**的那一段（摘掉 ref 后，`ask=` 后面必须再没有 `｜`，且长度 1~6）；
 *   · 正文里出现 `ask=` 字样（不带前导全角竖线 / 后面接长文）⇒ **不当指针**，一律留在正文里；
 *   · `ask=-` 也算「没有」（接续头里旧行渲染成 `ask=-`，读回来要还原成 null）。
 */
function splitAskSegment(body) {
  const s = String(body ?? '');
  let idx = s.lastIndexOf(ASK_SEG);
  while (idx >= 0) {
    const tail = s.slice(idx + ASK_SEG.length);
    if (/^[^\n｜]{1,6}$/.test(tail)) {
      const ask = tail.trim();
      return { text: s.slice(0, idx), ask: ask === '-' ? null : ask };
    }
    idx = idx > 0 ? s.lastIndexOf(ASK_SEG, idx - 1) : -1;
  }
  return { text: s, ask: null };
}

/**
 * 一行结论的形状：`- 日期｜线名｜一句结论｜ask=A2｜ref：…`（`ask` / `ref` 都可省）。
 * 🔴 `ask` 是**可选**的 ≤6 字符愿景指针（指向该线愿景件里某条 ask 的 id）。
 *    为空 / `-` ⇒ **一个字符都不加** ⇒ 与加这个能力之前**逐字相同**（「默认等价」由夹具钉着）。
 */
export const buildRow = ({ date, line, text, ref, ask }) => {
  const raw = ask === null || ask === undefined ? '' : String(ask).trim();
  const A = raw === '-' ? '' : raw;      // `-` 也算「没有」⇒ 别让 `｜ask=-｜` 进结论档
  return `- ${date}｜${line}｜${norm(text)}${A ? `｜ask=${A}` : ''}${ref ? `｜ref：${ref}` : ''}`;
};

/** 解析一行结论（宽容：ask / ref 段都可省；结论里自带全角竖线也不拆坏）。 */
export function parseRow(raw) {
  const s = String(raw ?? '');
  const m = s.match(/^-\s+(\d{4}-\d{2}-\d{2})\s*｜/);
  if (!m) return null;
  const parts = s.slice(m[0].length).split('｜');
  const line = norm(parts.shift() ?? '');
  if (!line) return null;
  const rest = parts.join('｜');
  const rm = rest.match(/^([\s\S]*?)\s*｜\s*ref：\s*([\s\S]*)$/);
  const { text, ask } = splitAskSegment(rm ? rm[1] : rest);   // 先摘 ask，再当正文
  return { date: m[1], line, text: norm(text), ref: rm ? norm(rm[2]) : '', ask };
}
const readRows = (file) => { try { return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n').map(parseRow).filter(Boolean); } catch { return []; } };

/**
 * 「一行槽位」段的渲染 —— **`reset` 与「收口后刷新」共用这一支**（2026-11-05 · 年轮判据 A-3 补缺）。
 * 共用 ⇒ 两处产物**逐字同构**：接续头里那一段永远就是 `reset` 会写的那一段，不是第二套格式。
 * 返回值**含段尾那一个空行**。
 */
export function renderSlotBlock(slots = []) {
  const L = [];
  L.push(`#### 一行槽位（每条线 1 行 · 上限 ${SLOT_MAX} · 每行 ≤${SLOT_CHARS} 显示宽 · 只是"上次收口的结论"，不是活数据）`);
  // ⚠️ 槽位行故意用「·」而不是「-」开头：`- 日期｜线名｜…` 是结论行的形状，
  //    接续头若照抄那种形状，下次 readSlots 会把接续头里的副本也当结论读回来（自身污染）。
  if (!slots.length) L.push('· （结论档里还没有任何收口；先跑 digest 记一条）');
  for (const r of slots) {
    const over = widthOf(r.text) > SLOT_CHARS ? ' ⚠️超长' : '';
    // 槽位行带 `ask=` 指针。旧行没有 ask ⇒ 如实写 `ask=-`，**不回填、不猜**。
    L.push(`· ${r.line}｜${r.text}｜ask=${r.ask || '-'}｜${r.date}${r.ref ? `｜ref：${r.ref}` : ''}${over}`);
  }
  if (slots.length >= SLOT_MAX) L.push(`· （槽位已满 ${SLOT_MAX} 行：要加新线，先收口最旧那条）`);
  L.push('');
  return L;
}

/** 当前槽位 = 每条线最新那一行，按日期降序取前 max 条（跨月也拼得出来）。 */
/**
 * 当前「一行槽位」= 结论档里**每条线最新那一行**，按日期降序取前 max 条。
 *
 * 第三参 `prefer` = 当前**有活**的线名集合（看板现读；Set / 数组都行）。
 *   · 给了它 ⇒ **有活的线先占名额**（组内仍按日期降序、稳定排序），无活的历史行排在后面补位；
 *     名额只有 max 个时，无活的行要让位 —— 「在跑的主线都得有一行在槽位里」，
 *     不能让一条静线（当天更早收口过、此刻无在途卡）把活线挤出去。
 *   · 不给 / 给空集 / 一条都命中不了 ⇒ **行为与加这个参数之前逐字相同**（纯日期降序）。
 */
export function readSlots(max = SLOT_MAX, dir = LOG_DIR, prefer = null) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^router-\d{6}\.md$/.test(f)).sort().reverse(); } catch { return []; }
  const latest = new Map();
  for (const f of files) for (const r of readRows(path.join(dir, f))) {
    const cur = latest.get(r.line);
    if (!cur || r.date > cur.date) latest.set(r.line, r);
  }
  const rows = [...latest.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const ps = prefer ? (prefer instanceof Set ? prefer : new Set(prefer)) : null;
  if (ps && ps.size) {
    const live = rows.filter((r) => ps.has(r.line));
    if (live.length) return [...live, ...rows.filter((r) => !ps.has(r.line))].slice(0, Math.max(1, max));
  }
  return rows.slice(0, Math.max(1, max));
}

/** 「接续头」：下次开局读它就够（槽位 + 未答的事 + 怎么继续）。 */
export function renderResume({ slots = [], attnOpen = [], at = Date.now(), doc = '' } = {}) {
  const L = [`### 接续头 · ${stamp(at)}（上次收口时间）`, '', ...renderSlotBlock(slots), '#### 待办的事（只列未答的）'];
  if (!attnOpen.length) L.push('1. （没有未答的拍板请求）');
  attnOpen.slice(0, 20).forEach((a, i) => L.push(`${i + 1}. [卡 ${String(a?.cardId ?? '?').slice(0, 8)}] ${norm(a?.question).replace(/\s+/g, ' ')}${Array.isArray(a?.options) && a.options.length ? ` → 选 ${a.options.join('/')}` : ''}`));
  if (attnOpen.length > 20) L.push(`（还有 ${attnOpen.length - 20} 件，跑 status 看全）`);
  L.push('', '#### 怎么继续（三句）',
    '- 车况**现跑**：`node router-act.mjs brief`（别拿上面槽位当现状）',
    `- 结论**现读**：${doc ? doc.replace(/\\/g, '/') : '<log-dir>/router-<YYYYMM>.md'}`,
    '- 清空上下文**归宿主/人**（到阈值由宿主自动压；阈值见宿主配置的 `thresholdRatio`，本件不写死百分比）；'
    + '本件不自动清、不删会话、不归档。');
  return L.join('\n');
}

/**
 * 把结论档里**最新那段接续头**的「#### 一行槽位」段就地重渲染成「当前槽位」。
 *
 * 为什么要有它：`reset` 只在收口那一刻写接续头，之后 `digest` 只往结论区追加 ⇒ 档里的槽位段会一直停在
 * 上一次 `reset` 那天。本函数让**每次收口写完之后**顺手把那段刷成最新的。
 *
 * 🔴 只换那一段 —— 段外**一个字节都不动**：
 *   · 结论区是 append-only（历史行只许追加，不许重写）；
 *   · 接续头的时间戳 / 待办清单 / 「怎么继续」归 `reset`（谁写整段谁负责），这里不冒充；
 *   · 更早的接续头段是历史 ⇒ 只刷新**最后一段**，前面几段原样留着。
 * 幂等：渲染结果与档里逐字相同 ⇒ **不写盘**（同一天重跑，前后 sha 相同）。
 *
 * @returns {{ok:boolean, reason:string|null, changed:boolean, wrote:boolean, err:string|null,
 *            slotSections:number, atLine:number, beforeLines:number, afterLines:number,
 *            shaBefore:string, shaAfter:string}}
 */
export function refreshResumeHeadSlots({ doc, slots = [], apply = true } = {}) {
  const r = {
    ok: true, reason: null, changed: false, wrote: false, err: null,
    slotSections: 0, atLine: 0, beforeLines: 0, afterLines: 0, shaBefore: '', shaAfter: '',
  };
  let buf;
  try { buf = fs.readFileSync(doc); } catch { r.ok = false; r.reason = 'no-doc'; return r; }
  const { eol, lines } = splitLinesKeepEol(buf.toString('utf8'));
  const starts = [];
  lines.forEach((l, i) => { if (/^####\s+一行槽位/.test(l)) starts.push(i); });
  r.slotSections = starts.length;
  if (!starts.length) { r.ok = false; r.reason = 'no-slot-section'; return r; }
  const i = starts[starts.length - 1];
  let j = lines.length;
  for (let k = i + 1; k < lines.length; k++) { if (/^#{3,4}\s+/.test(lines[k])) { j = k; break; } }
  const oldBlock = lines.slice(i, j);
  const newBlock = renderSlotBlock(slots);
  r.atLine = i + 1;
  r.beforeLines = oldBlock.filter((l) => l.startsWith('· ')).length;
  r.afterLines = newBlock.filter((l) => l.startsWith('· ')).length;
  r.shaBefore = sha256(Buffer.from(oldBlock.join('\n'), 'utf8'));
  r.shaAfter = sha256(Buffer.from(newBlock.join('\n'), 'utf8'));
  r.changed = oldBlock.join('\n') !== newBlock.join('\n');
  if (!r.changed) { r.reason = 'unchanged'; return r; }
  if (!apply) { r.reason = 'dry-run'; return r; }
  try {
    writeFileAtomic(doc, [...lines.slice(0, i), ...newBlock, ...lines.slice(j)].join(eol));
    r.wrote = true;
  } catch (e) {
    r.ok = false;
    r.err = e?.message ?? String(e);
  }
  return r;
}

/**
 * 现读看板拿「有活」的线名集合（给 `readSlots` 的 `prefer` 用）。
 * 🔴 拿不到就返回 `null`（调用方退回纯日期口径）—— 收口绝不能因为看板取数失败而停。
 */
async function activeLineSetOrNull(opts = {}) {
  try {
    const board = await fetchBoard(opts);
    const rows = aggregate(board.tasks ?? []);
    return new Set(rows.filter((r) => activeCount(r) > 0).map((r) => r.line));
  } catch { return null; }
}

// ── digest --auto：每线一行，纯机械（零模型调用）──────────────────────────────
//   输入 = 当前「有活的主线」集合 —— 与 `brief` 车况**同一套**（aggregate + activeCount>0），不另造口径；
//   每条线一行 = 该线**最近一张已完成卡的标题**（截断到槽位显示宽）+ 卡 id 作 ref；
//   没有已完成卡的线**不编结论**，退化成「该线最近一张卡 + 它的状态词」（同样是机械摘取）。
export const AUTO_STATUS_WORD = {
  running: '在跑', review: '待验收', todo: '排队', backlog: '排队', failed: '失败', done: '已完成',
};

/**
 * 机械摘取「每条有活主线一行结论」—— 纯函数（夹具直接喂假数据；**不读盘、不联网**）。
 * @param {{tasks?:Array, rows?:Array, lineOfCard?:Map<string,string>}} opts
 * @returns {Array<{line:string, text?:string, ref?:string, kind?:string, at?:number, skip?:string}>}
 *   `skip:'no-card'` = 这条线一张卡都没有（不编，交给调用方如实打印）。
 */
export function buildAutoDigestRows({ tasks = [], rows = [], lineOfCard = new Map() } = {}) {
  const doneBy = new Map();
  const lastBy = new Map();
  for (const t of Array.isArray(tasks) ? tasks : []) {
    const line = norm(lineOfCard.get(String(t?.id ?? '')));
    if (!line) continue;
    const at = Number(t?.updatedAt ?? 0);
    const cur = lastBy.get(line);
    if (!cur || at > Number(cur?.updatedAt ?? 0)) lastBy.set(line, t);
    if (String(t?.status ?? '') !== 'done') continue;
    const d = doneBy.get(line);
    if (!d || at > Number(d?.updatedAt ?? 0)) doneBy.set(line, t);
  }
  const active = (Array.isArray(rows) ? rows : [])
    .filter((r) => activeCount(r) > 0)
    .sort((a, b) => (rankOf(a) - rankOf(b)) || (b.lastAt - a.lastAt));
  const out = [];
  for (const r of active) {
    const d = doneBy.get(r.line);
    const src = d ?? lastBy.get(r.line);
    if (!src) { out.push({ line: r.line, skip: 'no-card' }); continue; }
    const word = d ? '已完成' : (AUTO_STATUS_WORD[String(src?.status ?? '')] ?? '最近');
    const title = String(src?.title ?? '').replace(/\s+/g, ' ').trim();
    out.push({
      line: r.line,
      text: clipW(`${word}：${title}`, SLOT_CHARS),
      ref: String(src?.id ?? ''),
      kind: d ? 'done' : String(src?.status ?? ''),
      at: Number(src?.updatedAt ?? 0),
    });
  }
  return out;
}

// ── 动词 ───────────────────────────────────────────────────────────────────
const usageError = (msg) => { process.stderr.write(`❌ ${msg}\n`); return 2; };
const asJson = (argv) => argv.includes('--json');
const intOf = (argv) => (f, d) => Number(argvVal(argv)(f, d)) || d;

/**
 * `status --json` 的机器可读形状（**纯函数**，夹具可测）。
 * 老键一个不动；`staleAttentions` 只加键（读取侧销账的如实交代）。
 */
export function renderJson(board, rows, attn) {
  return JSON.stringify({
    at: new Date().toISOString(), version: VERSION, totals: { cards: (board?.tasks ?? []).length, ...sumOf(rows) },
    lines: sortedActive(rows).map((r) => ({ ...r, lastAtISO: r.lastAt ? new Date(r.lastAt).toISOString() : null })),
    attention: {
      open: attn.open.length,
      total: attn.all.length,
      staleAttentions: { count: attn.staleCount ?? 0, cardIds: (attn.stale ?? []).map((a) => String(a?.cardId ?? '')), checked: attn.ledgerChecked !== false },
    },
  }, null, 2);
}

async function cmdStatus(argv, opts) {
  const maxLines = intOf(argv)('--max-lines', 20);
  const board = await fetchBoard(opts);
  const attn = readAttentions();
  const rows = aggregate(board.tasks);
  if (!asJson(argv)) { process.stdout.write(`${renderStatus(board, rows, attn, maxLines)}\n`); return 0; }
  process.stdout.write(`${renderJson(board, rows, attn)}\n`);
  return 0;
}

async function cmdBrief(argv, opts) {
  const board = await fetchBoard(opts);
  const attn = readAttentions();
  const rows = aggregate(board.tasks);
  const bopts = briefOptions();
  const withGaps = argv.includes('--gaps');
  let text = renderBrief(board, rows, attn, bopts);
  let vg = null;
  if (withGaps) {
    vg = buildVisionGaps({ rows, slots: readSlots(SLOT_MAX), now: Date.now() });
    text += `\n${renderVisionGaps(vg.gaps, { note: vg.note, top: vg.view.top, textChars: vg.view.textChars })}`;
  }
  if (asJson(argv)) {
    const parts = partitionBriefAttn({ open: attn.open, tasks: board.tasks, opts: bopts });
    process.stdout.write(`${JSON.stringify({
      at: new Date().toISOString(),
      version: VERSION,
      brief: text.split('\n'),
      needsOwner: {
        asks: parts.asks.length, reviews: parts.reviews.length, failedAttentions: parts.failed.length, shownMax: bopts.askMax,
        // 读取侧兜底销账的如实交代（**只加键**，老键一个不动）
        staleAttentions: { count: attn.staleCount ?? 0, cardIds: (attn.stale ?? []).map((a) => String(a?.cardId ?? '')), checked: attn.ledgerChecked !== false },
      },
      ...(vg ? { visionGaps: vg.gaps, visionView: vg.view, visionWarnings: vg.warnings, visionNote: vg.note, visionTotals: vg.idx.totals } : {}),
    }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`${text}\n`);
  return 0;
}

async function cmdCardShow(argv, opts) {
  const want = norm(argvVal(argv)('--card', ''));
  if (!want) return usageError('缺 --card <cardId>（前缀匹配，命中恰好 1 张才输出）');
  const maxLines = Math.min(40, intOf(argv)('--max-lines', 20));
  const hits = (await fetchBoard(opts)).tasks.filter((t) => String(t?.id ?? '').startsWith(want));
  if (!hits.length) { process.stderr.write(`✗ 找不到卡：${want}\n`); return 3; }
  if (hits.length > 1) {
    process.stderr.write(`✗ 卡 id 前缀不唯一（${hits.length} 张），给更长的前缀：\n`);
    for (const t of hits.slice(0, 10)) process.stderr.write(`  ${t.id}  ${String(t.title ?? '').slice(0, 50)}\n`);
    return 3;
  }
  const t = hits[0];
  const L = [`卡 ${t.id}`, `  标题：${String(t.title ?? '').slice(0, 90)}`, `  状态：${t.status ?? '?'}${t.line ? `  线：${t.line}` : ''}`];
  if (t.updatedAt) L.push(`  更新：${ago(t.updatedAt)}`);
  const desc = String(t.description ?? '');
  const idx = desc.indexOf('待拍板');
  if (idx >= 0) L.push('  ── 待拍板段 ──', ...desc.slice(idx).split(/\r?\n/).slice(1, 11).map((x) => `  ${x}`));
  process.stdout.write(`${L.slice(0, maxLines).join('\n')}\n`);
  return 0;
}

async function listSessions(opts) {
  const r = await hostRpc(BASE, 'session.list', {}, { timeoutMs: TIMEOUT_MS, ...opts });
  if (!r.ok) throw new Error(r.error?.message ?? 'session.list 失败');
  return Array.isArray(r.value?.items) ? r.value.items : [];
}

async function cmdSay(argv, opts) {
  const val = argvVal(argv);
  const has = (f) => argv.includes(f);
  const TO = norm(val('--to', ''));
  const TEXT = String(val('--text', '') ?? '');
  const RECEIPT = val('--receipt', null);
  const RAW = has('--raw');
  const APPLY = has('--apply');
  const JSONOUT = asJson(argv);
  const MODE = norm(val('--mode', 'queue'));
  const CMD = norm(val('--cmd', 'do')).toLowerCase();
  const PRIO = norm(val('--prio', 'today')).toLowerCase();
  const DUE = norm(val('--due', '-')) || '-';
  const REF = norm(val('--ref', '-')) || '-';
  const REPLY = norm(val('--reply', 'router')) || 'router';
  const DECIDED = norm(val('--decided-by', 'router')).toLowerCase();
  const id = norm(val('--id', '')) || shortId();

  // ① 用法闸（空正文不投：投话是真打扰）
  if (RECEIPT === null && !TEXT.trim()) return usageError('缺正文（--text "一句话"）—— 空正文不投');
  if (MODE !== 'queue' && MODE !== 'steer') return usageError(`--mode 只支持 queue|steer，收到 "${MODE}"`);
  if (!RAW && !CMD_WORDS.includes(CMD)) return usageError(`--cmd 只支持 ${CMD_WORDS.join('|')}（封闭词表）；收到 "${CMD}"`);
  if (!RAW && !PRIO_WORDS.includes(PRIO)) return usageError(`--prio 只支持 ${PRIO_WORDS.join('|')}；收到 "${PRIO}"`);
  if (!DECIDED_BY.includes(DECIDED)) return usageError(`--decided-by 只支持 ${DECIDED_BY.join('|')}；收到 "${DECIDED}"`);

  // ② 记回执模式：只落流水，不投递
  if (RECEIPT !== null) {
    const parsed = parseReply(RECEIPT);
    const w = appendOps(opsRecord({ verb: 'say', target: TO || '(未指定)', sid: null, decidedBy: DECIDED, id: parsed.id || id, format: parsed.format, extra: { action: 'receipt', state: parsed.state, out: parsed.out, oneLine: clipW(parsed.oneLine, 80) } }));
    if (JSONOUT) process.stdout.write(`${JSON.stringify({ verb: 'say', action: 'receipt', ...parsed, ops: w }, null, 2)}\n`);
    else {
      process.stdout.write(`记回执（format=${parsed.format}${parsed.state ? ` · state=${parsed.state}` : ''}）\n  ${clipW(parsed.oneLine, 100)}\n`);
      if (parsed.format === 'free') process.stdout.write('  （对方没守 @@rep 格式 —— 照收，不丢不报错）\n');
      process.stdout.write(`  流水：${w.ok ? `+1 行 → ${w.file}` : `✗ 写失败（${w.error}）`}\n`);
    }
    return w.ok ? 0 : 1;
  }
  if (!TO) return usageError('缺目标（--to <线名|会话id>）');

  // ③ 投递（唯一一条腿：lib/say.mjs；两闸在那边）
  let body = TEXT;
  if (!RAW) {
    const items = await listSessions(opts).catch(() => []);
    const hit = items.find((it) => String(it?.sessionId ?? it?.id ?? '') === TO);
    const title = String(hit?.projections?.values?.title ?? '');
    const to = clipW(norm(title).replace(/^(\s*【[^】]{1,12}】\s*)+/, '').trim() || TO, 16);
    body = buildEnvelope({ to, text: TEXT, cmd: CMD, id, reply: REPLY, prio: PRIO, due: DUE, ref: REF });
  }
  const res = await sayViaLib({ to: TO, text: body, mode: MODE, apply: APPLY, allowSelf: has('--allow-self'), allowHandoff: has('--allow-handoff'), base: BASE, opts });

  for (const n of res.notes ?? []) process.stdout.write(`${n}\n`);
  if (!JSONOUT) {
    process.stdout.write(`[${APPLY ? 'apply' : 'dry-run'}] Router 投话 · ${APPLY ? '真投' : '只预览，不投'}\n`);
    if (res.sid) process.stdout.write(`  目标：${res.sid}${res.target?.running ? '（▶在跑）' : '（空闲）'}  短号：${id}  模式：${MODE}\n`);
    process.stdout.write(`  ── 正文（${Buffer.byteLength(body, 'utf8')} B）──\n${body}\n  ──\n`);
    if (res.error) process.stderr.write(`✗ ${res.error}\n`);
    for (const c of res.cands ?? []) process.stderr.write(`  ${c.running ? '▶' : ' '} ${c.sid}  ${String(c.title).slice(0, 60)}\n`);
    if (res.dryRun) process.stdout.write('  （未投递；加 --apply 真投）\n');
  }
  const w = appendOps(opsRecord({
    verb: 'say', target: TO, sid: res.sid ?? null, ok: res.ok === true, dryRun: !APPLY, decidedBy: DECIDED, id, format: RAW ? 'raw' : 'envelope',
    extra: { to: TO, cmd: RAW ? null : CMD, prio: RAW ? null : PRIO, due: RAW ? null : DUE, ref: RAW ? null : REF, rc: res.rc, gate: res.ok ? null : (res.rc === SAY_EXIT.ARCHIVED ? 'archived' : res.rc === SAY_EXIT.SELF ? 'self' : 'other') },
  }));
  if (JSONOUT) process.stdout.write(`${JSON.stringify({ verb: 'say', rc: res.rc, ok: res.ok, dryRun: !APPLY, sid: res.sid ?? null, id, decidedBy: DECIDED, body, ops: w, error: res.error ?? null }, null, 2)}\n`);
  else {
    process.stdout.write(`  流水：${w.ok ? `+1 行 → ${w.file}` : `✗ 写失败（${w.error}）`}\n`);
    if (!w.ok) process.stderr.write(`⚠️ 动作流水写失败：${w.error}${APPLY && res.ok ? '（话已投出，账没记上 —— 不撤销，如实报）' : ''}\n`);
  }
  return res.rc;
}

/**
 * `digest --auto` 的完整流程（唯一写盘仍是"档不在就先写头、再追加一行"那一条路径）。
 * 幂等键沿用 digest：线名 + 日期 ⇒ 同一天同一条线重复跑**零新增行**。
 */
async function runAutoDigest({ DIR, DATE, APPLY, JSONOUT, DECIDED, opts }) {
  const board = await fetchBoard(opts);
  const tasks = board?.tasks ?? [];
  const rows = aggregate(tasks);
  const lineOfCard = lineOfCardMap(tasks);
  const plan = buildAutoDigestRows({ tasks, rows, lineOfCard });

  const doc = logPath(DATE, DIR);
  const existed = new Set(readRows(doc).map((r) => `${r.date}｜${r.line}`));
  const todo = plan.filter((p) => !p.skip && !existed.has(`${DATE}｜${p.line}`));
  const skipped = plan.filter((p) => p.skip);

  let wrote = 0;
  let err = null;
  if (APPLY) {
    for (const p of todo) {
      try {
        if (!fs.existsSync(doc)) {
          fs.mkdirSync(path.dirname(doc), { recursive: true });
          fs.writeFileSync(doc, logHeader(DATE.slice(0, 7).replace('-', '')), 'utf8');
        }
        fs.appendFileSync(doc, `${buildRow({ date: DATE, line: p.line, text: p.text, ref: p.ref })}\n`, 'utf8');
        wrote += 1;
      } catch (e) { err = e?.message ?? String(e); break; }
    }
  }

  // 收口写完顺手刷接续头的槽位段（有活线优先；没接续头就不发明新段）
  let refresh = null;
  if (APPLY && wrote && !err) {
    const live = new Set(plan.filter((p) => !p.skip).map((p) => p.line));
    refresh = refreshResumeHeadSlots({ doc, slots: readSlots(SLOT_MAX, DIR, live), apply: true });
  }

  const w = appendOps(opsRecord({
    verb: 'digest', target: '(auto)', sid: null, ok: !err, dryRun: !APPLY, decidedBy: DECIDED,
    extra: { date: DATE, doc, auto: true, planned: plan.length, wrote, skippedNoCard: skipped.length, error: err },
  }));

  if (JSONOUT) {
    process.stdout.write(`${JSON.stringify({
      verb: 'digest', auto: true, date: DATE, doc, ok: !err, dryRun: !APPLY, wrote,
      planned: plan.map((p) => ({ line: p.line, text: p.text ?? null, ref: p.ref ?? null, skip: p.skip ?? null })),
      refresh, error: err, ops: w,
    }, null, 2)}\n`);
  } else {
    process.stdout.write(`[${APPLY ? 'apply' : 'dry-run'}] digest --auto · ${DATE} · 有活主线 ${plan.length - skipped.length} 条\n  结论档：${doc}\n`);
    for (const p of plan) {
      process.stdout.write(p.skip
        ? `  · ${p.line}：一条卡都没读到 ⇒ 不编结论（skip=no-card）\n`
        : `  ${existed.has(`${DATE}｜${p.line}`) ? '=' : '+'} ${p.line}｜${p.text}｜ref：${p.ref}\n`);
    }
    if (!APPLY) process.stdout.write('  （未写；加 --apply 才追加）\n');
    if (err) process.stderr.write(`✗ 写结论档失败：${err}\n`);
    if (refresh) process.stdout.write(refresh.wrote ? `  接续头槽位段已刷新（第 ${refresh.atLine} 行起，${refresh.beforeLines} → ${refresh.afterLines} 行）\n` : `  接续头槽位段：${refresh.ok ? refresh.reason : refresh.reason ?? '没刷'}\n`);
    process.stdout.write(`  流水：${w.ok ? `+1 行 → ${w.file}` : `✗ 写失败（${w.error}）`}\n`);
  }
  return err || !w.ok ? 1 : 0;
}

async function cmdDigest(argv, opts = {}) {
  const val = argvVal(argv);
  const DIR = norm(val('--dir', '')) || LOG_DIR;     // 夹具/演练钩子：只换结论档目录，生产别带
  const LINE = norm(val('--line', ''));
  const RAW_TEXT = String(val('--text', '') ?? '');
  const DATE = norm(val('--date', '')) || ymd();
  const APPLY = argv.includes('--apply');
  const JSONOUT = asJson(argv);
  const DECIDED = norm(val('--decided-by', 'router')).toLowerCase();
  const AUTO = argv.includes('--auto');

  if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE) || Number.isNaN(Date.parse(`${DATE}T00:00:00`))) return usageError(`--date 要 YYYY-MM-DD，收到 "${DATE}"`);
  if (!DECIDED_BY.includes(DECIDED)) return usageError(`--decided-by 只支持 ${DECIDED_BY.join('|')}；收到 "${DECIDED}"`);

  if (AUTO) {
    if (LINE || norm(RAW_TEXT)) return usageError('--auto 是「每条有活主线机械写一行」，不接受 --line / --text');
    return runAutoDigest({ DIR, DATE, APPLY, JSONOUT, DECIDED, opts });
  }

  if (!LINE) return usageError('缺线名（--line <线名>）—— 一条线一行');
  if (widthOf(LINE) > 60) return usageError(`线名太长（${widthOf(LINE)} > 60）：写线名，别把整句塞进来`);
  const TEXT = norm(RAW_TEXT.replace(/\r\n/g, '\n').split('\n')[0]);
  const extraLines = RAW_TEXT.replace(/\r\n/g, '\n').split('\n').slice(1).filter((l) => l.trim()).length;
  if (!TEXT) return usageError('缺结论（--text "一句结论"）—— 空结论不收');

  // 愿景指针（可选，≤6 字符）。`--ask -` = 显式「没有」。
  const askRaw = val('--ask', null);
  const askGiven = askRaw !== null;
  const ask = askGiven ? (norm(askRaw) === '-' ? null : norm(askRaw) || null) : null;
  if (ask && [...ask].length > 6) return usageError(`--ask 只收 ≤6 个字符的愿景指针（指向该线愿景件里某条 ask 的 id）；收到 "${ask}"`);

  const ref = norm(val('--ref', '')).replace(/\\/g, '/');   // 档是 markdown：反斜杠会被吃掉
  const row = buildRow({ date: DATE, line: LINE, text: TEXT, ref, ask });
  const doc = logPath(DATE, DIR);
  const existed = readRows(doc).some((r) => r.date === DATE && r.line === LINE);

  let wrote = false, err = null;
  if (APPLY && !existed) try {
    if (!fs.existsSync(doc)) { fs.mkdirSync(path.dirname(doc), { recursive: true }); fs.writeFileSync(doc, logHeader(DATE.slice(0, 7).replace('-', '')), 'utf8'); }
    fs.appendFileSync(doc, `${row}\n`, 'utf8');
    wrote = true;
  } catch (e) { err = e?.message ?? String(e); }

  // 收口写完顺手刷接续头的槽位段（只换那一段；档里没有接续头就不发明新段）
  let refresh = null;
  if (wrote) refresh = refreshResumeHeadSlots({ doc, slots: readSlots(SLOT_MAX, DIR), apply: true });

  if (!asJson(argv)) {
    process.stdout.write(`[${APPLY ? 'apply' : 'dry-run'}] digest · ${LINE} · ${DATE}\n  结论档：${doc}\n`);
    process.stdout.write(existed ? '  幂等：同一天同一条线已有 ⇒ 跳过（不重复追加；同日改结论请手工改档）\n' : `  这一行：${row}\n`);
    if (extraLines) process.stdout.write(`  ⚠️ --text 有多行，只收第一行（其余 ${extraLines} 行没进档：过程不进结论档）\n`);
    if (!APPLY) process.stdout.write('  （未写；加 --apply 才追加）\n');
    if (refresh) process.stdout.write(refresh.wrote ? `  接续头槽位段已刷新（第 ${refresh.atLine} 行起，${refresh.beforeLines} → ${refresh.afterLines} 行）\n` : `  接续头槽位段：${refresh.ok ? refresh.reason : refresh.reason ?? '没刷'}\n`);
    if (err) process.stderr.write(`✗ 写结论档失败：${err}\n`);
  }
  const w = appendOps(opsRecord({ verb: 'digest', target: LINE, sid: null, ok: !err, dryRun: !APPLY, decidedBy: DECIDED, extra: { date: DATE, doc, ref: ref || null, ask: ask || null, askGiven, chars: TEXT.length, wrote, skipped: existed ? 'duplicate' : null, error: err } }));
  if (asJson(argv)) process.stdout.write(`${JSON.stringify({ verb: 'digest', line: LINE, date: DATE, doc, row, ask: ask || null, ok: !err, dryRun: !APPLY, wrote, skipped: existed ? 'duplicate' : null, refresh, error: err, ops: w }, null, 2)}\n`);
  else process.stdout.write(`  流水：${w.ok ? `+1 行 → ${w.file}` : `✗ 写失败（${w.error}）`}\n`);
  return err || !w.ok ? 1 : 0;
}

async function cmdReset(argv, opts = {}) {
  const DECIDED = norm(argvVal(argv)('--decided-by', 'router')).toLowerCase();
  const APPLY = argv.includes('--apply');
  if (!DECIDED_BY.includes(DECIDED)) return usageError(`--decided-by 只支持 ${DECIDED_BY.join('|')}；收到 "${DECIDED}"`);

  const at = Date.now();
  // reset 与收口**同一套取舍**：有活的线优先，活线不满 16 名时静线补位。
  // 拿不到看板（取数失败）⇒ null ⇒ 退回纯日期口径（reset 不能因为取数失败而不干活）。
  const slots = readSlots(SLOT_MAX, LOG_DIR, await activeLineSetOrNull(opts));
  const attn = readAttentions();     // 本地文件；**不联网**（宿主起不来也能收口）
  const doc = logPath(ymd(at));
  const head = renderResume({ slots, attnOpen: attn.open, at, doc });

  let wrote = false, err = null;
  if (APPLY) try {
    if (!fs.existsSync(doc)) { fs.mkdirSync(path.dirname(doc), { recursive: true }); fs.writeFileSync(doc, logHeader(ymd(at).slice(0, 7).replace('-', '')), 'utf8'); }
    fs.appendFileSync(doc, `\n${head}\n`, 'utf8');
    wrote = true;
  } catch (e) { err = e?.message ?? String(e); }
  const w = appendOps(opsRecord({ verb: 'reset', target: '(router)', sid: null, ok: !err, dryRun: !APPLY, decidedBy: DECIDED, extra: { doc, slots: slots.length, attentions: attn.open.length, wrote, error: err, sessionTouched: false } }));

  if (asJson(argv)) process.stdout.write(`${JSON.stringify({ verb: 'reset', ok: !err, dryRun: !APPLY, doc, slots: slots.length, attentions: attn.open.length, wrote, error: err, head, ops: w, sessionTouched: false }, null, 2)}\n`);
  else {
    process.stdout.write(`[${APPLY ? 'apply' : 'dry-run'}] reset · 槽位 ${slots.length} 行 · 等拍板 ${attn.open.length} 件\n  结论档：${doc}\n`);
    process.stdout.write(APPLY ? (wrote ? '  已把接续头追加到档尾。\n' : `  ✗ 写档失败：${err}\n`) : '  （dry-run：没写；加 --apply 才追加）\n');
    process.stdout.write(`  ── 接续头（直接贴给下一次的自己）──\n${head}\n  ──\n`);
    process.stdout.write('  🔴 没有清空任何东西：不调 compact、不删会话、不归档；到阈值由宿主自动压（阈值见宿主配置的 thresholdRatio）。\n');
    process.stdout.write(`  流水：${w.ok ? `+1 行 → ${w.file}` : `✗ 写失败（${w.error}）`}\n`);
  }
  return err || !w.ok ? 1 : 0;
}

async function cmdWake(argv) {
  // 写面**故意不实现**：唤醒要一套「卡片分组 + 三道闸（单条上限 / 冷却 / 一键关）」的数据面，
  // 那是看板侧的契约、不是本骨架的东西。给个诚实的 stub，比给个半吊子安全。
  const w = appendOps(opsRecord({ verb: 'wake', target: '(stub)', sid: null, ok: false, dryRun: !argv.includes('--apply'), extra: { note: 'stub-no-thread-plane' } }));
  process.stdout.write('[wake] 本骨架不含 thread 唤醒面（需要看板侧的卡片分组数据 + 三道闸）。\n'
    + '  没有 thread 的活请改用 `say`：把话投给那条线的主会话，由它自己去跑卡。\n'
    + `  流水：${w.ok ? `+1 行 → ${w.file}` : `✗ 写失败（${w.error}）`}\n`);
  return 2;
}

// ── 入口 ───────────────────────────────────────────────────────────────────
const VERBS = ['status', 'brief', 'card-show', 'say', 'digest', 'reset', 'wake'];

export const USAGE = `router-act.mjs v${VERSION}（受控手 · 白名单动词 · 默认 dry-run）

  node router-act.mjs brief     [--json] [--gaps]                只读：三行摘要（--gaps 另起一段「愿景差距」）
  node router-act.mjs status    [--json] [--max-lines N]         只读：一屏车况
  node router-act.mjs card-show --card <cardId> [--max-lines N]  只读：一张卡的一句话
  node router-act.mjs say       --to <线名|会话id> --text "<一句话>" [--apply] [选项]
  node router-act.mjs digest    --line <线名> --text "<一句结论>" [--ask <≤6 字符指针>] [--ref <…>] [--date YYYY-MM-DD] [--apply]
  node router-act.mjs digest    --auto [--date YYYY-MM-DD] [--apply]    每条有活主线机械写一行（零模型调用）
  node router-act.mjs reset     [--apply] [--json]
  node router-act.mjs wake      （stub：本骨架不含 thread 唤醒面）

  say 是**唯一**能打扰别的会话的动词；投递腿只有 lib/say.mjs 一条（两闸：不投自己 / 不投已归档）
  digest / reset 只写结论档；reset **不清空任何东西**（不 compact / 不删会话 / 不归档）
  --json 机器可读 · --max-lines 人类可读的硬上限（status 默认 20；card-show 上限 40）
  🔴 参数是**白名单**：不认识的 flag ⇒ rc=2 + 打印该动词用法，**一个字节都不写盘**（写动词带 --apply 也拦）

  第 3 行「要你定」：明细 ≤${BRIEF_DEFAULTS.askMax} 条（可配），**执行失败卡只折叠成计数、不进明细**
  --gaps：另起一段「愿景差距」= 各条线声明的目标 vs 看板现状，回答"下一步该推哪条线"（只读）
  digest --ask：给槽位那行加一个 ≤6 字符的愿景指针（不给 ⇒ 一个字符都不加）
  digest --auto：把每条有活主线写一行（取最近一张已完成卡的标题；没有就退化成「状态词：最近一张卡」）
  收口写完会顺手把最新那段接续头的「一行槽位」刷成当前槽位（只换那一段，档里没有就不发明）
  陈旧账（卡已归档/完成/不在账本）**读取侧兜底销账**，只报数、不写任何状态；账本读不到 ⇒ 一条都不销

say 选项：--cmd ${CMD_WORDS.join('|')} · --prio ${PRIO_WORDS.join('|')} · --id/--due/--ref/--reply
          --raw（原样投、不套信封）· --mode queue|steer · --decided-by ${DECIDED_BY.join('|')}
          --receipt "<对方回话原文>"（不投递，只记账）· --allow-self / --allow-handoff（自测用）

环境：DSH_WEB_URL（默认 http://127.0.0.1:3080）· DSH_RPC_COOKIE_SECRET（看板/RPC 鉴权要它）
      DSH_HOME · ROUTER_HOME · ROUTER_OPS_FILE · ROUTER_STATE_FILE · ROUTER_LOG_DIR
      ROUTER_LEDGER_FILE（可选的卡账本，只读；读不到 ⇒ 陈旧账一条都不销）
      ROUTER_BOARD_HEADERS（看板端点要额外请求头时给一个 JSON 对象串）
      ROUTER_CONFIG_FILE（配置文件，缺省 <home>/router-config.json）

阈值一律可配（**env > 配置文件 > 缺省**，见 lib/config.mjs）：
      brief   ROUTER_BRIEF_ASK_MAX · ROUTER_FAILED_STATUSES · ROUTER_REVIEW_STATUSES
              ROUTER_FAILED_Q_PATTERNS · ROUTER_FAILED_OPTION_SETS
      愿景     ROUTER_VISION_DIR · ROUTER_PRIORITY_FILE · ROUTER_PRIORITY_KEY · ROUTER_GAP_TOP
              ROUTER_GAP_TEXT_CHARS · ROUTER_GAP_W_ASKC / _INFLIGHT / _ACTIVITY / _ASKA / _PRIORITY
              ROUTER_GAP_ACTIVITY_CAP_DAYS`;

const HANDLERS = { status: cmdStatus, brief: cmdBrief, 'card-show': cmdCardShow, say: cmdSay, digest: cmdDigest, reset: cmdReset, wake: cmdWake };

export async function main(argv) {
  const verb = argv.find((a) => !a.startsWith('-'));
  const rest = argv.filter((a) => a !== verb);
  if (!verb || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${verb && VERB_USAGE[verb] ? `${VERB_USAGE[verb]}\n\n` : ''}${USAGE}\n`);
    // 显式要 help ⇒ 0（与全生态一致：`--help` 是成功）；什么都没给 ⇒ 2（缺动词是错）。
    const wantsHelp = argv.includes('--help') || argv.includes('-h');
    return wantsHelp ? 0 : 2;
  }
  if (!VERBS.includes(verb)) { process.stderr.write(`❌ 未知动词 "${verb}"。白名单：${VERBS.join(' / ')}\n`); return 2; }
  // 🔴 参数白名单：未知 flag ⇒ rc=2，且在**任何副作用之前**就拒（写动词带 --apply 也一样拦）
  const scan = scanFlags(verb, rest);
  if (scan.unknown.length) { process.stderr.write(`${renderUnknownFlags(verb, scan.unknown, scan.allowed)}\n`); return 2; }
  try { return await HANDLERS[verb](rest, {}); } catch (e) {
    process.stderr.write(`✗ ${verb} 失败：${e?.message ?? e}\n`);
    return 1;
  }
}

function isDirectRun() {
  try {
    const self = fileURLToPath(import.meta.url);
    const entry = process.argv[1];
    if (!entry) return false;
    return fs.realpathSync(entry).toLowerCase() === fs.realpathSync(self).toLowerCase();
  } catch { return false; }
}

if (isDirectRun()) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((e) => { process.stderr.write(`[router-act] 崩了：${e?.stack ?? e}\n`); process.exitCode = 1; });
}

export default {
  VERSION, USAGE, VERBS, main, fetchBoard, aggregate, readSlots, renderResume,
  openAttentions, readAttentions, readLedgerCardStatus, splitStaleAttentions, staleNoteOf,
  lineOfCardMap, pickFocus, renderStatus, renderJson, renderBrief, renderNeedsOwner,
  buildRow, parseRow, renderSlotBlock, refreshResumeHeadSlots, buildAutoDigestRows, AUTO_STATUS_WORD,
};

// 愿景缺口与「操作者优先级」都在 lib/vision-gaps.mjs；这里**再导出一次**，让调用方只有一个入口
// （纯函数在那边，阈值解析在这条链上 —— 交付报告里那张「内部函数 → 开源实现」对照表按这条找）。
export { buildVisionGaps, renderVisionGaps, computeVisionGaps, readOwnerPriorityItems, ownerPriorityHit };
