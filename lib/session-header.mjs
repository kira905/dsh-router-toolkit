/**
 * lib/session-header.mjs —— 找会话日志 + 读首帧 header（**只读**，只服务于"cwd 还在吗"这一项）。
 *
 * ⚠️ 会话日志文件名是**世代化**的（同一会话在不同主包版本下可能是 `session.jsonl.zstd` /
 *    `session.v3.jsonl.zstd` / 未压缩的 `.jsonl`）。所以这里**不写死文件名**：列目录、按已知
 *    后缀挑一个"优先级最高 + 最新写入"的。生产树里这份判断件叫 `session-file-name.mjs`，
 *    本骨架不搬它，只保留这条纪律。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { resolveHome } from './home.mjs';

/** 后缀优先级（越靠前越优先认）。 */
const SUFFIX_ORDER = ['.v3.jsonl.zstd', '.jsonl.zstd', '.jsonl'];

/** 在一个会话目录里挑当前那份日志（认全世代）。 */
export function pickSessionFileInDir(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  let best = null;
  for (const n of names) {
    const rank = SUFFIX_ORDER.findIndex((s) => n.endsWith(s));
    if (rank < 0) continue;
    const file = path.join(dir, n);
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(file).mtimeMs; } catch { continue; }
    if (!best || rank < best.rank || (rank === best.rank && mtimeMs > best.mtimeMs)) best = { file, rank, mtimeMs };
  }
  return best?.file ?? null;
}

/** 按 sessionId 找会话文件（id 只当一层目录名；带分隔符 / `..` 一律拒，防路径穿越）。 */
export function findSessionFile(sessionId, home) {
  const id = String(sessionId ?? '').trim();
  if (!id || /[\\/]/.test(id) || id.includes('..')) return null;
  const root = path.join(resolveHome(home), 'sessions');
  let dirs;
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return null; }
  for (const d of dirs) {
    const hit = pickSessionFileInDir(path.join(root, d.name, id));
    if (hit) return hit;
  }
  return null;
}

/** 取首帧记录（zstd 直接解；纯 jsonl 直接读）；任何一步失败 ⇒ null。 */
function readFirstRecord(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return null; }
  let text;
  try {
    text = file.endsWith('.zstd') ? zlib.zstdDecompressSync(buf).toString('utf8') : buf.toString('utf8');
  } catch { return null; }
  const first = text.split('\n').find((l) => l.trim());
  if (!first) return null;
  try { return JSON.parse(first); } catch { return null; }
}

/**
 * 读会话首帧 header。首帧可能是 header 本体，也可能包在 `{type:'header', data:{…}}` 里。
 * @returns {{file:string, header:object, raw:object}|null}
 */
export function readSessionHeader(sessionId, home) {
  const file = findSessionFile(sessionId, home);
  if (!file) return null;
  const rec = readFirstRecord(file);
  if (!rec) return null;
  const inner = rec?.data;
  const header = inner && typeof inner === 'object' && (inner.id || inner.origin) ? inner : rec;
  return { file, header, raw: rec };
}

export default { pickSessionFileInDir, findSessionFile, readSessionHeader };
