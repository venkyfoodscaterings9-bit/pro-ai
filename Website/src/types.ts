export type ProviderId = "anthropic" | "openai" | "gemini" | "groq" | "openrouter" | "mistral";
export type MessageRole = "user" | "assistant";
export type Theme = "light" | "dark";
export type AttachmentKind = "image" | "text";
export type OutputFormat = "xlsx" | "csv" | "html" | "pdf" | "docx" | "pptx" | "markdown" | "json" | "txt" | "chart";
export type OutputFormatPreference = "auto" | "chat" | OutputFormat;

export interface ModelOption {
  id: string;
  name: string;
  provider: ProviderId;
  vision?: boolean;
}

export interface ProviderOption {
  id: ProviderId;
  name: string;
  description: string;
  color: string;
  models: ModelOption[];
}

export interface ChatAttachment {
  id: string;
  name: string;
  mimeType: string;
  kind: AttachmentKind;
  data: string;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: number;
  attachments?: ChatAttachment[];
  provider?: ProviderId;
  model?: string;
  interrupted?: boolean;
  failure?: boolean;
  errorText?: string;
  fallbackMessage?: string;
  generatedFiles?: GeneratedFile[];
}

export interface Chat {
  id: string;
  title: string;
  messages: ChatMessage[];
  pinned: boolean;
  updatedAt: number;
  provider: ProviderId;
  model: string;
  projectId?: string;
}

export interface Project {
  id: string;
  name: string;
  systemPrompt: string;
  createdAt: number;
  updatedAt: number;
}

export interface EncryptedApiKey {
  id: string;
  provider: ProviderId;
  label: string;
  iv: string;
  ciphertext: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}

export interface VaultMetadata {
  salt: string;
  iterations: number;
  verifierIv: string;
  verifierCiphertext: string;
  createdAt: number;
}

export interface AppSettings {
  theme: Theme;
  defaultProvider: ProviderId;
  defaultModel: string;
  customInstructions: string;
  defaultOutputFormat: OutputFormatPreference;
  alwaysAskOutputFormat: boolean;
  updatedAt: number;
}

export interface GeneratedFile {
  id: string;
  name: string;
  format: OutputFormat;
  content: string;
  createdAt: number;
}

export interface ProviderMessage {
  role: MessageRole;
  content: string;
  attachments?: ChatAttachment[];
}

export interface Artifact {
  id: string;
  name: string;
  language: "html" | "svg" | "markdown";
  content: string;
}
