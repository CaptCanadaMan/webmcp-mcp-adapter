// Serves the fixture pages through Playwright request interception so the
// tests never open a TCP port.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_ORIGIN = "http://webmcp.fixture";

export async function installFixtureRoutes(page) {
  await page.route(`${FIXTURE_ORIGIN}/**`, async (route) => {
    const { pathname } = new URL(route.request().url());
    const file = pathname === "/" ? "index.html" : pathname.slice(1);
    try {
      const body = await readFile(path.join(ROOT, file));
      await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body });
    } catch {
      await route.fulfill({ status: 404, body: "not found" });
    }
  });
}
