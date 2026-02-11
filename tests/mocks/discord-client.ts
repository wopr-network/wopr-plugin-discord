/**
 * Mock Discord.js objects for testing wopr-plugin-discord.
 *
 * Provides lightweight fakes of Client, Message, TextChannel, DMChannel,
 * ThreadChannel, Guild, GuildMember, User, and ChatInputCommandInteraction.
 */
import { vi } from "vitest";

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------
export function createMockUser(overrides: Record<string, any> = {}) {
  return {
    id: overrides.id ?? "user-123",
    username: overrides.username ?? "TestUser",
    displayName: overrides.displayName ?? "Test User",
    bot: overrides.bot ?? false,
    tag: overrides.tag ?? "TestUser#0001",
    send: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// GuildMember
// ---------------------------------------------------------------------------
export function createMockGuildMember(overrides: Record<string, any> = {}) {
  const user = overrides.user ?? createMockUser();
  return {
    id: user.id,
    user,
    displayName: overrides.displayName ?? user.displayName ?? user.username,
    guild: overrides.guild ?? null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Guild
// ---------------------------------------------------------------------------
export function createMockGuild(overrides: Record<string, any> = {}) {
  const members = new Map<string, any>();
  return {
    id: overrides.id ?? "guild-123",
    name: overrides.name ?? "Test Guild",
    members: {
      cache: members,
      get: (id: string) => members.get(id),
      ...overrides.members,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// TextChannel
// ---------------------------------------------------------------------------
export function createMockTextChannel(overrides: Record<string, any> = {}) {
  const guild = overrides.guild ?? createMockGuild();
  return {
    id: overrides.id ?? "channel-123",
    name: overrides.name ?? "general",
    type: 0, // ChannelType.GuildText
    guild,
    guildId: guild.id,
    send: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    isTextBased: () => true,
    isDMBased: () => false,
    isThread: () => false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// DMChannel
// ---------------------------------------------------------------------------
export function createMockDMChannel(overrides: Record<string, any> = {}) {
  const recipient = overrides.recipient ?? createMockUser();
  return {
    id: overrides.id ?? "dm-channel-123",
    type: 1, // ChannelType.DM
    recipient,
    send: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    isTextBased: () => true,
    isDMBased: () => true,
    isThread: () => false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ThreadChannel
// ---------------------------------------------------------------------------
export function createMockThreadChannel(overrides: Record<string, any> = {}) {
  const guild = overrides.guild ?? createMockGuild();
  const parent = overrides.parent ?? createMockTextChannel({ guild });
  return {
    id: overrides.id ?? "thread-123",
    name: overrides.name ?? "test-thread",
    type: 11, // ChannelType.PublicThread
    guild,
    guildId: guild.id,
    parent,
    parentId: parent.id,
    send: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    isTextBased: () => true,
    isDMBased: () => false,
    isThread: () => true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------
export function createMockMessage(overrides: Record<string, any> = {}) {
  const author = overrides.author ?? createMockUser();
  const channel = overrides.channel ?? createMockTextChannel();
  const guild = overrides.guild ?? channel.guild ?? createMockGuild();
  return {
    id: overrides.id ?? "msg-123",
    content: overrides.content ?? "Hello, WOPR!",
    author,
    channel,
    guild,
    guildId: guild?.id,
    mentions: {
      users: new Map(),
      channels: new Map(),
      roles: new Map(),
      ...overrides.mentions,
    },
    reply: vi.fn().mockResolvedValue(undefined),
    react: vi.fn().mockResolvedValue(undefined),
    attachments: new Map(),
    reference: overrides.reference ?? null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ChatInputCommandInteraction
// ---------------------------------------------------------------------------
export function createMockInteraction(overrides: Record<string, any> = {}) {
  const user = overrides.user ?? createMockUser();
  const channel = overrides.channel ?? createMockTextChannel();
  const guild = overrides.guild ?? channel.guild ?? createMockGuild();
  const optionsData: Record<string, any> = overrides.optionsData ?? {};

  return {
    id: overrides.id ?? "interaction-123",
    commandName: overrides.commandName ?? "help",
    user,
    member: overrides.member ?? createMockGuildMember({ user, guild }),
    channel,
    channelId: channel.id,
    guild,
    guildId: guild?.id,
    options: {
      getString: vi.fn((key: string) => optionsData[key] ?? null),
      getBoolean: vi.fn((key: string) => optionsData[key] ?? null),
      getInteger: vi.fn((key: string) => optionsData[key] ?? null),
      getNumber: vi.fn((key: string) => optionsData[key] ?? null),
      ...overrides.options,
    },
    replied: false,
    deferred: false,
    reply: vi.fn().mockImplementation(async function (this: any) {
      this.replied = true;
    }),
    deferReply: vi.fn().mockImplementation(async function (this: any) {
      this.deferred = true;
    }),
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    isCommand: () => true,
    isChatInputCommand: () => true,
    isAutocomplete: () => false,
    isButton: () => false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------
export function createMockClient(overrides: Record<string, any> = {}) {
  const eventHandlers = new Map<string, Function[]>();
  return {
    user: overrides.user ?? { id: "bot-123", username: "WOPRBot", tag: "WOPRBot#0001" },
    channels: {
      cache: new Map<string, any>(),
      fetch: vi.fn().mockResolvedValue(null),
      ...overrides.channels,
    },
    guilds: {
      cache: new Map<string, any>(),
      ...overrides.guilds,
    },
    login: vi.fn().mockResolvedValue("mock-token"),
    destroy: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((event: string, handler: Function) => {
      if (!eventHandlers.has(event)) eventHandlers.set(event, []);
      eventHandlers.get(event)!.push(handler);
    }),
    once: vi.fn((event: string, handler: Function) => {
      if (!eventHandlers.has(event)) eventHandlers.set(event, []);
      eventHandlers.get(event)!.push(handler);
    }),
    off: vi.fn(),
    emit: vi.fn((event: string, ...args: any[]) => {
      const handlers = eventHandlers.get(event) || [];
      for (const h of handlers) h(...args);
    }),
    removeAllListeners: vi.fn(),
    isReady: () => true,
    application: { id: "app-123" },
    // Expose for test inspection
    _eventHandlers: eventHandlers,
    ...overrides,
  };
}
