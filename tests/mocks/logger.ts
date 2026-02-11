/**
 * Mock winston logger for testing wopr-plugin-discord.
 */
import { vi } from "vitest";

export function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    verbose: vi.fn(),
    silly: vi.fn(),
    log: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}
