import type { GeneratedFile, OutputFormat, OutputFormatPreference } from "../types";

export const OUTPUT_FORMATS: { id: OutputFormat; label: string }[] = [
  { id: "xlsx", label: "Excel" },
  { id: "csv", label: "CSV" },
  { id: "html", label: "HTML" },
  { id: "pdf", label: "PDF" },
  { id: "docx", label: "Word" },
  { id: "pptx", label: "PPT" },
  { id: "markdown", label: "Markdown" },
  { id: "json", label: "JSON" },
  { id: "txt", label: "TXT" },
  { id: "chart", label: "Chart" },
];

export interface OutputSheet {
  name: string;
  columns: string[];
  rows: unknown[][];
}

export interface OutputSlide {
  title: string;
  bullets: string[];
  notes?: string;
}

export interface ParsedOutput {
  reply: string;
  bodies: Map<OutputFormat, string>;
  names: Map<OutputFormat, string>;
}

export class OutputParseError extends Error {
  readonly rawText: string;

  constructor(message: string, rawText: string) {
    super(message);
    this.name = "OutputParseError";
    this.rawText = rawText;
  }
}

export function detectOutputFormats(text: string): OutputFormat[] {
  const rules: [OutputFormat, RegExp][] = [
    ["xlsx", /\bexcel\b|\bxlsx\b|\bspreadsheet\b|\bsheet\b|in\s+table\s+and\s+download|excel\s+me\s+(?:do|de|bana(?:o|do)?)/i],
    ["csv", /\bcsv\b/i],
    ["html", /\bhtml\b|web\s*page|webpage|html\s+file/i],
    ["pdf", /\bpdf\b/i],
    ["docx", /\bword\b|\bdocx?\b|\bdoc\s+file\b/i],
    ["pptx", /\bpptx?\b|\bslides?\b|\bpresentation\b/i],
    ["markdown", /\bmarkdown\b|\.md\b/i],
    ["json", /\bjson\b/i],
    ["txt", /\btxt\b|text\s+file/i],
    ["chart", /\bchart\b|\bgraph\b/i],
  ];
  return rules.filter(([, pattern]) => pattern.test(text)).map(([format]) => format);
}

export function resolveOutputFormats(
  text: string,
  override: OutputFormatPreference,
  defaultFormat: OutputFormatPreference,
): OutputFormat[] {
  if (override === "chat") return [];
  if (override !== "auto") return [override];
  const detected = detectOutputFormats(text);
  if (detected.length) return detected;
  return defaultFormat === "auto" || defaultFormat === "chat" ? [] : [defaultFormat];
}

function formatInstructions(format: OutputFormat): string {
  switch (format) {
    case "xlsx":
    case "csv":
      return `${format}: return JSON {"sheets":[{"name":"Sheet1","columns":["A","B"],"rows":[[...],[...]]}]}. Use real numbers (not text) for amounts, ISO dates, one header row, and no merged cells.`;
    case "html":
      return "html: return one complete self-contained HTML file with inline CSS.";
    case "pdf":
    case "docx":
      return `${format}: return Markdown with headings and tables.`;
    case "pptx":
      return 'pptx: return JSON {"slides":[{"title":"","bullets":[""],"notes":""}]}.';
    case "chart":
      return 'chart: return JSON {"sheets":[{"name":"Chart","columns":["Label","Value"],"rows":[["A",1]]}]} suitable for a chart.';
    case "markdown":
    case "json":
    case "txt":
      return `${format}: return the raw content only.`;
  }
}

export function buildOutputInstruction(formats: OutputFormat[]): string {
  if (!formats.length) return "";
  const requested = [...new Set(formats)];
  return [
    "For this request only, provide a short user-facing explanation in <chat_reply>...</chat_reply>, then one file block per requested format using <file name=\"suggested_file_name\" format=\"format-id\">content</file>.",
    "Do not include the file contents outside the file blocks. Use these content rules:",
    ...requested.map(formatInstructions),
    `Requested formats: ${requested.join(", ")}.`,
  ].join("\n");
}

function extractTable(text: string): OutputSheet | null {
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length - 1; index += 1) {
    const header = lines[index].trim();
    const separator = lines[index + 1].trim();
    if (!header.startsWith("|") || !/^\|?\s*:?-{3,}/.test(separator)) continue;
    const cells = (line: string) => line.replace(/^\s*\|?|\|?\s*$/g, "").split("|").map((cell) => cell.trim());
    const columns = cells(header);
    const rows: unknown[][] = [];
    for (let rowIndex = index + 2; rowIndex < lines.length && lines[rowIndex].includes("|"); rowIndex += 1) {
      rows.push(cells(lines[rowIndex]).map((value) => {
        const numeric = value.replace(/,/g, "");
        return numeric && /^-?(?:\d+\.?\d*|\.\d+)$/.test(numeric) ? Number(numeric) : value;
      }));
    }
    if (columns.length) return { name: "Sheet1", columns, rows };
  }
  return null;
}

function removeCodeFence(text: string): string {
  const match = text.trim().match(/^```(?:json|javascript|js|markdown|md|html|csv|text)?\s*\n([\s\S]*?)\n```$/i);
  return match ? match[1].trim() : text.trim();
}

function parseJson(text: string, rawText: string): unknown {
  try {
    return JSON.parse(removeCodeFence(text));
  } catch {
    throw new OutputParseError("The model returned invalid JSON for a structured file.", rawText);
  }
}

export function parseSheets(text: string, rawText = text): OutputSheet[] {
  const table = extractTable(text);
  let value: unknown;
  try {
    value = JSON.parse(removeCodeFence(text));
  } catch {
    if (table) return [table];
    throw new OutputParseError("The model did not return valid spreadsheet JSON or a Markdown table.", rawText);
  }
  const sheets = value && typeof value === "object" && "sheets" in value
    ? (value as { sheets?: unknown }).sheets
    : null;
  if (!Array.isArray(sheets) || !sheets.length) {
    if (table) return [table];
    throw new OutputParseError("The spreadsheet JSON must contain a non-empty sheets array.", rawText);
  }
  return sheets.map((sheet, index) => {
    if (!sheet || typeof sheet !== "object") {
      throw new OutputParseError("A spreadsheet sheet has an invalid shape.", rawText);
    }
    const item = sheet as Record<string, unknown>;
    if (!Array.isArray(item.columns) || !Array.isArray(item.rows)) {
      throw new OutputParseError("Each sheet needs columns and rows arrays.", rawText);
    }
    return {
      name: typeof item.name === "string" && item.name ? item.name : `Sheet${index + 1}`,
      columns: item.columns.map(String),
      rows: item.rows.map((row) => Array.isArray(row) ? row : [row]),
    };
  });
}

export function parseSlides(text: string, rawText = text): OutputSlide[] {
  const table = extractTable(text);
  let value: unknown;
  try {
    value = parseJson(text, rawText);
  } catch (cause) {
    if (table) return [{ title: "Summary", bullets: table.rows.map((row) => row.join(" — ")) }];
    throw cause;
  }
  const slides = value && typeof value === "object" && "slides" in value
    ? (value as { slides?: unknown }).slides
    : null;
  if (!Array.isArray(slides) || !slides.length) {
    throw new OutputParseError("The presentation JSON must contain a non-empty slides array.", rawText);
  }
  return slides.map((slide) => {
    if (!slide || typeof slide !== "object") throw new OutputParseError("A slide has an invalid shape.", rawText);
    const item = slide as Record<string, unknown>;
    return {
      title: typeof item.title === "string" ? item.title : "",
      bullets: Array.isArray(item.bullets) ? item.bullets.map(String) : [],
      notes: typeof item.notes === "string" ? item.notes : "",
    };
  });
}

export function parseModelOutput(response: string, formats: OutputFormat[]): ParsedOutput {
  const chatReply = response.match(/<chat_reply>([\s\S]*?)<\/chat_reply>/i)?.[1]?.trim();
  const filePattern = /<file\b([^>]*)>([\s\S]*?)<\/file>/gi;
  const blocks = new Map<OutputFormat, string>();
  const names = new Map<OutputFormat, string>();
  for (const match of response.matchAll(filePattern)) {
    const format = match[1].match(/\bformat\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
    if (format && OUTPUT_FORMATS.some((item) => item.id === format)) {
      blocks.set(format as OutputFormat, match[2].trim());
      const name = match[1].match(/\bname\s*=\s*["']([^"']+)["']/i)?.[1]?.trim();
      if (name) names.set(format as OutputFormat, name);
    }
  }
  const fallback = response
    .replace(/<chat_reply>[\s\S]*?<\/chat_reply>/gi, "")
    .replace(filePattern, "")
    .trim();
  for (const format of formats) {
    if (!blocks.has(format)) {
      const codeBlock = fallback.match(/```(?:[\w+-]+)?\s*\n([\s\S]*?)\n```/i)?.[1]?.trim();
      const table = extractTable(fallback);
      let body = codeBlock ?? fallback;
      if (codeBlock && table && (format === "xlsx" || format === "csv" || format === "chart" || format === "pptx")) {
        try {
          validateStructuredOutput(format, codeBlock, response);
        } catch {
          body = fallback;
        }
      }
      blocks.set(format, body);
    }
  }
  return {
    reply: chatReply || fallback || response.replace(/<file\b[^>]*>[\s\S]*?<\/file>/gi, "").trim(),
    bodies: blocks,
    names,
  };
}

export function visibleAssistantText(response: string): string {
  const chatReply = response.match(/<chat_reply>([\s\S]*?)(?:<\/chat_reply>|$)/i)?.[1];
  if (chatReply !== undefined) return chatReply.trim();
  return response
    .replace(/<file\b[\s\S]*$/i, "")
    .replace(/<\/?chat_reply>/gi, "")
    .replace(/<\/?file\b[^>]*>/gi, "")
    .trim();
}

export function validateStructuredOutput(format: OutputFormat, body: string, rawText: string): void {
  if (format === "xlsx" || format === "csv" || format === "chart") parseSheets(body, rawText);
  if (format === "pptx") parseSlides(body, rawText);
  if (format === "json") parseJson(body, rawText);
}

export function makeGeneratedFile(format: OutputFormat, body: string, index = 0, suggestedName?: string): GeneratedFile {
  const extensions: Record<OutputFormat, string> = {
    xlsx: "xlsx", csv: "csv", html: "html", pdf: "pdf", docx: "docx",
    pptx: "pptx", markdown: "md", json: "json", txt: "txt", chart: "png",
  };
  const cleanSuggestedName = suggestedName
    ?.replace(/[\\/]/g, "-")
    .replace(/[^\w .()-]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/\.[^.]+$/, "");
  const name = `${cleanSuggestedName || `morrow-output${index ? `-${index + 1}` : ""}`}.${extensions[format]}`;
  const content = format === "xlsx" || format === "csv" || format === "chart"
    ? JSON.stringify({ sheets: parseSheets(body) })
    : format === "pptx"
      ? JSON.stringify({ slides: parseSlides(body) })
      : format === "html" && !/<html[\s>]/i.test(body)
        ? `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeText(suggestedName ?? "Generated file")}</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:900px;margin:40px auto;padding:0 20px;color:#242331}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px;text-align:left}th{background:#f2f1f8}</style></head><body>${markdownTableHtml(body)}</body></html>`
      : removeCodeFence(body);
  return { id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${index}`, name, format, content, createdAt: Date.now() };
}

export function convertGeneratedFile(file: GeneratedFile, format: OutputFormat): GeneratedFile {
  const parsedData = (() => {
    try { return JSON.parse(file.content) as unknown; } catch { return null; }
  })();
  let sourceSheets = file.format === "xlsx" || file.format === "csv" || file.format === "chart"
    ? parseSheets(file.content)
    : (() => {
        try { return parseSheets(file.content); } catch { return extractTable(file.content) ? [extractTable(file.content)!] : []; }
      })();
  if (!sourceSheets.length && parsedData && typeof parsedData === "object" && !("slides" in parsedData)) {
    const entries = Array.isArray(parsedData) ? parsedData : Object.entries(parsedData).find(([, value]) => Array.isArray(value))?.[1];
    if (Array.isArray(entries) && entries.length && entries.every((item) => item && typeof item === "object" && !Array.isArray(item))) {
      const columns = [...new Set(entries.flatMap((item) => Object.keys(item as Record<string, unknown>)))];
      sourceSheets = [{
        name: "Sheet1",
        columns,
        rows: entries.map((item) => columns.map((column) => {
          const value = (item as Record<string, unknown>)[column];
          return value && typeof value === "object" ? JSON.stringify(value) : value;
        })),
      }];
    } else if (!Array.isArray(parsedData)) {
      sourceSheets = [{
        name: "Sheet1",
        columns: ["Key", "Value"],
        rows: Object.entries(parsedData).map(([key, value]) => [key, value && typeof value === "object" ? JSON.stringify(value) : value]),
      }];
    }
  }
  const sourceSlides = file.format === "pptx"
    ? parseSlides(file.content)
    : parsedData && typeof parsedData === "object" && "slides" in parsedData
      ? parseSlides(file.content)
      : [];
  const tableMarkdown = sourceSheets.length
    ? sourceSheets.map((sheet) => [
        `## ${sheet.name}`,
        `| ${sheet.columns.join(" | ")} |`,
        `| ${sheet.columns.map(() => "---").join(" | ")} |`,
        ...sheet.rows.map((row) => `| ${sheet.columns.map((_, index) => String(row[index] ?? "")).join(" | ")} |`),
      ].join("\n")).join("\n\n")
    : "";
  const slidesMarkdown = sourceSlides.length
    ? sourceSlides.map((slide) => `## ${slide.title}\n${slide.bullets.map((bullet) => `- ${bullet}`).join("\n")}`).join("\n\n")
    : "";
  const plainText = sourceSheets.length
    ? sourceSheets.map((sheet) => [sheet.name, sheet.columns.join("\t"), ...sheet.rows.map((row) => row.map(String).join("\t"))].join("\n")).join("\n\n")
    : slidesMarkdown || file.content.replace(/<[^>]+>/g, " ").trim();
  const structured = sourceSheets.length
    ? JSON.stringify({ sheets: sourceSheets })
    : sourceSlides.length
      ? JSON.stringify({ slides: sourceSlides })
      : "";
  let body: string;
  switch (format) {
    case "xlsx":
    case "csv":
    case "chart":
      body = structured || file.content;
      if (!structured) {
        const extracted = extractTable(file.content);
        if (extracted) body = JSON.stringify({ sheets: [extracted] });
      }
      break;
    case "pptx":
      body = sourceSlides.length ? JSON.stringify({ slides: sourceSlides }) : JSON.stringify({
        slides: sourceSheets.length
          ? [{ title: sourceSheets[0].name, bullets: sourceSheets[0].rows.map((row) => row.join(" — ")) }]
          : [{ title: file.name.replace(/\.[^.]+$/, ""), bullets: markdownParagraphs(file.content).slice(0, 10) }],
      });
      break;
    case "html":
      body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${file.name}</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:900px;margin:40px auto;padding:0 20px;color:#242331}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px;text-align:left}th{background:#f2f1f8}</style></head><body>${tableMarkdown ? markdownTableHtml(tableMarkdown) : `<pre>${escapeText(plainText)}</pre>`}</body></html>`;
      break;
    case "pdf":
    case "docx":
    case "markdown":
      body = tableMarkdown || slidesMarkdown || file.content;
      break;
    case "json":
      body = parsedData ? JSON.stringify(parsedData, null, 2) : JSON.stringify({ content: file.content }, null, 2);
      break;
    case "txt":
      body = plainText;
      break;
  }
  const base = file.name.replace(/\.[^.]+$/, "");
  return makeGeneratedFile(format, body, 0, base);
}

function escapeText(text: string): string {
  return text.replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character] ?? character);
}

function markdownTableHtml(markdown: string): string {
  const rows = markdown.split(/\r?\n/);
  const output: string[] = [];
  let inTable = false;
  for (let index = 0; index < rows.length; index += 1) {
    const line = rows[index].trim();
    if (!line.startsWith("|")) {
      if (inTable) output.push("</tbody></table>");
      inTable = false;
      if (line) output.push(`<p>${escapeText(line.replace(/^#{1,6}\s*/, ""))}</p>`);
      continue;
    }
    if (/^\|\s*:?-{3,}/.test(line)) continue;
    if (!inTable) {
      output.push("<table><thead>");
      inTable = true;
    }
    const cells = line.replace(/^\||\|$/g, "").split("|").map((cell) => escapeText(cell.trim()));
    if (output[output.length - 1] === "<table><thead>") {
      output.push(`<tr>${cells.map((cell) => `<th>${cell}</th>`).join("")}</tr></thead><tbody>`);
    } else {
      output.push(`<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`);
    }
  }
  if (inTable) output.push("</tbody></table>");
  return output.join("");
}

function markdownParagraphs(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.replace(/^#{1,6}\s*/, "").replace(/^\s*[-*+]\s+/, "").trim()).filter(Boolean);
}

export function fileLabel(format: OutputFormat): string {
  return OUTPUT_FORMATS.find((item) => item.id === format)?.label ?? format.toUpperCase();
}

export function getFileBody(file: GeneratedFile): string {
  return file.content;
}

export function getSheetsFromFile(file: GeneratedFile): OutputSheet[] {
  if (file.format === "xlsx" || file.format === "csv" || file.format === "chart") {
    return parseSheets(file.content);
  }
  const table = extractTable(file.content);
  return table ? [table] : [];
}

export function sanitizeHtmlPreview(html: string): string {
  const documentValue = new DOMParser().parseFromString(html, "text/html");
  documentValue.querySelectorAll("script,iframe,object,embed,form,base,link").forEach((element) => element.remove());
  documentValue.querySelectorAll("*").forEach((element) => {
    for (const attribute of [...element.attributes]) {
      if (
        /^on/i.test(attribute.name) ||
        (attribute.name === "src" && !attribute.value.startsWith("data:image/")) ||
        (attribute.name === "srcset") ||
        (attribute.name === "href" && !attribute.value.startsWith("#")) ||
        (attribute.name === "style" && /url\s*\(/i.test(attribute.value))
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  });
  documentValue.querySelectorAll("style").forEach((style) => {
    if (/@import|url\s*\(/i.test(style.textContent ?? "")) style.remove();
  });
  return `<!doctype html>${documentValue.documentElement.outerHTML}`;
}

export function outputPreferenceOptions(): { id: OutputFormatPreference; label: string }[] {
  return [
    { id: "auto", label: "Auto" },
    { id: "chat", label: "Chat only" },
    ...OUTPUT_FORMATS.filter((item) => item.id !== "chart"),
  ];
}
