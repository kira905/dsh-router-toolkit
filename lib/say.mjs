#!/usr/bin/env node
/**
 * lib/say.mjs —— **最小投话件**：把一句话投给另一个 DSH 会话。
 *
 * 它是 `router-act say` 的唯一投递腿（骨架里没有第二条投递路径）。
 *
 * ── 两道闸（拦点都在**打印预览之前**）──────────────────────────────────────
 *   ① 自校验闸：目标 == 自己（`DSH_SESSION_ID`）⇒ rc=4。**dry-run 也拦**。
 *      理由：预览看着完全正常、实际投给自己，是最难自察的一种错（历史事故形态）。
 *   ② 归档闸：目标在 `<home>/storages/workspace.json#global.archivedSessionIds` 里 ⇒ rc=5。
 *      理由：投给已归档会话是白投 —— 宿主在 `agent/pre-step` 拒掉这次投递、回合以
 *      `blocked` 收尾、**不发模型请求**，而投递接口仍回"已受理" ⇒ 投递方拿到"已通知"的假象。
 *      ⚠️ 别把它与「认领/恢复一个会话会让它继续跑」混为一谈 —— 那是 `session.create`
 *      路径的行为，不是 `session.prompt` 路径的行为。
 *   ③「已交接」闸：**默认关**。它是某些部署自己的交棒语义（标题里带标记就不投），
 *      不属于通用能力 ⇒ 要就开 `ROUTER_SAY_HANDOFF_GATE=1` + `ROUTER_SAY_HANDOFF_MARK`。
 *
 * ── 读不到就明说（绝不静默放行）────────────────────────────────────────────
 *   归档名单读不到 ⇒ 打印一行「⚠️ 读不到归档名单，本次未做归档闸」后继续。
 *   取不到 `DSH_SESSION_ID` ⇒ 打印「⚠️ 取不到 DSH_SESSION_ID，本次未做自校验」后继续。
 *
 * 退出码：0 成功/dry-run · 1 投递失败 · 2 用法错 · 3 目标不唯一或找不到 · 4 目标是自己 · 5 目标已归档
 */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { hostRpc } from './host-rpc.mjs';
import { resolveHome } from './home.mjs';

export const EXIT = { OK: 0, FAIL: 1, USAGE: 2, NOT_FOUND: 3, SELF: 4, ARCHIVED: 5 };
export const MODES = ['queue', 'steer'];
export const NO_SELF_NOTE = '⚠️ 取不到 DSH_SESSION_ID，本次未做自校验';
export const DEFAULT_HANDOFF_MARK = '【已交接】';

// ── 归档名单（只读；内联最小实现，不为它单开一个文件）───────────────────────
//   名单真源 = `<home>/storages/workspace.json` 的 `global.archivedSessionIds`。
//   元素形态有两种（裸 id / `session-<uuid>`）⇒ 比较一律走 sidKey，别拿原串直接比。
/** 会话 id 的比较键（**唯一**口径）。 */
export const sidKey = (v) => String(v ?? '').trim().toLowerCase().replace(/^session-/, '');

/**
 * 读已归档会话名单。
 * @returns {{ok:boolean, ids:Set<string>, file:string, reason:string|null}}
 *   `ok:false` ⇒ 读不到 / 解析失败 / 形状不认识；调用方**必须**把 reason 打出来。
 */
export function readArchived(home) {
  const root = resolveHome(home ?? process.env.DSH_HOME);
  const file = path.join(root, 'storages', 'workspace.json');
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { ok: false, ids: new Set(), file, reason: `${file} 读不到或解析失败（${e?.code ?? e?.message ?? e}）` };
  }
  const raw = doc?.global?.archivedSessionIds;
  // 形状不认识 ≠ 名单为空：宁可报「读不到」，也不假装"没有归档的"（那是最坏的一种放行）
  if (!Array.isArray(raw)) return { ok: false, ids: new Set(), file, reason: `${file} 里没有 global.archivedSessionIds 数组（形状不认识）` };
  return { ok: true, ids: new Set(raw.filter((x) => typeof x === 'string').map(sidKey)), file, reason: null };
}

/** 闸门话术（CLI 打印与夹具断言共用这一份，别各写一份）。 */
export const GATE_MSG = {
  self: '✗ 目标就是你自己 —— 没投。自测请显式加 --allow-self。',
  archived: '✗ 目标已在归档名单（storages/workspace.json#global.archivedSessionIds）—— 已归档的会话不投。\n'
    + '  真要投：先让宿主 unarchive 那个会话（RPC workspace/unarchiveSession），或换一条活的会话。',
  handoff: '✗ 目标标题带已交接标记 —— 默认拒投（这是本部署启用的可选闸）。\n'
    + '  确认你就是要投旧棒：显式加 --allow-handoff。',
  noList: '⚠️ 读不到归档名单，本次未做归档闸',
  allowSelf: '⚠️ --allow-self：目标就是你自己，已放行（仅自测用）',
  allowHandoff: '⚠️ --allow-handoff：目标标题带已交接标记，已放行',
};

const norm = (v) => String(v ?? '').trim();

/** 会话 id 取值的唯一来源（宿主给 `sessionId`，夹具常给 `id`）。 */
export function sidOf(item) {
  return String(item?.sessionId ?? item?.id ?? '');
}

/** 标题取值的唯一来源：宿主把标题放在 `projections.values.title`，顶层 `title` 常空。 */
export function titleOf(item) {
  const t = item?.projections?.values?.title ?? item?.title;
  return typeof t === 'string' ? t : '';
}

/**
 * 目标解析（**绝不猜**）：完整 id 直投；否则按「sid 前缀 / 标题子串」找候选，
 * **命中恰好 1 个**才算命中；0 个或多个 ⇒ `hit:null` + 候选列表。
 */
export function resolveTarget(items, to) {
  const want = norm(to);
  const list = Array.isArray(items) ? items : [];
  if (!want) return { hit: null, cands: [] };
  const exact = list.find((it) => sidOf(it) === want);
  if (exact) return { hit: exact, cands: [] };
  const byId = list.filter((it) => {
    const sid = sidOf(it);
    return sid.startsWith(want) || sid.replace(/^session-/, '').startsWith(want);
  });
  const byTitle = list.filter((it) => titleOf(it).includes(want));
  const all = [...byId, ...byTitle.filter((x) => !byId.includes(x))];
  if (all.length === 1) return { hit: all[0], cands: [] };
  return { hit: null, cands: all };
}

/** 目标是不是「我自己」：两边都非空且逐字相等。 */
export function isSelf(targetSid, selfSid) {
  const a = norm(targetSid);
  const b = norm(selfSid);
  return Boolean(a) && Boolean(b) && a === b;
}

/**
 * 投递闸判定（纯函数，DSH 无副作用）。
 * @returns {{blocked:boolean, rc:number, reason:'archived'|'handoff'|'ok'|'no-list'|'allow-handoff'}}
 */
export function deliveryGate({ targetSid = '', targetTitle = '', archivedIds = null, allowHandoff = false, handoffMark = DEFAULT_HANDOFF_MARK } = {}) {
  const key = sidKey(targetSid);
  if (archivedIds instanceof Set && key && archivedIds.has(key)) return { blocked: true, rc: EXIT.ARCHIVED, reason: 'archived' };
  const mark = norm(handoffMark);
  if (mark && String(targetTitle ?? '').includes(mark)) {
    return allowHandoff
      ? { blocked: false, rc: EXIT.OK, reason: 'allow-handoff' }
      : { blocked: true, rc: EXIT.ARCHIVED, reason: 'handoff' };
  }
  return { blocked: false, rc: EXIT.OK, reason: archivedIds instanceof Set ? 'ok' : 'no-list' };
}

/** 「已交接」闸是不是开着（默认关；开了才读标记）。 */
export function handoffGateEnabled() {
  return process.env.ROUTER_SAY_HANDOFF_GATE === '1';
}

/** 取会话表。 */
export async function sessionList(base, opts = {}) {
  const r = await hostRpc(base, 'session.list', {}, opts);
  if (!r.ok) throw new Error(`session.list 失败：${r.error?.message ?? 'unknown'}`);
  const v = r.value ?? {};
  return Array.isArray(v.items) ? v.items : [];
}

const HELP = `最小投话（session.prompt 的薄封装 · 默认 dry-run）

用法：node lib/say.mjs --to <会话id|标题子串> --text "…" [--apply] [选项]

  --to <目标>          完整 sessionId / sid 前缀 / 标题子串（不唯一会列候选、一个都不投）
  --text "…" | --file <路径>   正文（二选一）
  --mode queue|steer   默认 queue（目标当前回合跑完再送）；steer = step 边界插话
  --apply              真投（缺省只预览）
  --allow-self         显式放行"投给自己"（自测用）
  --allow-handoff      显式放行"标题带已交接标记"（需先开 ROUTER_SAY_HANDOFF_GATE=1）
  --list [--grep <子串>]  只读列会话

环境：DSH_WEB_URL（默认 http://127.0.0.1:3080）· DSH_RPC_COOKIE_SECRET · DSH_HOME · DSH_SESSION_ID
退出码：0 成功/dry-run · 1 投递失败 · 2 用法错 · 3 目标不唯一/找不到 · 4 目标是自己 · 5 目标已归档`;

/**
 * 投话主流程（CLI 与 router-act 都调它）。
 * @returns {Promise<{rc:number, ok:boolean, sid?:string, target?:object, body?:string, notes:string[], error?:string}>}
 */
export async function say({ to, text, mode = 'queue', apply = false, allowSelf = false, allowHandoff = false, base, opts = {} } = {}) {
  const notes = [];
  const url = base ?? (process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080');
  const body = String(text ?? '');
  const selfSid = norm(process.env.DSH_SESSION_ID);

  if (!norm(to) || !body.trim()) return { rc: EXIT.USAGE, ok: false, notes, error: '缺 --to 或正文（空正文不投：投话是真打扰）' };
  if (!MODES.includes(mode)) return { rc: EXIT.USAGE, ok: false, notes, error: `--mode 只支持 ${MODES.join('|')}，收到 "${mode}"` };

  let items;
  try {
    items = await sessionList(url, opts);
  } catch (e) {
    return { rc: EXIT.FAIL, ok: false, notes, error: String(e?.message ?? e) };
  }

  const { hit, cands } = resolveTarget(items, to);
  if (!hit) {
    const what = cands.length ? `目标不唯一（${cands.length} 个候选）—— 用完整 id 或更长的名字` : `找不到目标："${to}"`;
    return { rc: EXIT.NOT_FOUND, ok: false, notes, error: what, cands: cands.slice(0, 10).map((c) => ({ sid: sidOf(c), title: titleOf(c), running: Boolean(c.running) })) };
  }

  const sid = sidOf(hit);
  // ① 自校验闸（在预览之前）
  if (!selfSid) notes.push(NO_SELF_NOTE);
  if (isSelf(sid, selfSid)) {
    if (!allowSelf) return { rc: EXIT.SELF, ok: false, sid, target: hit, notes, error: GATE_MSG.self };
    notes.push(GATE_MSG.allowSelf);
  }

  // ② 归档闸（在预览之前）+ ③ 可选已交接闸
  const list = readArchived(process.env.DSH_HOME);
  if (!list.ok) notes.push(`${GATE_MSG.noList}（${list.reason}）`);
  const gate = deliveryGate({
    targetSid: sid,
    targetTitle: titleOf(hit),
    archivedIds: list.ok ? list.ids : null,
    allowHandoff: allowHandoff || !handoffGateEnabled(),
    handoffMark: process.env.ROUTER_SAY_HANDOFF_MARK || DEFAULT_HANDOFF_MARK,
  });
  if (gate.blocked) {
    return { rc: gate.rc, ok: false, sid, target: hit, notes, error: gate.reason === 'archived' ? GATE_MSG.archived : GATE_MSG.handoff };
  }
  if (gate.reason === 'allow-handoff') notes.push(GATE_MSG.allowHandoff);

  if (!apply) return { rc: EXIT.OK, ok: true, sid, target: hit, body, notes, dryRun: true };

  const r = await hostRpc(url, 'session.prompt', {
    requestId: randomUUID(), sessionId: sid, mode, content: [{ type: 'text', text: body }],
  }, opts);
  if (r.ok) return { rc: EXIT.OK, ok: true, sid, target: hit, body, notes, dryRun: false };
  return { rc: EXIT.FAIL, ok: false, sid, target: hit, body, notes, error: `投递失败：${r.error?.code ?? ''} ${r.error?.message ?? ''}`.trim() };
}

function isDirectRun() {
  try {
    const self = fileURLToPath(import.meta.url);
    const entry = process.argv[1];
    if (!entry) return false;
    return fs.realpathSync(entry).toLowerCase() === fs.realpathSync(self).toLowerCase();
  } catch { return false; }
}

async function cli(argv) {
  const has = (f) => argv.includes(f);
  const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
  if (has('--help') || has('-h') || !argv.length) {
    process.stdout.write(`${HELP}\n`);
    return argv.length ? EXIT.OK : EXIT.USAGE;
  }
  const url = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080';

  if (has('--list')) {
    const items = await sessionList(url);
    const grep = norm(val('--grep', ''));
    const rows = items.filter((it) => !grep || titleOf(it).includes(grep) || sidOf(it).includes(grep));
    process.stdout.write(`会话 ${items.length} 个${grep ? `（--grep "${grep}" ⇒ ${rows.length}）` : ''}：\n`);
    for (const it of rows) {
      process.stdout.write(`${it.running ? '▶' : ' '} ${sidOf(it)}  ${titleOf(it).slice(0, 60) || '（无标题）'}\n`);
    }
    return EXIT.OK;
  }

  let text = val('--text', '');
  const file = val('--file');
  if (file) {
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
      process.stderr.write(`读 --file 失败：${e.message}\n`);
      return EXIT.USAGE;
    }
  }

  const res = await say({
    to: val('--to'), text, mode: norm(val('--mode', 'queue')),
    apply: has('--apply'), allowSelf: has('--allow-self'), allowHandoff: has('--allow-handoff'), base: url,
  });
  for (const n of res.notes) process.stdout.write(`${n}\n`);
  if (res.error) process.stderr.write(`${res.error}\n`);
  if (res.cands?.length) {
    for (const c of res.cands) process.stderr.write(`  ${c.running ? '▶' : ' '} ${c.sid}  ${c.title.slice(0, 60)}\n`);
  }
  if (res.sid && res.ok) {
    process.stdout.write(`[${res.dryRun ? 'dry-run' : 'apply'}] 目标 ${res.sid}${res.target?.running ? '（▶在跑）' : '（空闲）'}\n`);
    process.stdout.write(`  标题：${titleOf(res.target).slice(0, 70) || '（无标题）'}\n`);
    process.stdout.write(`  正文（${Buffer.byteLength(res.body, 'utf8')} B）：\n---\n${res.body}\n---\n`);
    process.stdout.write(res.dryRun ? '  （未投递；加 --apply 真投）\n' : '  ✅ 已投递\n');
  }
  return res.rc;
}

if (isDirectRun()) {
  cli(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((e) => { process.stderr.write(`[say] 崩了：${e?.stack ?? e}\n`); process.exitCode = EXIT.FAIL; });
}

export default { say, EXIT, resolveTarget, sidOf, titleOf, deliveryGate, sessionList, GATE_MSG };
