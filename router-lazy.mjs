#!/usr/bin/env node
/**
 * router-lazy.mjs —— 「这条主线会话是不是停下没动」判据（**只读**）· 2026-11-03
 *
 * 【这个器具干什么】一个「只下命令、不执行」的统筹会话，需要判断「哪条主线该被推一下」。
 *   它以前只能靠 `router-act brief` 数停留天数 —— 判不出「谁该被催、催什么」。本器具把三层
 *   架构口径 §4-A2 的判据做成一条可现跑的命令：扫一圈会话 + 看板 + 接力台账，输出「该催谁」
 *   清单（人读一屏 / `--json` 机读）。
 *
 * 【判据（同时满足）】一条主线会话判「停下没动」= ①它现在没在跑（`running === false`）**且** ②下列任一：
 *   a. 该线有 **todo** 卡（看板 `tasks[].line` 命中该线，`status === 'todo'`）⇒ 档 `lazy`
 *   b. 该线只有 **backlog** 卡（无 todo）⇒ 档 `backlog`（"待规划"不是"待办"，**别按催办处理**）
 *   c. 该线在接力台账里有**未完成的 `pendingHandoff`** ⇒ 档 `lazy`
 *   d. 该会话标题带 **【待续】** ⇒ 档 `lazy`（标题自己标着"还有活没闭环"）
 *   e. 该线最近活动距今 > `--idle-hours`（默认 3）**且** 该线有 running/review 卡 ⇒ 档 `stuck`
 *      （"卡在跑/待验收但会话死了"这种畸形，单列）
 *   排除：标题状态令牌里含 **【已交接】** 的会话不进 `lazy`，单列 `handoff`（投话会被"已交接闸"挡掉）。
 *   排期例外（2026-11-05 补）：todo 卡**带未来排期**（`schedule.enabled === true` 且
 *   `Number(schedule.nextRunAt) > now`）不算"没动的待办" —— 它在等窗口，催它 = 白打扰，记进
 *   `cards.scheduledTodo`；排期**已过点**（`nextRunAt <= now`，或 enabled 但 nextRunAt 缺失/非数）
 *   仍算 `todo`，理由里额外写明「排期已过点」（那是更该催的信号）。
 *   ⚠️ 只放过"未来排期"这一种：backlog / handoff / stuck / 标题【待续】四个桶一字未变。
 *
 * 【为什么这么难】会话表里没有"我是哪条线"的字段 ⇒ 线名只能用两路证据推：
 *   ① **接力台账**（`chains[].mainline` + `newSessionId`，最权威 —— 接力时人已经写过线名了）；
 *   ② **标题令牌**（`【运行】/【待续】/【已交接】/【完成】/【续】` 之后那段，与看板 `line` 精确或分词比对）。
 *   两条都不命中的线**不假装它在**：进 `orphanLines`（有在途卡但无在册会话），只报不催。
 *   🔴 「线名从哪来」可注入：`analyze({ resolveLine })` 给一个函数就整套替换（外部索引 / 别的台账 /
 *      甚至常量都行）。默认那两路只是本件的缺省实现，不是硬绑定。
 *
 * 【红线】只读：不写看板、不改卡、不投话、不发消息、不动交接台账。
 *
 * 【取数】会话 = `session.list`（走本仓 `lib/host-rpc.mjs` 的 `hostRpc`）；看板 =
 *   `GET <base>/api/task-board/state`（有些看板的 state 端点按作用域过滤 ⇒ 额外请求头整个放进
 *   `ROUTER_BOARD_HEADERS` 的 JSON 串里；本件**不猜任何私有头名**，缺省一个头都不加）；
 *   台账 = `<home>/butler-relay.json`（`BUTLER_DSH_HOME > DSH_HOME > ~/.dsh`，字段形状照接力脚本
 *   的源码写，不猜）。缺省地址 `http://localhost:3080`，`--base-url` / `DSH_WEB_URL` 可改。
 *
 * 【fail-closed】取不到会话表 / 看板 / 台账（解析失败）⇒ **rc=3 且 stdout 一个字都不说"没人在偷懒"**。
 *   这是本器具最容易犯的错：把"取数失败"降级成"无事发生"= 假绿。宁可报错，不许装作太平。
 *
 * 【自测】`--selftest` 用夹具跑（`ROUTER_LAZY_SESSIONS_FILE` / `ROUTER_LAZY_BOARD_FILE` /
 *   `ROUTER_LAZY_LEDGER_FILE` / `ROUTER_LAZY_OPS_FILE` 注入口子），**不连生产、不碰网络**。
 *
 * 用法：node router-lazy.mjs [--json] [--top N] [--idle-hours N] [--base-url URL] [--quiet] [--selftest] [--help]
 * 退出码：0 正常（有没有候选都 0）· 2 用法错 · 3 取数失败（fail-closed）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hostRpc } from './lib/host-rpc.mjs';

// ── 常量 / 口径 ──────────────────────────────────────────────────────────────
/** 标题状态令牌（会话标题三态 + 接棒标记；`续` 是 relay 生成的前缀，不是状态）。 */
export const STATE_TOKENS = ['运行', '待续', '已交接', '完成', '续'];
/** 缺省 idle 阈值（小时）—— 口径档 §4-A2 给的是 `N`，本器具默认 3，`--idle-hours` 可改。 */
export const DEFAULT_IDLE_HOURS = 3;
/** 缺省输出条数。 */
export const DEFAULT_TOP = 5;
/** 只看这些卡状态（其余 status 与"该不该催"无关；done/failed 归档卡不进）。 */
export const RELEVANT_STATUSES = ['todo', 'backlog', 'review', 'running', 'failed'];
/** 档位紧急度权重（越大越该催）。 */
export const BUCKET_PRIORITY = { stuck: 100, lazy: 50, backlog: 20, handoff: 10 };

const HELP = `「这条主线会话是不是停下没动」判据（只读）

用法：node router-lazy.mjs [选项]

  --json             机读输出（JSON；数组永远是全量，不受 --top 影响）
  --top N            人读输出前 N 条（默认 ${DEFAULT_TOP}）
  --idle-hours N     判 stuck 的"多久没动"阈值，小时（默认 ${DEFAULT_IDLE_HOURS}）
  --base-url URL     DSH 地址（默认 http://localhost:3080）
  --quiet            没有候选时零输出（rc 仍为 0）；有候选照常打印
  --selftest         跑夹具自测（不连生产、不碰网络）
  --help, -h         本帮助

判据（同时满足）：① 会话 running === false；② 下列任一成立
  a. 该线有 todo 卡          ⇒ 档 lazy（催它去办）
  b. 该线只有 backlog 卡      ⇒ 档 backlog（"待规划"不是"待办"，别催跑）
  c. 接力台账有未完成 pendingHandoff ⇒ 档 lazy（交接没闭环）
  d. 标题带【待续】          ⇒ 档 lazy（标题自己标着"还有活没闭环"）
  e. 会话闲置 > N 小时 且 该线有 running/review 卡 ⇒ 档 stuck（卡在跑/待验收，会话却死了）
排除：标题状态令牌含【已交接】⇒ 档 handoff（投话会被已交接闸挡掉，只能起新棒或改投接手会话）

输出（人读）：<线名>｜<档>｜<理由>｜今日已催 N 次｜<建议动作>｜<sid 前 8 位>
输出（--json）：{ ok, items[{line,sessionId,title,buckets,reasons,suggest,idleHours,cards,nudgedToday,...}], orphanLines, sources }

今日已催（2026-11-05 补）：读 <home>/router-ops.jsonl（只读）数**本地当天**真投的 say/wake，按线汇总。
  · 只认 verb=say|wake 且 ok=true 且 dryRun!==true（演练没投不算）；
  · 🔴 流水不在 / 读失败 / 行坏 ⇒ 全 0，**不报错不阻断**（辅助信息，不是判据本体）；
  · N=0 时人读不显示该列；同一线今日已催 3 次仍没动 = 该上报给操作者，别催第 4 次。

取数：session.list（rpc）· GET /api/task-board/state（额外头走 ROUTER_BOARD_HEADERS）
      <home>/butler-relay.json · <home>/router-ops.jsonl
自测注入口子：ROUTER_LAZY_SESSIONS_FILE / ROUTER_LAZY_BOARD_FILE / ROUTER_LAZY_LEDGER_FILE / ROUTER_LAZY_OPS_FILE

退出码：0 正常（有没有候选都 0）· 2 用法错 · 3 取数失败（fail-closed，绝不当"没人偷懒"）`;

// ── 小工具 ──────────────────────────────────────────────────────────────────
const HOUR = 3600 * 1000;
/** 归一化：去掉空白与常见分隔符，用于线名比对（中文不切词）。 */
export const normName = (s) => String(s ?? '').replace(/[\s·・\-—_（）()【】\[\]]/g, '');
/** 线名分词：按空白 / 中点 / 括号切，保留长度 ≥2 的段（"V3.1.0"、"赛博房间"都算独特段）。 */
export const lineTokens = (s) => String(s ?? '').split(/[\s·・（）()【】\[\],，、]+/).map((x) => x.trim()).filter((x) => x.length >= 2);

/**
 * 拆标题的前导状态令牌 + 余下正文。
 * `【运行】【续】示例主线交接与 router 盘点` ⇒ `{ tokens:['运行','续'], rest:'示例主线交接与 router 盘点' }`
 * 认不出的括号（如卡会话的 `【示例线·卡名】`）**不当令牌**，原样留在 rest 里 —— 这是"主线会话 vs 卡会话"的判据。
 */
export function parseTitle(title) {
  let rest = String(title ?? '').trim();
  const tokens = [];
  for (;;) {
    const m = rest.match(/^【([^】]{1,8})】/);
    if (!m || !STATE_TOKENS.includes(m[1])) break;
    tokens.push(m[1]);
    rest = rest.slice(m[0].length).trim();
  }
  return { tokens, rest };
}

/** 是不是"主线会话"形状：有状态令牌，且令牌之后不是又一个括号（卡会话是 `【线·卡名】…`）。 */
export function looksMainline(parsed) {
  return parsed.tokens.length > 0 && !parsed.rest.startsWith('【');
}

/** 从 session.list 项取标题（三态归一化，与看板侧会话读数同口径）。 */
export function pickTitle(s) {
  const direct = s?.title;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const projected = s?.projections?.values?.title;
  if (typeof projected === 'string' && projected.length > 0) return projected;
  return '';
}

/** 时间戳归一化为毫秒数；拿不到 / 不是有限数 ⇒ null（**不猜**）。 */
export function pickUpdated(s) {
  for (const v of [s?.updatedAt, s?.lastActivityAt, s?.updated]) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/** 理由里的时间说法：拿到就给一位小数，拿不到就说"未知"，绝不写 0.0 小时。 */
export function idleText(idleHours) {
  return Number.isFinite(idleHours) ? `${idleHours.toFixed(1)} 小时` : '未知（时间戳缺失）';
}

// ── 取数（全部 fail-closed：拿不到就是 ok:false，不退化成"空数据"） ────────────
function readJsonFile(file, label) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (e) {
    return { ok: false, reason: `${label} 夹具读取失败：${String(e?.message ?? e)}（${file}）` };
  }
}

/**
 * 会话表。命中注入夹具 ⇒ 读文件；否则走 hostRpcJson(session.list)。
 * 返回 `{ ok, items, source }` 或 `{ ok:false, reason }`；形状识别失败也算失败（字段名变更不许静默成空表）。
 */
export async function loadSessions({ env, baseUrl, fetchImpl }) {
  const fixture = env.ROUTER_LAZY_SESSIONS_FILE;
  let json;
  let source;
  if (fixture) {
    const r = readJsonFile(fixture, '会话表');
    if (!r.ok) return r;
    json = r.value;
    source = `fixture:${fixture}`;
  } else {
    let r;
    try {
      r = await hostRpc(baseUrl, 'session.list', {}, { timeoutMs: 20_000, fetchImpl });
    } catch (e) {
      return { ok: false, reason: `session.list 调用失败：${String(e?.message ?? e)}` };
    }
    if (!r?.ok) {
      const err = r?.error;
      return { ok: false, reason: `session.list 返回错误：${`${err?.code ?? ''} ${err?.message ?? ''}`.trim()}` };
    }
    json = r.value;
    source = 'rpc';
  }
  const items = json?.result?.value?.items ?? json?.items ?? (Array.isArray(json) ? json : null);
  if (!Array.isArray(items)) {
    return { ok: false, reason: `会话表响应形状不可识别（无 result.value.items / items 数组）：${JSON.stringify(json ?? null)?.slice(0, 160)}` };
  }
  if (items.length > 0 && !items.some((i) => typeof i?.sessionId === 'string' && i.sessionId)) {
    return { ok: false, reason: `会话表 ${items.length} 项但无一项带 sessionId（字段名疑似变更）` };
  }
  return { ok: true, items, source };
}

/**
 * 看板端点要自定义请求头时（有些看板的 state 端点按作用域过滤），把整份键值放进
 * `ROUTER_BOARD_HEADERS`（JSON 对象串）。缺省 = 不加任何头（**本件不猜任何私有头名**）。
 */
export function boardHeaders(env = process.env) {
  const raw = String(env.ROUTER_BOARD_HEADERS ?? '').trim();
  if (!raw) return {};
  let j;
  try { j = JSON.parse(raw); } catch { return {}; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return {};
  const out = {};
  for (const [k, v] of Object.entries(j)) if (k && v !== null && v !== undefined) out[String(k)] = String(v);
  return out;
}

/** 看板 state（只读；额外头靠 `ROUTER_BOARD_HEADERS` 注入，缺省不加）。 */
export async function loadBoard({ env, baseUrl, fetchImpl }) {
  const fixture = env.ROUTER_LAZY_BOARD_FILE;
  let json;
  let source;
  if (fixture) {
    const r = readJsonFile(fixture, '看板');
    if (!r.ok) return r;
    json = r.value;
    source = `fixture:${fixture}`;
  } else {
    let res;
    try {
      res = await fetchImpl(`${baseUrl}/api/task-board/state`, {
        headers: { origin: baseUrl, ...boardHeaders(env) },
      });
    } catch (e) {
      return { ok: false, reason: `看板取数失败（${baseUrl}/api/task-board/state）：${String(e?.message ?? e)}` };
    }
    if (!res?.ok) return { ok: false, reason: `看板取数失败：HTTP ${res?.status ?? '?'}（${baseUrl}/api/task-board/state）` };
    try {
      json = await res.json();
    } catch (e) {
      return { ok: false, reason: `看板响应不是 JSON：${String(e?.message ?? e)}` };
    }
    source = 'rpc';
  }
  const tasks = Array.isArray(json) ? json : json?.tasks;
  if (!Array.isArray(tasks)) {
    return { ok: false, reason: `看板响应形状不可识别（无 tasks 数组）：${JSON.stringify(json ?? null)?.slice(0, 160)}` };
  }
  return { ok: true, tasks, source, revision: json?.revision ?? null };
}

/** 接力台账（`<home>/butler-relay.json`；`pendingHandoff` 是**单对象**）。 */
export function resolveDshHome(env) {
  const home = env.BUTLER_DSH_HOME || env.DSH_HOME;
  return home && String(home).trim() ? String(home) : path.join(os.homedir(), '.dsh');
}

export function ledgerFilePath(env) {
  return env.ROUTER_LAZY_LEDGER_FILE || path.join(resolveDshHome(env), 'butler-relay.json');
}

export function loadLedger({ env }) {
  const file = ledgerFilePath(env);
  if (!fs.existsSync(file)) {
    // 文件不在 = 从没跑过接力 ⇒ 没有 pendingHandoff。这不是取数失败，但也别当成"确认没有"的强判据。
    return { ok: true, exists: false, file, ledger: { pendingHandoff: null, chains: [] } };
  }
  const r = readJsonFile(file, '接力台账');
  if (!r.ok) return { ok: false, file, reason: `${r.reason}（解析失败 ⇒ 不敢判 pendingHandoff）` };
  const j = r.value ?? {};
  const chains = Array.isArray(j.chains) ? j.chains : [];
  const pendingHandoff = j.pendingHandoff && typeof j.pendingHandoff === 'object' ? j.pendingHandoff : null;
  return { ok: true, exists: true, file, ledger: { ...j, chains, pendingHandoff } };
}

/** 催办流水文件（`router-act.mjs` 每次 say/wake 追加一行；本器具**只读**它数"今天催了几次"）。 */
function opsFilePath(env) {
  return env.ROUTER_LAZY_OPS_FILE || path.join(resolveDshHome(env), 'router-ops.jsonl');
}

/** 本地日期键（`2026-11-5`）—— 🔴 按本地切"当天"，不用 UTC（否则早上 8 点前的催会被算成昨天）。 */
function localDayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * 今日已催次数（2026-11-05 补）。
 *
 * 口径：读 `<home>\router-ops.jsonl`（只读）→ 只认 `verb` 为 `say`/`wake`、`ok === true`、
 *   **本地当天**、且**真投**（`dryRun !== true`）的记录 → 按会话计数。
 *   `dryRun === true` 的 ok 记录是"演练没真投"，算进次数会让"催了 3 次"变成虚数 ⇒ 明确排除。
 *   会话 id 解析三路：`sid`（完整）→ `target` 精确 → `target` 以 `session-` 开头的**唯一**前缀。
 *   线名映射不在这里做（要等 `analyze` 把会话表归成线）。
 *
 * 🔴 这是**辅助信息、不是判据本体**：文件不在 / 读失败 / 行坏 / 时间不可解析 ⇒ 一律当 0，
 *   **不报错、不阻断**（主判据照常出结果）。
 */
function loadNudges({ env, sessions, now = Date.now() }) {
  const today = localDayKey(now);
  const file = opsFilePath(env);
  const out = { file, today, exists: false, records: 0, counted: 0, counts: new Map() };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  out.exists = true;
  const ids = (sessions ?? []).map((s) => String(s?.sessionId ?? '')).filter(Boolean);
  const idSet = new Set(ids);
  const byPrefix = (t) => {
    const hit = ids.filter((id) => id.startsWith(t));
    return hit.length === 1 ? hit[0] : null;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; } // 坏行跳过（不阻断）
    out.records += 1;
    const verb = String(rec?.verb ?? '');
    if (verb !== 'say' && verb !== 'wake') continue;
    if (rec?.ok !== true) continue;
    if (rec?.dryRun === true) continue; // 演练没真投 ⇒ 不算催
    const at = typeof rec?.at === 'number' ? rec.at : Date.parse(String(rec?.at ?? ''));
    if (!Number.isFinite(at) || localDayKey(at) !== today) continue;
    const sid = String(rec?.sid ?? '').trim();
    const target = String(rec?.target ?? '').trim();
    let resolved = null;
    if (sid && idSet.has(sid)) resolved = sid;
    else if (target && idSet.has(target)) resolved = target;
    else if (target.startsWith('session-')) resolved = byPrefix(target);
    if (!resolved) continue;
    out.counts.set(resolved, (out.counts.get(resolved) ?? 0) + 1);
    out.counted += 1;
  }
  return out;
}

// ── 分析（纯函数：进出都是普通对象，夹具可喂） ──────────────────────────────
/**
 * 纯函数：给定会话 / 看板卡 / 台账，算出「该催谁」。
 *
 * @param {{sessions:Array, tasks:Array, ledger:{chains?:Array,pendingHandoff?:object|null}, idleHours?:number, now?:number}} input
 * @returns {{items:Array, orphanLines:Array, claimedLines:string[], stats:object}}
 */
export function analyze({ sessions, tasks, ledger, idleHours = DEFAULT_IDLE_HOURS, now = Date.now(), nudges = null, resolveLine: resolveLineHook = null }) {
  // 1) 看板：只留未归档 + 相关状态，按 line 精确聚合
  const cardsByLine = new Map();
  // 排期旁挂：line → { overdue, earliestFuture }（只用来写字，不进桶、不新增 bucket 名）
  const scheduleByLine = new Map();
  const blank = () => ({ todo: 0, backlog: 0, review: 0, running: 0, failed: 0, scheduledTodo: 0 });
  for (const t of tasks ?? []) {
    if (!t || t.archivedAt) continue;
    const status = String(t.status ?? '');
    if (!RELEVANT_STATUSES.includes(status)) continue;
    const line = String(t.line ?? '').trim();
    if (!line) continue; // 未归线的卡没有"线"可催，别硬塞
    if (!cardsByLine.has(line)) {
      cardsByLine.set(line, blank());
      scheduleByLine.set(line, { overdue: 0, earliestFuture: null });
    }
    // 🔴 排期口径（卡「偷懒判据补排期」）：等窗口的 todo 不是"没动"。
    //   ① 未来排期（enabled 且 nextRunAt > now）⇒ 记 scheduledTodo，**不计 todo**；
    //   ② 排期已过点（nextRunAt <= now，或 enabled 但 nextRunAt 缺失/非数）⇒ 仍算 todo，另记 overdue 供理由用。
    //   now 用 analyze() 的入参（夹具能注入），**不新起 Date.now()**。
    if (status === 'todo') {
      const sch = t.schedule ?? null;
      const enabled = sch?.enabled === true;
      const nextRunAt = Number(sch?.nextRunAt);
      const future = enabled && Number.isFinite(nextRunAt) && nextRunAt > now;
      if (future) {
        cardsByLine.get(line).scheduledTodo += 1;
        const slot = scheduleByLine.get(line);
        if (slot.earliestFuture === null || nextRunAt < slot.earliestFuture) slot.earliestFuture = nextRunAt;
        continue;
      }
      if (enabled) scheduleByLine.get(line).overdue += 1;
    }
    cardsByLine.get(line)[status] += 1;
  }
  // 线内确实还有卡：scheduledTodo 要算进去（否则"等窗口的线"会被当成空线）
  const sumCards = (c) => (c ? c.todo + c.backlog + c.review + c.running + c.failed + (c.scheduledTodo ?? 0) : 0);

  // 2) 接力台账：每线最新一棒 + 会话→线 索引
  const chains = Array.isArray(ledger?.chains) ? ledger.chains : [];
  const latestChainByLine = new Map();
  const chainLineBySession = new Map();
  for (const c of chains) {
    const mainline = String(c?.mainline ?? '').trim();
    if (!mainline) continue;
    const at = Number(c?.at) || 0;
    const prev = latestChainByLine.get(mainline);
    if (!prev || at >= Number(prev.at ?? 0)) latestChainByLine.set(mainline, c);
    for (const sid of [c?.sourceSessionId, c?.newSessionId]) {
      const s = String(sid ?? '').trim();
      if (!s) continue;
      const p = chainLineBySession.get(s);
      if (!p || at >= p.at) chainLineBySession.set(s, { mainline, at });
    }
  }
  const pendingHandoff = ledger?.pendingHandoff ?? null;
  const pendingBySession = new Map();
  if (pendingHandoff) {
    for (const sid of [pendingHandoff.sourceSessionId, pendingHandoff.newSessionId]) {
      const s = String(sid ?? '').trim();
      if (s) pendingBySession.set(s, pendingHandoff);
    }
  }

  // 3) 会话归一化 + 线名解析
  const boardLines = [...cardsByLine.keys()];
  const defaultResolveLine = (s) => {
    const parsed = parseTitle(pickTitle(s));
    const chained = chainLineBySession.get(s.sessionId);
    if (chained) return { line: chained.mainline, lineSource: 'relay', parsed, chainAt: chained.at };
    const rest = parsed.rest.trim();
    const nRest = normName(rest);
    if (!rest) return { line: '', lineSource: 'none', parsed, chainAt: null };
    const exact = boardLines.find((L) => normName(L) === nRest);
    if (exact) return { line: exact, lineSource: 'title-exact', parsed, chainAt: null };
    // 分词全包含（双向）：要求至少一个 ≥3 字的独特段，避免"大管家"这种泛词单独命中
    const toks = lineTokens(rest);
    const hit = boardLines.find((L) => {
      const lt = lineTokens(L);
      const nL = normName(L);
      const allIn = (a, b) => a.length > 0 && a.every((t) => b.includes(normName(t)));
      const distinctive = (a) => a.some((t) => normName(t).length >= 3);
      return (allIn(toks, nL) && distinctive(toks)) || (allIn(lt, nRest) && distinctive(lt));
    });
    if (hit) return { line: hit, lineSource: 'title-token', parsed, chainAt: null };
    return { line: rest, lineSource: 'title-rest', parsed, chainAt: null };
  };

  /**
   * 线名解析的注入点（2026-11-06 开源版新增）。
   * 给了 `resolveLine` 就把它的返回值按字段覆盖到默认结果上（只给 `line` 也行 ——
   * `lineSource` / `parsed` / `chainAt` 仍由默认实现给出）。`lineSource` 会原样出现在
   * `--json` 的每条 item 上，调用方由此知道这个名字是哪来的。
   */
  const resolveLine = (s) => {
    const base = defaultResolveLine(s);
    if (typeof resolveLineHook !== 'function') return base;
    let patch = null;
    try {
      patch = resolveLineHook(s, { ...base, lines: boardLines, helpers: { parseTitle, pickTitle, normName, lineTokens } });
    } catch {
      return base;   // 注入的解析器自己炸了 ⇒ 退回默认，不拖垮整轮
    }
    return patch && typeof patch === 'object' ? { ...base, ...patch } : base;
  };

  const candidates = [];
  const unknownRunning = [];
  for (const s of sessions ?? []) {
    const sid = String(s?.sessionId ?? '').trim();
    if (!sid) continue;
    const resolved = resolveLine(s);
    if (!looksMainline(resolved.parsed)) continue; // 卡会话（worker）不归统筹会话催
    if (typeof s.running !== 'boolean') { unknownRunning.push({ sessionId: sid, title: pickTitle(s) }); continue; }
    candidates.push({
      sessionId: sid,
      title: pickTitle(s),
      running: s.running,
      updated: pickUpdated(s),
      ...resolved,
    });
  }

  // 3b) 今日已催次数按线汇总（2026-11-05 补）：只统计**主线会话**上的催办，
  //     线级 = 该线下所有在册主线会话之和（催的可能是旧棒）。nudges 是 Map<sessionId, 次数>，缺省为 0。
  const lineNudge = new Map();
  if (nudges instanceof Map) {
    for (const c of candidates) {
      const n = nudges.get(c.sessionId) ?? 0;
      if (!n) continue;
      const key = c.line || '(未识别线名)';
      lineNudge.set(key, (lineNudge.get(key) ?? 0) + n);
    }
  }

  // 4) 每条线选"最新一棒"（真源：会话 updated；缺时间戳的用台账 at 兜底，仍缺则排最后）
  const byLine = new Map();
  const rank = (c) => c.updated ?? c.chainAt ?? 0;
  for (const c of candidates) {
    const key = c.line || '(未识别线名)';
    const prev = byLine.get(key);
    if (!prev || rank(c) >= rank(prev)) byLine.set(key, c);
  }

  // 5) 逐线判档
  const items = [];
  const claimedLines = new Set();
  for (const [line, c] of byLine) {
    const cards = cardsByLine.get(line) ?? {
      // 线名不一致时用分词模糊兜一次（会话线名与看板写法不一致是常态）
      ...fuzzyCards(line, cardsByLine),
    };
    const cardLine = cardsByLine.has(line) ? line : (fuzzyLineOf(line, cardsByLine) ?? null);
    if (cardLine) claimedLines.add(cardLine);
    const idle = c.updated ? (now - c.updated) / HOUR : null;
    const hasHandoffToken = c.parsed.tokens.includes('已交接');
    const hasPendingToken = c.parsed.tokens.includes('待续');
    const handoff = pendingBySession.get(c.sessionId) ?? null;
    const buckets = [];
    const reasons = [];
    const push = (b, why) => { if (!buckets.includes(b)) buckets.push(b); reasons.push(why); };

    if (c.running) continue; // 在跑 ⇒ 不算偷懒（判据 ①）
    if (hasHandoffToken) {
      // 已交接 + 线内没活 + 没有指向它的 pendingHandoff ⇒ 正常收工，不报（否则历史交接会刷屏）
      if (sumCards(cards) === 0 && !handoff) continue;
      push('handoff', '标题带【已交接】：这一棒已交出去，投话会被"已交接闸"挡掉');
      if (sumCards(cards) > 0) reasons.push(`线内还有 ${cards.todo} todo / ${cards.backlog} backlog / ${cards.review} review / ${cards.running} running 卡`);
    } else {
      // 排期旁挂（卡「偷懒判据补排期」）：只影响 todo 这一支，其它桶一字不动
      const schInfo = scheduleByLine.get(cardLine ?? line) ?? { overdue: 0, earliestFuture: null };
      const schAt = schInfo.earliestFuture !== null ? ` ${schedTimeText(schInfo.earliestFuture)}` : '';
      if (cards.todo > 0) {
        // 真 todo ⇒ 照旧判 lazy（同一句话，只往后补信息，不改档位）
        const overdue = schInfo.overdue > 0 ? `（其中 ${schInfo.overdue} 张排期已过点仍未跑）` : '';
        const schedTail = cards.scheduledTodo > 0 ? `，另 ${cards.scheduledTodo} 张已排期${schAt}（等窗口，不催）` : '';
        push('lazy', `线内有 ${cards.todo} 张 todo 卡（待办）没动${overdue}${schedTail}`);
      } else {
        // 没有真 todo、只剩"等窗口"的 ⇒ **不判 lazy**：只留一条非桶说明；若此外无其它桶，整条不进 items
        if (cards.scheduledTodo > 0) reasons.push(`${cards.scheduledTodo} 张 todo 卡已排期${schAt}（等窗口，不催）`);
        if (cards.backlog > 0) push('backlog', `线内只有 ${cards.backlog} 张 backlog 卡（待规划，不是待办）`);
      }
      if (handoff) {
        const expired = Number(handoff.expireAt) > 0 && now > Number(handoff.expireAt);
        push('lazy', `接力台账有未完成 pendingHandoff（${handoff.sourceSessionId ?? '?'} → ${handoff.newSessionId ?? '?'}${expired ? '，交接窗已过期没闭环' : ''}）`);
      }
      if (hasPendingToken) push('lazy', '标题带【待续】：标题自己标着"还有活没闭环"');
      if (idle !== null && idle > idleHours && (cards.running > 0 || cards.review > 0)) {
        push('stuck', `会话已闲置 ${idleText(idle)}，但线内还有 ${cards.running} 张 running / ${cards.review} 张 review 卡（卡在跑、会话却死了）`);
      }
      // 失败卡不在判据里，但它是"该有人管"的信号 —— 只补一句理由，不改档位
      if (cards.failed > 0) reasons.push(`另有 ${cards.failed} 张 failed 卡（重试/归档属 Router 可自拍项）`);
    }
    if (!buckets.length) continue;

    const top = buckets.slice().sort((a, b) => BUCKET_PRIORITY[b] - BUCKET_PRIORITY[a])[0];
    const score = BUCKET_PRIORITY[top] + (Number.isFinite(idle) ? Math.min(idle, 72) : 0) + Math.min(sumCards(cards), 20) * 0.1;
    items.push({
      line,
      sessionId: c.sessionId,
      title: c.title,
      buckets,
      primaryBucket: top,
      reasons,
      suggest: suggestFor({ primaryBucket: top, cards, handoff, idleHours: idle, threshold: idleHours, lineSource: c.lineSource }),
      idleHours: Number.isFinite(idle) ? Number(idle.toFixed(2)) : null,
      nudgedToday: lineNudge.get(line) ?? 0,
      cards: { ...cards },
      cardLine,
      lineSource: c.lineSource,
      running: c.running,
      updatedAt: c.updated ? new Date(c.updated).toISOString() : null,
      _score: score,
    });
  }

  // 6) 有在途卡但没在册会话的线：只列不催（别假装它在）
  const orphanLines = [];
  for (const [line, cards] of cardsByLine) {
    if (claimedLines.has(line)) continue;
    if (sumCards(cards) === 0) continue;
    orphanLines.push({ line, cards: { ...cards } });
  }
  orphanLines.sort((a, b) => sumCards(b.cards) - sumCards(a.cards));

  items.sort((a, b) => b._score - a._score || (b.idleHours ?? -1) - (a.idleHours ?? -1) || a.line.localeCompare(b.line));
  for (const it of items) delete it._score;

  return {
    items,
    orphanLines,
    claimedLines: [...claimedLines],
    stats: {
      sessions: (sessions ?? []).length,
      mainlineCandidates: candidates.length,
      linesWithCards: cardsByLine.size,
      linesClaimed: claimedLines.size,
      unknownRunning: unknownRunning.length,
    },
  };
}

/** 排期时间给人看的写法（`2026/11/6 09:30`，不带秒 —— 卡面 cron 只到分钟）。 */
function schedTimeText(ms) {
  return new Date(ms).toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

function fuzzyLineOf(line, cardsByLine) {
  const nLine = normName(line);
  const toks = lineTokens(line);
  const allIn = (a, b) => a.length > 0 && a.every((t) => b.includes(normName(t)));
  const distinctive = (a) => a.some((t) => normName(t).length >= 3);
  let best = null;
  for (const L of cardsByLine.keys()) {
    const ok = (allIn(toks, normName(L)) && distinctive(toks)) || (allIn(lineTokens(L), nLine) && distinctive(lineTokens(L)));
    if (!ok) continue;
    // 命中多个时取分词最长的那条（更具体）
    if (!best || lineTokens(L).join('').length > lineTokens(best).join('').length) best = L;
  }
  return best;
}

function fuzzyCards(line, cardsByLine) {
  const L = fuzzyLineOf(line, cardsByLine);
  return L ? cardsByLine.get(L) : { todo: 0, backlog: 0, review: 0, running: 0, failed: 0, scheduledTodo: 0 };
}

/** 建议动作（**只给人看的字**：本器具只读，不动手）。 */
function suggestFor({ primaryBucket, cards, handoff, idleHours, threshold, lineSource }) {
  if (primaryBucket === 'handoff') {
    const to = handoff?.newSessionId ? `改投接手会话 ${String(handoff.newSessionId).replace(/^session-/, '').slice(0, 8)}` : '改投接手会话（台账里没有 pendingHandoff 的接手 id）';
    return `别投话给这一棒（会被已交接闸挡）：起新棒 relay，或${to}`;
  }
  if (primaryBucket === 'stuck') {
    return `先核会话真死没（看它的末条事件），再决定改投接手会话还是重跑那 ${cards.running + cards.review} 张卡`;
  }
  if (primaryBucket === 'backlog') {
    return `催"规划"不催"跑"：让它把 backlog 卡移 todo，或说明这批为什么不做`;
  }
  const bits = [];
  if (cards.todo > 0) bits.push(`run/推进 ${cards.todo} 张 todo 卡`);
  if (cards.review > 0) bits.push(`验收 ${cards.review} 张 review 卡`);
  if (cards.running > 0) bits.push(`盯一下 ${cards.running} 张 running 卡`);
  const what = bits.length ? bits.join('、') : '把【待续】那半截活接着干';
  const why = Number.isFinite(idleHours) && idleHours > threshold ? `已闲置 ${idleHours.toFixed(1)} 小时` : '会话没在跑';
  const src = lineSource === 'relay' ? '' : '（线名靠标题推的，投话前先核一眼目标会话）';
  return `催办：投话让它 ${what}（${why}）${src}`;
}

// ── 人读渲染 ────────────────────────────────────────────────────────────────
export function renderHuman({ items, orphanLines, stats, idleHours, top, now }) {
  const lines = [];
  const ts = new Date(now).toLocaleString('zh-CN', { hour12: false });
  const head = `偷懒判据（只读）· ${ts} · 阈值 ${idleHours}h · 候选 ${items.length} 条 / 在册主线 ${stats.linesClaimed} 条 / 有在途卡主线 ${stats.linesWithCards} 条`;
  lines.push(head);
  const shown = items.slice(0, top);
  shown.forEach((it, i) => {
    const sid8 = String(it.sessionId).replace(/^session-/, '').slice(0, 8);
    const why = it.reasons[0] ?? '—';
    const extra = it.reasons.length > 1 ? `（另 ${it.reasons.length - 1} 条理由）` : '';
    // 卡归线与会话线名不一致（历史写法）时标出来，免得人以为"这线没卡"
    const cardTag = it.cardLine && it.cardLine !== it.line ? `（卡记在「${it.cardLine}」）` : '';
    // 「今日已催 N 次」紧跟理由（N=0 不显示，省噪声；≥3 时人自己能看出"催过了别再催第 4 次"）
    const nudged = it.nudgedToday > 0 ? `｜今日已催 ${it.nudgedToday} 次` : '';
    lines.push(`${i + 1}. ${it.line}${cardTag}｜${it.primaryBucket}｜${why}${extra}${nudged}｜${it.suggest}｜${sid8}`);
  });
  if (items.length > shown.length) lines.push(`…另 ${items.length - shown.length} 条未列（--top ${items.length} 看全）`);
  if (items.length === 0) lines.push('（没有候选：在册主线都在跑，或没有该催的活）');
  if (orphanLines.length) {
    const brief = orphanLines.slice(0, 8).map((o) => `${o.line}（${o.cards.todo + o.cards.backlog + o.cards.review + o.cards.running + o.cards.failed + (o.cards.scheduledTodo ?? 0)}）`).join('、');
    lines.push(`另有 ${orphanLines.length} 条线有在途卡但无在册主线会话（不催，只能人工看）：${brief}${orphanLines.length > 8 ? ' …' : ''}`);
  }
  return lines.join('\n');
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
export async function runCli({ argv, env = process.env, out = (s) => process.stdout.write(`${s}\n`), err = (s) => process.stderr.write(`${s}\n`), fetchImpl = globalThis.fetch, now = Date.now() }) {
  const has = (k) => argv.includes(k);
  const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

  if (has('--help') || has('-h')) { out(HELP); return 0; }
  if (has('--selftest')) return runSelftest({ out, err });

  const unknown = argv.filter((a) => a.startsWith('-') && !['--json', '--quiet', '--top', '--idle-hours', '--base-url'].includes(a));
  if (unknown.length) { err(`用法错：不认识 ${unknown.join(' ')}（--help 看用法）`); return 2; }
  for (const k of ['--top', '--idle-hours', '--base-url']) {
    if (has(k) && val(k) === undefined) { err(`用法错：${k} 缺值`); return 2; }
  }
  const topRaw = val('--top', String(DEFAULT_TOP));
  const top = Number(topRaw);
  if (!Number.isFinite(top) || top < 1 || Math.floor(top) !== top) { err(`用法错：--top 要正整数，拿到 ${JSON.stringify(topRaw)}`); return 2; }
  const idleRaw = val('--idle-hours', String(DEFAULT_IDLE_HOURS));
  const idleHours = Number(idleRaw);
  if (!Number.isFinite(idleHours) || idleHours <= 0) { err(`用法错：--idle-hours 要正数，拿到 ${JSON.stringify(idleRaw)}`); return 2; }
  const baseUrl = String(val('--base-url', env.DSH_WEB_URL || 'http://localhost:3080')).replace(/\/+$/, '');
  const JSONOUT = has('--json');
  const QUIET = has('--quiet');

  const [ses, board, led] = [await loadSessions({ env, baseUrl, fetchImpl }), await loadBoard({ env, baseUrl, fetchImpl }), loadLedger({ env })];
  const errors = [];
  if (!ses.ok) errors.push(`会话表：${ses.reason}`);
  if (!board.ok) errors.push(`看板：${board.reason}`);
  if (!led.ok) errors.push(`接力台账：${led.reason}`);
  if (errors.length) {
    // 🔴 fail-closed：取不到就报错，绝不当"没人偷懒"。stdout 只留机读错误（人读模式一个字都不多说）。
    for (const e of errors) err(`取数失败（fail-closed）：${e}`);
    if (JSONOUT) out(JSON.stringify({ ok: false, errors }, null, 2));
    return 3;
  }

  // 今日已催次数（辅助信息：读不到就当 0，绝不因为它阻断主判据）
  const nudges = loadNudges({ env, sessions: ses.items, now });
  const result = analyze({ sessions: ses.items, tasks: board.tasks, ledger: led.ledger, idleHours, now, nudges: nudges.counts });
  const payload = {
    ok: true,
    generatedAt: new Date(now).toISOString(),
    idleThresholdHours: idleHours,
    total: result.items.length,
    items: result.items,
    orphanLines: result.orphanLines,
    stats: result.stats,
    sources: {
      sessions: ses.source,
      board: board.source,
      boardRevision: board.revision,
      ledger: led.exists ? led.file : `${led.file}（不存在 ⇒ 没有 pendingHandoff）`,
      ops: nudges.exists ? nudges.file : `${nudges.file}（不存在 ⇒ 今日已催全 0）`,
    },
    nudgedSource: { file: nudges.file, today: nudges.today, exists: nudges.exists, records: nudges.records, counted: nudges.counted },
  };

  if (JSONOUT) { out(JSON.stringify(payload, null, 2)); return 0; }
  if (QUIET && result.items.length === 0) return 0;
  out(renderHuman({ ...result, idleHours, top, now }));
  return 0;
}

// ── 夹具自测（不连生产、不碰网络） ─────────────────────────────────────────
function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'router-lazy-')); }

function writeFixture(dir, name, obj) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(obj, null, 1), 'utf8');
  return file;
}

const NOW = Date.parse('2026-11-03T09:00:00+08:00');
const ago = (h) => NOW - h * HOUR;

/** 造会话项（形状照 session.list：title / projections.values.title 两态都支持）。 */
function sess({ id, title, running = false, updated = ago(5) }) {
  return { sessionId: `session-${id}`, running, title, updatedAt: updated };
}

/** 造看板卡（只带判据用到的字段；`schedule` 不给则与真账本里"没排期的卡"同形）。 */
function card({ id, line, status, schedule = null }) {
  return { id: `card-${id}`, title: `卡 ${id}`, line, status, archivedAt: null, ...(schedule ? { schedule } : {}) };
}

export async function runSelftest({ out, err }) {
  const cases = [];
  const runCase = async (name, { sessions, board, ledger = {}, ops, argv = [], envExtra = {}, fetchImpl, expect }) => {
    const dir = tmpDir();
    // 🔴 默认把催办流水指向**不存在的夹具路径** —— 否则空字符串会落回 `~/.dsh/router-ops.jsonl`，
    //    自测就读到生产流水了（原 ①–㉑ 的期望值不受影响：文件不存在 ⇒ 今日已催全 0）。
    const env = { ...process.env, ROUTER_LAZY_SESSIONS_FILE: '', ROUTER_LAZY_BOARD_FILE: '', ROUTER_LAZY_LEDGER_FILE: '', ROUTER_LAZY_OPS_FILE: path.join(dir, 'ops-absent.jsonl') };
    if (sessions !== undefined) env.ROUTER_LAZY_SESSIONS_FILE = writeFixture(dir, 'sessions.json', { result: { value: { items: sessions } } });
    if (board !== undefined) env.ROUTER_LAZY_BOARD_FILE = writeFixture(dir, 'board.json', { revision: 1, tasks: board });
    env.ROUTER_LAZY_LEDGER_FILE = writeFixture(dir, 'ledger.json', ledger);
    if (ops !== undefined) {
      // 夹具流水：一行一条 JSON（与 router-act 的 appendOps 同形）
      const f = path.join(dir, 'ops.jsonl');
      fs.writeFileSync(f, ops.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8');
      env.ROUTER_LAZY_OPS_FILE = f;
    }
    Object.assign(env, envExtra);
    const stdout = [];
    const stderr = [];
    let code = -99;
    try {
      code = await runCli({
        argv,
        env,
        out: (s) => stdout.push(String(s)),
        err: (s) => stderr.push(String(s)),
        fetchImpl: fetchImpl ?? (() => { throw new Error('自测禁用网络：不该走到这里'); }),
        now: NOW,
      });
    } catch (e) {
      stderr.push(`抛错：${String(e?.message ?? e)}`);
      code = -1;
    }
    const text = stdout.join('\n');
    const problems = [];
    if (code !== expect.code) problems.push(`rc 期望 ${expect.code} 实得 ${code}`);
    for (const s of expect.stdoutHas ?? []) if (!text.includes(s)) problems.push(`stdout 缺 ${JSON.stringify(s)}`);
    for (const s of expect.stdoutHasNot ?? []) if (text.includes(s)) problems.push(`stdout 不该含 ${JSON.stringify(s)}`);
    if (expect.stdoutEmpty && text.trim() !== '') problems.push(`stdout 应为空，实得 ${JSON.stringify(text.slice(0, 120))}`);
    let json = null;
    if (expect.json) {
      try { json = JSON.parse(text); } catch (e) { problems.push(`stdout 不是 JSON：${String(e?.message ?? e)}`); }
      if (json) for (const f of expect.jsonFields ?? []) {
        const it = json.items?.[0];
        if (!it || it[f] === undefined) problems.push(`items[0] 缺字段 ${f}`);
      }
    }
    if (expect.json) {
      const n = json?.total ?? -1;
      if (expect.total !== undefined && n !== expect.total) problems.push(`total 期望 ${expect.total} 实得 ${n}`);
      const buckets = json?.items?.[0]?.buckets ?? [];
      for (const b of expect.buckets ?? []) if (!buckets.includes(b)) problems.push(`items[0].buckets 缺 ${b}（实得 ${JSON.stringify(buckets)}）`);
      for (const b of expect.bucketsNot ?? []) if (buckets.includes(b)) problems.push(`items[0].buckets 不该含 ${b}（实得 ${JSON.stringify(buckets)}）`);
      const reasonText = JSON.stringify(json?.items?.[0]?.reasons ?? []);
      for (const s of expect.reasonHas ?? []) if (!reasonText.includes(s)) problems.push(`items[0].reasons 缺 ${JSON.stringify(s)}`);
      for (const s of expect.reasonHasNot ?? []) if (reasonText.includes(s)) problems.push(`items[0].reasons 不该含 ${JSON.stringify(s)}（实得 ${reasonText.slice(0, 160)}）`);
      // 卡计数逐项断言（排期口径要能钉住 cards.todo / cards.scheduledTodo）
      for (const [k, v] of Object.entries(expect.cards ?? {})) {
        const got = json?.items?.[0]?.cards?.[k];
        if (got !== v) problems.push(`items[0].cards.${k} 期望 ${v} 实得 ${JSON.stringify(got)}`);
      }
      if (expect.idleHoursNull && json?.items?.[0]?.idleHours !== null) problems.push(`items[0].idleHours 应为 null，实得 ${JSON.stringify(json?.items?.[0]?.idleHours)}`);
      // 今日已催次数（新列，只加不改：老用例不写这个键 ⇒ 不参与断言）
      if (expect.nudgedToday !== undefined) {
        const got = json?.items?.[0]?.nudgedToday;
        if (got !== expect.nudgedToday) problems.push(`items[0].nudgedToday 期望 ${expect.nudgedToday} 实得 ${JSON.stringify(got)}`);
      }
    }
    if (typeof expect.check === 'function') {
      let msg = null;
      try { msg = expect.check(); } catch (e) { msg = `expect.check 抛错：${String(e?.message ?? e)}`; }
      if (msg) problems.push(msg);
    }
    const ok = problems.length === 0;
    cases.push({ name, ok, problems, code, stdout: text.slice(0, 400), stderr: stderr.join('\n').slice(0, 300) });
    fs.rmSync(dir, { recursive: true, force: true });
    return ok;
  };

  const L = '示例主线 · 甲';

  // ① 正常活跃线不报：running=true，哪怕有 todo 卡
  await runCase('① 运行中的线不报（running 优先于 todo 卡）', {
    sessions: [sess({ id: 'fx00001', title: `【运行】${L}`, running: true, updated: ago(0.1) })],
    board: [card({ id: 1, line: L, status: 'todo' })],
    ledger: { pendingHandoff: null, chains: [{ mainline: L, sourceSessionId: 'session-fx00001', newSessionId: 'session-fx00001', at: ago(0.2) }] },
    argv: ['--json'],
    expect: { code: 0, json: true, total: 0 },
  });

  // ② idle + todo 卡 ⇒ lazy
  await runCase('② 闲置 + todo 卡 ⇒ lazy', {
    sessions: [sess({ id: 'fx00002', title: `【完成】${L}` })],
    board: [card({ id: 2, line: L, status: 'todo' })],
    ledger: { pendingHandoff: null, chains: [{ mainline: L, sourceSessionId: 'session-fx00002', newSessionId: 'session-fx00002', at: ago(6) }] },
    argv: ['--json'],
    expect: { code: 0, json: true, total: 1, buckets: ['lazy'], jsonFields: ['line', 'sessionId', 'title', 'buckets', 'reasons', 'suggest', 'idleHours', 'cards'] },
  });

  // ③ idle + 只有 backlog ⇒ backlog（不是 lazy）
  await runCase('③ 只有 backlog 卡 ⇒ backlog（不按催办）', {
    sessions: [sess({ id: 'fx00003', title: `【完成】${L}` })],
    board: [card({ id: 3, line: L, status: 'backlog' })],
    ledger: { pendingHandoff: null, chains: [] },
    argv: ['--json'],
    expect: { code: 0, json: true, total: 1, buckets: ['backlog'], reasonHas: ['待规划'], stdoutHasNot: [] },
  });

  // ④ 标题【待续】⇒ lazy（reasons 带待续）
  await runCase('④ 标题【待续】⇒ lazy', {
    sessions: [sess({ id: 'fx00004', title: `【待续】${L}` })],
    board: [],
    ledger: { pendingHandoff: null, chains: [] },
    argv: ['--json'],
    expect: { code: 0, json: true, total: 1, buckets: ['lazy'], reasonHas: ['待续'] },
  });

  // ⑤ 【已交接】⇒ handoff（不混进 lazy）
  await runCase('⑤ 【已交接】⇒ handoff（不进 lazy）', {
    sessions: [sess({ id: 'fx00005', title: `【已交接】${L}` })],
    board: [card({ id: 5, line: L, status: 'todo' })],
    ledger: { pendingHandoff: { sourceSessionId: 'session-fx00005', newSessionId: 'session-fyb00005', handoffAt: ago(2), expireAt: ago(1) }, chains: [] },
    argv: ['--json'],
    expect: { code: 0, json: true, total: 1, buckets: ['handoff'], stdoutHasNot: ['"lazy"'] },
  });

  // ⑤b 【已交接】但线内已无活 ⇒ 不报（否则历史交接刷屏）
  await runCase('⑤b 【已交接】且线内无活 ⇒ 不报（正常收工）', {
    sessions: [sess({ id: 'fx00055', title: `【已交接】${L}` })],
    board: [],
    ledger: { pendingHandoff: null, chains: [] },
    argv: ['--json'],
    expect: { code: 0, json: true, total: 0 },
  });


  // ⑥ 卡在跑但会话死 ⇒ stuck（阈值 3h；会话闲置 5.5h）
  await runCase('⑥ 卡在跑但会话死了 ⇒ stuck', {
    sessions: [sess({ id: 'fx00006', title: `【完成】${L}`, updated: ago(5.5) })],
    board: [card({ id: 61, line: L, status: 'running' }), card({ id: 62, line: L, status: 'review' })],
    ledger: { pendingHandoff: null, chains: [] },
    argv: ['--json'],
    expect: { code: 0, json: true, total: 1, buckets: ['stuck'], reasonHas: ['running'] },
  });

  // ⑥b 同样有 running 卡但只闲置 1h（< 阈值）⇒ 不报 stuck
  await runCase('⑥b 有 running 卡但闲置未过阈值 ⇒ 不报', {
    sessions: [sess({ id: 'fx00007', title: `【完成】${L}`, updated: ago(1) })],
    board: [card({ id: 71, line: L, status: 'running' })],
    ledger: { pendingHandoff: null, chains: [] },
    argv: ['--json'],
    expect: { code: 0, json: true, total: 0 },
  });

  // ⑦ 两个都取不到 ⇒ rc=3 且绝不说"没人在偷懒"
  await runCase('⑦ 取数全失败 ⇒ rc=3（fail-closed，不说没事）', {
    sessions: undefined,
    board: undefined,
    envExtra: { ROUTER_LAZY_SESSIONS_FILE: path.join(os.tmpdir(), 'router-lazy-does-not-exist-s.json'), ROUTER_LAZY_BOARD_FILE: path.join(os.tmpdir(), 'router-lazy-does-not-exist-b.json') },
    argv: [],
    expect: { code: 3, stdoutEmpty: true, stdoutHasNot: ['没人在偷懒', '没有候选'] },
  });

  // ⑦b --json 模式取数失败 ⇒ rc=3 + ok:false，仍然不出现"没事"
  await runCase('⑦b 取数失败 + --json ⇒ rc=3 / ok:false', {
    sessions: undefined,
    board: undefined,
    envExtra: { ROUTER_LAZY_SESSIONS_FILE: path.join(os.tmpdir(), 'router-lazy-does-not-exist-s.json'), ROUTER_LAZY_BOARD_FILE: path.join(os.tmpdir(), 'router-lazy-does-not-exist-b.json') },
    argv: ['--json'],
    expect: { code: 3, stdoutHas: ['"ok": false'], stdoutHasNot: ['没人在偷懒'] },
  });

  // ⑧ 时间戳缺失 ⇒ 不崩、idleHours=null 标 unknown
  await runCase('⑧ 时间戳缺失 ⇒ idleHours=null 标 unknown（不崩）', {
    sessions: [{ sessionId: 'session-fx00008', running: false, title: `【完成】${L}` }],
    board: [card({ id: 81, line: L, status: 'todo' })],
    ledger: { pendingHandoff: null, chains: [] },
    argv: ['--json'],
    expect: { code: 0, json: true, total: 1, buckets: ['lazy'], idleHoursNull: true },
  });

  // ⑨ --quiet 无候选 ⇒ 零输出 rc=0
  await runCase('⑨ --quiet 无候选 ⇒ 零输出 rc=0', {
    sessions: [sess({ id: 'fx00009', title: `【运行】${L}`, running: true })],
    board: [],
    ledger: { pendingHandoff: null, chains: [] },
    argv: ['--quiet'],
    expect: { code: 0, stdoutEmpty: true },
  });

  // ⑩ 用法错 ⇒ rc=2
  await runCase('⑩ --top 非数字 ⇒ rc=2', {
    sessions: [sess({ id: 'fx00010', title: `【完成】${L}` })],
    board: [],
    ledger: {},
    argv: ['--top', 'abc'],
    expect: { code: 2, stdoutEmpty: true },
  });

  // ⑪ --help 有完整用法（本机规矩：不认的脚本会被误当直跑）
  await runCase('⑪ --help 有完整用法 ⇒ rc=0', {
    sessions: [], board: [], ledger: {},
    argv: ['--help'],
    expect: { code: 0, stdoutHas: ['用法', '--idle-hours', '退出码'] },
  });

  // ⑫ 人读输出格式：线名｜档｜理由｜建议｜sid 前 8 位
  await runCase('⑫ 人读一行格式 <线>｜<档>｜<理由>｜<建议>｜<sid8>', {
    sessions: [sess({ id: 'fx00012', title: `【完成】${L}` })],
    board: [card({ id: 121, line: L, status: 'todo' })],
    ledger: { pendingHandoff: null, chains: [] },
    argv: [],
    expect: { code: 0, stdoutHas: [`${L}｜lazy｜`, '｜', 'fx00012'] },
  });

  // ⑬ pendingHandoff 未完成 ⇒ lazy（有链无线名时靠 pending 会话推线）
  await runCase('⑬ 未完成 pendingHandoff ⇒ lazy', {
    sessions: [sess({ id: 'fx00013', title: `【完成】${L}` })],
    board: [],
    ledger: { pendingHandoff: { sourceSessionId: 'session-fx00013', newSessionId: 'session-fyb00013', handoffAt: ago(0.5), expireAt: nowPlus(0.2) }, chains: [] },
    argv: ['--json'],
    expect: { code: 0, json: true, total: 1, buckets: ['lazy'], reasonHas: ['pendingHandoff'] },
  });

  // ⑭ 有在途卡但无在册会话 ⇒ 进 orphanLines，不硬塞成候选
  await runCase('⑭ 无在册会话的线 ⇒ orphanLines（不假装它在）', {
    sessions: [],
    board: [card({ id: 141, line: '孤儿线 · 测试', status: 'todo' })],
    ledger: { pendingHandoff: null, chains: [] },
    argv: ['--json'],
    expect: { code: 0, json: true, total: 0, stdoutHas: ['孤儿线 · 测试'] },
  });

  // ── 排期口径（2026-11-05 新增；上面 ①–⑭ 的期望值一个都没动） ──
  const sched = (h) => ({ enabled: true, cron: '30 9 6 11 *', nextRunAt: nowPlus(h) });

  // ⑮ 唯一在途卡是"未来排期的 todo" ⇒ 不判 lazy，整条不进 items（等窗口，不催）
  await runCase('⑮ 未来排期的 todo 卡 ⇒ 不判 lazy（整条不进 items）', {
    sessions: [sess({ id: 'fx00015', title: `【完成】${L}` })],
    board: [card({ id: 151, line: L, status: 'todo', schedule: sched(3) })],
    ledger: { pendingHandoff: null, chains: [] },
    argv: ['--json'],
    expect: { code: 0, json: true, total: 0, stdoutHasNot: ['"lazy"', '没动'] },
  });

  // ⑯ 同线还有 backlog ⇒ 判 backlog（不是 lazy），且 cards 露出 todo=0 / scheduledTodo=1
  await runCase('⑯ 未来排期的 todo + backlog ⇒ 判 backlog，cards.todo=0 / scheduledTodo=1', {
    sessions: [sess({ id: 'fx00016', title: `【完成】${L}` })],
    board: [card({ id: 161, line: L, status: 'todo', schedule: sched(3) }), card({ id: 162, line: L, status: 'backlog' })],
    ledger: { pendingHandoff: null, chains: [] },
    argv: ['--json'],
    expect: { code: 0, json: true, total: 1, buckets: ['backlog'], bucketsNot: ['lazy'], reasonHas: ['已排期', '等窗口'], reasonHasNot: ['没动'], cards: { todo: 0, scheduledTodo: 1, backlog: 1 } },
  });

  // ⑰ 阴性对照：schedule.enabled=false ⇒ 仍判 lazy（没把整类 todo 放过）
  await runCase('⑰ schedule.enabled=false ⇒ 仍判 lazy（阴性对照）', {
    sessions: [sess({ id: 'fx00017', title: `【完成】${L}` })],
    board: [card({ id: 171, line: L, status: 'todo', schedule: { enabled: false, cron: '30 9 6 11 *', nextRunAt: nowPlus(3) } })],
    ledger: { pendingHandoff: null, chains: [] },
    argv: ['--json'],
    expect: { code: 0, json: true, total: 1, buckets: ['lazy'], reasonHas: ['没动'], cards: { todo: 1, scheduledTodo: 0 } },
  });

  // ⑱ 排期已过点（nextRunAt = now-1h）⇒ 仍判 lazy，且理由写明"排期已过点"（更该催）
  await runCase('⑱ 排期已过点 ⇒ 仍判 lazy + 理由含「排期已过点」', {
    sessions: [sess({ id: 'fx00018', title: `【完成】${L}` })],
    board: [card({ id: 181, line: L, status: 'todo', schedule: sched(-1) })],
    ledger: { pendingHandoff: null, chains: [] },
    argv: ['--json'],
    expect: { code: 0, json: true, total: 1, buckets: ['lazy'], reasonHas: ['没动', '排期已过点'], cards: { todo: 1, scheduledTodo: 0 } },
  });

  // ⑲ 真 todo + 未来排期同线 ⇒ 仍判 lazy，todo=1 / scheduledTodo=1（不许被"等窗口"整体带过）
  await runCase('⑲ 真 todo + 未来排期同线 ⇒ 仍判 lazy（todo=1 / scheduledTodo=1）', {
    sessions: [sess({ id: 'fx00019', title: `【完成】${L}` })],
    board: [card({ id: 191, line: L, status: 'todo' }), card({ id: 192, line: L, status: 'todo', schedule: sched(3) })],
    ledger: { pendingHandoff: null, chains: [] },
    argv: ['--json'],
    expect: { code: 0, json: true, total: 1, buckets: ['lazy'], reasonHas: ['没动', '已排期'], cards: { todo: 1, scheduledTodo: 1 } },
  });

  // ⑳ enabled 但 nextRunAt 缺失 ⇒ 仍算 todo，理由含「排期已过点」（fail-open 到"该催"那侧）
  await runCase('⑳ enabled 但 nextRunAt 缺失 ⇒ 仍算 todo + 理由含「排期已过点」', {
    sessions: [sess({ id: 'fx00020', title: `【完成】${L}` })],
    board: [card({ id: 201, line: L, status: 'todo', schedule: { enabled: true, cron: '30 9 6 11 *' } })],
    ledger: { pendingHandoff: null, chains: [] },
    argv: ['--json'],
    expect: { code: 0, json: true, total: 1, buckets: ['lazy'], reasonHas: ['排期已过点'], cards: { todo: 1, scheduledTodo: 0 } },
  });

  // ㉑ 人读输出：理由行能看到「已排期 …（等窗口，不催）」，且不出现"没动"
  await runCase('㉑ 人读理由行露出「已排期…（等窗口，不催）」', {
    sessions: [sess({ id: 'fx00021', title: `【完成】${L}` })],
    board: [card({ id: 211, line: L, status: 'todo', schedule: sched(3) }), card({ id: 212, line: L, status: 'backlog' })],
    ledger: { pendingHandoff: null, chains: [] },
    argv: [],
    expect: { code: 0, stdoutHas: ['已排期', '等窗口，不催'], stdoutHasNot: ['todo 卡（待办）没动'] },
  });

  // ── 今日已催次数（2026-11-05 新增；上面 ①–㉑ 的期望值一个都没动） ──
  // 时钟仍是固定 NOW（本地 09:00）⇒ 下面用相对偏移造"今天/昨天"，跟机器时区无关。
  const iso = (ms) => new Date(ms).toISOString();
  const opsRec = ({ verb = 'say', sid = null, target = '', ok = true, dryRun = false, at }) => ({ at: iso(at), verb, target, sid, ok, dryRun, source: 'router-act' });

  // ㉒ 今天 2 次真投（1 条靠完整 sid、1 条只给 target 短 id 前缀）⇒ 2；昨天 3 次 / ok:false / 演练 / digest 都不算
  await runCase('㉒ 今日已催：今天 2 次真投 ⇒ nudgedToday=2（昨天/失败/演练/digest 不算）', {
    sessions: [sess({ id: 'fx00022', title: `【完成】${L}` })],
    board: [card({ id: 221, line: L, status: 'todo' })],
    ledger: { pendingHandoff: null, chains: [] },
    ops: [
      opsRec({ sid: 'session-fx00022', target: 'session-fx00022', at: NOW - 1 * HOUR }),                    // 今天 · 完整 sid
      opsRec({ target: 'session-fx00022', at: NOW - 2 * HOUR }),                                             // 今天 · 短 id 前缀
      opsRec({ sid: 'session-fx00022', target: 'session-fx00022', at: NOW - 25 * HOUR }),                    // 昨天 ×3
      opsRec({ sid: 'session-fx00022', target: 'session-fx00022', at: NOW - 26 * HOUR }),
      opsRec({ sid: 'session-fx00022', target: 'session-fx00022', at: NOW - 27 * HOUR }),
      opsRec({ sid: 'session-fx00022', target: 'session-fx00022', at: NOW - 1 * HOUR, ok: false }),          // 投失败
      opsRec({ sid: 'session-fx00022', target: 'session-fx00022', at: NOW - 1 * HOUR, dryRun: true }),       // 演练没投
      opsRec({ sid: 'session-fx00022', target: 'session-fx00022', at: NOW - 1 * HOUR, verb: 'digest' }),     // 不是催办
    ],
    argv: ['--json'],
    expect: { code: 0, json: true, total: 1, buckets: ['lazy'], nudgedToday: 2 },
  });

  // ㉓ 人读输出把「今日已催 2 次」挂在理由后面（N=0 时整列不出现，见 ㉕）
  await runCase('㉓ 人读：理由后出现「今日已催 2 次」', {
    sessions: [sess({ id: 'fx00023', title: `【完成】${L}` })],
    board: [card({ id: 231, line: L, status: 'todo' })],
    ledger: { pendingHandoff: null, chains: [] },
    ops: [
      opsRec({ sid: 'session-fx00023', target: 'session-fx00023', at: NOW - 1 * HOUR }),
      opsRec({ sid: 'session-fx00023', target: 'session-fx00023', at: NOW - 2 * HOUR }),
    ],
    argv: [],
    expect: { code: 0, stdoutHas: [`${L}｜lazy｜`, '今日已催 2 次'], stdoutHasNot: ['今日已催 0 次'] },
  });

  // ㉔ 线级汇总：同线两棒（旧棒 a 1 次 + 最新棒 b 2 次）合计 3（不是只看最新一棒）
  await runCase('㉔ 同线两棒合计 3 次 ⇒ nudgedToday=3（线级汇总）', {
    sessions: [
      sess({ id: 'fx00024a', title: `【完成】${L}`, updated: ago(6) }),
      sess({ id: 'fx00024b', title: `【完成】${L}`, updated: ago(5) }),
    ],
    board: [card({ id: 241, line: L, status: 'todo' })],
    ledger: { pendingHandoff: null, chains: [] },
    ops: [
      opsRec({ sid: 'session-fx00024a', target: 'session-fx00024a', at: NOW - 1 * HOUR }),
      opsRec({ sid: 'session-fx00024b', target: 'session-fx00024b', at: NOW - 1.5 * HOUR }),
      opsRec({ sid: 'session-fx00024b', target: 'session-fx00024b', at: NOW - 2.5 * HOUR }),
    ],
    argv: ['--json'],
    expect: { code: 0, json: true, total: 1, nudgedToday: 3 },
  });

  // ㉕ 阴性对照：只有演练 / 失败 / 昨天的记录 ⇒ nudgedToday=0，人读不出现该列
  await runCase('㉕ 阴性对照：演练/失败/昨天都不算 ⇒ nudgedToday=0 且人读不显示该列', {
    sessions: [sess({ id: 'fx00025', title: `【完成】${L}` })],
    board: [card({ id: 251, line: L, status: 'todo' })],
    ledger: { pendingHandoff: null, chains: [] },
    ops: [
      opsRec({ sid: 'session-fx00025', target: 'session-fx00025', at: NOW - 25 * HOUR }),
      opsRec({ sid: 'session-fx00025', target: 'session-fx00025', at: NOW - 1 * HOUR, ok: false }),
      opsRec({ sid: 'session-fx00025', target: 'session-fx00025', at: NOW - 1 * HOUR, dryRun: true }),
      opsRec({ sid: 'session-fx00025', target: 'session-fx00025', at: NOW - 1 * HOUR, verb: 'wake', ok: false }),
    ],
    argv: [],
    expect: { code: 0, stdoutHas: [`${L}｜lazy｜`], stdoutHasNot: ['今日已催'] },
  });

  // ㉖ 流水文件不存在 ⇒ 不算取数失败（主判据照出），nudgedToday=0（辅助信息 fail-open）
  await runCase('㉖ 催办流水不存在 ⇒ rc 0 + nudgedToday=0（不阻断主判据）', {
    sessions: [sess({ id: 'fx00026', title: `【完成】${L}` })],
    board: [card({ id: 261, line: L, status: 'todo' })],
    ledger: { pendingHandoff: null, chains: [] },
    envExtra: { ROUTER_LAZY_OPS_FILE: path.join(os.tmpdir(), 'router-lazy-ops-does-not-exist.jsonl') },
    argv: ['--json'],
    expect: { code: 0, json: true, total: 1, nudgedToday: 0 },
  });

  // ── 2026-11-06 开源版新增三条（生产件里没有对应能力；上面 ①–㉖ 的期望值一个都没动） ──
  // 看板请求头：生产件把某个作用域头写死在代码里，仓内版一律由调用方给（不猜头名）。
  let seenHeaders = null;
  const fakeBoard = (tasks) => async (url, init) => {
    seenHeaders = init?.headers ?? null;
    return { ok: true, status: 200, json: async () => ({ revision: 1, tasks }) };
  };

  await runCase('㉗ ROUTER_BOARD_HEADERS 原样带上看板请求（本件不猜头名）', {
    sessions: [sess({ id: 'fx00027', title: `【完成】${L}` })],
    ledger: { pendingHandoff: null, chains: [] },
    envExtra: { ROUTER_BOARD_HEADERS: JSON.stringify({ 'x-example-scope': 'active' }) },
    fetchImpl: fakeBoard([card({ id: 271, line: L, status: 'todo' })]),
    argv: ['--json'],
    expect: {
      code: 0, json: true, total: 1,
      check: () => (seenHeaders && seenHeaders['x-example-scope'] === 'active'
        ? null
        : `看板请求没带上调用方给的头：${JSON.stringify(seenHeaders)}`),
    },
  });

  await runCase('㉘ 阴性对照：不给 ROUTER_BOARD_HEADERS ⇒ 一个自定义头都不带', {
    sessions: [sess({ id: 'fx00028', title: `【完成】${L}` })],
    ledger: { pendingHandoff: null, chains: [] },
    fetchImpl: fakeBoard([card({ id: 281, line: L, status: 'todo' })]),
    argv: ['--json'],
    expect: {
      code: 0, json: true, total: 1,
      check: () => {
        const extra = Object.keys(seenHeaders ?? {}).filter((k) => !['origin', 'accept', 'content-type'].includes(k));
        return extra.length === 0 ? null : `不该带自定义头，实得：${JSON.stringify(extra)}`;
      },
    },
  });

  // 线名解析可注入：给一个恒返回固定线名的钩子 ⇒ 会话被归到那条线上（完全不看台账/标题）
  {
    const injected = analyze({
      sessions: [{ sessionId: 'session-fx00029', running: false, title: '【完成】和线名毫无关系的标题', updatedAt: ago(5) }],
      tasks: [card({ id: 291, line: '注入线 · 外部索引', status: 'todo' })],
      ledger: { chains: [], pendingHandoff: null },
      resolveLine: () => ({ line: '注入线 · 外部索引', lineSource: 'injected' }),
      now: NOW,
    });
    const problems = [];
    if (injected.items.length !== 1) problems.push(`items 期望 1 实得 ${injected.items.length}`);
    if (injected.items[0]?.line !== '注入线 · 外部索引') problems.push(`line 期望注入值，实得 ${JSON.stringify(injected.items[0]?.line)}`);
    if (injected.items[0]?.lineSource !== 'injected') problems.push(`lineSource 期望 injected，实得 ${JSON.stringify(injected.items[0]?.lineSource)}`);
    if (!(injected.items[0]?.buckets ?? []).includes('lazy')) problems.push('注入线判档期望 lazy');
    cases.push({ name: '㉙ 线名解析可注入（resolveLine 钩子）', ok: problems.length === 0, problems, code: 0, stdout: '', stderr: '' });
  }

  const pass = cases.filter((c) => c.ok).length;
  const lines = [];
  lines.push(`router-lazy --selftest：${pass}/${cases.length} 通过（不连生产、不碰网络 · 固定时钟 ${new Date(NOW).toISOString()}）`);
  for (const c of cases) {
    lines.push(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : `  ← rc=${c.code} ${c.problems.join(' / ')}`}`);
    if (!c.ok) lines.push(`      stdout=${JSON.stringify(c.stdout.slice(0, 200))} stderr=${JSON.stringify(c.stderr.slice(0, 200))}`);
  }
  out(lines.join('\n'));
  if (pass !== cases.length) {
    err(`自测失败：${cases.length - pass} 条红`);
    return 1;
  }
  return 0;
}

function nowPlus(h) { return NOW + h * HOUR; }

// ── CLI 入口（junction 口径：argv[1] 与 import.meta.url 双 realpath 比对） ────
const isMain = (() => {
  const a = process.argv[1];
  if (!a) return false;
  try {
    return fs.realpathSync(a) === fs.realpathSync(new URL(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  process.exitCode = await runCli({ argv: process.argv.slice(2) });
}
