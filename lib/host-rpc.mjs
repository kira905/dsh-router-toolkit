/**
 * lib/host-rpc.mjs —— **最小** DSH 宿主 RPC 客户端（只给本骨架用）。
 *
 * 只做三件事：拼 `/api` cookie、发一个 JSON POST、把 `{result:{ok,value|error}}` 摊平成
 * 调用方能直接判的形状。**不做**：端点全表、双栈回落、流式、自适应 wire 名学习。
 *
 * 协议形状（照着宿主现行为写，不是自创）：
 *   POST <base>/api/<endpoint>          endpoint 是斜杠形（`session.list` → `session/list`）
 *   headers: content-type: application/json
 *            cookie: dsh-auth-<b64url(sha256(authority))>=v1.<body>.<sig>
 *   body:    { type:'client-request', rpcId:<uuid>, method:<endpoint>, payload:{ args:{ <wire>: payload } } }
 *   resp:    { result: { ok:true, value } | { ok:false, error:{code,message} } }
 *
 * 🔴 cookie 的签名密钥**必须由调用方给**（`cookieSecret` 参数或 `DSH_RPC_COOKIE_SECRET`）：
 *    本骨架不读任何本机凭据文件、不猜密钥位置。拿不到密钥 ⇒ 不签 cookie 直接发，
 *    由宿主决定放不放行（多数 `/api` 端点会 401 —— 这是**预期行为**，错误信息会明说）。
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';

/**
 * 端点 wire 名表：本骨架只用这四条。
 * `wire` = 该端点 payload 里业务参数挂的字段名；`null` = 端点无参。
 */
export const ENDPOINTS = {
  'session.list': { endpoint: 'session/list', wire: '_request' },
  'session.prompt': { endpoint: 'session/prompt', wire: 'request' },
  'workspace.insertBefore': { endpoint: 'workspace/insertBefore', wire: 'request' },
  'workspace.unarchiveSession': { endpoint: 'workspace/unarchiveSession', wire: 'request' },
};

const b64url = (b) => Buffer.from(b).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');

/** 解析签名密钥：显式参数 > env。返回 Base64 串或 undefined。 */
export function resolveSecret(cookieSecret) {
  if (typeof cookieSecret === 'string' && cookieSecret.trim()) return cookieSecret.trim();
  const env = process.env.DSH_RPC_COOKIE_SECRET;
  return env && env.trim() ? env.trim() : undefined;
}

let COOKIE_CACHE = new Map();

/**
 * 自签 `/api` cookie。密钥必须是 32 字节（Base64 / Base64URL 均可）。
 * @returns {{name:string, value:string, header:string}|null} 无密钥或密钥长度不对 ⇒ null
 */
export function hostCookie(baseUrl, cookieSecret) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const b64 = resolveSecret(cookieSecret);
  const cacheKey = `${base}|${b64 ? createHash('sha256').update(b64).digest('hex').slice(0, 12) : 'none'}`;
  if (COOKIE_CACHE.has(cacheKey)) return COOKIE_CACHE.get(cacheKey);

  let out = null;
  try {
    if (b64) {
      const padded = b64.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (b64.length % 4)) % 4);
      const secret = Buffer.from(padded, 'base64');
      if (secret.length === 32) {
        const authority = new URL(base).host;
        const name = `dsh-auth-${b64url(createHash('sha256').update(authority).digest())}`;
        const issuedAt = Date.now();
        const expiresAt = issuedAt + 30 * 86_400_000;
        const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }), 'utf8'));
        const sig = b64url(createHmac('sha256', secret).update(body).digest());
        const value = `v1.${body}.${sig}`;
        out = { name, value, header: `${name}=${value}` };
      }
    }
  } catch {
    out = null;
  }
  COOKIE_CACHE.set(cacheKey, out);
  return out;
}

/** 清 cookie 缓存（密钥轮换 / 夹具用）。 */
export function clearCookieCache() {
  COOKIE_CACHE = new Map();
}

/**
 * 发一个宿主 RPC。
 * @param {string} baseUrl 形如 `http://127.0.0.1:3080`
 * @param {string} method 点号方法名（见 `ENDPOINTS`）
 * @param {object} [payload]
 * @param {{timeoutMs?:number, cookieSecret?:string, fetchImpl?:Function}} [opts]
 * @returns {Promise<{status:number, ok:boolean, value:any, error:object|null, request:string}>}
 */
export async function hostRpc(baseUrl, method, payload = {}, opts = {}) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const spec = ENDPOINTS[method];
  if (!spec) {
    return { status: 0, ok: false, value: null, error: { code: 'unknown-endpoint', message: `${method} 不在本骨架的端点表里` }, request: '' };
  }
  const cookie = hostCookie(base, opts.cookieSecret);
  const args = spec.wire === null ? {} : { [spec.wire]: payload };
  const body = { type: 'client-request', rpcId: randomUUID(), method: spec.endpoint, payload: { args } };
  const headers = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie.header;
  const doFetch = opts.fetchImpl ?? fetch;
  const request = `/api/${spec.endpoint}`;

  let res;
  try {
    res = await doFetch(`${base}${request}`, {
      method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
  } catch (e) {
    return { status: 0, ok: false, value: null, error: { code: 'network', message: String(e?.message ?? e) }, request };
  }

  let json = null;
  try {
    const text = typeof res.text === 'function' ? await res.text() : '';
    json = text ? JSON.parse(text) : null;
  } catch (e) {
    return { status: res.status, ok: false, value: null, error: { code: 'parse', message: String(e?.message ?? e) }, request };
  }

  const r = json?.result;
  if (res.status === 200 && r?.ok === true) {
    return { status: 200, ok: true, value: r.value, error: null, request };
  }
  const err = r?.error ?? json?.error ?? {
    code: res.status === 401 ? 'unauthorized' : 'http',
    message: res.status === 401
      ? '未通过 /api 鉴权（没给 cookieSecret / DSH_RPC_COOKIE_SECRET，或密钥不对）'
      : `HTTP ${res.status}`,
  };
  return { status: res.status, ok: false, value: null, error: err, request };
}

/** 带 cookie 的 GET（看板 state 这类插件端点是 GET，不是 RPC）。 */
export async function hostGet(baseUrl, pathname, opts = {}) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const cookie = hostCookie(base, opts.cookieSecret);
  const headers = { accept: 'application/json' };
  if (cookie) headers.cookie = cookie.header;
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`${base}${pathname}`, { headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000) });
    const text = typeof res.text === 'function' ? await res.text() : '';
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON 也照实报 */ }
    if (!res.ok) {
      return {
        status: res.status, ok: false, body: json, error: {
          code: res.status === 403 || res.status === 401 ? 'unauthorized' : 'http',
          message: `HTTP ${res.status}${res.status === 403 ? '（这个端点要 /api cookie ⇒ 给 cookieSecret 或 DSH_RPC_COOKIE_SECRET）' : ''}`,
        },
      };
    }
    return { status: res.status, ok: true, body: json, error: null };
  } catch (e) {
    return { status: 0, ok: false, body: null, error: { code: 'network', message: String(e?.message ?? e) } };
  }
}

export default { ENDPOINTS, hostCookie, hostRpc, hostGet, resolveSecret, clearCookieCache };
