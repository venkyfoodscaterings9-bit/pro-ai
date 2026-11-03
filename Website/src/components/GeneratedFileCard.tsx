import { useEffect, useState } from "react";
import { Check, Copy, Download, FileCode2, FileImage, FileSpreadsheet, FileText, Eye, X } from "lucide-react";
import MarkdownContent from "./MarkdownContent";
import { buildFileBlob, chartDataUri, fileByteSize, previewHtml } from "../lib/fileGeneration";
import { fileLabel, getSheetsFromFile, OUTPUT_FORMATS } from "../lib/smartOutput";
import type { GeneratedFile, OutputFormat } from "../types";

interface GeneratedFileCardProps {
  file: GeneratedFile;
  onDownload: (file: GeneratedFile, name: string) => Promise<void>;
  onConvert: (file: GeneratedFile, format: OutputFormat) => void;
}

function sizeLabel(size: number): string {
  return size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function FileIcon({ format }: { format: OutputFormat }) {
  if (format === "xlsx" || format === "csv") return <FileSpreadsheet size={19} />;
  if (format === "html") return <FileCode2 size={19} />;
  if (format === "chart") return <FileImage size={19} />;
  return <FileText size={19} />;
}

export default function GeneratedFileCard({ file, onDownload, onConvert }: GeneratedFileCardProps) {
  const [name, setName] = useState(file.name);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [copyDone, setCopyDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fileSize, setFileSize] = useState(() => fileByteSize(file));
  const sheets = file.format === "xlsx" || file.format === "csv" || file.format === "chart"
    ? getSheetsFromFile(file)
    : [];
  useEffect(() => {
    let active = true;
    void buildFileBlob(file).then((blob) => {
      if (active) setFileSize(blob.size);
    }).catch(() => {
      if (active) setFileSize(fileByteSize(file));
    });
    return () => { active = false; };
  }, [file.content, file.format]);

  async function copyFile() {
    try {
      await navigator.clipboard.writeText(file.content);
      setCopyDone(true);
      window.setTimeout(() => setCopyDone(false), 1300);
    } catch {
      setPreviewOpen(true);
    }
  }

  async function download() {
    setBusy(true);
    try {
      const cleanName = name.trim() || file.name;
      const extension = `.${file.format === "markdown" ? "md" : file.format === "chart" ? "png" : file.format}`;
      await onDownload(file, cleanName.toLowerCase().endsWith(extension) ? cleanName : `${cleanName}${extension}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="generated-file-card">
        <div className="generated-file-icon"><FileIcon format={file.format} /></div>
        <div className="generated-file-details">
          <div className="generated-file-meta"><span className="generated-file-badge">{fileLabel(file.format)}</span><span>{sizeLabel(fileSize)}</span></div>
          <label className="sr-only" htmlFor={`generated-name-${file.id}`}>File name</label>
          <input id={`generated-name-${file.id}`} className="generated-file-name" value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="generated-file-actions">
          <button onClick={() => void download()} disabled={busy} title="Download"><Download size={14} /><span>{busy ? "Preparing…" : "Download"}</span></button>
          <button onClick={() => setPreviewOpen(true)} title="Preview"><Eye size={14} /><span>Preview</span></button>
          <button onClick={() => void copyFile()} title="Copy file content">{copyDone ? <Check size={14} /> : <Copy size={14} />}<span>{copyDone ? "Copied" : "Copy"}</span></button>
          <label className="generated-convert-label">
            <span>Regenerate as another format</span>
            <select aria-label="Regenerate as another format" value="" onChange={(event) => {
              if (event.target.value) onConvert(file, event.target.value as OutputFormat);
            }}>
              <option value="">Convert to…</option>
              {OUTPUT_FORMATS.filter((item) => item.id !== file.format).map((format) => (
                <option key={format.id} value={format.id}>{format.label}</option>
              ))}
            </select>
          </label>
        </div>
      </section>
      {previewOpen && (
        <div className="output-preview-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setPreviewOpen(false);
        }}>
          <section className="output-preview-modal" role="dialog" aria-modal="true" aria-label={`${file.name} preview`}>
            <header><div><span className="generated-file-badge">{fileLabel(file.format)}</span><strong>{name}</strong></div><button className="icon-button" onClick={() => setPreviewOpen(false)} aria-label="Close preview"><X size={18} /></button></header>
            <div className="output-preview-content">
              {(file.format === "xlsx" || file.format === "csv") && (
                <div className="output-table-scroll">
                  {sheets.map((sheet) => (
                    <table className="output-preview-table" key={sheet.name}>
                      <caption>{sheet.name}</caption>
                      <thead><tr>{sheet.columns.map((column, index) => <th key={`${column}-${index}`}>{column}</th>)}</tr></thead>
                      <tbody>{sheet.rows.slice(0, 50).map((row, rowIndex) => (
                        <tr key={rowIndex}>{sheet.columns.map((_, columnIndex) => <td key={columnIndex}>{String(row[columnIndex] ?? "")}</td>)}</tr>
                      ))}</tbody>
                    </table>
                  ))}
                  {sheets.some((sheet) => sheet.rows.length > 50) && <p className="field-hint">Preview limited to the first 50 rows per sheet.</p>}
                </div>
              )}
              {file.format === "html" && <iframe className="html-output-preview" title="HTML file preview" sandbox="" srcDoc={previewHtml(file)} />}
              {file.format === "chart" && <img className="chart-output-preview" src={file.content.startsWith("data:image/png,") ? file.content : chartDataUri(file)} alt="Generated chart preview" />}
              {(file.format === "pdf" || file.format === "docx" || file.format === "markdown") && <MarkdownContent content={file.content} />}
              {file.format === "pptx" && <div className="slide-output-preview">{JSON.parse(file.content).slides.map((slide: { title: string; bullets: string[]; notes?: string }, index: number) => (
                <article key={index}><h3>{slide.title || `Slide ${index + 1}`}</h3><ul>{slide.bullets.map((bullet, bulletIndex) => <li key={bulletIndex}>{bullet}</li>)}</ul>{slide.notes && <p><strong>Notes:</strong> {slide.notes}</p>}</article>
              ))}</div>}
              {file.format === "json" && <pre>{file.content}</pre>}
              {file.format === "txt" && <pre>{file.content}</pre>}
            </div>
          </section>
        </div>
      )}
    </>
  );
}
