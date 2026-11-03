import type { AppSettings, Chat, EncryptedApiKey, Project, VaultMetadata } from "../types";

function formatMessageTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

export function chatAsMarkdown(chat: Chat): string {
  const messages = chat.messages.map((message) => {
    const role = message.role === "user" ? "You" : "Morrow";
    const providerInfo = message.provider && message.model
      ? ` · ${message.provider} / ${message.model}`
      : "";
    const attachments = message.attachments?.length
      ? `\n\n_Attachments: ${message.attachments.map((file) => file.name).join(", ")}_`
      : "";
    const interrupted = message.interrupted ? "\n\n_(Response was stopped.)_" : "";
    return `## ${role}${providerInfo}\n\n${message.content}${attachments}${interrupted}\n\n---\n\n`;
  });
  return `# ${chat.title}\n\n_Exported ${formatMessageTime(Date.now())}_\n\n${messages.join("")}`;
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

export function downloadTextFile(name: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function buildBackupJson(data: {
  chats: Chat[];
  projects: Project[];
  settings: AppSettings;
  encryptedApiKeys: EncryptedApiKey[];
  vaultMetadata: VaultMetadata | null;
}): string {
  return JSON.stringify(
    {
      format: "morrow-local-backup-v1",
      exportedAt: new Date().toISOString(),
      ...data,
      note: "API key records remain encrypted and require the original vault passphrase. No plaintext API keys are included.",
    },
    null,
    2,
  );
}
