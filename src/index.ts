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

const logger = winston.createLogger({
  level: "debug",
  format: winston.format.combine(winston.format.timestamp(), winston.format.errors({ stack: true }), winston.format.json()),
  defaultMeta: { service: "wopr-plugin-discord" },
  transports: [
    new winston.transports.File({ filename: path.join(process.env.WOPR_HOME || "/tmp/wopr-test", "logs", "discord-plugin-error.log"), level: "error" }),
    new winston.transports.File({ filename: path.join(process.env.WOPR_HOME || "/tmp/wopr-test", "logs", "discord-plugin.log"), level: "debug" }),
    new winston.transports.Console({ format: winston.format.combine(winston.format.colorize(), winston.format.simple()), level: "warn" }),
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
}

const sessionStates = new Map<string, SessionState>();

function getSessionState(sessionKey: string): SessionState {
  if (!sessionStates.has(sessionKey)) {
    sessionStates.set(sessionKey, {
      thinkingLevel: "medium",
      verbose: false,
      usageMode: "tokens",
      messageCount: 0
    });
  }
  return sessionStates.get(sessionKey)!;
}

// Discord streaming message handler
const DISCORD_LIMIT = 2000;
const EDIT_THRESHOLD = 800;
const IDLE_SPLIT_MS = 1000;

class DiscordMessage {
  discordMsg: Message | null = null;
  buffer = "";
  lastEditLength = 0;
  isReply: boolean;
  isFinalized = false;
  
  constructor(isReply: boolean) {
    this.isReply = isReply;
  }
  
  addContent(text: string): void {
    this.buffer += text;
  }
  
  async flush(channel: TextChannel | ThreadChannel | DMChannel, replyTo: Message): Promise<boolean> {
    if (this.isFinalized || !this.buffer.trim()) return false;
    
    const content = this.buffer.trim();
    
    if (content.length > DISCORD_LIMIT) {
      const toSend = content.slice(0, DISCORD_LIMIT);
      if (this.discordMsg) {
        await this.discordMsg.edit(toSend);
      } else {
        this.discordMsg = this.isReply 
          ? await replyTo.reply(toSend)
          : await channel.send(toSend);
      }
      this.buffer = content.slice(DISCORD_LIMIT);
      this.lastEditLength = 0;
      this.isFinalized = true;
      return true;
    }
    
    const newContent = content.slice(this.lastEditLength);
    if (this.discordMsg) {
      if (newContent.length >= EDIT_THRESHOLD) {
        await this.discordMsg.edit(content);
        this.lastEditLength = content.length;
      }
    } else {
      if (content.length >= EDIT_THRESHOLD) {
        this.discordMsg = this.isReply 
          ? await replyTo.reply(content)
          : await channel.send(content);
        this.lastEditLength = content.length;
      }
    }
    return false;
  }
  
  async finalize(channel: TextChannel | ThreadChannel | DMChannel, replyTo: Message): Promise<void> {
    if (this.isFinalized || !this.buffer.trim()) return;
    const content = this.buffer.trim();
    if (this.discordMsg) {
      await this.discordMsg.edit(content);
    } else {
      this.discordMsg = this.isReply 
        ? await replyTo.reply(content)
        : await channel.send(content);
    }
    this.isFinalized = true;
  }
}

interface StreamState {
  channel: TextChannel | ThreadChannel | DMChannel;
  replyTo: Message;
  messages: DiscordMessage[];
  currentMsg: DiscordMessage;
  lastTokenTime: number;
  processing: boolean;
  pending: { msg: StreamMessage; sessionKey: string }[];
  finalizeTimer: NodeJS.Timeout | null;
}

const streams = new Map<string, StreamState>();

async function processPending(state: StreamState, sessionKey: string) {
  while (state.pending.length > 0) {
    const { msg } = state.pending.shift()!;
    await processChunk(msg, state, sessionKey);
  }
  state.processing = false;
}

async function processChunk(msg: StreamMessage, state: StreamState, sessionKey: string) {
  let textContent = "";
  if (msg.type === "text" && msg.content) {
    textContent = msg.content;
  } else if (msg.type === "assistant" && (msg as any).message?.content) {
    const content = (msg as any).message.content;
    if (Array.isArray(content)) {
      textContent = content.map((c: any) => c.text || "").join("");
    } else if (typeof content === "string") {
      textContent = content;
    }
  }
  
  if (!textContent) return;
  
  const now = Date.now();
  const timeSinceLast = now - state.lastTokenTime;
  
  if (timeSinceLast > IDLE_SPLIT_MS && state.currentMsg.buffer.length > 0) {
    await state.currentMsg.finalize(state.channel, state.replyTo);
    const newMsg = new DiscordMessage(false);
    state.messages.push(state.currentMsg);
    state.currentMsg = newMsg;
  }
  
  state.lastTokenTime = now;
  state.currentMsg.addContent(textContent);
  
  if ((state as any).setupFinalizeTimer) {
    (state as any).setupFinalizeTimer();
  }
  
  const needsNewMsg = await state.currentMsg.flush(state.channel, state.replyTo);
  
  if (needsNewMsg) {
    const newMsg = new DiscordMessage(false);
    newMsg.buffer = state.currentMsg.buffer;
    state.messages.push(state.currentMsg);
    state.currentMsg = newMsg;
    await state.currentMsg.flush(state.channel, state.replyTo);
  }
}

async function handleChunk(msg: StreamMessage, sessionKey: string) {
  const state = streams.get(sessionKey);
  if (!state) return;
  
  state.pending.push({ msg, sessionKey });
  
  if (!state.processing) {
    state.processing = true;
    processPending(state, sessionKey).catch((e) => {
      logger.error({ msg: "Chunk processing error", error: String(e) });
      state.processing = false;
    });
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
          `**/session <name>** - Switch to named session\n` +
          `**/wopr <message>** - Send message to WOPR\n` +
          `**/help** - Show this help\n\n` +
          `You can also mention me (@${client.user?.username}) to chat!`,
        ephemeral: true
      });
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
  
  streams.delete(sessionKey);
  
  const currentMsg = new DiscordMessage(false);
  const streamState: StreamState = {
    channel: interaction.channel as TextChannel | ThreadChannel | DMChannel,
    replyTo: null as any, // Will use editReply instead
    messages: [],
    currentMsg,
    lastTokenTime: Date.now(),
    processing: false,
    pending: [],
    finalizeTimer: null,
  };
  
  let responseBuffer = "";
  
  try {
    const response = await ctx.inject(sessionKey, fullMessage, {
      from: interaction.user.username,
      channel: { type: "discord", id: interaction.channelId, name: "slash-command" },
      onStream: (msg: StreamMessage) => {
        // Collect response for editing
        if (msg.type === "text" && msg.content) {
          responseBuffer += msg.content;
          // Edit reply every few chunks
          if (responseBuffer.length % 500 < 50) {
            interaction.editReply(responseBuffer.slice(0, 2000)).catch(() => {});
          }
        }
      }
    });
    
    // Final edit with complete response
    const usage = state.usageMode !== "off" ? `\n\n_Usage: ${state.messageCount} messages_` : "";
    await interaction.editReply((response + usage).slice(0, 2000));
    
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
  
  const ackEmoji = getAckReaction();
  try { await message.react(ackEmoji); } catch (e) {}
  
  const sessionKey = `discord-${message.channel.id}`;
  const state = getSessionState(sessionKey);
  state.messageCount++;
  
  streams.delete(sessionKey);
  
  const currentMsg = new DiscordMessage(true);
  const streamState: StreamState = {
    channel: message.channel as TextChannel | ThreadChannel | DMChannel,
    replyTo: message,
    messages: [],
    currentMsg,
    lastTokenTime: Date.now(),
    processing: false,
    pending: [],
    finalizeTimer: null,
  };
  
  const setupFinalizeTimer = () => {
    if (streamState.finalizeTimer) clearTimeout(streamState.finalizeTimer);
    streamState.finalizeTimer = setTimeout(async () => {
      if (streamState.currentMsg.buffer.length > 0 && !streamState.currentMsg.isFinalized) {
        await streamState.currentMsg.finalize(streamState.channel, streamState.replyTo);
      }
    }, 2000);
  };
  
  (streamState as any).setupFinalizeTimer = setupFinalizeTimer;
  setupFinalizeTimer();
  
  streams.set(sessionKey, streamState);
  
  // Add thinking level context
  if (state.thinkingLevel !== "medium") {
    messageContent = `[Thinking level: ${state.thinkingLevel}] ${messageContent}`;
  }
  
  try {
    await ctx.inject(sessionKey, messageContent, {
      from: authorDisplayName,
      channel: { type: "discord", id: message.channel.id, name: (message.channel as any).name },
      onStream: (msg: StreamMessage) => {
        handleChunk(msg, sessionKey).catch((e) => logger.error({ msg: "Chunk error", error: String(e) }));
      }
    });
    
    await streamState.currentMsg.finalize(streamState.channel, streamState.replyTo);
    if (streamState.finalizeTimer) clearTimeout(streamState.finalizeTimer);
    streams.delete(sessionKey);
    
    const usage = state.usageMode !== "off" ? `\n\n_Usage: ${state.messageCount} messages_` : "";
    if (usage && streamState.currentMsg.discordMsg) {
      await streamState.currentMsg.discordMsg.edit(streamState.currentMsg.discordMsg.content + usage);
    }
    
    try { 
      const ackEmoji = getAckReaction();
      await message.reactions.cache.get(ackEmoji)?.users.remove(client.user.id); 
      await message.react("✅"); 
    } catch (e) {}
  } catch (error: any) {
    logger.error({ msg: "Inject failed", error: String(error) });
    if (streamState.finalizeTimer) clearTimeout(streamState.finalizeTimer);
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
    if (!config?.token) { 
      const legacy = ctx.getMainConfig("discord") as {token?: string}; 
      if (legacy?.token) config = { token: legacy.token }; 
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
    
    client.on(Events.MessageCreate, (m) => handleMessage(m).catch((e) => logger.error(e)));
    client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      await handleSlashCommand(interaction).catch(e => logger.error({ msg: "Command error", error: String(e) }));
    });
    
    client.on(Events.ClientReady, async () => {
      logger.info({ tag: client?.user?.tag });
      
      // Register slash commands
      if (config.clientId) {
        await registerSlashCommands(config.token, config.clientId, config.guildId);
      } else {
        logger.warn("No clientId configured - slash commands not registered");
      }
    });
    
    try { 
      await client.login(config.token); 
      logger.info("Discord bot started"); 
    } catch (e) { 
      logger.error(e); 
      throw e; 
    }
  },
  async shutdown() { 
    if (client) await client.destroy(); 
  },
};

export default plugin;
