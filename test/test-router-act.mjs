#!/usr/bin/env node
/**
 * test/test-router-act.mjs —— `router-act.mjs` 的纯函数夹具（离线：零网络、零生产写入、零真实 home）。
 *
 * 跑法：`node test/test-router-act.mjs`（也挂在 `npm test` 里）。退出码 0 = 全绿。
 *
 * 覆盖（每节一段，全部现跑现判）：
 *   ① `bucketOf` 状态映射（含 done 不进车况）
 *   ② `aggregate` 的按线分组 / 卡片分组兜底 / lastAt 取最大
 *   ③ `openAttentions` 只认未答
 *   ④ `renderStatus` 行数硬上限（含溢出截断路径）
 *   ⑤ `renderJson` 结构
 *   ⑥ `lineOfCardMap` / `pickFocus` / `renderBrief`（三行硬上限）
 *   ⑦ `buildRow` / `parseRow` 的 `ask` 段（带 / 不带 / 往返 / 正文含 ask= 不误判 / 全角竖线不拆坏）
 *   ⑧ `readSlots` 带 ask + `renderResume` 的槽位行（新行 ask=A2 / 旧行 ask=- / 仍以「·」开头）
 *   ⑨ 愿景差距（排序公式逐项 / 顺序 / tier / ≤Top-N / A 类只上桌 / 坏 json 不炸 brief）
 *   ⑩ 第 3 行「要你定」≤N 条明细 + 失败卡不当主项
 *   ⑪ `digest --auto` 的机械摘取（零模型 · 纯函数）
 *   ⑫ 收口后刷新接续头的「一行槽位」段
 *   ⑬ 槽位取舍：有活的线优先（静线不许把活线挤出名额）
 *   ⑭ 陈旧账读取侧兜底销账（**fail-open**：账本读不到就一条都不销）
 *
 * 本文件里的线名 / 卡 id / 目录全部是**夹具造数**，不含任何真实路径或真实账号。
 */
import {
  aggregate, bucketOf, openAttentions, renderStatus, renderJson, renderBrief,
  lineOfCardMap, pickFocus,
  buildRow, parseRow, readSlots, renderResume, renderSlotBlock,
  computeVisionGaps, renderVisionGaps, buildVisionGaps, ownerPriorityHit,
  BRIEF_DEFAULTS, isFailedCardAttention, partitionBriefAttn, renderNeedsOwner, buildAutoDigestRows,
  SLOT_CHARS,
  refreshResumeHeadSlots,
  splitStaleAttentions, readLedgerCardStatus, readAttentions, staleNoteOf,
} from '../router-act.mjs';
import { scanVisionDir, DEFAULT_GAP_TOP } from '../lib/vision-gaps.mjs';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ''}`); }
};

console.log('① bucketOf');
ok(bucketOf('running') === 'run', 'running → run');
ok(bucketOf('todo') === 'todo', 'todo → todo');
ok(bucketOf('backlog') === 'todo', 'backlog → todo（未排期也算待）');
ok(bucketOf('review') === 'review', 'review → review（卡在验收）');
ok(bucketOf('failed') === 'failed', 'failed → failed');
ok(bucketOf('done') === null, 'done 不进车况');
ok(bucketOf('whatever') === null, '未知状态不进车况');

console.log('\n② aggregate');
const tasks = [
  { id: 'c1', line: '线A', status: 'running', updatedAt: 300 },
  { id: 'c2', line: '线A', status: 'failed', updatedAt: 100 },
  { id: 'c3', line: '线A', status: 'done', updatedAt: 500 },
  { id: 'c4', line: '', status: 'review', updatedAt: 200 },          // line 空 ⇒ 走卡片分组兜底
  { id: 'c5', line: '线B', status: 'todo', updatedAt: 400 },
];
const threadLine = new Map([['c4', '线C']]);
const rows = aggregate(tasks, threadLine, [{ line: '线D', cards: [] }]);
const by = (l) => rows.find((r) => r.line === l);

ok(by('线A')?.run === 1 && by('线A')?.failed === 1 && by('线A')?.done === 1, '线A 三态计数', by('线A'));
ok(by('线A')?.lastAt === 500, '线A lastAt 取最大（含 done 卡的更新时间）', by('线A')?.lastAt);
ok(by('线C')?.review === 1, '卡面 line 为空时用卡片分组的线兜底成 线C', by('线C'));
ok(by('线B')?.todo === 1, '线B todo 计数', by('线B'));
ok(by('线D') !== undefined && by('线D')?.run === 0, '分组里没挂卡的本也建一行（车况 0）', by('线D'));
ok(rows.some((r) => r.line === '(未归线)') === false, '没有线名的卡被兜住后不再落 (未归线)');
ok(aggregate(tasks).length === 3, '不传分组参数时行为不变（只有卡面有 line 的三条线）', aggregate(tasks).map((r) => r.line));

console.log('\n③ openAttentions');
const att = [
  { cardId: 'a', question: 'q1', askedAt: 't1' },
  { cardId: 'b', question: 'q2', askedAt: 't1', answeredAt: 't2' },
  { cardId: 'c', question: 'q3', askedAt: 't1', answeredAt: null },
];
ok(openAttentions(att).length === 2, '已答的被过滤、answeredAt:null 算未答', openAttentions(att).map((x) => x.cardId));
ok(openAttentions(undefined).length === 0, 'undefined 不炸');
ok(openAttentions([]).length === 0, '空数组不炸');

console.log('\n④ renderStatus 行数上限');
const many = [];
for (let i = 0; i < 30; i++) {
  many.push({ id: `x${i}`, line: `线${i}`, status: i % 3 === 0 ? 'running' : 'todo', updatedAt: 1000 + i });
}
const bigRows = aggregate(many);
const attn = { open: Array.from({ length: 8 }, (_, i) => ({ cardId: `a${i}`, question: `问${i}`, options: ['重试', '归档'] })), all: [] };
const fakeBoard = { revision: 7, tasks: many };

for (const limit of [20, 12, 8]) {
  const out = renderStatus(fakeBoard, bigRows, attn, limit);
  const n = out.split('\n').length;
  ok(n <= limit, `--max-lines ${limit} ⇒ 实际 ${n} 行（不超限）`, n);
}
const dflt = renderStatus(fakeBoard, bigRows, attn, 20);
ok(dflt.split('\n').length <= 20, '默认 20 行上限守住');
ok(dflt.includes('等拍板 8 件'), '等拍板计数正确');
ok(dflt.includes('另有'), '主线溢出走「另有 N 条」合并行');

const emptyOut = renderStatus(fakeBoard, aggregate([]), { open: [], all: [] }, 20);
ok(emptyOut.includes('等拍板 0 件'), '没有待拍板时显示 0 件');

console.log('\n⑤ renderJson');
const j = JSON.parse(renderJson(fakeBoard, bigRows, attn));
ok(j.totals.cards === 30, 'totals.cards 正确', j.totals);
ok(j.attention.open === 8, 'attention.open 正确');
ok(Array.isArray(j.lines) && j.lines.length > 0, 'lines 是数组');
ok(j.lines[0].line !== undefined && j.lines[0].lastAtISO !== null, 'lines 条目带 lastAtISO');
ok(j.attention.staleAttentions && j.attention.staleAttentions.count === 0, 'staleAttentions 只加键、缺省 0（老键不变）', j.attention);

console.log('\n⑥ lineOfCardMap / pickFocus / renderBrief');
const bTasks = [
  { id: 'k1', line: '线A', status: 'running', updatedAt: 900 },
  { id: 'k2', line: '线B', status: 'review', updatedAt: 500 },
  { id: 'k3', line: '线C', status: 'failed', updatedAt: 800 },
  { id: 'k4', line: '', status: 'todo', updatedAt: 700 },
  { id: 'k5', line: '线E', status: 'done', updatedAt: 950 },
];
const bThread = new Map([['k4', '线D']]);
const bRows = aggregate(bTasks, bThread, []);
const bMap = lineOfCardMap(bTasks, bThread);
ok(bMap.get('k1') === '线A', 'lineOfCardMap 直取卡面 line');
ok(bMap.get('k4') === '线D', 'lineOfCardMap 卡面空时走分组兜底');

// 无线索：失败 > 卡验收 > 在跑
const f1 = pickFocus(bRows, [], bMap);
ok(f1?.line === '线C' && f1?.tier === 1, '无拍板事项时首选「有失败卡」的线', f1);

// 等拍板关联线优先于失败线
const attOpen = [{ cardId: 'k1', question: '要你定' }];
const f2 = pickFocus(bRows, attOpen, bMap);
ok(f2?.line === '线A' && f2?.tier === 0, '有未答 attention 的线排第一（即使别处有失败卡）', f2);

// 同档取等最久（lastAt 最小）
const tieTasks = [
  { id: 't1', line: '线X', status: 'failed', updatedAt: 900 },
  { id: 't2', line: '线Y', status: 'failed', updatedAt: 300 },
];
const tieRows = aggregate(tieTasks);
ok(pickFocus(tieRows, [], lineOfCardMap(tieTasks))?.line === '线Y', '同档取等得最久（lastAt 最早）的线');

// 只有 todo 的线不当首选
const todoOnly = aggregate([{ id: 'z1', line: '线Z', status: 'todo', updatedAt: 100 }]);
const fz = pickFocus(todoOnly, [], lineOfCardMap([{ id: 'z1', line: '线Z', status: 'todo', updatedAt: 100 }]));
ok(fz?.tier === 4, '只有排队活的线 tier=4（不当首选但仍会返回）', fz);
ok(pickFocus(aggregate([]), [], new Map()) === null, '没有在途活时返回 null');

// brief 三行硬上限 + 三个要素都在
const briefOut = renderBrief({ tasks: bTasks }, bRows, { open: attOpen, all: attOpen }, { lineOfCard: bMap });
const bl = briefOut.split('\n');
ok(bl.length <= 3, `brief 硬上限 3 行（实际 ${bl.length} 行）`, bl.length);
ok(bl[0].includes('车况') && bl[0].includes('等拍板 1 件'), '第 1 行 = 车况 + 等拍板件数', bl[0]);
ok(bl[1].startsWith('先看 线A'), '第 2 行 = 建议先看哪条', bl[1]);
ok(bl[2].includes('要你定'), '第 3 行 = 要操作者定的事', bl[2]);

// 没有待拍板（也没有待验收）⇒ 明确写 0 件（不省略第三行）
const noReviewTasks = bTasks.filter((t) => t.status !== 'review');
const briefZero = renderBrief({ tasks: noReviewTasks }, aggregate(noReviewTasks, bThread, []), { open: [], all: [] }, { lineOfCard: lineOfCardMap(noReviewTasks, bThread) });
ok(briefZero.split('\n').length === 3 && briefZero.includes('要你定 0 件'), '无待拍板时第 3 行写「0 件」而不是省略');

// 无在途活 ⇒ 第 2 行说清楚
const briefIdle = renderBrief({ tasks: [] }, aggregate([]), { open: [], all: [] }, {});
ok(briefIdle.includes('没有在途活'), '无在途活时第 2 行说「没有在途活」', briefIdle.split('\n')[1]);

// 待拍板超 3 件 ⇒ 溢出折叠成计数（明细 ≤3 条）
const manyAtt = Array.from({ length: 5 }, (_, i) => ({ cardId: `k${i + 1}`, question: `问${i}` }));
const briefMany = renderBrief({ tasks: bTasks }, bRows, { open: manyAtt, all: manyAtt }, {});
const manyLine3 = briefMany.split('\n')[2];
ok(manyLine3.includes('另有 3 件'), '待拍板超过 3 条时折叠成「另有 N 件」', manyLine3);

console.log('\n⑦ buildRow / parseRow（ask 指针）');
const rowAsk = buildRow({ date: '2026-11-03', line: '测试线', text: 'x', ref: 'docs/a.md', ask: 'A2' });
ok(rowAsk === '- 2026-11-03｜测试线｜x｜ask=A2｜ref：docs/a.md', 'buildRow 带 ask：ask 在正文后、ref 前', rowAsk);
const rowNoAsk = buildRow({ date: '2026-11-03', line: '测试线', text: 'x', ref: 'docs/a.md' });
ok(rowNoAsk === '- 2026-11-03｜测试线｜x｜ref：docs/a.md', 'buildRow 不带 ask：**逐字等于加这个能力之前那条算式**', rowNoAsk);
ok(buildRow({ date: '2026-11-03', line: '测试线', text: 'x' }) === '- 2026-11-03｜测试线｜x', '连 ref 都没有时形状不变');
ok(buildRow({ date: 'd', line: 'l', text: 't', ask: '' }) === '- d｜l｜t', 'ask 空串 ⇒ 一个字符都不加', buildRow({ date: 'd', line: 'l', text: 't', ask: '' }));
ok(buildRow({ date: 'd', line: 'l', text: 't', ask: '-' }) === '- d｜l｜t', 'ask 写 "-" ⇒ 也不加（别让 ｜ask=-｜ 进结论档）');

const p1 = parseRow(rowAsk);
ok(p1 && p1.ask === 'A2' && p1.text === 'x' && p1.ref === 'docs/a.md' && p1.line === '测试线', 'parseRow 把新格式解得回来（往返一致）', p1);
ok(buildRow(p1) === rowAsk, 'parse → 再 buildRow ⇒ 逐字还原（往返）', buildRow(p1));
const p2 = parseRow(rowNoAsk);
ok(p2 && p2.ask === null && p2.text === 'x', '旧行（不带 ask）⇒ ask === null（不报错、不回填）', p2);

const tricky = buildRow({ date: '2026-11-03', line: '线', text: '排查 ask=A1 为什么不生效', ref: 'docs/x.md', ask: 'B3' });
const pt = parseRow(tricky);
ok(pt.text === '排查 ask=A1 为什么不生效' && pt.ask === 'B3', '正文里出现 ask= 字样不误判（只认尾段）', pt);
const tricky2 = parseRow('- 2026-11-03｜线｜正文里提到 ask=A1 这事');
ok(tricky2.ask === null && tricky2.text === '正文里提到 ask=A1 这事', '正文提到的 ask=…（后面还有字）⇒ 不当指针', tricky2);
const longTail = parseRow('- 2026-11-03｜线｜正文｜ask=ABCDEFG');
ok(longTail.ask === null && longTail.text === '正文｜ask=ABCDEFG', '尾段 >6 字符 ⇒ 不当 ask，整段留在正文', longTail);
const barText = buildRow({ date: '2026-11-03', line: '线', text: 'A｜B｜C', ask: 'C1' });
const pb = parseRow(barText);
ok(pb.text === 'A｜B｜C' && pb.ask === 'C1', '正文含全角竖线不拆坏（仍能摘出 ask）', pb);
ok(parseRow('- 2026-11-03｜线｜正文本｜ask=-').ask === null, '档里读到 ask=- ⇒ 还原成 null');

console.log('\n⑧ readSlots / renderResume 的槽位行');
const SB = path.join(os.tmpdir(), `router-act-ask-${Date.now()}`);
fs.mkdirSync(SB, { recursive: true });
const DOC = path.join(SB, 'router-202611.md');
fs.writeFileSync(DOC, [
  '# Router 结论档 · 202611',
  '',
  '- 2026-11-03｜线新｜有指针｜ask=A2｜ref：docs/a.md',
  '- 2026-11-02｜线旧｜没指针',
  '',
].join('\n'), 'utf8');
const slots = readSlots(16, SB);
ok(slots.length === 2, `临时目录里读出 2 条槽位（实际 ${slots.length}）`, slots.map((s) => s.line));
ok(slots.find((s) => s.line === '线新')?.ask === 'A2', 'readSlots 的每行对象带 ask（新行）', slots.find((s) => s.line === '线新'));
ok(slots.find((s) => s.line === '线旧')?.ask === null, 'readSlots 对旧行给 ask:null（不回填）', slots.find((s) => s.line === '线旧'));
const head = renderResume({ slots, attnOpen: [], at: Date.parse('2026-11-03T10:00:00+08:00'), doc: DOC });
const slotLines = head.split('\n').filter((l) => l.startsWith('· '));
ok(head.includes('· 线新｜有指针｜ask=A2｜2026-11-03｜ref：docs/a.md'), '槽位行新格式含 ｜ask=A2｜（顺序：线名｜结论｜ask｜日期｜ref）', slotLines[0]);
ok(slotLines.some((l) => l === '· 线旧｜没指针｜ask=-｜2026-11-02'), '旧行渲染成 ask=-（如实说没有）', slotLines);
ok(slotLines.every((l) => parseRow(l) === null), '槽位行仍以「·」开头 ⇒ 不会被 readSlots 当结论行读回来（自身污染）', slotLines);
fs.rmSync(SB, { recursive: true, force: true });

console.log('\n⑨ 愿景差距（分数/顺序/tier/≤Top-N/A 类只上桌）');
const YD = path.join(os.tmpdir(), `vision-fake-${Date.now()}`);
fs.mkdirSync(YD, { recursive: true });
const NOW = Date.parse('2026-11-03T12:00:00+08:00');
const DAY = 86_400_000;
const putJson = (name, obj) => fs.writeFileSync(path.join(YD, name), JSON.stringify(obj, null, 2), 'utf8');
putJson('线C多.json', {
  line: '线C多', version: 'v1', updatedAt: '2026-11-03T00:00:00Z', humanDoc: '愿景-C.md',
  asks: [
    { id: 'C1', kind: 'self-todo', what: '把 A 做完' },
    { id: 'C2', kind: 'self-todo', what: '把 B 做完' },
    { id: 'C3', kind: 'self-todo', what: '把 C 做完' },
  ],
});
putJson('线B能力.json', {
  line: '线B能力', version: 'v1', updatedAt: '2026-11-01T00:00:00Z',
  asks: [{ id: 'B1', kind: 'capability-gap', what: '缺跨机统一' }],
});
putJson('线A等操作者.json', {
  line: '线A等操作者', version: 'v1', updatedAt: '2026-11-01T00:00:00Z',
  asks: [
    { id: 'A1', kind: 'blocked-by-owner', what: '名字代号未定' },
    { id: 'A2', kind: 'blocked-by-owner', what: '调度权给不给' },
  ],
});
putJson('线P命中.json', {
  line: '线P命中', version: 'v1', updatedAt: '2026-11-02T00:00:00Z',
  asks: [{ id: 'B7', kind: 'capability-gap', what: '操作者点过的方向' }],
});
putJson('线D久.json', {
  line: '线D久', version: 'v1', updatedAt: '2026-10-01T00:00:00Z',
  asks: [{ id: 'B9', kind: 'capability-gap', what: '很久没动的那件' }],
});
putJson('capability.json', { generatedAt: '2026-11-02', humanDoc: '能力-20261102.md', capabilities: [], inUse: [] });

const vIdx = scanVisionDir(YD, { at: NOW });
ok(vIdx.lines.filter((l) => l.isVision).length === 5, '5 条愿景线（capability.json 被排除）', vIdx.lines.map((l) => `${l.line}:${l.isVision}`));

const gRows = aggregate([
  { id: 'q1', line: '线C多', status: 'running', updatedAt: NOW - 2 * DAY },
  { id: 'q2', line: '线P命中', status: 'todo', updatedAt: NOW },
  { id: 'q3', line: '线B能力', status: 'done', updatedAt: NOW },        // done 不进在途
  { id: 'q4', line: '线D久', status: 'failed', updatedAt: NOW - 30 * DAY },
]);
const slotsForDigest = [{ line: '线C多', date: '2026-11-02', text: 't', ref: '', ask: null }];
const gaps = computeVisionGaps({ lines: vIdx.lines, rows: gRows, ownerItems: ['线P命中 的优先级', '视频线'], slots: slotsForDigest, now: NOW });
const byLine = (l) => gaps.find((g) => g.line === l);

ok(gaps.length === 5, `算出 5 条线（实际 ${gaps.length}）`, gaps.map((g) => g.line));
// 线C多：3×(C 类 3) + 2×(有在途) + 0.5×min(2,7) − 0.2×0 + 0 = 12
ok(byLine('线C多')?.score === 12, '线C多 score = 9+2+1 = 12（公式逐项对得上）', byLine('线C多')?.score);
ok(byLine('线C多')?.activityDays === 2 && byLine('线C多')?.cards === 1, '活动天数取卡 updatedAt（2 天前）', byLine('线C多'));
// 线P命中：0 + 2×(有在途 todo) + 0.5×0 + 5（命中 ownerPriority）= 7
ok(byLine('线P命中')?.score === 7 && byLine('线P命中')?.ownerPriority === true, '命中 ownerPriority ⇒ +5（2+5=7）', byLine('线P命中'));
// 线B能力：只有一张 done 卡 ⇒ 在途 0（不加 2）、但 lastAt 计入（done 也算"最近活动"）⇒ 0
ok(byLine('线B能力')?.score === 0 && byLine('线B能力')?.ownerPriority === false, '没命中 ownerPriority ⇒ 不加分；done 卡不算在途（0 分）', byLine('线B能力'));
// 线D久：0 + 2×(1 张在途 failed) + 0.5×min(30,7)=3.5 − 0 = 5.5
ok(byLine('线D久')?.score === 5.5 && byLine('线D久')?.activityDays === 30, '活动天数封顶 7（30 天 ⇒ 0.5×7=3.5）', byLine('线D久'));
// 线A等操作者：0 + 0 + 0 − 0.2×2 = -0.4
ok(byLine('线A等操作者')?.score === -0.4 && byLine('线A等操作者')?.tier === 'A', 'A 类线扣分（−0.2×2）且 tier=A', byLine('线A等操作者'));
ok(gaps.map((g) => g.line).join('>') === '线C多>线P命中>线D久>线B能力>线A等操作者', '顺序 = 分数降序', gaps.map((g) => g.line));
ok(byLine('线C多')?.askId === 'C1' && byLine('线C多')?.tier === 'C', 'askTop = 该线排名第一的 ask（C 类优先）', byLine('线C多'));
ok(byLine('线A等操作者')?.askId === 'A1', '只剩 A 类的线，第一名才是 A（上桌）', byLine('线A等操作者'));
ok(byLine('线C多')?.lastDigest === '2026-11-02' && byLine('线B能力')?.lastDigest === null, '上次收口从结论档槽位取（没有就 null，不猜）', { C: byLine('线C多')?.lastDigest, B: byLine('线B能力')?.lastDigest });
ok(ownerPriorityHit('示例线 · 判据', ['示例线']) === true && ownerPriorityHit('视频线', ['示例线']) === false, 'ownerPriorityHit 互为子串（含中点也能对上）');
ok(ownerPriorityHit('任意线', []) === false && ownerPriorityHit('', ['x']) === false, '没有 ownerPriority / 空线名 ⇒ 不命中、不报错');

const gapText = renderVisionGaps(gaps);
const gl = gapText.split('\n');
ok(gl[0] === '愿景差距（Top-3）：', '段落标题逐字一致', gl[0]);
ok(gl.length === 1 + DEFAULT_GAP_TOP + 1, `≤Top-N 条 + 1 行「另有」提示（实际 ${gl.length} 行）`, gl.length);
ok(gl[1].startsWith('· 线C多｜差：') && gl[1].includes('（C1 · C）') && gl[1].includes('上次收口 2026-11-02'), '第 1 条格式：线名｜差：…（askId · tier）｜上次收口', gl[1]);
ok(!gl.slice(1, 1 + DEFAULT_GAP_TOP).some((l) => l.includes('线A等操作者')), 'A 类线不进「该推」的前三（只上桌）', gl.slice(1, 4));
const gapTextA = renderVisionGaps([byLine('线A等操作者')]);
ok(gapTextA.includes('· 线A等操作者｜等操作者：'), '排第一是 A 时渲染成「等操作者：」而不是「差：」', gapTextA);
ok(renderVisionGaps([]) === '愿景差距（Top-3）：\n（没有可读的愿景件：本轮没有该推的线）', '没有数据时明确写一行，不硬凑');
ok(renderVisionGaps([], { note: '（自定义说明）' }).includes('（自定义说明）'), '有说明就用说明');

// buildVisionGaps：真读目录（ownerPriority 现读优先级清单；夹具里把清单指到空文件 ⇒ 按 0）
const PRIO = `${YD}-prio.json`;   // 放在被扫目录**外面**，别让扫描器把它数成一个愿景件
fs.writeFileSync(PRIO, '{}', 'utf8');
const prevPrio = process.env.ROUTER_PRIORITY_FILE;
process.env.ROUTER_PRIORITY_FILE = PRIO;
const built = buildVisionGaps({ dir: YD, rows: gRows, now: NOW });
ok(built.gaps.length === 5 && built.idx.lines.length === 6, 'buildVisionGaps 现读目录 ⇒ 5 条差距 / 6 个 json', { gaps: built.gaps.length, lines: built.idx.lines.length });
ok(built.gaps.find((g) => g.line === '线P命中')?.ownerPriority === false, '优先级清单读不到 ⇒ 按 0（不报错、不猜）', built.gaps.find((g) => g.line === '线P命中')?.score);
ok(built.gaps.length > DEFAULT_GAP_TOP && renderVisionGaps(built.gaps, { note: built.note }).split('\n').length === 1 + DEFAULT_GAP_TOP + 1,
  '多于 Top-N 条时渲染层明写「另有 N 条」（不悄悄截断）', built.gaps.length);
const builtEmpty = buildVisionGaps({ dir: path.join(YD, 'nope'), rows: gRows, now: NOW });
ok(builtEmpty.gaps.length === 0 && builtEmpty.note.includes('没有可读的愿景件'), '目录不在 ⇒ 0 条 + 明确说明（不炸 brief）', builtEmpty.note);
const brokenDir = path.join(YD, 'brokenonly');
fs.mkdirSync(brokenDir, { recursive: true });
fs.writeFileSync(path.join(brokenDir, 'x.json'), '{oops', 'utf8');
const builtBroken = buildVisionGaps({ dir: brokenDir, rows: gRows, now: NOW });
ok(builtBroken.gaps.length === 0 && builtBroken.warnings.some((w) => /坏 JSON/.test(w)), '目录里只有坏 json ⇒ 0 条 + 报黄（一个坏 json 不许把 brief 打死）', builtBroken.warnings);
process.env.ROUTER_PRIORITY_FILE = prevPrio;

// brief 默认仍严格 3 行；追加 gaps 后前 3 行**逐字相同**
const briefPlain = renderBrief({ tasks: bTasks }, bRows, { open: attOpen, all: attOpen }, { lineOfCard: bMap });
const briefWithGaps = `${briefPlain}\n${renderVisionGaps(gaps)}`;
ok(briefPlain.split('\n').length === 3, '渲染层：不带 gaps 仍是 3 行', briefPlain.split('\n').length);
ok(briefWithGaps.split('\n').slice(0, 3).join('\n') === briefPlain, '带 gaps 时前 3 行逐字不变（只是后面追加）');
ok(briefWithGaps.split('\n').length > 3, '带 gaps 时行数变多');
fs.rmSync(YD, { recursive: true, force: true });

console.log('\n⑩ 第 3 行「要你定」≤N 条明细 + 失败卡不当主项');
/** 数第 3 行摆了几条明细（按 ①②③ 编号数；去掉「要你定」前缀与折叠尾） */
const detailCount = (line) => {
  const body = String(line).replace(/^要你定\s*/, '').replace(/（另有[\s\S]*$/, '').trim();
  if (!body || body === '0 件') return 0;
  return (body.match(/[①②③]/g) || []).length;
};
// 夹具：1 张在跑、1 张待验收、1 张失败（失败卡派生的 attention 走固定文案）
const aTasks = [
  { id: 'ok1', line: '线A', status: 'running', updatedAt: 10, title: '在跑的卡' },
  { id: 'rv1', line: '线B', status: 'review', updatedAt: 20, title: '等我验收' },
  { id: 'fa1', line: '线C', status: 'failed', updatedAt: 30, title: '挂掉那张' },
];
const aRows = aggregate(aTasks);
const aMap = lineOfCardMap(aTasks);
const asks5 = Array.from({ length: 5 }, (_, i) => ({
  cardId: 'ok1', question: `真问句${i}`, askedAt: `2026-11-0${i + 1}T00:00:00Z`,
}));
const failedAtt = { cardId: 'fa1', question: '卡「挂掉那张」执行失败（failed）—— 重试、归档，还是先放着？', options: ['重试', '归档', '先放着'] };

ok(isFailedCardAttention(failedAtt, new Map([['fa1', 'failed']])) === true, '失败卡：看板 status=failed ⇒ 认');
ok(isFailedCardAttention({ cardId: 'gone', question: failedAtt.question, options: ['重试', '归档', '先放着'] }, new Map()) === true, '卡已归档（看板查不到）也认：按固定问句/选项判');
ok(isFailedCardAttention({ cardId: 'ok1', question: '真问句0', options: ['是', '否'] }, new Map()) === false, '普通问句不算失败卡');

const line3Many = renderNeedsOwner({ tasks: aTasks }, { open: asks5 });
ok(detailCount(line3Many) === BRIEF_DEFAULTS.askMax, `第 3 行明细条数 = ${BRIEF_DEFAULTS.askMax}（实际 ${detailCount(line3Many)}）`, line3Many);
ok(line3Many.includes('另有 3 件'), '5 条真问句 + 1 张待验收 = 6 条 ⇒ 摆 3 条、折叠「另有 3 件」', line3Many);

const line3Fail = renderNeedsOwner({ tasks: aTasks }, { open: [{ cardId: 'ok1', question: '真问句0' }, failedAtt] });
ok(!line3Fail.includes('执行失败') && !line3Fail.includes('failed'), '失败卡**不当主项**（第 3 行不出现「执行失败」/failed）', line3Fail);
ok(line3Fail.includes('失败卡 1 件只报数、不占你的板'), '失败卡只进折叠计数（只报数 · 不承诺有机器在重试）', line3Fail);
ok(!line3Fail.includes('挂掉那张'), '失败卡的标题也不进明细', line3Fail);

// 排序口径：真等操作者拍的（askedAt 最久在前）→ 待验收。用看板里查不到的 cardId，让人读到问句原文。
const line3Order = renderNeedsOwner({ tasks: aTasks }, {
  open: [
    { cardId: 'gone-late', question: '真问句·后问的', askedAt: '2026-11-04T00:00:00Z' },
    { cardId: 'gone-early', question: '真问句·先问的', askedAt: '2026-11-01T00:00:00Z' },
  ],
});
ok(line3Order.indexOf('先问的') < line3Order.indexOf('后问的')
  && line3Order.indexOf('后问的') < line3Order.indexOf('待验收'), '排序：真等操作者拍的（等得最久在前）→ 待验收', line3Order);

const line3None = renderNeedsOwner({ tasks: [{ id: 'fa1', line: '线C', status: 'failed', updatedAt: 1, title: 'x' }] }, { open: [failedAtt] });
ok(line3None.startsWith('要你定 0 件') && line3None.includes('失败卡 1 件只报数'), '只有失败卡 ⇒ 0 件 + 折叠计数（不摆失败卡）', line3None);

const briefA1 = renderBrief({ tasks: aTasks }, aRows, { open: [...asks5, failedAtt], all: [...asks5, failedAtt] }, { lineOfCard: aMap });
const briefA1Lines = briefA1.split('\n');
ok(briefA1Lines.length === 3, `A-1 之后 brief 仍是 3 行（实际 ${briefA1Lines.length}）`, briefA1Lines.length);
ok(detailCount(briefA1Lines[2]) <= 3, 'A-1：第 3 行明细 ≤3', briefA1Lines[2]);
ok(!briefA1Lines[2].includes('执行失败'), 'A-1：第 3 行不拿失败卡当主项', briefA1Lines[2]);

console.log('\n⑪ digest --auto 的机械摘取（零模型 · 纯函数）');
const autoTasks = [
  { id: 'd1', line: '线A', status: 'done', updatedAt: 100, title: '线A 老的 done 卡' },
  { id: 'd2', line: '线A', status: 'done', updatedAt: 300, title: '线A 最近 done 卡' },
  { id: 'r1', line: '线A', status: 'running', updatedAt: 400, title: '线A 在跑那张' },
  { id: 'x1', line: '线B', status: 'running', updatedAt: 200, title: '线B 只有在跑' },
  { id: 'y1', line: '线C', status: 'backlog', updatedAt: 150, title: '线C 只有排队' },
  { id: 'z1', line: '静线', status: 'done', updatedAt: 999, title: '静线 done' },
];
const autoRows = aggregate(autoTasks);
const autoPlan = buildAutoDigestRows({ tasks: autoTasks, rows: autoRows, lineOfCard: lineOfCardMap(autoTasks) });
const planOf = (l) => autoPlan.find((p) => p.line === l);
ok(autoPlan.length === 3, '只给「有活的主线」出行（全 done 的静线不出）', autoPlan.map((p) => p.line));
ok(planOf('线A')?.text === '已完成：线A 最近 done 卡' && planOf('线A')?.ref === 'd2', '取**最近一张 done 卡**的标题，ref = 卡 id', planOf('线A'));
ok(planOf('线B')?.text === '在跑：线B 只有在跑' && planOf('线B')?.kind === 'running', '没有 done 卡 ⇒ 退化成「状态词：最近一张卡」（不编结论）', planOf('线B'));
ok(planOf('线C')?.text === '排队：线C 只有排队', 'backlog 归「排队」', planOf('线C'));
ok(autoPlan.every((p) => [...String(p.text)].length <= SLOT_CHARS), '每行正文 ≤ 槽位显示宽上限', autoPlan.map((p) => [...String(p.text)].length));

const longTitle = 'X'.repeat(400);
const longPlan = buildAutoDigestRows({
  tasks: [{ id: 'L1', line: '长线', status: 'done', updatedAt: 1, title: longTitle }],
  rows: aggregate([{ id: 'L1', line: '长线', status: 'running', updatedAt: 1 }]),
  lineOfCard: lineOfCardMap([{ id: 'L1', line: '长线', status: 'done', updatedAt: 1 }]),
});
ok([...String(longPlan[0]?.text ?? '')].length <= SLOT_CHARS && String(longPlan[0]?.text ?? '').endsWith('…'), '超长标题截断到槽位宽度（结尾补 …）', longPlan[0]?.text);

const autoPlanOrder = buildAutoDigestRows({
  tasks: [
    { id: 'q1', line: '只排队', status: 'todo', updatedAt: 5, title: 't' },
    { id: 'q2', line: '在跑', status: 'running', updatedAt: 5, title: 'r' },
  ],
  rows: aggregate([
    { id: 'q1', line: '只排队', status: 'todo', updatedAt: 5 },
    { id: 'q2', line: '在跑', status: 'running', updatedAt: 5 },
  ]),
  lineOfCard: lineOfCardMap([
    { id: 'q1', line: '只排队', status: 'todo', updatedAt: 5 },
    { id: 'q2', line: '在跑', status: 'running', updatedAt: 5 },
  ]),
});
ok(autoPlanOrder[0]?.line === '在跑', '顺序沿用 brief 车况的 priority（在跑先于只有排队）', autoPlanOrder.map((p) => p.line));

console.log('\n⑫ 收口后刷新接续头的「一行槽位」段');
const HD = path.join(os.tmpdir(), `router-act-head-${Date.now()}`);
fs.mkdirSync(HD, { recursive: true });
const HDOC = path.join(HD, 'router-202611.md');
const SLOT_HEAD = renderSlotBlock([])[0];   // 用本仓自己的段标题（与 reset 共用同一支渲染）
ok(SLOT_HEAD.startsWith('#### 一行槽位'), '槽位段标题由 renderSlotBlock 统一给出（reset 与刷新同构）', SLOT_HEAD);
const headDocBase = [
  '# Router 结论档 · 202611',
  '',
  '> 说明行（历史，不许动）',
  '',
  '---',
  '',
  '- 2026-11-02｜线旧｜老结论｜ref：docs/a.md',
  '- 2026-11-05｜线甲｜甲结论｜ref：c1',
  '- 2026-11-05｜线乙｜乙结论｜ref：c2',
  '',
  '### 接续头 · 2026-11-02 21:39（上次收口时间）',
  '',
  SLOT_HEAD,
  '· 线旧｜老结论｜2026-11-02｜ref：docs/a.md',
  '',
  '#### 待办的事（只列未答的）',
  '1. [卡 abcdef12] 某个问句 → 选 重试/归档',
  '',
  '#### 怎么继续（三句）',
  '- 车况**现跑**：`node router-act.mjs brief`（别拿上面槽位当现状）',
  '',
];
fs.writeFileSync(HDOC, headDocBase.join('\n'), 'utf8');
const headSlots = readSlots(16, HD);
const docRowsBefore = headDocBase.filter((l) => parseRow(l) !== null);

const h1 = refreshResumeHeadSlots({ doc: HDOC, slots: headSlots, apply: true });
ok(h1.ok && h1.changed && h1.wrote, '接续头里有槽位段 ⇒ 就地刷新成功', h1);
ok(h1.beforeLines === 1 && h1.afterLines === 3, `槽位段行数 1 → 3（当前槽位 ${headSlots.length} 条）`, h1);
ok(h1.shaBefore !== h1.shaAfter, '槽位段前后 sha 不同（真的变了）', [h1.shaBefore, h1.shaAfter]);

const after1 = fs.readFileSync(HDOC, 'utf8').split('\n');
ok(after1.filter((l) => parseRow(l) !== null).join('\n') === docRowsBefore.join('\n'),
  '🔴 结论区历史行一个字节都没动（append-only 守住）', docRowsBefore);
ok(after1.includes('· 线甲｜甲结论｜ask=-｜2026-11-05｜ref：c1'), '槽位行换成当前槽位（第 1 行 = 线甲）', after1.filter((l) => l.startsWith('· ')));
ok(after1.includes('· 线乙｜乙结论｜ask=-｜2026-11-05｜ref：c2'), '槽位行换成当前槽位（第 2 行 = 线乙）', after1.filter((l) => l.startsWith('· ')));
ok(after1.includes('### 接续头 · 2026-11-02 21:39（上次收口时间）'), '接续头时间戳不冒充（那是 reset 的事，本函数不动）');
ok(after1.includes('1. [卡 abcdef12] 某个问句 → 选 重试/归档') && after1.includes('> 说明行（历史，不许动）'),
  '段外内容（说明行 / 待办清单 / 怎么继续）逐字留着');
ok(after1.filter((l) => l.startsWith('· ')).every((l) => parseRow(l) === null), '刷新出来的槽位行仍以「·」开头（不会被 readSlots 当结论行读回来）');

const shaAfter1 = createHash('sha256').update(fs.readFileSync(HDOC)).digest('hex');
const h2 = refreshResumeHeadSlots({ doc: HDOC, slots: headSlots, apply: true });
ok(h2.ok && !h2.changed && !h2.wrote, '幂等：同一槽位再刷一次 ⇒ 不写盘（changed=false）', h2);
ok(createHash('sha256').update(fs.readFileSync(HDOC)).digest('hex') === shaAfter1, '幂等：第二次跑完档 sha 不变', shaAfter1);

// dry-run：算出会变，但一个字节都不写
const shaDry = createHash('sha256').update(fs.readFileSync(HDOC)).digest('hex');
const h3 = refreshResumeHeadSlots({ doc: HDOC, slots: headSlots.slice(0, 1), apply: false });
ok(h3.ok && h3.changed && !h3.wrote, 'apply:false ⇒ 只报会变、不写盘', h3);
ok(createHash('sha256').update(fs.readFileSync(HDOC)).digest('hex') === shaDry, 'dry-run 后档 sha 不变', shaDry);

// 档里还没有接续头（从没跑过 reset）⇒ 不发明新段
const NDOC = path.join(HD, 'router-202610.md');
fs.writeFileSync(NDOC, ['# Router 结论档 · 202610', '', '- 2026-10-30｜线丙｜丙结论', ''].join('\n'), 'utf8');
const h4 = refreshResumeHeadSlots({ doc: NDOC, slots: headSlots, apply: true });
ok(!h4.ok && h4.reason === 'no-slot-section' && !h4.wrote, '档里没有接续头 ⇒ 不发明新段（reason=no-slot-section）', h4);

// 多段接续头：只刷最后一段（更早的是历史）
const MDOC = path.join(HD, 'router-202609.md');
fs.writeFileSync(MDOC, [
  '# Router 结论档 · 202609', '',
  '- 2026-09-30｜线丁｜丁结论', '',
  '### 接续头 · 2026-09-30 10:00（上次收口时间）', '',
  SLOT_HEAD, '· 线丁｜丁结论｜2026-09-30', '',
  '#### 待办的事（只列未答的）', '1. （没有未答的拍板请求）', '',
  '### 接续头 · 2026-10-01 10:00（上次收口时间）', '',
  SLOT_HEAD, '· 线丁｜丁结论｜2026-09-30', '',
  '#### 待办的事（只列未答的）', '1. （没有未答的拍板请求）', '',
].join('\n'), 'utf8');
const mSlots = [{ line: '线丁', date: '2026-10-01', text: '新结论', ref: '', ask: null }];
const h5 = refreshResumeHeadSlots({ doc: MDOC, slots: mSlots, apply: true });
const mAfter = fs.readFileSync(MDOC, 'utf8').split('\n');
ok(h5.ok && h5.slotSections === 2 && h5.wrote, '两段接续头 ⇒ 认到 2 段、真刷新', h5);
ok(mAfter.filter((l) => l === '· 线丁｜丁结论｜2026-09-30').length === 1, '更早那段接续头原样留着（历史不动 · 连旧格式都不改）', mAfter.filter((l) => l.startsWith('· ')));
ok(mAfter.includes('· 线丁｜新结论｜ask=-｜2026-10-01'), '只有最后那段被刷成新槽位', mAfter.filter((l) => l.startsWith('· ')));

// 上限：20 条线 ⇒ 只留 16 行 + 「已满」提示（与 renderSlotBlock 同一口径）
const capDoc = path.join(HD, 'router-202608.md');
fs.writeFileSync(capDoc, ['# Router 结论档 · 202608', '', '### 接续头 · 2026-08-01 09:00（上次收口时间）', '', SLOT_HEAD, '· 占位｜x｜2026-08-01', ''].join('\n'), 'utf8');
const capSlots = Array.from({ length: 20 }, (_, i) => ({ line: `线${String(i).padStart(2, '0')}`, date: '2026-08-02', text: 't', ref: '', ask: null })).slice(0, 16);
const h6 = refreshResumeHeadSlots({ doc: capDoc, slots: capSlots, apply: true });
const capLines = fs.readFileSync(capDoc, 'utf8').split('\n').filter((l) => l.startsWith('· '));
ok(h6.afterLines === 17 && capLines.length === 17, `16 条槽位 + 1 行「已满」提示 = 17（实际 ${capLines.length}）`, capLines.length);
ok(capLines[capLines.length - 1].startsWith('· （槽位已满'), '第 17 行是「已满」提示（不是第 17 条线）', capLines[capLines.length - 1]);

fs.rmSync(HD, { recursive: true, force: true });

console.log('\n⑬ 槽位取舍：有活的线优先');
// 场景照实况：16 条活线 + 若干「今天更早收口过、此刻无在途卡」的静线。
// 纯日期口径下静线日期更近 ⇒ 先占名额，会把活线挤出 16 名。
const PD = path.join(os.tmpdir(), `router-act-prefer-${Date.now()}`);
fs.mkdirSync(PD, { recursive: true });
const pdoc = path.join(PD, 'router-202611.md');
const mkRow = (line, date) => `- ${date}｜${line}｜${line} 的结论｜ref：c-${line}`;
const statics = ['静1', '静2', '静3', '静4'];
const lives = Array.from({ length: 16 }, (_, i) => `活${String(i + 1).padStart(2, '0')}`);
fs.writeFileSync(pdoc, [
  '# Router 结论档 · 202611', '',
  ...statics.map((l) => mkRow(l, '2026-11-05')),   // 静线：日期更近（今天更早收口过）
  ...lives.map((l) => mkRow(l, '2026-11-04')),     // 活线：日期稍早
  '',
].join('\n'), 'utf8');

const noPrefer = readSlots(16, PD);
const withPrefer = readSlots(16, PD, new Set(lives));
const pushOut = lives.filter((l) => !noPrefer.some((s) => s.line === l));
ok(noPrefer.length === 16, `纯日期口径取满 16 行（实际 ${noPrefer.length}）`, noPrefer.map((s) => s.line));
ok(pushOut.length === 4, `纯日期口径下 4 条活线被静线挤出 16 名（实际挤出 ${pushOut.length} 条：${pushOut.join('、')}）`, noPrefer.map((s) => s.line));
ok(withPrefer.length === 16 && lives.every((l) => withPrefer.some((s) => s.line === l)),
  '🔴 给了活线集合 ⇒ 16 条活线一条不落地进槽位', withPrefer.map((s) => s.line));
ok(withPrefer.every((s) => lives.includes(s.line)), '活线刚好占满 16 名时静线一行都不占（活线优先）', withPrefer.map((s) => s.line));
ok(withPrefer.map((s) => s.line).join(',') === lives.join(','), '活线组内保持原日期降序的稳定顺序（不重排）', withPrefer.map((s) => s.line));

// 缺省行为逐字不变：这是「reset 与夹具输出不漂」的钉子
const key = (arr) => arr.map((s) => s.line).join(',');
ok(key(readSlots(16, PD, null)) === key(noPrefer) && key(readSlots(16, PD, [])) === key(noPrefer)
  && key(readSlots(16, PD, ['查无此线'])) === key(noPrefer),
  '缺省 / null / 空集合 / 命中不了任何线 ⇒ 与纯日期口径逐字相同（reset 靠这条不漂）',
  [key(readSlots(16, PD, null)), key(readSlots(16, PD, []))]);

// 活线不满 16：静线补位，且一律排在活线后面（不是插在中间）
const fewLives = lives.slice(0, 15);
const mixed = readSlots(16, PD, fewLives);
ok(mixed.length === 16 && mixed.slice(0, 15).every((s) => fewLives.includes(s.line)) && !fewLives.includes(mixed[15].line),
  '活线 15 条 + 1 条静线补位 ⇒ 静线排在最后（补位不许插队）', mixed.map((s) => s.line));

// prefer 传数组也认（内部转 Set）
ok(key(readSlots(16, PD, lives)) === key(withPrefer), 'prefer 传数组也认（内部转 Set）');
fs.rmSync(PD, { recursive: true, force: true });

console.log('\n⑭ 陈旧账读取侧兜底销账（fail-open：账本读不到就一条都不销）');
const staleOpen = [
  { cardId: 's-running', question: '在跑卡的问句' },
  { cardId: 's-done', question: '已完成卡的老问句' },
  { cardId: 's-gone', question: '已归档 / 删掉的卡的问句' },
];
const ledger = new Map([['s-running', 'running'], ['s-done', 'done']]);
const splitOk = splitStaleAttentions(staleOpen, ledger);
ok(splitOk.checked === true, '账本能读 ⇒ checked=true');
ok(splitOk.staleCount === 2 && splitOk.stale.map((a) => a.cardId).join(',') === 's-done,s-gone', '已完成 / 不在账本 ⇒ 归 stale', splitOk.stale.map((a) => a.cardId));
ok(splitOk.open.length === 1 && splitOk.open[0].cardId === 's-running', '其余状态（跑/待/验收/失败…）一律保留 open（宁可多报）', splitOk.open.map((a) => a.cardId));

const splitNoLedger = splitStaleAttentions(staleOpen, null);
ok(splitNoLedger.checked === false && splitNoLedger.staleCount === 0 && splitNoLedger.open.length === 3,
  '🔴 账本没核成 ⇒ fail-open：一条都不销、open 原样返回', splitNoLedger);
ok(splitStaleAttentions([], null).staleCount === 0 && splitStaleAttentions(undefined, ledger).open.length === 0, '空输入 / undefined 都不炸');

ok(staleNoteOf({ ledgerChecked: false, staleCount: 0 }) === '（陈旧账没核成：账本读不到，按原样全算）', '说明①账本没核成时要露痕迹（不许静默）', staleNoteOf({ ledgerChecked: false }));
ok(staleNoteOf({ ledgerChecked: true, staleCount: 3 }) === '（另有 3 件卡已归档/完成/不在板，不计入）', '说明②有陈旧账 ⇒ 说清件数', staleNoteOf({ ledgerChecked: true, staleCount: 3 }));
ok(staleNoteOf({ ledgerChecked: true, staleCount: 0 }) === '', '说明③都干净 ⇒ 空串（老输出一个字符都不多）');

// 真读两个文件：状态件 + 账本
const FD = path.join(os.tmpdir(), `router-act-stale-${Date.now()}`);
fs.mkdirSync(FD, { recursive: true });
const stateFile = path.join(FD, 'state.json');
const ledgerFile = path.join(FD, 'ledger.json');
fs.writeFileSync(stateFile, JSON.stringify({ attentions: staleOpen }, null, 2), 'utf8');
fs.writeFileSync(ledgerFile, JSON.stringify({ tasks: [{ id: 's-running', status: 'running' }, { id: 's-done', status: 'done' }] }, null, 2), 'utf8');
const readOk = readAttentions({ stateFile, ledgerFile });
ok(readOk.open.length === 1 && readOk.staleCount === 2 && readOk.ledgerChecked === true, 'readAttentions：账本在 ⇒ 销 2 条、open 剩 1 条', { open: readOk.open.length, stale: readOk.staleCount });
const readNoLedger = readAttentions({ stateFile, ledgerFile: path.join(FD, 'nope.json') });
ok(readNoLedger.open.length === 3 && readNoLedger.ledgerChecked === false, 'readAttentions：账本文件不在 ⇒ fail-open（3 条全留、checked=false）', { open: readNoLedger.open.length, checked: readNoLedger.ledgerChecked });
fs.writeFileSync(ledgerFile, '{oops', 'utf8');
ok(readAttentions({ stateFile, ledgerFile }).ledgerChecked === false, 'readAttentions：账本是一坨坏 JSON ⇒ 同样 fail-open（不抛、不销）');
ok(readLedgerCardStatus(path.join(FD, 'nope.json')) === null, 'readLedgerCardStatus：读不到 ⇒ null（调用方据此 fail-open）');
fs.writeFileSync(ledgerFile, JSON.stringify({ nope: true }, null, 2), 'utf8');
ok(readLedgerCardStatus(ledgerFile) === null, 'readLedgerCardStatus：没有 tasks[] ⇒ 也算核不成（不猜）');

// brief / status 的第 1 行要把这件事说清
fs.writeFileSync(ledgerFile, JSON.stringify({ tasks: [{ id: 's-running', status: 'running' }, { id: 's-done', status: 'done' }] }, null, 2), 'utf8');
const attnWithStale = readAttentions({ stateFile, ledgerFile });
const briefStale = renderBrief({ tasks: [] }, aggregate([]), attnWithStale, {});
ok(briefStale.includes('另有 2 件卡已归档/完成/不在板'), 'brief 第 1 行补一句陈旧账说明（不计入件数）', briefStale.split('\n')[0]);
const statusStale = renderStatus({ tasks: [] }, aggregate([]), attnWithStale, 20);
ok(statusStale.includes('另有 2 件卡已归档/完成/不在板'), 'status 的等拍板块同样说清', statusStale.split('\n').filter((l) => l.startsWith('等拍板')));
const attnFailOpen = readAttentions({ stateFile, ledgerFile: path.join(FD, 'nope.json') });
ok(renderBrief({ tasks: [] }, aggregate([]), attnFailOpen, {}).includes('陈旧账没核成'), 'brief：账本读不到时明写「没核成」（fail-open 也要看得见）');
fs.rmSync(FD, { recursive: true, force: true });

// 被销掉的 attention 不进 brief 第 3 行 / 不进 --json 的 asks 计数
const partsStale = partitionBriefAttn({ open: attnWithStale.open, tasks: [] });
ok(partsStale.asks.length === 1, '销掉的陈账不再进「要你定」的明细口径', partsStale.asks.map((a) => a.cardId));

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
process.exitCode = fail === 0 ? 0 : 1;
