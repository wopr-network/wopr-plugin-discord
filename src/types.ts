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
  type: "text" | "assistant";
  content: string;
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
  channel?: ChannelInfo;
  images?: string[];
}

export interface LogMessageOptions {
  from?: string;
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
}

export interface WOPRPlugin {
  name: string;
  version: string;
  description: string;
  init?: (context: WOPRPluginContext) => Promise<void>;
  shutdown?: () => Promise<void>;
}
