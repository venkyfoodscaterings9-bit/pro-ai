import { afterEach, describe, expect, it, vi } from "vitest";
import type { CustomModel, CustomProvider } from "../types";
import { fetchCustomModels, requestCustomProvider } from "./customProviderApi";
import { getSelectableModelGroups } from "./modelCatalog";
import { getProviderEndpoint, normalizeBaseUrl } from "./providerUrl";

const model: CustomModel = {
  id: "model-id",
  modelId: "test-model",
  displayName: "Test model",
  maxTokens: 64,
  temperature: 0.4,
  vision: false,
  streaming: true,
  enabled: true,
};

function provider(apiFormat: CustomProvider["apiFormat"], baseUrl: string): CustomProvider {
  return {
    id: "custom-test",
    name: "Test provider",
    baseUrl,
    apiFormat,
    enabled: true,
    models: [model],
  };
}

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

afterEach(() => vi.unstubAllGlobals());

describe("provider URL normalization", () => {
  it("removes trailing slashes and duplicate version segments", () => {
    expect(normalizeBaseUrl("https://api.example.com/v1/v1/")).toBe("https://api.example.com/v1");
    expect(getProviderEndpoint("https://api.example.com/v1/", "/v1/chat/completions"))
      .toBe("https://api.example.com/v1/chat/completions");
  });

  it("rejects insecure and credential-bearing URLs", () => {
    expect(() => normalizeBaseUrl("ftp://api.example.com")).toThrow("HTTP or HTTPS");
    expect(() => normalizeBaseUrl("https://user:pass@api.example.com")).toThrow("must not contain credentials");
  });
});

describe("custom provider requests", () => {
  it("only exposes enabled custom models grouped under their provider names", () => {
    const enabled = provider("openai", "https://api.example.com/v1");
    enabled.name = "My OpenRouter";
    enabled.models = [
      model,
      { ...model, id: "disabled", modelId: "hidden-model", enabled: false },
    ];
    const disabled = { ...provider("openai", "https://other.example.com/v1"), id: "custom-disabled", enabled: false };
    const groups = getSelectableModelGroups([enabled, disabled]);
    expect(groups.find((group) => group.id === enabled.id)).toMatchObject({
      name: "My OpenRouter",
      models: [{ modelId: "test-model", name: "Test model" }],
    });
    expect(groups.some((group) => group.id === disabled.id)).toBe(false);
  });

  it("uses OpenAI-compatible endpoint, key header, model and streaming body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    let text = "";
    await requestCustomProvider({
      provider: provider("openai", "https://api.example.com/v1/"),
      model,
      apiKey: "secret-key",
      messages: [{ role: "user", content: "Hi" }],
      signal: new AbortController().signal,
      onText: (chunk) => { text += chunk; },
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect(new Headers(options.headers).get("authorization")).toBe("Bearer secret-key");
    expect(JSON.parse(String(options.body))).toMatchObject({
      model: "test-model",
      stream: true,
      max_tokens: 64,
      temperature: 0.4,
    });
    expect(text).toBe("hello");
  });

  it("uses Anthropic-compatible endpoint and headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ content: [{ type: "text", text: "OK" }] }));
    vi.stubGlobal("fetch", fetchMock);
    let text = "";
    await requestCustomProvider({
      provider: provider("anthropic", "https://api.example.com/v1"),
      model: { ...model, streaming: false },
      apiKey: "secret-key",
      messages: [{ role: "user", content: "Hi" }],
      signal: new AbortController().signal,
      onText: (chunk) => { text += chunk; },
    });

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(options.headers);
    expect(url).toBe("https://api.example.com/v1/messages");
    expect(headers.get("x-api-key")).toBe("secret-key");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(JSON.parse(String(options.body))).toMatchObject({ model: "test-model", stream: false, max_tokens: 64 });
    expect(text).toBe("OK");
  });

  it("uses the Gemini streaming endpoint and API key header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      'data: {"candidates":[{"content":{"parts":[{"text":"Gemini"}]}}]}\n\n',
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    let text = "";
    await requestCustomProvider({
      provider: provider("gemini", "https://api.example.com/v1beta"),
      model,
      apiKey: "secret-key",
      messages: [{ role: "user", content: "Hi" }],
      signal: new AbortController().signal,
      onText: (chunk) => { text += chunk; },
    });

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1beta/models/test-model:streamGenerateContent?alt=sse");
    expect(new Headers(options.headers).get("x-goog-api-key")).toBe("secret-key");
    expect(text).toBe("Gemini");
  });

  it.each([
    [401, "API key was rejected (401)"],
    [404, "endpoint or model was not found (404)"],
    [429, "rate limit reached (429)"],
  ])("reports HTTP %s with a clear provider error", async (status, expected) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: { message: "provider error" } }),
      { status, headers: { "Content-Type": "application/json" } },
    )));
    await expect(requestCustomProvider({
      provider: provider("openai", "https://api.example.com/v1"),
      model,
      apiKey: "secret-key",
      messages: [{ role: "user", content: "Hi" }],
      signal: new AbortController().signal,
      onText: () => {},
    })).rejects.toThrow(expected);
  });

  it("parses model IDs from a compatible models endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ data: [{ id: "model-a" }, { id: "model-b" }] }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchCustomModels(provider("openai", "https://api.example.com/v1/"), "secret-key"))
      .resolves.toEqual([{ id: "model-a", name: "model-a" }, { id: "model-b", name: "model-b" }]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.example.com/v1/models");
  });

  it("explains unsupported model-list endpoints and keeps API keys out of errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: { message: "unsupported endpoint for secret-key" } }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    )));
    await expect(fetchCustomModels(provider("openai", "https://api.example.com/v1"), "secret-key"))
      .rejects.toThrow("does not provide a compatible GET /models endpoint");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: { message: "failed for secret-key" } }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    )));
    await expect(requestCustomProvider({
      provider: provider("openai", "https://api.example.com/v1"),
      model,
      apiKey: "secret-key",
      messages: [{ role: "user", content: "Hi" }],
      signal: new AbortController().signal,
      onText: () => {},
    })).rejects.toThrow("[redacted]");
  });

  it("explains when browser CORS or network restrictions block a request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(requestCustomProvider({
      provider: provider("openai", "https://api.example.com/v1"),
      model,
      apiKey: "secret-key",
      messages: [{ role: "user", content: "Hi" }],
      signal: new AbortController().signal,
      onText: () => {},
    })).rejects.toThrow("CORS). No proxy is configured.");
  });
});
