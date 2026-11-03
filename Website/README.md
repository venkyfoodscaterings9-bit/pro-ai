# Morrow

Morrow is a local-first, multi-provider AI chat interface. Conversations, projects, settings, and encrypted provider-key records are stored in the browser; requests go directly from the browser to the selected AI provider.

## Run locally

Requirements: Node.js 20.19+ or 22.12+ and npm.

```bash
npm install
npm run dev
```

Open the local URL printed by Vite (normally `http://localhost:5173`). To create and preview a production build:

```bash
npm run build
npm run preview
```

## Features

- Multi-provider chats with streaming replies, stop, regenerate, edit, copy, and Markdown/GFM rendering.
- Local chat history, search, rename, pin, delete, projects, and conversation backups.
- Image, plain-text, and Markdown attachments. Other file formats are not parsed.
- Light and dark themes.
- Export conversations as Markdown, save a rendered AI response as a standalone PDF, or print the full conversation. In the print dialog, choose **Save as PDF**.
- Smart Output Format detects requested file types, adds a per-request instruction, and creates downloadable Excel, CSV, HTML, PDF, Word, PowerPoint, Markdown, JSON, TXT, and PNG chart files in the browser. Generated files are saved with their conversation and listed in **Files**.
- Choose an output format next to Send to override detection, or set a default format and confirmation preference in Settings. HTML previews run in a sandboxed iframe with scripts and external resources removed.
- API keys encrypted in IndexedDB using the vault passphrase. The unlocked vault key stays in page memory until you lock it or close/reload the app; unlocking does not persist across a reload.
- Add custom OpenAI-, Anthropic-, or Gemini-compatible providers in **Settings → Models & Providers**, register or fetch model IDs, then select enabled models in chat. Custom API keys use the same encrypted browser vault.
- Export and import custom provider/model configuration as JSON. API keys are excluded by default; choosing to include them writes plaintext keys into the downloaded file.

## Connect a provider

Open **Settings → API keys**, create a vault passphrase, and add an API key for a built-in provider. To connect a custom endpoint, unlock the vault and use **Settings → Models & Providers** to add its name, base URL, API format, key, and model IDs. Select an enabled provider/model from the chat header. Model availability can vary by key, region, and provider lifecycle; check the provider's current model catalog.

The app sends requests directly from the browser to the selected provider; no proxy or app server is included. This requires a browser/network path that permits direct provider API requests. If a provider blocks browser requests with CORS, a backend proxy will be needed; this project does not currently include one. The app does not silently switch custom providers.

Smart Output Format uses the selected provider's existing chat request. Provider CORS restrictions can still block that request; generated files themselves are built locally in the browser and do not require a backend.

API key records remain encrypted at rest in this browser. The key used for a request is decrypted in page memory and sent directly to the provider. Browser storage does not protect secrets from malicious scripts, browser extensions, or a compromised device. Use keys with appropriate restrictions and review the provider's API key guidance.

## Data and privacy

Chats and attachments are stored in browser IndexedDB. Export a backup from Settings to keep a copy; API key records in that backup remain encrypted and require the original vault passphrase. Clearing browser site data removes local chats, settings, and keys.

## Stack

React, Vite, TypeScript, Tailwind CSS, IndexedDB, React Markdown, remark-gfm, and rehype-highlight.
