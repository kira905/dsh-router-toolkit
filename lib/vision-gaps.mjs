/**
 * lib/vision-gaps.mjs —— 「愿景缺口」：**一条线声明的目标** vs **它在看板上的现状**，差在哪。
 *
 * 一句话说清它在回答什么：`brief` 第 1~3 行告诉你"现在什么在跑"，本件告诉你"**下一步该推哪条线**"。
 * 它只读：读一目录"愿景件"（每条线一个 JSON）+ 看板车况 + 一张可选的「操作者优先级清单」，
 * 算出排序后给 Top-N。**不写任何文件、不改任何卡**。
 *
 * 愿景件形状（每条线一个文件，文件名随意，字段名按这个来）：
 * ```json
 * { "line": "发布线", "humanDoc": "docs/发布线.md",
 *   "asks": [ { "id": "a1", "kind": "self-todo", "what": "把回滚演练补上" } ] }
 * ```
 * `kind` → 档（A=卡在操作者手上 / B=能力缺口 / C=自己就能干）走一张**可覆盖**的映射表；
 * 未登记的 kind 一律按 B 计，并在 `warnings` 里点名（**不许静默吞**）。
 *
 * 排序公式（每个权重都能配，见 `DEFAULT_VISION_WEIGHTS` 与 `resolveVisionWeights()`）：
 * ```
 * score(线) = w.askC × C类ask数
 *           + w.inFlight × (在途卡数 > 0 ? 1 : 0)
 *           + w.activityPerDay × min(活动天数, w.activityCapDays)
 *           + w.askA × A类ask数
 *           + (命中操作者优先级 ? w.priorityHit : 0)
 * ```
 * 「该线排名第一的 ask」= C ＞ B ＞ A（同档按原序）：只有整条线只剩 A 时，第一才落在 A 上，
 * 那时渲染成「等操作者：…」而不是「差：…」—— **卡在人手上的事不该抢走"该推"的位置**。
 */
import fs from 'node:fs';
import path from 'node:path';
import { makeResolver } from './config.mjs';
import { resolveHome } from './home.mjs';

/** 示例映射（我们自己的三种 ask 分类）。你的愿景件用别的词 ⇒ 配置 `vision.kindTiers` 覆盖。 */
export const DEFAULT_KIND_TIERS = {
  'blocked-by-owner': 'A',   // 卡在操作者手上：只上桌，不进「该推」
  'capability-gap': 'B',     // 能力缺口
  'self-todo': 'C',          // 自己就能干的：最该推
};

const TIER_RANK = { C: 0, B: 1, A: 2 };

/** 每个权重的 env 名（`vision.weights.<k>` 是配置键，缺省见下表）。 */
const WEIGHT_ENV = {
  askC: 'ROUTER_GAP_W_ASKC',
  inFlight: 'ROUTER_GAP_W_INFLIGHT',
  activityPerDay: 'ROUTER_GAP_W_ACTIVITY',
  activityCapDays: 'ROUTER_GAP_ACTIVITY_CAP_DAYS',
  askA: 'ROUTER_GAP_W_ASKA',
  priorityHit: 'ROUTER_GAP_W_PRIORITY',
};

/** 缺省权重（改它们请走 env / 配置文件；改完 `brief --gaps` 立刻生效，**不用改代码**）。 */
export const DEFAULT_VISION_WEIGHTS = {
  askC: 3,              // 一条"C 类（自己就能干）"值多少分
  inFlight: 2,          // 这条线有在途卡（跑/待/验收/失败）额外加多少
  activityPerDay: 0.5,  // 每"安静一天"加多少（越久没动越该回头看）
  activityCapDays: 7,   // 上面那一项最多算几天
  askA: -0.2,           // 一条"A 类（卡在操作者手上）"倒扣多少
  priorityHit: 5,       // 命中操作者优先级清单加多少
};

export const DEFAULT_GAP_TOP = 3;
export const DEFAULT_GAP_TEXT_CHARS = 40;

/** kind → 档；未登记 ⇒ {tier:'B', known:false}（按 B 计，调用方负责点名）。 */
export function tierOfKind(kind, tiers = DEFAULT_KIND_TIERS) {
  const k = String(kind ?? '').trim();
  const t = (tiers || {})[k];
  return t === 'A' || t === 'B' || t === 'C' ? { tier: t, known: true } : { tier: 'B', known: false };
}

/** ask 的正文：`what` 是第一口径，`text` / `next` 只作兜底。 */
export function askTextOf(a) {
  return String(a?.what ?? a?.text ?? a?.next ?? '').trim();
}

/** 一条线内部「哪条 ask 排第一」：C ＞ B ＞ A，同档按数组原序（保证可复现）。 */
export function rankAsks(asks, tiers = DEFAULT_KIND_TIERS) {
  const arr = (Array.isArray(asks) ? asks : []).map((a, i) => {
    const { tier, known } = tierOfKind(a?.kind, tiers);
    return { id: String(a?.id ?? '').trim() || '?', kind: String(a?.kind ?? '').trim(), tier, known, text: askTextOf(a), i };
  });
  return arr.sort((x, y) => (TIER_RANK[x.tier] - TIER_RANK[y.tier]) || (x.i - y.i));
}

/**
 * 扫一个愿景目录。**永不抛**：读不动 / 坏 JSON / 缺字段 只进 `warnings`（报黄不修，谁写的谁修）。
 *
 * @param {string} dir 目录
 * @param {{at?:number, tiers?:object}} [opts]
 * @returns {{at:string, dir:string, lines:Array, totals:object, note:string, warnings:string[]}}
 */
export function scanVisionDir(dir, { at = Date.now(), tiers = DEFAULT_KIND_TIERS } = {}) {
  const out = {
    at: new Date(at).toISOString(),
    dir: String(dir ?? ''),
    lines: [],
    totals: { files: 0, vision: 0, ok: 0, missing: 0, broken: 0, asksTotal: 0, askA: 0, askB: 0, askC: 0 },
    note: '',
    warnings: [],
  };
  if (!out.dir) {
    out.note = '没有指定愿景目录（`ROUTER_VISION_DIR` / 配置 `vision.dir`）';
    out.warnings.push(out.note);
    return out;
  }

  let files;
  try {
    files = fs.readdirSync(out.dir).filter((f) => /\.json$/i.test(f)).sort();
  } catch (e) {
    out.note = `目录不存在或读不动：${out.dir}（${e?.code ?? e?.message ?? 'ERR'}）`;
    out.warnings.push(out.note);
    return out;
  }
  out.totals.files = files.length;
  if (!files.length) {
    out.note = `目录里没有 .json：${out.dir}`;
    out.warnings.push(out.note);
    return out;
  }

  for (const f of files) {
    const file = path.join(out.dir, f);
    const base = { file, jsonStatus: 'ok', line: '', version: '', updatedAt: '', humanDoc: '', asksTotal: 0, askA: 0, askB: 0, askC: 0, askTop: null, isVision: false, warnings: [] };

    let txt;
    try {
      txt = fs.readFileSync(file, 'utf8');
    } catch (e) {
      out.totals.broken += 1;
      out.lines.push({ ...base, file: f, line: `${f}（读不动）`, jsonStatus: 'broken', warnings: [`读不动：${e?.code ?? e?.message ?? 'ERR'}`] });
      out.warnings.push(`${f}：读不动（${e?.code ?? e?.message ?? 'ERR'}）`);
      continue;
    }

    let obj;
    try {
      obj = JSON.parse(txt);
    } catch (e) {
      out.totals.broken += 1;
      out.lines.push({ ...base, file: f, line: `${f}（坏 JSON）`, jsonStatus: 'broken', warnings: [`坏 JSON：${e?.message ?? e}`] });
      out.warnings.push(`${f}：坏 JSON（${e?.message ?? e}）—— 报黄不修`);
      continue;
    }

    const lineName = typeof obj?.line === 'string' ? obj.line.trim() : '';
    const asks = Array.isArray(obj?.asks) ? obj.asks : null;
    const entry = {
      ...base,
      file: f,
      line: lineName || `(无 line：${f})`,
      version: typeof obj?.version === 'string' ? obj.version : '',
      updatedAt: typeof obj?.updatedAt === 'string' ? obj.updatedAt : '',
      humanDoc: typeof obj?.humanDoc === 'string' ? obj.humanDoc.trim() : '',
    };

    const miss = [];
    if (!lineName) miss.push('line');
    if (!asks) miss.push('asks[]');
    if (miss.length) {
      entry.jsonStatus = 'missing';
      entry.warnings.push(`字段缺：${miss.join(' / ')}`);
      out.totals.missing += 1;
      out.lines.push(entry);
      out.warnings.push(`${f}：字段缺（${miss.join(' / ')}）—— 不是愿景件，不入「愿景差距」`);
      continue;
    }

    entry.isVision = true;
    entry.asksTotal = asks.length;
    for (const a of asks) {
      const t = tierOfKind(a?.kind, tiers);
      if (t.tier === 'A') entry.askA += 1;
      else if (t.tier === 'C') entry.askC += 1;
      else entry.askB += 1;
      if (!t.known) entry.warnings.push(`未映射 kind："${String(a?.kind ?? '').trim() || '(空)'}"（按 B 计）`);
    }
    const ranked = rankAsks(asks, tiers);
    entry.askTop = ranked.length ? { id: ranked[0].id, kind: ranked[0].kind, tier: ranked[0].tier, text: ranked[0].text } : null;
    if (entry.warnings.length) out.warnings.push(`${f}：${[...new Set(entry.warnings)].join('；')}`);

    out.lines.push(entry);
    out.totals.vision += 1;
    out.totals.ok += 1;
    out.totals.asksTotal += entry.asksTotal;
    out.totals.askA += entry.askA;
    out.totals.askB += entry.askB;
    out.totals.askC += entry.askC;
  }

  return out;
}

/** 比线名用：去掉空白与中点（"发布线 · 判据" 与 "发布线" 要能对上）。 */
const keyOf = (s) => String(s ?? '').toLowerCase().replace(/[\s·・]/g, '');

/** 命中操作者优先级：线名与条目**互为子串**即算（条目是人随口写的短语，不会一字不差等于线名）。 */
export function ownerPriorityHit(line, items) {
  const l = keyOf(line);
  if (!l) return false;
  return (Array.isArray(items) ? items : []).some((it) => {
    const s = keyOf(it);
    return !!s && (s.includes(l) || l.includes(s));
  });
}

/**
 * 读「操作者优先级清单」—— **只读**。
 * 缺省 `<home>/router-state.json#ownerPriority.items`（`ROUTER_PRIORITY_FILE` / 配置
 * `vision.priorityFile`、`vision.priorityKey` 可改）。🔴 字段不存在 ⇒ 空数组（= 权重 0）：
 * **不报错、不创建这个文件、不猜**。
 */
export function readOwnerPriorityItems({ file, key } = {}) {
  const r = makeResolver();
  const f = String(file ?? '').trim()
    || r.str('ROUTER_PRIORITY_FILE', 'vision.priorityFile', path.join(resolveHome(process.env.ROUTER_HOME), 'router-state.json'));
  const k = String(key ?? '').trim() || r.str('ROUTER_PRIORITY_KEY', 'vision.priorityKey', 'ownerPriority.items');
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return [];
  }
  let cur = doc;
  for (const seg of k.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return [];
    cur = cur[seg];
  }
  return Array.isArray(cur) ? cur.map((x) => String(x ?? '').trim()).filter(Boolean) : [];
}

/** 「上次收口」= 结论档里该线最新那一行；对不上就取**最长**的互为子串匹配，都没有 ⇒ null（不猜）。 */
export function lastDigestOf(line, slots) {
  const l = keyOf(line);
  let best = null;
  let bestLen = -1;
  for (const s of Array.isArray(slots) ? slots : []) {
    const k = keyOf(s?.line);
    if (!k) continue;
    if (String(s.line) === String(line)) return s.date ?? null;
    if (l && (l.includes(k) || k.includes(l)) && k.length > bestLen) {
      bestLen = k.length;
      best = s.date ?? null;
    }
  }
  return best;
}

const activeCount = (r) => (Number(r?.run) || 0) + (Number(r?.todo) || 0) + (Number(r?.review) || 0) + (Number(r?.failed) || 0);

/**
 * 算「愿景缺口」排序（**纯函数**：权重从参数来，不读 env —— 要 env 用 `buildVisionGaps()`）。
 *
 * @returns {Array<{line,askId,kind,tier,text,score,activityDays,lastDigest,asksTotal,askA,askB,askC,cards,ownerPriority}>}
 */
export function computeVisionGaps({ lines = [], rows = [], ownerItems = [], slots = [], now = Date.now(), weights } = {}) {
  const w = { ...DEFAULT_VISION_WEIGHTS, ...(weights || {}) };
  const inFlight = new Map();
  const lastAt = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    inFlight.set(r?.line, activeCount(r));
    lastAt.set(r?.line, Number(r?.lastAt) || 0);
  }

  const out = [];
  for (const L of Array.isArray(lines) ? lines : []) {
    if (!L || L.jsonStatus !== 'ok' || !L.isVision || !L.asksTotal || !L.askTop) continue;
    const line = String(L.line ?? '').trim();
    if (!line) continue;
    const cards = inFlight.get(line) ?? 0;
    const at = lastAt.get(line) ?? 0;
    const activityDays = at > 0 ? Math.max(0, Math.floor((now - at) / 86_400_000)) : 0;
    const hit = ownerPriorityHit(line, ownerItems);
    const raw = w.askC * (Number(L.askC) || 0)
      + w.inFlight * (cards > 0 ? 1 : 0)
      + w.activityPerDay * Math.min(activityDays, w.activityCapDays)
      + w.askA * (Number(L.askA) || 0)
      + (hit ? w.priorityHit : 0);
    out.push({
      line,
      askId: L.askTop.id,
      kind: L.askTop.kind,
      tier: L.askTop.tier,
      text: L.askTop.text,
      score: Math.round(raw * 100) / 100,
      activityDays,
      lastDigest: lastDigestOf(line, slots),
      asksTotal: L.asksTotal, askA: L.askA, askB: L.askB, askC: L.askC,
      cards,
      ownerPriority: hit,
    });
  }
  // 分数降序；同分按线名 —— **可复现**，不靠数组顺序碰运气
  out.sort((a, b) => (b.score - a.score) || String(a.line).localeCompare(String(b.line), 'zh-Hans-CN'));
  return out;
}

/** 截 N 个**字符**（码点；不是显示宽）。 */
export function clipChars(s, n) {
  const a = [...String(s ?? '')];
  return a.length <= n ? a.join('') : `${a.slice(0, n).join('')}…`;
}

/**
 * 人读那一段：标题 + ≤top 行；没有数据时**明确写一行**，不硬凑。
 * @param {Array} gaps
 * @param {{note?:string, top?:number, textChars?:number}} [opts]
 */
export function renderVisionGaps(gaps = [], { note = '', top = DEFAULT_GAP_TOP, textChars = DEFAULT_GAP_TEXT_CHARS } = {}) {
  const n = Math.max(1, Math.trunc(Number(top) || DEFAULT_GAP_TOP));
  const L = [`愿景差距（Top-${n}）：`];
  const shown = (Array.isArray(gaps) ? gaps : []).slice(0, n);
  if (!shown.length) {
    L.push(note || '（没有可读的愿景件：本轮没有该推的线）');
    return L.join('\n');
  }
  for (const g of shown) {
    const label = g?.tier === 'A' ? '等操作者' : '差';
    const text = clipChars(String(g?.text ?? '').replace(/\s+/g, ' ').trim(), textChars);
    L.push(`· ${g?.line}｜${label}：${text}（${g?.askId} · ${g?.tier}）｜活动 ${g?.activityDays} 天前｜上次收口 ${g?.lastDigest || '—'}`);
  }
  const rest = gaps.length - shown.length;
  if (rest > 0) L.push(`（另有 ${rest} 条线未展开：完整排序看 brief --gaps --json 的 visionGaps）`);
  else if (note) L.push(note);
  return L.join('\n');
}

/** 现读愿景目录 + 车况 ⇒ 愿景缺口（这一层负责读 env / 配置，纯函数在下面）。**永不抛**。 */
export function buildVisionGaps({ dir, rows = [], slots = [], now = Date.now() } = {}) {
  const r = makeResolver();
  const visionDir = String(dir ?? '').trim()
    || r.str('ROUTER_VISION_DIR', 'vision.dir', path.join(process.cwd(), 'docs', 'vision'));
  const cfgTiers = r.cfg?.vision?.kindTiers;
  const tiers = cfgTiers && typeof cfgTiers === 'object' && !Array.isArray(cfgTiers) ? cfgTiers : DEFAULT_KIND_TIERS;
  const weights = resolveVisionWeights(r);
  const top = r.int('ROUTER_GAP_TOP', 'vision.top', DEFAULT_GAP_TOP);
  const textChars = r.int('ROUTER_GAP_TEXT_CHARS', 'vision.textChars', DEFAULT_GAP_TEXT_CHARS);

  const idx = scanVisionDir(visionDir, { at: now, tiers });
  const gaps = computeVisionGaps({ lines: idx.lines, rows, ownerItems: readOwnerPriorityItems(), slots, now, weights });

  let note = '';
  if (!gaps.length) {
    const anyVision = (idx.lines || []).some((l) => l?.isVision);
    note = anyVision
      ? '（愿景件里没有带 asks 的线：本轮没有该推的线）'
      : `（没有可读的愿景件：${visionDir}）`;
    if (idx.note) note += `（${idx.note}）`;
  }
  return { idx, gaps, note, view: { dir: visionDir, top, textChars, weights }, warnings: [...r.warnings, ...(idx.warnings || [])] };
}

/** 权重：env > 配置(`vision.weights.<k>`) > 缺省。 */
export function resolveVisionWeights(r = makeResolver()) {
  const w = {};
  for (const [k, def] of Object.entries(DEFAULT_VISION_WEIGHTS)) {
    w[k] = r.num(WEIGHT_ENV[k], `vision.weights.${k}`, def);
  }
  return w;
}

export default {
  DEFAULT_KIND_TIERS, DEFAULT_VISION_WEIGHTS, DEFAULT_GAP_TOP, DEFAULT_GAP_TEXT_CHARS,
  tierOfKind, askTextOf, rankAsks, scanVisionDir, ownerPriorityHit, readOwnerPriorityItems,
  lastDigestOf, computeVisionGaps, clipChars, renderVisionGaps, buildVisionGaps, resolveVisionWeights,
};
