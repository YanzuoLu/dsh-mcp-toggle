import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

export const name = 'mcp-toggle'
export const inject = ['agents', 'sessions', 'tools', 'systemPrompt', 'mcpResources', 'sessionQuery', 'storageDomain', 'connection']
const spec = defineDomain({
  name: 'mcp_toggle', version: 1,
  tables: { sessions: domainTable(z.object({ enabledServers: z.array(z.string()) })) },
})

/** Stable lifetime and dispatch. Published revisions do not unload agents or MCP connections. */
export async function apply(ctx) {
  const domain = await ctx.storageDomain.open(spec)
  const bridge = {
    records: domain.table('sessions'), effective: new Map(), owners: new Map(), headers: new Map(),
    current: null, compat: null, operations: 0, closing: false,
    runtime: { revision: null, pendingRevision: null, error: null },
  }
  let module, revision, checking = false, rejected
  const busy = () => bridge.operations > 0 || ctx.agents.list().some(agent => agent.status === 'running')
  const operation = async callback => {
    bridge.operations += 1
    try { return await callback() } finally { bridge.operations -= 1 }
  }
  async function load(initial = false) {
    if (checking || bridge.closing) return
    checking = true
    try {
      let release
      try { release = JSON.parse(await readFile(new URL('./release.json', import.meta.url), 'utf8')) }
      catch (error) { if (!initial && error.code === 'ENOENT') return; throw error }
      if (!/^[a-f0-9]{12}$/.test(release.revision) || release.entry !== `./dist/host/${release.revision}/host.js`) throw new Error('Invalid MCP toggle release manifest')
      if (release.revision === revision || release.revision === rejected) return
      bridge.runtime.pendingRevision = release.revision
      if (!initial && busy()) return
      const next = await import(new URL(release.entry, import.meta.url).href)
      if (!initial && (busy() || bridge.closing)) return
      const candidate = next.createRuntime(ctx, bridge)
      for (const method of ['initialize', 'commit', 'filterTools', 'filterResources', 'filterAssembly', 'onEvent', 'onDisposed', 'get', 'set', 'cleanup']) {
        if (typeof candidate[method] !== 'function') throw new Error(`Missing MCP runtime method: ${method}`)
      }
      const previous = bridge.current, previousModule = module
      try {
        if (initial) for (const agent of ctx.agents.list()) bridge.effective.set(agent.session.id, null)
        // No await separates hook restoration and replacement. The same maps
        // retain every session's effective selection throughout this swap.
        bridge.compat?.dispose()
        bridge.current = candidate
        bridge.compat = next.installCompatibility(ctx, bridge)
        for (const agent of ctx.agents.list()) bridge.compat.attach(agent)
      } catch (error) {
        bridge.compat?.dispose()
        bridge.current = previous
        if (previousModule) {
          bridge.compat = previousModule.installCompatibility(ctx, bridge)
          for (const agent of ctx.agents.list()) bridge.compat.attach(agent)
        }
        rejected = release.revision
        throw error
      }
      module = next
      revision = release.revision
      bridge.runtime.revision = revision
      bridge.runtime.pendingRevision = null
      bridge.runtime.error = null
    } catch (error) {
      bridge.runtime.error = error.message
      if (initial) throw error
      ctx.logger.warn(`MCP toggle update: ${error.message}`)
    } finally { checking = false }
  }
  ctx.effect(() => async () => {
    bridge.closing = true
    bridge.compat?.dispose()
    await domain.close()
  }, 'mcp-toggle: lifetime')
  await load(true)

  ctx.on('agent/created', ({ agent, source }) => operation(async () => {
    bridge.compat.attach(agent)
    await bridge.current.initialize(agent, source === 'startup')
  }))
  ctx.on('agent/disposed', ({ agent }) => {
    bridge.current.onDisposed(agent)
    bridge.compat.detach(agent)
  })
  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle' && bridge.owners.has(agent.session.id)) bridge.current.commit(agent)
  })
  ctx.on('session/event', (session, event) => bridge.current.onEvent(session, event))
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => bridge.current.filterAssembly(await next(), context))
  ctx.on('api-session/removed', id => {
    void operation(() => bridge.records.delete(id)).catch(error => ctx.logger.warn(`MCP preference removal: ${error.message}`))
  })
  for (const agent of ctx.agents.list()) await operation(() => bridge.current.initialize(agent, false, true))

  for (const endpoint of ['get', 'set']) {
    ctx.connection.fetch.register({
      path: `/api/mcp-toggle/${endpoint}`, methods: ['POST'], requestBody: 'buffered',
      async fetch(request) {
        try {
          if (bridge.closing) return Response.json({ ok: false, error: { message: 'MCP settings are stopping' } }, { status: 503 })
          const value = await operation(() => request.json().then(payload => bridge.current[endpoint](payload)))
          return Response.json({ ok: true, value })
        } catch (error) {
          return Response.json({ ok: false, error: { message: error.message } }, { status: 400 })
        }
      },
    })
  }
  ctx.effect(() => {
    let cleaning = false
    const updates = setInterval(() => { void load() }, 2000)
    const cleanup = setInterval(() => {
      if (cleaning || bridge.closing) return
      cleaning = true
      void operation(() => bridge.current.cleanup()).catch(error => ctx.logger.warn(`MCP preference cleanup: ${error.message}`)).finally(() => { cleaning = false })
    }, 30000)
    updates.unref?.(); cleanup.unref?.()
    return () => { clearInterval(updates); clearInterval(cleanup) }
  }, 'mcp-toggle: published releases and cleanup')
}
