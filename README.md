# webmcp-mcp-adapter

An MCP server that turns any WebMCP-enabled web page into a set of MCP tools. It launches a Chromium window with Playwright, mirrors whatever tools the page registers on `modelContext`, and keeps that list live as the page adds and revokes them. Claude Code, Claude Desktop, Cursor, or any other MCP client then sees the page's tools as if they were its own.

Built for [Flow Control](https://flow.ahorsburgh.com), a human-supervised tower control demo where a Claude agent flies the Shift while a person watches the browser and approves plans. Nothing in this package is specific to that site.

## Why this exists

[WebMCP](https://github.com/webmachinelearning/webmcp) lets a page describe what an agent can do on it, with a name, a description, a JSON Schema and an `execute` callback that runs in the page's own JavaScript. That is a good fit for agents, but as of September 2026 it only exists in Chrome's gated early preview, and there is no standard way for an agent running outside the browser to reach those tools.

Two dialects are already in the wild:

- The explainer: `document.modelContext.registerTool(tool, { signal })`, revoked by aborting the signal, with `getTools()`, `executeTool()` and a `toolchange` event for the host side.
- Chrome 146 Canary: `navigator.modelContext.registerTool(tool)` and `unregisterTool(name)` behind the `webmcp` flag.

This adapter installs a polyfill that honours both, on both objects, before any page script runs. Registrations flow to the MCP client as `tools/list`, changes flow as `notifications/tools/list_changed`, and calls flow back into the page's `execute`. When a browser already ships a native `modelContext`, the experimental `--native` mode leaves it in place and bridges through the explainer's `getTools` / `executeTool` surface instead.

## Setup

```bash
npm install
npx playwright install chromium
```

Node 20 or newer.

### Claude Code

```bash
claude mcp add flow-control -- node /path/to/webmcp-mcp-adapter/bin/webmcp-mcp.js --url https://flow.ahorsburgh.com
```

Start a Claude Code session. A Chromium window opens on the page, and the page's tools appear under the `flow-control` server. When the page changes what it registers, Claude Code picks up the change through `list_changed`.

### Claude Desktop and other clients

```json
{
  "mcpServers": {
    "flow-control": {
      "command": "node",
      "args": ["/path/to/webmcp-mcp-adapter/bin/webmcp-mcp.js", "--url", "https://flow.ahorsburgh.com"]
    }
  }
}
```

## Options

| Flag | Meaning |
| --- | --- |
| `--url <url>` | Page to attach to. Required. |
| `--headless` | No browser window. Default is headed so a person can watch and act on the page. |
| `--channel <name>` | Playwright channel: `chromium` (default), `chrome`, `chrome-canary`, `msedge`. |
| `--native` | Experimental. Use the browser's own `modelContext` when present instead of the polyfill. |
| `--profile-dir <dir>` | Persistent browser profile, so logins survive between runs. |
| `--call-timeout-ms <n>` | Abort a tool call after n ms. Default 0, no timeout. |
| `--no-meta-tools` | Hide the two built-in tools below. |
| `--quiet` | No stderr logging. |

## What the client sees

- Every active page tool, with its description, its `inputSchema` (normalised to an object schema) and its annotations (`readOnlyHint` and friends) passed through.
- Two built-ins: `webmcp_status` reports the page URL, title, bridge mode and current tool names. `webmcp_navigate` loads another URL in the same tab.
- Tool names are sanitised to `[A-Za-z0-9_-]` and de-duplicated. The mapping is stable for the life of the server.

Results: if the page's `execute` returns an MCP-shaped `{ content: [...] }`, it passes through. Any other object is returned as pretty-printed JSON text plus `structuredContent`. A thrown error, a revoked tool, or a timeout comes back as an `isError` result rather than a protocol failure, so the agent can read the message and adapt.

Cancellation: an MCP `notifications/cancelled` for an in-flight call aborts the `AbortSignal` the page's `execute` received.

Navigation: when the tab navigates, the mirror resets and the new page's registrations replace the old ones.

## Living with a changing tool list

WebMCP pages register and revoke tools as their state changes. Flow Control, for example, exposes one tool while the Shift is armed, nine once the agent takes the sector, and five read-only tools after the Shift completes. The adapter forwards each change immediately, so an agent should expect its tool list to move and should re-list rather than assume. A call to a revoked tool returns an `isError` result saying the tool is stale.

## Native mode

`--channel chrome-canary --native` with the `webmcp` flag enabled in Chrome asks the adapter to use the browser's own implementation. The polyfill steps aside if `modelContext` already exists. Bridging then needs the explainer's `getTools` / `executeTool` on that object; if the browser only offers the register side, `webmcp_status` reports `native-unsupported` and you should run without `--native`. Chrome's early preview documentation is gated behind Google's early preview program, so this mode is untested against a real build and is labelled accordingly.

## Relation to other work

[mcp-b](https://github.com/MiguelsPizza/WebMCP) connects tabs to desktop MCP clients through a Chrome extension and a native messaging host, using its own postMessage transport. This adapter takes the other route: it speaks the standard page API directly through Playwright, needs no extension, and works with any page that calls `registerTool`, at the cost of owning the browser process.

## Limitations

- One page per server process. Run several servers for several pages.
- The polyfill is a faithful subset, not the spec: `exposedTo` origin scoping and `requestUserInteraction` are not implemented.
- Logged-in sites need `--profile-dir` and a person to sign in once in the headed window. The adapter never handles credentials.

## Tests

```bash
npm test
```

Runs headless against a local fixture page that registers tools in both dialects, revokes them both ways, returns raw and content-shaped results, throws, and navigates.

## Licence

MIT.
