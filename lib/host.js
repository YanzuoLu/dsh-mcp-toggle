export { installCompatibility } from './compat.js'

const RESOURCE_TOOLS = new Set(['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'])
const isAgent = scope => Boolean(scope?.session?.header?.id)
const isMcpTool = name => name.startsWith('mcp__')
const same = (a, b) => a !== null && a.size === b.size && [...a].every(name => b.has(name))
const validSession = value => {
  if (typeof value !== 'string' || !value) throw new Error('sessionId is required')
  return value
}

/** Pure policy callbacks. The stable entry owns storage, hooks and live maps. */
export function createRuntime(ctx, bridge) {
  const { records, effective, owners, headers } = bridge

  function serverNames(agent) {
    return [...bridge.compat.rawResources(agent).keys()].sort()
  }
  function toolOwners(name, names) {
    return names.filter(server => name.startsWith(`mcp__${server}__`))
  }
  function selected(id) {
    return new Set(records.get(owners.get(id) ?? id)?.enabledServers ?? [])
  }
  function policy(agent) {
    // null is used only during bootstrap attachment. An in-flight step gets
    // a snapshot of existing servers until the next safe step boundary.
    return effective.has(agent.session.id) ? effective.get(agent.session.id) : new Set()
  }
  let notificationPending = false
  function commit(agent) {
    const next = selected(agent.session.id)
    const previous = effective.get(agent.session.id)
    effective.set(agent.session.id, next)
    if (previous !== undefined && same(previous, next)) return
    if (notificationPending) return
    notificationPending = true
    queueMicrotask(() => {
      notificationPending = false
      if (bridge.closing) return
      ctx.emit('tools/change')
      ctx.emit('system-prompt/change')
    })
  }
  async function headerFor(id, refresh = false) {
    const live = ctx.agents.get(id)?.session.header
    if (live) { headers.set(id, live); return live }
    if (!refresh && headers.has(id)) return headers.get(id)
    const view = await ctx.sessionQuery.observeSession(id)
    try { headers.set(id, view.header); return view.header }
    finally { view[Symbol.dispose]() }
  }
  async function ownerFor(header) {
    let current = header
    const visited = new Set()
    while (current.origin === 'subagent') {
      if (!current.parentSession || visited.has(current.id)) throw new Error('Invalid subagent parent chain')
      visited.add(current.id)
      current = await headerFor(current.parentSession)
    }
    return current.id
  }
  async function initialize(agent, fresh = false, alreadyRunning = false) {
    const header = agent.session.header
    headers.set(header.id, header)
    const owner = await ownerFor(header)
    owners.set(header.id, owner)
    if (fresh && header.origin !== 'subagent' && header.id.startsWith('session-sidechat-') && header.parentSession && !records.get(header.id)) {
      const parentOwner = await ownerFor(await headerFor(header.parentSession))
      await records.put(header.id, { enabledServers: [...(records.get(parentOwner)?.enabledServers ?? [])] })
    }
    if (alreadyRunning && agent.status === 'running' && !records.get(owner)) effective.set(header.id, new Set(serverNames(agent)))
    else commit(agent)
  }
  function filterTools(view, scope) {
    if (!isAgent(scope)) return view
    const enabled = policy(scope)
    if (enabled === null) return view
    const names = serverNames(scope)
    const visible = new Map()
    const resourceEnabled = names.some(name => enabled.has(name))
    for (const [name, definition] of view.visible) {
      if (RESOURCE_TOOLS.has(name) && !resourceEnabled) continue
      if (isMcpTool(name)) {
        const matches = toolOwners(name, names)
        // Nested namespaces (a and a__b) are genuinely ambiguous in this DSH
        // release. Do not guess ownership from the longest matching prefix.
        if (matches.length !== 1 || !enabled.has(matches[0])) continue
      }
      visible.set(name, definition)
    }
    return visible.size === view.visible.size ? view : { ...view, visible }
  }
  function filterResources(providers, scope) {
    if (!isAgent(scope)) return providers
    const enabled = policy(scope)
    if (enabled === null) return providers
    return new Map([...providers].filter(([name]) => enabled.has(name)))
  }
  function filterAssembly(assembly, context) {
    const agent = context.agent ?? context.scope
    if (!isAgent(agent)) return assembly
    const enabled = policy(agent)
    if (enabled === null) return assembly
    return {
      ...assembly,
      sections: assembly.sections.filter(section => !section.name.startsWith('mcp:') || enabled.has(section.name.slice(4))),
    }
  }
  function onEvent(session, event) {
    if (!['turn/start', 'step/end', 'turn/end'].includes(event.type)) return
    const agent = ctx.agents.get(session.id)
    if (agent && owners.has(session.id)) commit(agent)
  }
  function onDisposed(agent) {
    effective.delete(agent.session.id)
    owners.delete(agent.session.id)
    headers.delete(agent.session.id)
  }
  function catalog(agent, enabledServers) {
    const names = serverNames(agent)
    const tools = bridge.compat.rawTools(agent).visible
    const counts = new Map(names.map(name => [name, 0]))
    for (const name of tools.keys()) {
      if (!isMcpTool(name)) continue
      const matches = toolOwners(name, names)
      if (matches.length === 1) counts.set(matches[0], counts.get(matches[0]) + 1)
    }
    return [...new Set([...names, ...enabledServers])].sort().map(name => ({
      name, toolCount: counts.get(name) ?? 0, connected: names.includes(name),
    }))
  }
  async function get(payload) {
    const sessionId = validSession(payload?.sessionId)
    const header = await headerFor(sessionId, true)
    const selectionSessionId = await ownerFor(header)
    owners.set(sessionId, selectionSessionId)
    const enabledServers = [...(records.get(selectionSessionId)?.enabledServers ?? [])]
    const agent = ctx.agents.get(sessionId)
    return {
      sessionId, selectionSessionId, enabledServers, servers: catalog(agent, enabledServers),
      inherited: header.origin === 'subagent',
      pending: Boolean(agent && effective.has(sessionId) && !same(effective.get(sessionId), new Set(enabledServers))),
      runtime: bridge.runtime,
    }
  }
  async function set(payload) {
    const sessionId = validSession(payload?.sessionId)
    const header = await headerFor(sessionId, true)
    if (header.origin === 'subagent') throw new Error('Subagents follow their parent session')
    if (!Array.isArray(payload.enabledServers) || !payload.enabledServers.every(name => typeof name === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(name))) {
      throw new Error('enabledServers must be a list of MCP server names')
    }
    const enabledServers = [...new Set(payload.enabledServers)].sort()
    const agent = ctx.agents.get(sessionId)
    const names = serverNames(agent)
    const known = new Set([...names, ...(records.get(sessionId)?.enabledServers ?? [])])
    for (const name of enabledServers) {
      if (!known.has(name)) throw new Error(`Unknown MCP server: ${name}`)
      if (names.some(other => other !== name && (name.startsWith(`${other}__`) || other.startsWith(`${name}__`)))) {
        throw new Error(`MCP namespace ${name} overlaps another server; give the servers non-overlapping names`)
      }
    }
    await records.put(sessionId, { enabledServers })
    for (const candidate of ctx.agents.list()) {
      if ((owners.get(candidate.session.id) ?? candidate.session.id) === sessionId && candidate.status === 'idle') commit(candidate)
    }
    return get({ sessionId })
  }
  async function cleanup() {
    if (![...records.entries()].length) return
    const present = new Set((await ctx.sessionQuery.listSessions()).map(record => record.header.id))
    for (const [id] of records.entries()) if (!present.has(id)) await records.delete(id)
  }
  return { initialize, commit, filterTools, filterResources, filterAssembly, onEvent, onDisposed, get, set, cleanup }
}
