import { vi } from "vitest";
import type { WOPRPluginContext } from "../types.js";

/**
 * Create a minimal mock Discord Message object.
 */
export function createMockMessage(
  overrides: {
    id?: string;
    content?: string;
    authorId?: string;
    authorUsername?: string;
    authorBot?: boolean;
    channelId?: string;
    channelType?: number;
    guildName?: string;
    channelName?: string;
    mentionedUserIds?: string[];
  } = {},
) {
  const channelId = overrides.channelId ?? "ch-1";
  const authorId = overrides.authorId ?? "user-1";
  const mentionedIds = overrides.mentionedUserIds ?? [];

  const message: any = {
    id: overrides.id ?? "msg-1",
    content: overrides.content ?? "Hello",
    author: {
      id: authorId,
      username: overrides.authorUsername ?? "testuser",
      bot: overrides.authorBot ?? false,
      displayName: overrides.authorUsername ?? "testuser",
      tag: `${overrides.authorUsername ?? "testuser"}#0001`,
      send: vi.fn().mockResolvedValue(undefined),
    },
    member: {
      displayName: overrides.authorUsername ?? "testuser",
    },
    channel: createMockChannel({
      id: channelId,
      type: overrides.channelType ?? 0,
      name: overrides.channelName ?? "general",
      guildName: overrides.guildName ?? "test-guild",
    }),
    channelId,
    guild: {
      name: overrides.guildName ?? "test-guild",
      members: { me: { displayName: "WOPR" }, cache: { get: vi.fn() } },
    },
    mentions: {
      users: new Map(mentionedIds.map((uid) => [uid, { id: uid, username: "bot", displayName: "bot" }])),
      channels: new Map(),
      roles: new Map(),
    },
    attachments: new Map(),
    interaction: null,
    reply: vi.fn().mockResolvedValue({ id: "reply-1", edit: vi.fn(), delete: vi.fn() }),
    react: vi.fn().mockResolvedValue(undefined),
    reactions: {
      cache: new Map(),
    },
  };
  return message;
}

/**
 * Create a minimal mock Discord TextChannel.
 */
export function createMockChannel(overrides: { id?: string; name?: string; type?: number; guildName?: string } = {}) {
  const channel: any = {
    id: overrides.id ?? "ch-1",
    name: overrides.name ?? "general",
    type: overrides.type ?? 0,
    guild: { name: overrides.guildName ?? "test-guild" },
    send: vi.fn().mockResolvedValue({
      id: "sent-1",
      edit: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    }),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    isTextBased: () => true,
    isDMBased: () => (overrides.type ?? 0) === 1,
    isThread: () => false,
  };
  return channel;
}

/**
 * Create a minimal mock Discord Client.
 */
export function createMockClient(overrides: { userId?: string; username?: string } = {}) {
  const client: any = {
    user: {
      id: overrides.userId ?? "bot-1",
      username: overrides.username ?? "WOPR",
    },
    channels: {
      fetch: vi.fn().mockResolvedValue(createMockChannel()),
    },
    guilds: {
      cache: new Map(),
    },
    users: {
      fetch: vi.fn().mockResolvedValue({ username: "resolved-user" }),
    },
  };
  return client;
}

/**
 * Create a minimal mock WOPRPluginContext.
 */
export function createMockContext(
  overrides: {
    injectResult?: string;
    injectError?: Error;
    providers?: Record<string, { supportedModels: string[] }>;
    cancelInjectResult?: boolean;
  } = {},
): WOPRPluginContext {
  const events = {
    on: vi.fn().mockReturnValue(vi.fn()),
    once: vi.fn(),
    off: vi.fn(),
    emit: vi.fn().mockResolvedValue(undefined),
    emitCustom: vi.fn().mockResolvedValue(undefined),
    listenerCount: vi.fn().mockReturnValue(0),
  };

  const ctx: any = {
    inject: overrides.injectError
      ? vi.fn().mockRejectedValue(overrides.injectError)
      : vi.fn().mockResolvedValue(overrides.injectResult ?? "AI response"),
    logMessage: vi.fn(),
    getAgentIdentity: vi.fn().mockResolvedValue({ name: "WOPR", emoji: "👀" }),
    getUserProfile: vi.fn().mockResolvedValue({ name: "Test User" }),
    getSessions: vi.fn().mockReturnValue([]),
    cancelInject: vi.fn().mockReturnValue(overrides.cancelInjectResult ?? false),
    events,
    hooks: {
      on: vi.fn(),
      off: vi.fn(),
      offByName: vi.fn(),
      list: vi.fn().mockReturnValue([]),
    },
    registerContextProvider: vi.fn(),
    unregisterContextProvider: vi.fn(),
    getContextProvider: vi.fn(),
    registerChannel: vi.fn(),
    unregisterChannel: vi.fn(),
    getChannel: vi.fn(),
    getChannels: vi.fn().mockReturnValue([]),
    getChannelsForSession: vi.fn().mockReturnValue([]),
    registerWebUiExtension: vi.fn(),
    unregisterWebUiExtension: vi.fn(),
    getWebUiExtensions: vi.fn().mockReturnValue([]),
    registerUiComponent: vi.fn(),
    unregisterUiComponent: vi.fn(),
    getUiComponents: vi.fn().mockReturnValue([]),
    getConfig: vi.fn().mockReturnValue({}),
    saveConfig: vi.fn().mockResolvedValue(undefined),
    getMainConfig: vi.fn(),
    registerLLMProvider: vi.fn(),
    unregisterLLMProvider: vi.fn(),
    getProvider: vi.fn((id: string) => {
      return overrides.providers?.[id] ?? null;
    }),
    registerConfigSchema: vi.fn(),
    unregisterConfigSchema: vi.fn(),
    getConfigSchema: vi.fn(),
    registerExtension: vi.fn(),
    unregisterExtension: vi.fn(),
    getExtension: vi.fn(),
    listExtensions: vi.fn().mockReturnValue([]),
    registerSTTProvider: vi.fn(),
    registerTTSProvider: vi.fn(),
    getSTT: vi.fn(),
    getTTS: vi.fn(),
    hasVoice: vi.fn().mockReturnValue({ stt: false, tts: false }),
    registerChannelProvider: vi.fn(),
    unregisterChannelProvider: vi.fn(),
    getChannelProvider: vi.fn(),
    getChannelProviders: vi.fn().mockReturnValue([]),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    storage: { getTable: vi.fn(), listTables: vi.fn() },
    session: {
      getContext: vi.fn().mockResolvedValue(null),
      setContext: vi.fn().mockResolvedValue(undefined),
      readConversationLog: vi.fn().mockResolvedValue([]),
    },
    getPluginDir: vi.fn().mockReturnValue("/tmp/test-plugin"),
  };
  return ctx;
}

/**
 * Create a mock ChatInputCommandInteraction for slash command testing.
 */
export function createMockInteraction(
  overrides: {
    commandName?: string;
    channelId?: string;
    channelType?: number;
    userId?: string;
    username?: string;
    options?: Record<string, any>;
  } = {},
) {
  const optionValues = overrides.options ?? {};
  const interaction: any = {
    commandName: overrides.commandName ?? "help",
    channelId: overrides.channelId ?? "ch-1",
    channel: {
      id: overrides.channelId ?? "ch-1",
      type: overrides.channelType ?? 0,
      name: "general",
      guild: { name: "test-guild" },
      isDMBased: () => (overrides.channelType ?? 0) === 1,
      isThread: () => false,
    },
    user: {
      id: overrides.userId ?? "user-1",
      username: overrides.username ?? "testuser",
      tag: `${overrides.username ?? "testuser"}#0001`,
    },
    options: {
      getString: vi.fn((name: string, _required?: boolean) => optionValues[name] ?? null),
      getBoolean: vi.fn((name: string, _required?: boolean) => optionValues[name] ?? null),
      getFocused: vi.fn(() => optionValues._focused ?? ""),
      data: Object.entries(optionValues)
        .filter(([k]) => !k.startsWith("_"))
        .map(([name, value]) => ({ name, value })),
    },
    reply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
    respond: vi.fn().mockResolvedValue(undefined),
  };
  return interaction;
}
