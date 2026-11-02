/**
 * lib/home.mjs —— DSH home 口径的唯一解析入口。
 *
 * 优先级（高 → 低）：显式参数 > `BUTLER_DSH_HOME` > `DSH_HOME` > `<os.homedir()>/.dsh`
 *
 * 为什么单独一个文件：骨架里至少三处要用同一个 home（动作流水、归档名单、巡检状态件），
 * 各写一份 `os.homedir()` 迟早分叉。生产版用的是 `lib/paths.mjs` 的 `dshHome()`，
 * 但那一份带来 8 个导出、其中 5 个本骨架用不到 ⇒ 这里只留一个函数。
 */
import os from 'node:os';
import path from 'node:path';

/** 解析 home 目录（返回绝对路径，不校验存在）。 */
export function resolveHome(explicit) {
  const cand = [explicit, process.env.BUTLER_DSH_HOME, process.env.DSH_HOME]
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .find(Boolean);
  return path.resolve(cand || path.join(os.homedir(), '.dsh'));
}

/** home 下的一个文件名（本骨架所有状态件的落点都由它算出来）。 */
export function homeFile(home, name) {
  return path.join(resolveHome(home), name);
}

export default { resolveHome, homeFile };
