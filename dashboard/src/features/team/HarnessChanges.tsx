import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GitPullRequest, RotateCcw, Undo2 } from "lucide-react";
import { teamApi } from "./team-store";
import {
  STATE_LABEL,
  clock,
  diffQuery,
  lineKind,
  splitPatch,
  turnsOf,
  type Capabilities,
  type Checkpoint,
  type DiffResult,
} from "./harness-changes";
import { PullRequestDialog } from "./PullRequestDialog";

const ALL = "all";

/**
 * Files changed by a session in its repository, per turn or as a whole, with a
 * light patch viewer, a two-step revert (and its undo) and the pull request form.
 */
export function HarnessChanges({
  id,
  agentName,
  checkpoints,
  capacidades,
  working,
  visible,
}: {
  id: string;
  agentName: string;
  checkpoints: Checkpoint[];
  capacidades?: Capabilities;
  working: boolean;
  visible: boolean;
}) {
  const turns = useMemo(() => turnsOf(checkpoints), [checkpoints]);
  const [selection, setSelection] = useState(ALL);
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");
  const [hiddenUndo, setHiddenUndo] = useState(0);
  const [prOpen, setPrOpen] = useState(false);
  const request = useRef(0);

  const turn = turns.find((t) => String(t.n) === selection);
  const last = checkpoints.at(-1);
  const undoable =
    last?.tipo === "reversion" && last.n !== hiddenUndo ? last : undefined;
  const lastN = last?.n ?? 0;

  const load = useCallback(async () => {
    if (!checkpoints.length) {
      setDiff(null);
      return;
    }
    const current = ++request.current;
    setLoading(true);
    try {
      const result = (await teamApi(diffQuery(id, turn))) as DiffResult;
      if (current !== request.current) return;
      setDiff(result);
      setError("");
    } catch (e) {
      if (current === request.current) setError((e as Error).message);
    } finally {
      if (current === request.current) setLoading(false);
    }
    // A new checkpoint or the end of a turn changes what there is to show.
  }, [id, turn, checkpoints.length]);

  useEffect(() => {
    if (visible) void load();
  }, [visible, load, lastN, working]);

  useEffect(() => {
    if (selection !== ALL && !turn) setSelection(ALL);
  }, [selection, turn]);

  const revertTarget = turn ? turn.n : checkpoints[0]?.n;
  const revertBlocked = !capacidades?.revertirArchivos
    ? "Revertir archivos requiere una carpeta con repositorio git."
    : working
      ? "Detén el turno antes de revertir."
      : "";
  const prBlocked = !capacidades?.crearPr
    ? "Crear un PR requiere un repositorio registrado con remoto en GitHub."
    : working
      ? "Detén el turno antes de crear el PR."
      : "";

  const revert = async (n: number, undo = false) => {
    setBusy(true);
    setError("");
    setDone("");
    try {
      await teamApi("/agentes/sesiones/revertir", { id, n });
      setDone(
        undo
          ? "Reversión deshecha: los archivos volvieron a su estado anterior."
          : "Archivos restaurados. La conversación del proveedor no se revierte.",
      );
      if (undo && undoable) setHiddenUndo(undoable.n);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  const blocks = useMemo(() => splitPatch(diff?.parche ?? ""), [diff]);
  const byPath = new Map(blocks.map((b) => [b.ruta, b]));

  if (!checkpoints.length)
    return (
      <p className="muted changes-empty">
        Todavía no hay cambios guardados. Cada turno guarda un punto de control
        antes de empezar.
      </p>
    );

  return (
    <div className="changes">
      <div className="changes-toolbar">
        <label>
          <span className="sr-only">Rango de cambios</span>
          <select
            value={selection}
            onChange={(e) => {
              setSelection(e.target.value);
              setConfirming(false);
              setDone("");
            }}
          >
            <option value={ALL}>Toda la sesión</option>
            {turns.map((t, i) => (
              <option key={t.n} value={String(t.n)}>
                {`Turno ${i + 1} · ${clock(t.ts)} · ${t.mensaje.slice(0, 50) || "sin texto"}`}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className={`button ${confirming ? "danger" : "subtle"}`}
          disabled={!!revertBlocked || busy || revertTarget === undefined}
          title={revertBlocked || "Devuelve los archivos al estado previo"}
          onBlur={() => setConfirming(false)}
          onClick={() => {
            if (!confirming) return setConfirming(true);
            if (revertTarget !== undefined) void revert(revertTarget);
          }}
        >
          <RotateCcw size={14} aria-hidden="true" />
          {confirming
            ? "Confirmar: revertir"
            : turn
              ? "Revertir a antes de este turno"
              : "Revertir a antes de la sesión"}
        </button>
        {undoable && (
          <button
            type="button"
            className="button"
            disabled={!!revertBlocked || busy}
            title={revertBlocked || "Vuelve al estado previo a la reversión"}
            onClick={() => void revert(undoable.n, true)}
          >
            <Undo2 size={14} aria-hidden="true" />
            Deshacer reversión
          </button>
        )}
        <button
          type="button"
          className="button primary"
          disabled={!!prBlocked || busy}
          title={
            prBlocked || `Rama, commit y PR con los cambios de ${agentName}`
          }
          onClick={() => setPrOpen(true)}
        >
          <GitPullRequest size={14} aria-hidden="true" />
          Crear PR
        </button>
      </div>
      {revertBlocked && (
        <small className="muted">
          {revertBlocked} La conversación del proveedor no se revierte.
        </small>
      )}
      {done && (
        <p className="muted" role="status">
          {done}
        </p>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {prOpen && (
        <PullRequestDialog
          id={id}
          agentName={agentName}
          capacidades={capacidades}
          onClose={() => setPrOpen(false)}
          onCreated={() => void load()}
        />
      )}
      {loading && !diff && <p className="muted">Calculando cambios…</p>}
      {diff && !diff.archivos.length && (
        <p className="muted">Sin cambios en este rango.</p>
      )}
      {diff && diff.archivos.length > 0 && (
        <>
          <p className="changes-summary">
            {diff.archivos.length} archivos ·{" "}
            <span className="patch-add-count">
              +{diff.archivos.reduce((n, a) => n + a.añadidas, 0)}
            </span>{" "}
            <span className="patch-del-count">
              −{diff.archivos.reduce((n, a) => n + a.eliminadas, 0)}
            </span>
          </p>
          <ul className="changes-files">
            {diff.archivos.map((file) => {
              const block = byPath.get(file.ruta);
              return (
                <li key={file.ruta}>
                  <details>
                    <summary>
                      <span
                        className={`changes-state state-${file.estado}`}
                        title={STATE_LABEL[file.estado]}
                      >
                        {file.estado}
                      </span>
                      <span className="changes-path">
                        {file.anterior
                          ? `${file.anterior} → ${file.ruta}`
                          : file.ruta}
                      </span>
                      <span className="changes-counts">
                        {file.binario ? (
                          "binario"
                        ) : (
                          <>
                            <span className="patch-add-count">
                              +{file.añadidas}
                            </span>{" "}
                            <span className="patch-del-count">
                              −{file.eliminadas}
                            </span>
                          </>
                        )}
                      </span>
                    </summary>
                    {block ? (
                      <pre className="changes-patch" tabIndex={0}>
                        {block.lines.map((line, i) => (
                          <span
                            key={i}
                            className={`patch-line patch-${lineKind(line)}`}
                          >
                            {line}
                            {"\n"}
                          </span>
                        ))}
                      </pre>
                    ) : (
                      <p className="muted">
                        Sin vista previa: el parche se recortó.
                      </p>
                    )}
                  </details>
                </li>
              );
            })}
          </ul>
          {diff.recortado && (
            <p className="muted" role="status">
              El parche se recortó a 1 MB; la lista de archivos está completa.
            </p>
          )}
        </>
      )}
    </div>
  );
}
