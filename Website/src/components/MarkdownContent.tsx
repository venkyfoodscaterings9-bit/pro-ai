import { Children, isValidElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import type { Artifact } from "../types";

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  return Children.toArray(node).map(nodeText).join("");
}

export default function MarkdownContent({
  content,
  onArtifact,
}: {
  content: string;
  onArtifact?: (artifact: Artifact) => void;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={{
        pre({ children }) {
          const code = Children.toArray(children).find((child) =>
            isValidElement<{ className?: string; children?: ReactNode }>(child),
          );
          if (!code || !isValidElement<{ className?: string; children?: ReactNode }>(code)) {
            return <pre>{children}</pre>;
          }
          const className = code.props.className ?? "";
          const match = /language-(html|svg|markdown|md)\b/i.exec(className);
          const source = nodeText(code.props.children).replace(/\n$/, "");
          const language = match?.[1]?.toLowerCase();
          const artifactLanguage = language === "md" ? "markdown" : language;
          const canPreview = Boolean(onArtifact && artifactLanguage && source.trim());
          const openArtifact = () => {
            if (!canPreview) return;
            onArtifact?.({
              id: globalThis.crypto.randomUUID(),
              name: `Untitled ${artifactLanguage}`,
              language: artifactLanguage as "html" | "svg" | "markdown",
              content: source,
            });
          };
          return (
            <div className="code-block">
              <div className="code-block-toolbar">
                <span>{language || "code"}</span>
                {canPreview && (
                  <button type="button" onClick={openArtifact}>
                    Open preview
                  </button>
                )}
              </div>
              <pre>{children}</pre>
            </div>
          );
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
