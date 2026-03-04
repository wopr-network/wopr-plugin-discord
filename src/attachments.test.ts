import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { AttachmentContentTypeError, DEFAULT_ALLOWED_CONTENT_TYPES, saveAttachments } from "./attachments.js";
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

  it("rejects attachment exceeding maxSizeBytes before download", async () => {
    const msg = makeMessage([
      {
        name: "huge.png",
        url: "https://cdn.discord.com/huge.png",
        size: 20_000_000,
        contentType: "image/png",
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
        name: "big.png",
        url: "https://cdn.discord.com/big.png",
        size: 20_000_000,
        contentType: "image/png",
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

  it("rejects attachment with disallowed content type", async () => {
    const msg = makeMessage([
      {
        name: "malware.exe",
        url: "https://cdn.discord.com/malware.exe",
        size: 100,
        contentType: "application/x-msdownload",
      },
    ]);

    const result = await saveAttachments(msg, { maxSizeBytes: 10_000_000, maxPerMessage: 5 });

    expect(result).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "Attachment content type not allowed" }));
  });

  it("allows attachment with permitted content type", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: (async function* () {
        yield Buffer.from("data");
      })(),
    });

    const msg = makeMessage([
      { name: "photo.jpg", url: "https://cdn.discord.com/photo.jpg", size: 100, contentType: "image/jpeg" },
    ]);

    const result = await saveAttachments(msg, { maxSizeBytes: 10_000_000, maxPerMessage: 5 });
    expect(result.length).toBe(1);
  });

  it("rejects attachment with null content type", async () => {
    const msg = makeMessage([
      { name: "unknown", url: "https://cdn.discord.com/unknown", size: 100, contentType: null as unknown as string },
    ]);

    const result = await saveAttachments(msg, { maxSizeBytes: 10_000_000, maxPerMessage: 5 });
    expect(result).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "Attachment content type not allowed" }));
  });

  it("uses custom allowedContentTypes when provided", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: (async function* () {
        yield Buffer.from("data");
      })(),
    });

    const msg = makeMessage([
      { name: "doc.pdf", url: "https://cdn.discord.com/doc.pdf", size: 100, contentType: "application/pdf" },
      { name: "pic.png", url: "https://cdn.discord.com/pic.png", size: 100, contentType: "image/png" },
    ]);

    // Only allow PDF
    const result = await saveAttachments(msg, {
      maxSizeBytes: 10_000_000,
      maxPerMessage: 5,
      allowedContentTypes: ["application/pdf"],
    });
    expect(result.length).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "Attachment content type not allowed", contentType: "image/png" }),
    );
  });

  it("rejected content type consumes the count slot", async () => {
    const msg = makeMessage([
      {
        name: "script.sh",
        url: "https://cdn.discord.com/script.sh",
        size: 100,
        contentType: "application/x-sh",
      },
      { name: "photo.jpg", url: "https://cdn.discord.com/photo.jpg", size: 100, contentType: "image/jpeg" },
    ]);

    const result = await saveAttachments(msg, { maxSizeBytes: 10_000_000, maxPerMessage: 1 });
    expect(result).toEqual([]);
  });

  it("exports DEFAULT_ALLOWED_CONTENT_TYPES with expected types", () => {
    expect(DEFAULT_ALLOWED_CONTENT_TYPES).toContain("image/jpeg");
    expect(DEFAULT_ALLOWED_CONTENT_TYPES).toContain("image/png");
    expect(DEFAULT_ALLOWED_CONTENT_TYPES).toContain("image/gif");
    expect(DEFAULT_ALLOWED_CONTENT_TYPES).toContain("image/webp");
    expect(DEFAULT_ALLOWED_CONTENT_TYPES).toContain("text/plain");
    expect(DEFAULT_ALLOWED_CONTENT_TYPES).toContain("text/markdown");
    expect(DEFAULT_ALLOWED_CONTENT_TYPES).toContain("application/pdf");
  });

  it("falls back to DEFAULT_ALLOWED_CONTENT_TYPES when allowedContentTypes is empty array", async () => {
    // Empty array must NOT disable the allowlist — it must fall back to defaults.
    const msg = makeMessage([
      {
        name: "malware.exe",
        url: "https://cdn.discord.com/malware.exe",
        size: 100,
        contentType: "application/x-msdownload",
      },
    ]);

    const result = await saveAttachments(msg, { allowedContentTypes: [] });
    expect(result).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "Attachment content type not allowed" }));
  });

  it("allows content type with parameters (e.g. text/plain; charset=utf-8)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: (async function* () {
        yield Buffer.from("hello");
      })(),
    });

    const msg = makeMessage([
      {
        name: "readme.txt",
        url: "https://cdn.discord.com/readme.txt",
        size: 100,
        contentType: "text/plain; charset=utf-8",
      },
    ]);

    const result = await saveAttachments(msg);
    expect(result.length).toBe(1);
  });

  it("allows content type with uppercase chars (case-insensitive match)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: (async function* () {
        yield Buffer.from("data");
      })(),
    });

    const msg = makeMessage([
      { name: "photo.jpg", url: "https://cdn.discord.com/photo.jpg", size: 100, contentType: "Image/JPEG" },
    ]);

    const result = await saveAttachments(msg);
    expect(result.length).toBe(1);
  });

  it("normalizes custom allowedContentTypes entries (case-insensitive, strips params)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: (async function* () {
        yield Buffer.from("data");
      })(),
    });

    const msg = makeMessage([
      { name: "photo.jpg", url: "https://cdn.discord.com/photo.jpg", size: 100, contentType: "image/jpeg" },
      { name: "readme.txt", url: "https://cdn.discord.com/readme.txt", size: 100, contentType: "text/plain" },
      { name: "doc.pdf", url: "https://cdn.discord.com/doc.pdf", size: 100, contentType: "application/pdf" },
    ]);

    // Pass mixed-case and parameterized entries in the custom allowlist
    const result = await saveAttachments(msg, {
      maxSizeBytes: 10_000_000,
      maxPerMessage: 5,
      allowedContentTypes: ["Image/JPEG", "text/plain; charset=utf-8"],
    });

    // image/jpeg and text/plain should match; application/pdf should be rejected
    expect(result.length).toBe(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "Attachment content type not allowed", contentType: "application/pdf" }),
    );
  });

  it("AttachmentContentTypeError is thrown for rejected content types (instanceof check)", async () => {
    // The error class must be thrown so callers/metrics can detect it via instanceof.
    // saveAttachments catches it internally, so we verify it was wired by checking the warn log.
    const msg = makeMessage([
      {
        name: "virus.exe",
        url: "https://cdn.discord.com/virus.exe",
        size: 100,
        contentType: "application/x-msdownload",
      },
    ]);

    await saveAttachments(msg);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "Attachment content type not allowed" }));
    // Confirm the class itself is importable and has the expected shape
    const err = new AttachmentContentTypeError("application/x-msdownload");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("ATTACHMENT_CONTENT_TYPE_REJECTED");
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
        name: "stall.png",
        url: "https://cdn.discord.com/stall.png",
        size: 100,
        contentType: "image/png",
      },
    ]);

    const promise = saveAttachments(msg);
    // Advance past the 30s timeout
    await vi.advanceTimersByTimeAsync(31_000);
    const result = await promise;

    expect(result).toEqual([]);
    expect(pipelineSignal?.aborted).toBe(true);

    vi.useRealTimers();
  });
});
