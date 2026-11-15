/** Engine behind each base character; drafts and sessions are stored per engine. */
export const engines: Record<string, string> = {
  ambar: "claude",
  menta: "codex",
  lira: "agy",
  marina: "deepseek",
};

export const draftKey = (project: string, motor: string) =>
  `sb-chat-draft:${project}:${motor}`;

/**
 * Leaves a message ready in an agent's composer and returns the route to it.
 * No model starts here: the session opens only when the owner sends the message.
 */
export function prepareAgentDraft(
  project: string,
  agentId: string,
  text: string,
) {
  const motor = engines[agentId];
  try {
    const key = draftKey(project, motor);
    const current = (localStorage.getItem(key) || "").trim();
    const incoming = text.trim();
    const next = !current
      ? incoming
      : !incoming || current === incoming || current.includes(incoming)
        ? current
        : `${current}\n\n${incoming}`;
    localStorage.setItem(key, next);
    localStorage.setItem(`sb-chat-selected:${project}:${motor}`, "new");
  } catch {
    // Without storage the route still opens; the message just is not prefilled.
  }
  const query = new URLSearchParams({ project, agent: agentId, chat: "new" });
  return `/team?${query}`;
}
