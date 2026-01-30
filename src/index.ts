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
  PermissionFlagsBits
} from "discord.js";
import winston from "winston";
import path from "path";
import type { WOPRPlugin, WOPRPluginContext, ConfigSchema, StreamMessage, AgentIdentity } from "./types.js";

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
}

function getAckReaction(): string {
  return agentIdentity.emoji?.trim() || "👀";
}

function getMessagePrefix(): string {
  const name = agentIdentity.name?.trim();
  return name ? `[${name}]` : "[WOPR]";
}

const configSchema: ConfigSchema = {
  title: "Discord Integration",
  description: "Configure Discord bot integration with slash commands",
  fields: [
    { name: "token", type: "password", label: "Discord Bot Token", placeholder: "Bot token from Discord Developer Portal", required: true, description: "Your Discord bot token" },
    { name: "guildId", type: "text", label: "Guild ID (optional)", placeholder: "Server ID to restrict bot to", description: "Restrict bot to a specific Discord server" },
    { name: "clientId", type: "text", label: "Application ID", placeholder: "From Discord Developer Portal", description: "Discord Application ID (for slash commands)" },
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

// Handle slash commands
async function handleSlashCommand(interaction: ChatInputCommandInteraction) {
  if (!ctx || !client) return;
  
  const { commandName } = interaction;
  const sessionKey = `discord-${interaction.channelId}`;
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
        content: "📦 **Compacting Session**\n\nSummarizing conversation context...",
        ephemeral: false
      });
      
      try {
        const summary = await ctx.inject(sessionKey, 
          "Please provide a brief summary of our conversation so far. Keep it concise.", 
          { silent: true }
        );
        await interaction.editReply(`📦 **Session Summary**\n\n${summary}`);
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
      const newSessionKey = `discord-${interaction.channelId}-${name}`;
      await interaction.reply({
        content: `💬 **Switched to session:** ${name}\n\nNote: Each session maintains separate context.`,
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
          `**/help** - Show this help\n\n` +
          `You can also mention me (@${client.user?.username}) to chat!`,
        ephemeral: true
      });
      break;
    }

    case "cancel": {
      const existingStream = streams.get(sessionKey);

      // Try to cancel the injection via WOPR
      let cancelled = false;
      if (ctx.cancelInject) {
        cancelled = ctx.cancelInject(sessionKey);
      }

      // Finalize and clean up the stream
      if (existingStream) {
        logger.info({ msg: "Cancel command - finalizing stream", sessionKey });
        await existingStream.finalize();
        streams.delete(sessionKey);
      }

      if (cancelled || existingStream) {
        await interaction.reply({
          content: "⏹️ **Cancelled**\n\nThe current response has been stopped.",
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
  }
}

async function getSessionInfo(sessionKey: string): Promise<string> {
  // This would integrate with WOPR session API
  return "💾 Session active";
}

async function handleWoprMessage(interaction: ChatInputCommandInteraction, messageContent: string) {
  if (!ctx || !client) return;

  const sessionKey = `discord-${interaction.channelId}`;
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
  if (message.author.bot) return;
  if (!client.user) return;

  // Ignore slash command interactions
  if (message.interaction) return;

  const isDirectlyMentioned = message.mentions.users.has(client.user.id);
  const isDM = message.channel.type === 1;

  const authorDisplayName = message.member?.displayName || (message.author as any).displayName || message.author.username;

  try {
    ctx.logMessage(`discord-${message.channel.id}`, message.content, {
      from: authorDisplayName,
      channel: { type: "discord", id: message.channel.id, name: (message.channel as any).name }
    });
  } catch (e) {}

  if (!isDirectlyMentioned && !isDM) return;

  let messageContent = message.content;
  if (client.user && isDirectlyMentioned) {
    const botMention = `<@${client.user.id}>`;
    const botNicknameMention = `<@!${client.user.id}>`;
    messageContent = messageContent.replace(botNicknameMention, "").replace(botMention, "").trim();
  }

  if (!messageContent) return; // Skip empty mentions

  const sessionKey = `discord-${message.channel.id}`;
  logger.info({ msg: "handleMessage - processing mention", sessionKey, author: authorDisplayName, contentLen: messageContent.length });

  const ackEmoji = getAckReaction();
  try { await message.react(ackEmoji); } catch (e) {}

  const state = getSessionState(sessionKey);
  state.messageCount++;

  // Clean up any existing stream for this session
  const existingStream = streams.get(sessionKey);
  if (existingStream) {
    logger.info({ msg: "handleMessage - cleaning up existing stream", sessionKey });
    await existingStream.finalize();
  }

  // Create new stream with explicit state machine
  const stream = new DiscordMessageStream(
    message.channel as TextChannel | ThreadChannel | DMChannel,
    message
  );
  streams.set(sessionKey, stream);
  logger.info({ msg: "handleMessage - stream created, calling inject", sessionKey });

  // Add thinking level context
  if (state.thinkingLevel !== "medium") {
    messageContent = `[Thinking level: ${state.thinkingLevel}] ${messageContent}`;
  }

  try {
    logger.info({ msg: "handleMessage - inject starting", sessionKey });
    await ctx.inject(sessionKey, messageContent, {
      from: authorDisplayName,
      channel: { type: "discord", id: message.channel.id, name: (message.channel as any).name },
      onStream: (msg: StreamMessage) => {
        handleChunk(msg, sessionKey).catch((e) => logger.error({ msg: "Chunk error", sessionKey, error: String(e) }));
      }
    });
    logger.info({ msg: "handleMessage - inject complete", sessionKey });

    // Finalize the stream
    logger.info({ msg: "handleMessage - finalizing stream", sessionKey });
    await stream.finalize();
    streams.delete(sessionKey);
    logger.info({ msg: "handleMessage - stream finalized and removed", sessionKey });

    // Append usage stats if enabled
    const usage = state.usageMode !== "off" ? `\n\n_Usage: ${state.messageCount} messages_` : "";
    const lastMsg = stream.getLastMessage();
    logger.debug({ msg: "handleMessage - appending usage", sessionKey, hasLastMsg: !!lastMsg, usageLen: usage.length });
    if (usage && lastMsg) {
      try {
        await lastMsg.edit(lastMsg.content + usage);
      } catch (e) {
        logger.debug({ msg: "handleMessage - usage edit failed", sessionKey, error: String(e) });
      }
    }

    try {
      const ackEmoji = getAckReaction();
      await message.reactions.cache.get(ackEmoji)?.users.remove(client.user.id);
      await message.react("✅");
    } catch (e) {}
    logger.info({ msg: "handleMessage - complete success", sessionKey });
  } catch (error: any) {
    const errorStr = String(error);
    const isCancelled = errorStr.toLowerCase().includes("cancelled") || errorStr.toLowerCase().includes("canceled");

    // If this was an intentional cancellation, don't show error
    if (isCancelled) {
      logger.info({ msg: "handleMessage - inject was cancelled", sessionKey });
      // Stream was already finalized by /cancel command, just clean up reaction
      try {
        const ackEmoji = getAckReaction();
        await message.reactions.cache.get(ackEmoji)?.users.remove(client.user.id);
      } catch (e) {}
      return;
    }

    logger.error({ msg: "handleMessage - inject failed", sessionKey, error: errorStr });
    await stream.finalize();
    streams.delete(sessionKey);
    try {
      const ackEmoji = getAckReaction();
      await message.reactions.cache.get(ackEmoji)?.users.remove(client.user.id);
      await message.react("❌");
    } catch (e) {}
    await message.reply("Error processing your request.");
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
  async init(context: WOPRPluginContext) {
    ctx = context;
    ctx.registerConfigSchema("wopr-plugin-discord", configSchema);
    
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
        GatewayIntentBits.GuildMessageReactions
      ] 
    });
    
    client.on(Events.MessageCreate, (m) => handleMessage(m).catch((e) => logger.error({ msg: "Message handling failed", error: String(e) })));
    client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      await handleSlashCommand(interaction).catch(e => logger.error({ msg: "Command error", error: String(e) }));
    });
    
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
    if (client) await client.destroy(); 
  },
};

export default plugin;
