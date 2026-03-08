/**
 * Event Handlers
 *
 * Message handling, inject execution, typing events, and event bus
 * subscription setup for the Discord plugin.
 */

import {
  ChannelType,
  type Client,
  type DMChannel,
  type Message,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
import { saveAttachments } from "./attachments.js";
import { discordChannelProvider, handleRegisteredCommand, handleRegisteredParsers } from "./channel-provider.js";
import type { ChannelQueueManager, QueuedInject } from "./channel-queue.js";
import { getSessionKey, resolveMentions } from "./discord-utils.js";
import { REACTION_ACTIVE, REACTION_CANCELLED, REACTION_DONE, REACTION_ERROR } from "./identity-manager.js";
import { logger } from "./logger.js";
import { DiscordMessageStream, eventBusStreams, handleChunk, streams } from "./message-streaming.js";
import { buildPairingMessage, createPairingRequest, hasOwner } from "./pairing.js";
import type { RateLimiter } from "./rate-limiter.js";
import { setMessageReaction } from "./reaction-manager.js";
import type {
  SessionCreateEvent,
  SessionInjectEvent,
  SessionResponseEvent,
  SessionStreamEvent,
  StreamMessage,
  WOPRPluginContext,
} from "./types.js";
import { startTyping, stopTyping, tickTyping } from "./typing-manager.js";

// ============================================================================
// Channel ID Lookup via SQL
// ============================================================================

/** Minimal interface for ctx.session (added by WOP-1538). */
interface CtxWithSession {
  session?: {
    readConversationLog?: (sessionName: string) => Promise<Array<{ channel?: { id: string; type: string } }>>;
  };
}

/**
 * Find the Discord channel ID from a session's conversation log via SQL.
 * Scans entries newest-first for one with channel.type === "discord".
 */
export async function findChannelIdFromSession(ctx: WOPRPluginContext, sessionName: string): Promise<string | null> {
  // Defense-in-depth: reject session names with unsafe characters or traversal segments.
  // Note: '/' is allowed because thread session keys include it (e.g. discord:guild:#parent/thread).
  if (sessionName.includes("\u0000") || sessionName.includes("\\") || /(^|\/)\.\.(\/|$)/.test(sessionName)) {
    logger.warn({ msg: "Rejected session name with unsafe characters or path traversal" });
    return null;
  }
  const ctxWithSession = ctx as unknown as CtxWithSession;
  if (!ctxWithSession.session?.readConversationLog) {
    logger.warn({ msg: "ctx.session.readConversationLog not available (WOP-1538 required)", sessionName });
    return null;
  }

  try {
    const entries = await ctxWithSession.session.readConversationLog(sessionName);
    if (!Array.isArray(entries)) {
      logger.debug({ msg: "No conversation entries for session", sessionName });
      return null;
    }
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.channel?.type === "discord" && entry.channel?.id) {
        logger.debug({ msg: "Found Discord channel ID", sessionName, channelId: entry.channel.id });
        return entry.channel.id;
      }
    }
    logger.debug({ msg: "No Discord channel found in conversation log", sessionName });
    return null;
  } catch (err) {
    logger.error({ msg: "Error reading conversation log", sessionName, error: err });
    return null;
  }
}

// ============================================================================
// Core Inject Execution
// ============================================================================

export async function executeInjectInternal(
  item: QueuedInject,
  cancelToken: { cancelled: boolean },
  ctx: WOPRPluginContext,
  queueManager: ChannelQueueManager,
): Promise<void> {
  const { sessionKey, messageContent: rawContent, authorDisplayName, replyToMessage } = item;
  const channelId = replyToMessage.channel.id;
  const streamKey = replyToMessage.id;

  if (cancelToken.cancelled) {
    logger.info({ msg: "executeInjectInternal - cancelled before start", sessionKey, streamKey });
    await setMessageReaction(replyToMessage, REACTION_CANCELLED);
    return;
  }

  await setMessageReaction(replyToMessage, REACTION_ACTIVE);

  const channel = replyToMessage.channel as TextChannel | ThreadChannel | DMChannel;
  await startTyping(channel);

  const state = queueManager.getSessionState(sessionKey);
  state.messageCount++;

  const pluginConfig = ctx.getConfig<{ useComponentsV2?: boolean }>();
  const stream = new DiscordMessageStream(
    replyToMessage.channel as TextChannel | ThreadChannel | DMChannel,
    replyToMessage,
    { useComponentsV2: pluginConfig.useComponentsV2 ?? false },
  );
  streams.set(streamKey, stream);

  let messageContent = rawContent;
  if (state.thinkingLevel !== "medium") {
    messageContent = `[Thinking level: ${state.thinkingLevel}] ${messageContent}`;
  }

  try {
    logger.info({
      msg: "executeInjectInternal - inject starting",
      sessionKey,
      streamKey,
      from: authorDisplayName,
    });
    await ctx.inject(sessionKey, messageContent, {
      from: authorDisplayName,
      channel: {
        type: "discord",
        id: channelId,
        name: (replyToMessage.channel as { name?: string }).name,
      },
      contextProviders: ["session_system", "skills", "bootstrap_files"],
      onStream: (msg: StreamMessage) => {
        if (cancelToken.cancelled) return;
        tickTyping(channelId);
        handleChunk(msg, streamKey).catch((e) => logger.error({ msg: "Chunk error", streamKey, error: String(e) }));
      },
    });
    logger.info({ msg: "executeInjectInternal - inject complete", sessionKey, streamKey });

    try {
      await stream.finalize();
    } finally {
      streams.delete(streamKey);
    }

    stopTyping(channelId, channel);

    await setMessageReaction(replyToMessage, REACTION_DONE);

    queueManager.clearBuffer(channelId);
  } catch (error: unknown) {
    const errorStr = String(error);
    const isCancelled =
      cancelToken.cancelled ||
      errorStr.toLowerCase().includes("cancelled") ||
      errorStr.toLowerCase().includes("canceled");

    stopTyping(channelId, channel);

    if (isCancelled) {
      logger.info({ msg: "executeInjectInternal - inject was cancelled", sessionKey, streamKey });
      try {
        await stream.finalize();
      } catch (e) {
        logger.debug("Stream cleanup error (non-fatal)", { error: e, streamKey });
      } finally {
        streams.delete(streamKey);
      }
      try {
        await setMessageReaction(replyToMessage, REACTION_CANCELLED);
      } catch (e) {
        logger.debug("Reaction cleanup error (non-fatal)", { error: e, streamKey });
      }
    } else {
      logger.error({
        msg: "executeInjectInternal - inject failed",
        sessionKey,
        streamKey,
        error: errorStr,
      });
      try {
        await stream.finalize();
      } catch (e) {
        logger.debug("Stream cleanup error (non-fatal)", { error: e, streamKey });
      } finally {
        streams.delete(streamKey);
      }
      try {
        await setMessageReaction(replyToMessage, REACTION_ERROR);
      } catch (e) {
        logger.debug("Reaction cleanup error (non-fatal)", { error: e, streamKey });
      }
    }
  }
}

// ============================================================================
// Message + Typing Handlers
// ============================================================================

export async function handleMessage(
  message: Message,
  client: Client,
  ctx: WOPRPluginContext,
  queueManager: ChannelQueueManager,
  rateLimiter?: RateLimiter,
): Promise<void> {
  if (!client.user) return;

  if (message.author.id === client.user.id) return;

  if (await handleRegisteredParsers(message)) {
    return;
  }

  if (message.interaction) return;

  const isDM = message.channel.type === 1;

  if (isDM && !hasOwner(ctx)) {
    const code = createPairingRequest(message.author.id, message.author.username);
    const pairingMessage = buildPairingMessage(code);
    await message.reply(pairingMessage);
    logger.info({
      msg: "Pairing code generated",
      userId: message.author.id,
      username: message.author.username,
    });
    return;
  }

  if (await handleRegisteredCommand(message)) {
    return;
  }

  const channelId = message.channel.id;
  const isDirectlyMentioned = message.mentions.users.has(client.user.id);
  const isBot = message.author.bot;

  const authorDisplayName =
    message.member?.displayName || (message.author as { displayName?: string }).displayName || message.author.username;

  const resolvedContent = resolveMentions(message);

  const sessionKey = getSessionKey(message.channel as TextChannel | ThreadChannel | DMChannel);
  try {
    ctx.logMessage(sessionKey, resolvedContent, {
      from: authorDisplayName,
      channel: {
        type: "discord",
        id: channelId,
        name: (message.channel as { name?: string }).name,
      },
    });
  } catch (e) {
    logger.debug("logMessage error (non-fatal)", { error: e, sessionKey });
  }

  queueManager.addToBuffer(channelId, {
    from: authorDisplayName,
    content: resolvedContent,
    timestamp: Date.now(),
    isBot,
    isMention: isDirectlyMentioned,
    originalMessage: message,
  });

  // === BOT MESSAGE HANDLING ===
  if (isBot) {
    if (!isDirectlyMentioned) return;

    let messageContent = resolvedContent;
    const botDisplayName = message.guild?.members.me?.displayName || client.user?.username || "WOPR";
    messageContent = messageContent.replace(new RegExp(`@${botDisplayName}\\s*`, "gi"), "").trim();

    if (!messageContent) return;

    const bufferContext = queueManager.getBufferContext(channelId);
    const fullMessage = bufferContext + messageContent;

    queueManager.queueInject(channelId, {
      sessionKey,
      messageContent: fullMessage,
      authorDisplayName,
      replyToMessage: message,
      isBot: true,
      queuedAt: Date.now(),
    });
    logger.info({
      msg: "Bot @mention queued",
      channelId,
      botId: message.author.id,
      authorDisplayName,
    });
    return;
  }

  // === HUMAN MESSAGE HANDLING ===
  if (isDirectlyMentioned || isDM) {
    // Per-user rate limit check — must come first to avoid costly operations (WOP-1723)
    if (rateLimiter?.isRateLimited(message.author.id)) {
      logger.warn({
        msg: "Human inject rate-limited",
        channelId,
        userId: message.author.id,
        authorDisplayName,
      });
      message.author
        .send("You've hit the rate limit. Please wait before sending more requests.")
        .catch((e: unknown) => logger.debug("Rate limit DM error (non-fatal)", { error: e }));
      return;
    }

    const bufferContext = queueManager.getBufferContext(channelId);

    let messageContent = resolvedContent;
    if (client.user && isDirectlyMentioned) {
      const botDisplayName = message.guild?.members.me?.displayName || client.user?.username || "WOPR";
      messageContent = messageContent.replace(new RegExp(`@${botDisplayName}\\s*`, "gi"), "").trim();
    }

    if (message.attachments.size > 0) {
      const attachmentConfig = ctx.getConfig<{
        maxAttachmentSizeBytes?: number;
        maxAttachmentsPerMessage?: number;
        allowedAttachmentTypes?: string;
      }>();
      const rawAllowedAttachmentTypes = attachmentConfig.allowedAttachmentTypes;
      const parsedAllowedTypes =
        rawAllowedAttachmentTypes !== undefined
          ? rawAllowedAttachmentTypes
              .split(",")
              .map((t) => t.split(";")[0].trim().toLowerCase())
              .filter(Boolean)
          : undefined;
      // Treat an empty result (whitespace-only or comma-only config) as undefined so that
      // saveAttachments falls back to DEFAULT_ALLOWED_CONTENT_TYPES rather than disabling
      // the allowlist check entirely (fail-open security footgun).
      if (parsedAllowedTypes !== undefined && parsedAllowedTypes.length === 0) {
        logger.warn({
          msg: "allowedAttachmentTypes config is set but produced no valid types — falling back to defaults",
        });
      }
      const allowedTypes = parsedAllowedTypes?.length ? parsedAllowedTypes : undefined;
      const attachmentPaths = await saveAttachments(message, {
        maxSizeBytes: attachmentConfig.maxAttachmentSizeBytes,
        maxPerMessage: attachmentConfig.maxAttachmentsPerMessage,
        allowedContentTypes: allowedTypes,
      });
      if (attachmentPaths.length > 0) {
        const attachmentInfo = attachmentPaths.map((p) => `[Attachment: ${p}]`).join("\n");
        messageContent = messageContent ? `${messageContent}\n\n${attachmentInfo}` : attachmentInfo;
        logger.info({
          msg: "Attachments appended to message",
          count: attachmentPaths.length,
          channelId,
        });
      }
    }

    if (!messageContent) {
      messageContent = "Hello! (You mentioned me without a message)";
      logger.info({ msg: "Human @mention - empty message, using default", channelId });
    }

    const fullMessage = bufferContext + messageContent;

    logger.info({
      msg: "Human @mention - queueing (priority)",
      channelId,
      hasContext: bufferContext.length > 0,
    });

    queueManager.queueInject(channelId, {
      sessionKey,
      messageContent: fullMessage,
      authorDisplayName,
      replyToMessage: message,
      isBot: false,
      queuedAt: Date.now(),
    });
    return;
  }
}

export function handleTypingStart(
  typing: { user: { bot: boolean }; channel: { id: string } },
  _client: Client,
  queueManager: ChannelQueueManager,
): void {
  if (typing.user.bot) return;
  queueManager.setHumanTyping(typing.channel.id);
}

// ============================================================================
// Event Bus Subscriptions
// ============================================================================

export function subscribeSessionEvents(ctx: WOPRPluginContext, client: Client): () => void {
  if (!ctx.events) return () => {};

  const beforeHandler = async (payload: SessionInjectEvent) => {
    if (!payload.session.startsWith("discord:")) return;
    if (!payload.message) return;
    if (payload.channel?.type === "discord") return;

    logger.info({
      msg: "Session inject for Discord (streaming)",
      session: payload.session,
      from: payload.from,
    });

    const channelId = await findChannelIdFromSession(ctx, payload.session);
    if (!channelId) {
      logger.warn({
        msg: "Could not find Discord channel ID for inject",
        session: payload.session,
      });
      return;
    }

    let sourceLabel = payload.from;
    if (payload.from === "cron") {
      sourceLabel = "Cron";
    } else if (payload.from === "cli") {
      sourceLabel = "CLI";
    } else if (payload.from?.startsWith("discord:")) {
      sourceLabel = `Session: ${payload.from}`;
    }

    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased() || !("send" in channel)) {
        logger.warn({
          msg: "Channel not sendable for streaming",
          session: payload.session,
          channelId,
        });
        return;
      }
      const notificationMsg = await (channel as TextChannel | ThreadChannel | DMChannel).send(
        `**[${sourceLabel}]** ${payload.message.slice(0, 1900)}`,
      );
      logger.info({
        msg: "Sent inject notification, creating stream",
        session: payload.session,
        channelId,
        msgId: notificationMsg.id,
      });

      const existing = eventBusStreams.get(payload.session);
      if (existing) {
        await existing.finalize().catch(() => {});
        eventBusStreams.delete(payload.session);
      }

      const eventBusConfig = ctx.getConfig<{ useComponentsV2?: boolean }>();
      const stream = new DiscordMessageStream(channel as TextChannel | ThreadChannel | DMChannel, notificationMsg, {
        useComponentsV2: eventBusConfig?.useComponentsV2 ?? false,
      });
      eventBusStreams.set(payload.session, stream);
    } catch (err) {
      logger.error({
        msg: "Failed to set up streaming for inject",
        session: payload.session,
        channelId,
        error: String(err),
      });
    }
  };

  const afterHandler = async (payload: SessionResponseEvent) => {
    if (!payload.session.startsWith("discord:")) return;
    if ((payload as { channel?: { type?: string } }).channel?.type === "discord") return;

    const stream = eventBusStreams.get(payload.session);
    if (stream) {
      if (payload.response) {
        logger.info({
          msg: "Delivering inject response to Discord stream",
          session: payload.session,
          from: payload.from,
          responseLen: payload.response.length,
        });
        stream.append(payload.response);
      } else {
        logger.warn({
          msg: "afterInject: no response content to deliver",
          session: payload.session,
          from: payload.from,
        });
      }
      await stream.finalize().catch((err) => {
        logger.error({
          msg: "Failed to finalize event bus stream",
          session: payload.session,
          error: String(err),
        });
      });
      eventBusStreams.delete(payload.session);
    } else if (payload.response) {
      logger.info({
        msg: "No stream, falling back to bulk send",
        session: payload.session,
        from: payload.from,
      });
      const channelId = await findChannelIdFromSession(ctx, payload.session);
      if (channelId) {
        try {
          await discordChannelProvider.send(channelId, payload.response);
        } catch (err) {
          logger.error({
            msg: "Failed to deliver response to Discord",
            session: payload.session,
            error: String(err),
          });
        }
      }
    }
  };

  const unsubBefore = ctx.events.on("session:beforeInject", beforeHandler);
  const unsubAfter = ctx.events.on("session:afterInject", afterHandler);
  logger.info("Subscribed to session events for Discord delivery (streaming)");

  return () => {
    unsubBefore();
    unsubAfter();
  };
}

export function subscribeStreamEvents(ctx: WOPRPluginContext): () => void {
  const ctxAny = ctx as unknown as Record<string, unknown>;
  if (typeof ctxAny.on !== "function") return () => {};

  const handler = (event: SessionStreamEvent) => {
    const stream = eventBusStreams.get(event.session);
    if (!stream) return;

    const msg = event.message;

    if (msg.type === "complete" || msg.type === "error") {
      logger.info({
        msg: "Event bus stream complete, finalizing",
        session: event.session,
        type: msg.type,
      });
      eventBusStreams.delete(event.session);
      stream.finalize().catch((err) => {
        logger.error({
          msg: "Failed to finalize event bus stream on complete",
          session: event.session,
          error: String(err),
        });
      });
      return;
    }

    if (msg.type === "system" && msg.subtype === "compact_boundary") {
      const metadata = msg.metadata as { pre_tokens?: number; trigger?: string } | undefined;
      if (metadata?.trigger === "auto") {
        let notification = "\u{1f4e6} **Auto-Compaction**\n";
        notification += metadata.pre_tokens
          ? `Context compressed from ~${Math.round(metadata.pre_tokens / 1000)}k tokens`
          : "Context has been automatically compressed";
        stream.append(`\n\n${notification}\n\n`);
      }
      return;
    }

    let textContent = "";
    if (msg.type === "text" && msg.content) {
      textContent = msg.content;
    } else if ((msg.type as string) === "assistant" && (msg as { message?: { content?: unknown } }).message?.content) {
      const content = (msg as { message?: { content?: unknown } }).message?.content;
      if (Array.isArray(content)) {
        textContent = content.map((c: { text?: string }) => c.text || "").join("");
      } else if (typeof content === "string") {
        textContent = content;
      }
    }

    if (textContent) {
      stream.append(textContent);
    }
  };

  (ctxAny.on as (event: string, handler: (event: SessionStreamEvent) => void) => void)("stream", handler);
  logger.info("Subscribed to stream events for Discord streaming");

  return () => {
    if (typeof (ctxAny as Record<string, unknown>).off === "function") {
      (ctxAny.off as (event: string, handler: (event: SessionStreamEvent) => void) => void)("stream", handler);
    }
  };
}

export function subscribeSessionCreateEvent(ctx: WOPRPluginContext, client: Client): () => void {
  if (!ctx.events) return () => {};

  const handler = async (payload: SessionCreateEvent) => {
    const sessionName = payload.session;

    const match = sessionName.match(/^discord:([^:]+):#(.+)$/);
    if (!match) return;

    const [, guildName, channelName] = match;
    logger.info({ msg: "Session create for Discord pattern", sessionName, guildName, channelName });

    const guild = client.guilds.cache.find(
      (g) =>
        g.name.toLowerCase().replace(/\s+/g, "-") === guildName.toLowerCase() ||
        g.name.toLowerCase() === guildName.toLowerCase(),
    );

    if (!guild) {
      logger.warn({ msg: "Guild not found for session", sessionName, guildName });
      return;
    }

    const existingChannel = guild.channels.cache.find(
      (c) => c.name.toLowerCase() === channelName.toLowerCase() && c.type === ChannelType.GuildText,
    );

    if (existingChannel) {
      logger.debug({ msg: "Channel already exists", channelName, channelId: existingChannel.id });
      return;
    }

    let woprCategory = guild.channels.cache.find(
      (c) => c.name.toLowerCase() === "wopr" && c.type === ChannelType.GuildCategory,
    );

    if (!woprCategory) {
      try {
        woprCategory = await guild.channels.create({
          name: "WOPR",
          type: ChannelType.GuildCategory,
        });
        logger.info({ msg: "Created WOPR category", categoryId: woprCategory.id });
      } catch (err) {
        logger.error({ msg: "Failed to create WOPR category", error: String(err) });
        return;
      }
    }

    try {
      const newChannel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: woprCategory.id,
      });
      logger.info({
        msg: "Created Discord channel for session",
        channelName,
        channelId: newChannel.id,
        sessionName,
      });
    } catch (err) {
      logger.error({ msg: "Failed to create Discord channel", channelName, error: String(err) });
    }
  };

  const unsubCreate = ctx.events.on("session:create", handler);
  logger.info("Subscribed to session:create for auto-channel creation");

  return () => {
    unsubCreate();
  };
}
