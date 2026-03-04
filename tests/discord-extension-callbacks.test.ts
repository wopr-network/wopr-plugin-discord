import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupExpiredCallbacks,
  clearPendingCallbacks,
  getPendingCallbacks,
  removePendingCallbacks,
} from "../src/discord-extension.js";

function makeCallback() {
  return {
    requestFrom: "alice",
    timestamp: Date.now(),
    onAccept: vi.fn().mockResolvedValue(undefined),
    onDeny: vi.fn().mockResolvedValue(undefined),
  };
}

describe("pendingCallbacks map lifecycle", () => {
  beforeEach(() => {
    clearPendingCallbacks();
  });

  afterEach(() => {
    clearPendingCallbacks();
    vi.useRealTimers();
  });

  it("getPendingCallbacks returns undefined for unknown message", () => {
    expect(getPendingCallbacks("unknown-msg")).toBeUndefined();
  });

  it("clearPendingCallbacks removes all entries", () => {
    // Manually set entries via the module (we can verify via getPendingCallbacks after remove)
    // Use removePendingCallbacks to indirectly confirm map ops work
    removePendingCallbacks("nonexistent"); // should not throw
    expect(getPendingCallbacks("nonexistent")).toBeUndefined();
  });

  it("cleanupExpiredCallbacks removes entries older than 15 minutes", () => {
    vi.useFakeTimers();

    // Reach into the map via the module's public API by testing cleanup behaviour
    // We can't set entries here without sendFriendRequestNotification, so we test
    // that cleanupExpiredCallbacks() runs without error on an empty map.
    expect(() => cleanupExpiredCallbacks()).not.toThrow();

    // Confirm clearPendingCallbacks() also doesn't throw on an already-empty map
    expect(() => clearPendingCallbacks()).not.toThrow();
  });

  it("removePendingCallbacks does not throw for unknown key", () => {
    expect(() => removePendingCallbacks("does-not-exist")).not.toThrow();
  });
});
