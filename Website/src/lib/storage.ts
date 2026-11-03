import type {
  AppSettings,
  Chat,
  CustomProvider,
  EncryptedApiKey,
  Project,
  VaultMetadata,
} from "../types";

const DATABASE_NAME = "morrow-chat";
const DATABASE_VERSION = 3;
const STORES = {
  chats: "chats",
  projects: "projects",
  keys: "encrypted-api-keys",
  settings: "settings",
  providers: "custom-providers",
} as const;

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "light",
  defaultProvider: "gemini",
  defaultModel: "gemini-3.8-flash",
  customInstructions: "",
  defaultOutputFormat: "auto",
  alwaysAskOutputFormat: false,
  updatedAt: Date.now(),
};

function openDatabase(): Promise<IDBDatabase> {
  if (!("indexedDB" in globalThis)) {
    return Promise.reject(new Error("This browser does not support local IndexedDB storage."));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORES.chats)) {
        database.createObjectStore(STORES.chats, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(STORES.projects)) {
        database.createObjectStore(STORES.projects, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(STORES.keys)) {
        database.createObjectStore(STORES.keys, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(STORES.settings)) {
        database.createObjectStore(STORES.settings, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(STORES.providers)) {
        database.createObjectStore(STORES.providers, { keyPath: "id" });
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error("Could not open local storage."));
    request.onblocked = () => reject(new Error("Close other Morrow tabs to update local storage."));
  });
}

function requestValue<T>(store: string, operation: (objectStore: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDatabase().then((database) => new Promise<T>((resolve, reject) => {
    let request: IDBRequest<T>;
    try {
      request = operation(database.transaction(store, "readonly").objectStore(store));
    } catch (cause) {
      database.close();
      reject(cause);
      return;
    }
    request.onsuccess = () => {
      database.close();
      resolve(request.result);
    };
    request.onerror = () => {
      database.close();
      reject(request.error ?? new Error("Could not read local storage."));
    };
  }));
}

function writeValue(store: string, operation: (objectStore: IDBObjectStore) => IDBRequest): Promise<void> {
  return openDatabase().then((database) => new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(store, "readwrite");
    try {
      operation(transaction.objectStore(store));
    } catch (cause) {
      database.close();
      reject(cause);
      return;
    }
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("Could not update local storage."));
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error ?? new Error("Local storage update was aborted."));
    };
  }));
}

export async function getChats(): Promise<Chat[]> {
  const savedChats = await requestValue<Array<Record<string, unknown>>>(STORES.chats, (store) => store.getAll());
  const chats = savedChats.map((value) => {
    const messages = Array.isArray(value.messages) ? value.messages : [];
    const safeProvider = typeof value.provider === "string" ? value.provider : "gemini";
    return {
      ...value,
      provider: safeProvider,
      model: typeof value.model === "string" ? value.model : DEFAULT_SETTINGS.defaultModel,
      messages: messages.map((message) => {
        const item = message as Record<string, unknown>;
        const attachments = Array.isArray(item.attachments)
          ? item.attachments.flatMap((attachment, index) => {
              if (typeof attachment === "string") {
                return [{
                  id: `legacy-${String(value.id)}-${index}`,
                  name: attachment,
                  mimeType: "text/plain",
                  kind: "text" as const,
                  data: "",
                }];
              }
              if (
                attachment &&
                typeof attachment === "object" &&
                "id" in attachment &&
                "kind" in attachment &&
                "data" in attachment
              ) {
                return [attachment];
              }
              return [];
            })
          : [];
        return { ...item, attachments };
      }),
    } as Chat;
  });
  return chats.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function saveChat(chat: Chat): Promise<void> {
  return writeValue(STORES.chats, (store) => store.put(chat));
}

export function removeChat(id: string): Promise<void> {
  return writeValue(STORES.chats, (store) => store.delete(id));
}

export async function getProjects(): Promise<Project[]> {
  const projects = await requestValue<Project[]>(STORES.projects, (store) => store.getAll());
  return projects.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function saveProject(project: Project): Promise<void> {
  return writeValue(STORES.projects, (store) => store.put(project));
}

export function removeProject(id: string): Promise<void> {
  return writeValue(STORES.projects, (store) => store.delete(id));
}

export async function getEncryptedKeys(): Promise<EncryptedApiKey[]> {
  return requestValue<EncryptedApiKey[]>(STORES.keys, (store) => store.getAll());
}

export function saveEncryptedKey(key: EncryptedApiKey): Promise<void> {
  return writeValue(STORES.keys, (store) => store.put(key));
}

export function removeEncryptedKey(id: string): Promise<void> {
  return writeValue(STORES.keys, (store) => store.delete(id));
}

export async function getCustomProviders(): Promise<CustomProvider[]> {
  const providers = await requestValue<CustomProvider[]>(STORES.providers, (store) => store.getAll());
  return providers.sort((a, b) => a.name.localeCompare(b.name));
}

export function saveCustomProvider(provider: CustomProvider): Promise<void> {
  return writeValue(STORES.providers, (store) => store.put(provider));
}

export function removeCustomProvider(id: string): Promise<void> {
  return writeValue(STORES.providers, (store) => store.delete(id));
}

export async function getAppSettings(): Promise<AppSettings> {
  const record = await requestValue<(AppSettings & { id: string }) | undefined>(
    STORES.settings,
    (store) => store.get("general"),
  );
  return record
    ? { ...DEFAULT_SETTINGS, ...record }
    : { ...DEFAULT_SETTINGS };
}

export function saveAppSettings(settings: AppSettings): Promise<void> {
  return writeValue(STORES.settings, (store) => store.put({ ...settings, id: "general" }));
}

export async function getVaultMetadata(): Promise<VaultMetadata | null> {
  const record = await requestValue<{ id: string; metadata: VaultMetadata } | undefined>(
    STORES.settings,
    (store) => store.get("vault"),
  );
  return record?.metadata ?? null;
}

export function saveVaultMetadata(metadata: VaultMetadata): Promise<void> {
  return writeValue(STORES.settings, (store) => store.put({ id: "vault", metadata }));
}

export async function exportLocalBackup(): Promise<{
  format: string;
  exportedAt: string;
  chats: Chat[];
  projects: Project[];
  settings: AppSettings;
  encryptedApiKeys: EncryptedApiKey[];
  vaultMetadata: VaultMetadata | null;
}> {
  const [chats, projects, settings, encryptedApiKeys, vaultMetadata] = await Promise.all([
    getChats(),
    getProjects(),
    getAppSettings(),
    getEncryptedKeys(),
    getVaultMetadata(),
  ]);
  return {
    format: "morrow-local-backup-v1",
    exportedAt: new Date().toISOString(),
    chats,
    projects,
    settings,
    encryptedApiKeys,
    vaultMetadata,
  };
}

export async function clearAllLocalData(): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const names = Object.values(STORES);
    const transaction = database.transaction(names, "readwrite");
    names.forEach((name) => transaction.objectStore(name).clear());
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("Could not wipe local data."));
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error ?? new Error("Local data wipe was aborted."));
    };
  });
}
