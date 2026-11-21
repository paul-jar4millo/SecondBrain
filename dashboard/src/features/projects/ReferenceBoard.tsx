import { useEffect, useRef, useState } from "react";
import { isDemo } from "../../core/store";
import { useUI } from "../../components/ui";
import { agentApi } from "../agents/agent-api";
interface Pin {
  id: string;
  titulo: string;
  consulta?: string;
  etiquetas?: string[];
  imagen: string;
  url: string;
}
interface Board {
  pines?: Pin[];
  tablero: string[];
}

export function ReferenceBoard({ projectId }: { projectId: string }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [bank, setBank] = useState(false);
  const [version, setVersion] = useState(0);
  const [pending, setPending] = useState<string[]>([]);
  const generation = useRef(0);
  const { notify } = useUI();
  useEffect(() => {
    generation.current++;
    let alive = true;
    setBoard(null);
    setError("");
    agentApi(`/room?espacio=${encodeURIComponent(projectId)}`)
      .then((data) => {
        if (alive) setBoard(data as Board);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [projectId, version]);
  return (
    <section className="reference-workspace">
      <div className="section-heading">
        <h2>Referencias del proyecto</h2>
        <button
          className="button"
          aria-pressed={bank}
          onClick={() => setBank((v) => !v)}
        >
          {bank ? "Ver guardadas" : "Explorar banco local"}
        </button>
      </div>
      <p className="muted">
        El banco local es independiente de las entregas de los modelos. Guardar
        una referencia no inicia encargos.
      </p>
      {bank && (
        <label className="reference-search" htmlFor="reference-query">
          Buscar referencias
          <input
            id="reference-query"
            type="search"
            value={query}
            placeholder="Habitación, luz, diseño…"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      )}
      {error && (
        <div className="inline-error" role="alert">
          <p>{error}</p>
          <button className="button" onClick={() => setVersion((v) => v + 1)}>
            Reintentar
          </button>
        </div>
      )}
      {!board && !error && <p role="status">Cargando referencias…</p>}
      {board && (
        <div className="reference-grid">
          {(board.pines || [])
            .filter(
              (p) =>
                (bank || board.tablero.includes(p.id)) &&
                (!bank ||
                  !query ||
                  `${p.titulo} ${p.consulta || ""} ${(p.etiquetas || []).join(" ")}`
                    .toLocaleLowerCase("es")
                    .includes(query.toLocaleLowerCase("es"))),
            )
            .map((p) => (
              <article key={p.id}>
                <a href={p.url} target="_blank" rel="noreferrer">
                  <img
                    src={
                      isDemo
                        ? p.imagen
                        : `/api/v1/room/image?id=${encodeURIComponent(p.id)}`
                    }
                    alt=""
                    loading="lazy"
                  />
                  <h3>{p.titulo}</h3>
                </a>
                <button
                  className="button"
                  disabled={pending.includes(p.id)}
                  onClick={async () => {
                    const started = generation.current;
                    setPending((ids) => [...ids, p.id]);
                    try {
                      const ids = (await agentApi("/room/board", {
                        id: p.id,
                        guardar: !board.tablero.includes(p.id),
                        espacio: projectId,
                      })) as string[];
                      if (started === generation.current)
                        setBoard((current) =>
                          current ? { ...current, tablero: ids } : current,
                        );
                    } catch (e) {
                      notify((e as Error).message);
                    } finally {
                      setPending((ids) => ids.filter((id) => id !== p.id));
                    }
                  }}
                >
                  {board.tablero.includes(p.id)
                    ? "Quitar del tablero"
                    : "Guardar referencia"}
                </button>
              </article>
            ))}
        </div>
      )}
      {board && !bank && !board.tablero.length && (
        <div className="work-empty">
          <h3>Un lugar para tus referencias</h3>
          <p>
            Explora el banco local y guarda las imágenes que te sirvan para este
            proyecto.
          </p>
          <button className="button" onClick={() => setBank(true)}>
            Explorar referencias
          </button>
        </div>
      )}
    </section>
  );
}
