import { describe, it, expect } from "vitest";
import plugin from "../src/index.js";

describe("plugin smoke test", () => {
  it("exports a WOPRPlugin default", () => {
    expect(plugin).toBeDefined();
    expect(plugin.manifest).toBeDefined();
    expect(plugin.manifest.name).toBe("wopr-plugin-discord");
    expect(plugin.manifest.version).toBeDefined();
    expect(typeof plugin.init).toBe("function");
    expect(typeof plugin.shutdown).toBe("function");
  });
});
