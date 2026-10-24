# dsh-mcp-toggle

Per-session MCP selection for DeepSeek Harness Web. MCP servers are **off by default**.

## Usage

The **MCP** dropdown sits immediately to the right of the composer permission control, before Plan. Its count is the number of selected servers, not the number of tools. Select the servers this conversation needs. Appearance, compact-mode behavior and language follow DSH.

- An unconfigured ordinary session has no MCP servers selected. This includes existing sessions when the plugin is first installed. Newly added servers also stay off until selected.
- Choices are stored per session in DSH's `mcp_toggle` storage domain and survive restart. They are not a global setting or a browser-only preference.
- Subagents follow the ordinary session at the root of their parent chain. Their picker is hidden.
- A newly created `dsh-side-chat` side chat copies its main session's selection, then owns an independent choice. Existing unconfigured side chats and ordinary forks default off.
- Changes made while idle apply immediately. A running session adopts them at its next safe step boundary. The menu shows **Applies at the next step** while its selected and effective choices differ. Already executing MCP calls are not cancelled. On first installation, a step already in flight can finish with its existing servers before the default-off policy takes effect.
- Turning a server off removes its tools from subsequent native tool definitions and generated PTC SDKs, hides its attributed server instructions, removes it from the resource-server hint, and prevents resource access through the shared MCP resource tools. Ordinary DSH tools remain unchanged.
- Server connections are shared and remain running. Selecting a server does not launch, restart, disconnect or reload it. Availability means a provider is registered, not that the plugin has performed a network health probe.
- Previously recorded tool results and old conversation content are not deleted. Normal DSH compaction still manages that history.

The picker never sends a prompt or creates a model request. The plugin adds no model-facing instructions of its own.

## Install

```sh
dsh plugin --profile web add github:YanzuoLu/dsh-mcp-toggle
```

It targets **DSH 0.2.0-rc.2**. Installation and ordinary implementation updates do not require a DSH restart. Refresh the browser to load changed client code.

## Scope and compatibility

The permission component is decorated locally to append the picker. Its entry identity, injected props, existing control, locale, children and lifecycle remain intact. No DOM rows are moved and no DSH files are modified.

Two version-specific registry-view adapters cover native tools, PTC, and tools registered directly in an agent's scope. The public `restrict` API alone does not filter a scope's own registrations. The adapters filter copies returned by `ToolRuntime.view` and the MCP resource registry's `ScopedLayers.merge` only for agent scopes. Global and preset inspection, registrations, registry name sets, unrelated tools and shared connections remain unchanged. A normal prompt-assembly listener removes disabled `mcp:<server>` sections. Unloading restores the original methods without overwriting a later wrapper.

MCP names are attributed by their server-qualified prefix, which the current bridge preserves even when a raw tool name is normalized or shortened. Overlapping server namespaces such as `a` and `a__b` are ambiguous in this DSH version. The picker rejects enabling overlapping namespaces and does not guess which server owns an ambiguous tool. Give these servers distinct non-overlapping names.

These controls govern tools exposed by DSH. They are not an operating-system sandbox and do not prevent a separately authorized shell or custom plugin from contacting the same external service independently.

## Updating

A stable package-owned bootstrap polls the published release manifest. Host implementations are imported from immutable versioned URLs and replaced only while operations and agents are idle. Session preferences and effective policy maps survive implementation changes. Changes to bootstrap interfaces or DSH compatibility require explicit testing rather than global module-cache resets.

```sh
npm run build
```

Publish the generated host directory and manifest together. Development tests and temporary artifacts belong in the ignored `.cache/` directory. Removed session preferences are cleared on removal notifications and reconciled against the session catalog periodically.
