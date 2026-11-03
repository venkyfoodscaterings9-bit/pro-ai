import type { ApiFormat, ChatAttachment, CustomModel, CustomProvider, ProviderMessage } from "../types";
import { getProviderEndpoint } from "./providerUrl";

export class CustomProviderRequestError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "CustomProviderRequestError";
    this.retryable = retryable;
  }
}

interface RequestInput {
  provider: CustomProvider;
  model: CustomModel;
  apiKey: string;
  messages: ProviderMessage[];
  systemPrompt?: string;
  signal: AbortSignal;
  onText: (chunk: string) => void;
  streaming?: boolean;
}

function providerError(provider: CustomProvider, status: number, detail?: string): CustomProviderRequestError {
  const prefix = `${provider.name}: `;
  if (status === 401 || status === 403) {
    return new CustomProviderRequestError(`${prefix}API key was rejected (${status}). Check the key and its permissions.`, false);
  }
  if (status === 404) {
    return new CustomProviderRequestError(`${prefix}endpoint or model was not found (404). Check the base URL and exact model ID.`, false);
  }
  if (status === 429) return new CustomProviderRequestError(`${prefix}rate limit reached (429).`, true);
  return new CustomProviderRequestError(
    `${prefix}request failed (${status}).${detail ? ` ${detail}` : ""}`,
    status === 408 || status >= 500,
  );
}

async function errorDetail(response: Response, apiKey: string): Promise<string | undefined> {
  try {
    const body = await response.text();
    const parsed: unknown = JSON.parse(body);
    let message: unknown;
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      const error = record.error;
      message = typeof error === "string"
        ? error
        : error && typeof error === "object"
          ? (error as Record<string, unknown>).message
          : record.message;
    }
    return typeof message === "string" ? message.split(apiKey).join("[redacted]").slice(0, 240) : undefined;
  } catch {
    return undefined;
  }
}

function addTextAttachments(message: ProviderMessage): string {
  return [
    message.content,
    ...(message.attachments ?? [])
      .filter((attachment) => attachment.kind === "text")
      .map((attachment) => `\n\n[Attached file: ${attachment.name}]\n${attachment.data}`),
  ].filter(Boolean).join("");
}

function openAiContent(message: ProviderMessage): string | Array<Record<string, unknown>> {
  const text = addTextAttachments(message);
  const images = (message.attachments ?? []).filter((attachment) => attachment.kind === "image");
  if (!images.length) return text;
  return [
    ...(text ? [{ type: "text", text }] : []),
    ...images.map((image) => ({
      type: "image_url",
      image_url: { url: `data:${image.mimeType};base64,${image.data}` },
    })),
  ];
}

function anthropicContent(message: ProviderMessage): string | Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [];
  const text = addTextAttachments(message);
  if (text) content.push({ type: "text", text });
  for (const image of (message.attachments ?? []).filter((item) => item.kind === "image")) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: image.mimeType, data: image.data },
    });
  }
  return content;
}

function geminiParts(message: ProviderMessage): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  const text = addTextAttachments(message);
  if (text) parts.push({ text });
  for (const image of (message.attachments ?? []).filter((item) => item.kind === "image")) {
    parts.push({ inline_data: { mime_type: image.mimeType, data: image.data } });
  }
  return parts;
}

function requestBody(input: RequestInput, stream: boolean): Record<string, unknown> {
  const { provider, model } = input;
  if (provider.apiFormat === "openai") {
    return {
      model: model.modelId,
      messages: [
        ...(input.systemPrompt ? [{ role: "system", content: input.systemPrompt }] : []),
        ...input.messages.map((message) => ({ role: message.role, content: openAiContent(message) })),
      ],
      stream,
      ...(model.maxTokens ? { max_tokens: model.maxTokens } : {}),
      ...(model.temperature !== undefined ? { temperature: model.temperature } : {}),
    };
  }
  if (provider.apiFormat === "anthropic") {
    return {
      model: model.modelId,
      max_tokens: model.maxTokens ?? 8192,
      messages: input.messages.map((message) => ({ role: message.role, content: anthropicContent(message) })),
      ...(input.systemPrompt ? { system: input.systemPrompt } : {}),
      ...(model.temperature !== undefined ? { temperature: model.temperature } : {}),
      stream,
    };
  }
  return {
    contents: input.messages.map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: geminiParts(message),
    })),
    ...(input.systemPrompt ? { systemInstruction: { parts: [{ text: input.systemPrompt }] } } : {}),
    ...(model.maxTokens || model.temperature !== undefined
      ? { generationConfig: {
          ...(model.maxTokens ? { maxOutputTokens: model.maxTokens } : {}),
          ...(model.temperature !== undefined ? { temperature: model.temperature } : {}),
        } }
      : {}),
  };
}

function requestUrl(provider: CustomProvider, model: CustomModel, stream: boolean): string {
  const encodedModel = encodeURIComponent(model.modelId.replace(/^models\//, ""));
  if (provider.apiFormat === "openai") return getProviderEndpoint(provider.baseUrl, "/chat/completions");
  if (provider.apiFormat === "anthropic") return getProviderEndpoint(provider.baseUrl, "/messages");
  return getProviderEndpoint(
    provider.baseUrl,
    `/models/${encodedModel}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`,
  );
}

function requestHeaders(provider: CustomProvider, apiKey: string): Record<string, string> {
  if (provider.apiFormat === "anthropic") {
    return {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    };
  }
  if (provider.apiFormat === "gemini") return { "x-goog-api-key": apiKey };
  return { Authorization: `Bearer ${apiKey}` };
}

function getResponseText(format: ApiFormat, payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  if (format === "openai") {
    const choices = record.choices;
    if (!Array.isArray(choices)) return "";
    const content = (choices[0] as { message?: { content?: unknown } } | undefined)?.message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.flatMap((part) => part && typeof part === "object" && "text" in part && typeof part.text === "string" ? [part.text] : []).join("");
    }
    return "";
  }
  if (format === "anthropic") {
    const content = record.content;
    return Array.isArray(content)
      ? content.flatMap((part) => part && typeof part === "object" && "text" in part && typeof part.text === "string" ? [part.text] : []).join("")
      : "";
  }
  const candidates = record.candidates;
  const parts = Array.isArray(candidates)
    ? (candidates[0] as { content?: { parts?: unknown } } | undefined)?.content?.parts
    : undefined;
  return Array.isArray(parts)
    ? parts.flatMap((part) => part && typeof part === "object" && "text" in part && typeof part.text === "string" ? [part.text] : []).join("")
    : "";
}

function getStreamText(format: ApiFormat, payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  if (format === "openai") {
    const choices = record.choices;
    const content = Array.isArray(choices)
      ? (choices[0] as { delta?: { content?: unknown } } | undefined)?.delta?.content
      : undefined;
    if (typeof content === "string") return content;
    return Array.isArray(content)
      ? content.flatMap((part) => part && typeof part === "object" && "text" in part && typeof part.text === "string" ? [part.text] : []).join("")
      : "";
  }
  if (format === "anthropic") {
    const delta = record.delta as { text?: unknown } | undefined;
    return typeof delta?.text === "string" ? delta.text : "";
  }
  return getResponseText(format, payload);
}

async function readStream(
  response: Response,
  provider: CustomProvider,
  onText: (chunk: string) => void,
): Promise<void> {
  if (!response.body) throw new CustomProviderRequestError(`${provider.name} returned no readable response stream.`, true);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const parse = (block: string) => {
    let eventName = "message";
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (!data.length) return;
    const raw = data.join("\n");
    if (raw === "[DONE]") return;
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new CustomProviderRequestError(`${provider.name} returned an invalid streaming event.`, false);
    }
    if (eventName === "error" || (payload && typeof payload === "object" && "error" in payload)) {
      throw new CustomProviderRequestError(`${provider.name} reported a streaming error.`, true);
    }
    onText(getStreamText(provider.apiFormat, payload));
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) parse(block);
      if (done) {
        if (buffer.trim()) parse(buffer);
        break;
      }
    }
  } catch (cause) {
    if (cause instanceof TypeError && !response.bodyUsed) {
      throw new CustomProviderRequestError(`${provider.name} streaming response was interrupted.`, true);
    }
    throw cause;
  } finally {
    reader.releaseLock();
  }
}

export async function requestCustomProvider(input: RequestInput): Promise<void> {
  const stream = input.streaming ?? input.model.streaming;
  let response: Response;
  try {
    response = await fetch(requestUrl(input.provider, input.model, stream), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...requestHeaders(input.provider, input.apiKey) },
      body: JSON.stringify(requestBody(input, stream)),
      signal: input.signal,
    });
  } catch (cause) {
    if (input.signal.aborted) throw cause;
    if (cause instanceof TypeError) {
      throw new CustomProviderRequestError(
        `${input.provider.name} could not be reached. Your network or browser may block this request (CORS). No proxy is configured.`,
        true,
      );
    }
    throw cause;
  }
  if (!response.ok) {
    const detail = await errorDetail(response, input.apiKey);
    throw providerError(input.provider, response.status, detail);
  }
  if (stream) {
    await readStream(response, input.provider, input.onText);
  } else {
    try {
      input.onText(getResponseText(input.provider.apiFormat, await response.json()));
    } catch (cause) {
      if (cause instanceof CustomProviderRequestError) throw cause;
      throw new CustomProviderRequestError(`${input.provider.name} returned an invalid response.`, false);
    }
  }
}

export async function fetchCustomModels(provider: CustomProvider, apiKey: string): Promise<Array<{ id: string; name: string }>> {
  const url = getProviderEndpoint(provider.baseUrl, "/models");
  let response: Response;
  try {
    response = await fetch(url, { headers: requestHeaders(provider, apiKey) });
  } catch (cause) {
    if (cause instanceof TypeError) {
      throw new Error(`${provider.name} could not be reached. Your network or browser may block this request (CORS). No proxy is configured.`);
    }
    throw cause;
  }
  if (!response.ok) {
    const detail = await errorDetail(response, apiKey);
    if (
      response.status === 404
      || response.status === 405
      || response.status === 501
      || (response.status === 400 && /not supported|unsupported|does not support/i.test(detail ?? ""))
    ) {
      throw new Error(`${provider.name} does not provide a compatible GET /models endpoint. Add model IDs manually.`);
    }
    throw providerError(provider, response.status, detail);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`${provider.name} returned an unreadable model list. Add model IDs manually.`);
  }
  if (!payload || typeof payload !== "object") {
    throw new Error(`${provider.name} returned an unsupported model list. Add model IDs manually.`);
  }
  const record = payload as Record<string, unknown>;
  const list = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : null;
  if (!list) throw new Error(`${provider.name} does not provide a compatible GET /models endpoint. Add model IDs manually.`);
  return list.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const entry = item as Record<string, unknown>;
    const rawId = typeof entry.id === "string"
      ? entry.id
      : typeof entry.name === "string"
        ? entry.name
        : null;
    if (!rawId) return [];
    const id = rawId.replace(/^models\//, "");
    const display = typeof entry.displayName === "string" ? entry.displayName : id;
    return [{ id, name: display }];
  });
}

export async function testCustomProvider(
  provider: CustomProvider,
  model: CustomModel,
  apiKey: string,
): Promise<void> {
  let response = "";
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 20_000);
  try {
    await requestCustomProvider({
      provider,
      model,
      apiKey,
      messages: [{ role: "user", content: "Reply with OK." }],
      signal: controller.signal,
      streaming: false,
      onText: (chunk) => { response += chunk; },
    });
  } catch (cause) {
    if (controller.signal.aborted) throw new Error(`${provider.name} connection test timed out.`);
    throw cause;
  } finally {
    window.clearTimeout(timeout);
  }
  if (!response.trim()) throw new Error(`${provider.name} accepted the request but returned no text.`);
}

export function lastFour(apiKey: string): string {
  return apiKey.slice(-4);
}

export function hasImageAttachment(attachments: ChatAttachment[] = []): boolean {
  return attachments.some((attachment) => attachment.kind === "image");
}
