import { Copy, Download, X } from "lucide-react";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { downloadTextFile } from "../lib/exports";
import type { Artifact } from "../types";

function previewDocument(content: string): string {
  const policy = "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;padding:16px;font:14px/1.5 system-ui,sans-serif;color:#292b27}img,svg{max-width:100%;height:auto}pre{overflow:auto;white-space:pre-wrap}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:6px 9px}</style></head><body>${content}</body></html>`;
}

export default function ArtifactPanel({
  artifact,
  onClose,
}: {
  artifact: Artifact;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  async function copyArtifact() {
    try {
      await navigator.clipboard.writeText(artifact.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  }

  return (
    <aside className="artifact-panel" aria-label="Artifact preview">
      <header className="artifact-header">
        <div>
          <p>ARTIFACT</p>
          <strong>{artifact.name}</strong>
        </div>
        <div className="artifact-actions">
          <button onClick={() => void copyArtifact()} aria-label={copied ? "Copied" : "Copy artifact"} title={copied ? "Copied" : "Copy"}>
            <Copy size={15} />
          </button>
          <button
            onClick={() => downloadTextFile(
              `${artifact.name.replace(/[^\w.-]+/g, "-")}.${artifact.language === "markdown" ? "md" : artifact.language}`,
              artifact.content,
              "text/plain;charset=utf-8",
            )}
            aria-label="Download artifact"
            title="Download"
          >
            <Download size={15} />
          </button>
          <button onClick={onClose} aria-label="Close preview"><X size={17} /></button>
        </div>
      </header>
      {artifact.language === "markdown" ? (
        <div className="artifact-markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{artifact.content}</ReactMarkdown>
        </div>
      ) : (
        <div className="artifact-frame-wrap">
          <iframe
            title={`${artifact.name} isolated preview`}
            sandbox=""
            referrerPolicy="no-referrer"
            srcDoc={previewDocument(artifact.content)}
          />
        </div>
      )}
      <footer className="artifact-safety">Isolated preview · scripts and external network access are disabled</footer>
    </aside>
  );
}
