/**
 * dsh-router-reset-btn · Host 半边
 *
 * 一个「收口并清空」按钮的后端：一键两步，顺序不能反：
 *   ① 先跑 `router-act reset --apply` —— 把槽位 + 待定的决策写进结论档、生成「接续头」。
 *      **这一步是保命**：先落档再清空，否则压掉的东西没人找得回。
 *   ② 再调宿主的 `compaction.compactNow(agent, signal)` —— 原地压缩（会话 id 不变）。
 *      这一步**不落档、不删会话、不归档**；失败也只是没压，绝不回滚 ①。
 *
 * 🔴 边界（「清空留给人」）：
 *   · 只有人点这个 HTTP 入口才动手；本插件**没有**定时器、没有自动触发、没有事件订阅。
 *   · 非 Router 会话一律拒（给人话原因），不碰任何别人的会话。
 *
 * 契约（都查过源码，别凭记忆改）：
 *   · `compaction.compactNow(agent: ManualCompactAgentContext, signal, sourceCommandId?)`
 *     ⇒ agent 直接满足 ManualCompactAgentContext（`session` + `runMaintenance`）。
 *   · Router 判定 = `agent.session.header.agentPreset`（SessionHeader 有此字段），
 *     回落 `agentPresets.composedPreset(agent.ctx)`。
 *   · 上下文占比 = `tokenMeter.measure(session).totalTokens ÷ session.requestContext().contextWindow`。
 *
 * 可配置（**都不改代码**）：
 *   · `routePrefix`   本插件挂的路由前缀（缺省 `/api/dsh-router-reset`；env `DSH_ROUTER_RESET_PREFIX`）
 *   · `routerActPath`  `router-act.mjs` 的位置（缺省按下面的顺序找）
 *   · `allowAny`      跳过「必须是 Router 会话」这道闸（只给测试实例/夹具用）
 *
 * `router-act.mjs` 解析顺序（高 → 低）：`DSH_ROUTER_ACT` env > 与本包同目录的 `router-act.mjs`
 *   > `<home>/tools/dsh-butler/router-act.mjs`（单机安装布局）。`home` = `DSH_HOME` > `~/.dsh`。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-router-reset-btn'

/** webServer 是硬依赖：没有它这个插件根本没入口。别的服务一律 `ctx.get` 软取。 */
export const inject = ['webServer']

/** 缺省路由前缀（`routePrefix` 可覆盖）。 */
export const DEFAULT_ROUTE_PREFIX = '/api/dsh-router-reset'
const RESET_TIMEOUT_MS = 120000

// ── 配置解析 ─────────────────────────────────────────────────────────────

const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)

/** 路由前缀：显式 config > env > 缺省。末尾斜杠去掉、必须带前导斜杠。 */
export function resolveRoutePrefix(config = {}, env = process.env) {
  const raw = str(config?.routePrefix) ?? str(env.DSH_ROUTER_RESET_PREFIX) ?? DEFAULT_ROUTE_PREFIX
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`
  return withSlash.replace(/\/+$/, '') || DEFAULT_ROUTE_PREFIX
}

/** DSH home：`DSH_HOME` > `~/.dsh`（与其余工具同口径）。 */
export function resolveHome(env = process.env) {
  const v = str(env.DSH_HOME)
  return v ? path.resolve(v) : path.join(os.homedir(), '.dsh')
}

/** `router-act.mjs` 的候选路径（高 → 低）。第一个存在的胜出；都不存在就返回第一个（报错时带出来）。 */
export function routerActCandidates(config = {}, env = process.env) {
  const out = []
  const explicit = str(config?.routerActPath) ?? str(env.DSH_ROUTER_ACT)
  if (explicit) out.push(path.resolve(explicit))
  // 与本包同根（本仓的结构：router-act.mjs 在包根，插件在 plugin/ 子目录）
  out.push(fileURLToPath(new URL('../router-act.mjs', import.meta.url)))
  // 单机安装布局
  out.push(path.join(resolveHome(env), 'tools', 'dsh-butler', 'router-act.mjs'))
  return out
}

export function resolveRouterActPath(config = {}, env = process.env) {
  const cands = routerActCandidates(config, env)
  for (const c of cands) {
    try {
      if (fs.statSync(c).isFile()) return c
    } catch {
      /* 试下一个 */
    }
  }
  return cands[0]
}

// ── 小工具 ───────────────────────────────────────────────────────────────

function writeJson(res, code, body) {
  const text = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

function readBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('请求体太大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim() === '') return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (e) {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function errText(e) {
  if (e === null || e === undefined) return '未知错误'
  if (typeof e === 'string') return e
  return e.message ? String(e.message) : String(e)
}

/** 给界面看的一句话：多行报错只取第一行有效内容（完整原文留在 JSON 的 stdout/stderr 里）。 */
function firstLine(s, max = 240) {
  const text = typeof s === 'string' ? s : errText(s)
  const line = text.split(/\r?\n/).map((x) => x.trim()).find((x) => x !== '') ?? ''
  return line.length > max ? `${line.slice(0, max)}…` : line
}

/** 软取服务：读未 inject 的服务属性会抛错，所以每次 get 都包一层。 */
function softGet(ctx, key) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(key) : undefined
  } catch {
    return undefined
  }
}

// ── 会话 / preset ────────────────────────────────────────────────────────

function resolveAgent(ctx, sessionId) {
  const agents = softGet(ctx, 'agents')
  if (agents === undefined || agents === null || typeof agents.get !== 'function') return undefined
  try {
    return agents.get(sessionId)
  } catch {
    return undefined
  }
}

/** Router 判定：先读会话头（权威、写死的），再回落 preset 组合。读不到就 undefined（= 判不了）。 */
function presetOf(ctx, agent) {
  try {
    const preset = agent?.session?.header?.agentPreset
    if (typeof preset === 'string' && preset !== '') return preset
  } catch {
    /* 读头失败 ⇒ 走回落 */
  }
  try {
    const presets = softGet(ctx, 'agentPresets')
    if (presets !== undefined && presets !== null && typeof presets.composedPreset === 'function' && agent?.ctx) {
      const id = presets.composedPreset(agent.ctx)
      if (typeof id === 'string' && id !== '') return id
    }
  } catch {
    /* 回落也失败 ⇒ 判不了 */
  }
  return undefined
}

/** @returns {true|false|null} null = 判不了（会话没在内存里 / 读不到 preset） */
function routerStateOf(ctx, agent, { presetOfFn, allowAnyFn }) {
  if (agent === undefined || agent === null) return null
  const preset = presetOfFn(agent)
  if (preset === undefined) return null
  if (preset === 'router') return true
  return allowAnyFn() ? true : false
}

// ── 上下文读数 ───────────────────────────────────────────────────────────

function measureContext(ctx, session) {
  try {
    const meter = softGet(ctx, 'tokenMeter')
    if (meter === undefined || meter === null || typeof meter.measure !== 'function') return null
    const m = meter.measure(session)
    let contextWindow
    try {
      const rc = typeof session.requestContext === 'function' ? session.requestContext() : undefined
      if (rc !== undefined && rc !== null && typeof rc.contextWindow === 'number') contextWindow = rc.contextWindow
    } catch {
      /* 没有窗口读数 ⇒ 只报 token 数 */
    }
    const totalTokens = typeof m.totalTokens === 'number' ? m.totalTokens : null
    return {
      totalTokens,
      surfaceTokens: typeof m.surfaceTokens === 'number' ? m.surfaceTokens : null,
      contextWindow: contextWindow === undefined ? null : contextWindow,
      ratio: totalTokens !== null && typeof contextWindow === 'number' && contextWindow > 0
        ? Math.round((totalTokens / contextWindow) * 10000) / 10000
        : null,
    }
  } catch {
    return null
  }
}

// ── ① 落档：跑 router-act.mjs reset ──────────────────────────────────────

export function runRouterActReset(scriptPath, { cwd, env = process.env } = {}) {
  const script = scriptPath
  const args = [script, 'reset', '--apply', '--json', '--decided-by', 'plugin']
  return new Promise((resolve) => {
    let settled = false
    const done = (v) => {
      if (settled) return
      settled = true
      resolve(v)
    }
    let child
    try {
      child = spawn(process.execPath, args, {
        cwd: cwd ?? path.dirname(script),
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      return done({ ok: false, code: null, stdout: '', stderr: `起不来：${errText(e)}`, payload: null })
    }
    let stdout = ''
    let stderr = ''
    const cap = (s, chunk) => (s.length < 262144 ? s + chunk.toString('utf8') : s)
    child.stdout.on('data', (c) => { stdout = cap(stdout, c) })
    child.stderr.on('data', (c) => { stderr = cap(stderr, c) })
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已退出 */ }
      done({ ok: false, code: null, stdout, stderr: `${stderr}\n（超时 ${RESET_TIMEOUT_MS}ms 被杀）`, payload: null })
    }, RESET_TIMEOUT_MS)
    child.on('error', (e) => {
      clearTimeout(timer)
      done({ ok: false, code: null, stdout, stderr: errText(e), payload: null })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      let payload = null
      const trimmed = stdout.trim()
      if (trimmed !== '') {
        try {
          payload = JSON.parse(trimmed)
        } catch {
          const a = trimmed.indexOf('{')
          const b = trimmed.lastIndexOf('}')
          if (a >= 0 && b > a) {
            try { payload = JSON.parse(trimmed.slice(a, b + 1)) } catch { payload = null }
          }
        }
      }
      const ok = code === 0 && payload !== null && payload.ok === true
      done({ ok, code, stdout, stderr, payload })
    })
  })
}

// ── ② 压缩：宿主 compaction.compactNow ───────────────────────────────────

function resolveCompaction(ctx, agent) {
  try {
    const presets = softGet(ctx, 'agentPresets')
    if (presets !== undefined && presets !== null && typeof presets.serviceFor === 'function' && agent?.ctx) {
      const svc = presets.serviceFor(agent, 'compaction')
      if (svc !== undefined && svc !== null && typeof svc.compactNow === 'function') {
        return { svc, via: 'agentPresets.serviceFor' }
      }
    }
  } catch {
    /* 回落 */
  }
  try {
    const svc = softGet(ctx, 'compaction')
    if (svc !== undefined && svc !== null && typeof svc.compactNow === 'function') {
      return { svc, via: 'ctx.compaction' }
    }
  } catch {
    /* 无 */
  }
  return null
}

/** 把 ManualCompactionError 的 code 翻成一句人话。 */
export function compactFailureText(e) {
  const code = e && typeof e.code === 'string' ? e.code : ''
  switch (code) {
    case 'busy':
      return '会话正忙（有回合在跑 / 已有压缩在跑），等它闲下来再点一次'
    case 'cancelled':
      return '压缩被取消'
    case 'changed':
      return '要压的历史在压缩前变了，这次没压（日志里有痕迹）'
    case 'summary':
      return '压不出有用的摘要，这次没压'
    case 'commit':
      return '压缩落盘中途出错，部分历史可能已变，先看一眼会话状态再点'
    case 'persistence':
      return '压完了但会话没存下去'
    default:
      return errText(e)
  }
}

// ── handler 工厂（deps 可注入：夹具用它，生产走缺省） ────────────────────

/**
 * 造一个 HTTP handler。**纯依赖注入式**：`ctx` 只被用来软取服务，`deps` 里任何一项都能被替身覆盖
 * （夹具就是这么测的 —— 不连真宿主、不跑真 router-act）。
 *
 * @param {{ ctx?: object, routePrefix?: string, routerActPath?: string, deps?: object }} opts
 */
export function createHandler({ ctx = {}, routePrefix = DEFAULT_ROUTE_PREFIX, routerActPath, deps = {} } = {}) {
  const prefix = String(routePrefix || DEFAULT_ROUTE_PREFIX).replace(/\/+$/, '')
  const resolveAgentFn = deps.resolveAgent ?? ((sid) => resolveAgent(ctx, sid))
  const presetOfFn = deps.presetOf ?? ((agent) => presetOf(ctx, agent))
  const measureFn = deps.measureContext ?? ((session) => measureContext(ctx, session))
  const compactionFn = deps.resolveCompaction ?? ((agent) => resolveCompaction(ctx, agent))
  const allowAnyFn = deps.allowAny ?? (() => process.env.DSH_ROUTER_RESET_ALLOW_ANY === '1')
  const resetFn = deps.runReset ?? (() => runRouterActReset(routerActPath ?? resolveRouterActPath()))
  const stateOf = (agent) => routerStateOf(ctx, agent, { presetOfFn, allowAnyFn })

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost')
    if (!url.pathname.startsWith(prefix)) {
      return writeJson(res, 404, { ok: false, error: `unknown path: ${url.pathname}` })
    }
    const sub = url.pathname.slice(prefix.length).replace(/\/+$/, '')
    try {
      if (req.method === 'GET' && sub === '/state') {
        const sessionId = url.searchParams.get('sessionId') || ''
        if (sessionId === '') return writeJson(res, 400, { ok: false, error: '缺 sessionId' })
        const agent = resolveAgentFn(sessionId)
        const isRouter = stateOf(agent)
        return writeJson(res, 200, {
          ok: true,
          data: {
            sessionId,
            live: agent !== undefined && agent !== null,
            isRouter,
            preset: agent === undefined ? null : (presetOfFn(agent) ?? null),
            allowAny: allowAnyFn(),
            before: agent === undefined ? null : measureFn(agent.session),
          },
        })
      }

      if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: `method not allowed: ${req.method}` })
      if (sub !== '/run') return writeJson(res, 404, { ok: false, error: `unknown path: ${sub || '/'}` })

      const body = await readBody(req)
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
      if (sessionId === '') return writeJson(res, 400, { ok: false, state: 'failed', phase: 'input', error: '缺 sessionId' })

      const agent = resolveAgentFn(sessionId)
      if (agent === undefined || agent === null) {
        return writeJson(res, 409, {
          ok: false,
          state: 'failed',
          phase: 'resolve',
          error: '这个会话现在没在内存里（宿主没加载它）——先打开一次这个会话，再点收口。',
        })
      }

      const isRouter = stateOf(agent)
      if (isRouter === false) {
        const preset = presetOfFn(agent) ?? '(读不到)'
        return writeJson(res, 403, {
          ok: false,
          state: 'failed',
          phase: 'guard',
          error: `这个会话不是 Router 会话（当前 preset = ${preset}）。收口按钮只给 Router 会话用，没动它任何东西。`,
        })
      }

      const before = measureFn(agent.session)

      // ① 落档（保命）。失败 ⇒ 绝不往下走。
      const t0 = Date.now()
      const reset = await resetFn()
      const resetMs = Date.now() - t0
      if (!reset.ok) {
        const raw = (reset.payload && reset.payload.error) || reset.stderr || `exit=${reset.code}`
        const detail = firstLine(raw)
        return writeJson(res, 502, {
          ok: false,
          state: 'failed',
          phase: 'reset',
          error: `落档失败，所以没压缩（保命优先）：${detail}`,
          reset: { ok: false, ms: resetMs, code: reset.code, stderr: reset.stderr.slice(-2000), stdout: reset.stdout.slice(-2000) },
          before,
        })
      }
      const resetInfo = {
        ok: true,
        ms: resetMs,
        doc: reset.payload.doc ?? null,
        slots: reset.payload.slots ?? null,
        attentions: reset.payload.attentions ?? null,
        wrote: reset.payload.wrote === true,
        replacedSegments: reset.payload.replacedSegments ?? null,
      }

      // ② 压缩。失败/返回 null ⇒ 如实报「已落档，但这次没压」，不报成功。
      const service = compactionFn(agent)
      if (service === null) {
        return writeJson(res, 200, {
          ok: false,
          state: 'reset-only',
          phase: 'compact',
          error: '已落档，但这个会话的组合里没有 compaction 服务，所以这次没压。',
          reset: resetInfo,
          before,
          after: measureFn(agent.session),
        })
      }

      const abort = new AbortController()
      const t1 = Date.now()
      let result = null
      try {
        result = await service.svc.compactNow(agent, abort.signal)
      } catch (e) {
        return writeJson(res, 200, {
          ok: false,
          state: 'reset-only',
          phase: 'compact',
          error: `已落档，但这次没压（${compactFailureText(e)}）。`,
          reset: resetInfo,
          compact: { via: service.via, ms: Date.now() - t1, threw: true, code: e && e.code ? String(e.code) : null },
          before,
          after: measureFn(agent.session),
        })
      }

      const after = measureFn(agent.session)
      if (result === null || result === undefined) {
        return writeJson(res, 200, {
          ok: false,
          state: 'reset-only',
          phase: 'compact',
          error: '已落档，但这次没压（没有可压缩的历史 —— 太短，压了也没意义）。',
          reset: resetInfo,
          compact: { via: service.via, ms: Date.now() - t1, result: null },
          before,
          after,
        })
      }

      return writeJson(res, 200, {
        ok: true,
        state: 'done',
        reset: resetInfo,
        compact: {
          via: service.via,
          ms: Date.now() - t1,
          shadowedItems: Array.isArray(result.shadowedSeqs) ? result.shadowedSeqs.length : null,
          shadowedTokenCount: typeof result.shadowedTokenCount === 'number' ? result.shadowedTokenCount : null,
          summarySeq: result.summarySeq ?? null,
        },
        before,
        after,
      })
    } catch (e) {
      try {
        writeJson(res, 500, { ok: false, state: 'failed', phase: 'internal', error: errText(e) })
      } catch {
        /* 响应已经写过了 */
      }
    }
  }
}

// ── 插件本体 ─────────────────────────────────────────────────────────────

export function apply(ctx, config = {}) {
  const routePrefix = resolveRoutePrefix(config)
  const routerActPath = resolveRouterActPath(config)
  const handler = createHandler({ ctx, routePrefix, routerActPath })
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: routePrefix, handler }))
}

export default { name, inject, apply, createHandler, resolveRoutePrefix, resolveRouterActPath, resolveHome, routerActCandidates, runRouterActReset, compactFailureText, DEFAULT_ROUTE_PREFIX }
