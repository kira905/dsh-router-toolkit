/**
 * lib/flags.mjs —— 每个动词的**合法参数白名单**。
 *
 * 为什么单列一份：`argvVal()` / `argv.includes()` 那种"用到才取"的读法天生吞掉笔误 ——
 * `digest ... --apply --aply` 会**照写**结论档，人还以为自己加了开关。参数白名单 + 进 `main()`
 * **任何副作用之前**扫一遍，未知参数一律 rc=2、一个字节都不写盘（写动词带 `--apply` 也拦）。
 *
 * 加参数 = 改这里一处 + 补夹具（这是特性，不是麻烦）。
 * ⚠️ `--help` / `-h` 全体通用，不在表里；`--flag=value` 形式**不支持**（参数与值用空格分开；
 *    写成 `--line=x` 会被当未知参数拒掉，那正是我们要的 fail-closed）。
 */

/** `value` = 后面跟一个值的参数；`bool` = 纯开关。 */
export const VERB_FLAGS = {
  status: { value: ['--max-lines'], bool: ['--json'] },
  brief: { value: [], bool: ['--json', '--gaps'] },
  'card-show': { value: ['--card', '--max-lines'], bool: [] },
  say: {
    value: ['--to', '--text', '--id', '--due', '--ref', '--reply', '--cmd', '--prio', '--mode', '--decided-by', '--receipt'],
    bool: ['--apply', '--raw', '--json', '--allow-self', '--allow-handoff'],
  },
  digest: { value: ['--line', '--text', '--ref', '--date', '--decided-by'], bool: ['--apply', '--json'] },
  reset: { value: ['--decided-by'], bool: ['--apply', '--json'] },
  wake: { value: [], bool: ['--apply'] },
};

/** 每个动词的用法（未知参数时打印这一段，不打印整屏 USAGE；`say` 的那段是多行）。 */
export const VERB_USAGE = {
  status: '用法：node router-act.mjs status [--json] [--max-lines N]   （只读 · 零写入）',
  brief: '用法：node router-act.mjs brief [--json] [--gaps]   （只读 · 零写入；--gaps 另起一段「愿景差距」）',
  'card-show': '用法：node router-act.mjs card-show --card <cardId> [--max-lines N]   （只读 · 零写入）',
  say: [
    '用法：node router-act.mjs say --to <线名|会话id> --text "<一句话>" [--apply] [选项]',
    '  选项：--cmd ask|do|report|notify · --prio now|today|when-free · --raw · --mode queue|steer',
    '        --id / --due / --ref / --reply / --receipt / --decided-by router|owner / --json',
    '        --allow-self / --allow-handoff（自测用）',
  ].join('\n'),
  digest: '用法：node router-act.mjs digest --line <线名> --text "<一句结论>" [--ref <…>] [--date YYYY-MM-DD] [--apply] [--json] [--decided-by router|owner]',
  reset: '用法：node router-act.mjs reset [--apply] [--json] [--decided-by router|owner]',
  wake: '用法：node router-act.mjs wake [--apply]   （stub：本骨架不含 thread 唤醒面）',
};

/**
 * 扫一遍参数，挑出不认识的。
 * @returns {{ unknown: string[], allowed: string[] }}
 * 值本身长得像参数也不查（`--text "--x"` 合法）—— 只查"参数位"上的 token。
 */
export function scanFlags(verb, argv = []) {
  const spec = VERB_FLAGS[verb];
  if (!spec) return { unknown: [], allowed: [] };
  const takesValue = new Set(spec.value);
  const allowed = [...spec.value, ...spec.bool, '--help', '-h'];
  const known = new Set(allowed);
  const unknown = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i]);
    if (!a.startsWith('-')) continue;          // 位置参数（多半是某个参数的值）不查
    if (!known.has(a)) { unknown.push(a); continue; }
    if (takesValue.has(a)) i += 1;             // 跳过这个参数的值
  }
  return { unknown, allowed };
}

/** 一条给人看的错误段：哪几个参数不认识 + 该动词用法 + 合法清单。 */
export function renderUnknownFlags(verb, unknown, allowed) {
  const hint = unknown.some((f) => f.includes('=')) ? '\n  （本件不支持 `--flag=value` 形式：参数与值用空格分开）' : '';
  return [
    `❌ ${verb}：不认识的参数 ${unknown.map((f) => `"${f}"`).join(' / ')} —— 不认识就拒（rc=2，一个字节都没写）${hint}`,
    `  ${VERB_USAGE[verb] ?? `用法：node router-act.mjs ${verb} …`}`,
    `  该动词合法参数：${allowed.filter((f) => f !== '-h').join(' ')}`,
  ].join('\n');
}

export default { VERB_FLAGS, VERB_USAGE, scanFlags, renderUnknownFlags };
