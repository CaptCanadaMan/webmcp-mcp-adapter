// End-to-end over real stdio: spawn the CLI the way an MCP client does and
// talk to it through the SDK's stdio client transport.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "bin", "webmcp-mcp.js");
const FIXTURE = pathToFileURL(path.join(HERE, "fixture", "index.html")).href;

test("CLI serves the page's tools over stdio", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, "--url", FIXTURE, "--headless", "--quiet"],
    stderr: "pipe",
  });
  const client = new Client({ name: "stdio-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    // The browser may still be launching after initialize; poll until the page's tools show up.
    let names = [];
    const deadline = Date.now() + 20_000;
    while (!names.includes("echo")) {
      if (Date.now() > deadline) throw new Error(`echo never appeared; saw ${names.join(", ")}`);
      names = (await client.listTools()).tools.map((tool) => tool.name);
      if (!names.includes("echo")) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(names.includes("webmcp_status"));

    const result = await client.callTool({ name: "echo", arguments: { text: "over stdio" } });
    assert.deepEqual(result.structuredContent, { echoed: "over stdio", at: 1 });

    const status = await client.callTool({ name: "webmcp_status", arguments: {} });
    assert.equal(status.structuredContent.mode, "polyfill");
    assert.equal(status.structuredContent.title, "WebMCP fixture");
  } finally {
    await client.close();
  }
});
