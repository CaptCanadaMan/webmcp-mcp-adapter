import { test } from "node:test";
import assert from "node:assert/strict";
import { bootAdapter } from "./helpers.js";

test("lists page tools with schemas and annotations, plus meta tools", async () => {
  const t = await bootAdapter();
  try {
    const { tools } = await t.client.listTools();
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    assert.ok(byName.echo, "echo listed");
    assert.equal(byName.echo.description, "Echo the text back.");
    assert.deepEqual(byName.echo.inputSchema.required, ["text"]);
    assert.equal(byName.echo.annotations.readOnlyHint, true);
    assert.ok(byName.chrome_style, "navigator.modelContext registration listed");
    assert.ok(byName.webmcp_status && byName.webmcp_navigate, "meta tools listed");

    const sanitised = tools.find((tool) => tool.description === "Needs a sanitised MCP name.");
    assert.equal(sanitised.name, "my_tool_with_spaces");
    assert.equal(sanitised.inputSchema.type, "object", "schema without type is normalised");
    assert.equal(byName.content_tool.annotations, undefined, "no annotations means none");
  } finally {
    await t.close();
  }
});

test("maps raw objects, strings and content arrays onto CallToolResult", async () => {
  const t = await bootAdapter();
  try {
    const raw = await t.client.callTool({ name: "echo", arguments: { text: "hi" } });
    assert.deepEqual(raw.structuredContent, { echoed: "hi", at: 1 });
    assert.equal(raw.content[0].type, "text");
    assert.match(raw.content[0].text, /"echoed": "hi"/);

    const passthrough = await t.client.callTool({ name: "content_tool", arguments: {} });
    assert.equal(passthrough.content[0].text, "from content_tool");
    assert.deepEqual(passthrough.structuredContent, { ok: true });

    const text = await t.client.callTool({ name: "my_tool_with_spaces", arguments: { n: 4 } });
    assert.equal(text.content[0].text, "n is 4");
  } finally {
    await t.close();
  }
});

test("a throwing execute becomes an isError result, not a protocol error", async () => {
  const t = await bootAdapter();
  try {
    const result = await t.client.callTool({ name: "boom", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /kaboom/);

    const unknown = await t.client.callTool({ name: "never_registered", arguments: {} });
    assert.equal(unknown.isError, true);
    assert.match(unknown.content[0].text, /^(stale tool|unknown tool): never_registered/);
  } finally {
    await t.close();
  }
});

test("signal abort and unregisterTool both revoke and notify list_changed", async () => {
  const t = await bootAdapter();
  try {
    let seen = t.listChanged.length;
    await t.session.page.evaluate(() => window.revokeEphemeral());
    await t.waitForListChanged(seen);
    let names = (await t.client.listTools()).tools.map((tool) => tool.name);
    assert.ok(!names.includes("ephemeral"), "ephemeral revoked");
    const stale = await t.client.callTool({ name: "ephemeral", arguments: {} });
    assert.equal(stale.isError, true);
    assert.match(stale.content[0].text, /stale tool/);

    seen = t.listChanged.length;
    await t.session.page.evaluate(() => window.unregisterChromeStyle());
    await t.waitForListChanged(seen);
    names = (await t.client.listTools()).tools.map((tool) => tool.name);
    assert.ok(!names.includes("chrome_style"), "chrome_style unregistered");

    seen = t.listChanged.length;
    await t.session.page.evaluate(() => window.registerLate());
    await t.waitForListChanged(seen);
    names = (await t.client.listTools()).tools.map((tool) => tool.name);
    assert.ok(names.includes("late"), "late registration appears");

    const count = await t.session.page.evaluate(() => window.toolchangeCount);
    assert.equal(count, 3, "page saw a toolchange event per change");
  } finally {
    await t.close();
  }
});

test("call timeout aborts the page-side execution", async () => {
  const t = await bootAdapter({ session: { callTimeoutMs: 200 } });
  try {
    const result = await t.client.callTool({ name: "slow", arguments: { ms: 5000 } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /timed out/);
    const quick = await t.client.callTool({ name: "slow", arguments: { ms: 20 } });
    assert.deepEqual(quick.structuredContent, { slept: 20 });
  } finally {
    await t.close();
  }
});

test("navigation replaces the tool list and webmcp_status reports the page", async () => {
  const t = await bootAdapter();
  try {
    const seen = t.listChanged.length;
    const nav = await t.client.callTool({ name: "webmcp_navigate", arguments: { url: `${t.url}page2.html` } });
    assert.equal(nav.isError, undefined);
    await t.waitForListChanged(seen);
    await t.session.page.waitForFunction(() => window.__webmcpBridge.list().length > 0);

    const names = (await t.client.listTools()).tools.map((tool) => tool.name);
    assert.ok(names.includes("other_tool"));
    assert.ok(!names.includes("echo"));

    const status = await t.client.callTool({ name: "webmcp_status", arguments: {} });
    assert.equal(status.structuredContent.mode, "polyfill");
    assert.equal(status.structuredContent.title, "Second fixture");
    assert.deepEqual(status.structuredContent.tools, ["other_tool"]);
  } finally {
    await t.close();
  }
});

test("--no-meta-tools hides the built-ins", async () => {
  const t = await bootAdapter({ server: { metaTools: false } });
  try {
    const names = (await t.client.listTools()).tools.map((tool) => tool.name);
    assert.ok(!names.includes("webmcp_status"));
  } finally {
    await t.close();
  }
});
