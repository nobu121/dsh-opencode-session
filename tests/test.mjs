// Local behavioral test for dsh-opencode-go-header without a full DSH boot.
// Spins up an HTTP echo server, registers the plugin's apply() against a fake
// ctx, then drives 'llm/stream' waterfalls the way the llm service would.
//
// Run: node tests/test.mjs

import assert from 'node:assert/strict'
import http from 'node:http'
import plugin from '../lib/index.js'

const failures = []
function check(name, fn) {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.error(`FAIL - ${name}\n    ${error.message}`)
  }
}

// ---- fake cordis ctx (only what apply() touches) ----
function fakeCtx() {
  const listeners = new Map()
  const ctx = {
    listeners,
    logger: {
      info() {},
      warn() {},
      error() {},
    },
    effect(fn) {
      const cleanup = fn()
      ctx.cleanups.push(cleanup)
      return () => cleanup?.()
    },
    cleanups: [],
    on(name, listener, options) {
      if (!listeners.has(name)) listeners.set(name, [])
      const list = listeners.get(name)
      // Cordis `prepend` unshifts, so the most recently prepended listener is
      // the outermost one in a waterfall.
      if (options?.prepend) list.unshift(listener)
      else list.push(listener)
      return () => {
        const i = list.indexOf(listener)
        if (i >= 0) list.splice(i, 1)
      }
    },
  }
  return ctx
}

// Cordis waterfall dispatch: the last argument is the innermost `next`, and
// each listener receives the shared arguments plus its own `next`.
function waterfall(ctx, name, ...args) {
  const listeners = [...(ctx.listeners.get(name) ?? [])]
  const inner = args.pop()
  const next = () => {
    const listener = listeners.shift() ?? inner
    return listener(...args)
  }
  args.push(next)
  return next()
}

// The plugin rewrites globalThis.fetch on apply and restores on cleanup, so
// snapshot it here and always restore before exiting.
const realFetch = globalThis.fetch

function echoServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ url: req.url, headers: req.headers }))
      })
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` })
    })
  })
}

const { server, url } = await echoServer()

try {
  // ---- apply with default-ish config (only opencode-go for clarity) ----
  const ctx = fakeCtx()
  let ctx2
  plugin.apply(ctx, { providers: ['opencode-go'], mode: 'session-id' })
  const llmStream = ctx.listeners.get('llm/stream')[0]

  // Adapter stream shape: an async generator that performs one provider
  // request through (patched) global fetch, then yields a chunk carrying the
  // echoed request headers.
  const adapterStream = async function* (tag) {
    const res = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    })
    const echoed = await res.json()
    yield { tag, echoed }
  }

  // Emulate ctx.llm.stream dispatch: waterfall listener receives (options, next).
  const streamCall = (provider, sessionId, initHeaders) => {
    const next = () => adapterStream(`${provider}:${sessionId ?? 'none'}`)
    return llmStream(
      { provider, model: 'm', sessionId, messages: [], system: '' },
      next,
    )
  }

  // 1) opencode-go + session id -> header present with the session value.
  {
    const session = 'session-11111111-2222-3333-4444-555555555555'
    const chunks = []
    for await (const chunk of streamCall('opencode-go', session)) chunks.push(chunk)
    const echoed = chunks[0].echoed.headers
    check('opencode-go request carries x-opencode-session = session id', () => {
      assert.equal(echoed['x-opencode-session'], session)
    })
  }

  // 2) opencode-go + session id -> same value on the second request (stable).
  {
    const session = 'session-11111111-2222-3333-4444-555555555555'
    const chunks = []
    for await (const chunk of streamCall('opencode-go', session)) chunks.push(chunk)
    check('opencode-go session value is stable across requests', () => {
      assert.equal(chunks[0].echoed.headers['x-opencode-session'], session)
    })
  }

  // 3) Non-opencode provider -> no header injected.
  {
    const chunks = []
    for await (const chunk of streamCall('deepseek-official', 'session-aaaaaaaa-0000-0000-0000-000000000000')) chunks.push(chunk)
    check('non-opencode provider request is untouched', () => {
      assert.equal(chunks[0].echoed.headers['x-opencode-session'], undefined)
    })
  }

  // 4) A fetch issued OUTSIDE any llm/stream call gets no header either.
  {
    const res = await fetch(`${url}/v1/models`, { headers: { accept: 'application/json' } })
    const body = await res.json()
    check('bare fetch outside a stream call is untouched', () => {
      assert.equal(body.headers['x-opencode-session'], undefined)
    })
  }

  // 5) An explicit header set by the provider profile is preserved.
  {
    const session = 'session-22222222-2222-3333-4444-555555555555'
    const next = () => (async function* () {
      const res = await fetch(`${url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'x-opencode-session': 'preset-value' },
        body: '{}',
      })
      yield { echoed: await res.json() }
    })()
    const wrapped = llmStream({ provider: 'opencode-go', model: 'm', sessionId: session }, next)
    const chunks = []
    for await (const chunk of wrapped) chunks.push(chunk)
    check('caller-provided x-opencode-session header wins', () => {
      assert.equal(chunks[0].echoed.headers['x-opencode-session'], 'preset-value')
    })
  }

  // 6) uuid mode: distinct sessions -> distinct uuids; same session -> same uuid.
  {
    ctx2 = fakeCtx()
    plugin.apply(ctx2, { providers: ['opencode-go'], mode: 'uuid' })
    const listener2 = ctx2.listeners.get('llm/stream')[0]
    const one = []
    for await (const c of listener2({ provider: 'opencode-go', sessionId: 'session-u1' }, () => adapterStream('u1'))) one.push(c)
    const two = []
    for await (const c of listener2({ provider: 'opencode-go', sessionId: 'session-u1' }, () => adapterStream('u1-again'))) two.push(c)
    const three = []
    for await (const c of listener2({ provider: 'opencode-go', sessionId: 'session-u2' }, () => adapterStream('u2'))) three.push(c)
    const v1 = one[0].echoed.headers['x-opencode-session']
    const v2 = two[0].echoed.headers['x-opencode-session']
    const v3 = three[0].echoed.headers['x-opencode-session']
    check('uuid mode: stable per session, unique across sessions', () => {
      assert.equal(v1, v2)
      assert.notEqual(v1, v3)
      assert.match(v1, /^[0-9a-f-]{36}$/)
    })
  }

  // 7) no sessionId -> no header (auxiliary calls pass through).
  {
    const chunks = []
    for await (const chunk of streamCall('opencode-go', undefined)) chunks.push(chunk)
    check('opencode-go request without sessionId is untouched', () => {
      assert.equal(chunks[0].echoed.headers['x-opencode-session'], undefined)
    })
  }

  // 8) plugin unload restores the fetch that was installed before its apply.
  // Instances from earlier groups still hold the patched fetch (the plugin is
  // a singleton in real DSH, so a fresh scenario needs those cleaned up
  // first, in reverse application order: ctx2 then ctx).
  {
    for (const cleanup of ctx2.cleanups) cleanup()
    for (const cleanup of ctx.cleanups) cleanup()
    assert.equal(globalThis.fetch, realFetch)

    const ctx3 = fakeCtx()
    plugin.apply(ctx3, { providers: ['opencode-go'] })
    assert.notEqual(globalThis.fetch, realFetch)
    for (const cleanup of ctx3.cleanups) cleanup()
    check('plugin unload restores globalThis.fetch', () => {
      assert.equal(globalThis.fetch, realFetch)
    })
  }

  // 9) concurrent conversations keep their own header value even when their
  // provider streams interleave at await boundaries.
  {
    const ctx4 = fakeCtx()
    plugin.apply(ctx4, { providers: ['opencode-go'], mode: 'session-id' })
    const listener4 = ctx4.listeners.get('llm/stream')[0]
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    const make = (tag) => async function* () {
      const first = await fetch(`${url}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ tag }) })
      yield { tag: `${tag}-1`, echoed: await first.json() }
      await sleep(25)
      const second = await fetch(`${url}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ tag }) })
      yield { tag: `${tag}-2`, echoed: await second.json() }
    }

    const iterA = listener4({ provider: 'opencode-go', sessionId: 'session-conv-a' }, make('a'))[Symbol.asyncIterator]()
    const iterB = listener4({ provider: 'opencode-go', sessionId: 'session-conv-b' }, make('b'))[Symbol.asyncIterator]()

    // Pull both conversations concurrently so their internal awaits (fetch,
    // sleep) overlap; each request must still carry its own conversation id.
    const [a1, b1] = await Promise.all([iterA.next(), iterB.next()])
    const [a2, b2] = await Promise.all([iterA.next(), iterB.next()])

    check('concurrent conversations keep distinct x-opencode-session values', () => {
      assert.equal(a1.value.echoed.headers['x-opencode-session'], 'session-conv-a')
      assert.equal(a2.value.echoed.headers['x-opencode-session'], 'session-conv-a')
      assert.equal(b1.value.echoed.headers['x-opencode-session'], 'session-conv-b')
      assert.equal(b2.value.echoed.headers['x-opencode-session'], 'session-conv-b')
    })
    for (const cleanup of ctx4.cleanups) cleanup()
    assert.equal(globalThis.fetch, realFetch)
  }

  // 10) An auxiliary call that omits `sessionId` still receives the header
  // while it runs inside a `tools/pre-execute` call — the experimental
  // auto-review gate builds its reviewer request that way.
  {
    const ctx5 = fakeCtx()
    plugin.apply(ctx5, { providers: ['opencode-go'], mode: 'session-id' })
    const listener5 = ctx5.listeners.get('llm/stream')[0]

    let reviewerHeader
    let bareHeader
    const gate = async (exec, next) => {
      // Reviewer request: no sessionId, exactly like a hand-built gate.
      const chunks = []
      for await (const chunk of listener5({ provider: 'opencode-go', model: 'm' }, () => adapterStream('reviewer'))) {
        chunks.push(chunk)
      }
      reviewerHeader = chunks[0].echoed.headers['x-opencode-session']
      // A request the tool body itself makes in the same window stays clean.
      const bare = await fetch(`${url}/v1/models`)
      bareHeader = (await bare.json()).headers['x-opencode-session']
      return next()
    }
    // Registered BEFORE the plugin installs its own gate listener, so the
    // plugin's later registration must still win the waterfall.
    ctx5.on('tools/pre-execute', gate, { prepend: true })

    // The first stream is what installs the session scope.
    for await (const _ of listener5(
      { provider: 'opencode-go', sessionId: 'session-tool-1', model: 'm' },
      () => adapterStream('main'),
    )) { /* drain */ }

    const decision = await waterfall(ctx5, 'tools/pre-execute',
      { name: 'bash', agent: { session: { id: 'session-tool-1' } } },
      () => Promise.resolve({ kind: 'allow' }))

    check('auxiliary call inside a tool execution reuses the wrapping session', () => {
      assert.equal(reviewerHeader, 'session-tool-1')
    })
    check('tool body request inside the same execution stays untouched', () => {
      assert.equal(bareHeader, undefined)
    })
    check('plugin gate listener runs ahead of an earlier prepended listener', () => {
      assert.notEqual(ctx5.listeners.get('tools/pre-execute')[0], gate)
      assert.equal(ctx5.listeners.get('tools/pre-execute')[1], gate)
      assert.deepEqual(decision, { kind: 'allow' })
    })

    for (const cleanup of ctx5.cleanups) cleanup()
    assert.equal(globalThis.fetch, realFetch)
  }
} finally {
  server.close()
  globalThis.fetch = realFetch
}

if (failures.length > 0) {
  console.error(`\n${failures.length} test(s) failed`)
  process.exit(1)
}
console.log('\nall tests passed')
