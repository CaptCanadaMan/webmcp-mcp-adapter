import { test } from "node:test";
import assert from "node:assert/strict";
import { createNameMap } from "../src/names.js";
import { normaliseInputSchema, toCallResult } from "../src/server.js";

test("name map sanitises, de-duplicates and stays stable", () => {
  const names = createNameMap();
  assert.equal(names.safeNameFor("get_snapshot"), "get_snapshot");
  assert.equal(names.safeNameFor("my tool/with.spaces"), "my_tool_with_spaces");
  assert.equal(names.safeNameFor("my tool with spaces"), "my_tool_with_spaces_2");
  assert.equal(names.safeNameFor("my tool/with.spaces"), "my_tool_with_spaces");
  assert.equal(names.pageNameFor("my_tool_with_spaces_2"), "my tool with spaces");
  assert.equal(names.safeNameFor("///"), "tool");
  assert.equal(names.safeNameFor("x".repeat(80)).length, 64);
});

test("schema normalisation always yields an object schema", () => {
  assert.deepEqual(normaliseInputSchema(undefined), { type: "object", properties: {} });
  assert.deepEqual(normaliseInputSchema({ properties: { a: {} } }), { type: "object", properties: { a: {} } });
  assert.equal(normaliseInputSchema({ type: "string" }).properties.value.type, "string");
});

test("call result mapping", () => {
  assert.deepEqual(toCallResult(undefined).content[0].text, "(tool returned no result)");
  assert.deepEqual(toCallResult("plain").content, [{ type: "text", text: "plain" }]);
  assert.equal(toCallResult([1, 2]).structuredContent, undefined);
  assert.deepEqual(toCallResult({ a: 1 }).structuredContent, { a: 1 });
  assert.equal(toCallResult({ content: [], isError: true }).isError, true);
});
