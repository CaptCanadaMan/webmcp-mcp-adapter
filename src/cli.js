import { parseArgs } from "node:util";
import { openSession } from "./browser.js";
import { createAdapterServer } from "./server.js";

const USAGE = `Usage: webmcp-mcp --url <page-url> [options]

Serves the page's WebMCP tools as MCP tools over stdio.

Options:
  --url <url>              Page to attach to (required)
  --headless               Run the browser without a window (default: headed)
  --channel <name>         Playwright browser channel: chromium (default), chrome, chrome-canary, msedge
  --native                 Experimental: use the browser's own modelContext when present instead of the polyfill
  --profile-dir <dir>      Persistent browser profile (keeps logins between runs)
  --call-timeout-ms <n>    Abort a tool call after n ms (default: 0, no timeout)
  --no-meta-tools          Do not expose webmcp_status / webmcp_navigate
  --quiet                  Suppress stderr logging
  --help                   Show this help
`;

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        url: { type: "string" },
        headless: { type: "boolean", default: false },
        channel: { type: "string" },
        native: { type: "boolean", default: false },
        "profile-dir": { type: "string" },
        "call-timeout-ms": { type: "string", default: "0" },
        "no-meta-tools": { type: "boolean", default: false },
        quiet: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
      strict: true,
    });
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}`);
    process.exit(2);
  }
  const flags = parsed.values;
  if (flags.help) {
    process.stderr.write(USAGE);
    return;
  }
  if (!flags.url) {
    process.stderr.write(`--url is required\n\n${USAGE}`);
    process.exit(2);
  }
  const callTimeoutMs = Number(flags["call-timeout-ms"]);
  if (!Number.isFinite(callTimeoutMs) || callTimeoutMs < 0) {
    process.stderr.write("--call-timeout-ms must be a non-negative number\n");
    process.exit(2);
  }

  // stdout is the MCP channel; everything human-facing goes to stderr.
  const log = flags.quiet
    ? () => {}
    : (line) => process.stderr.write(`[webmcp-mcp ${new Date().toISOString()}] ${line}\n`);

  // Connect stdio first so the client's initialize round-trip is not held
  // behind the browser launch; tool requests await the session.
  const session = openSession({
    url: flags.url,
    headed: !flags.headless,
    channel: flags.channel,
    native: flags.native,
    profileDir: flags["profile-dir"],
    callTimeoutMs,
    log,
  });
  session
    .then((ready) => ready.info().then((info) => log(`attached to ${info.url} (${info.mode})`)))
    .catch((error) => log(`browser failed to open: ${error?.message ?? error}`));

  const adapter = createAdapterServer({ session, metaTools: !flags["no-meta-tools"], log });
  await adapter.connectStdio();
  log(`serving ${flags.url} over stdio`);

  let closing = false;
  const shutdown = async (reason) => {
    if (closing) return;
    closing = true;
    log(`shutting down (${reason})`);
    await adapter.close();
    try {
      const ready = await session;
      await ready.close();
    } catch {
      // the browser never opened; nothing to close
    }
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.stdin.on("end", () => shutdown("stdin closed"));
  process.stdin.on("close", () => shutdown("stdin closed"));
}
