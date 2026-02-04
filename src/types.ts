/**
 * Local type definitions for WOPR plugin
 */

export interface ConfigField {
  name: string;
  type: string;
  label?: string;
  placeholder?: string;
  required?: boolean;
  description?: string;
  hidden?: boolean;
  default?: any;
}

export interface ConfigSchema {
  title: string;
  description: string;
  fields: ConfigField[];
}

export interface StreamMessage {
  type: "text" | "assistant" | "tool_use" | "complete" | "error" | "system";
  content: string;
  toolName?: string;
  subtype?: string;  // For system messages: "init", "compact_boundary", "status", etc.
  metadata?: Record<string, unknown>;  // For system message metadata (e.g., compact_metadata)
}

export interface ChannelInfo {
  type: string;
  id: string;
  name?: string;
}

export interface InjectOptions {
  silent?: boolean;
  onStream?: (msg: StreamMessage) => void;
  from?: string;
  /** Unique identifier for the sender (e.g., Discord user ID) */
  senderId?: string;
  channel?: ChannelInfo;
  images?: string[];
  /**
   * Control which context providers to use.
   * Use ['skills', 'bootstrap_files', 'session_system'] to get system context
   * but skip conversation_history (when plugin handles its own context).
   */
  contextProviders?: string[];
  /**
   * If true, allow V2 injection into active streams (default: true).
   * Set to false if the plugin handles V2 injection itself.
   */
  allowV2Inject?: boolean;
  /**
   * Priority level (higher = processed first within queue)
   */
  priority?: number;
}

export interface LogMessageOptions {
  from?: string;
  /** Unique identifier for the sender (e.g., Discord user ID) */
  senderId?: string;
  channel?: ChannelInfo;
}

export interface PluginLogger {
  info: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
}

export interface AgentIdentity {
  name?: string;
  creature?: string;
  vibe?: string;
  emoji?: string;
}

export interface UserProfile {
  name?: string;
  preferredAddress?: string;
  pronouns?: string;
  timezone?: string;
  notes?: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  available: boolean;
  models?: string[];
}

/**
 * Event types from WOPR core
 */
export interface WOPREvent {
  type: string;
  payload: any;
  timestamp: number;
  source?: string;
}

export interface SessionCreateEvent {
  session: string;
  config?: any;
}

export interface SessionInjectEvent {
  session: string;
  message: string;
  from: string;
  channel?: { type: string; id: string; name?: string };
}

export interface SessionResponseEvent {
  session: string;
  message: string;
  response: string;
  from: string;
  channel?: { type: string; id: string; name?: string };
}

export type EventHandler<T = any> = (payload: T, event: WOPREvent) => void | Promise<void>;

export interface WOPREventBus {
  on(event: string, handler: EventHandler<any>): () => void;
  once(event: string, handler: EventHandler<any>): void;
  off(event: string, handler: EventHandler<any>): void;
  emit(event: string, payload: any): Promise<void>;
  emitCustom(event: string, payload: any): Promise<void>;
  listenerCount(event: string): number;
}

export interface WOPRPluginContext {
  inject: (session: string, message: string, options?: InjectOptions) => Promise<string>;
  logMessage: (session: string, message: string, options?: LogMessageOptions) => void;
  injectPeer: (peer: string, session: string, message: string) => Promise<string>;
  getIdentity: () => { publicKey: string; shortId: string; encryptPub: string };
  getAgentIdentity: () => AgentIdentity | Promise<AgentIdentity>;
  getUserProfile: () => UserProfile | Promise<UserProfile>;
  getSessions: () => string[];
  getPeers: () => any[];
  getConfig: <T = any>() => T;
  saveConfig: <T>(config: T) => Promise<void>;
  getMainConfig: (key?: string) => any;
  registerConfigSchema: (pluginId: string, schema: ConfigSchema) => void;
  getPluginDir: () => string;
  log: PluginLogger;
  // Event bus for reactive plugin composition
  events?: WOPREventBus;
  // Provider/model management
  getProviders?: () => Promise<ProviderInfo[]>;
  setSessionProvider?: (session: string, provider: string, options?: { model?: string }) => Promise<void>;
  // Cancel an in-progress injection for a session
  cancelInject?: (session: string) => boolean;
  // V2 Session API - for injecting into active streaming sessions
  hasActiveSession?: (session: string) => Promise<boolean>;
  injectIntoActiveSession?: (session: string, message: string, options?: { from?: string; senderId?: string; channel?: ChannelInfo }) => Promise<void>;
  // Channel provider registration
  registerChannelProvider?: (provider: ChannelProvider) => void;
  unregisterChannelProvider?: (id: string) => void;
  // Extension registration (for cross-plugin APIs)
  registerExtension?: (name: string, extension: unknown) => void;
  unregisterExtension?: (name: string) => void;
  getExtension?: <T = unknown>(name: string) => T | undefined;
}

export interface PluginCommand {
  name: string;
  description: string;
  usage?: string;
  handler: (ctx: WOPRPluginContext, args: string[]) => Promise<void>;
}

export interface WOPRPlugin {
  name: string;
  version: string;
  description: string;
  commands?: PluginCommand[];
  init?: (context: WOPRPluginContext) => Promise<void>;
  shutdown?: () => Promise<void>;
}

// ============================================================================
// Channel Provider Types (for cross-plugin protocol commands)
// ============================================================================

/**
 * Context passed to channel command handlers
 */
export interface ChannelCommandContext {
  channel: string;           // Channel identifier (Discord channel ID)
  channelType: string;       // "discord"
  sender: string;            // Username of sender
  args: string[];            // Command arguments
  reply: (msg: string) => Promise<void>;
  getBotUsername: () => string;
}

/**
 * Context passed to channel message parsers
 */
export interface ChannelMessageContext {
  channel: string;
  channelType: string;
  sender: string;
  content: string;
  reply: (msg: string) => Promise<void>;
  getBotUsername: () => string;
}

/**
 * A command that can be registered on channel providers
 */
export interface ChannelCommand {
  name: string;
  description: string;
  handler: (ctx: ChannelCommandContext) => Promise<void>;
}

/**
 * A message parser that watches channel messages
 */
export interface ChannelMessageParser {
  id: string;
  pattern: RegExp | ((msg: string) => boolean);
  handler: (ctx: ChannelMessageContext) => Promise<void>;
}

/**
 * Channel provider interface
 */
export interface ChannelProvider {
  id: string;
  registerCommand(cmd: ChannelCommand): void;
  unregisterCommand(name: string): void;
  getCommands(): ChannelCommand[];
  addMessageParser(parser: ChannelMessageParser): void;
  removeMessageParser(id: string): void;
  getMessageParsers(): ChannelMessageParser[];
  send(channel: string, content: string): Promise<void>;
  getBotUsername(): string;
}
