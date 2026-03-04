import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock node:fs and node:fs/promises before importing module
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const { PassThrough } = await import("node:stream");
  return {
    ...actual,
    existsSync: vi.fn((p: string) => {
      if (p === "/data") return false;
      return actual.existsSync(p);
    }),
    mkdirSync: vi.fn(),
    createWriteStream: vi.fn(() => {
      const pt = new PassThrough();
      pt.bytesWritten = 0;
      pt.on("data", (chunk: Buffer) => {
        pt.bytesWritten += chunk.length;
      });
      return pt;
    }),
  };
});

vi.mock("node:stream/promises", () => ({
  pipeline: vi.fn(async () => {}),
}));

vi.mock("node:fs/promises", () => ({
  unlink: vi.fn(async () => {}),
}));

vi.mock("node:stream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:stream")>();
  return {
    ...actual,
    Readable: {
      ...actual.Readable,
      fromWeb: vi.fn(() => {
        const { PassThrough } = actual;
        return new PassThrough();
      }),
      from: actual.Readable.from.bind(actual.Readable),
    },
    Transform: actual.Transform,
  };
});

vi.mock("./logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { saveAttachments } from "./attachments.js";
import { logger } from "./logger.js";

function makeMessage(attachments: Array<{ name: string; url: string; size: number; contentType: string }>) {
  const entries = attachments.map(
    (a, i) => [String(i), { ...a, id: String(i) }] as [string, typeof a & { id: string }],
  );
  const map = new Map(entries);
  return {
    attachments: {
      get size() {
        return map.size;
      },
      [Symbol.iterator]() {
        return map.entries();
      },
      entries() {
        return map.entries();
      },
    },
    author: { id: "user-123" },
  } as unknown as import("discord.js").Message;
}

describe("saveAttachments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("rejects attachment exceeding maxSizeBytes before download", async () => {
    const msg = makeMessage([
      {
        name: "huge.bin",
        url: "https://cdn.discord.com/huge.bin",
        size: 20_000_000,
        contentType: "application/octet-stream",
      },
    ]);

    const result = await saveAttachments(msg, { maxSizeBytes: 10_000_000, maxPerMessage: 5 });

    expect(result).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "Attachment exceeds size limit" }));
  });

  it("limits number of attachments per message", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: (async function* () {
        yield Buffer.from("data");
      })(),
    });

    const msg = makeMessage([
      { name: "a.txt", url: "https://cdn.discord.com/a.txt", size: 100, contentType: "text/plain" },
      { name: "b.txt", url: "https://cdn.discord.com/b.txt", size: 100, contentType: "text/plain" },
      { name: "c.txt", url: "https://cdn.discord.com/c.txt", size: 100, contentType: "text/plain" },
    ]);

    await saveAttachments(msg, { maxSizeBytes: 10_000_000, maxPerMessage: 2 });

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "Attachment limit reached" }));
  });

  it("falls back to default maxSizeBytes when NaN is supplied", async () => {
    // NaN is sanitized to DEFAULT_MAX_SIZE_BYTES; attachment at 100 bytes is well under it
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: (async function* () {
        yield Buffer.from("hello");
      })(),
    });
    const msg = makeMessage([
      { name: "f.txt", url: "https://cdn.discord.com/f.txt", size: 100, contentType: "text/plain" },
    ]);
    // Should not throw and should attempt the download
    await expect(saveAttachments(msg, { maxSizeBytes: NaN })).resolves.not.toThrow();
  });

  it("falls back to default maxSizeBytes when Infinity is supplied", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: (async function* () {
        yield Buffer.from("hello");
      })(),
    });
    const msg = makeMessage([
      { name: "f.txt", url: "https://cdn.discord.com/f.txt", size: 100, contentType: "text/plain" },
    ]);
    await expect(saveAttachments(msg, { maxSizeBytes: Infinity })).resolves.not.toThrow();
  });

  it("falls back to default maxPerMessage when NaN is supplied", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: (async function* () {
        yield Buffer.from("hello");
      })(),
    });
    const msg = makeMessage([
      { name: "f.txt", url: "https://cdn.discord.com/f.txt", size: 100, contentType: "text/plain" },
    ]);
    await expect(saveAttachments(msg, { maxPerMessage: NaN })).resolves.not.toThrow();
  });

  it("oversized attachment consumes the count slot", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: (async function* () {
        yield Buffer.from("data");
      })(),
    });

    // maxPerMessage: 1, first attachment is oversized so it consumes the slot;
    // second attachment should also be blocked (limit reached, not size)
    const msg = makeMessage([
      {
        name: "big.bin",
        url: "https://cdn.discord.com/big.bin",
        size: 20_000_000,
        contentType: "application/octet-stream",
      },
      { name: "small.txt", url: "https://cdn.discord.com/small.txt", size: 100, contentType: "text/plain" },
    ]);

    const result = await saveAttachments(msg, { maxSizeBytes: 10_000_000, maxPerMessage: 1 });
    expect(result).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("uses defaults when no limits provided", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: (async function* () {
        yield Buffer.from("hello");
      })(),
    });

    const msg = makeMessage([
      { name: "small.txt", url: "https://cdn.discord.com/small.txt", size: 100, contentType: "text/plain" },
    ]);

    const result = await saveAttachments(msg);
    expect(result.length).toBe(1);
  });

  it("aborts body stream when timeout fires during download", async () => {
    vi.useFakeTimers();

    let pipelineSignal: AbortSignal | undefined;
    const { pipeline: mockPipeline } = await import("node:stream/promises");
    vi.mocked(mockPipeline).mockImplementationOnce((...args) => {
      const opts = args.find((a) => a && typeof a === "object" && "signal" in a) as
        | { signal?: AbortSignal }
        | undefined;
      pipelineSignal = opts?.signal;
      // Simulate a pipeline that never resolves (stalled body)
      return new Promise((_resolve, reject) => {
        if (pipelineSignal) {
          pipelineSignal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }
      });
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: (async function* () {
        // yields nothing — stalls
      })(),
    });

    const msg = makeMessage([
      {
        name: "stall.bin",
        url: "https://cdn.discord.com/stall.bin",
        size: 100,
        contentType: "application/octet-stream",
      },
    ]);

    const promise = saveAttachments(msg);
    // Advance past the 30s timeout
    await vi.advanceTimersByTimeAsync(31_000);
    const result = await promise;

    expect(result).toEqual([]);
    expect(pipelineSignal?.aborted).toBe(true);
  });
});
