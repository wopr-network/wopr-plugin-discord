import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { discordChannelProvider, handleRegisteredCommand, setCommandAuthConfig } from "./channel-provider.js";
import { logger } from "./logger.js";

function createMockMessage(
  overrides: {
    content?: string;
    authorId?: string;
    authorUsername?: string;
    memberRoleIds?: string[];
    memberNull?: boolean;
  } = {},
) {
  const msg: any = {
    content: overrides.content ?? "/test arg1 arg2",
    author: {
      id: overrides.authorId ?? "user-123",
      username: overrides.authorUsername ?? "testuser",
    },
    member: overrides.memberNull
      ? null
      : {
          roles: {
            cache: new Map((overrides.memberRoleIds ?? []).map((id) => [id, { id }])),
          },
        },
    channelId: "ch-1",
    reply: vi.fn().mockResolvedValue(undefined),
  };
  return msg;
}

describe("handleRegisteredCommand", () => {
  beforeEach(() => {
    for (const cmd of discordChannelProvider.getCommands()) {
      discordChannelProvider.unregisterCommand(cmd.name);
    }
    setCommandAuthConfig({ allowedUserIds: [], allowedRoleIds: [] });
    vi.clearAllMocks();
  });

  it("returns false for non-command messages", async () => {
    const msg = createMockMessage({ content: "hello world" });
    expect(await handleRegisteredCommand(msg)).toBe(false);
  });

  it("returns false for unregistered commands", async () => {
    const msg = createMockMessage({ content: "/unknown" });
    expect(await handleRegisteredCommand(msg)).toBe(false);
  });

  it("blocks command when no allowlist is configured (deny-all default)", async () => {
    const handler = vi.fn();
    discordChannelProvider.registerCommand({
      name: "test",
      description: "test cmd",
      handler,
    });
    const msg = createMockMessage({ content: "/test arg1" });

    const result = await handleRegisteredCommand(msg);

    expect(result).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining("not authorized"));
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "Channel command blocked" }));
  });

  it("allows command when user ID is in allowlist", async () => {
    const handler = vi.fn();
    discordChannelProvider.registerCommand({
      name: "test",
      description: "test cmd",
      handler,
    });
    setCommandAuthConfig({ allowedUserIds: ["user-123"], allowedRoleIds: [] });
    const msg = createMockMessage({ content: "/test hello" });

    const result = await handleRegisteredCommand(msg);

    expect(result).toBe(true);
    expect(handler).toHaveBeenCalled();
  });

  it("allows command when user has an allowed role", async () => {
    const handler = vi.fn();
    discordChannelProvider.registerCommand({
      name: "test",
      description: "test cmd",
      handler,
    });
    setCommandAuthConfig({ allowedUserIds: [], allowedRoleIds: ["role-admin"] });
    const msg = createMockMessage({
      content: "/test",
      memberRoleIds: ["role-admin", "role-other"],
    });

    const result = await handleRegisteredCommand(msg);

    expect(result).toBe(true);
    expect(handler).toHaveBeenCalled();
  });

  it("blocks command when user has no matching role", async () => {
    const handler = vi.fn();
    discordChannelProvider.registerCommand({
      name: "test",
      description: "test cmd",
      handler,
    });
    setCommandAuthConfig({ allowedUserIds: [], allowedRoleIds: ["role-admin"] });
    const msg = createMockMessage({
      content: "/test",
      memberRoleIds: ["role-other"],
    });

    const result = await handleRegisteredCommand(msg);

    expect(result).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it("skips role check gracefully when member is null (DM)", async () => {
    const handler = vi.fn();
    discordChannelProvider.registerCommand({
      name: "test",
      description: "test cmd",
      handler,
    });
    setCommandAuthConfig({ allowedUserIds: ["user-123"], allowedRoleIds: [] });
    const msg = createMockMessage({ content: "/test", memberNull: true });

    const result = await handleRegisteredCommand(msg);

    expect(result).toBe(true);
    expect(handler).toHaveBeenCalled();
  });

  it("blocks in DM when only role IDs are configured", async () => {
    const handler = vi.fn();
    discordChannelProvider.registerCommand({
      name: "test",
      description: "test cmd",
      handler,
    });
    setCommandAuthConfig({ allowedUserIds: [], allowedRoleIds: ["role-admin"] });
    const msg = createMockMessage({ content: "/test", memberNull: true });

    const result = await handleRegisteredCommand(msg);

    expect(result).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it("sanitizes args (strips control chars)", async () => {
    const handler = vi.fn();
    discordChannelProvider.registerCommand({
      name: "test",
      description: "test cmd",
      handler,
    });
    setCommandAuthConfig({ allowedUserIds: ["user-123"], allowedRoleIds: [] });
    const msg = createMockMessage({
      content: "/test hel\x00lo wor\x7Fld",
    });

    await handleRegisteredCommand(msg);

    const ctx = handler.mock.calls[0][0];
    expect(ctx.args[0]).toBe("hello");
    expect(ctx.args[1]).toBe("world");
  });

  it("truncates args exceeding 512 characters", async () => {
    const handler = vi.fn();
    discordChannelProvider.registerCommand({
      name: "test",
      description: "test cmd",
      handler,
    });
    setCommandAuthConfig({ allowedUserIds: ["user-123"], allowedRoleIds: [] });
    const longArg = "a".repeat(600);
    const msg = createMockMessage({ content: `/test ${longArg}` });

    await handleRegisteredCommand(msg);

    const ctx = handler.mock.calls[0][0];
    expect(ctx.args[0].length).toBe(512);
  });

  it("filters out args that become empty after sanitization", async () => {
    const handler = vi.fn();
    discordChannelProvider.registerCommand({
      name: "test",
      description: "test cmd",
      handler,
    });
    setCommandAuthConfig({ allowedUserIds: ["user-123"], allowedRoleIds: [] });
    const msg = createMockMessage({
      content: "/test \x00\x01 valid",
    });

    await handleRegisteredCommand(msg);

    const ctx = handler.mock.calls[0][0];
    expect(ctx.args).toEqual(["valid"]);
  });
});
