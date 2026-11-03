import type {
  ModelOption,
  ProviderId,
  ProviderMessage,
  ProviderOption,
} from "../types";

export const PROVIDERS: ProviderOption[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    description: "Claude models",
    color: "#b77b51",
    models: [
      { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", provider: "anthropic", vision: true },
      { id: "claude-opus-5-5", name: "Claude Opus 5.5", provider: "anthropic", vision: true },
      { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", provider: "anthropic", vision: true },
      { id: "claude-fable-5-1", name: "Claude Fable 5.1", provider: "anthropic", vision: true },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    description: "GPT models",
    color: "#27866b",
    models: [
      { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", provider: "openai", vision: true },
      { id: "gpt-6-astra", name: "GPT-6 Astra", provider: "openai", vision: true },
      { id: "gpt-6-luna", name: "GPT-6 Luna", provider: "openai", vision: true },
    ],
  },
  {
    id: "gemini",
    name: "Google Gemini",
    description: "Gemini models",
    color: "#6886c6",
    models: [
      { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", provider: "gemini", vision: true },
      { id: "gemini-4-argon", name: "Gemini 4 Argon", provider: "gemini", vision: true },
      { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro", provider: "gemini", vision: true },
      { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash-Lite", provider: "gemini", vision: true },
    ],
  },
  {
    id: "groq",
    name: "Groq",
    description: "Fast inference",
    color: "#e58b50",
    models: [
      { id: "openai/gpt-oss-120b", name: "GPT-OSS 120B", provider: "groq" },
      { id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B", provider: "groq" },
      { id: "llama-4-scout-17b-16e-instruct", name: "Llama 4 Scout", provider: "groq", vision: true },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    description: "Many models, one key",
    color: "#8976bd",
    models: [
      { id: "openai/gpt-6.1-sol", name: "GPT-6.1 Sol", provider: "openrouter", vision: true },
      { id: "anthropic/claude-sonnet-5-5", name: "Claude Sonnet 5.5", provider: "openrouter", vision: true },
      { id: "google/gemini-3.8-flash", name: "Gemini 3.8 Flash", provider: "openrouter", vision: true },
      { id: "meta-llama/llama-4-maverick", name: "Llama 4 Maverick", provider: "openrouter", vision: true },
    ],
  },
  {
    id: "mistral",
    name: "Mistral",
    description: "Mistral models",
    color: "#cf8651",
    models: [
      { id: "mistral-large-latest", name: "Mistral Large", provider: "mistral", vision: true },
      { id: "mistral-medium-latest", name: "Mistral Medium", provider: "mistral", vision: true },
      { id: "mistral-small-latest", name: "Mistral Small", provider: "mistral", vision: true },
    ],
  },
];

export function getProvider(providerId: ProviderId): ProviderOption {
  const provider = PROVIDERS.find((item) => item.id === providerId);
  if (!provider) throw new Error("The selected provider is not supported.");
  return provider;
}

export function getModel(providerId: ProviderId, modelId: string): ModelOption {
  const model = getProvider(providerId).models.find((item) => item.id === modelId);
  if (!model) throw new Error(`The selected model is not listed for ${getProvider(providerId).name}.`);
  return model;
}

export function getDefaultModel(providerId: ProviderId): ModelOption {
  return getProvider(providerId).models[0];
}

export class ProviderRequestError extends Error {
  readonly provider: ProviderId;
  readonly retryable: boolean;

  constructor(provider: ProviderId, message: string, retryable: boolean) {
    super(message);
    this.name = "ProviderRequestError";
    this.provider = provider;
    this.retryable = retryable;
  }
}

export interface StreamInput {
  provider: ProviderId;
  model: string;
  apiKey: string;
  messages: ProviderMessage[];
  systemPrompt: string;
  signal: AbortSignal;
  onText: (chunk: string) => void;
}

function providerError(provider: ProviderId, status: number): ProviderRequestError {
  const name = getProvider(provider).name;
  const retryable = status === 401 || status === 403 || status === 408 || status === 429 || status >= 500;
  if (status === 401 || status === 403) {
    return new ProviderRequestError(provider, `${name} rejected this API key. Check the key and its permissions.`, true);
  }
  if (status === 429) {
    return new ProviderRequestError(provider, `${name} rate limit reached.`, true);
  }
  return new ProviderRequestError(
    provider,
    `${name} request failed (${status}). Check the selected model and provider settings.`,
    retryable,
  );
}

async function postJson(
  provider: ProviderId,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (cause) {
    if (signal.aborted) throw cause;
    if (cause instanceof TypeError) {
      throw new ProviderRequestError(
        provider,
        `${getProvider(provider).name} could not be reached directly. Your network or browser may block this request (CORS). No proxy is configured.`,
        true,
      );
    }
    throw cause;
  }
  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      // The response body is intentionally ignored so provider error text cannot expose secrets.
    }
    throw providerError(provider, response.status);
  }
  if (!response.body) {
    throw new ProviderRequestError(provider, `${getProvider(provider).name} returned no readable stream.`, true);
  }
  return response;
}

interface ParsedEvent {
  name: string;
  data: string;
}

async function readSse(
  provider: ProviderId,
  response: Response,
  onEvent: (event: ParsedEvent) => void,
): Promise<void> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  function parseBlock(block: string) {
    let name = "message";
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) name = line.slice(6).trim();
      if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (data.length) onEvent({ name, data: data.join("\n") });
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) parseBlock(block);
      if (done) {
        if (buffer.trim()) parseBlock(buffer);
        break;
      }
    }
  } catch (cause) {
    if (cause instanceof TypeError && !response.bodyUsed) {
      throw new ProviderRequestError(provider, `${getProvider(provider).name} streaming response was interrupted.`, true);
    }
    throw cause;
  } finally {
    reader.releaseLock();
  }
}

function openAiContent(message: ProviderMessage): string | Array<Record<string, unknown>> {
  const imageAttachments = (message.attachments ?? []).filter((item) => item.kind === "image");
  const textAttachments = (message.attachments ?? []).filter((item) => item.kind === "text");
  if (!imageAttachments.length) {
    return [
      message.content,
      ...textAttachments.map((item) => `\n\n[Attached file: ${item.name}]\n${item.data}`),
    ].filter(Boolean).join("");
  }
  const parts: Array<Record<string, unknown>> = [];
  const text = [
    message.content,
    ...textAttachments.map((item) => `\n\n[Attached file: ${item.name}]\n${item.data}`),
  ].filter(Boolean).join("");
  if (text) parts.push({ type: "text", text });
  for (const image of imageAttachments) {
    parts.push({
      type: "image_url",
      image_url: { url: `data:${image.mimeType};base64,${image.data}` },
    });
  }
  return parts;
}

async function streamOpenAiCompatible(input: StreamInput): Promise<void> {
  const endpoints: Record<Exclude<ProviderId, "anthropic" | "gemini">, string> = {
    openai: "https://api.openai.com/v1/chat/completions",
    groq: "https://api.groq.com/openai/v1/chat/completions",
    openrouter: "https://openrouter.ai/api/v1/chat/completions",
    mistral: "https://api.mistral.ai/v1/chat/completions",
  };
  const provider = input.provider as Exclude<ProviderId, "anthropic" | "gemini">;
  const headers: Record<string, string> = { Authorization: `Bearer ${input.apiKey}` };
  if (provider === "openrouter") {
    headers["HTTP-Referer"] = globalThis.location?.origin ?? "http://localhost";
    headers["X-Title"] = "Morrow";
  }
  const messages: Array<Record<string, unknown>> = [];
  if (input.systemPrompt.trim()) messages.push({ role: "system", content: input.systemPrompt });
  for (const message of input.messages) {
    messages.push({ role: message.role, content: openAiContent(message) });
  }
  const response = await postJson(
    provider,
    endpoints[provider],
    headers,
    { model: input.model, messages, stream: true },
    input.signal,
  );
  await readSse(provider, response, (event) => {
    if (event.data === "[DONE]") return;
    let payload: {
      error?: { message?: string; type?: string };
      choices?: Array<{ delta?: { content?: string | Array<{ text?: string }> } }>;
    };
    try {
      payload = JSON.parse(event.data) as typeof payload;
    } catch {
      throw new ProviderRequestError(provider, `${getProvider(provider).name} returned an invalid streaming event.`, false);
    }
    if (payload.error) {
      throw new ProviderRequestError(provider, `${getProvider(provider).name} reported a streaming error.`, true);
    }
    const content = payload.choices?.[0]?.delta?.content;
    if (typeof content === "string") input.onText(content);
    else if (Array.isArray(content)) content.forEach((part) => part.text && input.onText(part.text));
  });
}

async function streamAnthropic(input: StreamInput): Promise<void> {
  const messages = input.messages.map((message) => {
    const content: Array<Record<string, unknown>> = [];
    const text = [
      message.content,
      ...(message.attachments ?? [])
        .filter((attachment) => attachment.kind === "text")
        .map((attachment) => `\n\n[Attached file: ${attachment.name}]\n${attachment.data}`),
    ].filter(Boolean).join("");
    if (text) content.push({ type: "text", text });
    for (const attachment of message.attachments ?? []) {
      if (attachment.kind === "image") {
        content.push({
          type: "image",
          source: { type: "base64", media_type: attachment.mimeType, data: attachment.data },
        });
      }
    }
    return { role: message.role, content };
  });
  const response = await postJson(
    "anthropic",
    "https://api.anthropic.com/v1/messages",
    {
      "x-api-key": input.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    {
      model: input.model,
      max_tokens: 8192,
      stream: true,
      system: input.systemPrompt || undefined,
      messages,
    },
    input.signal,
  );
  await readSse("anthropic", response, (event) => {
    if (event.name === "error") {
      throw new ProviderRequestError("anthropic", "Anthropic reported a streaming error.", true);
    }
    if (event.name !== "content_block_delta") return;
    try {
      const payload = JSON.parse(event.data) as { delta?: { text?: string } };
      if (payload.delta?.text) input.onText(payload.delta.text);
    } catch {
      throw new ProviderRequestError("anthropic", "Anthropic returned an invalid streaming event.", false);
    }
  });
}

async function streamGemini(input: StreamInput): Promise<void> {
  const contents = input.messages.map((message) => {
    const parts: Array<Record<string, unknown>> = [];
    const text = [
      message.content,
      ...(message.attachments ?? [])
        .filter((attachment) => attachment.kind === "text")
        .map((attachment) => `\n\n[Attached file: ${attachment.name}]\n${attachment.data}`),
    ].filter(Boolean).join("");
    if (text) parts.push({ text });
    for (const attachment of message.attachments ?? []) {
      if (attachment.kind === "image") {
        parts.push({ inline_data: { mime_type: attachment.mimeType, data: attachment.data } });
      }
    }
    return { role: message.role === "assistant" ? "model" : "user", parts };
  });
  const response = await postJson(
    "gemini",
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:streamGenerateContent?alt=sse`,
    { "x-goog-api-key": input.apiKey },
    {
      contents,
      systemInstruction: input.systemPrompt
        ? { parts: [{ text: input.systemPrompt }] }
        : undefined,
    },
    input.signal,
  );
  await readSse("gemini", response, (event) => {
    if (event.data === "[DONE]") return;
    try {
      const payload = JSON.parse(event.data) as {
        error?: { message?: string };
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      if (payload.error) {
        throw new ProviderRequestError("gemini", "Google Gemini reported a streaming error.", true);
      }
      for (const part of payload.candidates?.[0]?.content?.parts ?? []) {
        if (part.text) input.onText(part.text);
      }
    } catch (cause) {
      if (cause instanceof ProviderRequestError) throw cause;
      throw new ProviderRequestError("gemini", "Google Gemini returned an invalid streaming event.", false);
    }
  });
}

export async function streamProviderResponse(input: StreamInput): Promise<void> {
  getModel(input.provider, input.model);
  if (input.provider === "anthropic") return streamAnthropic(input);
  if (input.provider === "gemini") return streamGemini(input);
  return streamOpenAiCompatible(input);
}

export function modelHasVision(provider: ProviderId, model: string): boolean {
  return Boolean(getModel(provider, model).vision);
}
