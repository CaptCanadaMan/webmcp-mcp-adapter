// Playwright session around one page: launches Chromium, injects the polyfill
// (or bridges the native API), and exposes list / call / cancel plus a change
// feed. Site-agnostic: tool names, schemas and results are opaque here.

import { chromium } from "playwright";
import { installWebMcpPolyfill } from "./polyfill.js";

/**
 * @param {{
 *   url: string,
 *   headed?: boolean,
 *   channel?: string,
 *   native?: boolean,
 *   profileDir?: string,
 *   callTimeoutMs?: number,
 *   prepare?: (page: import("playwright").Page) => Promise<void> | void,
 *   log?: (line: string) => void,
 * }} options
 */
/** Strip Playwright's evaluate prefix and the page-side stack from an error. */
function cleanPageError(error) {
  const raw = String(error?.message ?? error);
  const firstLine = raw.split("\n")[0];
  return firstLine.replace(/^page\.evaluate:\s*/, "").replace(/^Error:\s*/, "");
}

export async function openSession(options) {
  const {
    url,
    headed = true,
    channel,
    native = false,
    profileDir,
    callTimeoutMs = 0,
    prepare,
    log = () => {},
  } = options;

  const launchOptions = { headless: !headed, ...(channel ? { channel } : {}) };
  // A headed window follows the real OS window size so the person watching
  // can resize it and see the page reflow; headless keeps a fixed viewport.
  const contextOptions = headed ? { viewport: null } : {};

  let browser = null;
  let context;
  if (profileDir) {
    context = await chromium.launchPersistentContext(profileDir, { ...launchOptions, ...contextOptions });
  } else {
    browser = await chromium.launch(launchOptions);
    context = await browser.newContext(contextOptions);
  }
  const page = context.pages()[0] ?? (await context.newPage());

  const listeners = new Set();
  const notify = (event) => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        log(`change listener failed: ${error?.message ?? error}`);
      }
    }
  };

  await page.exposeBinding("__webmcpBridgeEvent", (_source, event) => {
    notify({ ...event, at: Date.now() });
  });
  await page.addInitScript(installWebMcpPolyfill, { nativeMode: native });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      notify({ kind: "reset", name: null, url: frame.url(), at: Date.now() });
    }
  });
  page.on("console", (message) => {
    if (message.type() === "error") log(`page console.error: ${message.text()}`);
  });
  page.on("pageerror", (error) => log(`page error: ${error.message}`));
  page.on("close", () => notify({ kind: "closed", name: null, at: Date.now() }));

  // Hook for callers that need routes or headers in place before the first
  // navigation (tests serve their fixture through page.route this way).
  if (prepare) await prepare(page);
  await page.goto(url, { waitUntil: "domcontentloaded" });

  let nextCallId = 1;

  return {
    page,

    /** Active tools as the page currently registers them. */
    async list() {
      return page.evaluate(() => window.__webmcpBridge.list());
    },

    /**
     * Invoke a page tool. Resolves with whatever the page's execute returned;
     * rejects when the bridge refuses (stale tool) or execute throws.
     */
    async call(name, args = {}, { signal } = {}) {
      const callId = `call-${nextCallId}`;
      nextCallId += 1;
      const cancelInPage = () => {
        page.evaluate((id) => window.__webmcpBridge.cancel(id), callId).catch(() => {});
      };
      signal?.addEventListener("abort", cancelInPage, { once: true });
      let timer;
      try {
        const execution = page.evaluate(
          ([id, toolName, toolArgs]) => window.__webmcpBridge.call(id, toolName, toolArgs),
          [callId, name, args ?? {}],
        );
        if (callTimeoutMs > 0) {
          const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => {
              cancelInPage();
              reject(new Error(`call timed out after ${callTimeoutMs} ms: ${name}`));
            }, callTimeoutMs);
          });
          return await Promise.race([execution, timeout]);
        }
        return await execution;
      } catch (error) {
        throw new Error(cleanPageError(error));
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancelInPage);
      }
    },

    /** Subscribe to registered / revoked / changed / reset / closed events. */
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async info() {
      const mode = await page
        .evaluate(() => (window.__webmcpBridge ? window.__webmcpBridge.mode : "unavailable"))
        .catch(() => "unavailable");
      return { url: page.url(), title: await page.title().catch(() => ""), mode };
    },

    async navigate(nextUrl) {
      await page.goto(nextUrl, { waitUntil: "domcontentloaded" });
    },

    async close() {
      await context.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
    },
  };
}
