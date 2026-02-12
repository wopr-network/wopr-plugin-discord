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
import { findChannelIdFromConversationLog, getSessionKey, resolveMentions } from "./discord-utils.js";
import { REACTION_ACTIVE, REACTION_CANCELLED, REACTION_DONE, REACTION_ERROR } from "./identity-manager.js";
import { logger } from "./logger.js";
import { DiscordMessageStream, eventBusStreams, handleChunk, streams } from "./message-streaming.js";
import { buildPairingMessage, createPairingRequest, hasOwner } from "./pairing.js";
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

  const stream = new DiscordMessageStream(
    replyToMessage.channel as TextChannel | ThreadChannel | DMChannel,
    replyToMessage,
  );
  streams.set(streamKey, stream);

  let messageContent = rawContent;
  if (state.thinkingLevel !== "medium") {
    messageContent = `[Thinking level: ${state.thinkingLevel}] ${messageContent}`;
  }

  try {
    logger.info({ msg: "executeInjectInternal - inject starting", sessionKey, streamKey, from: authorDisplayName });
    await ctx.inject(sessionKey, messageContent, {
      from: authorDisplayName,
      channel: { type: "discord", id: channelId, name: (replyToMessage.channel as any).name },
      contextProviders: ["session_system", "skills", "bootstrap_files"],
      onStream: (msg: StreamMessage) => {
        if (cancelToken.cancelled) return;
        tickTyping(channelId);
        handleChunk(msg, streamKey).catch((e) => logger.error({ msg: "Chunk error", streamKey, error: String(e) }));
      },
    });
    logger.info({ msg: "executeInjectInternal - inject complete", sessionKey, streamKey });

    await stream.finalize();
    streams.delete(streamKey);

    stopTyping(channelId, channel);

    await setMessageReaction(replyToMessage, REACTION_DONE);

    queueManager.clearBuffer(channelId);
  } catch (error: any) {
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
        streams.delete(streamKey);
        await setMessageReaction(replyToMessage, REACTION_CANCELLED);
      } catch (_e) {}
    } else {
      logger.error({ msg: "executeInjectInternal - inject failed", sessionKey, streamKey, error: errorStr });
      try {
        await stream.finalize();
        streams.delete(streamKey);
        await setMessageReaction(replyToMessage, REACTION_ERROR);
      } catch (_e) {}
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
    logger.info({ msg: "Pairing code generated", userId: message.author.id, username: message.author.username });
    return;
  }

  if (await handleRegisteredCommand(message)) {
    return;
  }

  const channelId = message.channel.id;
  const isDirectlyMentioned = message.mentions.users.has(client.user.id);
  const isBot = message.author.bot;

  const authorDisplayName =
    message.member?.displayName || (message.author as any).displayName || message.author.username;

  const resolvedContent = resolveMentions(message);

  const sessionKey = getSessionKey(message.channel as TextChannel | ThreadChannel | DMChannel);
  try {
    ctx.logMessage(sessionKey, resolvedContent, {
      from: authorDisplayName,
      channel: { type: "discord", id: channelId, name: (message.channel as any).name },
    });
  } catch (_e) {}

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
    logger.info({ msg: "Bot @mention queued", channelId, botId: message.author.id, authorDisplayName });
    return;
  }

  // === HUMAN MESSAGE HANDLING ===
  if (isDirectlyMentioned || isDM) {
    const bufferContext = queueManager.getBufferContext(channelId);

    let messageContent = resolvedContent;
    if (client.user && isDirectlyMentioned) {
      const botDisplayName = message.guild?.members.me?.displayName || client.user?.username || "WOPR";
      messageContent = messageContent.replace(new RegExp(`@${botDisplayName}\\s*`, "gi"), "").trim();
    }

    if (message.attachments.size > 0) {
      const attachmentPaths = await saveAttachments(message);
      if (attachmentPaths.length > 0) {
        const attachmentInfo = attachmentPaths.map((p) => `[Attachment: ${p}]`).join("\n");
        messageContent = messageContent ? `${messageContent}\n\n${attachmentInfo}` : attachmentInfo;
        logger.info({ msg: "Attachments appended to message", count: attachmentPaths.length, channelId });
      }
    }

    if (!messageContent) {
      messageContent = "Hello! (You mentioned me without a message)";
      logger.info({ msg: "Human @mention - empty message, using default", channelId });
    }

    const fullMessage = bufferContext + messageContent;

    logger.info({ msg: "Human @mention - queueing (priority)", channelId, hasContext: bufferContext.length > 0 });

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

export function handleTypingStart(typing: any, _client: Client, queueManager: ChannelQueueManager): void {
  if (typing.user.bot) return;
  queueManager.setHumanTyping(typing.channel.id);
}

// ============================================================================
// Event Bus Subscriptions
// ============================================================================

export function subscribeSessionEvents(ctx: WOPRPluginContext, client: Client): void {
  if (!ctx.events) return;

  ctx.events.on("session:beforeInject", async (payload: SessionInjectEvent) => {
    if (!payload.session.startsWith("discord:")) return;
    if (!payload.message) return;
    if (payload.channel?.type === "discord") return;

    logger.info({ msg: "Session inject for Discord (streaming)", session: payload.session, from: payload.from });

    const channelId = findChannelIdFromConversationLog(payload.session);
    if (!channelId) {
      logger.warn({ msg: "Could not find Discord channel ID for inject", session: payload.session });
      return;
    }

    let sourceLabel = payload.from;
    if (payload.from === "cron") {
      sourceLabel = "Cron";
    } else if (payload.from === "cli") {
      sourceLabel = "CLI";
    } else if (payload.from?.startsWith("p2p:")) {
      sourceLabel = "P2P";
    } else if (payload.from?.startsWith("discord:")) {
      sourceLabel = `Session: ${payload.from}`;
    }

    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased() || !("send" in channel)) {
        logger.warn({ msg: "Channel not sendable for streaming", session: payload.session, channelId });
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

      const stream = new DiscordMessageStream(channel as TextChannel | ThreadChannel | DMChannel, notificationMsg);
      eventBusStreams.set(payload.session, stream);
    } catch (err) {
      logger.error({
        msg: "Failed to set up streaming for inject",
        session: payload.session,
        channelId,
        error: String(err),
      });
    }
  });

  ctx.events.on("session:afterInject", async (payload: SessionResponseEvent) => {
    if (!payload.session.startsWith("discord:")) return;
    if ((payload as any).channel?.type === "discord") return;

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
        logger.error({ msg: "Failed to finalize event bus stream", session: payload.session, error: String(err) });
      });
      eventBusStreams.delete(payload.session);
    } else if (payload.response) {
      logger.info({ msg: "No stream, falling back to bulk send", session: payload.session, from: payload.from });
      const channelId = findChannelIdFromConversationLog(payload.session);
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
  });
  logger.info("Subscribed to session events for Discord delivery (streaming)");
}

export function subscribeStreamEvents(ctx: WOPRPluginContext): void {
  const ctxAny = ctx as unknown as Record<string, unknown>;
  if (typeof ctxAny.on !== "function") return;

  (ctxAny.on as (event: string, handler: (event: SessionStreamEvent) => void) => void)(
    "stream",
    (event: SessionStreamEvent) => {
      const stream = eventBusStreams.get(event.session);
      if (!stream) return;

      const msg = event.message;

      if (msg.type === "complete" || msg.type === "error") {
        logger.info({ msg: "Event bus stream complete, finalizing", session: event.session, type: msg.type });
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
      } else if ((msg.type as string) === "assistant" && (msg as any).message?.content) {
        const content = (msg as any).message.content;
        if (Array.isArray(content)) {
          textContent = content.map((c: any) => c.text || "").join("");
        } else if (typeof content === "string") {
          textContent = content;
        }
      }

      if (textContent) {
        stream.append(textContent);
      }
    },
  );
  logger.info("Subscribed to stream events for Discord streaming");
}

export function subscribeSessionCreateEvent(ctx: WOPRPluginContext, client: Client): void {
  if (!ctx.events) return;

  ctx.events.on("session:create", async (payload: SessionCreateEvent) => {
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
  });
  logger.info("Subscribed to session:create for auto-channel creation");
}
