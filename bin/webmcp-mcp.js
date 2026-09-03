#!/usr/bin/env node
import { main } from "../src/cli.js";

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`webmcp-mcp: ${error?.stack ?? error}\n`);
  process.exit(1);
});
