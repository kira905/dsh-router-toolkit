// dsh-router-toolkit / test/test-router-reset-plugin.mjs
// 运行：node test/test-router-reset-plugin.mjs
//
// 覆盖范围 = 「收口并清空」按钮的两条命根子：
//   ① **保命顺序**：落档失败 ⇒ 绝不压缩；非 Router 会话 ⇒ 绝不动手
//   ② **不静默**：压缩失败/没有压缩服务/没有可压历史 ⇒ 一律如实报「已落档，但这次没压」
// 外加：路由前缀可覆盖、方法/路径校验、client 半边的三句话与前缀解析。
//
// 🔴 全程零网络、零真实 router-act、零真实宿主服务：
//   handler 的每一项依赖都由 deps 注入成替身；client 半边在 vm 沙箱里跑。
// 🔴 含**阴性对照**（两条）：把判据的前提改回去，同一条断言必须变红 —— 证明它不是空转。
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import {
  createHandler, resolveRoutePrefix, resolveRouterActPath, routerActCandidates, compactFailureText, DEFAULT_ROUTE_PREFIX,
} from '../plugin/index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.join(HERE, '..', 'plugin', 'client.js')

let pass = 0
let fail = 0
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log(`  ✔ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ''}`) }
}

// ── 请求 / 响应替身 ──────────────────────────────────────────────────────

function makeReq(method, url, body) {
  const ee = new EventEmitter()
  ee.method = method
  ee.url = url
  ee.destroy = () => {}
  queueMicrotask(() => {
    if (body !== undefined) ee.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
    ee.emit('end')
  })
  return ee
}
function makeRes() {
  const r = { code: 0, body: '' }
  r.writeHead = (c) => { r.code = c }
  r.end = (t) => { r.body = String(t ?? '') }
  return r
}
async function call(handler, method, url, body) {
  const res = makeRes()
  await handler(makeReq(method, url, body), res)
  let json = null
  try { json = JSON.parse(res.body) } catch { json = null }
  return { code: res.code, json, raw: res.body }
}

// ── 依赖替身 ────────────────────────────────────────────────────────────

const AGENT = { session: { id: 'session-abc' }, ctx: {} }
const before = { totalTokens: 1200, surfaceTokens: 1200, contextWindow: 100000, ratio: 0.012 }

function okReset() {
  return async () => ({ ok: true, code: 0, stdout: '{}', stderr: '', payload: { ok: true, doc: 'conclusion.md', slots: 16, wrote: true, replacedSegments: 1 } })
}
function badReset() {
  return async () => ({ ok: false, code: 2, stdout: '', stderr: 'boom: 结论档写不进去', payload: null })
}
function compactSpy(impl) {
  const calls = []
  const svc = {
    compactNow: async (...args) => {
      calls.push(args)
      if (impl) return impl()
      return { shadowedSeqs: [1, 2], shadowedTokenCount: 800, summarySeq: 9 }
    },
  }
  return { calls, svc }
}

/**
 * 造一个 handler；每个依赖都能替身。
 * @param {{preset?:string|null, live?:boolean, reset?:Function, compaction?:object|null, allowAny?:boolean}} o
 */
function handler(o = {}) {
  const {
    preset = 'router', live = true, reset = okReset(), compaction = compactSpy(), allowAny = false, routePrefix = DEFAULT_ROUTE_PREFIX,
  } = o
  return createHandler({
    routePrefix,
    deps: {
      resolveAgent: (sid) => (live ? AGENT : undefined),
      presetOf: () => (preset === null ? undefined : preset),
      measureContext: () => before,
      runReset: reset,
      resolveCompaction: () => (compaction === null ? null : { svc: compaction.svc, via: 'test' }),
      allowAny: () => allowAny,
    },
  })
}

const main = async () => {
  console.log('① GET /state（判「这个会话该不该显示按钮」）')
  {
    const r = await call(handler(), 'GET', `${DEFAULT_ROUTE_PREFIX}/state`)
    ok(r.code === 400 && r.json?.error === '缺 sessionId', '缺 sessionId ⇒ 400', r.json)
  }
  {
    const r = await call(handler(), 'GET', `${DEFAULT_ROUTE_PREFIX}/state?sessionId=session-abc`)
    ok(r.code === 200 && r.json?.data?.isRouter === true && r.json?.data?.live === true, 'Router 会话 ⇒ isRouter=true / live=true', r.json)
    ok(r.json?.data?.before?.ratio === 0.012, '带上下文读数（ratio 原样透出）', r.json?.data?.before)
  }
  {
    const r = await call(handler({ preset: 'worker' }), 'GET', `${DEFAULT_ROUTE_PREFIX}/state?sessionId=session-abc`)
    ok(r.code === 200 && r.json?.data?.isRouter === false, '非 Router 会话 ⇒ isRouter=false（按钮该隐藏）', r.json?.data)
  }
  {
    const r = await call(handler({ live: false }), 'GET', `${DEFAULT_ROUTE_PREFIX}/state?sessionId=session-xyz`)
    ok(r.code === 200 && r.json?.data?.live === false && r.json?.data?.isRouter === null, '会话不在内存 ⇒ live=false / isRouter=null（判不了）', r.json?.data)
  }

  console.log('\n② POST /run（保命顺序 + 不静默）')
  {
    const spy = compactSpy()
    const r = await call(handler({ compaction: spy }), 'POST', `${DEFAULT_ROUTE_PREFIX}/run`, {})
    ok(r.code === 400 && r.json?.phase === 'input', '缺 sessionId ⇒ 400 / phase=input', r.json)
  }
  {
    const spy = compactSpy()
    const r = await call(handler({ live: false, compaction: spy }), 'POST', `${DEFAULT_ROUTE_PREFIX}/run`, { sessionId: 'session-xyz' })
    ok(r.code === 409 && r.json?.phase === 'resolve', '会话不在内存 ⇒ 409 / phase=resolve', r.json)
  }
  {
    const resetCalls = []
    const spy = compactSpy()
    const reset = async () => { resetCalls.push(1); return okReset()() }
    const r = await call(handler({ preset: 'worker', reset, compaction: spy }), 'POST', `${DEFAULT_ROUTE_PREFIX}/run`, { sessionId: 'session-abc' })
    ok(r.code === 403 && r.json?.phase === 'guard', '非 Router ⇒ 403 / phase=guard', r.json)
    ok(resetCalls.length === 0 && spy.calls.length === 0, '非 Router ⇒ 落档和压缩**一次都没调**（没动别人的东西）', { reset: resetCalls.length, compact: spy.calls.length })
  }
  {
    const spy = compactSpy()
    const r = await call(handler({ reset: badReset(), compaction: spy }), 'POST', `${DEFAULT_ROUTE_PREFIX}/run`, { sessionId: 'session-abc' })
    ok(r.code === 502 && r.json?.phase === 'reset' && r.json?.ok === false, '落档失败 ⇒ 502 / phase=reset（不报成功）', r.json)
    ok(/保命优先/.test(r.json?.error ?? '') && spy.calls.length === 0, '落档失败 ⇒ **不压缩**，且错误里说清「保命优先」', { error: r.json?.error, compact: spy.calls.length })
  }
  {
    const r = await call(handler({ compaction: null }), 'POST', `${DEFAULT_ROUTE_PREFIX}/run`, { sessionId: 'session-abc' })
    ok(r.code === 200 && r.json?.state === 'reset-only' && r.json?.ok === false, '没有 compaction 服务 ⇒ 200 reset-only / ok=false', r.json)
    ok(/没有 compaction 服务/.test(r.json?.error ?? ''), '错误话说清"已落档，没压的原因"', r.json?.error)
  }
  {
    const spy = compactSpy(() => { const e = new Error('busy'); e.code = 'busy'; throw e })
    const r = await call(handler({ compaction: spy }), 'POST', `${DEFAULT_ROUTE_PREFIX}/run`, { sessionId: 'session-abc' })
    ok(r.code === 200 && r.json?.state === 'reset-only' && r.json?.compact?.code === 'busy', '压缩抛 busy ⇒ reset-only + 带 code', r.json)
    ok(/会话正忙/.test(r.json?.error ?? ''), '失败原因翻成人话（「会话正忙」）', r.json?.error)
  }
  {
    const spy = compactSpy(() => null)
    const r = await call(handler({ compaction: spy }), 'POST', `${DEFAULT_ROUTE_PREFIX}/run`, { sessionId: 'session-abc' })
    ok(r.code === 200 && r.json?.state === 'reset-only' && r.json?.compact?.result === null, '压缩返回 null ⇒ reset-only（没有可压历史）', r.json?.compact)
  }
  {
    const spy = compactSpy()
    const r = await call(handler({ compaction: spy }), 'POST', `${DEFAULT_ROUTE_PREFIX}/run`, { sessionId: 'session-abc' })
    ok(r.code === 200 && r.json?.state === 'done' && r.json?.ok === true, '全通 ⇒ 200 done', r.json?.state)
    ok(r.json?.reset?.slots === 16 && r.json?.reset?.wrote === true, '回话里带落档信息（slots / wrote）', r.json?.reset)
    ok(r.json?.compact?.shadowedItems === 2 && r.json?.compact?.shadowedTokenCount === 800, '回话里带压缩信息（条数 / tokens）', r.json?.compact)
    ok(spy.calls.length === 1 && r.json?.before?.ratio === 0.012, '压缩只调一次，before 读数在', { calls: spy.calls.length })
  }

  console.log('\n③ 路由前缀 / 方法 / 路径')
  {
    const h = handler({ routePrefix: '/x/y/z' })
    const good = await call(h, 'GET', '/x/y/z/state?sessionId=session-abc')
    const bad = await call(h, 'GET', `${DEFAULT_ROUTE_PREFIX}/state?sessionId=session-abc`)
    ok(good.code === 200, '自定义前缀 /x/y/z ⇒ 200', good.json)
    ok(bad.code === 404, '旧前缀不认（不会两边都挂）', bad.json)
  }
  {
    const r = await call(handler(), 'PUT', `${DEFAULT_ROUTE_PREFIX}/run`)
    ok(r.code === 405, 'PUT ⇒ 405', r.json)
  }
  {
    const r = await call(handler(), 'POST', `${DEFAULT_ROUTE_PREFIX}/nope`, { sessionId: 'session-abc' })
    ok(r.code === 404, '未知子路径 ⇒ 404', r.json)
  }
  {
    ok(resolveRoutePrefix({}, { DSH_ROUTER_RESET_PREFIX: '/custom/prefix/' }) === '/custom/prefix', '前缀：env 可改，末尾斜杠归一', resolveRoutePrefix({}, { DSH_ROUTER_RESET_PREFIX: '/custom/prefix/' }))
    ok(resolveRoutePrefix({ routePrefix: '/a/b' }, { DSH_ROUTER_RESET_PREFIX: '/c/d' }) === '/a/b', '前缀：显式 config 压过 env', resolveRoutePrefix({ routePrefix: '/a/b' }, { DSH_ROUTER_RESET_PREFIX: '/c/d' }))
    ok(resolveRoutePrefix({}, {}) === DEFAULT_ROUTE_PREFIX, '前缀：都没给 ⇒ 缺省', resolveRoutePrefix({}, {}))
  }
  {
    const env = { DSH_ROUTER_ACT: path.join(HERE, 'fake-router-act.mjs') }
    const cands = routerActCandidates({}, env)
    ok(cands[0] === path.resolve(env.DSH_ROUTER_ACT), 'router-act 路径：DSH_ROUTER_ACT 排第一', cands[0])
    const resolved = resolveRouterActPath({}, {})
    ok(path.isAbsolute(resolved) && /router-act\.mjs$/.test(resolved), 'router-act 路径：不带 env 也能解析出一个绝对路径', resolved)
  }
  ok(compactFailureText({ code: 'summary' }) === '压不出有用的摘要，这次没压', '压缩错误码 → 人话（summary）', compactFailureText({ code: 'summary' }))

  console.log('\n④ client 半边（vm 沙箱：不碰真 window）')
  {
    const code = fs.readFileSync(CLIENT, 'utf8')
    let entry = null
    const fakeWindow = { __ModuleLoader__: { load: (spec) => { entry = spec } } }
    const sandbox = {
      window: fakeWindow,
      console,
      fetch: () => Promise.reject(new Error('no network in fixture')),
      document: { createElement: () => ({ setAttribute() {}, remove() {}, textContent: '', appendChild() {} }), head: { appendChild() {} } },
    }
    vm.runInNewContext(code, sandbox)
    ok(entry?.id === 'dsh-router-reset-btn', 'client loader id 与 patch entry id 一致（对不齐就"加载了但没注册"）', entry?.id)
    const fakeReact = { createElement: (...a) => ({ el: a }), useState: (v) => [v, () => {}], useEffect: () => {} }
    const mod = entry.factory((n) => {
      if (n === 'react') return fakeReact
      throw new Error(`unexpected require: ${n}`)
    })
    const t = mod.__test
    const done = t.describe({ state: 'done', reset: { slots: 16 }, compact: { shadowedItems: 2, shadowedTokenCount: 800, ms: 1500 }, before: { ratio: 0.5 }, after: { ratio: 0.1 } })
    ok(done.kind === 'done' && /收口完成/.test(done.text) && /落档 16 行/.test(done.text) && /50% → 10%/.test(done.text), 'describe(done) ⇒ ✅ + 落档行数 + 上下文占比', done.text)
    const warn = t.describe({ state: 'reset-only', error: '已落档，但这次没压（会话正忙）' })
    ok(warn.kind === 'warn' && /^⚠️/.test(warn.text), 'describe(reset-only) ⇒ ⚠️ 不是成功', warn.text)
    const err = t.describe({ state: 'failed', error: '落档失败' })
    ok(err.kind === 'error' && /^❌/.test(err.text), 'describe(failed) ⇒ ❌', err.text)
    ok(t.describe(null).kind === 'error', 'describe(null) ⇒ ❌（不装成功）', t.describe(null))
    ok(t.apiPrefix() === DEFAULT_ROUTE_PREFIX, 'client 前缀缺省与 host 一致', t.apiPrefix())
    fakeWindow.__DSH_ROUTER_RESET_PREFIX__ = '/x/y/'
    ok(t.apiPrefix() === '/x/y', 'client 前缀可由 window.__DSH_ROUTER_RESET_PREFIX__ 覆盖（末尾斜杠归一）', t.apiPrefix())
  }

  console.log('\n⑤ 阴性对照（判据改坏必须红 —— 证明上面那些断言不是空转）')
  {
    // ①「落档失败 ⇒ 不压缩」这条：只要把落档改成成功，同一条判据就该不成立
    const spy = compactSpy()
    const bad = await call(handler({ reset: okReset(), compaction: spy }), 'POST', `${DEFAULT_ROUTE_PREFIX}/run`, { sessionId: 'session-abc' })
    const stillHolds = bad.code === 502 && spy.calls.length === 0
    ok(stillHolds === false, '阴性对照①：落档成功时「502 且没压缩」不再成立（该判据不空转）', { code: bad.code, compact: spy.calls.length })

    // ②「非 Router ⇒ 落档和压缩都不调」这条：只要把 preset 改成 router，同一条判据就该不成立
    const resetCalls = []
    const reset = async () => { resetCalls.push(1); return okReset()() }
    const good = await call(handler({ preset: 'router', reset, compaction: compactSpy() }), 'POST', `${DEFAULT_ROUTE_PREFIX}/run`, { sessionId: 'session-abc' })
    const guardHolds = good.code === 403 && resetCalls.length === 0
    ok(guardHolds === false, '阴性对照②：Router 会话时「403 且没落档」不再成立（该判据不空转）', { code: good.code, reset: resetCalls.length })
  }
}

main().then(() => {
  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`)
  process.exitCode = fail === 0 ? 0 : 1
}).catch((e) => {
  console.error(`夹具自己炸了：${e?.stack ?? e}`)
  process.exitCode = 1
})
