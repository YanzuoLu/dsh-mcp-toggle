import { symbols } from '@deepseek-ai/cordis'
import toolsPackage from '@deepseek-ai/dsh-tools/package.json' with { type: 'json' }
import resourcesPackage from '@deepseek-ai/dsh-mcp-resources/package.json' with { type: 'json' }

const VERSION = '0.2.0-rc.2'
const unsupported = detail => new Error(`Unsupported DSH MCP compatibility API (${VERSION} required): ${detail}`)
const originalOf = value => value?.[symbols.original] ?? value
// AgentLoop does not inject mcpResources. Dynamic lookup still respects the
// caller's service-isolation scope without requiring a new Agent dependency.
const serviceOf = (owner, name) => originalOf(typeof owner.get === 'function' ? owner.get(name) : owner[name])

function toolView(value) {
  if (!(value?.visible instanceof Map) || !(value.knownNames instanceof Set) || !(value.restrictableNames instanceof Set)) {
    throw unsupported('tools.view() must return visible, knownNames and restrictableNames collections')
  }
  return value
}

function resourceMap(value) {
  if (!(value instanceof Map)) throw unsupported('mcpResources.layers.merge() must return a Map')
  return value
}

/**
 * The two private read seams used by DSH 0.2.0-rc.2. The bootstrap owns their
 * lifetime while bridge.current supplies the replaceable policy implementation.
 * Registrations, connections, execution signals and registry name sets stay owned
 * by DSH. Policy decides which scopes and returned entries to filter.
 */
export function installCompatibility(ctx, bridge) {
  for (const pkg of [toolsPackage, resourcesPackage]) {
    if (pkg.version !== VERSION) throw unsupported(`${pkg.name} is ${pkg.version}`)
  }
  const toolInstances = new WeakMap()
  const resourceInstances = new WeakMap()
  const patches = new Set()
  let agentPairs = new WeakMap()
  let rootPair
  let disposed = false

  function filter(method, value, scope) {
    const delegate = disposed ? undefined : bridge.current
    if (delegate == null) return value
    if (typeof delegate[method] !== 'function') throw unsupported(`bridge.current.${method} is missing`)
    return delegate[method](value, scope)
  }

  function restore(patch) {
    // A later wrapper may retain ours. Leave its method in place and make our
    // enclosed wrapper pass through once its final owner has detached.
    if (patch.target[patch.key] !== patch.wrapper) return
    if (patch.descriptor) Object.defineProperty(patch.target, patch.key, patch.descriptor)
    else delete patch.target[patch.key]
  }

  function prepare(target, key, project, validate) {
    const original = target?.[key]
    const descriptor = target && Object.getOwnPropertyDescriptor(target, key)
    if (typeof original !== 'function') throw unsupported(`${key}() is missing`)
    if (descriptor && (!('value' in descriptor) || (!descriptor.configurable && !descriptor.writable))) {
      throw unsupported(`${key} cannot be wrapped`)
    }
    if (!descriptor && !Object.isExtensible(target)) throw unsupported(`${key} owner is not extensible`)
    const patch = { target, key, descriptor, original, validate, active: true, users: 0, pinned: false }
    patch.wrapper = function (...args) {
      const value = validate(Reflect.apply(original, this, args))
      return patch.active ? filter(project, value, args[0]) : value
    }
    return patch
  }

  function contextOf(agent) {
    if (disposed) throw new Error('MCP compatibility adapter is disposed')
    const owner = agent === undefined ? ctx : agent.ctx
    if (!owner) throw unsupported('agent.ctx is missing')
    return owner
  }

  function release(patch) {
    patch.active = false
    restore(patch)
    patch.instances.delete(patch.service)
    patches.delete(patch)
  }

  function replacePair(agent, next) {
    const previous = agent === undefined ? rootPair : agentPairs.get(agent)
    for (const patch of next ?? []) {
      if (previous?.includes(patch)) continue
      if (agent === undefined) patch.pinned = true
      else patch.users++
    }
    if (agent === undefined) rootPair = next
    else if (next) agentPairs.set(agent, next)
    else agentPairs.delete(agent)
    for (const patch of previous ?? []) {
      if (next?.includes(patch)) continue
      if (agent === undefined) patch.pinned = false
      else patch.users--
      if (!patch.pinned && patch.users === 0) release(patch)
    }
  }

  function attach(agent) {
    const owner = contextOf(agent)
    const tools = serviceOf(owner, 'tools')
    const resources = serviceOf(owner, 'mcpResources')
    if (!tools || !resources?.layers) throw unsupported('tools or mcpResources service is missing')
    const layers = resources.layers
    if (typeof layers.global?.servers?.entries !== 'function') {
      throw unsupported('mcpResources.layers.global.servers is missing')
    }
    const additions = []
    if (!toolInstances.has(tools)) {
      additions.push({ instances: toolInstances, service: tools,
        patch: prepare(tools, 'view', 'filterTools', toolView) })
    }
    if (!resourceInstances.has(resources)) {
      additions.push({ instances: resourceInstances, service: resources,
        patch: prepare(layers, 'merge', 'filterResources', resourceMap) })
    }
    const installed = []
    try {
      for (const entry of additions) {
        const { patch, instances, service } = entry
        Object.defineProperty(patch.target, patch.key, patch.descriptor
          ? { ...patch.descriptor, value: patch.wrapper }
          : { configurable: true, writable: true, value: patch.wrapper })
        installed.push(entry)
        patch.instances = instances
        patch.service = service
        instances.set(service, patch)
        patches.add(patch)
      }
    } catch (error) {
      for (const { patch } of installed.reverse()) release(patch)
      throw error
    }
    replacePair(agent, [toolInstances.get(tools), resourceInstances.get(resources)])
  }

  /** Release an agent's instance references without resolving its disposed context. */
  function detach(agent) {
    if (disposed || agent === undefined) return
    replacePair(agent, undefined)
  }

  function rawTools(agent) {
    attach(agent)
    const service = serviceOf(contextOf(agent), 'tools')
    const patch = toolInstances.get(service)
    return patch.validate(Reflect.apply(patch.original, service, [agent]))
  }

  function rawResources(agent) {
    attach(agent)
    const service = serviceOf(contextOf(agent), 'mcpResources')
    const patch = resourceInstances.get(service)
    return patch.validate(Reflect.apply(patch.original, service.layers, [agent, layer => layer.servers]))
  }

  function dispose() {
    if (disposed) return
    disposed = true
    for (const patch of [...patches].reverse()) release(patch)
    agentPairs = new WeakMap()
    rootPair = undefined
  }

  attach()
  return { attach, detach, rawTools, rawResources, dispose }
}
