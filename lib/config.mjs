/**
 * lib/config.mjs —— 「**env > 配置文件 > 缺省**」的唯一解析入口。
 *
 * 为什么单列一份：0.1.x 里阈值都写死在文件顶部（`SLOT_MAX = 16` / `MAX_TOTAL = 400` / 三条失败卡判据的
 * 文案…）。写死的东西换个部署就得改代码 —— 而"改代码"是最贵的一种配置。
 * 这里把**取值顺序**收成一个函数，任何阈值都只写一行：
 *
 *   const r = makeResolver();
 *   const maxTotal = r.int('ROUTER_HEAD_MAX_TOTAL', 'head.maxTotal', 400);
 *
 * 取值顺序（高 → 低）：
 *   ① 环境变量 `env`（非空才算给了）
 *   ② 配置文件 `key`（点分路径，如 `head.maxTotal`）
 *   ③ 代码里的缺省值 `def`
 *
 * 配置文件默认 `<home>/router-config.json`（`ROUTER_CONFIG_FILE` 可指到别处）；**文件不在 = 没配置**，
 * 不创建、不报错。非法值（`ROUTER_HEAD_MAX_TOTAL=abc`）**回落缺省并记一条 warning** —— 绝不返回 NaN
 * 让下游拿一堆 NaN 去比大小。
 *
 * 🔴 本件不缓存、不写盘：每次 `makeResolver()` 现读（一轮进程里调用方自己复用一份）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveHome } from './home.mjs';

/** 配置文件路径：`ROUTER_CONFIG_FILE` > `<home>/router-config.json`。 */
export function configFile(explicit) {
  const v = String(explicit ?? process.env.ROUTER_CONFIG_FILE ?? '').trim();
  return v ? path.resolve(v) : path.join(resolveHome(process.env.ROUTER_HOME), 'router-config.json');
}

/** 读配置；**任何失败都当"没配置"**（坏 JSON 也不抛，只是整份忽略）。 */
export function loadConfig(file = configFile()) {
  let txt;
  try {
    txt = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  try {
    const j = JSON.parse(txt);
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

/** 点分路径取值（`'a.b.c'`）；中途不是对象就返回 undefined。 */
export function getPath(obj, key) {
  if (!key) return obj;
  let cur = obj;
  for (const seg of String(key).split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

const TRUE_WORDS = new Set(['1', 'true', 'yes', 'y', 'on', '是']);
const FALSE_WORDS = new Set(['0', 'false', 'no', 'n', 'off', '否']);

/**
 * 造一个解析器。同一个进程里**复用一份**就够（它会记 trace / warnings）。
 *
 * @param {object} cfg 已加载的配置对象（缺省现读配置文件）
 * @returns {{file:string, cfg:object, str:Function, int:Function, num:Function, bool:Function, list:Function, trace:Array, warnings:Array}}
 */
export function makeResolver(cfg = loadConfig()) {
  const trace = [];
  const warnings = [];
  const file = configFile();

  /** 取原始值 + 来源；三种 kind 共用（解析失败由调用方按 kind 处理）。 */
  const pick = (env, key, def) => {
    const rawEnv = env ? process.env[env] : undefined;
    if (typeof rawEnv === 'string' && rawEnv.trim() !== '') return { raw: rawEnv.trim(), source: 'env' };
    const rawCfg = getPath(cfg, key);
    if (rawCfg !== undefined && rawCfg !== null) return { raw: rawCfg, source: 'config' };
    return { raw: def, source: 'default' };
  };

  const record = (env, key, value, source) => { trace.push({ env: env ?? null, key: key ?? null, value, source }); return value; };
  const bad = (env, key, raw, kind, def) => {
    warnings.push(`配置 ${env ? `env ${env}` : key} 的值 "${String(raw)}" 不是合法 ${kind} ⇒ 用缺省 ${String(def)}`);
    return null;
  };

  const str = (env, key, def) => {
    const { raw, source } = pick(env, key, def);
    const v = String(raw ?? '');
    return record(env, key, v, source);
  };

  const num = (env, key, def) => {
    const { raw, source } = pick(env, key, def);
    const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
    if (!Number.isFinite(n)) { bad(env, key, raw, '数字', def); return record(env, key, def, 'default'); }
    return record(env, key, n, source);
  };

  const int = (env, key, def) => {
    const n = num(env, key, def);
    return Number.isFinite(n) ? Math.trunc(n) : def;
  };

  const bool = (env, key, def) => {
    const { raw, source } = pick(env, key, def);
    if (typeof raw === 'boolean') return record(env, key, raw, source);
    const s = String(raw ?? '').trim().toLowerCase();
    if (TRUE_WORDS.has(s)) return record(env, key, true, source);
    if (FALSE_WORDS.has(s)) return record(env, key, false, source);
    bad(env, key, raw, '开关（true/false）', def);
    return record(env, key, def, 'default');
  };

  /** 列表：配置侧给数组，env 侧用逗号切（空格/空项自动丢掉）。 */
  const list = (env, key, def) => {
    const { raw, source } = pick(env, key, def);
    let arr;
    if (Array.isArray(raw)) arr = raw;
    else arr = String(raw ?? '').split(',');
    const clean = arr.map((x) => String(x ?? '').trim()).filter(Boolean);
    return record(env, key, clean, source);
  };

  return { file, cfg, str, num, int, bool, list, trace, warnings };
}

/** 一份给人看的「这些值是从哪来的」表（交付报告 / `--json` 用得上）。 */
export function renderTrace(trace = [], warnings = []) {
  const L = trace.map((x) => `${x.key ?? x.env} = ${JSON.stringify(x.value)}  ← ${x.source}`);
  if (warnings.length) L.push(...warnings.map((w) => `⚠️ ${w}`));
  return L.join('\n');
}

export default { configFile, loadConfig, getPath, makeResolver, renderTrace };
