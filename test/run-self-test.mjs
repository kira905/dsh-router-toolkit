#!/usr/bin/env node
/**
 * test/run-self-test.mjs —— 夹具自测（J1–J6）。**不联网、不碰任何真实 home**。
 *
 * 它干的事：造一个临时 DSH home（含 workspace.json / 会话文件 / 状态文件）+ 起一个本地 mock 宿主
 * （只实现本仓用到的 4 个端点），然后**用子进程真跑 CLI**，逐条断言。
 *
 * 每条都以「现跑读数」判定，不是拿历史结果冒充。退出码 0 = 全绿。
 *
 *   node test/run-self-test.mjs            # 跑全部
 *   node test/run-self-test.mjs --keep     # 保留临时目录（排障用）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const KEEP = process.argv.includes('--keep');

const results = [];
const check = (id, name, ok, detail) => {
  results.push({ id, name, ok, detail });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${name}\n      ${detail}\n`);
};

const stamp = Date.now().toString(36);
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), `router-selftest-${stamp}-`));
const HOME = path.join(ROOT, 'home');
const TARGET = path.join(ROOT, 'workdir');
const OTHER = path.join(ROOT, 'other-workdir');
const OPS = path.join(ROOT, 'ops.jsonl');
const STATE = path.join(ROOT, 'state.json');
const LOGDIR = path.join(ROOT, 'log');
const WS_FILE = path.join(HOME, 'storages', 'workspace.json');
const SECRET = Buffer.alloc(32, 7).toString('base64');

const MAIN_SID = 'session-main-1111-2222-3333-444455556666';
const ARCHIVED_SID = 'session-arch-1111-2222-3333-444455556666';
const PEER_SID = 'session-peer-1111-2222-3333-444455556666';

fs.mkdirSync(path.join(HOME, 'storages'), { recursive: true });
fs.mkdirSync(TARGET, { recursive: true });
fs.mkdirSync(OTHER, { recursive: true });
fs.mkdirSync(LOGDIR, { recursive: true });

/** 写一份会话日志：首帧 = header（zstd），够 readSessionHeader 解析即可。 */
function writeSession(sid, { cwd } = {}) {
  const dir = path.join(HOME, 'sessions', 'ws-fixture', sid);
  fs.mkdirSync(dir, { recursive: true });
  const header = { type: 'header', data: { id: sid, origin: 'user', cwd: cwd ?? TARGET } };
  fs.writeFileSync(path.join(dir, 'session.v3.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`, 'utf8')));
}
writeSession(MAIN_SID);
writeSession(PEER_SID, { cwd: OTHER });
writeSession(ARCHIVED_SID);

/** 夹具 workspace.json：router 工作区当前在**第一位**（J4 要全 ok），另一组排后面。 */
function writeWs({ routerFirst = true, archived = [ARCHIVED_SID] } = {}) {
  const doc = {
    global: {
      workspaceIds: routerFirst ? ['ws-router', 'ws-other'] : ['ws-other', 'ws-router'],
      archivedSessionIds: archived,
    },
    tables: {
      workspaces: {
        'ws-router': { path: TARGET, sessionIds: [MAIN_SID] },
        'ws-other': { path: OTHER, sessionIds: [PEER_SID] },
      },
    },
  };
  fs.mkdirSync(path.dirname(WS_FILE), { recursive: true });
  fs.writeFileSync(WS_FILE, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  return doc;
}
writeWs();
// 状态文件：一条未答的拍板请求 + 一条失败卡派生的拍板请求 + 一条已答的（后者不该被算进「待定」）
fs.writeFileSync(STATE, `${JSON.stringify({
  attentions: [
    { cardId: 'card-aaaa1111', question: '发布窗口选周三还是周四？', options: ['周三', '周四'], askedAt: '2026-11-01T10:00:00Z' },
    { cardId: 'card-ffff6666', question: '执行失败（failed）：要不要重试', options: ['重试', '归档', '先放着'], askedAt: '2026-11-01T09:00:00Z' },
    { cardId: 'card-bbbb2222', question: '已答过的', answeredAt: '2026-11-01T11:00:00Z' },
  ],
}, null, 2)}\n`, 'utf8');

const BOARD = {
  revision: 7,
  tasks: [
    { id: 'card-aaaa1111', title: '示例：发布脚本版本号核对', status: 'running', line: '前端线', updatedAt: Date.now() - 60_000 },
    { id: 'card-cccc3333', title: '示例：数据导出补字段', status: 'todo', line: '数据线', updatedAt: Date.now() - 3_600_000 },
    { id: 'card-dddd4444', title: '示例：发布线回滚演练', status: 'review', line: '发布线', updatedAt: Date.now() - 7_200_000 },
    { id: 'card-ffff6666', title: '示例：执行失败的活', status: 'failed', line: '发布线', updatedAt: Date.now() - 900_000 },
    { id: 'card-eeee5555', title: '示例：已完成的活', status: 'done', line: '数据线', updatedAt: Date.now() - 86_400_000 },
  ],
};

const sessionItems = [
  { id: MAIN_SID, running: false, projections: { values: { title: '主会话（夹具）' } } },
  { id: PEER_SID, running: true, projections: { values: { title: '前端线（夹具）' } } },
  { id: ARCHIVED_SID, running: false, projections: { values: { title: '归档夹具会话' } } },
];

const PROMPTS = [];
const RPC_LOG = [];

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const url = req.url.split('?')[0];
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
    const send = (obj, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    RPC_LOG.push({ url, cookie: Boolean(req.headers.cookie) });

    if (url === '/api/task-board/state' && req.method === 'GET') return send({ result: { value: BOARD } });

    if (url === '/api/session/list') return send({ result: { ok: true, value: { items: sessionItems } } });

    if (url === '/api/session/prompt') {
      const args = body?.payload?.args?.request ?? {};
      PROMPTS.push({ sessionId: args.sessionId, mode: args.mode, text: args.content?.[0]?.text ?? '' });
      // 归档会话上的投递：宿主会「受理」但实际没人读 —— mock 里如实受理（闸在客户端拦）
      return send({ result: { ok: true, value: { accepted: true } } });
    }

    if (url === '/api/workspace/insertBefore') {
      const a = body?.payload?.args?.request ?? {};
      const doc = JSON.parse(fs.readFileSync(WS_FILE, 'utf8'));
      const ids = doc.global.workspaceIds.filter((x) => x !== a.workspaceId);
      const at = Math.max(0, ids.indexOf(a.beforeWorkspaceId));
      ids.splice(at, 0, a.workspaceId);
      doc.global.workspaceIds = ids;
      fs.writeFileSync(WS_FILE, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
      return send({ result: { ok: true, value: { workspaceIds: ids } } });
    }

    if (url === '/api/workspace/unarchiveSession') {
      const a = body?.payload?.args?.request ?? {};
      const doc = JSON.parse(fs.readFileSync(WS_FILE, 'utf8'));
      doc.global.archivedSessionIds = (doc.global.archivedSessionIds ?? []).filter((x) => x !== a.sessionId);
      fs.writeFileSync(WS_FILE, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
      return send({ result: { ok: true, value: { archivedSessionIds: doc.global.archivedSessionIds } } });
    }

    return send({ result: { ok: false, error: { code: 'not-found', message: `mock 没实现 ${url}` } } }, 404);
  });
});

const listen = () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

/**
 * 子进程跑 CLI（环境全隔离：home / 流水 / 状态 / 日志目录 / 宿主地址 全是夹具的）。
 * ⚠️ 必须用**异步** spawn：mock 宿主跑在本进程里，同步 spawnSync 会把本进程事件循环堵死，
 *    子进程的 HTTP 请求永远等不到响应（第一版就是这么假红的）。
 */
function run(script, args, extraEnv = {}) {
  const env = {
    ...process.env,
    DSH_HOME: HOME,
    ROUTER_HOME: HOME,
    ROUTER_OPS_FILE: OPS,
    ROUTER_STATE_FILE: STATE,
    ROUTER_LOG_DIR: LOGDIR,
    ROUTER_GUARD_WS_FILE: WS_FILE,
    ROUTER_GUARD_STATE_FILE: path.join(ROOT, 'guard-state.json'),
    ROUTER_GUARD_ROOT: TARGET,
    DSH_WEB_URL: `http://127.0.0.1:${PORT}`,
    DSH_RPC_COOKIE_SECRET: SECRET,
    DSH_SESSION_ID: MAIN_SID,
    ...extraEnv,
  };
  for (const k of Object.keys(extraEnv)) if (extraEnv[k] === null) delete env[k];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(REPO, script), ...args], { env });
    let out = '', err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* */ } }, 30_000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ rc: code, out, err }); });
  });
}

const opsLines = () => {
  try { return fs.readFileSync(OPS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};
const opsCount = () => opsLines().length;

let PORT = 0;

async function main() {
  PORT = await listen();
  process.stdout.write(`夹具根：${ROOT}\n宿主 mock：http://127.0.0.1:${PORT}\n\n`);

  // ── J1 只读车况 ───────────────────────────────────────────────────────────
  {
    const r = await run('router-act.mjs', ['status', '--json']);
    let j = null;
    try { j = JSON.parse(r.out); } catch { /* 下面判 */ }
    const ok = r.rc === 0 && j && Array.isArray(j.lines) && j.lines.length >= 1;
    check('J1', '骨架能自己报出车况（读得到看板）', ok, `rc=${r.rc} · JSON 可解析=${Boolean(j)} · lines=${j?.lines?.length ?? 0} · 待定=${j?.attention?.open ?? '?'}`);
  }

  // ── J2 默认 dry-run ───────────────────────────────────────────────────────
  {
    const before = opsCount();
    const r = await run('router-act.mjs', ['say', '--to', '前端线', '--text', '夹具：这是一句派活']);
    const after = opsLines();
    const last = after[after.length - 1] ?? {};
    const ok = r.rc === 0 && /dry-run/.test(r.out) && after.length === before + 1 && last.dryRun === true && PROMPTS.length === 0;
    check('J2', '投话默认不真投（dry-run 是默认）', ok, `rc=${r.rc} · 输出含 dry-run=${/dry-run/.test(r.out)} · 流水 ${before}→${after.length} · 真投次数=${PROMPTS.length}`);
  }

  // ── J3 真投（唯一一条腿）──────────────────────────────────────────────────
  {
    const before = opsCount();
    const r = await run('router-act.mjs', ['say', '--to', '前端线', '--text', '夹具：真投一句', '--apply']);
    const after = opsLines();
    const last = after[after.length - 1] ?? {};
    const sent = PROMPTS[PROMPTS.length - 1];
    const ok = r.rc === 0 && after.length === before + 1 && last.ok === true && last.dryRun === false
      && sent?.sessionId === PEER_SID && /夹具：真投一句/.test(sent.text);
    check('J3', '投话真投只有一条腿（--apply）', ok, `rc=${r.rc} · 流水 ok=${last.ok} · 目标=${sent?.sessionId === PEER_SID ? '对' : sent?.sessionId} · 正文命中=${/夹具：真投一句/.test(sent?.text ?? '')}`);
  }

  // ── J3b 已归档一律拒 ──────────────────────────────────────────────────────
  {
    const before = opsCount();
    const nPrompt = PROMPTS.length;
    const r = await run('router-act.mjs', ['say', '--to', ARCHIVED_SID, '--text', '夹具：不该投进归档会话', '--apply']);
    const after = opsLines();
    const last = after[after.length - 1] ?? {};
    const ok = r.rc === 5 && after.length === before + 1 && last.ok === false && PROMPTS.length === nPrompt;
    check('J3b', '投给已归档会话一律拒（rc=5 · 流水 ok:false · 目标零变化）', ok, `rc=${r.rc}（期望 5）· 流水 ${before}→${after.length} ok=${last.ok} · 真投增幅=${PROMPTS.length - nPrompt} · gate=${last.extra?.gate ?? '-'}`);
  }

  // ── 自校验闸（补充：不投给自己）───────────────────────────────────────────
  {
    const nPrompt = PROMPTS.length;
    const r = await run('router-act.mjs', ['say', '--to', MAIN_SID, '--text', '夹具：投给自己']);
    const ok = r.rc === 4 && PROMPTS.length === nPrompt;
    check('J2b', '目标是自己 ⇒ 拒（rc=4，dry-run 也拦）', ok, `rc=${r.rc}（期望 4）· 真投增幅=${PROMPTS.length - nPrompt}`);
  }

  // ── J4 巡检三项全绿 + 幂等 ────────────────────────────────────────────────
  {
    writeWs({ routerFirst: true });
    const r1 = await run('router-guard.mjs', ['--router-cwd', TARGET, '--json']);
    let j1 = null;
    try { j1 = JSON.parse(r1.out); } catch { /* 判下面 */ }
    const r2 = await run('router-guard.mjs', ['--router-cwd', TARGET, '--json']);
    let j2 = null;
    try { j2 = JSON.parse(r2.out); } catch { /* 同上 */ }
    const allOk = (j) => Array.isArray(j?.items) && j.items.length === 3 && j.items.every((x) => x.status === 'ok');
    const zeroAction = (j) => j?.tally?.fixed === 0 && j?.tally?.alarm === 0;
    const ok = r1.rc === 0 && r2.rc === 0 && allOk(j1) && allOk(j2) && zeroAction(j2);
    check('J4', '巡检三项全绿且幂等（连跑两次）', ok,
      `rc=${r1.rc}/${r2.rc} · 首次 ${JSON.stringify(j1?.tally)} · 二次 ${JSON.stringify(j2?.tally)} · 三项=${(j2?.items ?? []).map((x) => `${x.id}:${x.status}`).join(',')}`);
  }

  // ── J5 坏一档能自己拨回 ───────────────────────────────────────────────────
  {
    writeWs({ routerFirst: false });
    const dry = await run('router-guard.mjs', ['--router-cwd', TARGET, '--json']);
    let jd = null;
    try { jd = JSON.parse(dry.out); } catch { /* */ }
    const pinDry = jd?.items?.find((x) => x.id === 'pin');
    const fix = await run('router-guard.mjs', ['--router-cwd', TARGET, '--json', '--apply']);
    let jf = null;
    try { jf = JSON.parse(fix.out); } catch { /* */ }
    const pinFix = jf?.items?.find((x) => x.id === 'pin');
    const again = await run('router-guard.mjs', ['--router-cwd', TARGET, '--json']);
    let ja = null;
    try { ja = JSON.parse(again.out); } catch { /* */ }
    const ok = pinDry?.status === 'alarm' && pinFix?.status === 'fixed' && (ja?.items ?? []).every((x) => x.status === 'ok');
    check('J5', '坏一档能自己拨回（dry-run 报 / --apply 修 / 再跑全绿）', ok,
      `dry=${pinDry?.status}（期望 alarm）→ apply=${pinFix?.status}（期望 fixed）→ 再跑=${(ja?.items ?? []).map((x) => x.status).join(',')}`);
  }

  // ── J6 环境没就绪时让路不崩 ───────────────────────────────────────────────
  {
    const r = await run('router-guard.mjs', ['--router-cwd', TARGET, '--json'], { ROUTER_GUARD_WS_FILE: path.join(ROOT, 'no-such-workspace.json') });
    let j = null;
    try { j = JSON.parse(r.out); } catch { /* */ }
    const noStack = !/at\s+\w+\s+\(/.test(r.err) && !/Error:/.test(r.err);
    const ok = r.rc === 3 && noStack && Array.isArray(j?.items) && j.items.length === 3;
    check('J6', '环境没就绪时让路不崩（rc=3 · 无 stack · 三项照跑）', ok,
      `rc=${r.rc}（期望 3）· 无 stack=${noStack} · items=${j?.items?.length ?? 0} · 状态=${(j?.items ?? []).map((x) => `${x.id}:${x.status}`).join(',')}`);
  }

  // ── 结论档：digest 幂等 + reset 不清空 ────────────────────────────────────
  {
    const d1 = await run('router-act.mjs', ['digest', '--line', '前端线', '--text', '夹具结论', '--apply']);
    const d2 = await run('router-act.mjs', ['digest', '--line', '前端线', '--text', '夹具结论改一下', '--apply']);
    const docs = fs.existsSync(LOGDIR) ? fs.readdirSync(LOGDIR).filter((f) => /^router-\d{6}\.md$/.test(f)) : [];
    const doc = docs.length ? path.join(LOGDIR, docs[0]) : null;
    const text = doc ? fs.readFileSync(doc, 'utf8') : '';
    const rows = text.split('\n').filter((l) => /^-\s+\d{4}-\d{2}-\d{2}｜/.test(l));
    const r1 = await run('router-act.mjs', ['reset', '--apply']);
    const afterReset = doc ? fs.readFileSync(doc, 'utf8') : '';
    const ok = d1.rc === 0 && d2.rc === 0 && rows.length === 1 && /幂等/.test(d2.out)
      && r1.rc === 0 && afterReset.includes('接续头') && afterReset.includes('前端线');
    check('J-extra', 'digest 幂等（同线同日只一行）+ reset 只追加不清空', ok,
      `digest rc=${d1.rc}/${d2.rc} · 结论行=${rows.length}（期望 1）· 幂等提示=${/幂等/.test(d2.out)} · reset 段=已在档尾`);
  }

  // ── 未知动词 / 未知参数 fail-closed ───────────────────────────────────────
  {
    const bad = await run('router-act.mjs', ['nope']);
    const noCard = await run('router-act.mjs', ['card-show']);
    const badCmd = await run('router-act.mjs', ['say', '--to', '前端线', '--text', 'x', '--cmd', 'frobnicate']);
    const badPrio = await run('router-act.mjs', ['say', '--to', '前端线', '--text', 'x', '--prio', 'yesterday']);
    const ok = bad.rc !== 0 && noCard.rc === 2 && badCmd.rc === 2 && badPrio.rc === 2;
    check('J-extra2', '未知动词 / 缺必填 / 越界枚举 ⇒ fail-closed（rc≠0）', ok,
      `unknown-verb rc=${bad.rc} · 缺 --card rc=${noCard.rc} · 越界 --cmd rc=${badCmd.rc} · 越界 --prio rc=${badPrio.rc}`);
  }

  // ── 每个动词 --help 都是用法、不写盘 ──────────────────────────────────────
  {
    const nOpsBefore = opsCount();
    const rows = [];
    for (const v of ['status', 'brief', 'card-show', 'say', 'digest', 'reset', 'wake']) {
      const r = await run('router-act.mjs', [`${v}`, '--help']);
      rows.push(`${v}:${r.rc}`);
    }
    const g = await run('router-guard.mjs', ['--help']);
    const ok = rows.every((x) => x.endsWith(':0')) && g.rc === 0 && opsCount() === nOpsBefore;
    check('J-extra3', '逐动词 --help rc=0 且不写盘', ok, `${rows.join(' ')} · guard:${g.rc} · 流水无新增=${opsCount() === nOpsBefore}`);
  }

  // ── R-3：未知 flag 一律 fail-closed（写动词带 --apply 也拦）───────────────
  {
    const logSnap = () => {
      if (!fs.existsSync(LOGDIR)) return '[]';
      return JSON.stringify(fs.readdirSync(LOGDIR).sort().map((f) => {
        const p = path.join(LOGDIR, f);
        const buf = fs.statSync(p).isFile() ? fs.readFileSync(p) : Buffer.alloc(0);
        return [f, createHash('sha256').update(buf).digest('hex').slice(0, 16)];
      }));
    };
    const before = { log: logSnap(), ops: opsCount(), prompts: PROMPTS.length };
    const dig = await run('router-act.mjs', ['digest', '--line', 'R3夹具线', '--text', '这一行不该落盘', '--apply', '--bogus-flag']);
    const say = await run('router-act.mjs', ['say', '--to', '前端线', '--text', '这一句不该投出去', '--apply', '--bogus-flag']);
    const readOnly = await run('router-act.mjs', ['status', '--json', '--bogus-flag']);
    const reset = await run('router-act.mjs', ['reset', '--apply', '--bogus-flag']);
    const typo = await run('router-act.mjs', ['digest', '--line', 'R3夹具线', '--text', '笔误 --aply', '--aply']);
    const after = { log: logSnap(), ops: opsCount(), prompts: PROMPTS.length };
    const runs = [dig, say, readOnly, reset, typo];
    const rcAll2 = runs.every((r) => r.rc === 2);
    const hints = runs.every((r) => /用法：node router-act\.mjs/.test(`${r.out}${r.err}`) && /不认识的参数/.test(r.err));
    const ok = rcAll2 && hints && before.log === after.log && before.ops === after.ops && before.prompts === after.prompts;
    check('J-extra4', '未知 flag ⇒ rc=2 且零写入（结论档 sha / 流水 / 真投全不变）', ok,
      `rc dig=${dig.rc} say=${say.rc} status=${readOnly.rc} reset=${reset.rc} 笔误--aply=${typo.rc}（期望全 2）`
      + ` · 打印用法=${hints} · 结论档${before.log === after.log ? '未变' : '变了'}`
      + ` · 流水 ${before.ops}→${after.ops} · 真投增幅=${after.prompts - before.prompts}`);
  }

  // ── J7 brief 第 3 行：失败卡不上桌（明细只放真等人拍的）──────────────────
  {
    const r = await run('router-act.mjs', ['brief', '--json']);
    let j = null;
    try { j = JSON.parse(r.out); } catch { /* 下面判 */ }
    const lines = j?.brief ?? [];
    const line3 = lines[2] ?? '';
    const onlyFailedTitle = '示例：执行失败的活';
    const ok = r.rc === 0 && lines.length === 3
      && j?.needsOwner?.failedAttentions === 1 && j?.needsOwner?.asks === 1 && j?.needsOwner?.reviews === 1
      && /要你定/.test(line3) && /其中失败卡 1 件/.test(line3) && !line3.includes(onlyFailedTitle)
      && !/执行失败/.test(line3);
    check('J7', 'brief 仍严格三行；失败卡只折叠成计数、不进明细', ok,
      `rc=${r.rc} · 行数=${lines.length}（期望 3）· needsOwner=${JSON.stringify(j?.needsOwner)} · 明细含失败卡=${line3.includes(onlyFailedTitle)}`);
  }

  // ── J8 接续头压缩：取料 / 写盘 / 校验 / selftest（一个件四条腿）──────────
  {
    const fix = path.join(ROOT, 'headfix');
    fs.mkdirSync(fix, { recursive: true });
    const frames = [
      { type: 'header', data: { id: 'session-headfix-0000', cwd: TARGET } },
      { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '把发布脚本的版本号改成多少？' }] } },
      { type: 'assistant/message', data: { role: 'assistant', content: [{ type: 'reasoning', text: '嗯…我得先想一下。'.repeat(20) }, { type: 'text', text: '改成次版本号就行。' }] } },
    ];
    fs.writeFileSync(path.join(fix, 'session.v3.jsonl.zstd'), Buffer.concat(frames.map((f) => zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(f)}\n`, 'utf8')))));

    const outDir = path.join(ROOT, 'headout');
    const gen = await run('lib/router-head.mjs', ['--from-session', fix, '--write', outDir, '--json']);
    let g = null;
    try { g = JSON.parse(gen.out); } catch { /* 下面判 */ }
    const wrote = Boolean(g?.wouldWriteTo) && fs.existsSync(g.wouldWriteTo);
    const headFile = g?.wouldWriteTo ?? path.join(outDir, 'none.md');
    const chk = await run('lib/router-head.mjs', ['--check', headFile, '--json']);
    let c = null;
    try { c = JSON.parse(chk.out); } catch { /* 下面判 */ }
    const badFile = path.join(ROOT, 'bad-head.md');
    fs.writeFileSync(badFile, '# 接续头 · 2026-11-05 00:00\n- 甲：x\n- 乙：y', 'utf8');
    const bad = await run('lib/router-head.mjs', ['--check', badFile]);
    const st = await run('lib/router-head.mjs', ['--selftest']);
    const help = await run('lib/router-head.mjs', ['--help']);
    const ok = gen.rc === 0 && /^把发布脚本的版本号改成多少/.test(g?.raw?.lastUser ?? '')
      && wrote && /- 在聊：/.test(g?.head ?? '') && c?.ok === true && chk.rc === 0
      && bad.rc === 1 && st.rc === 0 && help.rc === 0;
    check('J8', '接续头：取料→写盘→校验全绿，坏头 rc=1，selftest 全绿', ok,
      `gen rc=${gen.rc} · 原料=${(g?.raw?.lastUser ?? '').slice(0, 12)}… · 写盘=${wrote} · check rc=${chk.rc} ok=${c?.ok} · 坏头 rc=${bad.rc}（期望 1）· selftest rc=${st.rc} · help rc=${help.rc}`);
  }

  // ── J9 brief --gaps：愿景缺口另起一段（不占那三行）────────────────────────
  {
    const vdir = path.join(ROOT, 'vision');
    fs.mkdirSync(vdir, { recursive: true });
    fs.writeFileSync(path.join(vdir, 'line-a.json'), JSON.stringify({
      line: '发布线',
      asks: [{ id: 'v1', kind: 'self-todo', what: '把回滚演练补上' }],
    }), 'utf8');
    const env = { ROUTER_VISION_DIR: vdir, ROUTER_PRIORITY_FILE: path.join(ROOT, 'no-priority.json') };
    const r = await run('router-act.mjs', ['brief', '--gaps', '--json'], env);
    let j = null;
    try { j = JSON.parse(r.out); } catch { /* 下面判 */ }
    const lines = j?.brief ?? [];
    const g0 = (j?.visionGaps ?? [])[0];
    const ok = r.rc === 0 && lines.length === 5 && /愿景差距（Top-3）：/.test(lines[3] ?? '')
      && g0?.line === '发布线' && g0?.tier === 'C' && /差：把回滚演练补上/.test(lines[4] ?? '');
    check('J9', 'brief --gaps 另起一段「愿景差距」，三行车况一字不动', ok,
      `rc=${r.rc} · 总行数=${lines.length}（期望 5）· gaps=${(j?.visionGaps ?? []).length} · Top1=${g0?.line}/${g0?.tier}`);
    // 不带 --gaps 时必须仍严格三行（同一份夹具）
    const plain = await run('router-act.mjs', ['brief', '--json'], env);
    let p = null;
    try { p = JSON.parse(plain.out); } catch { /* 下面判 */ }
    check('J9b', '不带 --gaps ⇒ 严格三行（旧行为不许被新功能撑长）', (p?.brief ?? []).length === 3,
      `行数=${(p?.brief ?? []).length}（期望 3）`);
  }

  // ── 汇总 ──────────────────────────────────────────────────────────────────
  const fail = results.filter((r) => !r.ok);
  process.stdout.write(`\n══ 合计 ${results.length} 项 · PASS ${results.length - fail.length} · FAIL ${fail.length}\n`);
  if (fail.length) process.stdout.write(`失败项：${fail.map((f) => f.id).join(', ')}\n`);
  if (KEEP) process.stdout.write(`（--keep：夹具根保留在 ${ROOT}）\n`);
  server.close();
  if (!KEEP) { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* 清不掉不影响结论 */ } }
  process.exitCode = fail.length ? 1 : 0;
}

main().catch((e) => {
  process.stderr.write(`自测崩了：${e?.stack ?? e}\n`);
  try { server.close(); } catch { /* */ }
  process.exitCode = 1;
});
