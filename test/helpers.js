import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { openSession } from "../src/browser.js";
import { createAdapterServer } from "../src/server.js";
import { FIXTURE_ORIGIN, installFixtureRoutes } from "./fixture/serve.js";

/** Boot a headless browser session on the fixture page + an in-process MCP client. */
export async function bootAdapter(options = {}) {
  const url = `${FIXTURE_ORIGIN}/`;
  const session = await openSession({ url, headed: false, prepare: installFixtureRoutes, ...options.session });
  await session.page.evaluate(() => window.fixtureReady);

  const adapter = createAdapterServer({ session, listChangedDebounceMs: 20, ...options.server });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const listChanged = [];
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    listChanged.push(Date.now());
  });
  await adapter.server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    url,
    session,
    adapter,
    client,
    listChanged,
    async waitForListChanged(previousCount, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (listChanged.length <= previousCount) {
        if (Date.now() > deadline) throw new Error("no tools/list_changed notification arrived");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    async close() {
      await client.close().catch(() => {});
      await adapter.close();
      await session.close();
    },
  };
}
