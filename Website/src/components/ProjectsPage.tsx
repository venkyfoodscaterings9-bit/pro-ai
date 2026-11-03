import { ArrowLeft, ArrowUpRight, FolderKanban, MessageSquare, Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { Chat, Project } from "../types";

interface ProjectsPageProps {
  projects: Project[];
  chats: Chat[];
  onBack: () => void;
  onSave: (project: Project) => Promise<void>;
  onDelete: (project: Project) => Promise<void>;
  onOpenChat: (chat: Chat) => void;
  onNewChat: (projectId: string) => void;
}

function createId(): string {
  return globalThis.crypto.randomUUID();
}

export default function ProjectsPage({
  projects,
  chats,
  onBack,
  onSave,
  onDelete,
  onOpenChat,
  onNewChat,
}: ProjectsPageProps) {
  const [selectedId, setSelectedId] = useState(projects[0]?.id ?? "");
  const selectedProject = projects.find((project) => project.id === selectedId) ?? null;
  const [name, setName] = useState(selectedProject?.name ?? "");
  const [systemPrompt, setSystemPrompt] = useState(selectedProject?.systemPrompt ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!selectedId && projects.length) setSelectedId(projects[0].id);
    if (selectedId && !projects.some((project) => project.id === selectedId)) {
      setSelectedId(projects[0]?.id ?? "");
    }
  }, [projects, selectedId]);

  useEffect(() => {
    setName(selectedProject?.name ?? "");
    setSystemPrompt(selectedProject?.systemPrompt ?? "");
  }, [selectedId, selectedProject?.name, selectedProject?.systemPrompt]);

  const projectChats = selectedProject
    ? chats.filter((chat) => chat.projectId === selectedProject.id).sort((a, b) => b.updatedAt - a.updatedAt)
    : [];

  async function createProject() {
    const now = Date.now();
    const project: Project = {
      id: createId(),
      name: "New project",
      systemPrompt: "",
      createdAt: now,
      updatedAt: now,
    };
    try {
      await onSave(project);
      setSelectedId(project.id);
      setName(project.name);
      setSystemPrompt("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the project.");
    }
  }

  async function saveProject() {
    if (!selectedProject || !name.trim()) {
      setError("Enter a project name before saving.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onSave({ ...selectedProject, name: name.trim(), systemPrompt, updatedAt: Date.now() });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the project.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteSelectedProject() {
    if (!selectedProject) return;
    if (!window.confirm(`Delete “${selectedProject.name}”? Its chats will move to Recent, not be deleted.`)) return;
    setBusy(true);
    setError("");
    try {
      await onDelete(selectedProject);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete the project.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="projects-page">
      <header className="projects-header">
        <button className="icon-button" onClick={onBack} aria-label="Back to chat"><ArrowLeft size={18} /></button>
        <div><p className="eyebrow">Your workspace</p><h1>Projects</h1></div>
        <button className="done-button project-create-button" onClick={() => void createProject()}><Plus size={15} /> New project</button>
      </header>
      {error && <div className="settings-feedback settings-feedback-error" role="alert">{error}</div>}
      {projects.length === 0 ? (
        <div className="projects-empty">
          <div className="projects-empty-icon"><FolderKanban size={20} /></div>
          <h2>A space for the things you’re working on</h2>
          <p>Keep related conversations together and give each project its own instructions.</p>
          <button className="done-button" onClick={() => void createProject()}><Plus size={15} /> Create a project</button>
        </div>
      ) : (
        <div className="projects-layout">
          <nav className="project-list" aria-label="Projects">
            {projects.map((project) => (
              <button
                key={project.id}
                className={selectedId === project.id ? "project-list-item project-list-item-active" : "project-list-item"}
                onClick={() => setSelectedId(project.id)}
              >
                <FolderKanban size={16} />
                <span>{project.name}</span>
                <small>{chats.filter((chat) => chat.projectId === project.id).length}</small>
              </button>
            ))}
          </nav>
          {selectedProject && (
            <div className="project-detail">
              <div className="project-detail-heading">
                <div><p className="eyebrow">PROJECT DETAILS</p><h2>{selectedProject.name}</h2></div>
                <button className="done-button" onClick={() => onNewChat(selectedProject.id)}><Plus size={15} /> New chat</button>
              </div>
              <label className="field-label" htmlFor="project-name">Project name</label>
              <input id="project-name" className="text-field" maxLength={60} value={name} onChange={(event) => setName(event.target.value)} />
              <label className="field-label project-prompt-label" htmlFor="project-system-prompt">Project instructions</label>
              <textarea
                id="project-system-prompt"
                className="text-field text-area-field project-prompt"
                rows={5}
                maxLength={8000}
                value={systemPrompt}
                onChange={(event) => setSystemPrompt(event.target.value)}
                placeholder="Give this project context, goals, or a preferred response style."
              />
              <p className="field-hint">Added to every message in this project. Together with general custom instructions, it is sent to your selected provider.</p>
              <div className="project-actions">
                <button className="wipe-button" onClick={() => void deleteSelectedProject()} disabled={busy}><Trash2 size={14} /> Delete project</button>
                <button className="done-button" onClick={() => void saveProject()} disabled={busy}><Save size={14} /> Save project</button>
              </div>
              <div className="project-chats">
                <div className="project-chats-heading"><h3>Project chats</h3><span>{projectChats.length}</span></div>
                {projectChats.length ? projectChats.map((chat) => (
                  <button className="project-chat-row" key={chat.id} onClick={() => onOpenChat(chat)}>
                    <MessageSquare size={15} /><span>{chat.title}</span><ArrowUpRight size={14} />
                  </button>
                )) : <p className="project-no-chats">Chats you create from this project will show up here.</p>}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
