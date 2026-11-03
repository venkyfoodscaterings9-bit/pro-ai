import { Files, MessageSquare } from "lucide-react";
import GeneratedFileCard from "./GeneratedFileCard";
import type { Chat, GeneratedFile, OutputFormat } from "../types";

interface FilesPageProps {
  chats: Chat[];
  onDownload: (file: GeneratedFile, name: string) => Promise<void>;
  onConvert: (file: GeneratedFile, format: OutputFormat) => void;
  onOpenChat: (chat: Chat) => void;
}

export default function FilesPage({ chats, onDownload, onConvert, onOpenChat }: FilesPageProps) {
  const files = chats.flatMap((chat) => chat.messages.flatMap((message) =>
    (message.generatedFiles ?? []).map((file) => ({ chat, file })),
  )).sort((a, b) => b.file.createdAt - a.file.createdAt);

  return (
    <div className="files-page">
      <header className="files-page-heading">
        <div><p className="eyebrow">Your workspace</p><h1>Generated files</h1><p>Files created in your conversations, saved in this browser.</p></div>
        <span className="files-page-count">{files.length} {files.length === 1 ? "file" : "files"}</span>
      </header>
      {files.length ? (
        <div className="files-page-list">
          {files.map(({ chat, file }) => (
            <section className="files-page-item" key={`${chat.id}-${file.id}`}>
              <button className="files-page-chat" onClick={() => onOpenChat(chat)}><MessageSquare size={13} />{chat.title}</button>
              <GeneratedFileCard file={file} onDownload={onDownload} onConvert={onConvert} />
            </section>
          ))}
        </div>
      ) : (
        <div className="files-page-empty"><Files size={24} /><h2>No generated files yet</h2><p>Ask Morrow for a spreadsheet, document, presentation, or chart to see it here.</p></div>
      )}
    </div>
  );
}
