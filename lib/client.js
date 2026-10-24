// Browser half, loaded by the DSH web shell as a classic script.
window.__ModuleLoader__.load({
  id: 'dsh-mcp-toggle',
  factory: (require) => {
    const React = require('react')
    const { useEffect, useState, useSyncExternalStore } = React
    const { Fragment, jsx, jsxs } = require('react/jsx-runtime')
    const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store')
    const { Menu, Toast, IconApiOutlineRegular, IconChevronDownOutlineRegular, IconWarningOutlineRegular } = require('@deepseek-ai/dsh-client-ui-primitives')

    const ID = 'dsh-mcp-toggle'
    const NS = 'mcp-toggle'
    const PERMISSION = 'conversation.input.permission'
    const WRAPPED = Symbol.for('dsh-mcp-toggle.permission-wrapper')
    const identity = (value) => value
    const Empty = () => null
    const zh = {
      picker: 'MCP 服务器，已启用 {count} 个', tools: '{count} 个工具', connected: '可用', disconnected: '不可用',
      empty: '没有可用的 MCP 服务器', inherited: '继承父会话的 MCP 选择', pending: '下一步生效',
      loadError: 'MCP 选择加载失败：{message}', saveError: 'MCP 选择保存失败：{message}',
      serviceUnavailable: '服务暂时不可用（HTTP {status}）', reauthRequired: '登录已失效，请重新登录（HTTP {status}）',
      httpError: '请求失败（HTTP {status}）', httpMessage: '{message}（HTTP {status}）',
      unexpectedResponse: '服务返回了无法识别的响应（HTTP {status}），请稍后重试', retrying: '{message}，正在自动重试',
    }
    const en = {
      picker: 'MCP servers, {count} enabled', tools: '{count} tools', connected: 'Available', disconnected: 'Unavailable',
      empty: 'No MCP servers available', inherited: 'MCP selection inherited from the parent session', pending: 'Applies at the next step',
      loadError: 'Could not load MCP selection: {message}', saveError: 'Could not save MCP selection: {message}',
      serviceUnavailable: 'Service temporarily unavailable (HTTP {status})', reauthRequired: 'Authentication required. Please sign in again (HTTP {status})',
      httpError: 'Request failed (HTTP {status})', httpMessage: '{message} (HTTP {status})',
      unexpectedResponse: 'Unexpected server response (HTTP {status}). Please try again later', retrying: '{message}. Retrying automatically',
    }
    // ModelSelect's trigger tokens and states, including its compact-row variables.
    const CSS = `
.dsh-mcp-trigger{border-radius:var(--dsw-radius-sm);min-width:0;max-width:min(360px,45cqw);height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;outline:none;align-items:center;gap:4px;padding:0 4px 0 8px;font-size:13px;font-weight:400;line-height:20px;display:flex}
.dsh-mcp-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-mcp-trigger:focus-visible:not([data-selection-focus]){box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
.dsh-mcp-trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.dsh-mcp-text{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}
.dsh-mcp-icon{display:var(--dsh-composer-model-icon-display,none);flex:none}
.dsh-mcp-text,.dsh-mcp-chevron{display:var(--dsh-composer-model-text-display,block)}
.dsh-mcp-chevron{color:var(--dsw-alias-label-caption);flex:none;transition:transform .12s}
.dsh-mcp-chevronOpen{transform:rotate(180deg)}
.dsh-mcp-row{min-width:0;display:flex;flex-direction:column}
.dsh-mcp-name{text-overflow:ellipsis;white-space:nowrap;overflow:hidden}
.dsh-mcp-detail{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px}
`

    const responseError = (uiCode, status) => Object.assign(new Error(`HTTP ${status}`), { uiCode, status })
    const httpError = (status) => responseError(status === 503 ? 'serviceUnavailable' : status === 401 ? 'reauthRequired' : 'httpError', status)
    // A proxy or reloading host may return text instead of the API envelope.
    // Validate the fields the picker reads before accepting a replacement.
    const validSelection = (value, sessionId) => value !== null && typeof value === 'object'
      && value.sessionId === sessionId && typeof value.selectionSessionId === 'string'
      && typeof value.inherited === 'boolean' && (value.pending === undefined || typeof value.pending === 'boolean')
      && Array.isArray(value.enabledServers) && value.enabledServers.every((name) => typeof name === 'string')
      && Array.isArray(value.servers) && value.servers.every((server) => server !== null && typeof server === 'object'
        && typeof server.name === 'string' && (server.label === undefined || typeof server.label === 'string')
        && Number.isInteger(server.toolCount) && server.toolCount >= 0
        && (server.connected === undefined || typeof server.connected === 'boolean'))
    async function callHost(endpoint, payload, signal) {
      const response = await fetch(`api/mcp-toggle/${endpoint}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload), signal,
      })
      let result
      try {
        result = await response.json()
      } catch (error) {
        if (signal.aborted || error?.name === 'AbortError') throw error
        if (!response.ok) throw httpError(response.status)
        if (error?.name === 'SyntaxError') throw responseError('unexpectedResponse', response.status)
        throw error
      }
      if (result?.ok === false && typeof result.error?.message === 'string') {
        throw Object.assign(new Error(result.error.message), { status: response.status })
      }
      if (!response.ok) throw httpError(response.status)
      if (result?.ok !== true || !validSelection(result.value, payload.sessionId)) throw responseError('unexpectedResponse', response.status)
      return result.value
    }

    const initial = (sessionId) => ({ sessionId, value: null, loading: false, saving: false, error: null })
    function createController() {
      const state = createSnapshotStore(initial())
      const lifetime = new AbortController()
      // Writes outlive a view switch. Returning to that session waits for its
      // write to settle before reading, so an abort cannot create a stale read.
      const writes = new Map()
      let active, read, generation = 0, errorId = 0
      const current = (seat) => active === seat && seat.generation === generation && !lifetime.signal.aborted
      const patch = (seat, values) => {
        if (current(seat)) state.set({ ...state.getSnapshot(), ...values })
      }
      const fail = (seat, kind, error) => {
        if (!current(seat)) return
        const message = typeof error?.message === 'string' ? error.message : String(error)
        const { uiCode, status } = error ?? {}
        if (kind === 'loadError') {
          seat.failures503 = status === 503 ? seat.failures503 + 1 : 0
          if (seat.failures503 === 1) return
        }
        const previous = state.getSnapshot().error
        if (previous?.kind !== kind || previous.message !== message || previous.uiCode !== uiCode || previous.status !== status) {
          patch(seat, { error: { id: ++errorId, kind, message, uiCode, status } })
        }
      }
      const abortRead = () => { read?.controller.abort(); read = undefined }
      const refresh = async () => {
        const seat = active
        if (!seat || !current(seat) || document.visibilityState !== 'visible' || writes.has(seat.sessionId) || read) return
        const request = { controller: new AbortController() }
        read = request
        patch(seat, { loading: true })
        try {
          const value = await callHost('get', { sessionId: seat.sessionId }, request.controller.signal)
          if (read === request && current(seat)) {
            seat.failures503 = 0
            patch(seat, { value, error: null })
          }
        } catch (error) {
          if (read === request && !request.controller.signal.aborted) fail(seat, 'loadError', error)
        } finally {
          if (read === request) { read = undefined; patch(seat, { loading: false }) }
        }
      }
      const mount = (sessionId) => {
        if (lifetime.signal.aborted || typeof sessionId !== 'string' || sessionId.length === 0) return () => {}
        active?.release()
        const seat = { sessionId, generation: ++generation, failures503: 0 }
        active = seat
        state.set(initial(sessionId))
        const onVisibility = () => {
          if (document.visibilityState === 'visible') void refresh()
          else { abortRead(); patch(seat, { loading: false }) }
        }
        const timer = setInterval(() => { void refresh() }, 5000)
        document.addEventListener('visibilitychange', onVisibility)
        seat.release = () => {
          clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisibility)
          if (current(seat)) { abortRead(); active = undefined }
        }
        const writing = writes.get(sessionId)
        if (writing) {
          patch(seat, { loading: true })
          void writing.then(() => { if (current(seat)) void refresh() })
        } else void refresh()
        return seat.release
      }
      const toggle = (name) => {
        const seat = active, snapshot = state.getSnapshot()
        const value = snapshot.value
        // Rows are disabled for the whole write. This synchronous guard also
        // prevents a second click in the render gap from racing a replacement.
        if (!seat || !current(seat) || !value || value.inherited || writes.has(seat.sessionId) || !value.servers.some((server) => server.name === name)) return
        const enabledServers = value.enabledServers.includes(name)
          ? value.enabledServers.filter((server) => server !== name)
          : [...value.enabledServers, name]
        abortRead()
        patch(seat, { saving: true, loading: false, error: null })
        const operation = callHost('set', { sessionId: seat.sessionId, enabledServers }, lifetime.signal).then((accepted) => {
          patch(seat, { value: accepted, error: null })
        }).catch((error) => {
          fail(seat, 'saveError', error)
        }).finally(() => {
          writes.delete(seat.sessionId)
          patch(seat, { saving: false })
        })
        writes.set(seat.sessionId, operation)
        return operation
      }
      return {
        state, mount, refresh, toggle,
        dispose() { active?.release(); lifetime.abort() },
      }
    }

    function Picker({ sessionId, locked, useInput, useSessions, controller, sessions, locale, t }) {
      const input = useInput(identity)
      const catalog = useSessions(identity)
      const state = useSyncExternalStore(controller.state.subscribe, controller.state.getSnapshot, controller.state.getSnapshot)
      useSyncExternalStore(locale.subscribe, locale.getSnapshot, locale.getSnapshot)
      const [open, setOpen] = useState(false)
      const [dismissedError, setDismissedError] = useState(null)
      const subagent = typeof sessionId === 'string' && sessions.subagentAddress(sessionId) !== undefined
      const selected = typeof sessionId === 'string' && sessionId.length > 0 && (catalog.byId[sessionId]?.retainedBy?.mainView ?? 0) > 0
      const available = selected && input !== undefined && !subagent
      useEffect(() => {
        setOpen(false)
        if (available) return controller.mount(sessionId)
      }, [available, sessionId, controller])
      const value = state.sessionId === sessionId ? state.value : null
      const saving = state.sessionId === sessionId && state.saving
      const disabled = locked !== false || !available || value === null || value.inherited || saving
      useEffect(() => { if (!available || locked !== false) setOpen(false) }, [available, locked])
      if (subagent) return null
      const count = value?.enabledServers.length ?? 0
      const label = t('picker', { count })
      const error = state.sessionId === sessionId ? state.error : null
      const errorMessage = error?.uiCode ? t(error.uiCode, { status: error.status })
        : error?.status !== undefined ? t('httpMessage', { message: error.message, status: error.status }) : error?.message
      const errorDetail = error?.kind === 'loadError' && error.status === 503 ? t('retrying', { message: errorMessage }) : errorMessage
      const items = value?.servers.map((server) => ({
        id: server.name,
        disabled,
        label: jsxs('span', { className: 'dsh-mcp-row', children: [
          jsx('span', { className: 'dsh-mcp-name', title: server.name, children: server.label || server.name }),
          jsx('span', { className: 'dsh-mcp-detail', children: [
            t('tools', { count: server.toolCount }),
            ...(typeof server.connected === 'boolean' ? [' · ', t(server.connected ? 'connected' : 'disconnected')] : []),
          ] }),
        ] }),
      })) ?? []
      return jsxs(Fragment, { children: [
        jsx(Menu, {
          open, side: 'top', align: 'start', portal: true, selection: 'check',
          selectedIds: value?.enabledServers ?? [],
          items: items.length > 0 ? items : [{ type: 'label', id: 'empty', text: t('empty') }],
          footer: value?.pending === true ? [{ type: 'label', id: 'pending', text: t('pending') }] : undefined,
          onSelect: (name) => { if (!disabled) void controller.toggle(name) },
          onClose: () => setOpen(false),
          anchor: jsxs('button', {
            type: 'button', className: 'dsh-mcp-trigger', disabled,
            'aria-label': label, 'aria-haspopup': 'menu', 'aria-expanded': open,
            'aria-busy': saving || (state.sessionId === sessionId && state.loading),
            title: value?.inherited ? t('inherited') : label,
            onClick: () => { if (!disabled) setOpen(!open) },
            children: [
              jsx(IconApiOutlineRegular, { size: 16, className: 'dsh-mcp-icon' }),
              jsx('span', { className: 'dsh-mcp-text', children: `MCP ${count}` }),
              jsx(IconChevronDownOutlineRegular, { className: `dsh-mcp-chevron${open ? ' dsh-mcp-chevronOpen' : ''}` }),
            ],
          }),
        }),
        error && error.id !== dismissedError && jsx(Toast, {
          text: t(error.kind, { message: errorDetail }), icon: jsx(IconWarningOutlineRegular, {}),
          onDone: () => setDismissedError(error.id),
        }, error.id),
      ] })
    }

    // InputBar orders permission, then plan, then the left list. Wrap only the
    // permission component to insert immediately after it, before plan. Its
    // entry identity, injections, locale, children and original props stay intact.
    function installPicker(ctx, controller) {
      const slots = ctx.slots
      const locale = { subscribe: (listener) => ctx.locale.subscribe(listener), getSnapshot: () => ctx.locale.getSnapshot() }
      const t = ctx.locale.bind(NS)
      return slots.inject(PERMISSION, function* () {
        const patched = new Map()
        let stopped = false
        const reconcile = () => {
          if (stopped) return
          const entries = slots.entries(PERMISSION)
          for (const [entry, { Original, wrapper }] of patched) {
            if (entries.includes(entry)) continue
            if (entry.component === wrapper) entry.component = Original
            patched.delete(entry)
          }
          for (const entry of entries) {
            const Original = entry.component
            if (Original === Empty || Original[WRAPPED]) continue
            function PermissionWithMcp(props) {
              return jsxs(Fragment, { children: [
                React.createElement(Original, props),
                jsx(Picker, { ...props, controller, sessions: ctx.sessions, locale, t }, props.sessionId),
              ] })
            }
            PermissionWithMcp[WRAPPED] = true
            patched.set(entry, { Original, wrapper: PermissionWithMcp })
            entry.component = PermissionWithMcp
          }
        }
        yield ctx.on('slots/changed', (key) => { if (key === PERMISSION) reconcile() })
        yield slots.subscribe(PERMISSION, reconcile)
        reconcile()
        // The empty high-priority-number loser pulses registry subscribers. It
        // owns no id or child declaration and can never replace a real selector.
        const pulse = () => ({ name: PERMISSION, priority: Math.max(1e9, ...slots.entries(PERMISSION).map((entry) => entry.options.priority ?? 0)) + 1 })
        slots.register(pulse(), Empty)()
        yield slots.register(pulse(), Empty)
        yield () => {
          stopped = true
          for (const [entry, { Original, wrapper }] of patched) if (entry.component === wrapper) entry.component = Original
          patched.clear()
        }
      })
    }

    const inject = ['slots']
    function apply(ctx) {
      ctx.inject(['sessions', 'locale'], (ctx) => {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'mcp-toggle: dictionaries')
        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-plugin', ID)
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'mcp-toggle: styles')
        const controller = createController()
        ctx.effect(() => controller.dispose, 'mcp-toggle: requests')
        installPicker(ctx, controller)
      })
    }
    return { name: ID, inject, apply }
  },
})
