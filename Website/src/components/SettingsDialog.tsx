import {
  Check,
  KeyRound,
  LockKeyhole,
  Moon,
  Plus,
  ShieldCheck,
  Sun,
  Trash2,
  UnlockKeyhole,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { getProvider, PROVIDERS } from "../lib/providers";
import { outputPreferenceOptions } from "../lib/smartOutput";
import type {
  AppSettings,
  EncryptedApiKey,
  ProviderId,
  Theme,
  VaultMetadata,
} from "../types";

type SettingsTab = "general" | "keys";

interface KeyForm {
  id?: string;
  provider: ProviderId;
  label: string;
  secret: string;
}

interface SettingsDialogProps {
  settings: AppSettings;
  keys: EncryptedApiKey[];
  vaultMetadata: VaultMetadata | null;
  vaultUnlocked: boolean;
  initialTab?: SettingsTab;
  initialNotice?: string;
  onClose: () => void;
  onSaveSettings: (settings: AppSettings) => Promise<void>;
  onCreateVault: (passphrase: string) => Promise<void>;
  onUnlockVault: (passphrase: string) => Promise<void>;
  onLockVault: () => void;
  onSaveKey: (values: KeyForm) => Promise<void>;
  onDeleteKey: (key: EncryptedApiKey) => Promise<void>;
  onExport: () => Promise<void>;
  onWipe: () => Promise<void>;
}

export default function SettingsDialog({
  settings,
  keys,
  vaultMetadata,
  vaultUnlocked,
  initialTab = "general",
  initialNotice = "",
  onClose,
  onSaveSettings,
  onCreateVault,
  onUnlockVault,
  onLockVault,
  onSaveKey,
  onDeleteKey,
  onExport,
  onWipe,
}: SettingsDialogProps) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [draftSettings, setDraftSettings] = useState(settings);
  const [passphrase, setPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [keyForm, setKeyForm] = useState<KeyForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(initialNotice);

  useEffect(() => {
    setDraftSettings(settings);
  }, [settings]);

  async function run(action: () => Promise<void>, success?: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      if (success) setNotice(success);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The action could not be completed.");
    } finally {
      setBusy(false);
    }
  }

  async function unlock() {
    if (!vaultMetadata) {
      if (passphrase !== confirmPassphrase) {
        setError("The passphrases do not match.");
        return;
      }
      await run(() => onCreateVault(passphrase), "Your encrypted key vault is ready.");
    } else {
      await run(() => onUnlockVault(passphrase));
    }
    setPassphrase("");
    setConfirmPassphrase("");
  }

  async function saveKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!keyForm) return;
    await run(async () => {
      await onSaveKey(keyForm);
      setKeyForm(null);
    }, "API key saved encrypted in this browser.");
  }

  async function saveGeneral() {
    await run(async () => {
      await onSaveSettings({ ...draftSettings, updatedAt: Date.now() });
    }, "Settings saved.");
  }

  async function exportBackup() {
    await run(onExport, "Encrypted local backup downloaded.");
  }

  async function wipeData() {
    if (!window.confirm("Permanently delete all chats, projects, settings, and encrypted API keys from this browser? This cannot be undone.")) return;
    await run(onWipe, "All local Morrow data was removed.");
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section className="settings-modal settings-modal-wide" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="modal-heading">
          <div>
            <p className="eyebrow">Your workspace</p>
            <h2 id="settings-title">Settings</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close settings"><X size={19} /></button>
        </div>

        <div className="settings-tabs" role="tablist" aria-label="Settings sections">
          <button className={tab === "general" ? "settings-tab settings-tab-active" : "settings-tab"} onClick={() => { setTab("general"); setError(""); setNotice(""); }} role="tab" aria-selected={tab === "general"}>
            General
          </button>
          <button className={tab === "keys" ? "settings-tab settings-tab-active" : "settings-tab"} onClick={() => { setTab("keys"); setError(""); setNotice(""); }} role="tab" aria-selected={tab === "keys"}>
            <KeyRound size={14} /> API keys <span className="key-count">{keys.length}</span>
          </button>
        </div>

        {error && <div className="settings-feedback settings-feedback-error" role="alert">{error}</div>}
        {notice && <div className="settings-feedback settings-feedback-success" role="status"><Check size={14} />{notice}</div>}

        {tab === "general" ? (
          <div className="settings-content">
            <section className="settings-section">
              <div className="settings-row">
                <div><h3>Appearance</h3><p>Choose the look that feels right.</p></div>
                <div className="segmented-control" role="group" aria-label="Theme">
                  {(["light", "dark"] as Theme[]).map((theme) => (
                    <button
                      key={theme}
                      className={draftSettings.theme === theme ? "segment segment-active" : "segment"}
                      onClick={() => setDraftSettings((current) => ({ ...current, theme }))}
                    >
                      {theme === "light" ? <Sun size={14} /> : <Moon size={14} />}
                      {theme === "light" ? "Light" : "Dark"}
                    </button>
                  ))}
                </div>
              </div>
            </section>
            <section className="settings-section">
              <label className="field-label" htmlFor="default-model">Default model</label>
              <select
                id="default-model"
                className="text-field"
                value={`${draftSettings.defaultProvider}:${draftSettings.defaultModel}`}
                onChange={(event) => {
                  const [provider, ...modelParts] = event.target.value.split(":");
                  setDraftSettings((current) => ({
                    ...current,
                    defaultProvider: provider as ProviderId,
                    defaultModel: modelParts.join(":"),
                  }));
                }}
              >
                {PROVIDERS.map((provider) => (
                  <optgroup label={provider.name} key={provider.id}>
                    {provider.models.map((model) => (
                      <option key={model.id} value={`${provider.id}:${model.id}`}>{model.name}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <p className="field-hint">Available models can change. Check your provider account for access and pricing.</p>
            </section>
            <section className="settings-section">
              <label className="field-label" htmlFor="default-output-format">Default output format</label>
              <select
                id="default-output-format"
                className="text-field"
                value={draftSettings.defaultOutputFormat}
                onChange={(event) => setDraftSettings((current) => ({
                  ...current,
                  defaultOutputFormat: event.target.value as AppSettings["defaultOutputFormat"],
                }))}
              >
                {outputPreferenceOptions().map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}
              </select>
              <label className="output-ask-setting">
                <input
                  type="checkbox"
                  checked={draftSettings.alwaysAskOutputFormat}
                  onChange={(event) => setDraftSettings((current) => ({ ...current, alwaysAskOutputFormat: event.target.checked }))}
                />
                <span><strong>Always ask which format before generating</strong><small>Confirm or adjust detected formats before sending a request.</small></span>
              </label>
            </section>
            <section className="settings-section">
              <label className="field-label" htmlFor="custom-instructions">Custom instructions</label>
              <textarea
                id="custom-instructions"
                className="text-field text-area-field"
                rows={4}
                maxLength={8000}
                value={draftSettings.customInstructions}
                onChange={(event) => setDraftSettings((current) => ({ ...current, customInstructions: event.target.value }))}
                placeholder="How should Morrow respond across your chats?"
              />
              <p className="field-hint">Sent to the selected model as a system instruction. Project instructions take priority and are added alongside these.</p>
            </section>
            <section className="settings-section settings-danger-zone">
              <div><h3>Local data</h3><p>Export a backup or permanently wipe all Morrow data stored in this browser.</p></div>
              <div className="data-actions">
                <button className="appearance-button" onClick={() => void exportBackup()} disabled={busy}>Export backup</button>
                <button className="wipe-button" onClick={() => void wipeData()} disabled={busy}><Trash2 size={14} /> Wipe data</button>
              </div>
            </section>
          </div>
        ) : (
          <div className="settings-content">
            <section className="settings-section vault-intro">
              <div className="vault-status-icon">{vaultUnlocked ? <UnlockKeyhole size={18} /> : <LockKeyhole size={18} />}</div>
              <div className="vault-status-copy">
                <h3>{vaultUnlocked ? "Vault unlocked" : vaultMetadata ? "Vault locked" : "Create your encrypted vault"}</h3>
                <p>
                  {vaultUnlocked
                    ? "The vault stays unlocked in this tab until you lock it or close or reload the app."
                    : vaultMetadata
                      ? "Enter the passphrase you chose to access your saved keys."
                      : "Choose a strong passphrase. Morrow cannot recover it if you forget it."}
                </p>
              </div>
              {vaultUnlocked ? (
                <button className="appearance-button" onClick={onLockVault}><LockKeyhole size={14} /> Lock</button>
              ) : null}
            </section>
            {!vaultUnlocked ? (
              <form className="vault-unlock-form" onSubmit={(event) => { event.preventDefault(); void unlock(); }}>
                <label className="field-label" htmlFor="vault-passphrase">{vaultMetadata ? "Vault passphrase" : "Create passphrase"}</label>
                <input
                  id="vault-passphrase"
                  className="text-field"
                  type="password"
                  autoComplete="new-password"
                  minLength={vaultMetadata ? undefined : 10}
                  required
                  value={passphrase}
                  onChange={(event) => setPassphrase(event.target.value)}
                  placeholder={vaultMetadata ? "Enter your vault passphrase" : "At least 10 characters"}
                />
                {!vaultMetadata && (
                  <>
                    <label className="field-label confirmation-label" htmlFor="vault-passphrase-confirm">Confirm passphrase</label>
                    <input
                      id="vault-passphrase-confirm"
                      className="text-field"
                      type="password"
                      autoComplete="new-password"
                      minLength={10}
                      required
                      value={confirmPassphrase}
                      onChange={(event) => setConfirmPassphrase(event.target.value)}
                      placeholder="Enter it again"
                    />
                  </>
                )}
                <button className="done-button vault-submit" type="submit" disabled={busy}>
                  {busy ? "Unlocking…" : vaultMetadata ? "Unlock vault" : "Create vault"}
                </button>
              </form>
            ) : (
              <div className="key-manager">
                <div className="key-manager-heading">
                  <div><h3>Provider keys</h3><p>Keys are encrypted with AES-GCM before being saved.</p></div>
                  <button className="done-button add-key-button" onClick={() => setKeyForm({ provider: "anthropic", label: "", secret: "" })}><Plus size={15} /> Add key</button>
                </div>
                {PROVIDERS.map((provider) => {
                  const providerKeys = keys.filter((item) => item.provider === provider.id);
                  return (
                    <div className="provider-key-group" key={provider.id}>
                      <div className="provider-key-heading">
                        <span className="provider-dot" style={{ backgroundColor: provider.color }} />
                        <strong>{provider.name}</strong>
                        <span>{providerKeys.length || "No"} {providerKeys.length === 1 ? "key" : "keys"}</span>
                      </div>
                      {providerKeys.map((key) => (
                        <div className="api-key-row" key={key.id}>
                          <div className="api-key-lock"><ShieldCheck size={15} /></div>
                          <div className="api-key-label"><strong>{key.label}</strong><span>Encrypted ·••••••••</span></div>
                          <button aria-label={`Edit ${key.label}`} title="Edit label or replace key" onClick={() => setKeyForm({ id: key.id, provider: key.provider, label: key.label, secret: "" })}>Edit</button>
                          <button className="key-delete-button" aria-label={`Delete ${key.label}`} title="Delete key" onClick={() => {
                            if (window.confirm(`Delete “${key.label}”?`)) void run(() => onDeleteKey(key));
                          }}><Trash2 size={14} /></button>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            )}
            <p className="vault-caveat">
              Encryption protects keys at rest, not against malicious scripts, browser extensions, browser compromise, or a compromised device. Keys are sent directly to the chosen provider. Direct browser requests may be blocked by provider CORS; no proxy is included.
            </p>
          </div>
        )}

        <div className="settings-footer">
          <span><span className="local-dot" /> Stored locally in IndexedDB</span>
          <div className="settings-footer-actions">
            {tab === "general" && <button className="done-button" onClick={() => void saveGeneral()} disabled={busy}>Save settings</button>}
            <button className="appearance-button" onClick={onClose}>Close</button>
          </div>
        </div>

        {keyForm && (
          <div className="key-form-backdrop" role="presentation" onMouseDown={(event) => {
            if (event.target === event.currentTarget) setKeyForm(null);
          }}>
            <form className="key-form" onSubmit={(event) => void saveKey(event)}>
              <div className="key-form-heading">
                <div><p className="eyebrow">{keyForm.id ? "Update a connection" : "New connection"}</p><h3>{keyForm.id ? "Edit API key" : "Add API key"}</h3></div>
                <button type="button" className="icon-button" onClick={() => setKeyForm(null)} aria-label="Close key form"><X size={18} /></button>
              </div>
              <label className="field-label" htmlFor="key-provider">Provider</label>
              <select id="key-provider" className="text-field" value={keyForm.provider} disabled={Boolean(keyForm.id)} onChange={(event) => setKeyForm({ ...keyForm, provider: event.target.value as ProviderId })}>
                {PROVIDERS.map((provider) => <option value={provider.id} key={provider.id}>{provider.name}</option>)}
              </select>
              <label className="field-label form-gap" htmlFor="key-label">Label</label>
              <input id="key-label" className="text-field" required maxLength={40} value={keyForm.label} onChange={(event) => setKeyForm({ ...keyForm, label: event.target.value })} placeholder={`My ${getProvider(keyForm.provider).name} key`} />
              <label className="field-label form-gap" htmlFor="key-secret">{keyForm.id ? "Replace API key (optional)" : "API key"}</label>
              <input id="key-secret" className="text-field" type="password" autoComplete="off" spellCheck={false} required={!keyForm.id} value={keyForm.secret} onChange={(event) => setKeyForm({ ...keyForm, secret: event.target.value })} placeholder={keyForm.id ? "Leave blank to keep the current key" : "Paste your API key"} />
              {keyForm.id && <p className="field-hint">Your existing API key is never displayed. Leave this blank to keep it unchanged.</p>}
              <div className="key-form-footer">
                <button type="button" className="appearance-button" onClick={() => setKeyForm(null)}>Cancel</button>
                <button className="done-button" type="submit" disabled={busy}>{busy ? "Saving…" : "Save encrypted key"}</button>
              </div>
            </form>
          </div>
        )}
      </section>
    </div>
  );
}
