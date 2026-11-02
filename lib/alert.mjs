/**
 * lib/alert.mjs —— 报警出口：一行一个 JSON 落到日志、同时回声到 stderr，另可挂附加通道。
 *
 * 这里刻意**不 import 本仓的其它模块**（除了 home 解析）：巡检脚本自己掉队时，
 * 报警仍要能出去 —— 报警通道不能跟被监控对象共用一堆依赖。
 *
 * 落点：`<home>/router-alert.log`（append-only；每行 `{at, level, source, message, detail}`）
 * 附加通道：`addChannel(fn)` 返回注销函数；**任何通道抛错都被吞掉**，不影响主流程。
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveHome } from './home.mjs';

const sinks = [];

/** 注册一个附加通道（如桌面通知）；返回注销函数。 */
export function addChannel(fn) {
  if (typeof fn !== 'function') return () => {};
  sinks.push(fn);
  const off = () => { const i = sinks.indexOf(fn); if (i >= 0) sinks.splice(i, 1); };
  return off;
}

/** 报警日志的绝对路径。 */
export function alertLogPath(home) {
  return path.join(resolveHome(home), 'router-alert.log');
}

/**
 * 发一条报警。
 * @param {{level?:'info'|'warn'|'error', source?:string, message:string, detail?:object}} entry
 * @param {{home?:string, silent?:boolean}} [opts]
 * @returns {{ok:boolean, file:string, error:string|null}}
 */
export function alert(entry, opts = {}) {
  const rec = {
    at: new Date().toISOString(),
    level: entry?.level ?? 'warn',
    source: entry?.source ?? 'router',
    message: String(entry?.message ?? ''),
    detail: entry?.detail ?? null,
  };
  const file = alertLogPath(opts.home);
  let ok = true, error = null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(rec)}\n`, { encoding: 'utf8' });
  } catch (e) {
    ok = false;
    error = e?.message ?? String(e);
  }
  if (!opts.silent) {
    try { process.stderr.write(`[router-alert][${rec.level}] ${rec.source}: ${rec.message}\n`); } catch { /* stderr 也不可写就算了 */ }
  }
  for (const fn of sinks) { try { fn(rec); } catch { /* 通道自身故障不影响主流程 */ } }
  return { ok, file, error };
}

/** 读日志尾部（排障用；解析不了的行走 `{raw}` 兜底，绝不抛）。 */
export function tailAlerts(limit = 20, opts = {}) {
  let text = '';
  try { text = fs.readFileSync(alertLogPath(opts.home), 'utf8'); } catch { return []; }
  return text.split(/\r?\n/).filter(Boolean).slice(-limit)
    .map((line) => { try { return JSON.parse(line); } catch { return { raw: line }; } });
}

export default { addChannel, alert, tailAlerts, alertLogPath };
