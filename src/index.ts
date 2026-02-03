/**
 * WOPR Discord Plugin - With Slash Commands
 */

import {
  Client,
  GatewayIntentBits,
  Events,
  Message,
  TextChannel,
  ThreadChannel,
  DMChannel,
  SlashCommandBuilder,
  REST,
  Routes,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  Partials,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ButtonInteraction,
  ComponentType,
} from "discord.js";
import winston from "winston";
import path from "path";
import { createWriteStream, existsSync, mkdirSync, readFileSync } from "fs";
import { pipeline } from "stream/promises";
import {
  createFriendRequestButtons,
  createFriendRequestEmbed,
  storePendingButtonRequest,
  getPendingButtonRequest,
  removePendingButtonRequest,
  isFriendRequestButton,
  handleFriendButtonInteraction,
  cleanupExpiredButtonRequests,
  getOwnerUserId,
} from "./friend-buttons.js";
import {
  createPairingRequest,
  claimPairingCode,
  buildPairingMessage,
  hasOwner,
  setOwner,
  cleanupExpiredPairings,
} from "./pairing.js";
import type {
  WOPRPlugin,
  WOPRPluginContext,
  ConfigSchema,
  StreamMessage,
  AgentIdentity,
  ChannelProvider,
  ChannelCommand,
  ChannelMessageParser,
  ChannelCommandContext,
  ChannelMessageContext,
  SessionResponseEvent,
} from "./types.js";

const consoleFormat = winston.format.printf(({ level, message, msg, error, ...meta }) => {
  const displayMsg = msg || message || "";
  const errorInfo = error ? ` - ${error}` : "";
  return `${level}: ${displayMsg}${errorInfo}`;
});

const logger = winston.createLogger({
  level: "debug",
  format: winston.format.combine(winston.format.timestamp(), winston.format.errors({ stack: true }), winston.format.json()),
  defaultMeta: { service: "wopr-plugin-discord" },
  transports: [
    new winston.transports.File({ filename: path.join(process.env.WOPR_HOME || "/tmp/wopr-test", "logs", "discord-plugin-error.log"), level: "error" }),
    new winston.transports.File({ filename: path.join(process.env.WOPR_HOME || "/tmp/wopr-test", "logs", "discord-plugin.log"), level: "debug" }),
    new winston.transports.Console({ format: winston.format.combine(winston.format.colorize(), consoleFormat), level: "warn" }),
  ],
});

let client: Client | null = null;
let ctx: WOPRPluginContext | null = null;
let agentIdentity: AgentIdentity = { name: "WOPR", emoji: "👀" };

/**
 * Generate a readable session key from a Discord channel.
 * Format:
 * - Guild channels: discord:guildName:#channelName
 * - Threads: discord:guildName:#parentChannel/threadName
 * - DMs: discord:dm:username
 */
function getSessionKey(channel: TextChannel | ThreadChannel | DMChannel): string {
  // Sanitize name for use in session key (lowercase, replace spaces with -)
  const sanitize = (name: string) => name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '');

  if (channel.isDMBased()) {
    // DM channel - use recipient username
    const dm = channel as DMChannel;
    const recipientName = dm.recipient?.username || 'unknown';
    return `discord:dm:${sanitize(recipientName)}`;
  }

  if (channel.isThread()) {
    // Thread - include parent channel
    const thread = channel as ThreadChannel;
    const guildName = thread.guild?.name || 'unknown';
    const parentName = thread.parent?.name || 'unknown';
    return `discord:${sanitize(guildName)}:#${sanitize(parentName)}/${sanitize(thread.name)}`;
  }

  // Regular text channel
  const textChannel = channel as TextChannel;
  const guildName = textChannel.guild?.name || 'unknown';
  return `discord:${sanitize(guildName)}:#${sanitize(textChannel.name)}`;
}

/**
 * Get session key from interaction (for slash commands)
 */
function getSessionKeyFromInteraction(interaction: ChatInputCommandInteraction): string {
  const channel = interaction.channel;
  if (channel && (channel instanceof TextChannel || channel instanceof ThreadChannel || channel instanceof DMChannel)) {
    return getSessionKey(channel);
  }
  // Fallback to channel ID if we can't resolve the channel type
  return `discord:${interaction.channelId}`;
}

/**
 * Find the Discord channel ID from a session's conversation log.
 * Looks for the most recent message with a Discord channel reference.
 */
function findChannelIdFromConversationLog(sessionName: string): string | null {
  const sessionsDir = process.env.WOPR_HOME
    ? path.join(process.env.WOPR_HOME, "sessions")
    : "/data/sessions";
  const logPath = path.join(sessionsDir, `${sessionName}.conversation.jsonl`);

  if (!existsSync(logPath)) {
    logger.debug({ msg: "Conversation log not found", sessionName, logPath });
    return null;
  }

  try {
    const content = readFileSync(logPath, "utf-8");
    const lines = content.trim().split("\n").filter(l => l);

    // Search from most recent entry backwards for a Discord channel reference
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.channel?.type === "discord" && entry.channel?.id) {
          logger.debug({ msg: "Found Discord channel ID", sessionName, channelId: entry.channel.id });
          return entry.channel.id;
        }
      } catch {
        // Skip malformed lines
      }
    }

    logger.debug({ msg: "No Discord channel found in conversation log", sessionName });
    return null;
  } catch (err) {
    logger.error({ msg: "Error reading conversation log", sessionName, error: String(err) });
    return null;
  }
}

// Slash command definitions
const commands = [
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show session status and configuration"),
  new SlashCommandBuilder()
    .setName("new")
    .setDescription("Start a new session (reset conversation)"),
  new SlashCommandBuilder()
    .setName("reset")
    .setDescription("Reset the current session (alias for /new)"),
  new SlashCommandBuilder()
    .setName("compact")
    .setDescription("Compact session context (summarize conversation)"),
  new SlashCommandBuilder()
    .setName("think")
    .setDescription("Set the thinking level for responses")
    .addStringOption(option =>
      option.setName("level")
        .setDescription("Thinking level")
        .setRequired(true)
        .addChoices(
          { name: "Off", value: "off" },
          { name: "Minimal", value: "minimal" },
          { name: "Low", value: "low" },
          { name: "Medium", value: "medium" },
          { name: "High", value: "high" },
          { name: "Maximum", value: "xhigh" }
        )
    ),
  new SlashCommandBuilder()
    .setName("verbose")
    .setDescription("Toggle verbose mode")
    .addBooleanOption(option =>
      option.setName("enabled")
        .setDescription("Enable or disable verbose mode")
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("usage")
    .setDescription("Set usage tracking display")
    .addStringOption(option =>
      option.setName("mode")
        .setDescription("Usage display mode")
        .setRequired(true)
        .addChoices(
          { name: "Off", value: "off" },
          { name: "Tokens only", value: "tokens" },
          { name: "Full", value: "full" }
        )
    ),
  new SlashCommandBuilder()
    .setName("session")
    .setDescription("Switch to a different session")
    .addStringOption(option =>
      option.setName("name")
        .setDescription("Session name")
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("wopr")
    .setDescription("Send a message to WOPR")
    .addStringOption(option =>
      option.setName("message")
        .setDescription("Your message")
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show available commands and help"),
  new SlashCommandBuilder()
    .setName("claim")
    .setDescription("Claim ownership of this bot with a pairing code (DM only)")
    .addStringOption(option =>
      option.setName("code")
        .setDescription("The pairing code you received")
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("cancel")
    .setDescription("Cancel the current AI response in progress"),
  new SlashCommandBuilder()
    .setName("model")
    .setDescription("Switch the AI model for this session")
    .addStringOption(option =>
      option.setName("model")
        .setDescription("AI model to use")
        .setRequired(true)
        .addChoices(
          { name: "⚡ Haiku 4.5 (Fast)", value: "haiku" },
          { name: "🧠 Sonnet 4.5 (Balanced)", value: "sonnet" },
          { name: "🔮 Opus 4.5 (Most Capable)", value: "opus" }
        )
    ),
];

// Cache identity on init
async function refreshIdentity() {
  if (!ctx) return;
  try {
    const identity = await ctx.getAgentIdentity();
    if (identity) {
      agentIdentity = { ...agentIdentity, ...identity };
      logger.info({ msg: "Identity refreshed", identity: agentIdentity });
    }
  } catch (e) {
    logger.warn({ msg: "Failed to refresh identity", error: String(e) });
  }
  // Also refresh reaction emojis from config
  await refreshReactionEmojis();
}

// Reaction emojis for message state - configurable via plugin settings
let reactionEmojis = {
  queued: "🕐",
  active: "⚡",
  done: "✅",
  error: "❌",
  cancelled: "⏹️",
};

function getReactionEmoji(state: keyof typeof reactionEmojis): string {
  return reactionEmojis[state];
}

async function refreshReactionEmojis(): Promise<void> {
  if (!ctx) return;
  try {
    const config = ctx.getConfig<Record<string, any>>();
    if (config) {
      reactionEmojis = {
        queued: config.emojiQueued || "🕐",
        active: config.emojiActive || "⚡",
        done: config.emojiDone || "✅",
        error: config.emojiError || "❌",
        cancelled: config.emojiCancelled || "⏹️",
      };
      logger.info({ msg: "Reaction emojis refreshed", emojis: reactionEmojis });
    }
  } catch (e) {
    logger.warn({ msg: "Failed to refresh reaction emojis", error: String(e) });
  }
}

// Convenience getters
const REACTION_QUEUED = () => reactionEmojis.queued;
const REACTION_ACTIVE = () => reactionEmojis.active;
const REACTION_DONE = () => reactionEmojis.done;
const REACTION_ERROR = () => reactionEmojis.error;
const REACTION_CANCELLED = () => reactionEmojis.cancelled;

function getAckReaction(): string {
  return agentIdentity.emoji?.trim() || "👀";
}

function getMessagePrefix(): string {
  const name = agentIdentity.name?.trim();
  return name ? `[${name}]` : "[WOPR]";
}

/**
 * Set reaction state on a message. Removes old state reactions first.
 */
async function setMessageReaction(message: Message, reaction: string | (() => string)): Promise<void> {
  if (!client?.user) return;

  const botId = client.user.id;
  // Call functions to get current emoji values
  const stateReactions = [REACTION_QUEUED(), REACTION_ACTIVE(), REACTION_DONE(), REACTION_ERROR(), REACTION_CANCELLED()];
  const reactionValue = typeof reaction === 'function' ? reaction() : reaction;

  try {
    // Remove any existing state reactions from us
    for (const emoji of stateReactions) {
      try {
        const existingReaction = message.reactions.cache.get(emoji);
        if (existingReaction?.users.cache.has(botId)) {
          await existingReaction.users.remove(botId);
        }
      } catch (e) {
        // Ignore - reaction might not exist
      }
    }

    // Add the new reaction
    await message.react(reactionValue);
  } catch (e) {
    logger.debug({ msg: "Failed to set reaction", reaction: reactionValue, error: String(e) });
  }
}

/**
 * Clear all state reactions from a message
 */
async function clearMessageReactions(message: Message): Promise<void> {
  if (!client?.user) return;

  const botId = client.user.id;
  // Call functions to get current emoji values
  const stateReactions = [REACTION_QUEUED(), REACTION_ACTIVE(), REACTION_DONE(), REACTION_ERROR(), REACTION_CANCELLED()];

  for (const emoji of stateReactions) {
    try {
      const existingReaction = message.reactions.cache.get(emoji);
      if (existingReaction?.users.cache.has(botId)) {
        await existingReaction.users.remove(botId);
      }
    } catch (e) {
      // Ignore
    }
  }
}

// ============================================================================
// Typing Indicator Manager - Shows "Bot is typing..." during processing
// ============================================================================

interface TypingState {
  interval: NodeJS.Timeout | null;
  lastActivity: number;
  active: boolean;
}

const typingStates = new Map<string, TypingState>();
const TYPING_REFRESH_MS = 8000;  // Discord typing indicator lasts ~10s, refresh at 8s
const TYPING_IDLE_TIMEOUT_MS = 5000;  // Stop typing after 5s of no activity

/**
 * Start showing typing indicator in a channel.
 * Will auto-refresh every 8 seconds until stopped.
 */
async function startTyping(channel: TextChannel | ThreadChannel | DMChannel): Promise<void> {
  const channelId = channel.id;

  // Clean up any existing typing state
  stopTyping(channelId);

  const state: TypingState = {
    interval: null,
    lastActivity: Date.now(),
    active: true
  };

  // Send initial typing indicator
  try {
    await channel.sendTyping();
    logger.debug({ msg: "Typing indicator started", channelId });
  } catch (e) {
    logger.debug({ msg: "Failed to start typing indicator", channelId, error: String(e) });
    return;
  }

  // Set up refresh interval
  state.interval = setInterval(async () => {
    const now = Date.now();
    const idleTime = now - state.lastActivity;

    // Stop if idle for too long
    if (idleTime > TYPING_IDLE_TIMEOUT_MS) {
      logger.debug({ msg: "Typing indicator stopped (idle)", channelId, idleTime });
      stopTyping(channelId);
      return;
    }

    // Refresh typing indicator
    if (state.active) {
      try {
        await channel.sendTyping();
        logger.debug({ msg: "Typing indicator refreshed", channelId });
      } catch (e) {
        // Channel might be gone, stop typing
        stopTyping(channelId);
      }
    }
  }, TYPING_REFRESH_MS);

  typingStates.set(channelId, state);
}

/**
 * Update activity timestamp to prevent idle timeout.
 * Call this when receiving stream chunks.
 */
function tickTyping(channelId: string): void {
  const state = typingStates.get(channelId);
  if (state) {
    state.lastActivity = Date.now();
  }
}

/**
 * Stop showing typing indicator in a channel.
 */
function stopTyping(channelId: string): void {
  const state = typingStates.get(channelId);
  if (state) {
    state.active = false;
    if (state.interval) {
      clearInterval(state.interval);
      state.interval = null;
    }
    typingStates.delete(channelId);
    logger.debug({ msg: "Typing indicator stopped", channelId });
  }
}

const configSchema: ConfigSchema = {
  title: "Discord Integration",
  description: "Configure Discord bot integration with slash commands",
  fields: [
    { name: "token", type: "password", label: "Discord Bot Token", placeholder: "Bot token from Discord Developer Portal", required: true, description: "Your Discord bot token" },
    { name: "guildId", type: "text", label: "Guild ID (optional)", placeholder: "Server ID to restrict bot to", description: "Restrict bot to a specific Discord server" },
    { name: "clientId", type: "text", label: "Application ID", placeholder: "From Discord Developer Portal", description: "Discord Application ID (for slash commands)" },
    { name: "ownerUserId", type: "text", label: "Owner User ID (optional)", placeholder: "Your Discord user ID", description: "Receive private notifications for friend requests" },
    { name: "emojiQueued", type: "text", label: "Queued Emoji", placeholder: "🕐", default: "🕐", description: "Emoji shown when message is queued" },
    { name: "emojiActive", type: "text", label: "Active Emoji", placeholder: "⚡", default: "⚡", description: "Emoji shown when processing" },
    { name: "emojiDone", type: "text", label: "Done Emoji", placeholder: "✅", default: "✅", description: "Emoji shown when complete" },
    { name: "emojiError", type: "text", label: "Error Emoji", placeholder: "❌", default: "❌", description: "Emoji shown on error" },
    { name: "emojiCancelled", type: "text", label: "Cancelled Emoji", placeholder: "⏹️", default: "⏹️", description: "Emoji shown when cancelled" },
    { name: "pairingRequests", type: "object", hidden: true, default: {} },
    { name: "mappings", type: "object", hidden: true, default: {} },
  ],
};

// Session state management per channel
interface SessionState {
  thinkingLevel: string;
  verbose: boolean;
  usageMode: string;
  messageCount: number;
  model: string;
  lastBotInteraction?: Record<string, number>;  // botId -> timestamp for cooldown
}

const sessionStates = new Map<string, SessionState>();

function getSessionState(sessionKey: string): SessionState {
  if (!sessionStates.has(sessionKey)) {
    sessionStates.set(sessionKey, {
      thinkingLevel: "medium",
      verbose: false,
      usageMode: "tokens",
      messageCount: 0,
      model: "claude-sonnet-4-20250514"
    });
  }
  return sessionStates.get(sessionKey)!;
}

// ============================================================================
// Channel Message Queue System - Promise chain for sequential message processing
// ============================================================================

interface BufferedMessage {
  from: string;
  content: string;
  timestamp: number;
  isBot: boolean;
  isMention: boolean;  // was this bot directly @mentioned?
  originalMessage: Message;
}

interface QueuedInject {
  sessionKey: string;
  messageContent: string;
  authorDisplayName: string;
  replyToMessage: Message;
  isBot: boolean;
  queuedAt: number;
  cooldownUntil?: number;  // for bot messages only
}

interface ChannelQueue {
  buffer: BufferedMessage[];
  // Promise chain - each inject waits for the previous to complete
  processingChain: Promise<void>;
  // Pending items waiting to be added to chain (for bot cooldown/human typing)
  pendingItems: QueuedInject[];
  humanTypingUntil: number;
  // Track if we're currently processing (for /cancel)
  currentInject: { cancelled: boolean } | null;
}

const channelQueues = new Map<string, ChannelQueue>();
const HUMAN_TYPING_WINDOW_MS = 15000;  // 15s after human stops typing
const BOT_COOLDOWN_MS = 5000;          // 5s between bot responses

function getChannelQueue(channelId: string): ChannelQueue {
  if (!channelQueues.has(channelId)) {
    channelQueues.set(channelId, {
      buffer: [],
      processingChain: Promise.resolve(),
      pendingItems: [],
      humanTypingUntil: 0,
      currentInject: null
    });
  }
  return channelQueues.get(channelId)!;
}

function addToBuffer(channelId: string, msg: BufferedMessage) {
  const queue = getChannelQueue(channelId);
  queue.buffer.push(msg);
  // Keep buffer reasonable size (last 20 messages)
  if (queue.buffer.length > 20) {
    queue.buffer.shift();
  }
  logger.info({ msg: "Buffer add", channelId, from: msg.from, isBot: msg.isBot, isMention: msg.isMention, bufferSize: queue.buffer.length });
}

function getBufferContext(channelId: string): string {
  const queue = getChannelQueue(channelId);
  if (queue.buffer.length === 0) return "";

  // Build context from buffer (exclude the triggering message itself)
  const contextLines = queue.buffer.slice(0, -1).map(m => `${m.from}: ${m.content}`);
  if (contextLines.length === 0) return "";

  return `[Recent conversation context]\n${contextLines.join('\n')}\n[End context]\n\n`;
}

function clearBuffer(channelId: string) {
  const queue = getChannelQueue(channelId);
  queue.buffer = [];
}

function isHumanTyping(channelId: string): boolean {
  const queue = getChannelQueue(channelId);
  return Date.now() < queue.humanTypingUntil;
}

function setHumanTyping(channelId: string) {
  const queue = getChannelQueue(channelId);
  queue.humanTypingUntil = Date.now() + HUMAN_TYPING_WINDOW_MS;
  logger.info({ msg: "Human typing detected", channelId, pauseUntil: new Date(queue.humanTypingUntil).toISOString() });
}

/**
 * Queue an inject to the promise chain.
 * Human messages go directly to chain. Bot messages wait for cooldown.
 */
function queueInject(channelId: string, item: QueuedInject) {
  const queue = getChannelQueue(channelId);

  if (item.isBot) {
    // Bot messages: add to pending with cooldown, processor will add to chain
    item.cooldownUntil = Date.now() + BOT_COOLDOWN_MS;
    queue.pendingItems.push(item);
    // Show queued reaction
    setMessageReaction(item.replyToMessage, REACTION_QUEUED).catch(() => {});
    logger.info({ msg: "Bot inject queued (pending cooldown)", channelId, from: item.authorDisplayName, queueSize: queue.pendingItems.length });
  } else {
    // Human messages: add directly to promise chain (immediate priority)
    // Also clear any pending bot messages - human takes priority
    if (queue.pendingItems.length > 0) {
      logger.info({ msg: "Clearing pending bot messages - human priority", channelId, cleared: queue.pendingItems.length });
      // Clear queued reactions from cancelled bot messages
      for (const pending of queue.pendingItems) {
        clearMessageReactions(pending.replyToMessage).catch(() => {});
      }
      queue.pendingItems = [];
    }

    // Check if there's already something processing - if so, show queued first
    if (queue.currentInject) {
      setMessageReaction(item.replyToMessage, REACTION_QUEUED).catch(() => {});
    }

    addToChain(channelId, item);
    logger.info({ msg: "Human inject queued (direct to chain)", channelId, from: item.authorDisplayName });
  }
}

/**
 * Add an inject to the promise chain - it will execute after all previous injects complete.
 */
function addToChain(channelId: string, item: QueuedInject) {
  const queue = getChannelQueue(channelId);

  queue.processingChain = queue.processingChain.then(async () => {
    // Check if cancelled before starting
    if (queue.currentInject?.cancelled) {
      logger.info({ msg: "Inject skipped - queue was cancelled", channelId, from: item.authorDisplayName });
      return;
    }

    // Create cancellation token for this inject
    const cancelToken = { cancelled: false };
    queue.currentInject = cancelToken;

    try {
      await executeInjectInternal(item, cancelToken);
    } catch (error) {
      logger.error({ msg: "Chain inject failed", channelId, error: String(error) });
    } finally {
      // Clear current inject if it's still ours
      if (queue.currentInject === cancelToken) {
        queue.currentInject = null;
      }
    }
  });
}

/**
 * Cancel current and pending injects for a channel.
 * Returns true if there was something to cancel.
 */
function cancelChannelQueue(channelId: string): boolean {
  const queue = getChannelQueue(channelId);
  let hadSomething = false;

  // Cancel current inject (reaction will be set by executeInjectInternal when it detects cancellation)
  if (queue.currentInject) {
    queue.currentInject.cancelled = true;
    hadSomething = true;
    logger.info({ msg: "Current inject cancelled", channelId });
  }

  // Clear pending items and set cancelled reaction on each
  if (queue.pendingItems.length > 0) {
    hadSomething = true;
    logger.info({ msg: "Pending items cleared", channelId, count: queue.pendingItems.length });
    for (const item of queue.pendingItems) {
      setMessageReaction(item.replyToMessage, REACTION_CANCELLED).catch(() => {});
    }
    queue.pendingItems = [];
  }

  // Reset the chain to resolved (don't wait for cancelled items)
  queue.processingChain = Promise.resolve();

  return hadSomething;
}

/**
 * Get count of pending items in queue (for status display)
 */
function getQueuedCount(channelId: string): number {
  const queue = getChannelQueue(channelId);
  return queue.pendingItems.length + (queue.currentInject ? 1 : 0);
}

// Check and fire pending bot responses (called periodically)
async function processPendingBotResponses() {
  const now = Date.now();

  for (const [channelId, queue] of channelQueues.entries()) {
    // Skip if no pending items
    if (queue.pendingItems.length === 0) continue;

    // Skip if human is typing
    if (now < queue.humanTypingUntil) continue;

    // Find items ready to fire (past cooldown)
    const readyItems: QueuedInject[] = [];
    const stillPending: QueuedInject[] = [];

    for (const item of queue.pendingItems) {
      if (item.cooldownUntil && now < item.cooldownUntil) {
        stillPending.push(item);
      } else {
        readyItems.push(item);
      }
    }

    queue.pendingItems = stillPending;

    // Add ready items to chain
    for (const item of readyItems) {
      logger.info({ msg: "Moving pending item to chain", channelId, from: item.authorDisplayName });
      addToChain(channelId, item);
    }
  }
}

// Start periodic check for pending responses
let queueProcessorInterval: NodeJS.Timeout | null = null;
let cleanupInterval: NodeJS.Timeout | null = null;

function startQueueProcessor() {
  if (queueProcessorInterval) return;
  queueProcessorInterval = setInterval(() => {
    processPendingBotResponses().catch(err =>
      logger.error({ msg: "Queue processor error", error: String(err) })
    );
  }, 1000);  // Check every second
  logger.info({ msg: "Queue processor started" });
}

function startCleanupInterval() {
  if (cleanupInterval) return;
  // Clean up expired pairings and button requests every minute
  cleanupInterval = setInterval(() => {
    cleanupExpiredPairings();
    cleanupExpiredButtonRequests();
  }, 60000);
  logger.info({ msg: "Cleanup interval started" });
}

function stopQueueProcessor() {
  if (queueProcessorInterval) {
    clearInterval(queueProcessorInterval);
    queueProcessorInterval = null;
    logger.info({ msg: "Queue processor stopped" });
  }
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

// ============================================================================
// Channel Provider Implementation
// ============================================================================

// Registered commands and parsers from other plugins (e.g., P2P friend commands)
const registeredCommands: Map<string, ChannelCommand> = new Map();
const registeredParsers: Map<string, ChannelMessageParser> = new Map();

/**
 * Discord Channel Provider - allows other plugins to register commands and message parsers
 */
const discordChannelProvider: ChannelProvider = {
  id: "discord",

  registerCommand(cmd: ChannelCommand): void {
    registeredCommands.set(cmd.name, cmd);
    logger.info({ msg: "Channel command registered", name: cmd.name });
  },

  unregisterCommand(name: string): void {
    registeredCommands.delete(name);
  },

  getCommands(): ChannelCommand[] {
    return Array.from(registeredCommands.values());
  },

  addMessageParser(parser: ChannelMessageParser): void {
    registeredParsers.set(parser.id, parser);
    logger.info({ msg: "Message parser registered", id: parser.id });
  },

  removeMessageParser(id: string): void {
    registeredParsers.delete(id);
  },

  getMessageParsers(): ChannelMessageParser[] {
    return Array.from(registeredParsers.values());
  },

  async send(channelId: string, content: string): Promise<void> {
    if (!client) throw new Error("Discord client not initialized");
    const channel = await client.channels.fetch(channelId);
    if (channel && channel.isTextBased() && 'send' in channel) {
      // Split content into chunks of 2000 chars (Discord limit)
      const chunks: string[] = [];
      let remaining = content;
      while (remaining.length > 0) {
        if (remaining.length <= 2000) {
          chunks.push(remaining);
          break;
        }
        // Try to split at a newline or space near the limit
        let splitAt = remaining.lastIndexOf('\n', 2000);
        if (splitAt < 1500) splitAt = remaining.lastIndexOf(' ', 2000);
        if (splitAt < 1500) splitAt = 2000;
        chunks.push(remaining.slice(0, splitAt));
        remaining = remaining.slice(splitAt).trimStart();
      }
      for (const chunk of chunks) {
        if (chunk.trim()) {
          await channel.send(chunk);
        }
      }
    }
  },

  getBotUsername(): string {
    return client?.user?.username || "unknown";
  },
};

/**
 * Send a friend request notification to the owner with Accept/Deny buttons.
 * Returns true if notification was sent, false if no owner configured.
 */
async function sendFriendRequestNotification(
  requestFrom: string,
  pubkey: string,
  encryptPub: string,
  channelId: string,
  channelName: string,
  signature: string
): Promise<boolean> {
  if (!ctx || !client) return false;

  const config = ctx.getConfig<{ ownerUserId?: string }>();
  if (!config.ownerUserId) {
    logger.warn({ msg: "No ownerUserId configured - friend request notification not sent" });
    return false;
  }

  try {
    // Fetch the owner user
    const owner = await client.users.fetch(config.ownerUserId);
    if (!owner) {
      logger.warn({ msg: "Could not fetch owner user", ownerUserId: config.ownerUserId });
      return false;
    }

    // Store pending request for button handling
    storePendingButtonRequest(requestFrom, pubkey, encryptPub, channelId, signature);

    // Create the embed and buttons
    const pubkeyShort = pubkey.slice(0, 12) + "...";
    const embed = createFriendRequestEmbed(requestFrom, pubkeyShort, channelName);
    const buttons = createFriendRequestButtons(requestFrom);

    // Send DM to owner
    await owner.send({
      embeds: [embed],
      components: [buttons],
    });

    logger.info({ msg: "Friend request notification sent to owner", requestFrom, ownerUserId: config.ownerUserId });
    return true;
  } catch (err) {
    logger.error({ msg: "Failed to send friend request notification", error: String(err) });
    return false;
  }
}

// Expose Discord extension to other plugins and CLI
const discordExtension = {
  sendFriendRequestNotification,
  getBotUsername: () => client?.user?.username || "unknown",

  // Pairing methods for CLI
  claimOwnership: async (code: string): Promise<{ success: boolean; userId?: string; username?: string; error?: string }> => {
    if (!ctx) return { success: false, error: "Discord plugin not initialized" };

    const request = claimPairingCode(code);
    if (!request) {
      return { success: false, error: "Invalid or expired pairing code" };
    }

    // Set the owner in config
    await setOwner(ctx, request.discordUserId);

    return {
      success: true,
      userId: request.discordUserId,
      username: request.discordUsername,
    };
  },

  hasOwner: () => ctx ? hasOwner(ctx) : false,
  getOwnerId: () => ctx?.getConfig<{ ownerUserId?: string }>()?.ownerUserId || null,
};

/**
 * Check if a message matches a registered command and handle it
 * Returns true if handled, false otherwise
 */
async function handleRegisteredCommand(message: Message): Promise<boolean> {
  const content = message.content.trim();

  // Check for /command format
  if (!content.startsWith("/")) return false;

  const parts = content.slice(1).split(/\s+/);
  const cmdName = parts[0].toLowerCase();
  const args = parts.slice(1);

  const cmd = registeredCommands.get(cmdName);
  if (!cmd) return false;

  const channelId = message.channelId;

  const cmdCtx: ChannelCommandContext = {
    channel: channelId,
    channelType: "discord",
    sender: message.author.username,
    args,
    reply: async (msg: string) => {
      await message.reply(msg);
    },
    getBotUsername: () => client?.user?.username || "unknown",
  };

  try {
    await cmd.handler(cmdCtx);
    return true;
  } catch (error) {
    logger.error({ msg: "Channel command error", cmd: cmdName, error: String(error) });
    await message.reply(`Error executing /${cmdName}: ${error}`);
    return true;  // Still handled, just with error
  }
}

/**
 * Check if a message matches any registered parser and handle it
 * Returns true if handled, false otherwise
 */
async function handleRegisteredParsers(message: Message): Promise<boolean> {
  const content = message.content;
  const channelId = message.channelId;

  for (const parser of registeredParsers.values()) {
    let matches = false;

    if (typeof parser.pattern === "function") {
      matches = parser.pattern(content);
    } else {
      matches = parser.pattern.test(content);
    }

    if (matches) {
      const msgCtx: ChannelMessageContext = {
        channel: channelId,
        channelType: "discord",
        sender: message.author.username,
        content,
        reply: async (msg: string) => {
          await message.reply(msg);
        },
        getBotUsername: () => client?.user?.username || "unknown",
      };

      try {
        await parser.handler(msgCtx);
        return true;
      } catch (error) {
        logger.error({ msg: "Message parser error", id: parser.id, error: String(error) });
        // Don't reply with error for parsers - they're silent watchers
        return false;
      }
    }
  }

  return false;
}

// Discord streaming message handler with explicit state machine
const DISCORD_LIMIT = 2000;
const EDIT_THRESHOLD = 800;
const IDLE_SPLIT_MS = 1000;
const FLUSH_DEBOUNCE_MS = 300;

// Explicit state machine - each state is mutually exclusive
type MessageState =
  | { status: 'buffering'; content: string }
  | { status: 'sending'; content: string; promise: Promise<Message> }
  | { status: 'sent'; content: string; discordMsg: Message; lastEditLength: number }
  | { status: 'finalized' };

/**
 * Manages a single Discord message's lifecycle with edit-in-place support.
 * Uses explicit state machine to prevent race conditions.
 */
class DiscordMessageUnit {
  private state: MessageState = { status: 'buffering', content: '' };
  private readonly channel: TextChannel | ThreadChannel | DMChannel;
  private readonly replyTo: Message;
  private readonly isReply: boolean;
  private readonly unitId: string;

  constructor(
    channel: TextChannel | ThreadChannel | DMChannel,
    replyTo: Message,
    isReply: boolean
  ) {
    this.channel = channel;
    this.replyTo = replyTo;
    this.isReply = isReply;
    this.unitId = Math.random().toString(36).slice(2, 8);
    logger.debug({ msg: "DiscordMessageUnit created", unitId: this.unitId, isReply });
  }

  get content(): string {
    if (this.state.status === 'finalized') return '';
    return this.state.content;
  }

  get isFinalized(): boolean {
    return this.state.status === 'finalized';
  }

  get discordMsg(): Message | null {
    if (this.state.status === 'sent') return this.state.discordMsg;
    return null;
  }

  append(text: string): void {
    if (this.state.status === 'finalized') {
      logger.debug({ msg: "Unit.append ignored - finalized", unitId: this.unitId, textLen: text.length });
      return;
    }
    if (this.state.status === 'sending') {
      logger.debug({ msg: "Unit.append ignored - sending", unitId: this.unitId, textLen: text.length });
      return;
    }
    const prevLen = this.state.content.length;
    this.state = { ...this.state, content: this.state.content + text };
    logger.debug({ msg: "Unit.append", unitId: this.unitId, added: text.length, totalLen: this.state.content.length, prevLen });
  }

  /**
   * Attempt to flush content to Discord.
   * Returns 'split' if content exceeded limit and needs continuation.
   */
  async flush(): Promise<'ok' | 'split' | 'skip'> {
    if (this.state.status === 'finalized') {
      logger.debug({ msg: "Unit.flush skip - finalized", unitId: this.unitId });
      return 'skip';
    }
    if (this.state.status === 'sending') {
      logger.debug({ msg: "Unit.flush skip - sending", unitId: this.unitId });
      return 'skip';
    }

    const content = this.state.content.trim();
    if (!content) {
      logger.debug({ msg: "Unit.flush skip - empty", unitId: this.unitId });
      return 'skip';
    }

    logger.debug({ msg: "Unit.flush", unitId: this.unitId, status: this.state.status, contentLen: content.length });

    // Handle overflow - need to split
    if (content.length > DISCORD_LIMIT) {
      logger.debug({ msg: "Unit.flush overflow", unitId: this.unitId, contentLen: content.length });
      return this.handleOverflow(content);
    }

    // In buffering state - check if we have enough to send initial message
    if (this.state.status === 'buffering') {
      if (content.length < EDIT_THRESHOLD) {
        logger.debug({ msg: "Unit.flush skip - below threshold", unitId: this.unitId, contentLen: content.length, threshold: EDIT_THRESHOLD });
        return 'skip';
      }
      return this.sendInitial(content);
    }

    // In sent state - check if we have enough new content to edit
    if (this.state.status === 'sent') {
      const newChars = content.length - this.state.lastEditLength;
      if (newChars < EDIT_THRESHOLD) {
        logger.debug({ msg: "Unit.flush skip - not enough new chars", unitId: this.unitId, newChars, threshold: EDIT_THRESHOLD });
        return 'skip';
      }
      return this.editExisting(content);
    }

    return 'skip';
  }

  private async sendInitial(content: string): Promise<'ok' | 'split' | 'skip'> {
    if (this.state.status !== 'buffering') return 'skip';

    logger.debug({ msg: "Unit.sendInitial", unitId: this.unitId, contentLen: content.length, isReply: this.isReply });

    // Transition: buffering → sending
    const promise = this.isReply
      ? this.replyTo.reply(content)
      : this.channel.send(content);
    this.state = { status: 'sending', content, promise };

    try {
      const discordMsg = await promise;
      // Transition: sending → sent
      this.state = { status: 'sent', content, discordMsg, lastEditLength: content.length };
      logger.debug({ msg: "Unit.sendInitial success", unitId: this.unitId, msgId: discordMsg.id });
      return 'ok';
    } catch (error) {
      // Rollback to buffering on failure
      this.state = { status: 'buffering', content };
      logger.error({ msg: "Unit.sendInitial failed", unitId: this.unitId, error: String(error) });
      throw error;
    }
  }

  private async editExisting(content: string): Promise<'ok' | 'split' | 'skip'> {
    if (this.state.status !== 'sent') return 'skip';

    logger.debug({ msg: "Unit.editExisting", unitId: this.unitId, contentLen: content.length });
    await this.state.discordMsg.edit(content);
    this.state = { ...this.state, content, lastEditLength: content.length };
    logger.debug({ msg: "Unit.editExisting success", unitId: this.unitId });
    return 'ok';
  }

  private async handleOverflow(content: string): Promise<'ok' | 'split' | 'skip'> {
    const toSend = content.slice(0, DISCORD_LIMIT);
    const overflow = content.slice(DISCORD_LIMIT);
    logger.debug({ msg: "Unit.handleOverflow", unitId: this.unitId, toSendLen: toSend.length, overflowLen: overflow.length });

    if (this.state.status === 'buffering') {
      // Send initial with truncated content
      const promise = this.isReply
        ? this.replyTo.reply(toSend)
        : this.channel.send(toSend);
      this.state = { status: 'sending', content: toSend, promise };

      try {
        await promise;
        // Mark as finalized - overflow will be new message
        this.state = { status: 'finalized' };
        logger.debug({ msg: "Unit.handleOverflow sent and finalized", unitId: this.unitId });
      } catch (error) {
        this.state = { status: 'buffering', content };
        logger.error({ msg: "Unit.handleOverflow failed", unitId: this.unitId, error: String(error) });
        throw error;
      }
    } else if (this.state.status === 'sent') {
      await this.state.discordMsg.edit(toSend);
      this.state = { status: 'finalized' };
      logger.debug({ msg: "Unit.handleOverflow edited and finalized", unitId: this.unitId });
    }

    // Signal that we have overflow content for a new message
    return 'split';
  }

  /**
   * Finalize this message - send/edit with final content.
   * Safe to call multiple times.
   */
  async finalize(): Promise<void> {
    logger.debug({ msg: "Unit.finalize called", unitId: this.unitId, status: this.state.status, contentLen: this.state.status !== 'finalized' ? this.state.content.length : 0 });

    if (this.state.status === 'finalized') {
      logger.debug({ msg: "Unit.finalize skip - already finalized", unitId: this.unitId });
      return;
    }

    // Wait for any in-flight send to complete
    if (this.state.status === 'sending') {
      logger.debug({ msg: "Unit.finalize waiting for send", unitId: this.unitId });
      try {
        const discordMsg = await this.state.promise;
        this.state = { status: 'sent', content: this.state.content, discordMsg, lastEditLength: this.state.content.length };
        logger.debug({ msg: "Unit.finalize send completed", unitId: this.unitId, msgId: discordMsg.id });
      } catch (error) {
        logger.error({ msg: "Unit.finalize send failed", unitId: this.unitId, error: String(error) });
        this.state = { status: 'finalized' };
        return;
      }
    }

    const content = this.state.content.trim();
    if (!content) {
      logger.debug({ msg: "Unit.finalize skip - empty content", unitId: this.unitId });
      this.state = { status: 'finalized' };
      return;
    }

    // Immediately mark as finalized to prevent races
    const prevState = this.state;
    this.state = { status: 'finalized' };

    try {
      if (prevState.status === 'sent') {
        logger.debug({ msg: "Unit.finalize editing sent message", unitId: this.unitId, contentLen: content.length });
        await prevState.discordMsg.edit(content.slice(0, DISCORD_LIMIT));
        logger.debug({ msg: "Unit.finalize edit success", unitId: this.unitId });
      } else if (prevState.status === 'buffering') {
        logger.debug({ msg: "Unit.finalize sending buffered content", unitId: this.unitId, contentLen: content.length, isReply: this.isReply });
        const msg = this.isReply
          ? await this.replyTo.reply(content.slice(0, DISCORD_LIMIT))
          : await this.channel.send(content.slice(0, DISCORD_LIMIT));
        // Already finalized, but store reference if needed
        (this as any)._finalMsg = msg;
        logger.debug({ msg: "Unit.finalize send success", unitId: this.unitId, msgId: msg.id });
      }
    } catch (error) {
      logger.error({ msg: "Unit.finalize failed", unitId: this.unitId, error: String(error) });
    }
  }

  /**
   * Get overflow content after a split (content that exceeded DISCORD_LIMIT)
   */
  getOverflow(originalContent: string): string {
    return originalContent.slice(DISCORD_LIMIT);
  }
}

/**
 * Coordinates streaming of potentially multiple Discord messages.
 * Handles idle-split, overflow, and debounced flushing.
 */
class DiscordMessageStream {
  private currentUnit: DiscordMessageUnit;
  private completedUnits: DiscordMessageUnit[] = [];
  private readonly channel: TextChannel | ThreadChannel | DMChannel;
  private readonly replyTo: Message;
  private readonly streamId: string;

  private lastAppendTime = Date.now();
  private flushTimer: NodeJS.Timeout | null = null;
  private pendingContent: string[] = [];
  private processing = false;
  private finalized = false;

  constructor(channel: TextChannel | ThreadChannel | DMChannel, replyTo: Message) {
    this.channel = channel;
    this.replyTo = replyTo;
    this.streamId = Math.random().toString(36).slice(2, 8);
    this.currentUnit = new DiscordMessageUnit(channel, replyTo, true); // First message is reply
    logger.info({ msg: "Stream created", streamId: this.streamId, channelId: channel.id });
  }

  /**
   * Add content from a stream chunk.
   */
  append(text: string): void {
    if (this.finalized) {
      logger.debug({ msg: "Stream.append ignored - finalized", streamId: this.streamId, textLen: text.length });
      return;
    }
    this.pendingContent.push(text);
    const totalPending = this.pendingContent.reduce((sum, t) => sum + t.length, 0);
    const currentUnitLen = this.currentUnit.content.length;
    const totalContent = totalPending + currentUnitLen;

    logger.debug({ msg: "Stream.append", streamId: this.streamId, textLen: text.length, totalContent, pendingCount: this.pendingContent.length });

    // If we have enough content to send, process immediately
    if (totalContent >= EDIT_THRESHOLD) {
      logger.debug({ msg: "Stream.append - threshold reached, processing immediately", streamId: this.streamId, totalContent, threshold: EDIT_THRESHOLD });
      this.scheduleProcessing(true); // immediate
    } else {
      this.scheduleProcessing(false); // debounced
    }
  }

  private scheduleProcessing(immediate: boolean = false): void {
    if (this.processing) {
      logger.debug({ msg: "Stream.scheduleProcessing - already processing", streamId: this.streamId });
      return;
    }

    // Clear any existing timer
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (immediate) {
      // Process on next tick to allow current call stack to complete
      logger.debug({ msg: "Stream.scheduleProcessing - immediate", streamId: this.streamId });
      setImmediate(() => this.processPending());
    } else {
      // Debounce flush to batch rapid chunks when below threshold
      logger.debug({ msg: "Stream.scheduleProcessing - debounced", streamId: this.streamId, debounceMs: FLUSH_DEBOUNCE_MS });
      this.flushTimer = setTimeout(() => this.processPending(), FLUSH_DEBOUNCE_MS);
    }
  }

  private async processPending(): Promise<void> {
    if (this.processing || this.finalized) {
      logger.debug({ msg: "Stream.processPending skip", streamId: this.streamId, processing: this.processing, finalized: this.finalized });
      return;
    }
    this.processing = true;
    logger.debug({ msg: "Stream.processPending start", streamId: this.streamId, pendingCount: this.pendingContent.length });

    try {
      while (this.pendingContent.length > 0) {
        const text = this.pendingContent.shift()!;
        await this.processText(text);
      }
      logger.debug({ msg: "Stream.processPending complete", streamId: this.streamId });
    } catch (error) {
      logger.error({ msg: "Stream processing error", streamId: this.streamId, error: String(error) });
    } finally {
      this.processing = false;
    }
  }

  private async processText(text: string): Promise<void> {
    const now = Date.now();
    const timeSinceLast = now - this.lastAppendTime;
    this.lastAppendTime = now;

    logger.debug({ msg: "Stream.processText", streamId: this.streamId, textLen: text.length, timeSinceLast });

    // Idle split: long pause with existing content → start new message
    if (timeSinceLast > IDLE_SPLIT_MS && this.currentUnit.content.length > 0) {
      logger.info({ msg: "Stream idle split", streamId: this.streamId, timeSinceLast, unitContent: this.currentUnit.content.length });
      await this.currentUnit.finalize();
      this.completedUnits.push(this.currentUnit);
      this.currentUnit = new DiscordMessageUnit(this.channel, this.replyTo, false);
    }

    // Add content to current unit
    this.currentUnit.append(text);

    // Handle content that exceeds Discord limit - may need multiple messages
    await this.flushWithOverflowHandling();
  }

  /**
   * Flush current unit, handling overflow by creating new units as needed.
   */
  private async flushWithOverflowHandling(): Promise<void> {
    while (true) {
      const currentContent = this.currentUnit.content;
      const result = await this.currentUnit.flush();
      logger.debug({ msg: "Stream.flushWithOverflowHandling result", streamId: this.streamId, result, contentLen: currentContent.length });

      if (result === 'split') {
        // Unit sent first 2000 chars and finalized - extract overflow for new unit
        const overflow = currentContent.slice(DISCORD_LIMIT);
        logger.info({ msg: "Stream overflow split", streamId: this.streamId, overflowLen: overflow.length });
        this.completedUnits.push(this.currentUnit);
        this.currentUnit = new DiscordMessageUnit(this.channel, this.replyTo, false);

        if (overflow.length > 0) {
          this.currentUnit.append(overflow);
          // Continue loop to handle if overflow itself exceeds limit
        } else {
          break;
        }
      } else {
        // 'ok' or 'skip' - no overflow, we're done
        break;
      }
    }
  }

  /**
   * Finalize the entire stream - flush any remaining content.
   */
  async finalize(): Promise<void> {
    logger.info({ msg: "Stream.finalize called", streamId: this.streamId, finalized: this.finalized, processing: this.processing, pendingCount: this.pendingContent.length });

    if (this.finalized) {
      logger.debug({ msg: "Stream.finalize skip - already finalized", streamId: this.streamId });
      return;
    }

    // Cancel any pending flush timer (we'll process everything now)
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
      logger.debug({ msg: "Stream.finalize cancelled pending flush timer", streamId: this.streamId });
    }

    // Wait for any ongoing processing to complete
    if (this.processing) {
      logger.info({ msg: "Stream.finalize waiting for processing to complete", streamId: this.streamId });
      // Poll until processing completes (processPending sets processing=false in finally block)
      let waitCount = 0;
      while (this.processing && waitCount < 100) { // Max 10 seconds
        await new Promise(resolve => setTimeout(resolve, 100));
        waitCount++;
      }
      if (this.processing) {
        logger.warn({ msg: "Stream.finalize timed out waiting for processing", streamId: this.streamId });
      } else {
        logger.debug({ msg: "Stream.finalize processing completed", streamId: this.streamId, waitCount });
      }
    }

    this.finalized = true;

    // Process any remaining pending content
    const remainingCount = this.pendingContent.length;
    if (remainingCount > 0) {
      logger.debug({ msg: "Stream.finalize processing remaining content", streamId: this.streamId, remainingCount });
      while (this.pendingContent.length > 0) {
        const text = this.pendingContent.shift()!;
        this.currentUnit.append(text);
      }
      // Flush with overflow handling for any accumulated content
      await this.flushWithOverflowHandling();
    }

    // Finalize current unit
    logger.debug({ msg: "Stream.finalize finalizing current unit", streamId: this.streamId, unitContent: this.currentUnit.content.length });
    await this.currentUnit.finalize();
    logger.info({ msg: "Stream.finalize complete", streamId: this.streamId, completedUnits: this.completedUnits.length + 1 });
  }

  /**
   * Get the last Discord message (for appending usage stats, etc.)
   */
  getLastMessage(): Message | null {
    const msg = this.currentUnit.discordMsg;
    logger.debug({ msg: "Stream.getLastMessage", streamId: this.streamId, hasMsg: !!msg });
    return msg;
  }
}

// Stream registry - one stream per session
const streams = new Map<string, DiscordMessageStream>();

/**
 * Handle an incoming stream chunk.
 */
async function handleChunk(msg: StreamMessage, sessionKey: string): Promise<void> {
  const stream = streams.get(sessionKey);
  if (!stream) {
    logger.warn({ msg: "handleChunk - no stream found", sessionKey, msgType: msg.type });
    return;
  }

  // Handle system messages (including auto-compaction notifications)
  if (msg.type === "system" && msg.subtype === "compact_boundary") {
    const metadata = msg.metadata as { pre_tokens?: number; trigger?: string } | undefined;
    logger.info({ msg: "handleChunk - auto-compaction detected", sessionKey, metadata });

    // Only notify for auto-compaction (not manual /compact which has its own handler)
    if (metadata?.trigger === "auto") {
      // Send a notification about auto-compaction
      let notification = "📦 **Auto-Compaction**\n";
      if (metadata.pre_tokens) {
        notification += `Context compressed from ~${Math.round(metadata.pre_tokens / 1000)}k tokens`;
      } else {
        notification += "Context has been automatically compressed";
      }

      // Append notification to the stream so it appears inline with the response
      stream.append(`\n\n${notification}\n\n`);
    }
    return;
  }

  // Extract text content from various message formats
  let textContent = "";
  if (msg.type === "text" && msg.content) {
    textContent = msg.content;
    logger.debug({ msg: "handleChunk - text content", sessionKey, contentLen: textContent.length });
  } else if (msg.type === "assistant" && (msg as any).message?.content) {
    const content = (msg as any).message.content;
    if (Array.isArray(content)) {
      textContent = content.map((c: any) => c.text || "").join("");
    } else if (typeof content === "string") {
      textContent = content;
    }
    logger.debug({ msg: "handleChunk - assistant content", sessionKey, contentLen: textContent.length });
  } else {
    logger.debug({ msg: "handleChunk - skipping non-text", sessionKey, msgType: msg.type });
  }

  if (textContent) {
    stream.append(textContent);
  }
}

// Attachments directory
const ATTACHMENTS_DIR = existsSync("/data") ? "/data/attachments" : path.join(process.cwd(), "attachments");

/**
 * Download and save message attachments to disk
 * Returns array of file paths
 */
async function saveAttachments(message: Message): Promise<string[]> {
  if (!message.attachments.size) return [];

  // Ensure attachments directory exists
  if (!existsSync(ATTACHMENTS_DIR)) {
    mkdirSync(ATTACHMENTS_DIR, { recursive: true });
  }

  const savedPaths: string[] = [];

  for (const [, attachment] of message.attachments) {
    try {
      // Create unique filename: timestamp-originalname
      const timestamp = Date.now();
      const safeName = attachment.name?.replace(/[^a-zA-Z0-9._-]/g, "_") || "attachment";
      const filename = `${timestamp}-${message.author.id}-${safeName}`;
      const filepath = path.join(ATTACHMENTS_DIR, filename);

      // Download the attachment
      const response = await fetch(attachment.url);
      if (!response.ok) {
        logger.warn({ msg: "Failed to download attachment", url: attachment.url, status: response.status });
        continue;
      }

      // Save to disk
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

// Handle slash commands
async function handleSlashCommand(interaction: ChatInputCommandInteraction) {
  if (!ctx || !client) return;

  const { commandName } = interaction;
  const sessionKey = getSessionKeyFromInteraction(interaction);
  const state = getSessionState(sessionKey);
  
  logger.info({ msg: "Slash command received", command: commandName, user: interaction.user.tag });
  
  switch (commandName) {
    case "status": {
      const sessionInfo = await getSessionInfo(sessionKey);
      await interaction.reply({
        content: `📊 **Session Status**\n\n` +
          `**Session:** ${sessionKey}\n` +
          `**Thinking Level:** ${state.thinkingLevel}\n` +
          `**Verbose Mode:** ${state.verbose ? "On" : "Off"}\n` +
          `**Usage Tracking:** ${state.usageMode}\n` +
          `**Messages:** ${state.messageCount}\n` +
          `${sessionInfo}`,
        ephemeral: true
      });
      break;
    }
    
    case "new":
    case "reset": {
      // Reset the session
      sessionStates.delete(sessionKey);
      streams.delete(sessionKey);
      await interaction.reply({
        content: "🔄 **Session Reset**\n\nStarting fresh! Your conversation history has been cleared.",
        ephemeral: false
      });
      break;
    }
    
    case "compact": {
      await interaction.reply({
        content: "📦 **Compacting Session**\n\nTriggering context compaction...",
        ephemeral: false
      });

      try {
        let compactMetadata: { pre_tokens?: number; trigger?: string } | undefined;

        // Inject the actual /compact command to trigger Claude Code's internal compaction
        const result = await ctx.inject(sessionKey, "/compact", {
          silent: true,
          onStream: (msg: StreamMessage) => {
            // Capture compact_boundary metadata if available
            if (msg.type === "system" && msg.subtype === "compact_boundary" && msg.metadata) {
              compactMetadata = msg.metadata as { pre_tokens?: number; trigger?: string };
            }
          }
        });

        // Build response with metadata if available
        let response = "📦 **Session Compacted**\n\n";
        if (compactMetadata) {
          if (compactMetadata.pre_tokens) {
            response += `Compressed from ~${Math.round(compactMetadata.pre_tokens / 1000)}k tokens\n`;
          }
          response += `Trigger: ${compactMetadata.trigger || "manual"}`;
        } else {
          response += result || "Context has been compacted.";
        }

        await interaction.editReply(response);
      } catch (e) {
        await interaction.editReply("❌ Failed to compact session.");
      }
      break;
    }
    
    case "think": {
      const level = interaction.options.getString("level", true);
      state.thinkingLevel = level;
      const levelEmoji = { off: "🛑", minimal: "💡", low: "🤔", medium: "🧠", high: "🔬", xhigh: "🔮" }[level] || "🧠";
      await interaction.reply({
        content: `${levelEmoji} **Thinking level set to:** ${level}`,
        ephemeral: true
      });
      break;
    }
    
    case "verbose": {
      const enabled = interaction.options.getBoolean("enabled", true);
      state.verbose = enabled;
      await interaction.reply({
        content: enabled ? "🔊 **Verbose mode enabled**" : "🔇 **Verbose mode disabled**",
        ephemeral: true
      });
      break;
    }
    
    case "usage": {
      const mode = interaction.options.getString("mode", true);
      state.usageMode = mode;
      await interaction.reply({
        content: `📈 **Usage tracking set to:** ${mode}`,
        ephemeral: true
      });
      break;
    }
    
    case "session": {
      const name = interaction.options.getString("name", true);
      const baseKey = getSessionKeyFromInteraction(interaction);
      const newSessionKey = `${baseKey}/${name}`;
      await interaction.reply({
        content: `💬 **Switched to session:** ${newSessionKey}\n\nNote: Each session maintains separate context.`,
        ephemeral: false
      });
      break;
    }
    
    case "wopr": {
      const message = interaction.options.getString("message", true);
      await handleWoprMessage(interaction, message);
      break;
    }
    
    case "help": {
      await interaction.reply({
        content: `**🤖 WOPR Discord Commands**\n\n` +
          `**/status** - Show session status\n` +
          `**/new** or **/reset** - Start fresh session\n` +
          `**/compact** - Summarize conversation\n` +
          `**/think <level>** - Set thinking level (off/minimal/low/medium/high/xhigh)\n` +
          `**/verbose <on/off>** - Toggle verbose mode\n` +
          `**/usage <mode>** - Set usage tracking (off/tokens/full)\n` +
          `**/model <model>** - Switch AI model (sonnet/opus/haiku)\n` +
          `**/cancel** - Stop the current AI response\n` +
          `**/session <name>** - Switch to named session\n` +
          `**/wopr <message>** - Send message to WOPR\n` +
          `**/claim <code>** - Claim bot ownership (DM only)\n` +
          `**/help** - Show this help\n\n` +
          `You can also mention me (@${client.user?.username}) to chat!`,
        ephemeral: true
      });
      break;
    }

    case "claim": {
      // Only allow in DMs
      if (interaction.channel?.type !== 1) {
        await interaction.reply({
          content: "❌ The /claim command only works in DMs. Please DM me to claim ownership.",
          ephemeral: true
        });
        break;
      }

      // Check if owner already set
      if (hasOwner(ctx)) {
        await interaction.reply({
          content: "❌ This bot already has an owner configured.",
          ephemeral: true
        });
        break;
      }

      const code = interaction.options.getString("code", true);
      const result = await discordExtension.claimOwnership(code);

      if (result.success) {
        await interaction.reply({
          content: `✅ **Ownership claimed!**\n\nYou are now the owner of this bot.\n\n` +
            `**User ID:** ${result.userId}\n` +
            `**Username:** ${result.username}\n\n` +
            `You will receive private notifications for friend requests and other owner-only features.`,
          ephemeral: false
        });
        logger.info({ msg: "Bot ownership claimed", userId: result.userId, username: result.username });
      } else {
        await interaction.reply({
          content: `❌ **Claim failed:** ${result.error}\n\nMake sure you're using the correct code and it hasn't expired.`,
          ephemeral: true
        });
      }
      break;
    }

    case "cancel": {
      const channelId = interaction.channelId;

      // Cancel the channel queue (current + pending)
      const queueCancelled = cancelChannelQueue(channelId);

      // Also try to cancel the injection via WOPR
      let woprCancelled = false;
      if (ctx.cancelInject) {
        woprCancelled = ctx.cancelInject(sessionKey);
      }

      // Finalize and clean up any existing stream
      const existingStream = streams.get(sessionKey);
      if (existingStream) {
        logger.info({ msg: "Cancel command - finalizing stream", sessionKey });
        await existingStream.finalize();
        streams.delete(sessionKey);
      }

      const pendingCount = getQueuedCount(channelId);
      if (queueCancelled || woprCancelled || existingStream) {
        let msg = "⏹️ **Cancelled**\n\nThe current response has been stopped.";
        if (pendingCount > 0) {
          msg += `\n\n_${pendingCount} queued message(s) also cleared._`;
        }
        await interaction.reply({
          content: msg,
          ephemeral: false
        });
      } else {
        await interaction.reply({
          content: "ℹ️ **Nothing to cancel**\n\nNo response is currently in progress.",
          ephemeral: true
        });
      }
      break;
    }

    case "model": {
      const modelChoice = interaction.options.getString("model", true);

      // Resolve simple names to model IDs (fetched from config or use latest)
      const modelMap: Record<string, { id: string; name: string; emoji: string }> = {
        haiku: { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5", emoji: "⚡" },
        sonnet: { id: "claude-sonnet-4-5-20250929", name: "Sonnet 4.5", emoji: "🧠" },
        opus: { id: "claude-opus-4-5-20251101", name: "Opus 4.5", emoji: "🔮" },
      };

      const modelInfo = modelMap[modelChoice];
      if (!modelInfo) {
        await interaction.reply({
          content: `❌ Unknown model: ${modelChoice}`,
          ephemeral: true
        });
        break;
      }

      state.model = modelInfo.id;

      // Update the session's provider model through WOPR context
      try {
        if (ctx.setSessionProvider) {
          await ctx.setSessionProvider(sessionKey, "anthropic", { model: modelInfo.id });
        } else {
          // Fallback: use CLI via child_process (runs inside container)
          const { exec } = await import("child_process");
          const { promisify } = await import("util");
          const execAsync = promisify(exec);
          await execAsync(
            `node /app/dist/cli.js session set-provider ${sessionKey} anthropic --model ${modelInfo.id}`
          );
        }

        await interaction.reply({
          content: `${modelInfo.emoji} **Model switched to:** ${modelInfo.name}\n\nAll future responses will use this model.`,
          ephemeral: false
        });
      } catch (e) {
        logger.error({ msg: "Failed to switch model", error: String(e) });
        await interaction.reply({
          content: `❌ Failed to switch model: ${e}`,
          ephemeral: true
        });
      }
      break;
    }

    default: {
      // Check if this is a dynamically registered command from another plugin
      const registeredCmd = registeredCommands.get(commandName);
      if (registeredCmd) {
        // Build args from interaction options, resolving Discord mentions to usernames
        const args: string[] = [];
        for (const option of interaction.options.data) {
          if (option.value !== undefined) {
            let value = String(option.value);
            // Check for Discord user mention format <@USER_ID> or <@!USER_ID> and resolve to username
            const mentionMatch = value.match(/^<@!?(\d+)>$/);
            if (mentionMatch && client) {
              try {
                const user = await client.users.fetch(mentionMatch[1]);
                if (user) {
                  value = user.username;  // Use the actual username
                  logger.info({ msg: "Resolved mention to username", original: String(option.value), resolved: value });
                }
              } catch (err) {
                logger.warn({ msg: "Failed to resolve mention to username", value, error: String(err) });
                // Fall back to stripping mention format manually
                value = value.replace(/^<@!?/, "").replace(/>$/, "");
              }
            }
            args.push(value);
          }
        }

        // Create a reply function that handles the interaction
        let replied = false;
        const reply = async (msg: string) => {
          if (!replied) {
            await interaction.reply({ content: msg, ephemeral: false });
            replied = true;
          } else {
            await interaction.followUp({ content: msg, ephemeral: false });
          }
        };

        try {
          // Execute the channel command handler
          await registeredCmd.handler({
            channel: interaction.channelId,
            channelType: "discord",
            sender: interaction.user.username,
            args,
            reply,
            getBotUsername: () => client?.user?.username || "unknown",
          });

          // If handler didn't reply, send a default acknowledgment
          if (!replied) {
            await interaction.reply({ content: "✓ Command executed", ephemeral: true });
          }
        } catch (err) {
          logger.error({ msg: "Channel command handler error", command: commandName, error: String(err) });
          if (!replied) {
            await interaction.reply({ content: `Error: ${err}`, ephemeral: true });
          }
        }
      } else {
        logger.warn({ msg: "Unknown slash command", command: commandName });
      }
      break;
    }
  }
}

async function getSessionInfo(sessionKey: string): Promise<string> {
  // This would integrate with WOPR session API
  return "💾 Session active";
}

async function handleWoprMessage(interaction: ChatInputCommandInteraction, messageContent: string) {
  if (!ctx || !client) return;

  const sessionKey = getSessionKeyFromInteraction(interaction);
  const state = getSessionState(sessionKey);
  state.messageCount++;

  // Defer reply since AI response takes time
  await interaction.deferReply();

  // Add thinking level context
  let fullMessage = messageContent;
  if (state.thinkingLevel !== "medium") {
    fullMessage = `[Thinking level: ${state.thinkingLevel}] ${messageContent}`;
  }

  // Clean up any existing stream
  const existingStream = streams.get(sessionKey);
  if (existingStream) {
    await existingStream.finalize();
    streams.delete(sessionKey);
  }

  // For slash commands, we use a simple buffer since we edit the deferred reply
  let responseBuffer = "";
  let lastEditLength = 0;

  try {
    const response = await ctx.inject(sessionKey, fullMessage, {
      from: interaction.user.username,
      channel: { type: "discord", id: interaction.channelId, name: "slash-command" },
      // Skip conversation_history and channel_history - Discord handles its own context
      contextProviders: ['session_system', 'skills', 'bootstrap_files'],
      onStream: (msg: StreamMessage) => {
        // Collect response for editing
        if (msg.type === "text" && msg.content) {
          responseBuffer += msg.content;
          // Edit reply when we have enough new content (debounce edits)
          if (responseBuffer.length - lastEditLength >= EDIT_THRESHOLD) {
            lastEditLength = responseBuffer.length;
            interaction.editReply(responseBuffer.slice(0, DISCORD_LIMIT)).catch(() => {});
          }
        }
      }
    });

    // Final edit with complete response
    const usage = state.usageMode !== "off" ? `\n\n_Usage: ${state.messageCount} messages_` : "";
    await interaction.editReply((response + usage).slice(0, DISCORD_LIMIT));

  } catch (error: any) {
    logger.error({ msg: "Slash command inject failed", error: String(error) });
    await interaction.editReply("❌ Error processing your request.");
  }
}

// Handle @mention messages
async function handleMessage(message: Message) {
  if (!client || !ctx) return;
  if (!client.user) return;

  // Ignore our own messages
  if (message.author.id === client.user.id) return;

  // Check for registered message parsers FIRST - they need to see ALL messages
  // including slash command responses (which contain FRIEND_REQUEST/ACCEPT)
  if (await handleRegisteredParsers(message)) {
    return;  // Parser handled
  }

  // Ignore slash command interactions (for everything else)
  if (message.interaction) return;

  const isDM = message.channel.type === 1;

  // Handle owner pairing via DM when no owner is configured
  if (isDM && !hasOwner(ctx)) {
    const code = createPairingRequest(message.author.id, message.author.username);
    const pairingMessage = buildPairingMessage(code);
    await message.reply(pairingMessage);
    logger.info({ msg: "Pairing code generated", userId: message.author.id, username: message.author.username });
    return;
  }

  // Check for registered channel commands (e.g., /friend from P2P plugin)
  if (await handleRegisteredCommand(message)) {
    return;  // Command handled
  }

  // Note: Message parsers already checked above (before interaction check)
  // to ensure FRIEND_REQUEST/ACCEPT messages from slash command responses are processed

  const channelId = message.channel.id;
  const isDirectlyMentioned = message.mentions.users.has(client.user.id);
  const isBot = message.author.bot;

  const authorDisplayName = message.member?.displayName || (message.author as any).displayName || message.author.username;

  // Log ALL messages to WOPR conversation context
  const sessionKey = getSessionKey(message.channel as TextChannel | ThreadChannel | DMChannel);
  try {
    ctx.logMessage(sessionKey, message.content, {
      from: authorDisplayName,
      channel: { type: "discord", id: channelId, name: (message.channel as any).name }
    });
  } catch (e) {}

  // Add ALL messages to our buffer (for context building)
  addToBuffer(channelId, {
    from: authorDisplayName,
    content: message.content,
    timestamp: Date.now(),
    isBot,
    isMention: isDirectlyMentioned,
    originalMessage: message
  });

  // === BOT MESSAGE HANDLING ===
  if (isBot) {
    if (!isDirectlyMentioned) return; // Bots must @mention us

    // Prepare message content
    let messageContent = message.content;
    const botMention = `<@${client.user.id}>`;
    const botNicknameMention = `<@!${client.user.id}>`;
    messageContent = messageContent.replace(botNicknameMention, "").replace(botMention, "").trim();

    if (!messageContent) return; // Ignore empty bot mentions

    // Get accumulated context from buffer
    const bufferContext = getBufferContext(channelId);
    const fullMessage = bufferContext + messageContent;

    // Queue the bot response (will fire after cooldown + human typing check)
    queueInject(channelId, {
      sessionKey,
      messageContent: fullMessage,
      authorDisplayName,
      replyToMessage: message,
      isBot: true,
      queuedAt: Date.now()
    });
    logger.info({ msg: "Bot @mention queued", channelId, botId: message.author.id, authorDisplayName });
    return;
  }

  // === HUMAN MESSAGE HANDLING ===

  // Human @mention = immediate priority
  if (isDirectlyMentioned || isDM) {
    // Get accumulated context from buffer
    const bufferContext = getBufferContext(channelId);

    let messageContent = message.content;
    if (client.user && isDirectlyMentioned) {
      const botMention = `<@${client.user.id}>`;
      const botNicknameMention = `<@!${client.user.id}>`;
      messageContent = messageContent.replace(botNicknameMention, "").replace(botMention, "").trim();
    }

    // Handle attachments - save to disk and append paths
    if (message.attachments.size > 0) {
      const attachmentPaths = await saveAttachments(message);
      if (attachmentPaths.length > 0) {
        const attachmentInfo = attachmentPaths.map(p => `[Attachment: ${p}]`).join("\n");
        messageContent = messageContent ? `${messageContent}\n\n${attachmentInfo}` : attachmentInfo;
        logger.info({ msg: "Attachments appended to message", count: attachmentPaths.length, channelId });
      }
    }

    // If message was just a mention with no text (and no attachments), use a default prompt
    if (!messageContent) {
      messageContent = "Hello! (You mentioned me without a message)";
      logger.info({ msg: "Human @mention - empty message, using default", channelId });
    }

    // Prepend buffer context
    const fullMessage = bufferContext + messageContent;

    logger.info({ msg: "Human @mention - queueing (priority)", channelId, hasContext: bufferContext.length > 0 });

    // Queue with human priority (goes directly to chain, clears pending bot messages)
    queueInject(channelId, {
      sessionKey,
      messageContent: fullMessage,
      authorDisplayName,
      replyToMessage: message,
      isBot: false,
      queuedAt: Date.now()
    });
    return;
  }

  // Human message (no mention) = just logged to buffer above, nothing else to do
}

// Handle typing events - pause bot-to-bot when humans are typing
function handleTypingStart(typing: any) {
  if (!client) return;

  // Ignore bot typing
  if (typing.user.bot) return;

  const channelId = typing.channel.id;
  setHumanTyping(channelId);
}

// Core inject execution - called from promise chain with cancellation support
async function executeInjectInternal(item: QueuedInject, cancelToken: { cancelled: boolean }) {
  if (!ctx) return;

  const { sessionKey, messageContent: rawContent, authorDisplayName, replyToMessage } = item;
  const channelId = replyToMessage.channel.id;

  // Check cancellation before starting
  if (cancelToken.cancelled) {
    logger.info({ msg: "executeInjectInternal - cancelled before start", sessionKey });
    await setMessageReaction(replyToMessage, REACTION_CANCELLED);
    return;
  }

  // Transition from queued (🕐) to active (⚡)
  await setMessageReaction(replyToMessage, REACTION_ACTIVE);

  // Start typing indicator
  const channel = replyToMessage.channel as TextChannel | ThreadChannel | DMChannel;
  await startTyping(channel);

  const state = getSessionState(sessionKey);
  state.messageCount++;

  // Clean up any existing stream for this session
  const existingStream = streams.get(sessionKey);
  if (existingStream) {
    logger.info({ msg: "executeInjectInternal - cleaning up existing stream", sessionKey });
    await existingStream.finalize();
  }

  // Create new stream
  const stream = new DiscordMessageStream(
    replyToMessage.channel as TextChannel | ThreadChannel | DMChannel,
    replyToMessage
  );
  streams.set(sessionKey, stream);

  // Add thinking level context
  let messageContent = rawContent;
  if (state.thinkingLevel !== "medium") {
    messageContent = `[Thinking level: ${state.thinkingLevel}] ${messageContent}`;
  }

  try {
    logger.info({ msg: "executeInjectInternal - inject starting", sessionKey, from: authorDisplayName });
    await ctx.inject(sessionKey, messageContent, {
      from: authorDisplayName,
      channel: { type: "discord", id: channelId, name: (replyToMessage.channel as any).name },
      // Skip conversation_history and channel_history - Discord handles its own context buffer
      contextProviders: ['session_system', 'skills', 'bootstrap_files'],
      onStream: (msg: StreamMessage) => {
        // Check cancellation during streaming
        if (cancelToken.cancelled) return;
        // Tick typing indicator on each chunk
        tickTyping(channelId);
        handleChunk(msg, sessionKey).catch((e) => logger.error({ msg: "Chunk error", sessionKey, error: String(e) }));
      }
    });
    logger.info({ msg: "executeInjectInternal - inject complete", sessionKey });

    // Finalize the stream
    await stream.finalize();
    streams.delete(sessionKey);

    // Stop typing indicator
    stopTyping(channelId);

    // Transition to done (✅)
    await setMessageReaction(replyToMessage, REACTION_DONE);

    // Clear buffer after successful response
    clearBuffer(channelId);

  } catch (error: any) {
    const errorStr = String(error);
    const isCancelled = cancelToken.cancelled || errorStr.toLowerCase().includes("cancelled") || errorStr.toLowerCase().includes("canceled");

    // Stop typing indicator on any error
    stopTyping(channelId);

    if (isCancelled) {
      logger.info({ msg: "executeInjectInternal - inject was cancelled", sessionKey });
      try {
        await stream.finalize();
        streams.delete(sessionKey);
        await setMessageReaction(replyToMessage, REACTION_CANCELLED);
      } catch (e) {}
    } else {
      logger.error({ msg: "executeInjectInternal - inject failed", sessionKey, error: errorStr });
      try {
        await stream.finalize();
        streams.delete(sessionKey);
        await setMessageReaction(replyToMessage, REACTION_ERROR);
      } catch (e) {}
    }
  }
}

// Register slash commands
async function registerSlashCommands(token: string, clientId: string, guildId?: string) {
  const rest = new REST({ version: "10" }).setToken(token);
  
  try {
    logger.info("Registering slash commands...");
    
    if (guildId) {
      // Register to specific guild (faster for development)
      await rest.put(
        Routes.applicationGuildCommands(clientId, guildId),
        { body: commands.map(cmd => cmd.toJSON()) }
      );
      logger.info(`Registered ${commands.length} commands to guild ${guildId}`);
    } else {
      // Register globally (can take up to 1 hour to propagate)
      await rest.put(
        Routes.applicationCommands(clientId),
        { body: commands.map(cmd => cmd.toJSON()) }
      );
      logger.info(`Registered ${commands.length} global commands`);
    }
  } catch (error) {
    logger.error({ msg: "Failed to register commands", error: String(error) });
  }
}

const plugin: WOPRPlugin = {
  name: "wopr-plugin-discord",
  version: "2.11.0",
  description: "Discord bot with slash commands and identity support",
  commands: [
    {
      name: "discord",
      description: "Discord plugin commands",
      usage: "wopr discord claim <code>",
      async handler(_context: WOPRPluginContext, args: string[]) {
        const [subcommand, ...rest] = args;

        if (subcommand === "claim") {
          const code = rest[0];
          if (!code) {
            console.log("Usage: wopr discord claim <code>");
            console.log("  Claim ownership of the Discord bot using a pairing code");
            process.exit(1);
          }

          // Call the daemon API to claim ownership
          try {
            const response = await fetch("http://localhost:7437/plugins/discord/claim", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ code }),
            });
            const result = await response.json() as { success?: boolean; userId?: string; username?: string; error?: string };

            if (result.success) {
              console.log(`✓ Discord ownership claimed!`);
              console.log(`  Owner: ${result.username} (${result.userId})`);
              process.exit(0);
            } else {
              console.log(`Failed to claim: ${result.error || "Unknown error"}`);
              process.exit(1);
            }
          } catch (err) {
            console.log(`Error: Could not connect to WOPR daemon. Is it running?`);
            console.log(`  Start it with: wopr daemon start`);
            process.exit(1);
          }
        } else {
          console.log("Discord plugin commands:");
          console.log("  wopr discord claim <code>  - Claim ownership using a pairing code");
          process.exit(subcommand ? 1 : 0);
        }
      },
    },
  ],
  async init(context: WOPRPluginContext) {
    ctx = context;
    ctx.registerConfigSchema("wopr-plugin-discord", configSchema);

    // Register as a channel provider so other plugins can add commands/parsers
    if (ctx.registerChannelProvider) {
      ctx.registerChannelProvider(discordChannelProvider);
      logger.info("Registered Discord channel provider");
    }

    // Register the Discord extension so other plugins can send notifications
    if (ctx.registerExtension) {
      ctx.registerExtension("discord", discordExtension);
      logger.info("Registered Discord extension");
    }

    // Subscribe to session:afterInject to deliver cron responses to Discord
    logger.info({ msg: "Checking ctx.events availability", hasEvents: !!ctx.events });
    if (ctx.events) {
      ctx.events.on("session:afterInject", async (payload: SessionResponseEvent) => {
        logger.info({ msg: "session:afterInject event received", from: payload.from, session: payload.session });
        // Only handle cron-initiated responses for Discord sessions
        if (payload.from !== "cron") return;
        if (!payload.session.startsWith("discord:")) return;
        if (!payload.response) return;

        logger.info({ msg: "Cron response for Discord session", session: payload.session });

        // Find the channel ID from conversation log
        const channelId = findChannelIdFromConversationLog(payload.session);
        if (!channelId) {
          logger.warn({ msg: "Could not find Discord channel ID for cron response", session: payload.session });
          return;
        }

        // Deliver the response to Discord
        try {
          await discordChannelProvider.send(channelId, payload.response);
          logger.info({ msg: "Delivered cron response to Discord", session: payload.session, channelId });
        } catch (err) {
          logger.error({ msg: "Failed to deliver cron response to Discord", session: payload.session, channelId, error: String(err) });
        }
      });
      logger.info("Subscribed to session:afterInject for cron delivery");
    }

    await refreshIdentity();
    let config = ctx.getConfig<{token?: string; guildId?: string; clientId?: string}>();
    // Fall back to main config for Discord settings
    const mainDiscordConfig = ctx.getMainConfig("discord") as {token?: string; clientId?: string; guildId?: string};
    if (!config?.token && mainDiscordConfig?.token) {
      config = { ...config, token: mainDiscordConfig.token };
    }
    if (!config?.clientId && mainDiscordConfig?.clientId) {
      config = { ...config, clientId: mainDiscordConfig.clientId };
    }
    if (!config?.guildId && mainDiscordConfig?.guildId) {
      config = { ...config, guildId: mainDiscordConfig.guildId };
    }
    if (!config?.token) { 
      logger.warn("Not configured"); 
      return; 
    }
    
    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildMessageTyping  // For human typing detection
      ],
      partials: [Partials.Channel, Partials.Message]  // Required for DMs
    });

    client.on(Events.MessageCreate, (m) => handleMessage(m).catch((e) => logger.error({ msg: "Message handling failed", error: String(e) })));
    client.on(Events.InteractionCreate, async (interaction) => {
      // Handle slash commands
      if (interaction.isChatInputCommand()) {
        await handleSlashCommand(interaction).catch(e => logger.error({ msg: "Command error", error: String(e) }));
        return;
      }

      // Handle button interactions (friend request accept/deny)
      if (interaction.isButton() && isFriendRequestButton(interaction.customId)) {
        // Get P2P extension for friend request handling
        const p2pExt = ctx?.getExtension?.("p2p") as {
          acceptFriendRequest?: (from: string, pubkey: string, encryptPub: string, signature: string, channelId: string) => Promise<{ friend: any; acceptMessage: string }>;
          denyFriendRequest?: (from: string, signature: string) => Promise<void>;
        } | undefined;

        await handleFriendButtonInteraction(
          interaction,
          ctx!,
          client?.user?.username || "unknown",
          // onAccept handler - returns the FRIEND_ACCEPT message to post
          async (from: string, pending) => {
            if (p2pExt?.acceptFriendRequest) {
              const result = await p2pExt.acceptFriendRequest(
                from,
                pending.requestPubkey,
                pending.encryptPub,
                pending.signature,
                pending.channelId
              );
              logger.info({ msg: "Friend request accepted via button", from, friend: result.friend.name });
              return result.acceptMessage;
            } else {
              logger.warn({ msg: "P2P extension not available - cannot complete friendship" });
              return `Accepted friend request from @${from} (but P2P extension not available)`;
            }
          },
          // onDeny handler
          async (from: string) => {
            if (p2pExt?.denyFriendRequest) {
              // Get pending request to find signature
              const pending = getPendingButtonRequest(from);
              await p2pExt.denyFriendRequest(from, pending?.signature || "");
            }
            logger.info({ msg: "Friend request denied via button", from });
          }
        ).catch(e => logger.error({ msg: "Button interaction error", error: String(e) }));
        return;
      }
    });

    // Typing detection - pause bot-to-bot when humans are typing
    client.on(Events.TypingStart, (typing) => handleTypingStart(typing));

    // Start the queue processor for bot-to-bot responses
    startQueueProcessor();

    // Start cleanup interval for expired pairings and button requests
    startCleanupInterval();

    client.on(Events.ClientReady, async () => {
      logger.info({ tag: client?.user?.tag });
      
      // Register slash commands
      if (config.clientId && config.token) {
        await registerSlashCommands(config.token, config.clientId, config.guildId);
      } else {
        logger.warn("No clientId configured - slash commands not registered");
      }
    });
    
    try {
      await client.login(config.token);
      logger.info("Discord bot started");
    } catch (e) {
      logger.error({ msg: "Discord login failed", error: String(e) });
      throw e;
    }
  },
  async shutdown() {
    stopQueueProcessor();
    if (ctx?.unregisterChannelProvider) {
      ctx.unregisterChannelProvider("discord");
    }
    if (ctx?.unregisterExtension) {
      ctx.unregisterExtension("discord");
    }
    if (client) await client.destroy();
  },
};

export default plugin;
