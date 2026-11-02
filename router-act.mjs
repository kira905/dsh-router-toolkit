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
 * 前置条件：看板状态是插件端点（`GET /api/task-board/state`），**要 /api cookie** ——
 * 给 `DSH_RPC_COOKIE_SECRET`（32 字节 Base64）。不给 ⇒ 403，本件如实打印「状态取不到：<原因>」，
 * **绝不拿上次读数冒充**。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomInt } from 'node:crypto';
import { hostGet, hostRpc } from './lib/host-rpc.mjs';
import { resolveHome } from './lib/home.mjs';
import { say as sayViaLib, EXIT as SAY_EXIT } from './lib/say.mjs';
import { VERB_USAGE, scanFlags, renderUnknownFlags } from './lib/flags.mjs';

export const VERSION = '0.1.1';
const BASE = (process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080').replace(/\/+$/, '');
const HOME = resolveHome(process.env.ROUTER_HOME);
const OPS_FILE = process.env.ROUTER_OPS_FILE || path.join(HOME, 'router-ops.jsonl');
const STATE_FILE = process.env.ROUTER_STATE_FILE || path.join(HOME, 'router-state.json');
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
export async function fetchBoard(opts = {}) {
  const r = await hostGet(BASE, '/api/task-board/state', { timeoutMs: TIMEOUT_MS, ...opts });
  if (!r.ok) throw new Error(`看板 state 取不到：${r.error?.message ?? 'unknown'}（${BASE}/api/task-board/state）`);
  const top = r.body?.result?.value ?? r.body;  // 插件端点两种外壳都见过
  if (!top || !Array.isArray(top.tasks)) throw new Error('看板 state 结构异常：缺 tasks[]');
  return top;
}

/** 「待定」只认未答的（`answeredAt` 为空）—— 读状态文件，**不 grep 卡面文本猜**。 */
export function readAttentions() {
  const all = Array.isArray(readJson(STATE_FILE)?.attentions) ? readJson(STATE_FILE).attentions : [];
  return { open: all.filter((a) => a && !a.answeredAt), all, file: STATE_FILE };
}

/** 状态 → 车况桶（done 与其它状态不进车况）。 */
export function bucketOf(status) {
  return ({ running: 'run', todo: 'todo', backlog: 'todo', review: 'review', failed: 'failed' })[String(status ?? '')] ?? null;
}

/** 按线聚合（卡没写 line ⇒ 「(未归线)」）。 */
export function aggregate(tasks) {
  const rows = new Map();
  for (const t of Array.isArray(tasks) ? tasks : []) {
    const line = norm(t?.line) || '(未归线)';
    const r = rows.get(line) ?? { line, run: 0, todo: 0, review: 0, failed: 0, done: 0, cards: 0, lastAt: 0 };
    r.cards += 1;
    const b = bucketOf(t?.status);
    if (b) r[b] += 1;
    if (String(t?.status) === 'done') r.done += 1;
    r.lastAt = Math.max(r.lastAt, Number(t?.updatedAt ?? 0));
    rows.set(line, r);
  }
  return [...rows.values()];
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
  L.push('─'.repeat(48), !attn.open.length ? '待定 0 件' : `待定 ${attn.open.length} 件（未答）`);
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

/** 「先看哪条」：有卡在等拍板 → 有失败 → 等验收 → 在跑；同档取等得最久的那条。 */
export function pickFocus(rows, open) {
  const active = rows.filter((r) => activeCount(r) > 0);
  if (!active.length) return null;
  const why = (r) => (r.failed > 0 ? `${r.failed} 张失败卡` : r.review > 0 ? `${r.review} 张等验收` : r.run > 0 ? `${r.run} 张在跑` : `只有 ${r.todo} 张排队`);
  const cands = active.map((r) => ({ line: r.line, lastAt: r.lastAt, tier: open.some((a) => norm(a?.line) === r.line) ? 0 : r.failed > 0 ? 1 : r.review > 0 ? 2 : r.run > 0 ? 3 : 4, why: why(r) }));
  cands.sort((a, b) => (a.tier - b.tier) || (a.lastAt - b.lastAt));
  return cands[0].tier === 0 ? { ...cands[0], why: '在等拍板' } : cands[0];
}

/** 三行摘要（硬上限 3 行）。 */
export function renderBrief(board, rows, attn) {
  const t = sumOf(rows.filter((r) => activeCount(r) > 0));
  const focus = pickFocus(rows, attn.open);
  const titleById = new Map((board?.tasks ?? []).map((x) => [String(x?.id ?? ''), String(x?.title ?? '')]));
  const head = attn.open.slice(0, 2).map((a) => clipW(titleById.get(String(a?.cardId ?? '')) || norm(a?.question), 34));
  return [
    `车况 ${rows.filter((r) => activeCount(r) > 0).length} 线有活 · 跑${t.run} 待${t.todo} 卡${t.review} 败${t.failed} ｜ 待定 ${attn.open.length} 件`,
    focus ? `先看 ${clipW(focus.line, 28)}（${focus.why}，${ago(focus.lastAt)}）` : '先看 — 没有在途活',
    attn.open.length ? `要你定 ${head.join(' ② ')}${attn.open.length > 2 ? `（+${attn.open.length - 2} 件）` : ''}`.slice(0, 140) : '要你定 0 件',
  ].join('\n');
}

// ── 结论档（digest / reset 的落点）────────────────────────────────────────
const logPath = (date) => path.join(LOG_DIR, `router-${String(date).slice(0, 7).replace('-', '')}.md`);
const logHeader = (ym) => [
  `# Router 结论档 · ${ym}`, '',
  '> **这份档只放结论**：哪条线 + 一句结论 + 指向卡/报告的链接。**过程一律不进**（过程留在子线自己那边）。',
  '> 写入口：`router-act.mjs digest --line <线名> --text "<一句结论>" [--ref <…>] --apply`',
  '> 幂等键 = **线名 + 日期** ⇒ 同一天同一条线重复收口不会重复追加（同日改结论 = 手工改档）。',
  `> 槽位口径：每条线 1 行、上限 ${SLOT_MAX} 行 × 每行 ≤${SLOT_CHARS} 字；那几行只是「上次收口的结论」，**不是活数据**。`,
  '> `reset` 把当前槽位 + 待定事项写成一段「接续头」追加到本档末尾；**清空上下文留给人按**。', '', '---', '', '',
].join('\n');

/** 一行结论的形状：`- 日期｜线名｜一句结论｜ref：…`（ref 可省）。 */
export const buildRow = ({ date, line, text, ref }) => `- ${date}｜${line}｜${norm(text)}${ref ? `｜ref：${ref}` : ''}`;

/** 解析一行结论（宽容：ref 段可省；结论里自带全角竖线也不拆坏）。 */
export function parseRow(raw) {
  const m = String(raw ?? '').match(/^-\s+(\d{4}-\d{2}-\d{2})\s*｜/);
  if (!m) return null;
  const parts = String(raw).slice(m[0].length).split('｜');
  const line = norm(parts.shift() ?? '');
  if (!line) return null;
  const rest = parts.join('｜');
  const rm = rest.match(/^([\s\S]*?)\s*｜\s*ref：\s*([\s\S]*)$/);
  return { date: m[1], line, text: norm(rm ? rm[1] : rest), ref: rm ? norm(rm[2]) : '' };
}
const readRows = (file) => { try { return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n').map(parseRow).filter(Boolean); } catch { return []; } };

/** 当前槽位 = 每条线最新那一行，按日期降序取前 max 条（跨月也拼得出来）。 */
export function readSlots(max = SLOT_MAX, dir = LOG_DIR) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^router-\d{6}\.md$/.test(f)).sort().reverse(); } catch { return []; }
  const latest = new Map();
  for (const f of files) for (const r of readRows(path.join(dir, f))) {
    const cur = latest.get(r.line);
    if (!cur || r.date > cur.date) latest.set(r.line, r);
  }
  return [...latest.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).slice(0, Math.max(1, max));
}
/** 「接续头」：下次开局读它就够（槽位 + 待定 + 怎么继续）。 */
export function renderResume({ slots = [], attnOpen = [], at = Date.now(), doc = '' } = {}) {
  const L = [`### 接续头 · ${stamp(at)}（上次收口时间）`, '', `#### 一行槽位（每线 1 行 · 上限 ${SLOT_MAX} · 每行 ≤${SLOT_CHARS} 字 · 只是"上次收口的结论"，不是活数据）`];
  if (!slots.length) L.push('· （结论档里还没有任何收口；先跑 digest 记一条）');
  // ⚠️ 槽位行故意用「·」开头：「- 日期｜线名｜…」是结论行的形状，照抄会被下次 readSlots 读回来（自身污染）
  for (const r of slots) L.push(`· ${r.line}｜${r.text}｜${r.date}${r.ref ? `｜ref：${r.ref}` : ''}${widthOf(r.text) > SLOT_CHARS ? ' ⚠️超长' : ''}`);
  if (slots.length >= SLOT_MAX) L.push(`· （槽位已满 ${SLOT_MAX} 行：要加新线，先收口最旧那条）`);
  L.push('', '#### 待定的事（只列未答的）');
  if (!attnOpen.length) L.push('1. （没有未答的拍板请求）');
  attnOpen.slice(0, 20).forEach((a, i) => L.push(`${i + 1}. [卡 ${String(a?.cardId ?? '?').slice(0, 8)}] ${norm(a?.question).replace(/\s+/g, ' ')}${Array.isArray(a?.options) && a.options.length ? ` → 选 ${a.options.join('/')}` : ''}`));
  if (attnOpen.length > 20) L.push(`（还有 ${attnOpen.length - 20} 件，跑 status 看全）`);
  L.push('', '#### 怎么继续（三句）',
    '- 车况**现跑**：`node router-act.mjs brief`（别拿上面槽位当现状）',
    `- 结论**现读**：${doc ? doc.replace(/\\/g, '/') : '<log-dir>/router-<YYYYMM>.md'}`,
    '- 清空上下文**由人按**；本件不自动清、不删会话、不归档。');
  return L.join('\n');
}

// ── 动词 ───────────────────────────────────────────────────────────────────
const usageError = (msg) => { process.stderr.write(`❌ ${msg}\n`); return 2; };
const asJson = (argv) => argv.includes('--json');
const intOf = (argv) => (f, d) => Number(argvVal(argv)(f, d)) || d;

async function cmdStatus(argv, opts) {
  const maxLines = intOf(argv)('--max-lines', 20);
  const board = await fetchBoard(opts);
  const attn = readAttentions();
  const rows = aggregate(board.tasks);
  if (!asJson(argv)) { process.stdout.write(`${renderStatus(board, rows, attn, maxLines)}\n`); return 0; }
  process.stdout.write(`${JSON.stringify({
    at: new Date().toISOString(), version: VERSION, totals: { cards: board.tasks.length, ...sumOf(rows) },
    lines: sortedActive(rows).map((r) => ({ ...r, lastAtISO: r.lastAt ? new Date(r.lastAt).toISOString() : null })),
    attention: { open: attn.open.length, total: attn.all.length },
  }, null, 2)}\n`);
  return 0;
}

async function cmdBrief(argv, opts) {
  const board = await fetchBoard(opts);
  const attn = readAttentions();
  const rows = aggregate(board.tasks);
  const text = renderBrief(board, rows, attn);
  process.stdout.write(asJson(argv) ? `${JSON.stringify({ at: new Date().toISOString(), version: VERSION, brief: text.split('\n') }, null, 2)}\n` : `${text}\n`);
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

async function cmdDigest(argv) {
  const val = argvVal(argv);
  const LINE = norm(val('--line', ''));
  const RAW_TEXT = String(val('--text', '') ?? '');
  const DATE = norm(val('--date', '')) || ymd();
  const APPLY = argv.includes('--apply');
  const DECIDED = norm(val('--decided-by', 'router')).toLowerCase();

  if (!LINE) return usageError('缺线名（--line <线名>）—— 一条线一行');
  if (widthOf(LINE) > 60) return usageError(`线名太长（${widthOf(LINE)} > 60）：写线名，别把整句塞进来`);
  const TEXT = norm(RAW_TEXT.replace(/\r\n/g, '\n').split('\n')[0]);
  const extraLines = RAW_TEXT.replace(/\r\n/g, '\n').split('\n').slice(1).filter((l) => l.trim()).length;
  if (!TEXT) return usageError('缺结论（--text "一句结论"）—— 空结论不收');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE) || Number.isNaN(Date.parse(`${DATE}T00:00:00`))) return usageError(`--date 要 YYYY-MM-DD，收到 "${DATE}"`);
  if (!DECIDED_BY.includes(DECIDED)) return usageError(`--decided-by 只支持 ${DECIDED_BY.join('|')}；收到 "${DECIDED}"`);

  const ref = norm(val('--ref', '')).replace(/\\/g, '/');   // 档是 markdown：反斜杠会被吃掉
  const row = buildRow({ date: DATE, line: LINE, text: TEXT, ref });
  const doc = logPath(DATE);
  const existed = readRows(doc).some((r) => r.date === DATE && r.line === LINE);

  let wrote = false, err = null;
  if (APPLY && !existed) try {
    if (!fs.existsSync(doc)) { fs.mkdirSync(path.dirname(doc), { recursive: true }); fs.writeFileSync(doc, logHeader(DATE.slice(0, 7).replace('-', '')), 'utf8'); }
    fs.appendFileSync(doc, `${row}\n`, 'utf8');
    wrote = true;
  } catch (e) { err = e?.message ?? String(e); }
  if (!asJson(argv)) {
    process.stdout.write(`[${APPLY ? 'apply' : 'dry-run'}] digest · ${LINE} · ${DATE}\n  结论档：${doc}\n`);
    process.stdout.write(existed ? '  幂等：同一天同一条线已有 ⇒ 跳过（不重复追加；同日改结论请手工改档）\n' : `  这一行：${row}\n`);
    if (extraLines) process.stdout.write(`  ⚠️ --text 有多行，只收第一行（其余 ${extraLines} 行没进档：过程不进结论档）\n`);
    if (!APPLY) process.stdout.write('  （未写；加 --apply 才追加）\n');
    if (err) process.stderr.write(`✗ 写结论档失败：${err}\n`);
  }
  const w = appendOps(opsRecord({ verb: 'digest', target: LINE, sid: null, ok: !err, dryRun: !APPLY, decidedBy: DECIDED, extra: { date: DATE, doc, ref: ref || null, chars: TEXT.length, wrote, skipped: existed ? 'duplicate' : null, error: err } }));
  if (asJson(argv)) process.stdout.write(`${JSON.stringify({ verb: 'digest', line: LINE, date: DATE, doc, row, ok: !err, dryRun: !APPLY, wrote, skipped: existed ? 'duplicate' : null, error: err, ops: w }, null, 2)}\n`);
  else process.stdout.write(`  流水：${w.ok ? `+1 行 → ${w.file}` : `✗ 写失败（${w.error}）`}\n`);
  return err || !w.ok ? 1 : 0;
}

async function cmdReset(argv) {
  const DECIDED = norm(argvVal(argv)('--decided-by', 'router')).toLowerCase();
  const APPLY = argv.includes('--apply');
  if (!DECIDED_BY.includes(DECIDED)) return usageError(`--decided-by 只支持 ${DECIDED_BY.join('|')}；收到 "${DECIDED}"`);

  const at = Date.now();
  const slots = readSlots(SLOT_MAX);
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
    process.stdout.write(`[${APPLY ? 'apply' : 'dry-run'}] reset · 槽位 ${slots.length} 行 · 待定 ${attn.open.length} 件\n  结论档：${doc}\n`);
    process.stdout.write(APPLY ? (wrote ? '  已把接续头追加到档尾。\n' : `  ✗ 写档失败：${err}\n`) : '  （dry-run：没写；加 --apply 才追加）\n');
    process.stdout.write(`  ── 接续头（直接贴给下一次的自己）──\n${head}\n  ──\n`);
    process.stdout.write('  🔴 没有清空任何东西：不调 compact、不删会话、不归档。清空由人在界面里按。\n');
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

  node router-act.mjs brief     [--json]                        只读：三行摘要
  node router-act.mjs status    [--json] [--max-lines N]         只读：一屏车况
  node router-act.mjs card-show --card <cardId> [--max-lines N]  只读：一张卡的一句话
  node router-act.mjs say       --to <线名|会话id> --text "<一句话>" [--apply] [选项]
  node router-act.mjs digest    --line <线名> --text "<一句结论>" [--ref <…>] [--date YYYY-MM-DD] [--apply]
  node router-act.mjs reset     [--apply] [--json]
  node router-act.mjs wake      （stub：本骨架不含 thread 唤醒面）

  say 是**唯一**能打扰别的会话的动词；投递腿只有 lib/say.mjs 一条（两闸：不投自己 / 不投已归档）
  digest / reset 只写结论档；reset **不清空任何东西**（不 compact / 不删会话 / 不归档）
  --json 机器可读 · --max-lines 人类可读的硬上限（status 默认 20；card-show 上限 40）
  🔴 参数是**白名单**：不认识的 flag ⇒ rc=2 + 打印该动词用法，**一个字节都不写盘**（写动词带 --apply 也拦）

say 选项：--cmd ${CMD_WORDS.join('|')} · --prio ${PRIO_WORDS.join('|')} · --id/--due/--ref/--reply
          --raw（原样投、不套信封）· --mode queue|steer · --decided-by ${DECIDED_BY.join('|')}
          --receipt "<对方回话原文>"（不投递，只记账）· --allow-self / --allow-handoff（自测用）

环境：DSH_WEB_URL（默认 http://127.0.0.1:3080）· DSH_RPC_COOKIE_SECRET（看板/RPC 鉴权要它）
      DSH_HOME · ROUTER_HOME · ROUTER_OPS_FILE · ROUTER_STATE_FILE · ROUTER_LOG_DIR`;

const HANDLERS = { status: cmdStatus, brief: cmdBrief, 'card-show': cmdCardShow, say: cmdSay, digest: cmdDigest, reset: cmdReset, wake: cmdWake };

export async function main(argv) {
  const verb = argv.find((a) => !a.startsWith('-'));
  const rest = argv.filter((a) => a !== verb);
  if (!verb || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${verb && VERB_USAGE[verb] ? `${VERB_USAGE[verb]}\n\n` : ''}${USAGE}\n`);
    return verb ? 0 : 2;
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

export default { VERSION, USAGE, VERBS, main, fetchBoard, aggregate, readSlots, renderResume };
