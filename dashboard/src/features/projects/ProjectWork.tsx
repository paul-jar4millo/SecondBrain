import { useUI } from "../../components/ui";
import { agentName } from "../agents/characters";
import { StatusTag } from "../agents/TeamPrimitives";
import { useThreadProjection } from "../threads/thread-projection";
import {
  isAttentionThread,
  isWorkingThread,
  STATUS_LABEL,
} from "../threads/thread-store";

export function ProjectWork({
  repository,
  repositoryPath,
}: {
  repository: string | null;
  repositoryPath?: string;
}) {
  const { threads } = useThreadProjection();
  const { openThread } = useUI();
  if (!repository) return null;
  const current = threads.filter((thread) => {
    const path = thread.repo?.path;
    const matches = repositoryPath
      ? path === repositoryPath
      : path === repository || path?.split(/[\\/]/).at(-1) === repository;
    return matches && (isWorkingThread(thread) || isAttentionThread(thread));
  });
  if (!current.length) return null;
  return (
    <div className="project-work">
      <h3>Threads del repositorio</h3>
      {current.map((thread) => (
        <button
          className="history-link"
          key={thread.id}
          onClick={() => openThread({ id: thread.id })}
        >
          <span>
            {agentName(thread.agent.engine)} · {thread.title}
          </span>
          <StatusTag state={thread.status}>
            {STATUS_LABEL[thread.status]}
          </StatusTag>
        </button>
      ))}
    </div>
  );
}
