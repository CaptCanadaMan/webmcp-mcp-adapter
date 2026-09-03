// Page-side WebMCP polyfill plus the host bridge the adapter drives.
//
// Injected with Playwright's addInitScript so `modelContext` exists before any
// page script evaluates. It is serialised by Playwright, so it must stay fully
// self-contained: no imports, no references to module scope.
//
// Two dialects of the API exist in the wild and both are honoured:
//   - webmachinelearning explainer: document.modelContext.registerTool(tool, { signal })
//     revoked by aborting the signal; host side getTools() / executeTool() / "toolchange".
//   - Chrome 146 early preview: navigator.modelContext.registerTool(tool) / unregisterTool(name).
// The same object is installed at both locations.
//
// Host bridge (used by src/browser.js via page.evaluate):
//   window.__webmcpBridge.mode                      "polyfill" | "native" | "native-unsupported"
//   window.__webmcpBridge.list()                    -> RegisteredTool[] (active only)
//   window.__webmcpBridge.call(callId, name, args)  -> Promise<result>
//   window.__webmcpBridge.cancel(callId)            -> boolean
// Registration changes call window.__webmcpBridgeEvent({ kind, name }) when the
// adapter has exposed that binding.

export function installWebMcpPolyfill(config) {
  const nativeMode = Boolean(config && config.nativeMode);

  const emit = (event) => {
    const binding = window.__webmcpBridgeEvent;
    if (typeof binding === "function") {
      try {
        binding(event);
      } catch {
        // The binding is best-effort; the page must never see its failure.
      }
    }
  };

  const publicToolShape = (entry) => ({
    name: entry.name,
    description: entry.description,
    inputSchema: entry.inputSchema,
    annotations: entry.annotations,
  });

  // ---------------------------------------------------------------------
  // Native mode: leave the browser's own implementation in place and bridge
  // to it if it offers the explainer's host surface.
  // ---------------------------------------------------------------------
  const existing =
    (typeof document !== "undefined" && document.modelContext) ||
    (typeof navigator !== "undefined" && navigator.modelContext) ||
    null;

  if (nativeMode && existing) {
    const inFlight = new Map();
    const supported = typeof existing.getTools === "function" && typeof existing.executeTool === "function";
    if (supported && typeof existing.addEventListener === "function") {
      existing.addEventListener("toolchange", () => emit({ kind: "changed", name: null }));
    }
    window.__webmcpBridge = {
      mode: supported ? "native" : "native-unsupported",
      async list() {
        if (!supported) {
          throw new Error("native modelContext has no getTools(); run without --native");
        }
        const tools = await existing.getTools();
        return tools.map(publicToolShape);
      },
      async call(callId, name, args) {
        if (!supported) {
          throw new Error("native modelContext has no executeTool(); run without --native");
        }
        const tools = await existing.getTools();
        const tool = tools.find((candidate) => candidate.name === name);
        if (!tool) {
          throw new Error(`stale tool: ${name}`);
        }
        const controller = new AbortController();
        inFlight.set(callId, controller);
        try {
          return await existing.executeTool(tool, args, { signal: controller.signal });
        } finally {
          inFlight.delete(callId);
        }
      },
      cancel(callId) {
        const controller = inFlight.get(callId);
        if (!controller) return false;
        controller.abort();
        return true;
      },
    };
    return;
  }

  // ---------------------------------------------------------------------
  // Polyfill mode.
  // ---------------------------------------------------------------------
  /** name -> { name, description, inputSchema, annotations, execute, revoked } */
  const registry = new Map();
  /** callId -> AbortController */
  const inFlight = new Map();

  class ModelContext extends EventTarget {
    constructor() {
      super();
      this.ontoolchange = null;
    }

    #changed(kind, name) {
      const event = new Event("toolchange");
      this.dispatchEvent(event);
      if (typeof this.ontoolchange === "function") {
        try {
          this.ontoolchange(event);
        } catch {
          // page handler errors are the page's problem
        }
      }
      emit({ kind, name });
    }

    #revoke(entry) {
      if (registry.get(entry.name) !== entry || entry.revoked) return;
      entry.revoked = true;
      registry.delete(entry.name);
      this.#changed("revoked", entry.name);
    }

    registerTool(tool, options) {
      if (!tool || typeof tool.name !== "string" || tool.name.length === 0) {
        return Promise.reject(new TypeError("registerTool: tool.name must be a non-empty string"));
      }
      if (typeof tool.execute !== "function") {
        return Promise.reject(new TypeError("registerTool: tool.execute must be a function"));
      }
      const signal = options && options.signal;
      if (signal && typeof signal.aborted === "boolean" && signal.aborted) {
        return Promise.resolve();
      }
      const entry = {
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : "",
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
        execute: tool.execute,
        revoked: false,
      };
      registry.set(tool.name, entry);
      if (signal && typeof signal.addEventListener === "function") {
        signal.addEventListener("abort", () => this.#revoke(entry), { once: true });
      }
      this.#changed("registered", tool.name);
      return Promise.resolve();
    }

    unregisterTool(name) {
      const entry = registry.get(name);
      if (entry) this.#revoke(entry);
      return Promise.resolve();
    }

    getTools() {
      return Promise.resolve([...registry.values()].map(publicToolShape));
    }

    executeTool(toolOrName, args, options) {
      const name = typeof toolOrName === "string" ? toolOrName : toolOrName && toolOrName.name;
      const entry = registry.get(name);
      if (!entry) {
        return Promise.reject(new Error(`stale tool: ${name}`));
      }
      const signal = (options && options.signal) || new AbortController().signal;
      return Promise.resolve().then(() => entry.execute(args === undefined ? {} : args, { signal }));
    }
  }

  const modelContext = new ModelContext();
  const install = (target) => {
    try {
      Object.defineProperty(target, "modelContext", {
        value: modelContext,
        configurable: true,
        writable: true,
        enumerable: true,
      });
    } catch {
      target.modelContext = modelContext;
    }
  };
  if (typeof document !== "undefined") install(document);
  if (typeof navigator !== "undefined") install(navigator);

  window.__webmcpBridge = {
    mode: "polyfill",
    list() {
      return [...registry.values()].map(publicToolShape);
    },
    async call(callId, name, args) {
      const entry = registry.get(name);
      if (!entry) {
        throw new Error(`stale tool: ${name}`);
      }
      const controller = new AbortController();
      inFlight.set(callId, controller);
      try {
        return await entry.execute(args === undefined ? {} : args, { signal: controller.signal });
      } finally {
        inFlight.delete(callId);
      }
    },
    cancel(callId) {
      const controller = inFlight.get(callId);
      if (!controller) return false;
      controller.abort();
      return true;
    },
  };
}
