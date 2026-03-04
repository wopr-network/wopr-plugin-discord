import { describe, it, expect, vi } from "vitest";
import { ComponentType, MessageFlags } from "discord.js";
import { createMockTextChannel, createMockMessage } from "./mocks/discord-client.js";

describe("DiscordMessageUnit with Components v2", () => {
  it("should send v2 payload when useComponentsV2 is true", async () => {
    const channel = createMockTextChannel();
    const sentMsg = createMockMessage({ id: "sent-1", channel, edit: vi.fn().mockResolvedValue(undefined) });
    const replyTo = createMockMessage({ channel, reply: vi.fn().mockResolvedValue(sentMsg) });

    const { DiscordMessageUnit } = await import("../src/message-streaming.js");
    const unit = new DiscordMessageUnit(channel as any, replyTo as any, true, { useComponentsV2: true });
    unit.append("Hello v2");
    const result = await unit.flush();
    expect(result).toBe("ok");

    expect(replyTo.reply).toHaveBeenCalledTimes(1);
    const payload = replyTo.reply.mock.calls[0][0];
    expect(typeof payload).toBe("object");
    expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
    expect(payload.components).toHaveLength(1);
    expect(payload.components[0].toJSON().type).toBe(ComponentType.Container);
  });

  it("should send plain string when useComponentsV2 is false", async () => {
    const channel = createMockTextChannel();
    const sentMsg = createMockMessage({ id: "sent-2", channel, edit: vi.fn().mockResolvedValue(undefined) });
    const replyTo = createMockMessage({ channel, reply: vi.fn().mockResolvedValue(sentMsg) });

    const { DiscordMessageUnit } = await import("../src/message-streaming.js");
    const unit = new DiscordMessageUnit(channel as any, replyTo as any, true, { useComponentsV2: false });
    unit.append("Hello legacy");
    const result = await unit.flush();
    expect(result).toBe("ok");

    const payload = replyTo.reply.mock.calls[0][0];
    expect(typeof payload).toBe("string");
    expect(payload).toBe("Hello legacy");
  });

  it("should edit with v2 payload (no flags) when useComponentsV2 is true", async () => {
    const editMock = vi.fn().mockResolvedValue(undefined);
    const channel = createMockTextChannel();
    const sentMsg = createMockMessage({ id: "sent-3", channel, edit: editMock });
    const replyTo = createMockMessage({ channel, reply: vi.fn().mockResolvedValue(sentMsg) });

    const { DiscordMessageUnit } = await import("../src/message-streaming.js");
    const unit = new DiscordMessageUnit(channel as any, replyTo as any, true, { useComponentsV2: true });
    unit.append("Initial");
    await unit.flush(); // sends initial

    unit.append(" more text");
    await unit.flush(); // edits

    expect(editMock).toHaveBeenCalledTimes(1);
    const editPayload = editMock.mock.calls[0][0];
    expect(typeof editPayload).toBe("object");
    expect(editPayload.components).toHaveLength(1);
    expect(editPayload.components[0].toJSON().type).toBe(ComponentType.Container);
    // No flags on edit
    expect(editPayload.flags).toBeUndefined();
  });
});
