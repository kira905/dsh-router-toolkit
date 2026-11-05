// dsh-router-toolkit / test/test-yearring-index.mjs —— yearring-index.mjs 夹具（沙盒，不碰生产）
// 运行：node test/test-yearring-index.mjs
//
// 覆盖：
//   ① 好 json：计数（总/A/C）、askTop 取谁、jsonStatus=ok、isVision、humanDocExists
//   ② 缺字段（无 line / 无 asks[]）：jsonStatus=missing、不当愿景件、不抛
//   ③ 坏 JSON：jsonStatus=broken、不抛、别的线照常索引
//   ④ 目录不存在：lines 空 + note、不抛
//   ⑤ CLI：{--json} 结构、坏/缺目录两档 **rc 恒 0**、且**绝不写盘**
//   ⑥ 目录解析：`--dir` > env `ROUTER_VISION_DIR`；humanDoc 的相对路径按「档目录」与它的上一级各试一次
//
// 🔴 全部数据都在 os.tmpdir() 下现造：不读任何真实目录、不依赖本机路径、不联网。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanYearring, rankAsks, tierOfKind, resolveVisionDir } from '../yearring-index.mjs';

const CLI = fileURLToPath(new URL('../yearring-index.mjs', import.meta.url));
const SANDBOX = path.join(os.tmpdir(), `yearring-index-test-${Date.now()}`);
fs.mkdirSync(SANDBOX, { recursive: true });

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ''}`); }
};
/** 跑 CLI：`ROUTER_VISION_DIR` 强制清空，避免本机 env 把夹具结果带偏。 */
const run = (args = [], extraEnv = {}) => {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ROUTER_VISION_DIR: '', ...extraEnv },
  });
  return { out: (r.stdout ?? '') + (r.stderr ?? ''), code: r.status };
};
const mk = (dir, name, content) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8');
};

const ASKS = [
  { id: 'A1', kind: 'blocked-by-owner', what: '名字未定' },
  { id: 'A2', kind: 'blocked-by-owner', what: '调度权给不给' },
  { id: 'B1', kind: 'capability-gap', what: '缺跨机统一' },
  { id: 'C1', kind: 'self-todo', what: '把 collision 四条判据补齐' },
  { id: 'C2', kind: 'self-todo', what: '槽位注入自检' },
  { id: 'X9', kind: 'brand-new-kind', what: '没见过的 kind' },
];

console.log('① 好 json（全字段）');
const D1 = path.join(SANDBOX, 'good');
mk(D1, 'example-line.json', {
  line: '示例线 · 判据', version: 'v9.9', updatedAt: '2026-11-02T07:01:37.392Z', humanDoc: '愿景-示例线.md', asks: ASKS,
});
mk(D1, '愿景-示例线.md', '# 愿景（夹具）\n');
const s1 = scanYearring(D1);
const L1 = s1.lines[0];
ok(s1.lines.length === 1, '只索引到 1 条线', s1.lines.length);
ok(L1.jsonStatus === 'ok' && L1.isVision === true, '状态 ok 且算愿景件', L1.jsonStatus);
ok(L1.asksTotal === 6, 'asksTotal = 6', L1.asksTotal);
ok(L1.askA === 2 && L1.askB === 2 && L1.askC === 2, 'A/B/C 各 2（未知 kind 按 B 计）', { A: L1.askA, B: L1.askB, C: L1.askC });
ok(L1.askTop?.id === 'C1' && L1.askTop?.tier === 'C', 'askTop 取 C 类里第一条（C1）', L1.askTop);
ok(L1.humanDocExists === true, 'humanDoc 存在 ⇒ true', L1.humanDoc);
ok(s1.totals.vision === 1 && s1.totals.asksTotal === 6, 'totals 汇总正确', s1.totals);
ok(s1.warnings.some((w) => w.includes('brand-new-kind')), '未映射 kind 进 warnings（不静默吞）', s1.warnings);

// rankAsks / tierOfKind 单件
ok(rankAsks(ASKS).map((a) => a.id).join(',') === 'C1,C2,B1,X9,A1,A2', 'rankAsks 顺序 = C → B → A（同档按原序）', rankAsks(ASKS).map((a) => a.id));
ok(tierOfKind('self-todo').tier === 'C' && tierOfKind('blocked-by-owner').tier === 'A', 'kind→tier 映射');
ok(tierOfKind('???').tier === 'B' && tierOfKind('???').known === false, '未知 kind ⇒ B 且标 known:false');

console.log('\n② 缺字段 / 非愿景件');
const D2 = path.join(SANDBOX, 'missing');
mk(D2, 'capability.json', { generatedAt: '2026-11-02', humanDoc: '能力-20261102.md', capabilities: [], inUse: [] });
mk(D2, 'no-asks.json', { line: '某线', version: 'v1', updatedAt: '2026-11-01T00:00:00Z' });
const s2 = scanYearring(D2);
ok(s2.lines.length === 2, '两条都列出来（不静默丢）', s2.lines.length);
ok(s2.lines.every((l) => l.jsonStatus === 'missing'), '两条都是 missing（缺 line / 缺 asks[]）', s2.lines.map((l) => l.jsonStatus));
ok(s2.lines.every((l) => l.isVision === false), '缺字段的不当愿景件', s2.lines.map((l) => l.isVision));
ok(s2.totals.missing === 2 && s2.totals.vision === 0, 'totals：missing 2 / vision 0', s2.totals);
ok(s2.lines.some((l) => l.line.includes('capability')), '没有 line 的用文件名兜个名字（不空着）', s2.lines.map((l) => l.line));

console.log('\n③ 坏 JSON + 好 json 混在一处');
const D3 = path.join(SANDBOX, 'mixed');
mk(D3, 'broken.json', '{"line": "断掉的线", "asks": [');
mk(D3, 'ok.json', { line: '好线', version: 'v1', updatedAt: '2026-11-02T00:00:00Z', humanDoc: '没有这份.md', asks: [{ id: 'A1', kind: 'blocked-by-owner', what: '等操作者' }] });
const s3 = scanYearring(D3);
const b = s3.lines.find((l) => l.jsonStatus === 'broken');
const g = s3.lines.find((l) => l.jsonStatus === 'ok');
ok(!!b && b.isVision === false, '坏 json ⇒ broken 且不算愿景件', b);
ok(s3.warnings.some((w) => w.includes('broken.json') && w.includes('坏 JSON')), '坏 json 进 warnings（报黄）', s3.warnings);
ok(!!g && g.line === '好线' && g.askTop?.id === 'A1', '同一目录里好 json 照常索引（一个坏的不带崩全目录）', g);
ok(g?.humanDocExists === false, 'humanDoc 不在 ⇒ false（不猜）', g?.humanDocExists);
ok(s3.totals.broken === 1 && s3.totals.vision === 1, 'totals：broken 1 / vision 1', s3.totals);

console.log('\n④ 目录不存在');
let threw = null;
let s4 = null;
try { s4 = scanYearring(path.join(SANDBOX, 'nope')); } catch (e) { threw = e; }
ok(threw === null, '目录不存在**不抛**', threw && String(threw));
ok(s4 && s4.lines.length === 0, 'lines 空', s4?.lines);
ok(s4 && /目录不存在|读不动/.test(s4.note), 'note 说清原因', s4?.note);
ok(s4 && s4.warnings.length > 0, 'warnings 非空（报黄）', s4?.warnings);

console.log('\n⑤ CLI · --json 结构 + rc 恒 0 + 不写盘');
const before = fs.readdirSync(D3).sort().join(',');
const cliGood = run(['--json', '--dir', D3]);
ok(cliGood.code === 0, 'CLI 跑混合目录（含坏 json）rc=0', cliGood.code);
let j = null;
try { j = JSON.parse(cliGood.out); } catch { j = null; }
ok(!!j && typeof j.dir === 'string' && Array.isArray(j.lines) && !!j.totals && typeof j.at === 'string', '--json 有 at/dir/lines/totals', j && Object.keys(j));
ok(!!j && j.lines.length === 2, '--json lines 与扫描一致', j?.lines?.length);
ok(fs.readdirSync(D3).sort().join(',') === before, 'CLI 跑完目录文件一个不多一个不少（纯只读）', fs.readdirSync(D3));

const cliBad = run(['--dir', path.join(SANDBOX, 'nope')]);
ok(cliBad.code === 0, 'CLI 跑不存在的目录 rc=0（不崩）', cliBad.code);
ok(/⚠️/.test(cliBad.out) && /目录不存在|读不动/.test(cliBad.out), '人读模式把那句报黄打出来', cliBad.out.slice(0, 120));
ok(!fs.existsSync(path.join(SANDBOX, 'nope')), 'CLI 不会顺手把目录建出来（绝不写盘）', fs.existsSync(path.join(SANDBOX, 'nope')));

const cliBadJson = run(['--json', '--dir', path.join(SANDBOX, 'nope')]);
let jb = null;
try { jb = JSON.parse(cliBadJson.out); } catch { jb = null; }
ok(cliBadJson.code === 0 && !!jb && Array.isArray(jb.lines) && jb.lines.length === 0, '目录不存在时 --json 仍给合法结构 + rc=0', { rc: cliBadJson.code, ok: !!jb });

console.log('\n⑥ 目录解析（env 注入 / 相对 humanDoc 的上级候选）');
// 不传 --dir 时按 env 走（旧夹具里"读真实生产目录"那条换成了这条：同样证明"CLI 现读不崩、结构对"，
// 但数据是现造的，不依赖本机目录）
const cliEnv = run(['--json'], { ROUTER_VISION_DIR: D1 });
let je = null;
try { je = JSON.parse(cliEnv.out); } catch { je = null; }
ok(cliEnv.code === 0 && !!je && je.lines.length === 1 && je.dir === path.resolve(D1),
  '不传 --dir 时按 env ROUTER_VISION_DIR 扫（不靠写死的缺省目录）', { rc: cliEnv.code, dir: je?.dir });

const D6 = path.join(SANDBOX, 'docs', 'vision');
mk(D6, 'parent-doc.json', { line: '上级档线', humanDoc: '愿景-上级.md', asks: [{ id: 'C1', kind: 'self-todo', what: 'x' }] });
mk(path.join(SANDBOX, 'docs'), '愿景-上级.md', '# 上级\n');
const s6 = scanYearring(D6);
ok(s6.lines[0]?.humanDocExists === true, 'humanDoc 的相对路径在「档目录的上一级」也认（不写死绝对根）', s6.lines[0]?.humanDocExists);

ok(path.isAbsolute(resolveVisionDir('some/rel/dir')) && path.resolve('some/rel/dir') === resolveVisionDir('some/rel/dir'),
  'resolveVisionDir 显式参数优先（相对路径也归一成绝对）', resolveVisionDir('some/rel/dir'));

console.log('\n⑦ CLI 用法面（rc=2 = 用法错；它与"坏数据 rc=0"是两回事）');
const cliUnknown = run(['--bogus-flag']);
ok(cliUnknown.code === 2, '不认识的 flag ⇒ rc=2（不静默忽略）', cliUnknown.code);
const cliNoDirValue = run(['--dir']);
ok(cliNoDirValue.code === 2, '--dir 缺值 ⇒ rc=2', cliNoDirValue.code);

fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
process.exitCode = fail === 0 ? 0 : 1;
