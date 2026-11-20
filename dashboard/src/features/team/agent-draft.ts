/** Engine behind each base character; drafts and sessions are stored per engine. */
export const engines: Record<string, string> = {
  ambar: "claude",
  menta: "codex",
  lira: "agy",
  marina: "deepseek",
};

export const draftKey = (project: string, engine: string) =>
  `sb-chat-draft:${project}:${engine}`;

/**
 * Leaves a message ready in an agent's composer and returns the route to it.
 * No model starts here: the session opens only when the owner sends the message.
 */
export function prepareAgentDraft(
  project: string,
  agentId: string,
  text: string,
) {
  const engine = engines[agentId];
  try {
    const key = draftKey(project, engine);
    const current = (localStorage.getItem(key) || "").trim();
    const incoming = text.trim();
    const next = !current
      ? incoming
      : !incoming || current === incoming || current.includes(incoming)
        ? current
        : `${current}\n\n${incoming}`;
    localStorage.setItem(key, next);
    localStorage.setItem(`sb-chat-selected:${project}:${engine}`, "new");
  } catch {
    // Without storage the route still opens; the message just is not prefilled.
  }
  const query = new URLSearchParams({ project, agent: agentId, chat: "new" });
  return `/team?${query}`;
}
