import type { ChatAttachment } from "../types";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_CHARACTERS = 500_000;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".jsonl", ".xml", ".html", ".htm",
  ".css", ".js", ".jsx", ".ts", ".tsx", ".py", ".rb", ".go", ".rs", ".java", ".c", ".h",
  ".cpp", ".cs", ".php", ".sql", ".sh", ".bat", ".ps1", ".yaml", ".yml", ".toml", ".ini",
  ".log", ".diff", ".patch",
]);

function makeId(): string {
  return globalThis.crypto.randomUUID();
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function extension(fileName: string): string {
  const index = fileName.lastIndexOf(".");
  return index < 0 ? "" : fileName.slice(index).toLowerCase();
}

async function readPdf(file: File): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const document = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = Math.min(document.numPages, 30);
  const totalPages = document.numPages;
  const extracted: string[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .flatMap((item) => ("str" in item && typeof item.str === "string" ? [item.str] : []))
        .join(" ");
      extracted.push(text);
    }
  } finally {
    await document.destroy();
  }
  const prefix = totalPages > pages
    ? `[Only the first ${pages} of ${totalPages} pages were extracted.]\n`
    : "";
  return `${prefix}${extracted.join("\n\n")}`.slice(0, MAX_TEXT_CHARACTERS);
}

async function readOneFile(file: File): Promise<ChatAttachment> {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`${file.name} is larger than the 8 MB per-file limit.`);
  }
  if (IMAGE_TYPES.has(file.type)) {
    if (file.size > MAX_IMAGE_BYTES) {
      throw new Error(`${file.name} is larger than the 5 MB image limit.`);
    }
    return {
      id: makeId(),
      name: file.name,
      mimeType: file.type,
      kind: "image",
      data: encodeBase64(new Uint8Array(await file.arrayBuffer())),
    };
  }
  if (file.type === "application/pdf" || extension(file.name) === ".pdf") {
    const text = await readPdf(file);
    return {
      id: makeId(),
      name: file.name,
      mimeType: "application/pdf",
      kind: "text",
      data: text,
    };
  }
  if (file.type.startsWith("text/") || TEXT_EXTENSIONS.has(extension(file.name))) {
    const text = await file.text();
    return {
      id: makeId(),
      name: file.name,
      mimeType: file.type || "text/plain",
      kind: "text",
      data: text.slice(0, MAX_TEXT_CHARACTERS),
    };
  }
  throw new Error(`${file.name} is not a supported image, PDF, or text-based file.`);
}

export async function readAttachments(files: File[]): Promise<ChatAttachment[]> {
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  if (totalBytes > 20 * 1024 * 1024) {
    throw new Error("The combined attachment size exceeds 20 MB.");
  }
  const attachments: ChatAttachment[] = [];
  for (const file of files) attachments.push(await readOneFile(file));
  return attachments;
}

export function attachmentPreviewUrl(attachment: ChatAttachment): string | null {
  if (attachment.kind !== "image") return null;
  return `data:${attachment.mimeType};base64,${attachment.data}`;
}
