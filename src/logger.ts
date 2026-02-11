/**
 * Winston logger for WOPR Discord Plugin
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import winston from "winston";

const consoleFormat = winston.format.printf((info) => {
  const level = info.level;

  // Try to extract message from various possible locations
  let msg = "";
  let errorStr = "";

  // Case 1: info.message is a string
  if (typeof info.message === "string") {
    msg = info.message;
  }
  // Case 2: info.message is an object with msg property
  else if (info.message && typeof info.message === "object") {
    const msgObj = info.message as Record<string, unknown>;
    if (typeof msgObj.msg === "string") {
      msg = msgObj.msg;
    }
    if (typeof msgObj.error === "string") {
      errorStr = ` - ${msgObj.error}`;
    }
    // If no msg property, stringify the whole object
    if (!msg) {
      try {
        msg = JSON.stringify(msgObj);
      } catch {
        msg = "[unserializable object]";
      }
    }
  }
  // Case 3: Check top-level info for msg/error (Winston splat format)
  else {
    const topLevel = info as Record<string, unknown>;
    if (typeof topLevel.msg === "string") {
      msg = topLevel.msg;
    }
    if (typeof topLevel.error === "string") {
      errorStr = ` - ${topLevel.error}`;
    }
  }

  // Fallback: stringify the entire info object if we still have no message
  if (!msg) {
    try {
      // Exclude metadata fields
      const { level: _l, timestamp: _t, service: _s, ...rest } = info as Record<string, unknown>;
      msg = Object.keys(rest).length > 0 ? JSON.stringify(rest) : "[empty message]";
    } catch {
      msg = "[unserializable]";
    }
  }

  return `${level}: ${msg}${errorStr}`;
});

const logDir = path.join(process.env.WOPR_HOME || "/tmp/wopr-test", "logs");
mkdirSync(logDir, { recursive: true });

export const logger = winston.createLogger({
  level: "debug",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ),
  defaultMeta: { service: "wopr-plugin-discord" },
  transports: [
    new winston.transports.File({
      filename: path.join(logDir, "discord-plugin-error.log"),
      level: "error",
    }),
    new winston.transports.File({
      filename: path.join(logDir, "discord-plugin.log"),
      level: "debug",
    }),
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize(), consoleFormat),
      level: "warn",
    }),
  ],
});
