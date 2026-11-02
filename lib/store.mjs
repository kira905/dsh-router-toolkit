/**
 * lib/store.mjs —— 本骨架自带的**最小**状态件读写件：单实例锁 + 原子写 + 宽容读。
 *
 * 刻意只有这几个，不多不少：
 *   `acquireTickLock`  —— 巡检脚本防并发（tick 与手工直跑撞车时后来者让路）
 *   `releaseTickLock`  —— 用完即放（进程崩了也不怕，靠 ttl 过期自愈）
 *   `writeJsonAtomic`  —— 同目录 tmp + rename，写一半断电不会留下半个 JSON
 *   `readJsonSafe`     —— 读不到/解析失败返回 {ok:false, error}，**不抛**（fail-open 的前提）
 *
 * 🔴 与 `dsh-butler-core` 的 `acquireLock` **不是同一个接口**（那边有 fingerprint / listLocks /
 *    多锁册管理），本件不追求与它合并：骨架要的是"一个文件一把锁 + 到期自愈"，够用就行。
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveHome } from './home.mjs';

/** 锁目录：`<home>/router-locks/`（与状态件分开，便于观察与清理） */
export function lockDir(home) {
  return path.join(resolveHome(home), 'router-locks');
}

function lockFile(name, home) {
  const safe = String(name ?? '').replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(lockDir(home), `${safe}.lock`);
}

function readLock(file) {
  try {
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    return rec && typeof rec === 'object' ? rec : null;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    // EPERM = 进程在但没权限（仍算活着）；ESRCH = 真没了
    return e?.code === 'EPERM';
  }
}

/**
 * 抢一把单实例锁。
 *
 * 判定顺序：**先看 ttl（它才是权威）→ 再看 pid**。
 * 只看 pid 会踩两个坑：① 容器/重启后 pid 被复用 ② 断电留下的锁 pid 早已不存在但 ttl 还没到。
 * 反过来只看 ttl 也不够：进程崩了以后要白等到 ttl 结束。两条都看才两头不漏。
 *
 * @returns {{ok:boolean, file:string, reason?:string, stale?:boolean, holder?:object|null}}
 */
export function acquireTickLock(name, { ttlMs = 120_000, home } = {}) {
  const file = lockFile(name, home);
  const now = Date.now();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch (e) {
    return { ok: false, file, reason: `锁目录建不出来（${e?.message ?? e}）` };
  }

  const cur = readLock(file);
  if (cur) {
    const at = Number(cur.at ?? 0);
    const ttl = Number(cur.ttlMs ?? ttlMs);
    const expired = !at || !Number.isFinite(at) || now - at > ttl;
    const alive = pidAlive(cur.pid);
    if (!expired && (alive || cur.pid === process.pid)) {
      return { ok: false, file, reason: `locked（pid ${cur.pid}，${Math.max(0, Math.round((ttl - (now - at)) / 1000))}s 后到期）`, holder: cur };
    }
    // 过期 或 持有者已死 ⇒ 接管（下面照常写自己的记录）
    const stale = true;
    const rec = { pid: process.pid, at: now, ttlMs, name: String(name ?? ''), stale };
    try {
      fs.writeFileSync(file, `${JSON.stringify(rec)}\n`, 'utf8');
      return { ok: true, file, stale, holder: cur };
    } catch (e) {
      return { ok: false, file, reason: `接管过期锁失败（${e?.message ?? e}）` };
    }
  }

  const rec = { pid: process.pid, at: now, ttlMs, name: String(name ?? '') };
  try {
    fs.writeFileSync(file, `${JSON.stringify(rec)}\n`, { encoding: 'utf8', flag: 'wx' });
    return { ok: true, file, holder: null };
  } catch (e) {
    if (e?.code === 'EEXIST') {
      // 竞态：读的时候没有、写的瞬间被别人抢了 ⇒ 让路，不抢
      return { ok: false, file, reason: 'locked（写入瞬间被抢占）', holder: readLock(file) };
    }
    return { ok: false, file, reason: `写锁失败（${e?.code ?? e?.message ?? e}）` };
  }
}

/** 放手（只放自己那把：别人接管过就别删）。 */
export function releaseTickLock(name, { home } = {}) {
  const file = lockFile(name, home);
  const cur = readLock(file);
  if (!cur) return { ok: true, file, released: false, reason: '锁已不在' };
  if (Number(cur.pid) !== process.pid) {
    return { ok: true, file, released: false, reason: `锁已被 pid ${cur.pid} 接管，不动别人的` };
  }
  try {
    fs.unlinkSync(file);
    return { ok: true, file, released: true };
  } catch (e) {
    return { ok: false, file, released: false, reason: `${e?.code ?? e?.message ?? e}` };
  }
}

/** 原子写 JSON：同目录 tmp → rename（跨盘 rename 会 EXDEV，所以 tmp 必须同目录）。 */
export function writeJsonAtomic(file, obj) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/** 宽容读 JSON：读不到 / 解析失败 ⇒ `{ok:false, error, value:null}`，**绝不抛**。 */
export function readJsonSafe(file) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')), error: null };
  } catch (e) {
    const code = e?.code ?? '';
    return { ok: false, value: null, error: `${code ? `${code} ` : ''}${e?.message ?? e}`.trim() };
  }
}

export default { acquireTickLock, releaseTickLock, writeJsonAtomic, readJsonSafe, lockDir };
