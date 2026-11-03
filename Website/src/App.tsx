import {
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  Download,
  Files,
  FileText,
  FolderKanban,
  Image as ImageIcon,
  LockKeyhole,
  Menu,
  MessageSquare,
  Moon,
  Paperclip,
  Pencil,
  Pin,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  Sparkles,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import ArtifactPanel from "./components/ArtifactPanel";
import FilesPage from "./components/FilesPage";
import GeneratedFileCard from "./components/GeneratedFileCard";
import MarkdownContent from "./components/MarkdownContent";
import ProjectsPage from "./components/ProjectsPage";
import SettingsDialog from "./components/SettingsDialog";
import { attachmentPreviewUrl, readAttachments } from "./lib/files";
import { buildBackupJson, chatAsMarkdown, downloadTextFile } from "./lib/exports";
import { fetchCustomModels, lastFour, requestCustomProvider, testCustomProvider, CustomProviderRequestError } from "./lib/customProviderApi";
import { buildFileBlob } from "./lib/fileGeneration";
import { getDefaultModel, getProvider, modelHasVision, PROVIDERS, ProviderRequestError, streamProviderResponse } from "./lib/providers";
import { getChatModel, getProviderColor, getProviderName, getSelectableModelGroups } from "./lib/modelCatalog";
import { normalizeBaseUrl } from "./lib/providerUrl";
import {
  buildOutputInstruction,
  fileLabel,
  makeGeneratedFile,
  outputPreferenceOptions,
  parseModelOutput,
  resolveOutputFormats,
  validateStructuredOutput,
  visibleAssistantText,
  convertGeneratedFile as convertOutputFile,
} from "./lib/smartOutput";
import {
  clearAllLocalData,
  DEFAULT_SETTINGS,
  exportLocalBackup,
  getAppSettings,
  getChats,
  getCustomProviders,
  getEncryptedKeys,
  getProjects,
  getVaultMetadata,
  removeChat,
  removeCustomProvider as removeCustomProviderFromStorage,
  removeEncryptedKey,
  removeProject,
  saveAppSettings,
  saveChat,
  saveCustomProvider as persistCustomProvider,
  saveEncryptedKey,
  saveProject as persistProject,
  saveVaultMetadata,
} from "./lib/storage";
import { createVault as initializeVault, decryptApiKey, encryptApiKey, unlockVault } from "./lib/vault";
import type {
  AppSettings,
  CustomModel,
  CustomProvider,
  Artifact,
  Chat,
  ChatAttachment,
  ChatMessage,
  EncryptedApiKey,
  GeneratedFile,
  ImportedCustomProvider,
  OutputFormat,
  OutputFormatPreference,
  Project,
  ProviderId,
  ProviderMessage,
  VaultMetadata,
} from "./types";

const SUGGESTIONS = [
  { title: "Untangle a tricky idea", prompt: "Help me think through a tricky idea: " },
  { title: "Write something thoughtful", prompt: "Help me write something thoughtful about " },
  { title: "Make a plan", prompt: "Help me make a practical plan for " },
  { title: "Learn something new", prompt: "Teach me the basics of " },
];

type SettingsTab = "general" | "keys" | "providers";
type AppPage = "chat" | "projects" | "files";

interface RequestAttempt {
  provider: ProviderId;
  model: string;
  key: EncryptedApiKey;
}

function makeId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function titleFromMessage(message: string): string {
  const clean = message.replace(/\s+/g, " ").trim();
  return clean.length > 48 ? `${clean.slice(0, 48).trimEnd()}…` : clean || "New chat";
}

function createChat(settings: AppSettings, projectId?: string): Chat {
  return {
    id: makeId(),
    title: "New chat",
    messages: [],
    pinned: false,
    updatedAt: Date.now(),
    provider: settings.lastSelectedProvider ?? settings.defaultProvider,
    model: settings.lastSelectedModel ?? settings.defaultModel,
    ...(projectId ? { projectId } : {}),
  };
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof DOMException
    ? cause.name === "AbortError"
    : Boolean(cause && typeof cause === "object" && "name" in cause && cause.name === "AbortError");
}

function errorText(cause: unknown, provider: ProviderId): string {
  if (cause instanceof ProviderRequestError) return cause.message;
  if (cause instanceof CustomProviderRequestError) return cause.message;
  if (cause instanceof TypeError) {
    return `${provider} could not be reached directly. Your network or browser may block this request (CORS). No proxy is configured.`;
  }
  return cause instanceof Error ? cause.message : `${provider} request failed.`;
}

function makeAttempts(
  provider: ProviderId,
  model: string,
  keys: EncryptedApiKey[],
  hasImages: boolean,
): RequestAttempt[] {
  const providerOrder = [provider, ...PROVIDERS.map((item) => item.id).filter((id) => id !== provider)];
  const attempts: RequestAttempt[] = [];
  for (const candidateProvider of providerOrder) {
    let models = candidateProvider === provider
      ? [model, ...getProvider(provider).models.map((item) => item.id).filter((id) => id !== model)]
      : getProvider(candidateProvider).models.map((item) => item.id);
    if (hasImages) {
      models = models.filter((candidateModel) => {
        try {
          return modelHasVision(candidateProvider, candidateModel);
        } catch {
          return false;
        }
      });
    }
    const candidateModel = models[0];
    if (!candidateModel) continue;
    const providerKeys = keys
      .filter((key) => key.provider === candidateProvider)
      .sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0));
    for (const key of providerKeys) {
      attempts.push({ provider: candidateProvider, model: candidateModel, key });
    }
  }
  return attempts;
}

export default function App() {
  const [chats, setChats] = useState<Chat[]>([]);
  const chatsRef = useRef<Chat[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [keys, setKeys] = useState<EncryptedApiKey[]>([]);
  const [customProviders, setCustomProviders] = useState<CustomProvider[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [vaultMetadata, setVaultMetadata] = useState<VaultMetadata | null>(null);
  const [vaultKey, setVaultKey] = useState<CryptoKey | null>(null);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState<AppPage>("chat");
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [settingsNotice, setSettingsNotice] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [chatMenuOpen, setChatMenuOpen] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  const [outputOverride, setOutputOverride] = useState<OutputFormatPreference>("auto");
  const [pendingFormatRequest, setPendingFormatRequest] = useState<{ text: string; formats: OutputFormat[] } | null>(null);
  const [pendingFormats, setPendingFormats] = useState<OutputFormat[]>([]);
  const [streamingChatId, setStreamingChatId] = useState<string | null>(null);
  const [generationStatus, setGenerationStatus] = useState("");
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [storageError, setStorageError] = useState("");
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [printChat, setPrintChat] = useState<Chat | null>(null);
  const [printMessage, setPrintMessage] = useState<{ title: string; message: ChatMessage } | null>(null);
  const [settingsReady, setSettingsReady] = useState(false);
  const deferredSearch = useDeferredValue(search);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const startNewChatRef = useRef<() => void>(() => {});

  const activeChat = chats.find((chat) => chat.id === activeChatId) ?? null;
  const currentProvider = activeChat?.provider ?? settings.lastSelectedProvider ?? settings.defaultProvider;
  const currentModel = activeChat?.model ?? settings.lastSelectedModel ?? settings.defaultModel;
  const modelGroups = useMemo(() => getSelectableModelGroups(customProviders), [customProviders]);
  const activeModel = (() => {
    try {
      return getChatModel(currentProvider, currentModel, customProviders);
    } catch {
      return getChatModel("gemini", getDefaultModel("gemini").id, customProviders);
    }
  })();
  const isStreaming = streamingChatId !== null;
  const printMessages = printChat?.messages ?? (printMessage ? [printMessage.message] : []);
  const printTitle = printChat?.title ?? printMessage?.title ?? "Morrow";

  function replaceChats(update: (current: Chat[]) => Chat[]) {
    const next = update(chatsRef.current);
    chatsRef.current = next;
    setChats(next);
  }

  useEffect(() => {
    let mounted = true;
    Promise.all([getChats(), getProjects(), getEncryptedKeys(), getAppSettings(), getVaultMetadata(), getCustomProviders()])
      .then(([savedChats, savedProjects, savedKeys, savedSettings, metadata, savedCustomProviders]) => {
        if (!mounted) return;
        chatsRef.current = savedChats;
        setChats(savedChats);
        setProjects(savedProjects);
        setKeys(savedKeys);
        setSettings(savedSettings);
        setVaultMetadata(metadata);
        setCustomProviders(savedCustomProviders);
        setSettingsReady(true);
      })
      .catch((cause: unknown) => {
        if (!mounted) return;
        setStorageError(cause instanceof Error ? cause.message : "Could not load local Morrow data.");
        setSettingsReady(true);
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "auto" });
  }, [activeChat?.messages, isStreaming]);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    if (!printChat && !printMessage) return;
    let cancelled = false;
    let firstFrame = 0;
    let secondFrame = 0;
    const previousTitle = document.title;
    document.title = printTitle;
    firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        void document.fonts.ready.then(() => {
          if (!cancelled) window.print();
        });
      });
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
      document.title = previousTitle;
    };
  }, [printChat, printMessage, printTitle]);

  useEffect(() => {
    const onAfterPrint = () => {
      setPrintChat(null);
      setPrintMessage(null);
    };
    window.addEventListener("afterprint", onAfterPrint);
    return () => window.removeEventListener("afterprint", onAfterPrint);
  }, []);

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        startNewChatRef.current();
      } else if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  const visibleChats = useMemo(() => {
    const normalized = deferredSearch.trim().toLowerCase();
    return [...chats]
      .filter((chat) => !normalized || chat.title.toLowerCase().includes(normalized) || chat.messages.some((message) => message.content.toLowerCase().includes(normalized)))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
  }, [chats, deferredSearch]);

  function persistChat(chat: Chat) {
    const lastMessage = chat.messages[chat.messages.length - 1];
    const saveable = lastMessage?.role === "assistant" && !lastMessage.content.trim()
      ? { ...chat, messages: chat.messages.slice(0, -1) }
      : chat;
    saveChat(saveable).catch((cause: unknown) => {
      setStorageError(cause instanceof Error ? cause.message : "Could not save this conversation.");
    });
  }

  function commitChat(chat: Chat) {
    replaceChats((current) => {
      const exists = current.some((item) => item.id === chat.id);
      return exists ? current.map((item) => item.id === chat.id ? chat : item) : [chat, ...current];
    });
    persistChat(chat);
  }

  function updateChat(id: string, update: (chat: Chat) => Chat) {
    const current = chatsRef.current.find((chat) => chat.id === id);
    if (current) commitChat(update(current));
  }

  function startNewChat(projectId?: string) {
    if (isStreaming) abortRef.current?.abort();
    const chat = createChat(settings, projectId);
    replaceChats((current) => [chat, ...current]);
    setActiveChatId(chat.id);
    setCurrentPage("chat");
    setDraft("");
    setPendingAttachments([]);
    setEditingMessageId(null);
    setGenerationStatus("");
    setError("");
    setSidebarOpen(false);
    setArtifact(null);
    persistChat(chat);
    composerRef.current?.focus();
  }
  startNewChatRef.current = startNewChat;

  async function saveSettings(next: AppSettings) {
    const defaultChanged = next.defaultProvider !== settings.defaultProvider || next.defaultModel !== settings.defaultModel;
    const updated = {
      ...next,
      ...(defaultChanged
        ? { lastSelectedProvider: next.defaultProvider, lastSelectedModel: next.defaultModel }
        : {}),
      updatedAt: Date.now(),
    };
    await saveAppSettings(updated);
    setSettings(updated);
  }

  async function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!selected.length) return;
    setError("");
    try {
      const attachments = await readAttachments(selected);
      setPendingAttachments((current) => [...current, ...attachments]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read the selected files.");
    }
  }

  async function createVault(passphrase: string) {
    const created = await initializeVault(passphrase);
    await saveVaultMetadata(created.metadata);
    setVaultMetadata(created.metadata);
    setVaultKey(created.key);
  }

  async function unlockKeyVault(passphrase: string) {
    if (!vaultMetadata) throw new Error("Create a vault before adding API keys.");
    const key = await unlockVault(passphrase, vaultMetadata);
    setVaultKey(key);
  }

  async function saveKey(values: { id?: string; provider: ProviderId; label: string; secret: string }) {
    if (!vaultKey) throw new Error("Unlock the API key vault first.");
    const existing = values.id ? keys.find((key) => key.id === values.id) : undefined;
    if (values.id && !existing) throw new Error("That saved API key no longer exists.");
    const next = values.secret.trim()
      ? await encryptApiKey(vaultKey, {
          id: values.id ?? makeId(),
          provider: values.provider,
          label: values.label,
          apiKey: values.secret,
          createdAt: existing?.createdAt,
          lastUsedAt: existing?.lastUsedAt,
        })
      : existing
        ? { ...existing, label: values.label.trim(), updatedAt: Date.now() }
        : null;
    if (!next) throw new Error("Enter an API key before saving.");
    await saveEncryptedKey(next);
    setKeys((current) => {
      const hasKey = current.some((key) => key.id === next.id);
      return hasKey ? current.map((key) => key.id === next.id ? next : key) : [...current, next];
    });
  }

  async function deleteKey(key: EncryptedApiKey) {
    await removeEncryptedKey(key.id);
    setKeys((current) => current.filter((item) => item.id !== key.id));
  }

  async function saveCustomProvider(provider: CustomProvider, plaintextKey: string) {
    const savedProvider = customProviders.find((item) => item.id === provider.id);
    const normalized: CustomProvider = {
      ...provider,
      name: provider.name.trim(),
      baseUrl: normalizeBaseUrl(provider.baseUrl),
      ...(provider.apiKeyLastFour || savedProvider?.apiKeyLastFour
        ? { apiKeyLastFour: provider.apiKeyLastFour ?? savedProvider?.apiKeyLastFour }
        : {}),
      models: provider.models.map((model) => ({
        ...model,
        modelId: model.modelId.trim(),
        displayName: model.displayName.trim() || model.modelId.trim(),
      })),
    };
    if (!normalized.name) throw new Error("Enter a provider name.");
    if (!normalized.models.every((model) => model.modelId)) throw new Error("Every model must have a model ID.");
    const existingKey = keys.find((key) => key.provider === normalized.id);
    if (plaintextKey.trim()) {
      if (!vaultKey) throw new Error("Unlock the encrypted key vault in Settings → API keys before saving this API key.");
      const encrypted = await encryptApiKey(vaultKey, {
        id: existingKey?.id ?? makeId(),
        provider: normalized.id,
        label: normalized.name,
        apiKey: plaintextKey,
        createdAt: existingKey?.createdAt,
        lastUsedAt: existingKey?.lastUsedAt,
      });
      await saveEncryptedKey(encrypted);
      setKeys((current) => current.some((item) => item.id === encrypted.id)
        ? current.map((item) => item.id === encrypted.id ? encrypted : item)
        : [...current, encrypted]);
    } else if (!existingKey && !savedProvider) {
      throw new Error("This provider has no saved API key. Enter a key before saving.");
    }
    await persistCustomProvider(normalized);
    setCustomProviders((current) => current.some((item) => item.id === normalized.id)
      ? current.map((item) => item.id === normalized.id ? normalized : item).sort((a, b) => a.name.localeCompare(b.name))
      : [...current, normalized].sort((a, b) => a.name.localeCompare(b.name)));
    const defaultModelStillAvailable = normalized.enabled
      && normalized.models.some((model) => model.enabled && model.modelId === settings.defaultModel);
    const lastModelStillAvailable = normalized.enabled
      && normalized.models.some((model) => model.enabled && model.modelId === settings.lastSelectedModel);
    const resetDefault = settings.defaultProvider === normalized.id && !defaultModelStillAvailable;
    const resetLast = settings.lastSelectedProvider === normalized.id && !lastModelStillAvailable;
    if (resetDefault || resetLast) {
      const fallbackModel = getDefaultModel("gemini");
      const updatedSettings = {
        ...settings,
        ...(resetDefault
          ? { defaultProvider: fallbackModel.provider, defaultModel: fallbackModel.id }
          : {}),
        ...(resetLast
          ? { lastSelectedProvider: fallbackModel.provider, lastSelectedModel: fallbackModel.id }
          : {}),
        updatedAt: Date.now(),
      };
      await saveAppSettings(updatedSettings);
      setSettings(updatedSettings);
    }
  }

  async function deleteCustomProvider(provider: CustomProvider) {
    await Promise.all(keys.filter((key) => key.provider === provider.id).map((key) => removeEncryptedKey(key.id)));
    await removeCustomProviderFromStorage(provider.id);
    setKeys((current) => current.filter((key) => key.provider !== provider.id));
    setCustomProviders((current) => current.filter((item) => item.id !== provider.id));
    if (settings.defaultProvider === provider.id || settings.lastSelectedProvider === provider.id) {
      const next = {
        ...settings,
        ...(settings.defaultProvider === provider.id
          ? { defaultProvider: "gemini", defaultModel: getDefaultModel("gemini").id }
          : {}),
        ...(settings.lastSelectedProvider === provider.id
          ? { lastSelectedProvider: "gemini", lastSelectedModel: getDefaultModel("gemini").id }
          : {}),
        updatedAt: Date.now(),
      };
      await saveAppSettings(next);
      setSettings(next);
    }
  }

  async function getCustomApiKey(provider: CustomProvider, enteredKey = ""): Promise<string> {
    if (enteredKey.trim()) return enteredKey.trim();
    if (!vaultKey) throw new Error("Unlock the API key vault in Settings → API keys to use this provider.");
    const key = keys.find((item) => item.provider === provider.id);
    if (!key) throw new Error(`No API key is saved for ${provider.name}. Edit the provider and add its key.`);
    return decryptApiKey(vaultKey, key);
  }

  async function testCustomProviderConnection(provider: CustomProvider, model: CustomModel, enteredKey: string) {
    const apiKey = await getCustomApiKey(provider, enteredKey);
    await testCustomProvider(provider, model, apiKey);
  }

  async function fetchModelsForProvider(provider: CustomProvider, enteredKey: string) {
    const apiKey = await getCustomApiKey(provider, enteredKey);
    return fetchCustomModels(provider, apiKey);
  }

  async function exportCustomProviderConfig(includeApiKeys: boolean) {
    const key = vaultKey;
    if (includeApiKeys && !key) {
      throw new Error("Unlock the API key vault in Settings → API keys before exporting API keys.");
    }
    const exported = await Promise.all(customProviders.map(async (provider) => {
      if (!includeApiKeys) return provider;
      const apiKeyRecord = keys.find((key) => key.provider === provider.id);
      return apiKeyRecord && key
        ? { ...provider, apiKey: await decryptApiKey(key, apiKeyRecord) }
        : provider;
    }));
    downloadTextFile(
      `morrow-providers-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify({ format: "morrow-custom-providers-v1", exportedAt: new Date().toISOString(), providers: exported }, null, 2),
      "application/json;charset=utf-8",
    );
  }

  async function importCustomProviderConfig(imported: ImportedCustomProvider[]) {
    if (!Array.isArray(imported) || !imported.length) throw new Error("The configuration file contains no providers.");
    const seenIds = new Set<string>();
    const normalized = imported.map((item) => {
      if (!item || typeof item !== "object") throw new Error("The configuration contains an invalid provider.");
      if (typeof item.name !== "string" || !item.name.trim()) throw new Error("Every imported provider needs a name.");
      if (typeof item.baseUrl !== "string") throw new Error(`Enter a base URL for ${item.name}.`);
      if (!["openai", "anthropic", "gemini"].includes(item.apiFormat)) throw new Error(`Unsupported API format for ${item.name}.`);
      if (!Array.isArray(item.models)) throw new Error(`The models list for ${item.name} is invalid.`);
      const id = typeof item.id === "string" && /^custom-[A-Za-z0-9-]+$/.test(item.id) ? item.id : `custom-${makeId()}`;
      if (seenIds.has(id)) throw new Error("The configuration contains duplicate provider IDs.");
      seenIds.add(id);
      const modelIds = new Set<string>();
      const models = item.models.map((model) => {
        if (!model || typeof model.modelId !== "string" || !model.modelId.trim()) {
          throw new Error(`Every model in ${item.name} needs a model ID.`);
        }
        const modelId = model.modelId.trim();
        if (modelIds.has(modelId)) throw new Error(`The provider ${item.name} contains a duplicate model ID.`);
        modelIds.add(modelId);
        return {
          id: typeof model.id === "string" && /^model-[A-Za-z0-9-]+$/.test(model.id) ? model.id : `model-${makeId()}`,
          modelId,
          displayName: typeof model.displayName === "string" && model.displayName.trim() ? model.displayName.trim() : modelId,
          ...(typeof model.maxTokens === "number" && Number.isInteger(model.maxTokens) && model.maxTokens > 0 ? { maxTokens: model.maxTokens } : {}),
          ...(typeof model.temperature === "number" && Number.isFinite(model.temperature) && model.temperature >= 0 && model.temperature <= 2 ? { temperature: model.temperature } : {}),
          vision: Boolean(model.vision),
          streaming: model.streaming !== false,
          enabled: model.enabled !== false,
        };
      });
      return {
        provider: {
          id,
          name: item.name.trim(),
          baseUrl: normalizeBaseUrl(item.baseUrl),
          apiFormat: item.apiFormat,
          enabled: item.enabled !== false,
          models,
          ...(typeof item.apiKey === "string" && item.apiKey.trim() ? { apiKeyLastFour: lastFour(item.apiKey.trim()) } : {}),
        } satisfies CustomProvider,
        apiKey: typeof item.apiKey === "string" ? item.apiKey : "",
      };
    });
    if (normalized.some((item) => item.apiKey) && !vaultKey) {
      throw new Error("Unlock the API key vault in Settings → API keys before importing API keys.");
    }
    for (const item of normalized) {
      if (item.apiKey || customProviders.some((provider) => provider.id === item.provider.id)) {
        await saveCustomProvider(item.provider, item.apiKey);
      } else {
        await persistCustomProvider(item.provider);
        setCustomProviders((current) => current.some((provider) => provider.id === item.provider.id)
          ? current.map((provider) => provider.id === item.provider.id ? item.provider : provider)
          : [...current, item.provider]);
      }
    }
  }

  async function exportBackup() {
    const backup = await exportLocalBackup();
    downloadTextFile(
      `morrow-backup-${new Date().toISOString().slice(0, 10)}.json`,
      buildBackupJson(backup),
      "application/json;charset=utf-8",
    );
  }

  async function wipeData() {
    abortRef.current?.abort();
    await clearAllLocalData();
    chatsRef.current = [];
    setChats([]);
    setProjects([]);
    setKeys([]);
    setCustomProviders([]);
    setVaultMetadata(null);
    setVaultKey(null);
    setSettings(DEFAULT_SETTINGS);
    setActiveChatId(null);
    setCurrentPage("chat");
    setSettingsOpen(false);
    setError("");
    setStorageError("");
  }

  async function saveProjectToStorage(project: Project) {
    await persistProject(project);
    setProjects((current) => {
      const exists = current.some((item) => item.id === project.id);
      return exists ? current.map((item) => item.id === project.id ? project : item) : [project, ...current];
    });
  }

  async function deleteProject(project: Project) {
    await removeProject(project.id);
    const detachedChats = chatsRef.current
      .filter((chat) => chat.projectId === project.id)
      .map(({ projectId: _projectId, ...chat }) => chat);
    await Promise.all(detachedChats.map((chat) => saveChat(chat)));
    replaceChats((current) => current.map((chat) => {
      if (chat.projectId !== project.id) return chat;
      const { projectId: _projectId, ...detached } = chat;
      return detached;
    }));
    setProjects((current) => current.filter((item) => item.id !== project.id));
  }

  async function handleModelChange(provider: ProviderId, model: string) {
    setModelPickerOpen(false);
    setError("");
    const selected = {
      ...settings,
      ...(activeChat ? {} : { defaultProvider: provider, defaultModel: model }),
      lastSelectedProvider: provider,
      lastSelectedModel: model,
      updatedAt: Date.now(),
    };
    setSettings(selected);
    saveAppSettings(selected).catch((cause: unknown) => {
      setStorageError(cause instanceof Error ? cause.message : "Could not save the selected model.");
    });
    if (activeChat) {
      updateChat(activeChat.id, (chat) => ({ ...chat, provider, model, updatedAt: Date.now() }));
      return;
    }
  }

  async function markKeyAttempted(key: EncryptedApiKey) {
    const updated = { ...key, lastUsedAt: Date.now() };
    setKeys((current) => current.map((item) => item.id === key.id ? updated : item));
    try {
      await saveEncryptedKey(updated);
    } catch (cause) {
      setStorageError(cause instanceof Error ? cause.message : "Could not save API key usage order.");
    }
  }

  async function sendMessage(
    overrideText?: string,
    replaceFromMessageId?: string,
    overrideAttachments?: ChatAttachment[],
    formatsOverride?: OutputFormat[],
  ) {
    if (isStreaming) return;
    const text = (overrideText ?? draft).trim();
    const attachments = overrideAttachments ?? pendingAttachments;
    if (!text && attachments.length === 0) return;
    const outputFormats = formatsOverride ?? resolveOutputFormats(text, outputOverride, settings.defaultOutputFormat);
    if (formatsOverride === undefined && settings.alwaysAskOutputFormat && outputFormats.length) {
      setPendingFormatRequest({ text, formats: outputFormats });
      setPendingFormats(outputFormats);
      return;
    }

    if (!vaultKey) {
      setSettingsOpen(true);
      setSettingsTab("keys");
      setSettingsNotice(vaultMetadata
        ? "Unlock the key vault to access your saved provider keys."
        : "Create your encrypted key vault, then add a provider key.");
      setError(vaultMetadata
        ? "Unlock the API key vault and choose a saved provider key to send a message."
        : "Create your encrypted API key vault and add a provider key in Settings.");
      return;
    }
    const current = (activeChat && activeChatId === activeChat.id
      ? activeChat
      : null) ?? createChat(settings);
    const provider = current.provider;
    const model = current.model;
    const customProvider = customProviders.find((item) => item.id === provider);
    let selectedModel: ReturnType<typeof getChatModel>;
    try {
      selectedModel = getChatModel(provider, model, customProviders);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Choose a configured model before sending.");
      return;
    }
    const customModel = customProvider?.models.find((item) => item.modelId === model);
    if (customProvider && (!customProvider.enabled || !customModel?.enabled)) {
      setError("This provider or model is disabled. Choose an enabled model or update its settings.");
      return;
    }
    if (attachments.some((item) => item.kind === "image") && !selectedModel.vision) {
      setError(`${selectedModel.name} does not accept image input. Choose a vision-capable model first.`);
      return;
    }
    const providerKeys = keys.filter((key) => key.provider === provider);
    if (customProvider && !providerKeys.length) {
      setSettingsOpen(true);
      setSettingsTab("providers");
      setSettingsNotice(`Add an API key to ${customProvider.name} before sending a message.`);
      setError(`No API key is saved for ${customProvider.name}.`);
      return;
    }
    if (!providerKeys.length && keys.length === 0) {
      setSettingsOpen(true);
      setSettingsTab("keys");
      setSettingsNotice("Add an API key to at least one provider to start a conversation.");
      setError("No API keys are saved yet. Add a key for at least one provider in Settings.");
      return;
    }

    let priorMessages = current.messages;
    if (replaceFromMessageId) {
      const index = current.messages.findIndex((message) => message.id === replaceFromMessageId);
      if (index >= 0) priorMessages = current.messages.slice(0, index);
    }
    const now = Date.now();
    const userMessage: ChatMessage = {
      id: makeId(),
      role: "user",
      content: text,
      createdAt: now,
      attachments,
    };
    const assistantMessage: ChatMessage = {
      id: makeId(),
      role: "assistant",
      content: "",
      createdAt: now + 1,
      provider,
      model,
    };
    const nextChat: Chat = {
      ...current,
      title: current.messages.length ? current.title : titleFromMessage(text || attachments[0]?.name || ""),
      messages: [...priorMessages, userMessage, assistantMessage],
      updatedAt: now,
    };
    setActiveChatId(nextChat.id);
    setCurrentPage("chat");
    setDraft("");
    setPendingAttachments([]);
    setEditingMessageId(null);
    setError("");
    setGenerationStatus("");
    commitChat(nextChat);
    setStreamingChatId(nextChat.id);

    const project = projects.find((item) => item.id === nextChat.projectId);
    const systemPrompt = [
      settings.customInstructions.trim() ? `General instructions:\n${settings.customInstructions.trim()}` : "",
      project?.systemPrompt.trim() ? `Project instructions (${project.name}):\n${project.systemPrompt.trim()}` : "",
      buildOutputInstruction(outputFormats),
    ].filter(Boolean).join("\n\n");
    const messages: ProviderMessage[] = [...priorMessages, userMessage].map((message) => ({
      role: message.role,
      content: message.content,
      attachments: message.attachments,
    }));
    const hasImages = [...priorMessages, userMessage].some((message) =>
      message.attachments?.some((attachment) => attachment.kind === "image"),
    );
    const attempts = customProvider
      ? providerKeys.map((key) => ({ provider, model, key }))
      : makeAttempts(provider, model, keys, hasImages);
    const controller = new AbortController();
    const requestProvider = (
      attempt: RequestAttempt,
      apiKey: string,
      requestMessages: ProviderMessage[],
      requestSystemPrompt: string,
      onText: (chunk: string) => void,
    ) => {
      const custom = customProviders.find((item) => item.id === attempt.provider);
      if (custom) {
        const requestModel = custom.models.find((item) => item.modelId === attempt.model);
        if (!requestModel) throw new Error(`The model ${attempt.model} is no longer configured for ${custom.name}.`);
        return requestCustomProvider({
          provider: custom,
          model: requestModel,
          apiKey,
          messages: requestMessages,
          systemPrompt: requestSystemPrompt,
          signal: controller.signal,
          onText,
        });
      }
      return streamProviderResponse({
        provider: attempt.provider,
        model: attempt.model,
        apiKey,
        messages: requestMessages,
        systemPrompt: requestSystemPrompt,
        signal: controller.signal,
        onText,
      });
    };
    abortRef.current = controller;
    let responseText = "";
    let responseContent = "";
    let generatedFiles: GeneratedFile[] = [];
    let streamUpdateTimer: number | null = null;
    let actualProvider = provider;
    let actualModel = model;
    let finalError = "";
    let fallbackMessage = "";
    let didComplete = false;
    const failedProviders = new Map<ProviderId, boolean>();
    let activeAttemptProvider: ProviderId | null = null;

    try {
      for (const attempt of attempts) {
        if (controller.signal.aborted) break;
        if (failedProviders.get(attempt.provider) === false) continue;
        if (activeAttemptProvider !== attempt.provider) {
          if (activeAttemptProvider) {
            setGenerationStatus(`Trying ${getProviderName(attempt.provider, customProviders)} after ${getProviderName(activeAttemptProvider, customProviders)} could not respond…`);
          } else if (attempt.provider !== provider) {
            setGenerationStatus(providerKeys.length
              ? `Trying ${getProviderName(attempt.provider, customProviders)} as a fallback…`
              : `No ${getProviderName(provider, customProviders)} key is saved. Trying ${getProviderName(attempt.provider, customProviders)}…`);
          } else if (attempt.model !== model) {
            setGenerationStatus(`${getChatModel(provider, model, customProviders).name} cannot accept these images. Trying ${getChatModel(provider, attempt.model, customProviders).name}…`);
          }
          activeAttemptProvider = attempt.provider;
        } else {
          setGenerationStatus(`Trying another saved ${getProviderName(attempt.provider, customProviders)} key…`);
        }

        try {
          const plaintextKey = await decryptApiKey(vaultKey, attempt.key);
          await markKeyAttempted(attempt.key);
          const receiveText = (chunk: string) => {
              if (!responseText) setGenerationStatus("");
              responseText += chunk;
              actualProvider = attempt.provider;
              actualModel = attempt.model;
              if (streamUpdateTimer === null) {
                streamUpdateTimer = window.setTimeout(() => {
                  streamUpdateTimer = null;
                  replaceChats((currentChats) => currentChats.map((chat) => chat.id === nextChat.id
                    ? {
                        ...chat,
                        messages: chat.messages.map((message) => message.id === assistantMessage.id
                          ? { ...message, content: visibleAssistantText(responseText) }
                          : message),
                      }
                    : chat));
                }, 50);
              }
            };
          await requestProvider(attempt, plaintextKey, messages, systemPrompt, receiveText);
          if (!responseText.trim()) {
            throw customProviders.some((item) => item.id === attempt.provider)
              ? new CustomProviderRequestError(`${getProviderName(attempt.provider, customProviders)} returned no text for this response.`, true)
              : new ProviderRequestError(attempt.provider, `${getProviderName(attempt.provider, customProviders)} returned no text for this response.`, true);
          }
          if (outputFormats.length) {
            const parsedOutput = parseModelOutput(responseText, outputFormats);
            responseContent = parsedOutput.reply;
            for (const [index, format] of outputFormats.entries()) {
              let body = parsedOutput.bodies.get(format) ?? responseText;
              try {
                validateStructuredOutput(format, body, responseText);
              } catch (validationError) {
                if (format === "xlsx" || format === "csv" || format === "chart" || format === "pptx" || format === "json") {
                  let repaired = "";
                  await requestProvider(attempt, plaintextKey, [
                      ...messages,
                      { role: "assistant", content: responseText },
                      { role: "user", content: `Return only corrected valid JSON for the ${format} file. Do not use Markdown fences or add explanations. Repair this content:\n${body}` },
                    ], "You repair malformed JSON. Return only valid JSON with the same intended data. Do not add Markdown fences or explanatory text.", (chunk) => { repaired += chunk; });
                  body = repaired.trim();
                  try {
                    validateStructuredOutput(format, body, responseText);
                    parsedOutput.bodies.set(format, body);
                  } catch (repairError) {
                    const detail = repairError instanceof Error ? repairError.message : "The repaired JSON is still invalid.";
                    finalError = `${fileLabel(format)} could not be generated: ${detail}\nRaw model text:\n${parsedOutput.bodies.get(format) ?? responseText}`;
                    continue;
                  }
                } else {
                  const detail = validationError instanceof Error ? validationError.message : "The output could not be parsed.";
                  finalError = `${fileLabel(format)} could not be generated: ${detail}\nRaw model text:\n${body}`;
                  continue;
                }
              }
              try {
                generatedFiles.push(makeGeneratedFile(format, body, index, parsedOutput.names.get(format)));
              } catch (cause) {
                finalError = cause instanceof Error ? `${fileLabel(format)} could not be generated: ${cause.message}\nRaw model text:\n${body}` : `Could not generate ${fileLabel(format)}. Raw model text:\n${body}`;
              }
            }
          } else {
            responseContent = visibleAssistantText(responseText);
          }
          actualProvider = attempt.provider;
          actualModel = attempt.model;
          didComplete = true;
          if (attempt.provider !== provider) {
            fallbackMessage = providerKeys.length
              ? `Used ${getProviderName(attempt.provider, customProviders)} (${getChatModel(attempt.provider, attempt.model, customProviders).name}) after ${getProviderName(provider, customProviders)} failed before producing a response. Your selected model was not changed.`
              : `No ${getProviderName(provider, customProviders)} key was saved, so this response used ${getProviderName(attempt.provider, customProviders)} (${getChatModel(attempt.provider, attempt.model, customProviders).name}). Your selected model was not changed.`;
          } else if (attempt.model !== model) {
            fallbackMessage = `Used ${getChatModel(attempt.provider, attempt.model, customProviders).name} because the selected model does not accept image input. Your selected model was not changed.`;
          } else if (attempt.key.id !== attempts[0]?.key.id) {
            fallbackMessage = `Used the saved key “${attempt.key.label}” after another ${getProviderName(provider, customProviders)} key failed.`;
          }
          break;
        } catch (cause) {
          if (isAbortError(cause) || controller.signal.aborted) break;
          finalError = errorText(cause, attempt.provider);
          const retryable = cause instanceof ProviderRequestError || cause instanceof CustomProviderRequestError ? cause.retryable : true;
          failedProviders.set(attempt.provider, retryable);
          if (responseText) {
            finalError = `${finalError} The provider returned a partial response, so Morrow did not retry it to avoid duplicated output.`;
            break;
          }
          if (attempts.some((item) => item.provider !== attempt.provider)) {
            setGenerationStatus(`${getProviderName(attempt.provider, customProviders)} failed before responding; checking your other saved providers…`);
          }
        }
      }
    } catch (cause) {
      if (!isAbortError(cause)) finalError = errorText(cause, provider);
    } finally {
      if (streamUpdateTimer !== null) window.clearTimeout(streamUpdateTimer);
      const stopped = controller.signal.aborted;
      const latest = chatsRef.current.find((chat) => chat.id === nextChat.id) ?? nextChat;
      const finalAssistant: ChatMessage = {
        ...assistantMessage,
        content: stopped && !responseText ? "Response stopped before any text was received." : responseContent || visibleAssistantText(responseText),
        provider: actualProvider,
        model: actualModel,
        ...(generatedFiles.length ? { generatedFiles } : {}),
        ...(stopped ? { interrupted: true } : {}),
        ...(fallbackMessage ? { fallbackMessage } : {}),
        ...((!didComplete || finalError) && !stopped ? { failure: true, errorText: finalError || "No configured provider could complete this request." } : {}),
      };
      const completedChat: Chat = {
        ...latest,
        messages: latest.messages.map((message) => message.id === assistantMessage.id ? finalAssistant : message),
        updatedAt: Date.now(),
      };
      commitChat(completedChat);
      setStreamingChatId(null);
      setGenerationStatus("");
      setError("");
      abortRef.current = null;
    }
  }

  function stopResponse() {
    abortRef.current?.abort();
  }

  function regenerate(chat: Chat) {
    if (isStreaming) return;
    const lastAssistantIndex = chat.messages.map((message) => message.role).lastIndexOf("assistant");
    const previousUser = chat.messages.slice(0, lastAssistantIndex).reverse().find((message) => message.role === "user");
    if (!previousUser) return;
    setActiveChatId(chat.id);
    void sendMessage(previousUser.content, previousUser.id, previousUser.attachments ?? []);
  }

  function editMessage(message: ChatMessage) {
    if (message.attachments?.length) {
      setError("Editing a message with attachments is not supported. Start a new message with the files attached.");
      return;
    }
    setEditingMessageId(message.id);
    setDraft(message.content);
    composerRef.current?.focus();
  }

  async function copyMessage(message: ChatMessage) {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopiedMessageId(message.id);
      window.setTimeout(() => setCopiedMessageId(null), 1500);
    } catch {
      setError("Clipboard access is unavailable in this browser.");
    }
  }

  async function downloadGeneratedFile(file: GeneratedFile, name: string) {
    try {
      const blob = await buildFileBlob(file);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = name;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      setError(cause instanceof Error ? `Could not create ${fileLabel(file.format)} file: ${cause.message}` : `Could not create ${fileLabel(file.format)} file.`);
    }
  }

  function addGeneratedFileToMessage(chatId: string, messageId: string, file: GeneratedFile) {
    updateChat(chatId, (chat) => ({
      ...chat,
      messages: chat.messages.map((message) => message.id === messageId
        ? { ...message, generatedFiles: [...(message.generatedFiles ?? []), file] }
        : message),
      updatedAt: Date.now(),
    }));
  }

  function convertExistingFile(file: GeneratedFile, format: OutputFormat) {
    try {
      const converted = convertOutputFile(file, format);
      const owner = chatsRef.current.find((chat) => chat.messages.some((message) =>
        message.generatedFiles?.some((existingFile) => existingFile.id === file.id),
      ));
      const message = owner?.messages.find((item) => item.generatedFiles?.some((existingFile) => existingFile.id === file.id));
      if (owner && message) addGeneratedFileToMessage(owner.id, message.id, converted);
      else setError("This file is no longer attached to a conversation.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Could not convert the file to ${fileLabel(format)}.`);
    }
  }

  function createMessageFile(message: ChatMessage, chat: Chat, format: OutputFormat) {
    try {
      const sourceFile = message.generatedFiles?.[0] ?? {
        id: `message-${message.id}`,
        name: "response.md",
        format: "markdown" as const,
        content: message.content,
        createdAt: message.createdAt,
      };
      const generated = convertOutputFile(sourceFile, format);
      addGeneratedFileToMessage(chat.id, message.id, generated);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Could not convert this response to ${fileLabel(format)}.`);
    }
  }

  async function deleteConversation(chat: Chat) {
    try {
      await removeChat(chat.id);
      replaceChats((current) => current.filter((item) => item.id !== chat.id));
      if (activeChatId === chat.id) setActiveChatId(null);
    } catch (cause) {
      setStorageError(cause instanceof Error ? cause.message : "Could not delete the conversation.");
    }
  }

  function openSettings(tab: SettingsTab = "general") {
    setSettingsTab(tab);
    setSettingsNotice("");
    setSettingsOpen(true);
    setModelPickerOpen(false);
  }

  function exportCurrentChat(chat: Chat) {
    downloadTextFile(
      `${chat.title.replace(/[^\w.-]+/g, "-").slice(0, 60) || "morrow-chat"}.md`,
      chatAsMarkdown(chat),
      "text/markdown;charset=utf-8",
    );
    setChatMenuOpen(false);
  }

  function printCurrentChat(chat: Chat) {
    setPrintMessage(null);
    setPrintChat(chat);
    setChatMenuOpen(false);
  }

  function printCurrentResponse(message: ChatMessage, title: string) {
    setPrintChat(null);
    setPrintMessage({ title, message });
  }

  function openArtifact(nextArtifact: Artifact) {
    setArtifact(nextArtifact);
  }

  function handleComposerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  return (
    <>
      <div className="app-shell">
        {sidebarOpen && <button className="mobile-scrim" aria-label="Close menu" onClick={() => setSidebarOpen(false)} />}
        <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
          <div className="sidebar-top">
            <a className="brand" href="#" onClick={(event) => event.preventDefault()} aria-label="Morrow home">
              <span className="brand-mark"><Sparkles size={17} strokeWidth={2.2} /></span>
              <span>morrow</span>
            </a>
            <button className="icon-button sidebar-close" aria-label="Close menu" onClick={() => setSidebarOpen(false)}><X size={18} /></button>
          </div>
          <button className="new-chat-button" onClick={() => startNewChat(activeChat?.projectId)}>
            <Plus size={17} strokeWidth={2} /><span>New chat</span><span className="shortcut">Ctrl/⌘ K</span>
          </button>
          <label className="search-box">
            <Search size={16} />
            <input ref={searchInputRef} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search chats" />
            <span className="search-shortcut">Ctrl/⌘ F</span>
          </label>
          <nav className="sidebar-nav" aria-label="Main navigation">
            <button className={currentPage === "projects" ? "nav-item nav-item-active" : "nav-item"} onClick={() => { setCurrentPage("projects"); setSidebarOpen(false); }}>
              <FolderKanban size={17} /><span>Projects</span><span className="nav-soon">{projects.length || ""}</span>
            </button>
            <button className={currentPage === "files" ? "nav-item nav-item-active" : "nav-item"} onClick={() => { setCurrentPage("files"); setSidebarOpen(false); }}>
              <Files size={17} /><span>Files</span><span className="nav-soon">{chats.reduce((total, chat) => total + chat.messages.reduce((count, message) => count + (message.generatedFiles?.length ?? 0), 0), 0) || ""}</span>
            </button>
          </nav>
          <div className="history-heading"><span>Recent</span><span className="history-count">{visibleChats.length || ""}</span></div>
          <div className="chat-list">
            {visibleChats.map((chat) => (
              <div className={`chat-row ${chat.id === activeChatId && currentPage === "chat" ? "chat-row-active" : ""}`} key={chat.id}>
                <button className="chat-row-main" onClick={() => { setActiveChatId(chat.id); setCurrentPage("chat"); setSidebarOpen(false); setError(""); setGenerationStatus(""); }}>
                  {chat.pinned ? <Pin size={14} className="pinned-icon" /> : <MessageSquare size={15} />}
                  <span className="chat-title">{chat.title}</span>
                </button>
                <div className="chat-row-actions">
                  <button aria-label={chat.pinned ? "Unpin chat" : "Pin chat"} title={chat.pinned ? "Unpin chat" : "Pin chat"} onClick={() => updateChat(chat.id, (item) => ({ ...item, pinned: !item.pinned }))}><Pin size={14} /></button>
                  <button aria-label="Rename chat" title="Rename chat" onClick={() => {
                    const title = window.prompt("Rename chat", chat.title);
                    if (title?.trim()) updateChat(chat.id, (item) => ({ ...item, title: title.trim(), updatedAt: Date.now() }));
                  }}><Pencil size={14} /></button>
                  <button aria-label="Delete chat" title="Delete chat" onClick={() => void deleteConversation(chat)}><Trash2 size={14} /></button>
                </div>
              </div>
            ))}
            {visibleChats.length === 0 && search && <p className="empty-search">No chats match “{search}”.</p>}
            {visibleChats.length === 0 && !search && <p className="sidebar-empty">Your conversations will appear here.</p>}
          </div>
          <div className="sidebar-bottom">
            <button className="settings-link" onClick={() => openSettings("general")}><Settings2 size={17} /><span>Settings</span></button>
            <button className="vault-sidebar-status" onClick={() => openSettings("keys")}>
              <span className="local-dot" />
              <span>{vaultKey ? "Key vault unlocked" : keys.length ? "Key vault locked" : "Connect an AI provider"}</span>
              {!vaultKey && <LockKeyhole size={13} />}
            </button>
            <button className="theme-toggle" onClick={() => {
              const next = { ...settings, theme: settings.theme === "light" ? "dark" as const : "light" as const, updatedAt: Date.now() };
              setSettings(next);
              saveAppSettings(next).catch((cause: unknown) => setStorageError(cause instanceof Error ? cause.message : "Could not save the theme."));
            }}>
              <span>{settings.theme === "light" ? <Moon size={16} /> : <Sun size={16} />}</span>
              <span>{settings.theme === "light" ? "Dark appearance" : "Light appearance"}</span>
            </button>
          </div>
        </aside>

        <main className="main-panel">
          {currentPage === "files" ? (
            <FilesPage
              chats={chats}
              onDownload={downloadGeneratedFile}
              onConvert={convertExistingFile}
              onOpenChat={(chat) => { setActiveChatId(chat.id); setCurrentPage("chat"); setSidebarOpen(false); }}
            />
          ) : currentPage === "projects" ? (
            <ProjectsPage
              projects={projects}
              chats={chats}
              onBack={() => setCurrentPage("chat")}
              onSave={saveProjectToStorage}
              onDelete={deleteProject}
              onOpenChat={(chat) => { setActiveChatId(chat.id); setCurrentPage("chat"); }}
              onNewChat={startNewChat}
            />
          ) : (
            <>
              <header className="topbar">
                <button className="icon-button mobile-menu" aria-label="Open menu" onClick={() => setSidebarOpen(true)}><Menu size={19} /></button>
                <div className="topbar-start">
                  <div className="model-picker-anchor">
                    <button className="model-picker" onClick={() => setModelPickerOpen((open) => !open)} aria-expanded={modelPickerOpen} aria-label="Choose model">
                      <span className="provider-dot" style={{ backgroundColor: getProviderColor(currentProvider, customProviders) }} />
                      <span>{activeModel.name}</span><ChevronDown size={15} />
                    </button>
                    {modelPickerOpen && (
                      <>
                        <button className="popover-scrim" aria-label="Close model picker" onClick={() => setModelPickerOpen(false)} />
                        <div className="model-popover">
                          <div className="model-popover-heading"><strong>Choose a model</strong><span>Available model IDs may change</span></div>
                          {modelGroups.map((provider) => {
                            const providerKeys = keys.filter((key) => key.provider === provider.id);
                            return (
                              <section className="model-provider-group" key={provider.id}>
                                <div className="model-provider-heading">
                                  <span className="provider-dot" style={{ backgroundColor: getProviderColor(provider.id, customProviders) }} />
                                  <span>{provider.name}</span><small>{providerKeys.length} {providerKeys.length === 1 ? "key" : "keys"}</small>
                                </div>
                                {provider.models.map((model) => (
                                  <button
                                    className={provider.id === currentProvider && model.modelId === currentModel ? "model-option model-option-selected" : "model-option"}
                                    key={`${provider.id}:${model.modelId}`}
                                    onClick={() => void handleModelChange(provider.id, model.modelId)}
                                  >
                                    <span>{model.name}</span>
                                    {provider.id === currentProvider && model.modelId === currentModel && <Check size={14} />}
                                  </button>
                                ))}
                              </section>
                            );
                          })}
                          <button className="model-add-key" onClick={() => openSettings("keys")}><Plus size={14} /> Manage provider keys</button>
                          <button className="model-add-key" onClick={() => openSettings("providers")}><Plus size={14} /> Models &amp; Providers</button>
                        </div>
                      </>
                    )}
                  </div>
                  {activeChat && (
                    <select
                      className="header-project-select"
                      aria-label="Assign chat to a project"
                      value={activeChat.projectId ?? ""}
                      onChange={(event) => updateChat(activeChat.id, (chat) => ({
                        ...chat,
                        ...(event.target.value ? { projectId: event.target.value } : { projectId: undefined }),
                        updatedAt: Date.now(),
                      }))}
                    >
                      <option value="">No project</option>
                      {projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}
                    </select>
                  )}
                </div>
                <div className="topbar-right">
                  <span className="provider-label">{getProviderName(currentProvider, customProviders)}</span>
                  {activeChat && (
                    <div className="chat-menu-anchor">
                      <button className="top-settings-button" aria-label="Export conversation" title="Export conversation" onClick={() => setChatMenuOpen((open) => !open)}><Download size={17} /></button>
                      {chatMenuOpen && (
                        <div className="chat-export-menu">
                          <button onClick={() => exportCurrentChat(activeChat)}><FileText size={15} /> Export as Markdown</button>
                          <button onClick={() => printCurrentChat(activeChat)}><Download size={15} /> Save as PDF…</button>
                        </div>
                      )}
                    </div>
                  )}
                  <button className="top-settings-button" onClick={() => openSettings("general")} aria-label="Open settings"><Settings2 size={18} /></button>
                </div>
              </header>

              {storageError && (
                <div className="storage-warning" role="alert">
                  <span>{storageError} Changes may not persist locally.</span>
                  <button onClick={() => setStorageError("")} aria-label="Dismiss storage warning"><X size={15} /></button>
                </div>
              )}
              {error && (
                <div className="storage-warning inline-top-error" role="alert">
                  <span>{error}</span><button onClick={() => setError("")} aria-label="Dismiss error"><X size={15} /></button>
                </div>
              )}
              <div className={`chat-workspace ${artifact ? "chat-workspace-with-artifact" : ""}`}>
                <section className={`conversation ${activeChat?.messages.length ? "conversation-has-messages" : ""}`}>
                  {activeChat?.messages.length ? (
                    <div className="message-list">
                      {activeChat.messages.map((message, index) => {
                        const isLastAssistant = message.role === "assistant" && index === activeChat.messages.length - 1;
                        const waiting = streamingChatId === activeChat.id && isLastAssistant && !message.content;
                                      const messageProvider = message.provider && message.model
                                        ? `${getProviderName(message.provider, customProviders)} · ${(() => {
                                            try {
                                              return getChatModel(message.provider, message.model, customProviders).name;
                                            } catch {
                                              return message.model;
                                            }
                                          })()}`
                                        : undefined;
                        return (
                          <article className={`message message-${message.role}`} key={message.id}>
                            {message.role === "assistant" && <div className="assistant-avatar"><Sparkles size={15} /></div>}
                            <div className="message-content-wrap">
                              <div className="message-label">
                                <span>{message.role === "user" ? "You" : "Morrow"}</span>
                                {messageProvider && <span className="message-provider-label">{messageProvider}</span>}
                              </div>
                              <div className={`message-content ${message.role === "user" ? "user-bubble" : ""}`}>
                                {message.attachments?.length ? (
                                  <div className="message-attachments">
                                    {message.attachments.map((attachment) => {
                                      const previewUrl = attachmentPreviewUrl(attachment);
                                      return previewUrl ? (
                                        <a className="message-image-link" href={previewUrl} target="_blank" rel="noreferrer" key={attachment.id} aria-label={`View ${attachment.name}`}>
                                          <img src={previewUrl} alt={attachment.name} />
                                        </a>
                                      ) : (
                                        <span className="attachment-pill" key={attachment.id}><FileText size={13} />{attachment.name}</span>
                                      );
                                    })}
                                  </div>
                                ) : null}
                                {waiting ? (
                                  <span className="thinking"><i /><i /><i /></span>
                                ) : message.role === "assistant" ? (
                                  <>
                                    {message.fallbackMessage && <p className="fallback-notice">{message.fallbackMessage}</p>}
                                    {message.errorText && <p className="message-error">{message.errorText}</p>}
                                    {message.content && <MarkdownContent content={message.content} onArtifact={openArtifact} />}
                                    {message.generatedFiles?.map((file) => (
                                      <GeneratedFileCard
                                        key={file.id}
                                        file={file}
                                        onDownload={downloadGeneratedFile}
                                        onConvert={convertExistingFile}
                                      />
                                    ))}
                                    {message.interrupted && message.content && <p className="interrupted-note">Response stopped. The content above is partial.</p>}
                                  </>
                                ) : (
                                  <div className="user-message-text">{message.content || (message.attachments?.length ? "Please review these attachments." : "")}</div>
                                )}
                              </div>
                              {message.role === "assistant" && (message.content || message.errorText) && (
                                <div className="message-actions">
                                  {message.content && <button onClick={() => void copyMessage(message)} aria-label="Copy response" title="Copy response">
                                    {copiedMessageId === message.id ? <Check size={14} /> : <Copy size={14} />}
                                    <span>{copiedMessageId === message.id ? "Copied" : "Copy"}</span>
                                  </button>}
                                  {message.content && <button onClick={() => printCurrentResponse(message, activeChat.title)} aria-label="Save response as PDF" title="Save response as PDF">
                                    <Download size={14} /><span>Save as PDF</span>
                                  </button>}
                                  {isLastAssistant && !isStreaming && <button onClick={() => regenerate(activeChat)} aria-label="Regenerate response" title="Regenerate response">
                                    <RotateCcw size={14} /><span>{message.failure ? "Retry" : "Regenerate"}</span>
                                  </button>}
                                  {isLastAssistant && message.failure && !isStreaming && <button onClick={() => { setError(""); setModelPickerOpen(true); }} aria-label="Switch model" title="Choose a different model">
                                    <ChevronDown size={14} /><span>Switch model</span>
                                  </button>}
                                </div>
                              )}
                              {message.role === "assistant" && message.content && activeChat && (
                                message.generatedFiles?.length || /^\s*\|.+\|\s*$/m.test(message.content) || /```(?:json|csv|html|markdown|md)?\s*\n/i.test(message.content)
                              ) && (
                                <div className="output-quick-actions" aria-label="Export this response">
                                  <span>Export as</span>
                                  {(["xlsx", "html", "pdf", "csv"] as OutputFormat[]).map((format) => (
                                    <button key={format} onClick={() => createMessageFile(message, activeChat, format)}>{fileLabel(format)}</button>
                                  ))}
                                </div>
                              )}
                              {message.role === "user" && !isStreaming && (
                                <div className="message-actions">
                                  <button onClick={() => editMessage(message)} aria-label="Edit message" title="Edit message"><Pencil size={14} /><span>Edit</span></button>
                                </div>
                              )}
                            </div>
                          </article>
                        );
                      })}
                      <div ref={bottomRef} />
                    </div>
                  ) : (
                    <div className="welcome">
                      <div className="welcome-icon"><Sparkles size={22} strokeWidth={1.8} /></div>
                      <p className="eyebrow">A little more clarity</p>
                      <h1>Good to see you.<br /><span>What’s on your mind?</span></h1>
                      <p className="welcome-copy">A calm space to think, make, and figure things out — one conversation at a time.</p>
                      <div className="suggestion-grid">
                        {SUGGESTIONS.map((suggestion, index) => (
                          <button className="suggestion-card" key={suggestion.title} onClick={() => { setDraft(suggestion.prompt); composerRef.current?.focus(); }}>
                            <span className={`suggestion-mark suggestion-mark-${index}`}><Sparkles size={15} /></span>
                            <span>{suggestion.title}</span><span className="suggestion-arrow">↗</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </section>
                {artifact && <ArtifactPanel artifact={artifact} onClose={() => setArtifact(null)} />}
              </div>

              <div className="composer-dock">
                {generationStatus && <div className="generation-status" role="status"><span className="status-spinner" />{generationStatus}</div>}
                {pendingAttachments.length > 0 && (
                  <div className="pending-files">
                    {pendingAttachments.map((attachment) => {
                      const preview = attachmentPreviewUrl(attachment);
                      return (
                        <div className="pending-file" key={attachment.id}>
                          {preview ? <img src={preview} alt="" /> : <FileText size={16} />}
                          <span>{attachment.name}</span>
                          <button onClick={() => setPendingAttachments((current) => current.filter((item) => item.id !== attachment.id))} aria-label={`Remove ${attachment.name}`}><X size={14} /></button>
                        </div>
                      );
                    })}
                  </div>
                )}
                {editingMessageId && (
                  <div className="edit-banner"><Pencil size={14} /> Editing message
                    <button onClick={() => { setEditingMessageId(null); setDraft(""); }} aria-label="Cancel edit"><X size={14} /></button>
                  </div>
                )}
                <div className="composer">
                  <textarea
                    ref={composerRef}
                    rows={1}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={handleComposerKeyDown}
                    placeholder={`Message ${getProviderName(currentProvider, customProviders)}…`}
                    aria-label="Message Morrow"
                    disabled={isStreaming || !settingsReady}
                  />
                  <div className="composer-toolbar">
                    <div className="composer-tools">
                      <button className="composer-tool" onClick={() => fileInputRef.current?.click()} aria-label="Attach files" title="Images, PDF, and text files" disabled={isStreaming}>
                        <Paperclip size={17} /><span className="attach-label">Attach</span>
                      </button>
                      <input ref={fileInputRef} className="sr-only" type="file" accept="image/jpeg,image/png,image/webp,image/gif,application/pdf,text/*,.txt,.md,.csv,.json,.html,.css,.js,.ts,.py,.yaml,.yml" multiple onChange={(event) => void handleFiles(event)} />
                      <button className="composer-model" onClick={() => setModelPickerOpen(true)} disabled={isStreaming}>
                        <span className="provider-dot" style={{ backgroundColor: getProviderColor(currentProvider, customProviders) }} />{activeModel.name}<ChevronDown size={13} />
                      </button>
                      {pendingAttachments.some((item) => item.kind === "image") && <span className="image-ready"><ImageIcon size={13} /> Vision</span>}
                    </div>
                    <select
                      className="output-format-selector"
                      aria-label="Output format"
                      title="Choose an output file format"
                      value={outputOverride}
                      disabled={isStreaming}
                      onChange={(event) => setOutputOverride(event.target.value as OutputFormatPreference)}
                    >
                      {outputPreferenceOptions().map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}
                    </select>
                    {isStreaming ? (
                      <button className="send-button stop-button" onClick={stopResponse} aria-label="Stop response" title="Stop response"><span className="stop-square" /></button>
                    ) : (
                      <button className="send-button" onClick={() => void sendMessage()} disabled={(!draft.trim() && pendingAttachments.length === 0) || !settingsReady} aria-label="Send message" title="Send message">
                        <ArrowUp size={18} strokeWidth={2.3} />
                      </button>
                    )}
                  </div>
                </div>
                <p className="composer-footnote">Morrow can make mistakes. Check important information.</p>
              </div>
            </>
          )}
        </main>
      </div>

      {pendingFormatRequest && (
        <div className="output-ask-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setPendingFormatRequest(null);
        }}>
          <section className="output-ask-modal" role="dialog" aria-modal="true" aria-labelledby="output-ask-title">
            <button className="icon-button output-ask-close" onClick={() => setPendingFormatRequest(null)} aria-label="Close format selection"><X size={18} /></button>
            <p className="eyebrow">Smart output</p>
            <h2 id="output-ask-title">Which formats should I create?</h2>
            <p>Morrow detected these formats in your message. Choose one or more before sending.</p>
            <div className="output-format-checks">
              {outputPreferenceOptions().filter((option) => option.id !== "auto" && option.id !== "chat").map((option) => {
                const format = option.id as OutputFormat;
                return (
                  <label key={format}>
                    <input
                      type="checkbox"
                      checked={pendingFormats.includes(format)}
                      onChange={(event) => setPendingFormats((current) => event.target.checked
                        ? [...current, format]
                        : current.filter((item) => item !== format))}
                    />
                    {option.label}
                  </label>
                );
              })}
            </div>
            <div className="output-ask-actions">
              <button className="appearance-button" onClick={() => setPendingFormatRequest(null)}>Cancel</button>
              <button className="done-button" onClick={() => {
                const { text: requestText } = pendingFormatRequest;
                const selectedFormats = [...pendingFormats];
                setPendingFormatRequest(null);
                void sendMessage(requestText, undefined, undefined, selectedFormats);
              }}>Continue</button>
            </div>
          </section>
        </div>
      )}

      {settingsOpen && settingsReady && (
        <SettingsDialog
          settings={settings}
          customProviders={customProviders}
          keys={keys}
          vaultMetadata={vaultMetadata}
          vaultUnlocked={Boolean(vaultKey)}
          initialTab={settingsTab}
          initialNotice={settingsNotice}
          onClose={() => setSettingsOpen(false)}
          onSaveSettings={saveSettings}
          onCreateVault={createVault}
          onUnlockVault={unlockKeyVault}
          onLockVault={() => setVaultKey(null)}
          onSaveKey={saveKey}
          onDeleteKey={deleteKey}
          onExport={exportBackup}
          onWipe={wipeData}
          onSaveCustomProvider={saveCustomProvider}
          onDeleteCustomProvider={deleteCustomProvider}
          onTestCustomProvider={testCustomProviderConnection}
          onFetchCustomModels={fetchModelsForProvider}
          onImportCustomProviders={importCustomProviderConfig}
          onExportCustomProviders={exportCustomProviderConfig}
        />
      )}

      {(printChat || printMessage) && (
        <article className="print-sheet">
          <h1>{printTitle}</h1>
          <p className="print-date">Exported from Morrow · {new Date().toLocaleString()}</p>
          {printMessages.map((message) => (
            <section className="print-message" key={message.id}>
              <h2>{message.role === "user" ? "You" : "Morrow"}</h2>
              {message.attachments?.length ? <p>Attachments: {message.attachments.map((item) => item.name).join(", ")}</p> : null}
              {message.role === "assistant"
                ? <MarkdownContent content={message.content} />
                : <p>{message.content}</p>}
            </section>
          ))}
        </article>
      )}
    </>
  );
}
