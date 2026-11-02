#!/usr/bin/env node
/**
 * router-guard.mjs —— 把「不该坏的东西」现读一遍；能自己拨回来就拨回来，拨不动就报警。
 * 默认 **dry-run**（只看不动），`--apply` 才动手；定时任务带 `--apply`。
 * 三项判据（一律现读文件 / 调 RPC，**不许用缓存、不许"上次是好的"**）：
 *   1 置顶复位 : `workspace.json#global.workspaceIds` 里目标工作区不是第一个 ⇒ RPC
 *                `workspace.insertBefore` 挪回第 1 位（顺序即置顶，**没有硬 pin 字段**）
 *   2 归档保护 : `archivedSessionIds` 含**当前主会话** ⇒ RPC `workspace.unarchiveSession` 复原。
 *                ⚠️ 只认「当前那个会话」，**不去复活**历史被归档的旧会话（它们本来就该躺着）
 *   3 cwd 还在 : 目标目录存在 **且** 当前会话 header.cwd 仍是它 ⇒ 假就只报警（**不自动建目录**：
 *                免得将错就错把会话钉到一个空目录上）。生产版另两项（会话身份漂移 / 入站通道
 *                Bot ready）判的是**部署事实**，不搬。
 * 结局四种 `ok` / `已复位` / `报警` / `unknown`（读不到 ⇒ 记 unknown 继续下一项，整脚本不崩）；
 * 幂等（复位全是「只在不对时才动」）；报警去重（站着不动的那条默认 6 小时只落一行，「已复位」
 * 不受约束；`--no-dedupe` / `--dedupe-min 0` 可关）；失败即让路（任何一处读不到 ⇒ 该项 unknown、
 * 其它项照跑；`workspace.json` 读不到 = 环境没就绪 ⇒ rc **3** 让路；"有报警"不是失败 ⇒ 仍是 0）。
 *
 * CLI：`--router-cwd <dir> [--apply] [--json] [--once] [--quiet] [--no-dedupe] [--dedupe-min N]`
 * 环境：DSH_HOME · ROUTER_HOME · ROUTER_GUARD_WS_FILE · ROUTER_GUARD_STATE_FILE ·
 *       ROUTER_GUARD_ROOT · DSH_RPC_COOKIE_SECRET · DSH_WEB_URL · ROUTER_GUARD_OFFLINE_RPC=1
 */
import fs from 'node:fs';
import path from 'node:path';
import { hostRpc } from './lib/host-rpc.mjs';
import { resolveHome } from './lib/home.mjs';
import { acquireTickLock, releaseTickLock, writeJsonAtomic, readJsonSafe } from './lib/store.mjs';
import { readSessionHeader, findSessionFile } from './lib/session-header.mjs';
import { alert } from './lib/alert.mjs';

export const VERSION = '0.1.0';
const ARGV = process.argv.slice(2);
const has = (f) => ARGV.includes(f);
const val = (f, d) => { const i = ARGV.indexOf(f); return i >= 0 ? ARGV[i + 1] : d; };
const APPLY = has('--apply');
const JSON_OUT = has('--json');
const QUIET = has('--quiet');
const HELP = has('--help') || has('-h');
const DEDUPE_MS = has('--no-dedupe') ? 0 : (Number(val('--dedupe-min', NaN)) >= 0 ? Number(val('--dedupe-min')) * 60_000 : 6 * 3_600_000);
const HOME = resolveHome(process.env.ROUTER_HOME);
const CFG = {
  home: HOME,
  wsFile: process.env.ROUTER_GUARD_WS_FILE || path.join(HOME, 'storages', 'workspace.json'),
  stateFile: process.env.ROUTER_GUARD_STATE_FILE || path.join(HOME, 'router-guard-state.json'),
  /** 目标工作区目录：**必填**（骨架不能替使用者猜目录）；没给 ⇒ 依赖它的项记 unknown */
  routerPath: String(process.env.ROUTER_GUARD_ROOT || val('--router-cwd', '') || '').trim(),
  base: (process.env.DSH_WEB_URL || 'http://127.0.0.1:3080').replace(/\/+$/, ''),
  offlineRpc: process.env.ROUTER_GUARD_OFFLINE_RPC === '1',
  ttlMs: 120_000,
  rpcTimeoutMs: Number(process.env.ROUTER_TIMEOUT_MS || 20_000),
};

const OK = 'ok', FIXED = 'fixed', ALARM = 'alarm', UNKNOWN = 'unknown';
const LABEL = { ok: 'ok', fixed: '已复位', alarm: '报警', unknown: 'unknown' };

const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;
const widthOf = (s) => { let n = 0; for (const ch of String(s)) n += WIDE.test(ch) ? 2 : 1; return n; };
const padW = (s, w) => String(s) + ' '.repeat(Math.max(0, w - widthOf(s)));
const clip = (s, n = 220) => (String(s ?? '').length > n ? `${String(s).slice(0, n)}…` : String(s ?? ''));
const shortId = (s) => (String(s ?? '').length > 24 ? `${String(s).slice(0, 16)}…` : String(s ?? ''));
const stamp = (ms = Date.now()) => { const d = new Date(ms), p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
/** 路径规范化比较（Windows 大小写不敏感；junction 走 realpath）。 */
function canon(p) {
  try { return fs.realpathSync.native(p).toLowerCase(); } catch {
    try { return path.resolve(String(p)).toLowerCase(); } catch { return String(p).toLowerCase(); }
  }
}
const result = (id, label, status, reason, extra = {}) => ({ id, label, status, reason: clip(reason, 400), ...extra });

/** 唯一的写 RPC 入口（离线夹具 / 失败都在这里收口）。 */
async function rpc(method, payload) {
  if (CFG.offlineRpc) return { ok: false, error: 'offline（ROUTER_GUARD_OFFLINE_RPC=1，夹具模式不碰生产）' };
  const r = await hostRpc(CFG.base, method, payload, { timeoutMs: CFG.rpcTimeoutMs });
  return r.ok ? { ok: true, value: r.value } : { ok: false, error: r.error ? `${r.error.code}: ${r.error.message}` : `HTTP ${r.status}` };
}

/** 一组会话里「最近写过」的那个（只 stat 文件、不解压；被归档的会话文件还在，mtime 仍可读）。 */
function newestByMtime(sids) {
  let best = null;
  for (const sid of sids) {
    try {
      const f = findSessionFile(sid, CFG.home);
      if (!f) continue;
      const m = fs.statSync(f).mtimeMs;
      if (!best || m > best.mtimeMs) best = { sid, mtimeMs: m };
    } catch { /* 单个读不到就跳过 */ }
  }
  return best?.sid ?? null;
}

/** 现状解析（一次读全，三项共用；读不到留 null，由各项自己判 unknown）。 */
function resolveState() {
  const st = { ws: null, wsError: null, wsId: null, archived: new Set(), wsSessionIds: [], currentSid: null, sidWhy: '', liveCount: 0 };
  const ws = readJsonSafe(CFG.wsFile);
  if (ws.ok && ws.value && typeof ws.value === 'object') {
    st.ws = ws.value;
    if (CFG.routerPath) {
      const want = canon(CFG.routerPath);
      for (const [id, rec] of Object.entries(ws.value?.tables?.workspaces ?? {})) if (rec?.path && canon(rec.path) === want) { st.wsId = id; break; }
    }
    st.archived = new Set((Array.isArray(ws.value?.global?.archivedSessionIds) ? ws.value.global.archivedSessionIds : []).map(String));
    const rec = st.wsId ? ws.value?.tables?.workspaces?.[st.wsId] : null;
    st.wsSessionIds = Array.isArray(rec?.sessionIds) ? rec.sessionIds.map(String) : [];
  } else st.wsError = ws.error ?? '解析不出对象';

  // 「当前主会话」= 工作区里唯一一个未归档的会话；0 个可见时回落「最近写过的」→ sessionIds[0]
  const live = st.wsSessionIds.filter((s) => !st.archived.has(s));
  st.liveCount = live.length;
  if (live.length === 1) { st.currentSid = live[0]; st.sidWhy = '工作区唯一未归档会话'; }
  else if (live.length === 0) {
    const newest = newestByMtime(st.wsSessionIds);
    if (newest) { st.currentSid = newest; st.sidWhy = '工作区没有未归档会话（回落到最近写过的那个）'; }
    else if (st.wsSessionIds.length) { st.currentSid = st.wsSessionIds[0]; st.sidWhy = '工作区没有未归档会话（回落到 sessionIds[0]）'; }
    else st.sidWhy = '工作区没有登记会话';
  } else st.sidWhy = `工作区有 ${live.length} 个未归档会话 ⇒ 认不出"当前"是哪个`;
  return st;
}

// ── 第 1 项 · 置顶复位 ─────────────────────────────────────────────────────
async function checkPin(st) {
  const id = 'pin', label = '置顶复位';
  if (!st.ws) return result(id, label, UNKNOWN, `workspace.json 读不到（${st.wsError}）：${CFG.wsFile}`, { sig: 'unknown|pin' });
  if (!CFG.routerPath) return result(id, label, UNKNOWN, '没给目标目录（--router-cwd / ROUTER_GUARD_ROOT）⇒ 不知道该把哪个工作区挪到第一位', { sig: 'unknown|pin' });
  if (!st.wsId) return result(id, label, ALARM, `目标工作区未登记：${CFG.routerPath} 不在 workspace.json 的 tables.workspaces 里`, { sig: 'pin|not-registered' });
  const ids = (st.ws.global?.workspaceIds ?? []).map(String);
  const idx = ids.indexOf(st.wsId);
  if (idx === 0) return result(id, label, OK, `已在第 1 位（共 ${ids.length} 组）`);
  if (idx < 0) return result(id, label, ALARM, '工作区在 tables 里但不在 workspaceIds 顺序表里（界面上看不见）', { sig: 'pin|not-in-order' });
  const detail = `当前第 ${idx + 1} 位（共 ${ids.length} 组）`;
  if (!APPLY) return result(id, label, ALARM, `${detail} —— dry-run 未动，加 --apply 会挪回第 1 位`, { sig: 'pin|not-first', wouldFix: true });
  const r = await rpc('workspace.insertBefore', { workspaceId: st.wsId, beforeWorkspaceId: ids[0] });
  if (!r.ok) return result(id, label, ALARM, `${detail}；insertBefore 失败：${r.error}`, { sig: 'pin|not-first' });
  const top = String(readJsonSafe(CFG.wsFile).value?.global?.workspaceIds?.[0] ?? '');
  return top === st.wsId
    ? result(id, label, FIXED, `已挪回第 1 位（原第 ${idx + 1} 位）`)
    : result(id, label, ALARM, `insertBefore 回执 ok，但回读第 1 位不是它（${CFG.wsFile}）`, { sig: 'pin|not-first' });
}

// ── 第 2 项 · 归档保护 ─────────────────────────────────────────────────────
async function checkArchive(st) {
  const id = 'archive', label = '归档保护';
  if (!st.ws) return result(id, label, UNKNOWN, `workspace.json 读不到（${st.wsError}）`, { sig: 'unknown|archive' });
  if (!st.currentSid) return result(id, label, UNKNOWN, `认不出当前会话（${st.sidWhy}）`, { sig: 'unknown|archive' });
  const counts = `工作区 ${st.wsSessionIds.length} 个会话 / 未归档 ${st.liveCount} 个`;
  if (!st.archived.has(st.currentSid)) return result(id, label, OK, `当前会话 ${shortId(st.currentSid)} 未被归档（${counts}）`);
  if (!APPLY) return result(id, label, ALARM, `当前会话 ${shortId(st.currentSid)} 在 archivedSessionIds 里 —— dry-run 未动，加 --apply 复原`, { sig: 'archive|archived', wouldFix: true });
  const r = await rpc('workspace.unarchiveSession', { sessionId: st.currentSid });
  if (!r.ok) return result(id, label, ALARM, `会话已被归档；unarchiveSession 失败：${r.error}`, { sig: 'archive|archived' });
  const still = new Set((readJsonSafe(CFG.wsFile).value?.global?.archivedSessionIds ?? []).map(String));
  return !still.has(st.currentSid)
    ? result(id, label, FIXED, `已复原会话 ${shortId(st.currentSid)}`)
    : result(id, label, ALARM, `unarchiveSession 回执 ok，但回读仍在归档名单里（${CFG.wsFile}）`, { sig: 'archive|archived' });
}

// ── 第 3 项 · cwd 还在 ─────────────────────────────────────────────────────
async function checkCwd(st) {
  const id = 'cwd', label = 'cwd 还在';
  if (!CFG.routerPath) return result(id, label, UNKNOWN, '没给目标目录（--router-cwd / ROUTER_GUARD_ROOT）', { sig: 'unknown|cwd' });
  let exists = false;
  try { exists = fs.existsSync(CFG.routerPath); } catch (e) {
    return result(id, label, UNKNOWN, `测目录失败（${e?.message ?? e}）：${CFG.routerPath}`, { sig: 'unknown|cwd' });
  }
  if (!st.currentSid) return result(id, label, UNKNOWN, `认不出当前会话（${st.sidWhy}）⇒ 只能验目录（目录${exists ? '在' : '不在'}）`, { sig: 'unknown|cwd' });
  const h = readSessionHeader(st.currentSid, CFG.home);
  const cwd = h?.header?.cwd ?? null;
  if (!h) return result(id, label, UNKNOWN, `会话 header 读不到（${shortId(st.currentSid)}）`, { sig: 'unknown|cwd' });
  if (!cwd) return result(id, label, UNKNOWN, `会话 header 里没有 cwd 字段（${shortId(st.currentSid)}）`, { sig: 'unknown|cwd' });
  if (!exists) return result(id, label, ALARM, `目录不在了：${CFG.routerPath}（header.cwd=${cwd}）—— 本件**不自动建目录**`, { sig: 'cwd|missing' });
  if (canon(cwd) !== canon(CFG.routerPath)) return result(id, label, ALARM, `会话 header.cwd=${cwd} ≠ 目标目录 ${CFG.routerPath}`, { sig: 'cwd|mismatch' });
  return result(id, label, OK, `${CFG.routerPath} 存在，且会话 header.cwd 一致`);
}

// ── 报警去重（只对「站着的报警」；已复位不去重）──────────────────────────────
function loadState() {
  const o = readJsonSafe(CFG.stateFile).value;
  const v = o && typeof o === 'object' ? o : {};
  return { alertMarks: v.alertMarks && typeof v.alertMarks === 'object' ? v.alertMarks : {} };
}
const shouldEmit = (marks, sig, now) => !DEDUPE_MS || !((Number(marks[sig] ?? 0)) && now - Number(marks[sig]) < DEDUPE_MS);
function pruneMarks(marks, now) {
  const keep = Math.max(DEDUPE_MS, 7 * 86_400_000), out = {};
  for (const [k, v] of Object.entries(marks)) {
    // 标记一律存 epoch 毫秒：存 ISO 串的话 Number() = NaN ⇒ 去重永不命中，每轮都重报一遍
    const t = Number.isFinite(Number(v)) ? Number(v) : Date.parse(String(v));
    if (Number.isFinite(t) && now - t < keep) out[k] = t;
  }
  return out;
}

function usage() {
  return [
    `router-guard.mjs v${VERSION} —— 三项巡检（置顶复位 / 归档保护 / cwd 还在）`, '',
    '用法：node router-guard.mjs --router-cwd <dir> [--apply] [--json] [--once] [--quiet] [--no-dedupe] [--dedupe-min N]', '',
    '  --router-cwd <dir>  目标工作区目录（**必填**；也可用 ROUTER_GUARD_ROOT）。不给 ⇒ 依赖它的项记 unknown',
    '  --apply             真修（缺省 dry-run：只报该修什么）',
    '  --json / --once     机读输出 / 兼容定时任务的固定形态',
    '  --quiet             不打 stderr 告警回声（落盘照旧）',
    '  --no-dedupe / --dedupe-min N   关掉 / 调整报警去重窗口（默认 360 分钟）', '',
    '退出码：0 正常（含"有报警"）· 3 环境未就绪、本轮让路 · 1 崩了',
  ].join('\n');
}

export async function main() {
  if (HELP) { process.stdout.write(`${usage()}\n`); return 0; }
  const t0 = Date.now();
  const lock = acquireTickLock('router-guard', { ttlMs: CFG.ttlMs, home: CFG.home });
  if (!lock.ok) {
    if (JSON_OUT) process.stdout.write(`${JSON.stringify({ ok: true, skipped: true, reason: lock.reason ?? 'locked', version: VERSION }, null, 2)}\n`);
    else if (!QUIET) process.stdout.write(`[router-guard] 跳过：${lock.reason ?? 'locked'} —— 另一轮正在跑\n`);
    return 0;
  }
  try {
    const st = resolveState();
    const items = [];
    for (const [id, label, fn] of [['pin', '置顶复位', checkPin], ['archive', '归档保护', checkArchive], ['cwd', 'cwd 还在', checkCwd]]) {
      try { items.push(await fn(st)); } catch (e) {
        // fail-open：单点异常记 unknown，继续下一项（整脚本不崩、不吞）
        items.push(result(id, label, UNKNOWN, `本项异常（fail-open 记 unknown 继续）：${e?.message ?? e}`, { sig: `unknown|${id}` }));
      }
    }

    const now = Date.now();
    const marks = { ...loadState().alertMarks };
    for (const it of items) {
      if (it.status === OK) continue;
      const sig = it.sig || `${it.id}|${it.status}`;
      const head = it.status === FIXED ? '已复位' : it.status === ALARM ? '报警' : '未知';
      if (it.status !== FIXED && !shouldEmit(marks, sig, now)) { it.alerted = 'deduped'; continue; }
      const res = alert(
        { level: it.status === ALARM ? 'warn' : 'info', source: 'router-guard', message: `${head} · ${it.label}：${it.reason}`, detail: { item: it.id, status: it.status, sig, apply: APPLY, version: VERSION, at: new Date(now).toISOString() } },
        { home: CFG.home, silent: QUIET },
      );
      it.alerted = res.ok ? 'written' : `failed:${res.error}`;
      // 修好了 ⇒ 摘掉这一项的「站着」标记，下次真坏还要能报
      if (it.status === FIXED) for (const k of Object.keys(marks)) if (k.startsWith(`${it.id}|`)) delete marks[k];
      else marks[sig] = now;
    }

    const tally = { ok: 0, fixed: 0, alarm: 0, unknown: 0 };
    for (const it of items) tally[it.status] = (tally[it.status] ?? 0) + 1;
    const envReady = Boolean(st.ws);   // 环境就绪的唯一判据：状态文件读得到（读不到 = 这机器上还没初始化）
    const summary = {
      at: new Date(now).toISOString(), atLocal: stamp(now), apply: APPLY, version: VERSION,
      routerPath: CFG.routerPath || null, workspaceId: st.wsId, currentSession: st.currentSid, sessionWhy: st.sidWhy,
      tally, elapsedMs: Date.now() - t0,
      items: items.map((it) => ({ id: it.id, label: it.label, status: it.status, reason: it.reason, wouldFix: it.wouldFix === true, alerted: it.alerted ?? null })),
    };
    try {
      writeJsonAtomic(CFG.stateFile, {
        version: 1, updatedAt: new Date(now).toISOString(),
        lastRun: { at: new Date(now).toISOString(), apply: APPLY, tally, workspaceId: st.wsId, currentSession: st.currentSid },
        alertMarks: pruneMarks(marks, now),
      });
    } catch { /* 状态件写不进不影响巡检结论 */ }

    if (JSON_OUT) process.stdout.write(`${JSON.stringify({ ok: envReady, ...summary }, null, 2)}\n`);
    else {
      const L = [
        `[router-guard] ${summary.atLocal} · apply=${APPLY ? 'ON（会修）' : 'OFF（dry-run，只看不动）'} · v${VERSION}`,
        `  目标目录：${CFG.routerPath || '（未给）'}${st.wsId ? `（${st.wsId}）` : '（未登记）'} · 会话：${st.currentSid ? shortId(st.currentSid) : '认不出'}（${st.sidWhy}）`,
        ...items.map((it, i) => `  ${i + 1}. ${padW(it.label, 10)} ${padW(LABEL[it.status] ?? it.status, 7)} ${it.reason}`),
        `  汇总：ok ${tally.ok} · 已复位 ${tally.fixed} · 报警 ${tally.alarm} · unknown ${tally.unknown} · 用时 ${summary.elapsedMs}ms${tally.alarm + tally.fixed + tally.unknown ? '' : ' · 全绿，无需动作'}`,
      ];
      const deduped = items.filter((it) => it.alerted === 'deduped').length;
      if (deduped) L.push(`  （${deduped} 条 6 小时内报过，本次只记状态不重复落盘；--no-dedupe 可强制）`);
      process.stdout.write(`${L.join('\n')}\n`);
    }
    return envReady ? 0 : 3;
  } finally {
    releaseTickLock('router-guard', { home: CFG.home });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((e) => {
      try { process.stderr.write(`[router-guard] 崩了：${e?.stack ?? e}\n`); } catch { /* stderr 不可写就算了 */ }
      process.exitCode = 1;
    });
}

export { resolveState, checkPin, checkArchive, checkCwd };
