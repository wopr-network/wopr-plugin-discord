/**
 * Mock WOPRPluginContext for testing wopr-plugin-discord.
 */
import { vi } from "vitest";
import type { WOPRPluginContext, WOPREventBus, InjectOptions, LogMessageOptions } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Mock Event Bus
// ---------------------------------------------------------------------------
export function createMockEventBus(overrides: Partial<WOPREventBus> = {}): WOPREventBus {
  const handlers = new Map<string, Function[]>();
  return {
    on: vi.fn((event: string, handler: Function) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
      return () => {
        const list = handlers.get(event);
        if (list) {
          const idx = list.indexOf(handler);
          if (idx >= 0) list.splice(idx, 1);
        }
      };
    }),
    once: vi.fn((event: string, handler: Function) => {
      if (!handlers.has(event)) handlers.set(event, []);
      const wrapper = (...args: any[]) => {
        const list = handlers.get(event);
        if (list) {
          const idx = list.indexOf(wrapper);
          if (idx >= 0) list.splice(idx, 1);
        }
        return handler(...args);
      };
      handlers.get(event)!.push(wrapper);
    }),
    off: vi.fn((event: string, handler: Function) => {
      const list = handlers.get(event);
      if (list) {
        const idx = list.indexOf(handler);
        if (idx >= 0) list.splice(idx, 1);
      }
    }),
    emit: vi.fn(async (event: string, payload: any) => {
      const list = handlers.get(event) || [];
      for (const h of list) await h(payload, { type: event, payload, timestamp: Date.now() });
    }),
    emitCustom: vi.fn(async (event: string, payload: any) => {
      const list = handlers.get(event) || [];
      for (const h of list) await h(payload, { type: event, payload, timestamp: Date.now() });
    }),
    listenerCount: vi.fn((event: string) => (handlers.get(event) || []).length),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock WOPRPluginContext
// ---------------------------------------------------------------------------
export function createMockContext(overrides: Partial<WOPRPluginContext> = {}): WOPRPluginContext {
  const configStore: Record<string, any> = { ...(overrides as any)._configData };

  return {
    inject: vi.fn<[string, string, InjectOptions?], Promise<string>>().mockResolvedValue("Mock response"),
    logMessage: vi.fn<[string, string, LogMessageOptions?], void>(),
    injectPeer: vi.fn<[string, string, string], Promise<string>>().mockResolvedValue("Mock peer response"),
    getIdentity: vi.fn().mockReturnValue({
      publicKey: "mock-public-key",
      shortId: "mock-short-id",
      encryptPub: "mock-encrypt-pub",
    }),
    getAgentIdentity: vi.fn().mockResolvedValue({
      name: "TestAgent",
      creature: "owl",
      vibe: "chill",
      emoji: "🦉",
    }),
    getUserProfile: vi.fn().mockResolvedValue({
      name: "Test User",
      preferredAddress: "test@example.com",
    }),
    getSessions: vi.fn().mockReturnValue([]),
    getPeers: vi.fn().mockReturnValue([]),
    getConfig: vi.fn(() => ({ ...configStore })),
    saveConfig: vi.fn(async (config: any) => {
      Object.assign(configStore, config);
    }),
    getMainConfig: vi.fn().mockReturnValue({}),
    registerConfigSchema: vi.fn(),
    getPluginDir: vi.fn().mockReturnValue("/tmp/wopr-test/plugins/discord"),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    events: createMockEventBus(),
    getProviders: vi.fn().mockResolvedValue([]),
    setSessionProvider: vi.fn().mockResolvedValue(undefined),
    cancelInject: vi.fn().mockReturnValue(false),
    registerChannelProvider: vi.fn(),
    unregisterChannelProvider: vi.fn(),
    registerExtension: vi.fn(),
    unregisterExtension: vi.fn(),
    getExtension: vi.fn().mockReturnValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
    ...overrides,
  };
}
