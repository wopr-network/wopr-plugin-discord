/**
 * Tests for Typing Indicator Manager logic.
 *
 * The typing manager in index.ts handles:
 * - Starting typing indicator on a channel (sendTyping)
 * - Auto-refreshing every 8 seconds (TYPING_REFRESH_MS)
 * - Idle timeout after 5 seconds of no activity (TYPING_IDLE_TIMEOUT_MS)
 * - Force-clearing by sending and deleting an invisible message
 * - Cleaning up all channels on dispose
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockTextChannel, createMockDMChannel } from "./mocks/discord-client.js";

// ---------------------------------------------------------------------------
// Extracted typing manager logic (mirrors src/index.ts implementation)
// ---------------------------------------------------------------------------
interface TypingState {
  interval: ReturnType<typeof setInterval> | null;
  lastActivity: number;
  active: boolean;
}

const TYPING_REFRESH_MS = 8000;
const TYPING_IDLE_TIMEOUT_MS = 5000;

function createTypingManager() {
  const typingStates = new Map<string, TypingState>();

  async function startTyping(channel: any): Promise<void> {
    const channelId = channel.id;
    stopTyping(channelId);

    const state: TypingState = {
      interval: null,
      lastActivity: Date.now(),
      active: true,
    };

    try {
      await channel.sendTyping();
    } catch (_e) {
      return;
    }

    state.interval = setInterval(async () => {
      const now = Date.now();
      const idleTime = now - state.lastActivity;

      if (idleTime > TYPING_IDLE_TIMEOUT_MS) {
        stopTyping(channelId);
        return;
      }

      if (state.active) {
        try {
          await channel.sendTyping();
        } catch (_e) {
          stopTyping(channelId);
        }
      }
    }, TYPING_REFRESH_MS);

    typingStates.set(channelId, state);
  }

  function tickTyping(channelId: string): void {
    const state = typingStates.get(channelId);
    if (state) {
      state.lastActivity = Date.now();
    }
  }

  function stopTyping(channelId: string, channel?: any): void {
    const state = typingStates.get(channelId);
    if (state) {
      state.active = false;
      if (state.interval) {
        clearInterval(state.interval);
        state.interval = null;
      }
      typingStates.delete(channelId);
    }

    if (channel) {
      channel
        .send("\u200b")
        .then((m: any) => m.delete().catch(() => {}))
        .catch(() => {});
    }
  }

  function disposeAll(): void {
    for (const [channelId] of typingStates) {
      stopTyping(channelId);
    }
  }

  function getState(channelId: string): TypingState | undefined {
    return typingStates.get(channelId);
  }

  function getActiveCount(): number {
    return typingStates.size;
  }

  return { startTyping, tickTyping, stopTyping, disposeAll, getState, getActiveCount };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("TypingManager", () => {
  let manager: ReturnType<typeof createTypingManager>;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = createTypingManager();
  });

  afterEach(() => {
    manager.disposeAll();
    vi.useRealTimers();
  });

  // ---- startTyping ----

  it("should call sendTyping on the channel when starting", async () => {
    const channel = createMockTextChannel();
    await manager.startTyping(channel);

    expect(channel.sendTyping).toHaveBeenCalledOnce();
    expect(manager.getState(channel.id)).toBeDefined();
    expect(manager.getState(channel.id)!.active).toBe(true);
  });

  it("should not register state if initial sendTyping throws", async () => {
    const channel = createMockTextChannel({
      sendTyping: vi.fn().mockRejectedValue(new Error("Missing Access")),
    });

    await manager.startTyping(channel);

    expect(manager.getState(channel.id)).toBeUndefined();
    expect(manager.getActiveCount()).toBe(0);
  });

  it("should clean up existing state before starting a new one on the same channel", async () => {
    const channel = createMockTextChannel();

    await manager.startTyping(channel);
    const firstState = manager.getState(channel.id);
    expect(firstState).toBeDefined();

    await manager.startTyping(channel);
    const secondState = manager.getState(channel.id);
    expect(secondState).toBeDefined();
    // Only one active state per channel
    expect(manager.getActiveCount()).toBe(1);
  });

  // ---- 8s refresh interval ----

  it("should refresh typing indicator every 8 seconds", async () => {
    const channel = createMockTextChannel();
    await manager.startTyping(channel);

    expect(channel.sendTyping).toHaveBeenCalledTimes(1);

    // First interval: tick at 4s to stay within 5s idle window, then advance to 8s
    await vi.advanceTimersByTimeAsync(4000);
    manager.tickTyping(channel.id);
    await vi.advanceTimersByTimeAsync(4000); // total: 8s, interval fires

    expect(channel.sendTyping).toHaveBeenCalledTimes(2);

    // Second interval: tick at 12s (4s after first fire) to stay within idle window
    await vi.advanceTimersByTimeAsync(4000); // total: 12s
    manager.tickTyping(channel.id);
    await vi.advanceTimersByTimeAsync(4000); // total: 16s, interval fires

    expect(channel.sendTyping).toHaveBeenCalledTimes(3);
  });

  // ---- 5s idle timeout ----

  it("should stop typing after 5s of no activity (idle timeout)", async () => {
    const channel = createMockTextChannel();
    await manager.startTyping(channel);

    expect(manager.getState(channel.id)).toBeDefined();

    // Don't tick - let it go idle. Advance past the idle timeout + one refresh cycle.
    await vi.advanceTimersByTimeAsync(TYPING_REFRESH_MS);

    // The interval callback should have detected idle and stopped
    expect(manager.getState(channel.id)).toBeUndefined();
  });

  it("should not idle-timeout if tickTyping is called regularly", async () => {
    const channel = createMockTextChannel();
    await manager.startTyping(channel);

    // Tick every 4 seconds (within the 5s idle window)
    for (let i = 0; i < 5; i++) {
      manager.tickTyping(channel.id);
      await vi.advanceTimersByTimeAsync(4000);
    }

    // Should still be active after 20s total
    expect(manager.getState(channel.id)).toBeDefined();
    expect(manager.getState(channel.id)!.active).toBe(true);
  });

  // ---- force-clear via invisible message ----

  it("should force-clear typing by sending and deleting an invisible message", async () => {
    const deleteFn = vi.fn().mockResolvedValue(undefined);
    const sentMessage = { delete: deleteFn };
    const channel = createMockTextChannel({
      send: vi.fn().mockResolvedValue(sentMessage),
    });

    await manager.startTyping(channel);
    manager.stopTyping(channel.id, channel);

    expect(channel.send).toHaveBeenCalledWith("\u200b");
    // Wait for the microtask to resolve
    await vi.advanceTimersByTimeAsync(0);
    expect(deleteFn).toHaveBeenCalled();
  });

  it("should not send invisible message if no channel is passed to stopTyping", async () => {
    const channel = createMockTextChannel();
    await manager.startTyping(channel);

    // Reset send mock to track only post-start calls
    channel.send.mockClear();
    manager.stopTyping(channel.id);

    expect(channel.send).not.toHaveBeenCalled();
  });

  // ---- stopTyping on sendTyping failure during refresh ----

  it("should stop typing if sendTyping fails during refresh", async () => {
    const channel = createMockTextChannel();
    await manager.startTyping(channel);

    // Make subsequent sendTyping calls fail
    channel.sendTyping.mockRejectedValue(new Error("Channel deleted"));
    manager.tickTyping(channel.id);
    await vi.advanceTimersByTimeAsync(TYPING_REFRESH_MS);

    expect(manager.getState(channel.id)).toBeUndefined();
  });

  // ---- disposeAll ----

  it("should clear all channels on disposeAll", async () => {
    const channel1 = createMockTextChannel({ id: "ch-1" });
    const channel2 = createMockTextChannel({ id: "ch-2" });
    const channel3 = createMockDMChannel({ id: "dm-1" });

    await manager.startTyping(channel1);
    await manager.startTyping(channel2);
    await manager.startTyping(channel3);

    expect(manager.getActiveCount()).toBe(3);

    manager.disposeAll();

    expect(manager.getActiveCount()).toBe(0);
    expect(manager.getState("ch-1")).toBeUndefined();
    expect(manager.getState("ch-2")).toBeUndefined();
    expect(manager.getState("dm-1")).toBeUndefined();
  });

  // ---- works with different channel types ----

  it("should work with DM channels", async () => {
    const channel = createMockDMChannel();
    await manager.startTyping(channel);

    expect(channel.sendTyping).toHaveBeenCalledOnce();
    expect(manager.getState(channel.id)).toBeDefined();
  });
});
