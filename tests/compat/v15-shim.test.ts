import { describe, expect, it } from "vitest";
import {
  DM_CHANNEL_TYPE,
  V15_EVENT_MAP,
  V15_TYPE_RENAMES,
  ephemeralFlag,
  extractFocusedValue,
  getV15TypeName,
  isDMChannel,
  isInteractionMessage,
  mapEventName,
} from "../../src/compat/v15-shim.js";

describe("v15-shim", () => {
  describe("isInteractionMessage", () => {
    it("should return true when message has interaction property (v14)", () => {
      const message = { interaction: { id: "123", type: 2 } } as any;
      expect(isInteractionMessage(message)).toBe(true);
    });

    it("should return true when message has interactionMetadata property (v15)", () => {
      const message = { interactionMetadata: { user: {}, type: 2 } } as any;
      expect(isInteractionMessage(message)).toBe(true);
    });

    it("should return false when message has neither property", () => {
      const message = {} as any;
      expect(isInteractionMessage(message)).toBe(false);
    });

    it("should return false when interaction is null", () => {
      const message = { interaction: null } as any;
      expect(isInteractionMessage(message)).toBe(false);
    });

    it("should return false when interactionMetadata is null", () => {
      const message = { interactionMetadata: null } as any;
      expect(isInteractionMessage(message)).toBe(false);
    });

    it("should prefer interactionMetadata when both exist", () => {
      const message = {
        interactionMetadata: { user: {}, type: 2 },
        interaction: { id: "123", type: 2 },
      } as any;
      expect(isInteractionMessage(message)).toBe(true);
    });
  });

  describe("isDMChannel", () => {
    it("should return true for DM channel type (1)", () => {
      expect(isDMChannel(1)).toBe(true);
    });

    it("should return false for guild text channel type (0)", () => {
      expect(isDMChannel(0)).toBe(false);
    });

    it("should return false for other channel types", () => {
      expect(isDMChannel(2)).toBe(false);
      expect(isDMChannel(4)).toBe(false);
      expect(isDMChannel(13)).toBe(false);
    });
  });

  describe("DM_CHANNEL_TYPE", () => {
    it("should equal 1 (ChannelType.DM)", () => {
      expect(DM_CHANNEL_TYPE).toBe(1);
    });
  });

  describe("V15_EVENT_MAP", () => {
    it("should map ready to clientReady", () => {
      expect(V15_EVENT_MAP.ready).toBe("clientReady");
    });

    it("should map webhookUpdate to webhooksUpdate", () => {
      expect(V15_EVENT_MAP.webhookUpdate).toBe("webhooksUpdate");
    });

    it("should mark shard events as removed", () => {
      expect(V15_EVENT_MAP.shardDisconnect).toBe("__removed__");
      expect(V15_EVENT_MAP.shardError).toBe("__removed__");
      expect(V15_EVENT_MAP.shardReady).toBe("__removed__");
      expect(V15_EVENT_MAP.shardReconnecting).toBe("__removed__");
      expect(V15_EVENT_MAP.shardResume).toBe("__removed__");
    });
  });

  describe("mapEventName", () => {
    it("should map ready to clientReady", () => {
      expect(mapEventName("ready")).toBe("clientReady");
    });

    it("should map webhookUpdate to webhooksUpdate", () => {
      expect(mapEventName("webhookUpdate")).toBe("webhooksUpdate");
    });

    it("should return unchanged name for unmapped events", () => {
      expect(mapEventName("messageCreate")).toBe("messageCreate");
      expect(mapEventName("interactionCreate")).toBe("interactionCreate");
      expect(mapEventName("typingStart")).toBe("typingStart");
    });

    it("should throw for removed events", () => {
      expect(() => mapEventName("shardDisconnect")).toThrow("removed in discord.js v15");
      expect(() => mapEventName("shardError")).toThrow("removed in discord.js v15");
      expect(() => mapEventName("shardReady")).toThrow("removed in discord.js v15");
    });
  });

  describe("V15_TYPE_RENAMES", () => {
    it("should include common renames", () => {
      expect(V15_TYPE_RENAMES.NewsChannel).toBe("AnnouncementChannel");
      expect(V15_TYPE_RENAMES.ClientEvents).toBe("ClientEventTypes");
      expect(V15_TYPE_RENAMES.SelectMenuBuilder).toBe("StringSelectMenuBuilder");
    });
  });

  describe("getV15TypeName", () => {
    it("should return new name for renamed types", () => {
      expect(getV15TypeName("NewsChannel")).toBe("AnnouncementChannel");
      expect(getV15TypeName("ClientEvents")).toBe("ClientEventTypes");
    });

    it("should return undefined for unchanged types", () => {
      expect(getV15TypeName("Client")).toBeUndefined();
      expect(getV15TypeName("Message")).toBeUndefined();
      expect(getV15TypeName("TextChannel")).toBeUndefined();
    });
  });

  describe("ephemeralFlag", () => {
    it("should return an object with a flags property", () => {
      const result = ephemeralFlag();
      // On v14 MessageFlags.Ephemeral is available, so flags path is taken
      expect(result).toHaveProperty("flags");
      expect((result as { flags: number }).flags).toBe(64);
    });

    it("should return a numeric flags value (not a bigint or string)", () => {
      const result = ephemeralFlag() as { flags: number };
      expect(typeof result.flags).toBe("number");
    });
  });

  describe("extractFocusedValue", () => {
    it("should return string directly when given a string (v14 behavior)", () => {
      expect(extractFocusedValue("test value")).toBe("test value");
    });

    it("should extract .value from object (v15 behavior)", () => {
      const result = { value: "test value", name: "option", type: 3 };
      expect(extractFocusedValue(result)).toBe("test value");
    });

    it("should handle empty string", () => {
      expect(extractFocusedValue("")).toBe("");
    });

    it("should handle object with empty value", () => {
      const result = { value: "", name: "option", type: 3 };
      expect(extractFocusedValue(result)).toBe("");
    });
  });
});
