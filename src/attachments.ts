/**
 * Attachment handling
 *
 * Downloads and saves Discord message attachments to the local filesystem.
 */

import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Message } from "discord.js";
import { logger } from "./logger.js";

const ATTACHMENTS_DIR = existsSync("/data") ? "/data/attachments" : path.join(process.cwd(), "attachments");

export async function saveAttachments(message: Message): Promise<string[]> {
  if (!message.attachments.size) return [];

  if (!existsSync(ATTACHMENTS_DIR)) {
    mkdirSync(ATTACHMENTS_DIR, { recursive: true });
  }

  const savedPaths: string[] = [];

  for (const [, attachment] of message.attachments) {
    try {
      const timestamp = Date.now();
      const safeName = attachment.name?.replace(/[^a-zA-Z0-9._-]/g, "_") || "attachment";
      const filename = `${timestamp}-${message.author.id}-${safeName}`;
      const filepath = path.join(ATTACHMENTS_DIR, filename);

      const response = await fetch(attachment.url);
      if (!response.ok) {
        logger.warn({ msg: "Failed to download attachment", url: attachment.url, status: response.status });
        continue;
      }

      const fileStream = createWriteStream(filepath);
      await pipeline(response.body as any, fileStream);

      savedPaths.push(filepath);
      logger.info({ msg: "Attachment saved", filename, size: attachment.size, contentType: attachment.contentType });
    } catch (err) {
      logger.error({ msg: "Error saving attachment", name: attachment.name, error: String(err) });
    }
  }

  return savedPaths;
}
