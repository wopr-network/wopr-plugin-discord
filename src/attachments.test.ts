import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoist mock references so they're available in vi.mock factories
const mocks = vi.hoisted(() => ({
  existsSync: vi.fn().mockReturnValue(false),
  mkdirSync: vi.fn(),
  createWriteStream: vi.fn(),
  pipeline: vi.fn().mockResolvedValue(undefined),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: mocks.existsSync,
  mkdirSync: mocks.mkdirSync,
  createWriteStream: mocks.createWriteStream,
}));

vi.mock("node:stream/promises", () => ({
  pipeline: mocks.pipeline,
}));

vi.mock("./logger.js", () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
  },
}));

import { createMockMessage } from "./__test-utils__/mocks.js";
import { saveAttachments } from "./attachments.js";

describe("saveAttachments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, "now").mockReturnValue(1234567890);
    mocks.existsSync.mockReturnValue(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns empty array when message has no attachments", async () => {
    const msg = createMockMessage();
    const result = await saveAttachments(msg);
    expect(result).toEqual([]);
    expect(mocks.mkdirSync).not.toHaveBeenCalled();
  });

  it("downloads and saves a single attachment", async () => {
    const msg = createMockMessage();
    msg.attachments = new Map([
      [
        "att-1",
        {
          name: "photo.png",
          url: "https://cdn.discord.com/photo.png",
          size: 1024,
          contentType: "image/png",
        },
      ],
    ]);

    const mockBody = { pipe: vi.fn() };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, body: mockBody }));
    mocks.createWriteStream.mockReturnValue({ close: vi.fn() });

    const result = await saveAttachments(msg);

    expect(result).toHaveLength(1);
    expect(result[0]).toContain("1234567890-user-1-photo.png");
    expect(globalThis.fetch).toHaveBeenCalledWith("https://cdn.discord.com/photo.png");
    expect(mocks.createWriteStream).toHaveBeenCalledWith(expect.stringContaining("1234567890-user-1-photo.png"));
    expect(mocks.pipeline).toHaveBeenCalledWith(mockBody, expect.objectContaining({ close: expect.any(Function) }));
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "Attachment saved", filename: expect.stringContaining("photo.png") }),
    );
  });

  it("skips attachment when fetch returns non-ok status (404)", async () => {
    const msg = createMockMessage();
    msg.attachments = new Map([
      [
        "att-1",
        { name: "missing.png", url: "https://cdn.discord.com/missing.png", size: 512, contentType: "image/png" },
      ],
    ]);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    const result = await saveAttachments(msg);

    expect(result).toEqual([]);
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "Failed to download attachment", status: 404 }),
    );
    expect(mocks.pipeline).not.toHaveBeenCalled();
  });

  it("catches network error during fetch and continues", async () => {
    const msg = createMockMessage();
    msg.attachments = new Map([
      ["att-1", { name: "fail.png", url: "https://cdn.discord.com/fail.png", size: 256, contentType: "image/png" }],
    ]);

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const result = await saveAttachments(msg);

    expect(result).toEqual([]);
    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: "Error saving attachment",
        name: "fail.png",
        error: expect.stringContaining("ECONNREFUSED"),
      }),
    );
  });

  it("processes multiple attachments and returns all saved paths", async () => {
    const msg = createMockMessage();
    msg.attachments = new Map([
      ["att-1", { name: "file1.txt", url: "https://cdn.discord.com/file1.txt", size: 100, contentType: "text/plain" }],
      ["att-2", { name: "file2.jpg", url: "https://cdn.discord.com/file2.jpg", size: 200, contentType: "image/jpeg" }],
      [
        "att-3",
        { name: "file3.pdf", url: "https://cdn.discord.com/file3.pdf", size: 300, contentType: "application/pdf" },
      ],
    ]);

    const mockBody = { pipe: vi.fn() };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, body: mockBody }));
    mocks.createWriteStream.mockReturnValue({ close: vi.fn() });

    const result = await saveAttachments(msg);

    expect(result).toHaveLength(3);
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    expect(mocks.pipeline).toHaveBeenCalledTimes(3);
    expect(mocks.loggerInfo).toHaveBeenCalledTimes(3);
  });

  it("saves successful attachments even when one fails mid-batch", async () => {
    const msg = createMockMessage();
    msg.attachments = new Map([
      ["att-1", { name: "good.txt", url: "https://cdn.discord.com/good.txt", size: 100, contentType: "text/plain" }],
      ["att-2", { name: "bad.txt", url: "https://cdn.discord.com/bad.txt", size: 200, contentType: "text/plain" }],
      [
        "att-3",
        { name: "also-good.txt", url: "https://cdn.discord.com/also-good.txt", size: 300, contentType: "text/plain" },
      ],
    ]);

    const mockBody = { pipe: vi.fn() };
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 2) return Promise.resolve({ ok: false, status: 500 });
        return Promise.resolve({ ok: true, body: mockBody });
      }),
    );
    mocks.createWriteStream.mockReturnValue({ close: vi.fn() });

    const result = await saveAttachments(msg);

    expect(result).toHaveLength(2);
    expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);
    expect(mocks.loggerInfo).toHaveBeenCalledTimes(2);
  });

  it("sanitizes special characters in attachment name", async () => {
    const msg = createMockMessage();
    msg.attachments = new Map([
      [
        "att-1",
        { name: "my file (1)!@#$.png", url: "https://cdn.discord.com/x.png", size: 50, contentType: "image/png" },
      ],
    ]);

    const mockBody = { pipe: vi.fn() };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, body: mockBody }));
    mocks.createWriteStream.mockReturnValue({ close: vi.fn() });

    const result = await saveAttachments(msg);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatch(/my_file/);
    expect(result[0]).toContain(".png");
  });

  it("uses fallback name when attachment.name is undefined", async () => {
    const msg = createMockMessage();
    msg.attachments = new Map([
      [
        "att-1",
        { name: undefined, url: "https://cdn.discord.com/x.bin", size: 50, contentType: "application/octet-stream" },
      ],
    ]);

    const mockBody = { pipe: vi.fn() };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, body: mockBody }));
    mocks.createWriteStream.mockReturnValue({ close: vi.fn() });

    const result = await saveAttachments(msg);

    expect(result).toHaveLength(1);
    expect(result[0]).toContain("1234567890-user-1-attachment");
  });

  it("creates attachments directory if it does not exist", async () => {
    const msg = createMockMessage();
    msg.attachments = new Map([
      ["att-1", { name: "file.txt", url: "https://cdn.discord.com/file.txt", size: 10, contentType: "text/plain" }],
    ]);

    mocks.existsSync.mockReturnValue(false);

    const mockBody = { pipe: vi.fn() };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, body: mockBody }));
    mocks.createWriteStream.mockReturnValue({ close: vi.fn() });

    await saveAttachments(msg);

    expect(mocks.mkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true });
  });

  it("catches pipeline error and logs it", async () => {
    const msg = createMockMessage();
    msg.attachments = new Map([
      ["att-1", { name: "broken.txt", url: "https://cdn.discord.com/broken.txt", size: 10, contentType: "text/plain" }],
    ]);

    const mockBody = { pipe: vi.fn() };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, body: mockBody }));
    mocks.createWriteStream.mockReturnValue({ close: vi.fn() });
    mocks.pipeline.mockRejectedValueOnce(new Error("ENOSPC: no space left on device"));

    const result = await saveAttachments(msg);

    expect(result).toEqual([]);
    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "Error saving attachment", error: expect.stringContaining("ENOSPC") }),
    );
  });
});
