/**
 * dsh-router-reset-btn · Client 半边
 *
 * 输入框左侧工具栏（`conversation.input.left`）多一个「收口」按钮：
 *   · 只在 Router 会话显示 —— 挂载时问一次 host 的 `<prefix>/state`，
 *     host 明确说「不是 Router」才隐藏；问不到（网络错/host 没回）就**照常显示**，
 *     点了由 host 给一句人话原因（宁可见了没用，也不要看不见能用）。
 *   · 点一下 = 一个 POST，host 那边先落档、再压缩，然后回一段人话结果。
 *   · 本插件**不自动动手**：没有定时器、没有事件订阅、没有打开即压；只有人点。
 *
 * ⚠️ 路由前缀：host 侧可配（`routePrefix`）。client 侧读同一个值的唯一途径是
 *   `window.__DSH_ROUTER_RESET_PREFIX__`（部署时写进页面，或保持两边都用缺省值）。
 *   不一致时按钮会调不通 —— README 里写了这一条，别默默踩。
 *
 * ⚠️ 防白屏（历史先例：inject 不存在的服务 ⇒ entry 永久 pending ⇒ 全站白屏）：
 *   ① `inject` 只写 `slots`（客户端确实有这个服务）；
 *   ② apply 整体 try/catch，任何一步失败就安静退出（按钮没了但 GUI 还在）；
 *   ③ 组件本身也 try/catch，渲染只返回基础 DOM。
 *
 * ⚠️ `window.__ModuleLoader__.load` 的 id 必须等于 loader entry 名，
 *   否则 ModuleLoader 报 "loaded without registering dsh-router-reset-btn"。
 */
window.__ModuleLoader__.load({
  id: 'dsh-router-reset-btn',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const DEFAULT_PREFIX = '/api/dsh-router-reset'

    /** host 与 client 共用的路由前缀：页面里写死的优先，否则用缺省。 */
    function apiPrefix() {
      try {
        const p = window.__DSH_ROUTER_RESET_PREFIX__
        if (typeof p === 'string' && p.trim() !== '') return p.trim().replace(/\/+$/, '')
      } catch {
        /* 没 window 就按缺省 */
      }
      return DEFAULT_PREFIX
    }

    const CSS = [
      '.dsh-rrb-btn{display:inline-flex;align-items:center;gap:4px;height:30px;padding:0 8px;border-radius:8px;cursor:pointer;color:var(--dsw-alias-label-secondary);background:transparent;border:none;font:inherit;font-size:12px;line-height:1;outline:none;transition:background .12s,color .12s;white-space:nowrap}',
      '.dsh-rrb-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.dsh-rrb-btn:disabled{opacity:.55;cursor:default}',
      '.dsh-rrb-btn[data-busy="true"]{color:var(--dsw-alias-brand-primary)}',
      '.dsh-rrb-msg{display:inline-flex;align-items:center;max-width:min(520px,60vw);font-size:12px;line-height:1.35;padding:3px 8px;border-radius:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-rrb-msg[data-kind="done"]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}',
      '.dsh-rrb-msg[data-kind="warn"]{color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}',
      '.dsh-rrb-msg[data-kind="error"]{color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent)}',
    ].join('')

    const STYLE_OWNER_ID = 'dsh-router-reset-btn'

    function createOwnedStyle(css) {
      const el = document.createElement('style')
      el.setAttribute('data-plugin', STYLE_OWNER_ID)
      el.textContent = css
      document.head.appendChild(el)
      return el
    }

    // 收口图标：一个向下的箭头落进方框里（= 落到档，再清空）
    function icon() {
      return h('svg', {
        width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('path', { d: 'M8 2v7' }),
        h('path', { d: 'M5 6.5 8 9.5l3-3' }),
        h('path', { d: 'M2.5 11.5v1.2a.8.8 0 0 0 .8.8h9.4a.8.8 0 0 0 .8-.8v-1.2' }),
      )
    }

    function pct(ratio) {
      if (typeof ratio !== 'number' || !isFinite(ratio)) return null
      return Math.round(ratio * 1000) / 10
    }

    function fmtMs(ms) {
      if (typeof ms !== 'number' || !isFinite(ms)) return '?'
      return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 100) / 10}s`
    }

    /** 一次点击的结果 → 一句话人话。 */
    function describe(json) {
      if (json === null || typeof json !== 'object') return { kind: 'error', text: '没收到结果（响应不是 JSON）' }
      if (json.state === 'done') {
        const r = json.reset || {}
        const c = json.compact || {}
        const b = json.before || {}
        const a = json.after || {}
        const bPct = pct(b.ratio)
        const aPct = pct(a.ratio)
        const parts = []
        parts.push(`落档 ${r.slots === null || r.slots === undefined ? '?' : r.slots} 行`)
        parts.push(c.shadowedItems === null || c.shadowedItems === undefined ? '压缩完成' : `压掉 ${c.shadowedItems} 条约 ${c.shadowedTokenCount ?? '?'} tokens`)
        parts.push(`耗时 ${fmtMs(c.ms)}`)
        if (bPct !== null && aPct !== null) parts.push(`上下文 ${bPct}% → ${aPct}%`)
        else if (a.totalTokens !== null && a.totalTokens !== undefined) parts.push(`上下文 ${a.totalTokens} tokens`)
        return { kind: 'done', text: `✅ 收口完成 · ${parts.join(' · ')}` }
      }
      if (json.state === 'reset-only') return { kind: 'warn', text: `⚠️ ${json.error || '已落档，但这次没压'}` }
      return { kind: 'error', text: `❌ ${json.error || '收口失败（没拿到原因）'}` }
    }

    function RouterResetButton(props) {
      const sessionId = props.sessionId
      // visible: true / false / null(=判不了 ⇒ 照常显示)
      const [isRouter, setIsRouter] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState(null)

      React.useEffect(() => {
        let stop = false
        if (typeof sessionId !== 'string' || sessionId === '') return () => { stop = true }
        try {
          fetch(`${apiPrefix()}/state?sessionId=${encodeURIComponent(sessionId)}`)
            .then((r) => r.json())
            .then((j) => {
              if (stop) return
              const v = j && j.ok && j.data ? j.data.isRouter : null
              setIsRouter(v === true ? true : v === false ? false : null)
            })
            .catch(() => { if (!stop) setIsRouter(null) })
        } catch {
          setIsRouter(null)
        }
        return () => { stop = true }
      }, [sessionId])

      if (isRouter === false) return null

      const onClick = () => {
        if (busy) return
        setBusy(true)
        setMsg(null)
        fetch(`${apiPrefix()}/run`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        })
          .then((r) => r.json())
          .then((j) => setMsg(describe(j)))
          .catch((e) => setMsg({ kind: 'error', text: `❌ 调不通 host：${e && e.message ? e.message : e}` }))
          .then(() => setBusy(false), () => setBusy(false))
      }

      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
        h('button', {
          type: 'button',
          className: 'dsh-rrb-btn',
          'data-router-reset-btn': '',
          'data-busy': busy ? 'true' : 'false',
          disabled: busy,
          title: '收口并清空：先把槽位与待定项落进结论档，再原地压缩上下文（会话 id 不变）',
          onClick,
        }, icon(), h('span', null, busy ? '收口中…' : '收口')),
        msg === null ? null : h('span', {
          className: 'dsh-rrb-msg',
          'data-kind': msg.kind,
          title: msg.text,
          'data-router-reset-msg': '',
        }, msg.text),
      )
    }

    function apply(ctx) {
      try {
        const styleEl = createOwnedStyle(CSS)
        ctx.effect(() => () => { try { styleEl.remove() } catch { /* 已卸载 */ } }, 'dsh-router-reset-btn: styles')

        const slots = typeof ctx.get === 'function' ? ctx.get('slots') : ctx.slots
        if (slots === undefined || slots === null || typeof slots.register !== 'function') return

        slots.inject('conversation.input.left', () => slots.register(
          { name: 'conversation.input.left', id: 'router-reset-btn', order: 40, label: '收口' },
          (props) => React.createElement(RouterResetButton, { sessionId: props ? props.sessionId : undefined }),
        ))
      } catch (e) {
        try { console.warn('[dsh-router-reset-btn] apply 失败（按钮不出现，GUI 不受影响）:', e && e.message ? e.message : e) } catch { /* 无 console */ }
      }
    }

    exports.apply = apply
    exports.inject = ['slots']
    exports.__test = { describe, pct, fmtMs, apiPrefix }
    return module.exports
  },
})
