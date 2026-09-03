// MCP server that mirrors a browser session's WebMCP tools. Uses the low-level
// Server so the page's JSON Schemas pass through untouched, and emits
// notifications/tools/list_changed whenever the page registers or revokes.

import { createRequire } from "node:module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createNameMap } from "./names.js";

const { version } = createRequire(import.meta.url)("../package.json");

export const META_TOOLS = {
  status: {
    name: "webmcp_status",
    description:
      "Report the page this adapter is attached to: URL, title, bridge mode (polyfill or native) and the names of the WebMCP tools it currently registers. Call this first if you are unsure what tools exist; the tool list changes as the page changes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, title: "WebMCP status" },
  },
  navigate: {
    name: "webmcp_navigate",
    description:
      "Navigate the attached browser tab to another URL. The page's WebMCP tools are dropped and whatever the new page registers replaces them.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "Absolute URL to load." } },
      required: ["url"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, title: "WebMCP navigate" },
  },
};

const SAFE_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const ANNOTATION_KEYS = ["title", "readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];

export function normaliseInputSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {} };
  }
  if (schema.type === "object") return schema;
  if (schema.type === undefined) return { ...schema, type: "object" };
  // A non-object root schema cannot be expressed as MCP tool input; wrap it.
  return { type: "object", properties: { value: schema }, required: ["value"] };
}

export function normaliseAnnotations(annotations) {
  if (!annotations || typeof annotations !== "object") return undefined;
  const out = {};
  for (const key of ANNOTATION_KEYS) {
    if (annotations[key] !== undefined) out[key] = annotations[key];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Map whatever a page tool returned onto an MCP CallToolResult. */
export function toCallResult(result) {
  if (result && typeof result === "object" && Array.isArray(result.content)) {
    const mapped = { content: result.content };
    if (result.structuredContent && typeof result.structuredContent === "object") {
      mapped.structuredContent = result.structuredContent;
    }
    if (typeof result.isError === "boolean") mapped.isError = result.isError;
    return mapped;
  }
  if (result === undefined) {
    return { content: [{ type: "text", text: "(tool returned no result)" }] };
  }
  if (typeof result === "string") {
    return { content: [{ type: "text", text: result }] };
  }
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  }
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

export function errorResult(message) {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/**
 * @param {{
 *   session: Promise<import("./browser.js").openSession extends (...a: any) => Promise<infer S> ? S : never> | any,
 *   metaTools?: boolean,
 *   listChangedDebounceMs?: number,
 *   log?: (line: string) => void,
 * }} options
 */
export function createAdapterServer(options) {
  const { metaTools = true, listChangedDebounceMs = 150, log = () => {} } = options;
  const sessionReady = Promise.resolve(options.session);

  const server = new Server(
    { name: "webmcp-mcp-adapter", version },
    { capabilities: { tools: { listChanged: true } } },
  );
  const names = createNameMap();

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const session = await sessionReady;
    const pageTools = await session.list();
    const tools = pageTools.map((tool) => {
      const entry = {
        name: names.safeNameFor(tool.name),
        description: typeof tool.description === "string" ? tool.description : "",
        inputSchema: normaliseInputSchema(tool.inputSchema),
      };
      const annotations = normaliseAnnotations(tool.annotations);
      if (annotations) entry.annotations = annotations;
      return entry;
    });
    if (metaTools) tools.push(META_TOOLS.status, META_TOOLS.navigate);
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args = {} } = request.params;
    const session = await sessionReady;

    if (metaTools && name === META_TOOLS.status.name) {
      const info = await session.info();
      const tools = await session.list().catch(() => []);
      const status = { ...info, tools: tools.map((tool) => names.safeNameFor(tool.name)) };
      return toCallResult(status);
    }
    if (metaTools && name === META_TOOLS.navigate.name) {
      if (typeof args?.url !== "string") return errorResult("webmcp_navigate: url is required");
      try {
        await session.navigate(args.url);
        return toCallResult(await session.info());
      } catch (error) {
        return errorResult(`navigation failed: ${error?.message ?? error}`);
      }
    }

    let pageName = names.pageNameFor(name);
    if (!pageName) {
      // The map fills during tools/list; a client may call first, or call a
      // tool that was revoked before it was ever listed. Refresh, then fall
      // back to identity for names that are already MCP-safe so the page can
      // answer with its own stale-tool error.
      for (const tool of await session.list().catch(() => [])) names.safeNameFor(tool.name);
      pageName = names.pageNameFor(name) ?? (SAFE_NAME.test(name) ? name : undefined);
    }
    if (!pageName) {
      return errorResult(`unknown tool: ${name}. The page's tool list may have changed; list tools again.`);
    }
    try {
      log(`call ${pageName} ${JSON.stringify(args)}`);
      const result = await session.call(pageName, args, { signal: extra?.signal });
      return toCallResult(result);
    } catch (error) {
      const message = error?.message ?? String(error);
      log(`call ${pageName} failed: ${message}`);
      return errorResult(message);
    }
  });

  let timer = null;
  let unsubscribe = () => {};
  sessionReady
    .then((session) => {
      unsubscribe = session.onChange((event) => {
        log(`page ${event.kind}${event.name ? ` ${event.name}` : ""}`);
        if (!server.transport) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          server.sendToolListChanged().catch((error) => log(`list_changed failed: ${error?.message ?? error}`));
        }, listChangedDebounceMs);
      });
    })
    .catch((error) => log(`session failed to open: ${error?.message ?? error}`));

  return {
    server,
    async connectStdio() {
      await server.connect(new StdioServerTransport());
    },
    async close() {
      clearTimeout(timer);
      unsubscribe();
      await server.close().catch(() => {});
    },
  };
}
