import { useEffect, useState } from "react";
import { lineKind } from "../team/harness-changes";
import { threadsApi } from "./thread-api";
import type { FileDiff } from "./thread-types";

const CHANGE = {
  add: "Nuevo",
  modify: "Modificado",
  delete: "Eliminado",
  rename: "Renombrado",
} as const;

export function DiffFiles({ files }: { files: FileDiff[] }) {
  if (!files.length) return <p className="muted">Sin cambios.</p>;
  return (
    <div className="thread-diff">
      {files.map((file) => (
        <details key={file.path} open={files.length <= 3}>
          <summary>
            <span className="thread-diff-path">
              {file.oldPath ? `${file.oldPath} → ` : ""}
              {file.path}
            </span>
            <span className="thread-work-meta">
              {CHANGE[file.change]}{" "}
              <span className="diff-add">+{file.additions}</span>{" "}
              <span className="diff-del">−{file.deletions}</span>
            </span>
          </summary>
          <pre className="thread-patch">
            {file.patch.split("\n").map((line, i) => (
              <span key={i} className={`diff-line diff-${lineKind(line)}`}>
                {line || " "}
                {"\n"}
              </span>
            ))}
          </pre>
        </details>
      ))}
    </div>
  );
}

/** The thread's total diff, or one turn's, loaded on demand. */
export function DiffView({
  threadId,
  turnId,
  refreshKey,
}: {
  threadId: string;
  turnId?: string;
  refreshKey: number;
}) {
  const [files, setFiles] = useState<FileDiff[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    threadsApi
      .diff(threadId, turnId)
      .then((r) => alive && (setFiles(r.files), setError("")))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [threadId, turnId, refreshKey]);
  if (error) return <p className="inline-error">{error}</p>;
  if (!files) return <p role="status">Cargando cambios…</p>;
  return <DiffFiles files={files} />;
}
