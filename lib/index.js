// dsh-opencode-go-header
//
// Host plugin: automatically attach an `x-opencode-session` header to model
// requests that are routed to an OpenCode / OpenCode Go provider route.
//
// OpenCode's relay pins every request that shares the same
// `x-opencode-session` value to the same upstream backend, which keeps its
// prompt cache warm across the turns of one conversation. The value only has
// to be opaque and stable per conversation, so by default we reuse the DSH
// session id that already travels with each model call (the same identity the
// official DeepSeek adapter sends as `x-deepseek-harness-session-id`).
//
// How it works:
//   1. Listen on the `llm/stream` waterfall. Calls whose `options.provider`
//      names a configured OpenCode route and which carry a `sessionId` are
//      driven through an AsyncLocalStorage store holding the header value.
//   2. `globalThis.fetch` is patched once. While a store is active the patch
//      merges `x-opencode-session: <value>` into the outgoing request headers
//      (unless the request already carries the header).
//   3. Both registrations are fiber-scoped ctx effects, so plugin stop /
//      update / unload restores the original fetch and removes the listener.
//
// Requests that are NOT routed to an OpenCode provider, or that carry no
// session id (some auxiliary hand-built calls), pass through untouched.
//
// Auxiliary calls that omit `sessionId` but still run inside a known tool
// execution — the experimental auto-review gate builds its reviewer request
// that way — reuse the session id of the wrapping `tools/pre-execute` call;
// see `installSessionScope` in `apply`.

import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { appendFile } from 'node:fs/promises'

export const name = 'opencode-go-session-header'

// Activate only after the abstract `llm` service exists, so the waterfall
// event we listen on is already registered by its provider.
export const inject = ['llm']

const SESSION_HEADER = 'x-opencode-session'

// Provider routes OpenCode(Go) requests are served under. A route naming an
// installed pi-ai catalog provider keeps that provider's id as its route key,
// so both catalog ids are covered; users who route OpenCode through a custom
// provider key add it through config.
const DEFAULT_PROVIDERS = ['opencode', 'opencode-go']

function resolveConfig(config = {}) {
  const providers = Array.isArray(config.providers) && config.providers.length > 0
    ? config.providers.map((value) => String(value))
    : [...DEFAULT_PROVIDERS]
  // session-id: reuse the DSH session id (stable across turns AND restarts,
  // unique per conversation). uuid: derive a process-stable random uuid per
  // DSH session id (opaque, but resets when the process restarts).
  const mode = config.mode === 'uuid' ? 'uuid' : 'session-id'
  const debug = config.debug === true
  const debugFile = typeof config.debugFile === 'string' && config.debugFile.length > 0
    ? config.debugFile
    : undefined
  return { providers: new Set(providers), mode, debug, debugFile }
}

/** Fire-and-forget append of one debug record; failures only log a warning. */
function recordDebug(ctx, file, entry) {
  appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8').catch((error) => {
    ctx.logger.warn('[opencode-go-session-header] debugFile write failed: %s', error?.message ?? String(error))
  })
}

/** Derive the opaque header value for one DSH session id. */
export function headerValueFor(sessionId, mode, table) {
  const raw = String(sessionId)
  if (raw.length === 0) return undefined
  if (mode !== 'uuid') return raw
  let value = table.get(raw)
  if (value === undefined) {
    value = randomUUID()
    table.set(raw, value)
  }
  return value
}

/**
 * Wrap a downstream async iterable so every pull executes inside an
 * AsyncLocalStorage store. Async generators and the promises they create
 * inherit the store as long as the generator body is driven from a pull made
 * inside `als.run`, which is exactly what this wrapper does per `next()`.
 */
export function withStore(iterable, store, als) {
  const iterator = typeof iterable[Symbol.asyncIterator] === 'function'
    ? iterable[Symbol.asyncIterator]()
    : iterable
  return {
    [Symbol.asyncIterator]() {
      return this
    },
    async next() {
      return als.run(store, () => iterator.next())
    },
    async return(value) {
      if (typeof iterator.return === 'function') {
        try {
          return await iterator.return(value)
        } catch {
          // The downstream stream may already be torn down; treat as done.
        }
      }
      return { done: true, value }
    },
    async throw(error) {
      if (typeof iterator.throw === 'function') {
        return als.run(store, () => iterator.throw(error))
      }
      throw error
    },
  }
}

/** True when the outgoing request already carries the session header. */
function hasSessionHeader(input, init) {
  const source = init?.headers
    ?? (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined)
  if (source === undefined) return false
  try {
    return new Headers(source).has(SESSION_HEADER)
  } catch {
    return false
  }
}

/**
 * Build a patched fetch that injects the header while a store is active.
 * Header precedence mirrors native fetch: when `init.headers` is present it
 * wins; otherwise a Request's own headers are the base.
 */
export function patchFetch(original, als) {
  return function patchedFetch(input, init) {
    const state = als.getStore()
    if (state && !hasSessionHeader(input, init)) {
      const headers = new Headers(
        init?.headers
          ?? (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined),
      )
      headers.set(SESSION_HEADER, state.value)
      return original.call(this, input, { ...init, headers })
    }
    return original.apply(this, arguments)
  }
}

export function apply(ctx, config) {
  const { providers, mode, debug, debugFile } = resolveConfig(config)
  const als = new AsyncLocalStorage()
  const uuidBySession = new Map()
  // Session id of the tool execution currently in flight; see below.
  const sessionScope = new AsyncLocalStorage()

  const originalFetch = globalThis.fetch
  if (typeof originalFetch !== 'function') {
    ctx.logger.warn('[opencode-go-session-header] globalThis.fetch is unavailable; cannot inject x-opencode-session')
    return
  }

  const patched = patchFetch(originalFetch, als)

  ctx.effect(() => {
    globalThis.fetch = patched
    ctx.logger.info(
      '[opencode-go-session-header] active for providers [%s] with mode %s',
      [...providers].join(', '),
      mode,
    )
    return () => {
      if (globalThis.fetch === patched) globalThis.fetch = originalFetch
    }
  }, 'opencode-go-session-header.fetch-patch')

  // Some hand-built auxiliary calls omit `sessionId` — the experimental
  // auto-review gate builds its reviewer request that way. Such a call still
  // runs inside a tool execution whose agent names the session, so run the
  // rest of `tools/pre-execute` inside a store the stream listener below
  // reads. Only that listener consults the store, so the wrapping window
  // cannot leak the header into the tool body's own requests.
  //
  // Registration is deferred to the first `llm/stream`: the Loader mounts
  // entries concurrently and resolves their modules asynchronously, so bundle
  // order does not make this listener register after the auto-review gate's
  // own prepended `tools/pre-execute` listener. Registering later unshifts it
  // ahead of that gate, which is what lets the store cover its reviewer
  // request. A reviewer call always follows a model response, so the first
  // stream precedes every review.
  let sessionScopeInstalled = false
  const installSessionScope = () => {
    if (sessionScopeInstalled) return
    sessionScopeInstalled = true
    ctx.on('tools/pre-execute', (exec, next) => {
      const sessionId = exec?.agent?.session?.id
      if (sessionId === undefined || sessionId === null) return next()
      return sessionScope.run(String(sessionId), () => next())
    }, { prepend: true })
  }

  ctx.on('llm/stream', (options, next) => {
    installSessionScope()
    if (options === undefined || options === null || typeof options !== 'object') return next()
    if (!providers.has(String(options.provider))) return next()
    const sessionId = options.sessionId ?? sessionScope.getStore()
    if (sessionId === undefined || sessionId === null) return next()
    const value = headerValueFor(sessionId, mode, uuidBySession)
    if (value === undefined) return next()

    // Reaching the adapter is the only way the actual HTTP request happens;
    // `next()` returns the downstream (lazy) stream. Call it exactly once,
    // then drive its iterator from inside the store.
    let downstream
    try {
      downstream = next()
    } catch (error) {
      // Let the caller handle an adapter dispatch failure as it normally would.
      throw error
    }
    if (downstream === undefined || downstream === null) return downstream
    if (typeof downstream[Symbol.asyncIterator] !== 'function') return downstream

    if (debug || debugFile !== undefined) {
      const entry = {
        ts: new Date().toISOString(),
        provider: options.provider,
        model: options.model,
        session: String(sessionId),
        header: SESSION_HEADER,
        value,
      }
      if (debugFile !== undefined) recordDebug(ctx, debugFile, entry)
      if (debug) {
        ctx.logger.info(
          '[opencode-go-session-header] streaming provider "%s" with %s=%s',
          options.provider,
          SESSION_HEADER,
          value,
        )
      }
    }
    return withStore(downstream, { value }, als)
  }, { prepend: true })
}

export default { name, inject, apply }
