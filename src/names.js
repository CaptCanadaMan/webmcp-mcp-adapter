// WebMCP tool names are free-form strings; MCP clients (and the Claude API)
// expect ^[A-Za-z0-9_-]{1,64}$. The map is stable for the life of a session so
// a page name always resolves to the same MCP name across re-registrations.

const SAFE = /^[A-Za-z0-9_-]{1,64}$/;

export function createNameMap() {
  const pageToSafe = new Map();
  const safeToPage = new Map();

  function sanitise(pageName) {
    let base = pageName.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
    if (base.length === 0) base = "tool";
    return base.slice(0, 64);
  }

  return {
    safeNameFor(pageName) {
      const known = pageToSafe.get(pageName);
      if (known) return known;
      let candidate = SAFE.test(pageName) ? pageName : sanitise(pageName);
      let suffix = 2;
      while (safeToPage.has(candidate) && safeToPage.get(candidate) !== pageName) {
        const tail = `_${suffix}`;
        candidate = `${candidate.slice(0, 64 - tail.length)}${tail}`;
        suffix += 1;
      }
      pageToSafe.set(pageName, candidate);
      safeToPage.set(candidate, pageName);
      return candidate;
    },
    pageNameFor(safeName) {
      return safeToPage.get(safeName);
    },
  };
}
