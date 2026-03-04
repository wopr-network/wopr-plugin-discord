/**
 * Attachment handling
 *
 * Downloads and saves Discord message attachments to the local filesystem
 * with size and count limits to prevent disk exhaustion.
 */

import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Message } from "discord.js";
import { logger } from "./logger.js";

const ATTACHMENTS_DIR = existsSync("/data") ? "/data/attachments" : path.join(process.cwd(), "attachments");

export const DEFAULT_MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
export const DEFAULT_MAX_PER_MESSAGE = 5;

export const DEFAULT_ALLOWED_CONTENT_TYPES: readonly string[] = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "text/plain",
  "text/markdown",
  "application/pdf",
];

export interface AttachmentLimits {
  maxSizeBytes: number;
  maxPerMessage: number;
  allowedContentTypes: readonly string[];
}

export class AttachmentContentTypeError extends Error {
  readonly code = "ATTACHMENT_CONTENT_TYPE_REJECTED";
  constructor(contentType: string | null) {
    super(`Attachment content type not allowed: ${contentType ?? "unknown"}`);
    this.name = "AttachmentContentTypeError";
  }
}

export class AttachmentSizeLimitError extends Error {
  readonly code = "ATTACHMENT_SIZE_LIMIT_EXCEEDED";
  constructor(bytesReceived: number, maxSize: number) {
    super(`Attachment stream exceeded size limit: ${bytesReceived} > ${maxSize}`);
    this.name = "AttachmentSizeLimitError";
  }
}

export async function saveAttachments(message: Message, limits?: Partial<AttachmentLimits>): Promise<string[]> {
  if (!message.attachments.size) return [];

  const rawMaxSize = limits?.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
  const rawMaxCount = limits?.maxPerMessage ?? DEFAULT_MAX_PER_MESSAGE;
  // Treat empty array the same as "not configured" — fall back to the default allowlist so a
  // misconfigured/empty allowedContentTypes can never silently disable the content-type check.
  const configuredAllowedTypes = limits?.allowedContentTypes;
  const allowedTypes = (
    Array.isArray(configuredAllowedTypes) && configuredAllowedTypes.length > 0
      ? configuredAllowedTypes
      : DEFAULT_ALLOWED_CONTENT_TYPES
  ).map((t) => t.split(";")[0].trim().toLowerCase());
  // Sanitize: fall back to defaults for invalid (NaN / Infinity / negative) values
  const maxSize = Number.isFinite(rawMaxSize) && rawMaxSize > 0 ? rawMaxSize : DEFAULT_MAX_SIZE_BYTES;
  const maxCount = Number.isFinite(rawMaxCount) && rawMaxCount >= 0 ? Math.floor(rawMaxCount) : DEFAULT_MAX_PER_MESSAGE;

  if (!existsSync(ATTACHMENTS_DIR)) {
    mkdirSync(ATTACHMENTS_DIR, { recursive: true });
  }

  const savedPaths: string[] = [];
  let count = 0;

  for (const [, attachment] of message.attachments) {
    if (count >= maxCount) {
      logger.warn({
        msg: "Attachment limit reached",
        limit: maxCount,
        total: message.attachments.size,
      });
      break;
    }

    // Increment before validation so rejected attachments consume the slot,
    // preventing bypass by padding requests with invalid attachments.
    count++;

    try {
      // Content-type allowlist check — normalize to base type (strip params) and lowercase
      // so that e.g. "text/plain; charset=utf-8" correctly matches "text/plain".
      const baseContentType = (attachment.contentType ?? "").split(";")[0].trim().toLowerCase();
      if (!allowedTypes.includes(baseContentType)) {
        throw new AttachmentContentTypeError(attachment.contentType);
      }

      // Pre-download size check using Discord-reported size
      if (attachment.size > maxSize) {
        logger.warn({
          msg: "Attachment exceeds size limit",
          name: attachment.name,
          size: attachment.size,
          limit: maxSize,
        });
        continue;
      }

      const timestamp = Date.now();
      const safeName = attachment.name?.replace(/[^a-zA-Z0-9._-]/g, "_") || "attachment";
      const filename = `${timestamp}-${message.author.id}-${attachment.id}-${safeName}`;
      const filepath = path.join(ATTACHMENTS_DIR, filename);

      const saved = await downloadAttachment(attachment.url, filepath, maxSize);
      if (saved) {
        savedPaths.push(filepath);
        logger.info({ msg: "Attachment saved", filename, size: attachment.size, contentType: attachment.contentType });
      }
    } catch (err) {
      if (err instanceof AttachmentContentTypeError) {
        logger.warn({
          msg: "Attachment content type not allowed",
          name: attachment.name,
          contentType: attachment.contentType,
          allowedTypes,
        });
      } else {
        logger.error({ msg: "Error saving attachment", name: attachment.name, error: String(err) });
      }
    }
  }

  return savedPaths;
}

async function downloadAttachment(url: string, filepath: string, maxSize: number): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000); // 30s timeout

  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }

  if (!response.ok) {
    clearTimeout(timeout);
    logger.warn({ msg: "Failed to download attachment", url, status: response.status });
    return false;
  }

  // Streaming size guard — errors if actual bytes exceed limit
  let bytesReceived = 0;
  const sizeGuard = new Transform({
    transform(chunk, _encoding, callback) {
      bytesReceived += chunk.length;
      if (bytesReceived > maxSize) {
        callback(new AttachmentSizeLimitError(bytesReceived, maxSize));
        return;
      }
      callback(null, chunk);
    },
  });

  const nodeStream = response.body
    ? Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
    : Readable.from([]);

  const fileStream = createWriteStream(filepath);

  try {
    // Keep the abort signal active through the body pipeline so a stalled
    // body stream is terminated by the same 30s timeout.
    await pipeline(nodeStream, sizeGuard, fileStream, { signal: controller.signal });
  } catch (err) {
    // Clean up partial file on failure
    try {
      await unlink(filepath);
    } catch {
      // ignore cleanup errors
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  return true;
}
