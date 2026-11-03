import type { EncryptedApiKey, ProviderId, VaultMetadata } from "../types";

const VAULT_CHECK = "morrow-key-vault-check:v1";
const ITERATIONS = 310_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function secureCrypto(): Crypto {
  if (!globalThis.crypto?.subtle || !globalThis.crypto.getRandomValues) {
    throw new Error("Secure browser cryptography is unavailable. Use a current browser over HTTPS or localhost.");
  }
  return globalThis.crypto;
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const crypto = secureCrypto();
  const material = await crypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptValue(key: CryptoKey, value: string): Promise<{ iv: string; ciphertext: string }> {
  const iv = secureCrypto().getRandomValues(new Uint8Array(12));
  const ciphertext = await secureCrypto().subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(value),
  );
  return { iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) };
}

async function decryptValue(key: CryptoKey, iv: string, ciphertext: string): Promise<string> {
  try {
    const plaintext = await secureCrypto().subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(iv) },
      key,
      fromBase64(ciphertext),
    );
    return decoder.decode(plaintext);
  } catch {
    throw new Error("The vault passphrase is incorrect or the encrypted data has been changed.");
  }
}

export async function createVault(passphrase: string): Promise<{ metadata: VaultMetadata; key: CryptoKey }> {
  if (passphrase.trim().length < 10) {
    throw new Error("Use a vault passphrase with at least 10 characters.");
  }
  const salt = secureCrypto().getRandomValues(new Uint8Array(16));
  const key = await deriveKey(passphrase, salt, ITERATIONS);
  const verifier = await encryptValue(key, VAULT_CHECK);
  return {
    key,
    metadata: {
      salt: toBase64(salt),
      iterations: ITERATIONS,
      verifierIv: verifier.iv,
      verifierCiphertext: verifier.ciphertext,
      createdAt: Date.now(),
    },
  };
}

export async function unlockVault(passphrase: string, metadata: VaultMetadata): Promise<CryptoKey> {
  const key = await deriveKey(passphrase, fromBase64(metadata.salt), metadata.iterations);
  const verifier = await decryptValue(key, metadata.verifierIv, metadata.verifierCiphertext);
  if (verifier !== VAULT_CHECK) {
    throw new Error("The vault passphrase is incorrect.");
  }
  return key;
}

export async function encryptApiKey(
  key: CryptoKey,
  values: {
    id: string;
    provider: ProviderId;
    label: string;
    apiKey: string;
    createdAt?: number;
    lastUsedAt?: number;
  },
): Promise<EncryptedApiKey> {
  const apiKey = values.apiKey.trim();
  if (!apiKey) throw new Error("Enter an API key before saving.");
  const encrypted = await encryptValue(key, apiKey);
  const now = Date.now();
  return {
    id: values.id,
    provider: values.provider,
    label: values.label.trim() || `${values.provider} key`,
    iv: encrypted.iv,
    ciphertext: encrypted.ciphertext,
    createdAt: values.createdAt ?? now,
    updatedAt: now,
    ...(values.lastUsedAt ? { lastUsedAt: values.lastUsedAt } : {}),
  };
}

export function decryptApiKey(key: CryptoKey, record: EncryptedApiKey): Promise<string> {
  return decryptValue(key, record.iv, record.ciphertext);
}
