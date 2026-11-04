#!/usr/bin/env node
/**
 * test/run-unit-tests.mjs —— 纯函数夹具（U1–U21）。**不联网、不碰真实 home、不碰生产件**。
 *
 * 与 `test/run-self-test.mjs` 的分工：
 *   · run-self-test.mjs  → 用子进程**真跑 CLI**，判「行为」；
 *   · 本件               → 直接 import 纯函数，判「算得对不对」（尤其是阈值可配、边界刚好不压）。
 *
 * 每条都现跑现判；退出码 0 = 全绿。
 *
 *   node test/run-unit-tests.mjs            # 跑全部
 *   node test/run-unit-tests.mjs --keep     # 保留临时目录（排障用）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const KEEP = process.argv.includes('--keep');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'router-unit-'));
const results = [];

async function t(id, name, fn) {
  try {
    const detail = await fn();
    results.push({ id, name, ok: true });
    process.stdout.write(`PASS  ${id}  ${name}\n      ${typeof detail === 'string' ? detail : ''}\n`);
  } catch (e) {
    results.push({ id, name, ok: false });
    process.stdout.write(`FAIL  ${id}  ${name}\n      ${e?.message ?? e}\n`);
  }
}

// ── 夹具：临时配置 + 临时 vision 目录 + 临时状态文件 ─────────────────────────
const CFG = path.join(ROOT, 'router-config.json');
const VISION = path.join(ROOT, 'vision');
const STATE = path.join(ROOT, 'router-state.json');
fs.mkdirSync(VISION, { recursive: true });

const writeJson = (p, obj) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8'); };
const DAY = 86_400_000;

writeJson(CFG, {
  head: { maxTotal: 222 },
  vision: { top: 5, textChars: 12, weights: { priorityHit: 9 } },
  brief: { askMax: 2 },
  custom: { nested: { flag: true } },
});
process.env.ROUTER_CONFIG_FILE = CFG;

writeJson(path.join(VISION, 'alpha.json'), {
  line: 'alpha',
  asks: [
    { id: 'a1', kind: 'self-todo', what: '自己就能推的第一件事' },
    { id: 'a2', kind: 'capability-gap', what: '缺一个能力' },
  ],
});
writeJson(path.join(VISION, 'beta.json'), {
  line: 'beta',
  asks: [{ id: 'b1', kind: 'blocked-by-owner', what: '卡在操作者手上' }],
});
writeJson(path.join(VISION, 'odd.json'), {
  line: 'odd',
  asks: [{ id: 'o1', kind: '从未登记过的 kind', what: '未知分类' }],
});
writeJson(path.join(VISION, 'plain.json'), { line: 'plain', note: '不是愿景件（没有 asks）' });
fs.writeFileSync(path.join(VISION, 'broken.json'), '{ 这不是 JSON', 'utf8');

writeJson(STATE, { attentions: [], ownerPriority: { items: ['alpha 线', '别的东西'] } });

const runtime = {};
await t('U0', '模块能 import（新件缺失时这里先红）', async () => {
  runtime.cfg = await import('../lib/config.mjs');
  runtime.gaps = await import('../lib/vision-gaps.mjs');
  runtime.head = await import('../lib/router-head.mjs');
  runtime.act = await import('../router-act.mjs');
  return `config / vision-gaps / router-head / router-act 四件都拿得到导出`;
});

// ── U1–U4 配置解析：env > 配置文件 > 缺省 ────────────────────────────────────
await t('U1', '配置解析三级优先（env > 配置 > 缺省）', async () => {
  const { makeResolver } = runtime.cfg;
  const r = makeResolver();
  const fromDefault = r.int('ROUTER_HEAD_MAX_TOPIC', 'head.maxTopic', 60);
  const fromConfig = r.int('ROUTER_HEAD_MAX_TOTAL', 'head.maxTotal', 400);
  process.env.ROUTER_HEAD_MAX_TOTAL = '333';
  const fromEnv = makeResolver().int('ROUTER_HEAD_MAX_TOTAL', 'head.maxTotal', 400);
  delete process.env.ROUTER_HEAD_MAX_TOTAL;
  assert.equal(fromDefault, 60, '缺省应生效');
  assert.equal(fromConfig, 222, '配置文件应覆盖缺省');
  assert.equal(fromEnv, 333, 'env 应覆盖配置文件');
  const src = Object.fromEntries(r.trace.map((x) => [x.key, x.source]));
  assert.equal(src['head.maxTopic'], 'default');
  assert.equal(src['head.maxTotal'], 'config');
  return `default=60 · config=222 · env=333 · trace=${JSON.stringify(src)}`;
});

await t('U2', '非法 env 值不许静默变 NaN（回落缺省 + 记一条 warning）', async () => {
  const { makeResolver } = runtime.cfg;
  process.env.ROUTER_HEAD_MAX_TOTAL = '不是数字';
  const r = makeResolver();
  const v = r.int('ROUTER_HEAD_MAX_TOTAL', 'head.maxTotal', 400);
  delete process.env.ROUTER_HEAD_MAX_TOTAL;
  assert.equal(v, 400, '非法值必须回落缺省，不许返回 NaN');
  assert.ok(r.warnings.some((w) => w.includes('ROUTER_HEAD_MAX_TOTAL')), '必须留下一条 warning');
  return `值=400（缺省）· warnings=${r.warnings.length} 条`;
});

await t('U3', '配置键取不到 / 配置文件坏掉 ⇒ 用缺省、不抛', async () => {
  const { makeResolver, loadConfig } = runtime.cfg;
  const bad = path.join(ROOT, 'bad-config.json');
  fs.writeFileSync(bad, '{ 坏掉', 'utf8');
  assert.deepEqual(loadConfig(bad), {}, '坏配置应返回空对象');
  const r = makeResolver(loadConfig(path.join(ROOT, 'no-such.json')));
  assert.equal(r.str('ROUTER_XXX', 'no.such.key', 'fallback'), 'fallback');
  assert.equal(r.bool('ROUTER_YYY', 'a.b', true), true);
  assert.deepEqual(r.list('ROUTER_ZZZ', 'a.list', ['x']), ['x']);
  return '坏配置/缺文件/缺键 三条都回落缺省';
});

await t('U4', 'list 型设置：env 用逗号切；config 用数组', async () => {
  const { makeResolver } = runtime.cfg;
  assert.deepEqual(makeResolver().list('ROUTER_L1', 'no.key', ['d']), ['d']);
  process.env.ROUTER_L1 = 'a, b ,,c';
  assert.deepEqual(makeResolver().list('ROUTER_L1', 'no.key', ['d']), ['a', 'b', 'c']);
  delete process.env.ROUTER_L1;
  return 'env "a, b ,,c" ⇒ [a, b, c]';
});

// ── U5–U10 愿景缺口（纯函数 + 扫描） ────────────────────────────────────────
await t('U5', '扫描愿景目录：坏 JSON 报黄不抛、非愿景件不入、未知 kind 按 B 计 + warn', async () => {
  const { scanVisionDir } = runtime.gaps;
  const idx = scanVisionDir(VISION);
  const byLine = Object.fromEntries(idx.lines.filter((l) => l.isVision).map((l) => [l.line, l]));
  assert.equal(byLine.alpha.askC, 1, 'alpha 有 1 条 C');
  assert.equal(byLine.alpha.askB, 1, 'alpha 有 1 条 B');
  assert.equal(byLine.beta.askA, 1, 'beta 有 1 条 A');
  assert.equal(byLine.odd.askB, 1, '未知 kind 按 B 计');
  assert.equal(idx.totals.broken, 1, '坏 JSON 计入 broken');
  assert.ok(idx.warnings.some((w) => w.includes('从未登记过的 kind')), '未知 kind 必须点名');
  assert.ok(!byLine.plain, '没有 asks 的 json 不算愿景件');
  return `vision=${idx.totals.vision} broken=${idx.totals.broken} warnings=${idx.warnings.length}`;
});

await t('U6', '目录不存在 ⇒ note + 空列表，不抛（一个坏目录不许把简报打死）', async () => {
  const { scanVisionDir } = runtime.gaps;
  const idx = scanVisionDir(path.join(ROOT, 'no-such-dir'));
  assert.equal(idx.lines.length, 0);
  assert.ok(idx.note && idx.note.length > 0, '必须写明"目录不存在"');
  return `note=${idx.note}`;
});

await t('U7', '愿景缺口算分与排序：C 多的线在前；同分按线名（可复现）', async () => {
  const { scanVisionDir, computeVisionGaps } = runtime.gaps;
  const idx = scanVisionDir(VISION);
  const now = Date.parse('2026-11-05T00:00:00Z');
  const gaps = computeVisionGaps({ lines: idx.lines, rows: [{ line: 'alpha', run: 1, todo: 0, review: 0, failed: 0, lastAt: now - 2 * DAY }], now });
  assert.equal(gaps[0].line, 'alpha', 'alpha 该排第一');
  assert.equal(gaps[0].score, 6, 'alpha = 3×1C + 2×在途 + 0.5×2天 = 6');
  assert.equal(gaps[0].activityDays, 2);
  const beta = gaps.find((g) => g.line === 'beta');
  assert.equal(beta.score, -0.2, 'beta = −0.2×1A');
  assert.equal(beta.tier, 'A', 'beta 的 Top ask 是 A 类');
  return `${gaps.map((g) => `${g.line}:${g.score}`).join(' · ')}`;
});

await t('U8', '权重是参数不是常量：改 priorityHit 权重 ⇒ 分数跟着变', async () => {
  const { scanVisionDir, computeVisionGaps, DEFAULT_VISION_WEIGHTS } = runtime.gaps;
  const idx = scanVisionDir(VISION);
  const now = Date.parse('2026-11-05T00:00:00Z');
  const rows = [];
  const base = computeVisionGaps({ lines: idx.lines, rows, ownerItems: ['beta'], now });
  const heavy = computeVisionGaps({ lines: idx.lines, rows, ownerItems: ['beta'], now, weights: { ...DEFAULT_VISION_WEIGHTS, priorityHit: 9 } });
  const off = computeVisionGaps({ lines: idx.lines, rows, ownerItems: ['beta'], now, weights: { ...DEFAULT_VISION_WEIGHTS, priorityHit: 0 } });
  const b = base.find((g) => g.line === 'beta');
  const h = heavy.find((g) => g.line === 'beta');
  assert.equal(b.score, 4.8, '默认权重下 beta = 5（命中优先级）− 0.2（一条 A 类）');
  assert.equal(h.score, 8.8, 'priorityHit=9 ⇒ beta = 9 − 0.2');
  assert.equal(off.find((g) => g.line === 'beta').score, -0.2, 'priorityHit=0 ⇒ 只剩 −0.2');
  assert.equal(h.ownerPriority, true);
  return `默认 ${b.score} → 权重 9 后 ${h.score} → 关掉 ${off.find((g) => g.line === 'beta').score}`;
});

await t('U9', 'ownerPriority 命中：互为子串即算；空清单不命中', async () => {
  const { ownerPriorityHit } = runtime.gaps;
  assert.equal(ownerPriorityHit('alpha 线·判据', ['alpha']), true, '线名含条目');
  assert.equal(ownerPriorityHit('alpha', ['alpha 线的愿景']), true, '条目含线名');
  assert.equal(ownerPriorityHit('beta', ['alpha']), false);
  assert.equal(ownerPriorityHit('alpha', []), false);
  assert.equal(ownerPriorityHit('', ['alpha']), false);
  return '四种情形判对（含空）';
});

await t('U10', '读 ownerPriority 清单：文件/字段路径可配；文件不在 ⇒ 空数组不猜', async () => {
  const { readOwnerPriorityItems } = runtime.gaps;
  const items = readOwnerPriorityItems({ file: STATE, key: 'ownerPriority.items' });
  assert.deepEqual(items, ['alpha 线', '别的东西']);
  const missing = readOwnerPriorityItems({ file: path.join(ROOT, 'nope.json'), key: 'ownerPriority.items' });
  assert.deepEqual(missing, [], '文件不在 ⇒ []');
  const otherKey = readOwnerPriorityItems({ file: STATE, key: 'attentions' });
  assert.deepEqual(otherKey, [], '字段不是字符串数组 ⇒ []');
  return `读到 ${items.length} 条 · 缺文件=${missing.length} 条`;
});

await t('U11', '愿景缺口渲染：无数据写一行说明；Top-N 之外折叠成计数', async () => {
  const { renderVisionGaps } = runtime.gaps;
  const none = renderVisionGaps([], { note: '（夹具：没有愿景件）' });
  assert.ok(none.includes('夹具：没有愿景件'), '没有数据时要如实写一行');
  const many = Array.from({ length: 5 }, (_, i) => ({ line: `L${i}`, tier: i === 0 ? 'A' : 'C', text: '这是一条很长的 ask 正文需要被截断', askId: `id${i}`, activityDays: i, lastDigest: i ? '2026-11-01' : null }));
  const text = renderVisionGaps(many, { top: 3, textChars: 8 });
  const body = text.split('\n');
  assert.equal(body.length, 5, '标题 1 + 明细 3 + 折叠 1');
  assert.ok(body[1].startsWith('· L0｜等操作者：'), 'A 类渲染成「等操作者」');
  assert.ok(body[2].startsWith('· L1｜差：'), '非 A 类渲染成「差」');
  assert.ok(body[4].includes('另有 2 条线未展开'), '超出 Top-N 要折叠成计数');
  assert.ok(body[1].includes('…（'), '超长正文要截断');
  return body[4];
});

// ── U12–U15 简报第三行（失败卡不上桌） ─────────────────────────────────────
const tasksFixture = [
  { id: 'c1', title: '等验收的卡', status: 'review', updatedAt: 1000 },
  { id: 'c2', title: '执行失败的卡', status: 'failed', updatedAt: 2000 },
  { id: 'c3', title: '在跑的卡', status: 'running', updatedAt: 3000 },
];
const attnFixture = [
  { cardId: 'c2', question: '执行失败（failed）：要不要重试', options: ['重试', '归档', '先放着'], askedAt: '2026-11-01T10:00:00Z' },
  { cardId: 'ghost', question: '执行失败（failed）：这张卡已归档，问句还在', options: ['x'], askedAt: '2026-11-02T10:00:00Z' },
  { cardId: 'c9', question: '发布窗口选周三还是周四？', options: ['周三', '周四'], askedAt: '2026-11-03T10:00:00Z' },
];

await t('U12', '失败卡判定三条判据（看板状态 / 问句文案 / 选项组合）任一命中即算', async () => {
  const { isFailedCardAttention } = runtime.act;
  const statusById = new Map(tasksFixture.map((x) => [x.id, x.status]));
  assert.equal(isFailedCardAttention(attnFixture[0], statusById), true, '①看板同 id status=failed');
  assert.equal(isFailedCardAttention(attnFixture[1], statusById), true, '②卡已不在看板，但问句带失败文案');
  assert.equal(isFailedCardAttention(attnFixture[2], statusById), false, '正常待拍板不算失败卡');
  const noBoard = new Map();
  const byOptions = { cardId: 'zz', question: '随便问', options: ['重试', '归档', '先放着'], askedAt: 'x' };
  assert.equal(isFailedCardAttention(byOptions, noBoard), true, '③选项组合命中');
  return '三条判据各命中一次，正常件不命中';
});

await t('U13', '失败卡判定可配：换一套文案/状态，默认值不再命中', async () => {
  const { isFailedCardAttention } = runtime.act;
  const a = { cardId: 'q1', question: 'Execution failed: retry?', options: ['retry', 'archive', 'leave'], askedAt: 'x' };
  const def = isFailedCardAttention(a, new Map());
  assert.equal(def, false, '默认词表不该命中英文文案');
  const opts = { questionPatterns: [/execution failed/i], optionSets: [['retry', 'archive', 'leave']], statuses: ['failed'] };
  assert.equal(isFailedCardAttention(a, new Map(), opts), true, '配置后应命中');
  return '默认不中 / 配置后命中（证明没写死）';
});

await t('U14', 'partitionBriefAttn：待拍板按 askedAt 升序、待验收按 updatedAt 升序、失败卡单列', async () => {
  const { partitionBriefAttn } = runtime.act;
  const p = partitionBriefAttn({ open: attnFixture, tasks: tasksFixture });
  assert.equal(p.asks.length, 1, '只剩 1 条真待拍板');
  assert.equal(p.failed.length, 2, '2 条失败卡派生');
  assert.equal(p.reviews.length, 1, '1 张待验收');
  assert.equal(p.reviews[0].cardId, 'c1');
  return `asks=${p.asks.length} reviews=${p.reviews.length} failed=${p.failed.length}`;
});

await t('U15', 'renderNeedsOwner：≤N 条明细 + 折叠计数；全是失败卡时写「0 件」', async () => {
  const { renderNeedsOwner, BRIEF_DEFAULTS } = runtime.act;
  const board = { tasks: tasksFixture };
  const line = renderNeedsOwner(board, { open: attnFixture });
  assert.ok(line.startsWith('要你定 '), `第一段应是「要你定 …」，实得：${line}`);
  assert.ok(!line.includes('这张卡已归档'), '失败卡不许出现在明细里');
  assert.ok(line.includes('其中失败卡 2 件'), '失败卡只进折叠计数');
  const onlyFailed = renderNeedsOwner({ tasks: [tasksFixture[1]] }, { open: [attnFixture[0]] });
  assert.ok(onlyFailed.includes('要你定 0 件'), `全是失败卡 ⇒ 0 件，实得：${onlyFailed}`);
  assert.equal(BRIEF_DEFAULTS.askMax, 3, '缺省上限 3 条');
  const two = renderNeedsOwner(board, { open: attnFixture }, { askMax: 2 });
  assert.ok(two.length > 0);
  return `明细行=${line.split('②').length} · 折叠段=${/另有/.test(line)}`;
});

await t('U16', 'renderNeedsOwner 明细上限可配（3 → 1 时必须折叠）', async () => {
  const { renderNeedsOwner } = runtime.act;
  const open = [
    { cardId: 'x1', question: '问题一', options: ['a'], askedAt: '2026-11-01T00:00:00Z' },
    { cardId: 'x2', question: '问题二', options: ['a'], askedAt: '2026-11-02T00:00:00Z' },
    { cardId: 'x3', question: '问题三', options: ['a'], askedAt: '2026-11-03T00:00:00Z' },
  ];
  const line3 = renderNeedsOwner({ tasks: [] }, { open });
  const line1 = renderNeedsOwner({ tasks: [] }, { open }, { askMax: 1 });
  assert.equal(line3.split('②').length, 3, '缺省 3 条明细');
  assert.equal(line1.split('②').length, 1, 'askMax=1 时只留 1 条');
  assert.ok(line1.includes('另有 2 件'), '其余折叠成计数');
  return `3 条 → ${line3.split('②').length} 段；1 条 → ${line1.split('②').length} 段`;
});

// ── U17–U21 接续头压缩（空 / 超长 / 边界刚好不压） ─────────────────────────
await t('U17', '取料：assistant 只取 text 段（reasoning 不混入）+ 机器注入跳过 + 未知来源照收', async () => {
  const { pickTailFromEvents, oneLine } = runtime.head;
  const evs = [
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '把发布脚本的版本号改成多少？' }] } },
    { type: 'assistant/message', data: { role: 'assistant', content: [
      { type: 'reasoning', text: '嗯，我得先想一下版本号与兼容性的关系。'.repeat(10) },
      { type: 'text', text: '改成次版本号就行。' },
    ] } },
    { type: 'user/message', data: { role: 'user', source: { kind: 'time-context', form: 'snapshot' }, content: [{ type: 'text', text: 'Time sampled: 2026-11-05T00:00:00+08:00' }] } },
    { type: 'user/message', data: { role: 'user', source: { kind: 'qqbot' }, content: [{ type: 'text', text: '在吗，我想早点收工' }] } },
  ];
  const tail = pickTailFromEvents(evs);
  assert.equal(tail.lastAssistant, '改成次版本号就行。');
  assert.equal(tail.lastUser, '在吗，我想早点收工', '机器注入跳过、未知来源照收');
  const naive = oneLine(evs[1].data.content.map((p) => p.text).join(' '));
  assert.ok(naive.length > tail.lastAssistant.length * 5, '反例对照：不过滤 reasoning 会长出思维链');
  return `lastUser=${tail.lastUser} · 反例长度比 ${Math.round(naive.length / tail.lastAssistant.length)}×`;
});

await t('U18', '空输入：一个原料都没有 ⇒ 返回 null（读侧一个字都不加）', async () => {
  const { buildHeadWithStats, checkHead } = runtime.head;
  const r = buildHeadWithStats({});
  assert.equal(r.text, null);
  assert.equal(r.stats.verbatimDropped, false);
  assert.equal(checkHead('').ok, false, '空文本校验必须判红（不许空转）');
  return 'buildHead → null；checkHead("") → 判红';
});

await t('U19', '超长输入：原话整句超预算 ⇒ 整句不录（绝不截断），记 verbatimDropped', async () => {
  const { buildHeadWithStats, checkHead } = runtime.head;
  const r = buildHeadWithStats({ lastUser: '有原料', topic: '在聊一件长话', verbatim: '为'.repeat(500), now: new Date('2026-11-05T00:00:00+08:00') });
  assert.equal(r.stats.verbatimDropped, true);
  assert.ok(!r.text.includes('为为'), '不许留碎片');
  assert.ok(r.text.includes('- 原话：（无）'));
  assert.equal(checkHead(r.text).ok, true, '整句不录之后形态仍应合法');
  return `dropped=${r.stats.verbatimDropped} · 头长=${r.text.length}`;
});

await t('U20', '边界刚好不压：「在聊」= maxTopic 不截断，maxTopic+1 才截断', async () => {
  const { topicOf } = runtime.head;
  const fit = topicOf('a'.repeat(60), { maxTopic: 60 });
  const over = topicOf('a'.repeat(61), { maxTopic: 60 });
  assert.equal(fit, 'a'.repeat(60), '刚好 60 不许动它');
  assert.ok(!fit.includes('…'), '刚好不压：不许冒省略号');
  assert.ok(over.endsWith('…'), '超了才截断');
  assert.ok(Array.from(over).length <= 60, `截断后仍要 ≤60，实得 ${Array.from(over).length}`);
  return `fit=60（无省略号）· over=${Array.from(over).length}（带省略号）`;
});

await t('U21', '边界刚好不压：整份 = maxTotal 收下，多 1 个码点才丢原话', async () => {
  const { buildHeadWithStats } = runtime.head;
  const opts = { maxTopic: 10, maxTotal: 54 };
  const now = new Date('2026-11-05T00:00:00+08:00');
  const fit = buildHeadWithStats({ lastUser: 'u', topic: 'b'.repeat(10), verbatim: 'c'.repeat(8), now, ...opts });
  assert.equal(Array.from(fit.text).length, 54, `整份应正好 54 码点，实得 ${Array.from(fit.text).length}`);
  assert.equal(fit.stats.verbatimDropped, false, '刚好等于上限 ⇒ 不许丢');
  const over = buildHeadWithStats({ lastUser: 'u', topic: 'b'.repeat(10), verbatim: 'c'.repeat(9), now, ...opts });
  assert.equal(over.stats.verbatimDropped, true, '多 1 个码点 ⇒ 丢原话');
  return `54 码点收下 · 55 码点丢原话`;
});

await t('U22', '阈值全可配：maxTotal 调小 ⇒ 同一份输入更早丢原话', async () => {
  const { buildHeadWithStats } = runtime.head;
  const now = new Date('2026-11-05T00:00:00+08:00');
  const args = { lastUser: 'u', topic: 'b'.repeat(10), verbatim: 'c'.repeat(8), now, maxTopic: 10 };
  assert.equal(buildHeadWithStats({ ...args, maxTotal: 54 }).stats.verbatimDropped, false);
  assert.equal(buildHeadWithStats({ ...args, maxTotal: 40 }).stats.verbatimDropped, true);
  return 'maxTotal 54 ⇒ 留；40 ⇒ 丢（证明不是写死的 400）';
});

await t('U23', '注入版去掉时间戳（否则每轮变 ⇒ 前缀缓存每轮失效）', async () => {
  const { buildHead, forInjection } = runtime.head;
  const head = buildHead({ lastUser: 'u', topic: '聊了什么', now: new Date('2026-11-05T00:00:00+08:00') });
  const inj = forInjection(head);
  assert.ok(head.includes('2026-11-05'), '文件里要留时间');
  assert.ok(!/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(inj), '注入版不许带时间');
  assert.ok(inj.startsWith('# 接续头'), '注入版首行仍是标题（无时间）');
  return inj.split('\n')[0];
});

await t('U24', '负例对照：缺行 / 截断的原话 / 判定失败却写原话 ⇒ 三种都必须判红', async () => {
  const { checkHead } = runtime.head;
  const bad1 = '# 接续头 · 2026-11-05 00:00\n- 说话人：x\n- 说话人2：y';
  const bad2 = '# 接续头 · 2026-11-05 00:00\n- 在聊：聊了一件事\n- 原话：在一起的意思是有人在那边，不是你得天天…';
  const bad3 = '# 接续头 · 2026-11-05 00:00\n- 在聊：（接续头判定失败：压缩那一刻没判出来）\n- 原话：这句原话不该出现';
  assert.equal(checkHead(bad1).ok, false, '缺行必须判红');
  assert.equal(checkHead(bad2).ok, false, '截断的原话必须判红');
  assert.equal(checkHead(bad3).ok, false, '判定失败却写原话必须判红');
  return `三种负例全红（证明判据不是空转）`;
});

// ── 汇总 ────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n══ 单元夹具合计 ${results.length} 项 · PASS ${results.length - failed.length} · FAIL ${failed.length}\n`);
if (failed.length) process.stdout.write(`失败项：${failed.map((f) => f.id).join(', ')}\n`);
if (KEEP) process.stdout.write(`（--keep：夹具根保留在 ${ROOT}）\n`);
if (!KEEP) { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* 清不掉不影响结论 */ } }
process.exitCode = failed.length ? 1 : 0;
