import { Eye, EyeOff, Plus, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import type { ApiFormat, CustomModel, CustomProvider, ImportedCustomProvider } from "../types";
import { normalizeBaseUrl } from "../lib/providerUrl";

interface ProviderDraft {
  id?: string;
  name: string;
  baseUrl: string;
  apiFormat: ApiFormat;
  enabled: boolean;
}

interface ModelDraft {
  id?: string;
  modelId: string;
  displayName: string;
  maxTokens: string;
  temperature: string;
  vision: boolean;
  streaming: boolean;
  enabled: boolean;
}

interface ModelsProvidersSettingsProps {
  providers: CustomProvider[];
  vaultUnlocked: boolean;
  onSaveProvider: (provider: CustomProvider, apiKey: string) => Promise<void>;
  onDeleteProvider: (provider: CustomProvider) => Promise<void>;
  onTestProvider: (provider: CustomProvider, model: CustomModel, apiKey: string) => Promise<void>;
  onFetchModels: (provider: CustomProvider, apiKey: string) => Promise<Array<{ id: string; name: string }>>;
  onImport: (providers: ImportedCustomProvider[]) => Promise<void>;
  onExport: (includeApiKeys: boolean) => Promise<void>;
}

const EMPTY_PROVIDER: ProviderDraft = { name: "", baseUrl: "", apiFormat: "openai", enabled: true };
const EMPTY_MODEL: ModelDraft = {
  modelId: "",
  displayName: "",
  maxTokens: "",
  temperature: "",
  vision: false,
  streaming: true,
  enabled: true,
};

function providerToModelDraft(model?: CustomModel): ModelDraft {
  return model ? {
    id: model.id,
    modelId: model.modelId,
    displayName: model.displayName,
    maxTokens: model.maxTokens === undefined ? "" : String(model.maxTokens),
    temperature: model.temperature === undefined ? "" : String(model.temperature),
    vision: model.vision,
    streaming: model.streaming,
    enabled: model.enabled,
  } : { ...EMPTY_MODEL };
}

export default function ModelsProvidersSettings({
  providers,
  vaultUnlocked,
  onSaveProvider,
  onDeleteProvider,
  onTestProvider,
  onFetchModels,
  onImport,
  onExport,
}: ModelsProvidersSettingsProps) {
  const [selectedId, setSelectedId] = useState<string | null>(providers[0]?.id ?? null);
  const [providerDraft, setProviderDraft] = useState<ProviderDraft | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [modelDraft, setModelDraft] = useState<ModelDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [includeApiKeys, setIncludeApiKeys] = useState(false);
  const [testModelId, setTestModelId] = useState("");
  const [fetchedModels, setFetchedModels] = useState<Array<{ id: string; name: string; selected: boolean }>>([]);
  const importRef = useRef<HTMLInputElement>(null);
  const selectedProvider = providers.find((provider) => provider.id === selectedId) ?? null;
  const editingProvider = providerDraft?.id
    ? providers.find((provider) => provider.id === providerDraft.id)
    : undefined;
  const defaultTestModel = selectedProvider?.models.find((model) => model.enabled) ?? selectedProvider?.models[0];
  const selectedTestModel = selectedProvider?.models.find((model) => model.id === testModelId) ?? defaultTestModel;

  async function run(action: () => Promise<void>, success?: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      if (success) setNotice(success);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The provider action could not be completed.");
    } finally {
      setBusy(false);
    }
  }

  function startNewProvider() {
    setSelectedId(null);
    setProviderDraft({ ...EMPTY_PROVIDER });
    setApiKey("");
    setShowApiKey(false);
    setModelDraft(null);
    setTestModelId("");
    setError("");
    setNotice("");
  }

  function editProvider(provider: CustomProvider) {
    setSelectedId(provider.id);
    setProviderDraft({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiFormat: provider.apiFormat,
      enabled: provider.enabled,
    });
    setApiKey("");
    setShowApiKey(false);
    setModelDraft(null);
    setTestModelId("");
    setError("");
    setNotice("");
  }

  async function saveProvider(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!providerDraft) return;
    await run(async () => {
      const name = providerDraft.name.trim();
      if (!name) throw new Error("Enter a provider name.");
      const normalizedBaseUrl = normalizeBaseUrl(providerDraft.baseUrl);
      if (!providerDraft.id && !apiKey.trim()) throw new Error("Enter an API key before adding this provider.");
      if (!apiKey.trim() && !editingProvider?.apiKeyLastFour) {
        throw new Error("Enter an API key before saving this provider.");
      }
      const provider: CustomProvider = {
        id: providerDraft.id ?? `custom-${crypto.randomUUID()}`,
        name,
        baseUrl: normalizedBaseUrl,
        apiFormat: providerDraft.apiFormat,
        enabled: providerDraft.enabled,
        models: editingProvider?.models ?? [],
        ...(apiKey.trim()
          ? { apiKeyLastFour: apiKey.trim().slice(-4) }
          : editingProvider?.apiKeyLastFour
            ? { apiKeyLastFour: editingProvider.apiKeyLastFour }
            : {}),
      };
      await onSaveProvider(provider, apiKey);
      setSelectedId(provider.id);
      setProviderDraft(null);
      setApiKey("");
    }, "Provider saved. The API key is encrypted in this browser.");
  }

  async function saveModel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProvider || !modelDraft) return;
    await run(async () => {
      const modelId = modelDraft.modelId.trim();
      if (!modelId) throw new Error("Enter the exact model ID.");
      const maxTokens = modelDraft.maxTokens.trim() ? Number(modelDraft.maxTokens) : undefined;
      const temperature = modelDraft.temperature.trim() ? Number(modelDraft.temperature) : undefined;
      if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens < 1)) {
        throw new Error("Maximum tokens must be a positive whole number.");
      }
      const maxTemperature = selectedProvider.apiFormat === "anthropic" ? 1 : 2;
      if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > maxTemperature)) {
        throw new Error(`Temperature must be between 0 and ${maxTemperature} for this API format.`);
      }
      const model: CustomModel = {
        id: modelDraft.id ?? `model-${crypto.randomUUID()}`,
        modelId,
        displayName: modelDraft.displayName.trim() || modelId,
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
        vision: modelDraft.vision,
        streaming: modelDraft.streaming,
        enabled: modelDraft.enabled,
      };
      const duplicate = selectedProvider.models.some((item) => item.modelId === modelId && item.id !== model.id);
      if (duplicate) throw new Error("That model ID is already registered for this provider.");
      await onSaveProvider({
        ...selectedProvider,
        models: model.id
          ? selectedProvider.models.some((item) => item.id === model.id)
            ? selectedProvider.models.map((item) => item.id === model.id ? model : item)
            : [...selectedProvider.models, model]
          : [...selectedProvider.models, model],
      }, "");
      setModelDraft(null);
    }, "Model saved.");
  }

  async function toggleProvider(provider: CustomProvider) {
    await run(() => onSaveProvider({ ...provider, enabled: !provider.enabled }, ""), "Provider status updated.");
  }

  async function removeModel(model: CustomModel) {
    if (!selectedProvider || !window.confirm(`Delete model “${model.displayName}”?`)) return;
    await run(() => onSaveProvider({
      ...selectedProvider,
      models: selectedProvider.models.filter((item) => item.id !== model.id),
    }, ""), "Model deleted.");
  }

  async function toggleModel(model: CustomModel) {
    if (!selectedProvider) return;
    await run(() => onSaveProvider({
      ...selectedProvider,
      models: selectedProvider.models.map((item) => item.id === model.id ? { ...item, enabled: !item.enabled } : item),
    }, ""), "Model status updated.");
  }

  async function fetchModels() {
    const source = providerDraft ?? selectedProvider;
    if (!source) return;
    await run(async () => {
      const name = source.name.trim();
      const baseUrl = normalizeBaseUrl(source.baseUrl);
      const current = providers.find((provider) => provider.id === source.id);
      if (!apiKey.trim() && !current?.apiKeyLastFour) throw new Error("Enter and save an API key before fetching models.");
      const draftProvider: CustomProvider = {
        id: source.id ?? "pending-custom-provider",
        name: name || "Provider",
        baseUrl,
        apiFormat: source.apiFormat,
        enabled: source.enabled,
        models: current?.models ?? [],
        ...(apiKey.trim() ? { apiKeyLastFour: apiKey.slice(-4) } : current?.apiKeyLastFour ? { apiKeyLastFour: current.apiKeyLastFour } : {}),
      };
      const result = await onFetchModels(draftProvider, apiKey);
      setFetchedModels(result.map((model) => ({ ...model, selected: !current?.models.some((saved) => saved.modelId === model.id) })));
      setNotice(result.length ? `${result.length} model${result.length === 1 ? "" : "s"} found.` : "No models were returned. Add model IDs manually.");
    });
  }

  async function importConfiguration(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    await run(async () => {
      const parsed: unknown = JSON.parse(await file.text());
      const providersList = parsed && typeof parsed === "object" && "providers" in parsed
        ? (parsed as { providers: unknown }).providers
        : parsed;
      if (!Array.isArray(providersList)) throw new Error("Configuration file must contain a providers list.");
      await onImport(providersList as ImportedCustomProvider[]);
    }, "Provider configuration imported.");
  }

  async function addFetchedModels() {
    if (!selectedProvider || !fetchedModels.length) return;
    const seenIds = new Set(selectedProvider.models.map((model) => model.modelId));
    const additions = fetchedModels.filter((model) => model.selected).flatMap((fetched) => {
      if (seenIds.has(fetched.id)) return [];
      seenIds.add(fetched.id);
      return [{
        id: `model-${crypto.randomUUID()}`,
        modelId: fetched.id,
        displayName: fetched.name || fetched.id,
        vision: false,
        streaming: true,
        enabled: true,
      } satisfies CustomModel];
    });
    await run(async () => {
      await onSaveProvider({ ...selectedProvider, models: [...selectedProvider.models, ...additions] }, "");
      setFetchedModels([]);
    }, `${additions.length} model${additions.length === 1 ? "" : "s"} added.`);
  }

  async function deleteProvider(provider: CustomProvider) {
    if (!window.confirm(`Delete provider “${provider.name}” and its saved API key? Existing conversations will remain in history.`)) return;
    await run(async () => {
      await onDeleteProvider(provider);
      if (selectedId === provider.id) {
        const next = providers.find((item) => item.id !== provider.id);
        setSelectedId(next?.id ?? null);
        setProviderDraft(null);
        setTestModelId("");
        setFetchedModels([]);
      }
    }, "Provider and its saved key deleted.");
  }

  return (
    <div className="settings-content models-providers-settings">
      <section className="settings-section">
        <div className="settings-row">
          <div><h3>Models &amp; Providers</h3><p>Connect custom API endpoints and choose the models available in chat.</p></div>
          <button type="button" className="done-button" onClick={startNewProvider}><Plus size={14} /> Add provider</button>
        </div>
      </section>
      {error && <div className="settings-feedback settings-feedback-error" role="alert">{error}</div>}
      {notice && <div className="settings-feedback settings-feedback-success" role="status">{notice}</div>}
      {!vaultUnlocked && <p className="field-hint">Unlock the encrypted key vault in the API keys tab before adding or replacing provider keys.</p>}

      <div className="models-providers-layout">
        <div className="models-provider-list">
          {providers.length ? providers.map((provider) => (
            <div className="models-provider-entry" key={provider.id}>
              <button
                type="button"
                className={`models-provider-select${selectedProvider?.id === provider.id ? " models-provider-selected" : ""}`}
                onClick={() => { setSelectedId(provider.id); setProviderDraft(null); setModelDraft(null); setTestModelId(""); setFetchedModels([]); setError(""); setNotice(""); }}
              >
                <span><strong>{provider.name}</strong><small>{provider.models.length} model{provider.models.length === 1 ? "" : "s"} · {provider.enabled ? "Enabled" : "Disabled"}</small></span>
              </button>
              <button type="button" className="appearance-button" aria-label={`Edit ${provider.name}`} onClick={() => editProvider(provider)}>Edit</button>
            </div>
          )) : <p className="field-hint">No custom providers yet. Add one to get started.</p>}
        </div>

        {providerDraft ? (
          <form className="settings-section models-provider-form" onSubmit={(event) => void saveProvider(event)}>
            <h3>{providerDraft.id ? "Edit provider" : "Add provider"}</h3>
            <label className="field-label form-gap" htmlFor="custom-provider-name">Provider name</label>
            <input id="custom-provider-name" className="text-field" required maxLength={80} value={providerDraft.name} onChange={(event) => setProviderDraft({ ...providerDraft, name: event.target.value })} placeholder="My OpenRouter" />
            <label className="field-label form-gap" htmlFor="custom-provider-url">Base URL</label>
            <input id="custom-provider-url" className="text-field" type="url" required value={providerDraft.baseUrl} onChange={(event) => setProviderDraft({ ...providerDraft, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" />
            <label className="field-label form-gap" htmlFor="custom-provider-format">API format</label>
            <select id="custom-provider-format" className="text-field" value={providerDraft.apiFormat} onChange={(event) => setProviderDraft({ ...providerDraft, apiFormat: event.target.value as ApiFormat })}>
              <option value="openai">OpenAI-compatible</option>
              <option value="anthropic">Anthropic-compatible</option>
              <option value="gemini">Gemini-compatible</option>
            </select>
            <label className="field-label form-gap" htmlFor="custom-provider-key">API key</label>
            <div className="provider-key-input">
              <input id="custom-provider-key" className="text-field" type={showApiKey ? "text" : "password"} autoComplete="new-password" spellCheck={false} required={!editingProvider?.apiKeyLastFour} value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={editingProvider?.apiKeyLastFour ? `•••• ${editingProvider.apiKeyLastFour} (leave blank to keep)` : "Paste API key"} />
              <button type="button" className="icon-button" onClick={() => setShowApiKey((value) => !value)} aria-label={showApiKey ? "Hide API key" : "Show API key"}>{showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}</button>
            </div>
            {editingProvider?.apiKeyLastFour && <p className="field-hint"><ShieldCheck size={12} /> Saved key masked ·••••{editingProvider.apiKeyLastFour}. Leave blank to keep it.</p>}
            <label className="output-ask-setting form-gap">
              <input type="checkbox" checked={providerDraft.enabled} onChange={(event) => setProviderDraft({ ...providerDraft, enabled: event.target.checked })} />
              <span><strong>Provider enabled</strong><small>Enabled providers and models appear in the chat model selector.</small></span>
            </label>
            <div className="provider-editor-actions">
              <button type="button" className="appearance-button" onClick={() => { setProviderDraft(null); setApiKey(""); }} disabled={busy}>Cancel</button>
              <button type="submit" className="done-button" disabled={busy}>{busy ? "Saving…" : "Save provider"}</button>
            </div>
          </form>
        ) : selectedProvider ? (
          <section className="settings-section models-provider-details">
            <div className="settings-row">
              <div><h3>{selectedProvider.name}</h3><p>{selectedProvider.baseUrl}</p></div>
              <div className="data-actions">
                <button type="button" className="appearance-button" onClick={() => void toggleProvider(selectedProvider)} disabled={busy}>{selectedProvider.enabled ? "Disable" : "Enable"}</button>
                <button type="button" className="wipe-button" onClick={() => void deleteProvider(selectedProvider)} disabled={busy}><Trash2 size={13} /> Delete</button>
              </div>
            </div>
            <p className="field-hint">{selectedProvider.apiKeyLastFour
            ? `API key ·••••${selectedProvider.apiKeyLastFour} · ${selectedProvider.apiFormat}-compatible`
            : `No API key saved · ${selectedProvider.apiFormat}-compatible`}</p>
            <div className="settings-row models-section-heading">
              <div><h3>Models</h3><p>Register the exact model IDs accepted by this provider.</p></div>
              <button type="button" className="done-button" onClick={() => setModelDraft({ ...EMPTY_MODEL })}><Plus size={14} /> Add model</button>
            </div>
            <div className="data-actions models-provider-actions">
              <button type="button" className="appearance-button" onClick={() => void fetchModels()} disabled={busy}><RefreshCw size={13} /> Fetch models from provider</button>
              <button type="button" className="appearance-button" onClick={() => editProvider(selectedProvider)}>Edit provider</button>
            </div>
            <div className="provider-test-row">
              <label className="field-label" htmlFor="test-provider-model">Test connection with model</label>
              <select id="test-provider-model" className="text-field" value={selectedTestModel?.id ?? ""} onChange={(event) => setTestModelId(event.target.value)} disabled={!selectedProvider.models.length}>
                {selectedProvider.models.map((model) => <option value={model.id} key={model.id}>{model.displayName} · {model.modelId}</option>)}
              </select>
              <button type="button" className="appearance-button" onClick={() => {
                const model = selectedTestModel;
                if (!model) {
                  setError("Add a model before testing this provider.");
                  return;
                }
                void run(() => onTestProvider(selectedProvider, model, ""), "Provider connection succeeded.");
              }} disabled={busy || !selectedProvider.models.length}>Test connection</button>
            </div>
            {fetchedModels.length > 0 && (
              <div className="fetched-model-list">
                <strong>Models returned by provider</strong>
                {fetchedModels.map((model) => (
                  <label key={model.id}><input type="checkbox" checked={model.selected} onChange={(event) => setFetchedModels((current) => current.map((item) => item.id === model.id ? { ...item, selected: event.target.checked } : item))} /><span>{model.name}<small>{model.id}</small></span></label>
                ))}
                <button type="button" className="done-button" onClick={() => void addFetchedModels()} disabled={busy}>Add selected models</button>
              </div>
            )}
            {selectedProvider.models.length ? selectedProvider.models.map((model) => (
              <div className="custom-model-row" key={model.id}>
                <div><strong>{model.displayName}</strong><small>{model.modelId} · {model.enabled ? "Enabled" : "Disabled"}{model.vision ? " · Vision" : ""}{model.streaming ? " · Streaming" : ""}</small></div>
                <div className="data-actions">
                  <button type="button" className="appearance-button" onClick={() => void toggleModel(model)} disabled={busy}>{model.enabled ? "Disable" : "Enable"}</button>
                  <button type="button" className="appearance-button" onClick={() => setModelDraft(providerToModelDraft(model))}>Edit</button>
                  <button type="button" className="key-delete-button" aria-label={`Delete ${model.displayName}`} onClick={() => void removeModel(model)} disabled={busy}><Trash2 size={14} /></button>
                </div>
              </div>
            )) : <p className="field-hint">No models registered yet. Fetch models or add a model ID manually.</p>}
            {modelDraft && (
              <form className="models-model-form" onSubmit={(event) => void saveModel(event)}>
                <h3>{modelDraft.id ? "Edit model" : "Add model"}</h3>
                <label className="field-label form-gap" htmlFor="custom-model-id">Model ID</label>
                <input id="custom-model-id" className="text-field" required maxLength={200} value={modelDraft.modelId} onChange={(event) => setModelDraft({ ...modelDraft, modelId: event.target.value })} placeholder="gpt-4o" />
                <label className="field-label form-gap" htmlFor="custom-model-name">Display name</label>
                <input id="custom-model-name" className="text-field" maxLength={100} value={modelDraft.displayName} onChange={(event) => setModelDraft({ ...modelDraft, displayName: event.target.value })} placeholder="GPT-4o" />
                <div className="models-model-numbers">
                  <label><span className="field-label">Max tokens</span><input className="text-field" type="number" min="1" step="1" value={modelDraft.maxTokens} onChange={(event) => setModelDraft({ ...modelDraft, maxTokens: event.target.value })} /></label>
                  <label><span className="field-label">Temperature default</span><input className="text-field" type="number" min="0" max="2" step="0.1" value={modelDraft.temperature} onChange={(event) => setModelDraft({ ...modelDraft, temperature: event.target.value })} /></label>
                </div>
                <div className="models-model-options">
                  <label><input type="checkbox" checked={modelDraft.vision} onChange={(event) => setModelDraft({ ...modelDraft, vision: event.target.checked })} /> Supports vision</label>
                  <label><input type="checkbox" checked={modelDraft.streaming} onChange={(event) => setModelDraft({ ...modelDraft, streaming: event.target.checked })} /> Supports streaming</label>
                  <label><input type="checkbox" checked={modelDraft.enabled} onChange={(event) => setModelDraft({ ...modelDraft, enabled: event.target.checked })} /> Enabled</label>
                </div>
                <div className="provider-editor-actions">
                  <button type="button" className="appearance-button" onClick={() => setModelDraft(null)} disabled={busy}>Cancel</button>
                  <button type="submit" className="done-button" disabled={busy}>{busy ? "Saving…" : "Save model"}</button>
                </div>
              </form>
            )}
          </section>
        ) : (
          <div className="settings-section models-provider-empty"><p>Select a provider to manage models, or add a provider connection.</p></div>
        )}
      </div>

      <section className="settings-section models-provider-transfer">
        <div className="settings-row">
          <div><h3>Configuration backup</h3><p>Export or import your custom providers and models.</p></div>
          <div className="data-actions">
            <button type="button" className="appearance-button" onClick={() => void run(() => onExport(includeApiKeys))} disabled={busy}>Export JSON</button>
            <button type="button" className="appearance-button" onClick={() => importRef.current?.click()} disabled={busy}>Import JSON</button>
            <input ref={importRef} className="visually-hidden" type="file" accept="application/json,.json" onChange={(event) => void importConfiguration(event)} />
          </div>
        </div>
        <label className="output-ask-setting form-gap">
          <input type="checkbox" checked={includeApiKeys} onChange={(event) => setIncludeApiKeys(event.target.checked)} />
          <span><strong>Include API keys in export</strong><small>Unchecked by default. Included keys are plaintext in the downloaded JSON file.</small></span>
        </label>
      </section>
    </div>
  );
}
