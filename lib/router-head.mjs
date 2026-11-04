#!/usr/bin/env node
/**
 * lib/router-head.mjs —— 「接续头」压缩：给跨会话接续留一份**最近三句 + 一句摘要**的头。
 *
 * 要解决的问题：一个长会话换到新会话接着干，新会话要重读全文才知道"刚才在聊什么"。
 * 全文很贵（十几万 token），而人真正需要接住的往往只有：**在聊什么** + **那一句不能改写的原话**。
 * 本件把这件事压成一条 3~4 行、≤400 码点的头，写一份文件；新会话开局读它就够。
 *
 * ```
 * # 接续头 · <YYYY-MM-DD HH:MM>
 * - 在聊：<一句摘要，≤60 码点 —— 能改写的一律写这里>
 * - 原话：<只在「换种说法就变味」时出现；整句照抄、不许截断；没有就写「（无）」>
 * ```
 *
 * 两条判据（这是本件真正的设计，别改着改着改掉）：
 *   ① **「在聊」是摘要位，不是原话的前缀**。判据 =「换一种说法，意思变不变？」
 *      不变 ⇒ 改写成摘要；变了 ⇒ 才进「原话」行（整句照抄）。
 *      离线没有模型就**如实写「（离线：需模型判定）」**，绝不拿原话前缀冒充摘要。
 *   ② **「原话」行不许截断**：整句 + 其余行超预算 ⇒ **整句不录**（写「（无）」），并记 `verbatimDropped`。
 *      理由：截一半的句子既不是摘要也不是原话，读的人会当它是原话 —— 比不写更坏。
 *
 * 阈值都不写死（env > 配置文件 > 缺省，见 `lib/config.mjs`）：
 *   `ROUTER_HEAD_MAX_TOTAL` / `head.maxTotal`（整份码点上限，缺省 400）
 *   `ROUTER_HEAD_MAX_TOPIC` / `head.maxTopic`（「在聊」码点上限，缺省 60）
 *
 * 用法：
 *   node lib/router-head.mjs --from-session <文件|会话目录|session id|id 前缀> [--write <目录>] [--json]
 *   node lib/router-head.mjs --check <接续头文件> [--json]
 *   node lib/router-head.mjs --selftest
 *
 * 退出码：0 正常 · 1 取不到/校验不过 · 2 用法错 · 3 selftest 有用例失败
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { makeResolver, configFile } from './config.mjs';

// ───────────────────────── 阈值（全部可配） ─────────────────────────

export const DEFAULT_MAX_TOTAL = 400;
export const DEFAULT_MAX_TOPIC = 60;

/** 现读阈值：env > 配置文件 > 缺省（`lib/config.mjs` 是唯一解析口）。 */
export function headLimits(cfg) {
  const r = makeResolver(cfg);
  return {
    maxTotal: r.int('ROUTER_HEAD_MAX_TOTAL', 'head.maxTotal', DEFAULT_MAX_TOTAL),
    maxTopic: r.int('ROUTER_HEAD_MAX_TOPIC', 'head.maxTopic', DEFAULT_MAX_TOPIC),
    file: r.file,
    warnings: r.warnings,
  };
}

// 离线器具没有模型 ⇒ 摘要位只能写这个，**不许**拿原话的前缀假装是摘要。
const OFFLINE_TOPIC = '（离线：需模型判定）';
// 判定失败（degraded）时「在聊」写这个，**绝不**退回抄原话。
const DEGRADED_TOPIC = '（接续头判定失败：压缩那一刻没判出来，只留这一行，不抄原话）';

// ───────────────────────── 纯函数区 ─────────────────────────

export function cpLen(s) { return Array.from(String(s ?? '')).length; }

/** 按**码点**裁剪（不是 UTF-16 长度；emoji 不劈半） */
export function clip(s, n) {
  const cp = Array.from(String(s ?? ''));
  if (cp.length <= n) return cp.join('');
  return cp.slice(0, n).join('') + '…';
}

/** 压成一行、去多余空白 */
export function oneLine(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 从事件序列里挑「最近三句」的原料。返回 `{ lastUser, lastAssistant }`，取不到的为 null。
 *
 * 🔴 两个坑（实测过，别踩回去）：
 *   ① assistant 消息的 `reasoning` 段**也带 text** ⇒ 必须按 `part.type === 'text'` 过滤，
 *      否则把思维链抄进文件（既超字数，也把内部推理落盘）。
 *   ② `user/message` 的 message 就是 `event.data` 本身；`assistant/message` 才是 `event.data.message`。
 */
export function pickTailFromEvents(events) {
  let lastUser = null;
  let lastAssistant = null;
  for (const ev of Array.isArray(events) ? events : []) {
    const type = ev?.type;
    const d = ev?.data;
    if (!d) continue;
    if (type === 'user/message') {
      const msg = d;
      if (!isHumanMessage(msg)) continue;       // 机器注入（时间上下文 / 技能目录 / 记忆召回…）不是「人在说话」
      const text = textOfMessage(msg);
      if (!text) continue;
      if (isCheckpoint(msg, text)) continue;    // 压缩落进来的 checkpoint 不算「刚说的话」
      lastUser = text;
    } else if (type === 'assistant/message') {
      const msg = d.message ?? d;
      const text = textOfMessage(msg, true);
      if (text) lastAssistant = text;           // 空文本步（纯 tool_call）不覆盖上一次真回复
    }
  }
  return { lastUser, lastAssistant };
}

/** 从 message.content 取文本；assistant 侧必须只取 type==='text' */
function textOfMessage(msg, strictTextParts = false) {
  if (!msg) return '';
  const content = msg.content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const p of content) {
      if (!p) continue;
      if (strictTextParts) {
        if (p.type === 'text' && typeof p.text === 'string') parts.push(p.text);
      } else {
        if (typeof p.text === 'string' && (p.type === 'text' || p.type === 'input_text')) parts.push(p.text);
      }
    }
    return oneLine(parts.join(' '));
  }
  if (typeof msg.text === 'string') return oneLine(msg.text);
  if (typeof content === 'string') return oneLine(content);
  return '';
}

/** 压缩后的 checkpoint 摘要（自动摘要）不是「人在说话」 */
function isCheckpoint(msg, text) {
  const blob = `${String(text ?? '')} ${JSON.stringify(msg?.meta ?? msg?.source ?? '')}`;
  return /<compacted-summary>/.test(blob)
    || /automatically generated checkpoint/i.test(blob)
    || /compactionCheckpoint/i.test(blob);
}

// 🔴 机器注入（不是「人说的话」）：时间上下文 / 运行时上下文 / 指令 / 技能目录 / 记忆召回 /
//    来信通知… 全是系统塞进来的。⚠️ **未知 kind 一律照收** —— 人真说的那句绝不能因为来源字段
//    没登记就丢掉（别的入口，比如聊天机器人，kind 五花八门）。
const MACHINE_KINDS = new Set([
  'time-context', 'runtime-context', 'agent-instructions', 'skill-catalog',
  'memory-recall', 'life-memory', 'postcard-notice', 'system', 'reminder',
  'compaction', 'tool', 'job', 'notification', 'context',
]);

export function isHumanMessage(msg) {
  const k = msg?.source?.kind;
  const form = msg?.source?.form;
  if (k == null) return true;                 // 缺省 = 人
  if (k === 'user') return true;
  if (MACHINE_KINDS.has(k)) return false;
  if (form && ['snapshot', 'instructions', 'catalog'].includes(form)) return false;
  return true;
}

/**
 * 「在聊」= **摘要位**（写侧模型判出来的那句话），不是原话的机械截取。
 * `summary` 空 ⇒ `（离线：需模型判定）`；`degraded` ⇒ 判定失败串。
 * 上限走参数（缺省现读配置），保证返回值**永远 ≤ maxTopic** 码点。
 */
export function topicOf(summary, { degraded = false, maxTopic } = {}) {
  const TP = Number.isFinite(Number(maxTopic)) ? Math.max(1, Math.trunc(Number(maxTopic))) : headLimits().maxTopic;
  if (degraded) return DEGRADED_TOPIC;
  const s = oneLine(summary);
  if (!s) return OFFLINE_TOPIC;
  const clipped = clip(s, TP);
  // clip 会把省略号算进去 ⇒ 可能顶到 TP+1；这里保证「在聊」始终 ≤ TP
  return cpLen(clipped) > TP ? clip(s, TP - 1) : clipped;
}

/**
 * 生成接续头正文（**3~4 行**、整份 ≤ maxTotal 码点）。
 *
 * 输入分两半，别混：
 *   ① **原料** `lastUser` / `lastAssistant`（`pickTailFromEvents()` 的产物，只用来判"有没有料"）；
 *   ② **判定产物** `topic`（摘要）/ `verbatim`（整句）/ `degraded`（判定失败）—— 写侧由模型给。
 *
 * 🔴 「原话」行**不许截断**：整句 + 其余行超过 maxTotal ⇒ **整句不录**（写「（无）」），
 *    `stats.verbatimDropped = true`（写侧该往自己的日志记一行 `verbatim-dropped`）。
 * 🔴 判定失败（`degraded`）⇒ 在聊写判定失败串、原话「（无）」，**绝不退回抄原话**。
 * ⚠️ 时间戳只写在文件里（写侧）；注入侧要用 `forInjection()` 把它去掉 —— 否则每轮变 ⇒ 前缀缓存每轮失效。
 *
 * @param {{lastUser?:string|null, lastAssistant?:string|null, topic?:string, verbatim?:string,
 *          degraded?:boolean, now?:Date, maxTotal?:number, maxTopic?:number}} args
 * @returns {{text:string|null, stats:{degraded:boolean, offline:boolean, hasVerbatim:boolean, verbatimDropped:boolean, cp:number}}}
 */
export function buildHeadWithStats({ lastUser, lastAssistant, topic, verbatim, degraded = false, now = new Date(), maxTotal, maxTopic } = {}) {
  const lim = headLimits();
  const MT = Number.isFinite(Number(maxTotal)) ? Math.max(1, Math.trunc(Number(maxTotal))) : lim.maxTotal;
  const TP = Number.isFinite(Number(maxTopic)) ? Math.max(1, Math.trunc(Number(maxTopic))) : lim.maxTopic;

  const hasRaw = !!oneLine(lastUser) || !!oneLine(lastAssistant);
  if (!hasRaw) {
    // 一个原料都没有 ⇒ 读侧一个字都不加（干净启动）
    return { text: null, stats: { degraded: !!degraded, offline: false, hasVerbatim: false, verbatimDropped: false, cp: 0 } };
  }
  const t = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const lines = [`# 接续头 · ${t}`];
  const topicText = topicOf(topic, { degraded, maxTopic: TP });
  lines.push(`- 在聊：${topicText}`);
  const wantVerbatim = !degraded && typeof verbatim === 'string' && oneLine(verbatim) !== '';
  let verbatimLine = `- 原话：${wantVerbatim ? oneLine(verbatim) : '（无）'}`;
  const stats = {
    degraded: !!degraded,
    offline: topicText === OFFLINE_TOPIC,
    hasVerbatim: wantVerbatim,
    verbatimDropped: false,
    cp: 0,
  };
  if (wantVerbatim && cpLen([...lines, verbatimLine].join('\n')) > MT) {
    // 整句不录（绝不截断）；"改写进在聊"是写侧模型的事，这里只保证不落碎片
    verbatimLine = '- 原话：（无）';
    stats.hasVerbatim = false;
    stats.verbatimDropped = true;
  }
  lines.push(verbatimLine);
  const text = lines.join('\n');
  stats.cp = cpLen(text);
  return { text, stats };
}

/** 只要正文（多数调用方用它）；要 `verbatimDropped` 这类读数用 `buildHeadWithStats()` */
export function buildHead(args) {
  return buildHeadWithStats(args).text;
}

function pad(n) { return String(n).padStart(2, '0'); }

/**
 * 注入侧要的那份正文：去掉时间戳首行（时间戳每轮变 ⇒ 前缀缓存每轮失效）。
 * 文件里留时间是为了人读；注入的是"上个回合收口时记下的"，不带时间。
 */
export function forInjection(headText) {
  if (!headText) return '';
  const lines = String(headText).split(/\r?\n/);
  if (/^#\s*接续头/.test(lines[0])) lines[0] = '# 接续头（上个回合收口时记下的，不是活数据）';
  return lines.join('\n');
}

/**
 * 校验一份接续头文字；返回 `{ ok, problems[], stats }`。
 *
 * 形态判据：
 * - **3~4 行**：标题 + 「- 在聊：」+ 「- 原话：」；第 4 行只许是「原话」整句的**折行**。
 * - 「原话」行 **≤1 条**、必须**整句**（**不以省略号收尾**、不带「（裁到 N 码点）」尾巴）。
 * - 判定失败（degraded）⇒ 原话必须「（无）」，**不许**同时存在整句。
 * - 「在聊」是**摘要位**：允许 `（离线：需模型判定）` / 判定失败串，但不许拿原话前缀冒充。
 * - 第 2~4 行不许以时间戳结尾（那样注入版每轮都变）。
 */
export function checkHead(text, { maxTotal, maxTopic } = {}) {
  const lim = headLimits();
  const MT = Number.isFinite(Number(maxTotal)) ? Math.max(1, Math.trunc(Number(maxTotal))) : lim.maxTotal;
  const TP = Number.isFinite(Number(maxTopic)) ? Math.max(1, Math.trunc(Number(maxTopic))) : lim.maxTopic;

  const problems = [];
  const lines = String(text ?? '').split(/\r?\n/).filter((l) => l !== '');
  const first = lines[0] ?? '';
  const tsLooksOk = /^#\s*接续头\s*·\s*\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}$/.test(first);
  const stat = { cp: cpLen(text), lines: lines.length, first, tsLooksOk, degraded: false, hasVerbatim: false };

  if (!lines.length) {
    problems.push('空文本：接续头不是空文件（没有原料就压根别写这个文件）');
    return { ok: false, problems, stats: stat };
  }
  if (lines.length < 3 || lines.length > 4) {
    problems.push(`行数 = ${lines.length}，应为 3~4（标题 + 在聊 + 原话；原话整句太长而折行才是 4）`);
  }
  if (!tsLooksOk) problems.push(`第 1 行不是「# 接续头 · YYYY-MM-DD HH:MM」：${first.slice(0, 60)}`);
  if (cpLen(text) > MT) problems.push(`总码点 = ${cpLen(text)}，超过 ${MT}`);

  // 第 2 行：「在聊」= 摘要位
  const topicLine = lines[1] ?? '';
  if (!topicLine.startsWith('- 在聊：')) {
    problems.push('第 2 行不是「- 在聊：」（摘要位）');
  } else {
    const body = topicLine.slice('- 在聊：'.length).trim();
    stat.degraded = /判定失败|degraded/.test(body);
    if (!body) problems.push('「在聊」行是空的（没有摘要就写「（离线：需模型判定）」，判定失败写判定失败串）');
    else if (!stat.degraded && !body.startsWith('（离线：需模型判定）') && cpLen(body) > TP) {
      problems.push(`「在聊」摘要 = ${cpLen(body)} 码点，超过 ${TP}`);
    }
  }

  // 「原话」行：≤1 条、整句（不以省略号收尾）、与 degraded 不共存
  const vbIdx = lines.map((l, i) => (i >= 2 && l.startsWith('- 原话：') ? i : -1)).filter((i) => i >= 0);
  if (vbIdx.length === 0) {
    problems.push('缺「- 原话：」行（没有原话候选就写「（无）」，不许整行省略）');
  } else if (vbIdx.length > 1) {
    problems.push(`「原话」行出现 ${vbIdx.length} 次，最多 1 条`);
  } else {
    const body = lines[vbIdx[0]].slice('- 原话：'.length).trim();
    const isNone = body === '' || /^（无）$/.test(body);
    stat.hasVerbatim = !isNone;
    if (body === '') problems.push('「原话」行是空的（没有就写「（无）」）');
    if (!isNone) {
      if (/(…|\.\.\.|⋯)\s*$/.test(body)) {
        problems.push('「原话」行以省略号收尾 ⇒ 那是被截断的碎片，既不是摘要也不是原话（整句要整句）');
      }
      if (/（裁到\s*\d+\s*码点）\s*$/.test(body)) {
        problems.push('「原话」行带「（裁到 N 码点）」尾巴 ⇒ 原话不许截断');
      }
      if (stat.degraded) {
        problems.push('「在聊」写了判定失败，却仍写了原话整句 ⇒ 判定失败不许退回抄原话');
      }
    }
  }

  // 结构白名单：第 3 行起只许「- 原话：」或它的折行（不以 `- ` 开头的一行）
  for (let i = 2; i < lines.length; i += 1) {
    const l = lines[i];
    if (l.startsWith('- 原话：')) continue;
    if (i === 3 && !l.startsWith('- ')) continue;
    problems.push(`第 ${i + 1} 行不是许可的形态（只许「- 原话：」或其折行）：${l.slice(0, 40)}`);
  }

  // 时间戳只许「作为标题那一行」出现：正文行以时间戳结尾会让注入版每轮变
  for (const ln of lines.slice(1)) {
    if (/\s\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s*$/.test(ln)) problems.push('第 2~4 行有一行以时间戳结尾（注入会每轮变）');
  }

  // 思维链泄漏粗筛：真回复不会以这些起头还写这么长
  for (const [i, ln] of lines.entries()) {
    if (i === 0) continue;
    if (/^\s*-\s*(在聊|原话)：\s*(嗯|好，|让我|我需要|首先)/.test(ln) && cpLen(ln) >= 60) {
      problems.push(`第 ${i + 1} 行像思维链（被 reasoning 段污染）`);
    }
  }
  return { ok: problems.length === 0, problems, stats: stat };
}

// ───────────────────────── 会话文件读取（多帧 zstd） ─────────────────────────

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 读一份会话文件（多帧 zstd，逐帧解；坏帧只计数不抛）。 */
export function readSessionEvents(file) {
  const buf = fs.readFileSync(file);
  const starts = [];
  for (let i = 0; (i = buf.indexOf(MAGIC, i)) !== -1; i += 4) starts.push(i);
  const out = [];
  let bad = 0;
  for (let k = 0; k < starts.length; k += 1) {
    const s = starts[k];
    const e = k + 1 < starts.length ? starts[k + 1] : buf.length;
    let txt = '';
    try { txt = zlib.zstdDecompressSync(buf.subarray(s, e)).toString('utf8'); } catch { bad += 1; continue; }
    for (const ln of txt.split(/\r?\n/)) {
      if (!ln) continue;
      try { out.push(JSON.parse(ln)); } catch { /* 非 JSON 行忽略 */ }
    }
  }
  return { events: out, frames: starts.length, badFrames: bad };
}

const SESSION_FILE_NAMES = ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.v2.jsonl.zstd', 'session.jsonl.zstd'];

function pickSessionFileInDir(dir) {
  for (const n of SESSION_FILE_NAMES) {
    const p = path.join(dir, n);
    if (fs.existsSync(p)) return p;
  }
  const hit = fs.readdirSync(dir).filter((f) => /^session.*\.jsonl\.zstd$/.test(f)).sort().pop();
  return hit ? path.join(dir, hit) : null;
}

/** 把 `文件|目录|session id|id 前缀` 解析成一个会话文件路径（找不到不猜，回 `how`）。 */
export function resolveSessionFile(target, { home } = {}) {
  if (!target) return { file: null, how: 'none' };
  if (fs.existsSync(target)) {
    const st = fs.statSync(target);
    if (st.isDirectory()) return { file: pickSessionFileInDir(target), how: 'dir' };
    return { file: target, how: 'file' };
  }
  // 按 id / 前缀在本机 home 里搜（`<home>` 参数 > ROUTER_HOME/DSH_HOME > ~/.dsh）
  const roots = new Set();
  const explicit = String(home ?? '').trim();
  if (explicit) roots.add(explicit);
  for (const envName of ['ROUTER_HOME', 'DSH_HOME']) {
    const v = String(process.env[envName] ?? '').trim();
    if (v) roots.add(v);
  }
  roots.add(path.join(os.homedir(), '.dsh'));
  const id = String(target).replace(/^session-/, '');
  const cands = [];
  for (const root of [...roots]) {
    const sessions = path.join(root, 'sessions');
    if (!fs.existsSync(sessions)) continue;
    for (const ws of fs.readdirSync(sessions, { withFileTypes: true })) {
      if (!ws.isDirectory()) continue;
      const wsDir = path.join(sessions, ws.name);
      for (const s of fs.readdirSync(wsDir, { withFileTypes: true })) {
        if (!s.isDirectory()) continue;
        const bare = s.name.replace(/^session-/, '');
        if (bare === id || bare.startsWith(id)) cands.push(path.join(wsDir, s.name));
      }
    }
  }
  if (cands.length === 1) return { file: pickSessionFileInDir(cands[0]), how: 'id' };
  return { file: null, how: cands.length ? 'ambiguous' : 'notfound', candidates: cands };
}

// ───────────────────────── 夹具自测（空 / 超长 / 边界刚好不压） ─────────────────────────

export function selftest() {
  const results = [];
  const push = (name, ok, got, want) => results.push({ name, ok, got, want });
  const eq = (name, got, want) => push(name, JSON.stringify(got) === JSON.stringify(want), got, want);
  // 夹具里一律显式给阈值：不受本机配置影响（否则别人机器上跑会假红）
  const L = { maxTotal: 400, maxTopic: 60 };
  const now = new Date('2026-11-05T09:30:00+08:00');

  // 1) reasoning 不混入
  const evs = [
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '把发布脚本的版本号改成多少？' }] } },
    { type: 'assistant/message', data: { role: 'assistant', content: [
      { type: 'reasoning', text: '嗯…我得先想一下版本号与兼容性的关系，先看主版本再决定。'.repeat(10) },
      { type: 'text', text: '改成次版本号就行。' },
    ] } },
  ];
  const t1 = pickTailFromEvents(evs);
  eq('assistant 只取 text 段', t1.lastAssistant, '改成次版本号就行。');
  const naive = oneLine(evs[1].data.content.map((p) => p.text).join(' '));
  push('反例对照：不过滤 reasoning 会长出思维链', cpLen(naive) > cpLen(t1.lastAssistant) * 5, cpLen(naive), '>5x');

  // 2) 空文本步（纯 tool_call）不覆盖上一次真回复
  const evs2 = [...evs, { type: 'assistant/message', data: { role: 'assistant', content: [{ type: 'tool_call', name: 'read' }] } }];
  eq('纯 tool_call 步不覆盖', pickTailFromEvents(evs2).lastAssistant, '改成次版本号就行。');

  // 3) checkpoint 摘要不算人在说话
  const evs3 = [...evs, { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '<compacted-summary>This is an automatically generated checkpoint …' }] } }];
  eq('跳过 checkpoint', pickTailFromEvents(evs3).lastUser, '把发布脚本的版本号改成多少？');

  // 3b) 机器注入不是「人在说话」
  const evs3b = [...evs, { type: 'user/message', data: { role: 'user', source: { kind: 'time-context', form: 'snapshot' }, content: [{ type: 'text', text: 'Time sampled while preparing turn 1, step 25: 2026-11-05T01:00:00+08:00' }] } }];
  eq('跳过 time-context 注入', pickTailFromEvents(evs3b).lastUser, '把发布脚本的版本号改成多少？');
  // 3c) 未知来源照收（别的入口 kind 未登记 ⇒ 不许把人真话丢掉）
  const evs3c = [...evs, { type: 'user/message', data: { role: 'user', source: { kind: 'some-chat-bridge' }, content: [{ type: 'text', text: '在吗，我想早点收工' }] } }];
  eq('未知来源照收', pickTailFromEvents(evs3c).lastUser, '在吗，我想早点收工');

  // 4) 码点不劈半（emoji 是代理对，按 UTF-16 长度切会劈开）
  eq('emoji 不劈半', clip('🐟'.repeat(5), 3), '🐟🐟🐟…');

  // 5) 完整头：格式 + 体积（写侧给得出摘要的情形）
  const head = buildHead({ ...t1, topic: '刚聊到版本号怎么升', now, ...L });
  const c = checkHead(head, L);
  push('生成的头通过自检', c.ok, c.problems, []);
  push('整份 ≤ maxTotal 码点', c.stats.cp <= L.maxTotal, c.stats.cp, '<=400');
  push('首行带时间戳', c.stats.tsLooksOk, c.stats.first, '# 接续头 · 2026-11-05 09:30');
  push('只有 3 行（原话缺省为「（无）」）⇒ 通过', c.ok && c.stats.lines === 3 && head.includes('- 原话：（无）'), { lines: c.stats.lines, problems: c.problems }, '3 行 · ok');

  // 5b) 离线器具没有模型 ⇒ 摘要位**不许**假装是摘要
  const headOffline = buildHead({ ...t1, now, ...L });
  push('摘要位不许假装是摘要（离线写「（离线：需模型判定）」）',
    headOffline.includes('- 在聊：（离线：需模型判定）') && checkHead(headOffline, L).ok,
    headOffline.split('\n')[1], '- 在聊：（离线：需模型判定）');

  // 5c) 原话整句照抄（不裁剪）；形态照样通过
  const VB = '先别急着发版，等对端机器回来再说';
  const headVb = buildHead({ ...t1, topic: '刚聊到先别急着发版', verbatim: VB, now, ...L });
  push('原话整句原样照抄、且通过自检', checkHead(headVb, L).ok && headVb.includes(VB), checkHead(headVb, L).problems, []);

  // 6) 空输入：一个原料都没有 ⇒ null（干净启动）
  eq('空输入 ⇒ null（读侧一个字都不加）', buildHead({ ...L }), null);
  push('空文本校验判红（判据不许空转）', checkHead('', L).ok === false, checkHead('', L).problems, '>0');

  // 7) 超长输入：原话整句超预算 ⇒ 整句不录（绝不截断），记 verbatimDropped
  const r7 = buildHeadWithStats({ ...t1, topic: '刚聊到一件长话', verbatim: '为'.repeat(500), now, ...L });
  push('超长：原话整句不录、不截断（记 verbatim-dropped）',
    r7.stats.verbatimDropped === true && !r7.text.includes('为为') && checkHead(r7.text, L).ok,
    r7.stats, 'verbatimDropped=true');

  // 8) 边界刚好不压：「在聊」= 上限不截断，+1 才截断
  const fitTopic = topicOf('a'.repeat(60), { maxTopic: 60 });
  const overTopic = topicOf('a'.repeat(61), { maxTopic: 60 });
  push('边界：「在聊」= 上限时不压（无省略号）', fitTopic === 'a'.repeat(60) && !fitTopic.includes('…'), cpLen(fitTopic), 60);
  push('边界：「在聊」超 1 个码点才压（带省略号且仍 ≤ 上限）',
    overTopic.endsWith('…') && cpLen(overTopic) <= 60, cpLen(overTopic), '<=60 且带…');

  // 9) 边界刚好不压：整份 = maxTotal 收下，多 1 个码点才丢原话
  const small = { maxTotal: 54, maxTopic: 10 };
  const fitHead = buildHeadWithStats({ lastUser: 'u', topic: 'b'.repeat(10), verbatim: 'c'.repeat(8), now, ...small });
  const overHead = buildHeadWithStats({ lastUser: 'u', topic: 'b'.repeat(10), verbatim: 'c'.repeat(9), now, ...small });
  push('边界：整份正好 = maxTotal ⇒ 收下', cpLen(fitHead.text) === 54 && fitHead.stats.verbatimDropped === false, cpLen(fitHead.text), 54);
  push('边界：多 1 个码点 ⇒ 丢原话', overHead.stats.verbatimDropped === true, overHead.stats.verbatimDropped, true);

  // 10) 阈值可配：同一份输入，maxTotal 调小 ⇒ 更早丢
  push('阈值可配（maxTotal 54 留 / 40 丢）',
    buildHeadWithStats({ lastUser: 'u', topic: 'b'.repeat(10), verbatim: 'c'.repeat(8), now, maxTopic: 10, maxTotal: 54 }).stats.verbatimDropped === false
    && buildHeadWithStats({ lastUser: 'u', topic: 'b'.repeat(10), verbatim: 'c'.repeat(8), now, maxTopic: 10, maxTotal: 40 }).stats.verbatimDropped === true,
    '两者不同', '不同');

  // 11) 注入版去掉时间戳
  const inj = forInjection(head);
  push('注入版不含时间戳', !/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(inj), inj.split('\n')[0], '无日期');

  // 12) 负例：手工造坏头，check 必须报红
  push('负例：缺行 ⇒ 判红', checkHead('# 接续头 · 2026-11-05 09:30\n- 甲：x\n- 乙：y', L).ok === false, 'ok=false', 'false');
  push('负例：正文含时间戳 ⇒ 判红', checkHead('# 接续头 · 2026-11-05 09:30\n- 在聊：刚聊到重启时间 2026-11-05 09:31\n- 原话：（无）', L).ok === false, 'ok=false', 'false');
  const truncated = checkHead(`# 接续头 · 2026-11-05 09:30\n- 在聊：刚聊到发版时间\n- 原话：${VB.slice(0, 10)}…`, L);
  push('负例：原话带省略号 ⇒ 判红', truncated.ok === false && truncated.problems.some((p) => p.includes('省略号')), truncated.problems.length, '>0');
  push('负例：「原话」行 2 条 ⇒ 判红', checkHead('# 接续头 · 2026-11-05 09:30\n- 在聊：两件事\n- 原话：第一句\n- 原话：第二句', L).ok === false, 'ok=false', 'false');
  push('负例：判定失败却写原话 ⇒ 判红', checkHead(`# 接续头 · 2026-11-05 09:30\n- 在聊：${DEGRADED_TOPIC}\n- 原话：${VB}`, L).ok === false, 'ok=false', 'false');
  push('负例：行数超 4 ⇒ 判红', checkHead('# 接续头 · 2026-11-05 09:30\n- 在聊：a\n- 原话：（无）\n- 备注：x\n- 备注：y', L).ok === false, 'ok=false', 'false');

  // 13) 正例：判定失败 ⇒ 写判定失败串、不抄原话
  const okDeg = buildHead({ ...t1, degraded: true, verbatim: VB, now, ...L });
  push('正例：判定失败 ⇒ 不抄原话', checkHead(okDeg, L).ok && !okDeg.includes('对端机器'), checkHead(okDeg, L).problems, []);

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `  got=${JSON.stringify(r.got)} want=${JSON.stringify(r.want)}`}`);
  console.log(`\nselftest: ${results.length - failed.length}/${results.length} PASS`);
  return failed.length === 0;
}

// ───────────────────────── CLI ─────────────────────────

export const USAGE = `lib/router-head.mjs —— 接续头压缩（3~4 行 · 整份 ≤${DEFAULT_MAX_TOTAL} 码点 · 默认 dry-run）

  node lib/router-head.mjs --from-session <文件|目录|sessionId|id前缀> [--write <目录>] [--json]
  node lib/router-head.mjs --check <接续头文件> [--json]
  node lib/router-head.mjs --selftest
  node lib/router-head.mjs --help

  --from-session  从会话文件取「最近三句」原料，生成接续头（不给 --write 就只打印，不写盘）
  --check         校验一份接续头；不通过 rc=1
  --write         写到 <目录>/<会话 id 前 8 位>.md（**只新建/覆盖这一份头文件**，不碰会话、不删任何东西）
  --max-total N   整份码点上限（env ROUTER_HEAD_MAX_TOTAL / 配置 head.maxTotal；缺省 ${DEFAULT_MAX_TOTAL}）
  --max-topic N   「在聊」码点上限（env ROUTER_HEAD_MAX_TOPIC / 配置 head.maxTopic；缺省 ${DEFAULT_MAX_TOPIC}）

  配置文件：${configFile()}（不在 = 没配置）
`;

function main(argv) {
  const args = argv.slice(2);
  const val = (name) => { const i = args.indexOf(name); return i >= 0 ? (args[i + 1] ?? '') : undefined; };
  const has = (name) => args.includes(name);
  const limits = { maxTotal: Number(val('--max-total')) || undefined, maxTopic: Number(val('--max-topic')) || undefined };

  if (has('--help') || has('-h') || !args.length) {
    process.stdout.write(`${USAGE}\n`);
    process.exitCode = args.length ? 0 : 2;
    return;
  }

  if (has('--selftest')) {
    const ok = selftest();
    process.exitCode = ok ? 0 : 3;
    return;
  }

  if (has('--check')) {
    const f = val('--check');
    if (!f || !fs.existsSync(f)) { console.error(`找不到文件：${f}`); process.exitCode = 2; return; }
    const r = checkHead(fs.readFileSync(f, 'utf8'), limits);
    if (has('--json')) console.log(JSON.stringify(r, null, 1));
    else {
      console.log(`file = ${f}`);
      console.log(`cp = ${r.stats.cp}  行数 = ${r.stats.lines}  首行 = ${r.stats.first}`);
      console.log(r.ok ? 'OK 通过' : `FAIL\n${r.problems.map((p) => `  · ${p}`).join('\n')}`);
    }
    process.exitCode = r.ok ? 0 : 1;
    return;
  }

  if (has('--from-session')) {
    const tgt = val('--from-session');
    const hit = resolveSessionFile(tgt);
    if (!hit.file) {
      console.error(`取不到会话文件（target=${tgt} how=${hit.how}）${hit.candidates ? `\n  候选：\n  ${hit.candidates.join('\n  ')}` : ''}`);
      process.exitCode = 1;
      return;
    }
    const { events, frames, badFrames } = readSessionEvents(hit.file);
    const tail = pickTailFromEvents(events);
    const built = buildHeadWithStats({ ...tail, ...limits });
    const head = built.text;
    const outDir = val('--write');
    const sid = path.basename(path.dirname(hit.file));
    const payload = {
      file: hit.file, frames, badFrames, events: events.length,
      // 原料（离线能取到的那两句）—— 不含"判定产物"
      raw: { lastUser: tail.lastUser, lastAssistant: tail.lastAssistant },
      head,
      injection: forInjection(head),
      stats: built.stats,
      check: head ? checkHead(head, limits) : null,
      wouldWriteTo: outDir ? path.join(outDir, `${sid.replace(/^session-/, '').slice(0, 8)}.md`) : null,
      note: '离线没有模型 ⇒「在聊」只能写「（离线：需模型判定）」；「原话」要不要抄由写侧按「换种说法意思变不变」判。本件证明的是「取得到原料」。',
    };
    if (outDir && head) {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(payload.wouldWriteTo, `${head}\n`, 'utf8');
    }
    if (has('--json')) console.log(JSON.stringify(payload, null, 1));
    else {
      console.log(`file      = ${payload.file}`);
      console.log(`帧 = ${frames}（坏帧 ${badFrames}）  事件 = ${events.length}`);
      console.log(`原料 lastUser      = ${tail.lastUser ? `${cpLen(tail.lastUser)} 码点` : '（无）'}`);
      console.log(`原料 lastAssistant = ${tail.lastAssistant ? `${cpLen(tail.lastAssistant)} 码点` : '（无）'}`);
      console.log('--- 接续头（离线形态：摘要位待模型判）---');
      console.log(head ?? '（取不到原料 ⇒ 读侧一个字都不加）');
      console.log('--- 判据 ---');
      console.log(payload.check ? (payload.check.ok ? `OK  cp=${payload.check.stats.cp}` : `FAIL ${payload.check.problems.join('; ')}`) : '（无头）');
      if (payload.stats?.verbatimDropped) console.log('⚠️ 原话整句超预算 ⇒ 已整句不录（写侧该记一行 verbatim-dropped）');
      if (payload.wouldWriteTo) console.log(`已写入：${payload.wouldWriteTo}`);
    }
    process.exitCode = head ? 0 : 1;
    return;
  }

  process.stderr.write('用法错：给 --from-session / --check / --selftest 之一（--help 看全文）\n');
  process.exitCode = 2;
}

function isDirectRun() {
  try {
    const self = fileURLToPath(import.meta.url);
    const entry = process.argv[1];
    if (!entry) return false;
    return fs.realpathSync(entry).toLowerCase() === fs.realpathSync(self).toLowerCase();
  } catch { return false; }
}

if (isDirectRun()) main(process.argv);

export default {
  headLimits, pickTailFromEvents, isHumanMessage, clip, oneLine, cpLen, topicOf,
  buildHead, buildHeadWithStats, forInjection, checkHead, readSessionEvents, resolveSessionFile,
  selftest, USAGE,
};
