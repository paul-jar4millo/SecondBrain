import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { subscribeChanges } from "../../core/events";
import { isDemo } from "../../core/store";
import { teamApi } from "./team-store";
import { Markdown } from "../../components/Markdown";
import {
  choicePayload,
  effortLabel,
  loadChoice,
  ModelEffortPicker,
  saveChoice,
  type Model,
} from "./ModelEffortPicker";

type Motor = "claude" | "codex" | "agy" | "deepseek";
interface Session {
  id: string;
  motor: Motor;
  estado: string;
  proyecto?: string;
  copia: number;
  fase?: string;
  ultimaAccion?: string;
  encargo?: string | null;
  creada?: string;
  resultado?: string;
  error?: string;
  modelo?: string | null;
  esfuerzo?: string | null;
  conversacionId?: string;
  origen?: string;
  interactiva?: boolean;
  remotoUrl?: string;
  mensajes?: { rol: string; texto: string }[];
}
type Catalogo = Record<Motor, Model[]>;
const cuando = (iso?: string) =>
  iso
    ? new Date(iso).toLocaleString("es-MX", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

const names: Record<Motor, string> = {
  claude: "Ámbar · Claude",
  codex: "Menta · Codex",
  agy: "Lira · Antigravity",
  deepseek: "Marina · DeepSeek",
};

export function SessionPanel() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [engine, setEngine] = useState<Motor>("claude");
  const [project, setProject] = useState("");
  const [brief, setBrief] = useState("");
  const [proceed, setProceed] = useState<string | null>(null);
  const [equipo, setTeam] = useState(false);
  const [abierto, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [conectado, setConectado] = useState(false);
  const [busy, setBusy] = useState(false);
  const [catalog, setCatalog] = useState<Catalogo | null>(null);
  const [eleccion, setEleccion] = useState(() => loadChoice("claude"));
  const revision = useRef(0);
  const briefRef = useRef<HTMLTextAreaElement>(null);
  const briefCursor = useRef<number | null>(null);
  useLayoutEffect(() => {
    const pos = briefCursor.current;
    if (pos === null || !briefRef.current) return;
    briefCursor.current = null;
    briefRef.current.setSelectionRange?.(pos, pos);
  }, [brief]);
  useEffect(() => {
    if (!abierto || catalog || isDemo) return;
    let alive = true;
    teamApi("/agentes/modelos-lanzador")
      .then((c) => alive && setCatalog(c as Catalogo))
      .catch(() => alive && setCatalog(null));
    return () => {
      alive = false;
    };
  }, [abierto, catalog]);
  const modelos = catalog?.[engine] ?? [];
  const refresh = useCallback(async () => {
    const actual = ++revision.current;
    try {
      const [listado, repos] = isDemo
        ? [[], []]
        : await Promise.all([
            teamApi("/agentes/sesiones"),
            teamApi("/agentes/proyectos-lanzador"),
          ]);
      if (actual === revision.current) {
        setSessions(listado as Session[]);
        setProjects(repos as string[]);
        setConectado(!isDemo);
        setError("");
      }
    } catch {
      if (actual === revision.current) {
        setConectado(false);
        setError("El lanzador no está disponible.");
      }
    }
  }, []);
  useEffect(() => {
    void refresh();
    const leave = subscribeChanges(() => void refresh());
    const contador = revision;
    return () => {
      contador.current++;
      leave();
    };
  }, [refresh]);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
      return true;
    } catch (e) {
      setError((e as Error).message || "No se pudo completar la acción.");
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="session-panel" aria-labelledby="session-heading">
      <div className="section-heading">
        <div>
          <h2 id="session-heading">Sesiones</h2>
          <p>Actividad observada de los motores en el servidor.</p>
        </div>
        <button
          type="button"
          className="button"
          onClick={() => {
            if (!abierto) setProceed(null);
            setOpen(!abierto);
          }}
          disabled={!conectado}
        >
          {abierto ? "Cerrar encargo" : "Encargar trabajo"}
        </button>
      </div>
      {error && (
        <p className="inline-error" role="alert">
          {error}{" "}
          <button
            className="button"
            type="button"
            onClick={() => void refresh()}
          >
            Reintentar
          </button>
        </p>
      )}
      {abierto && (
        <form
          className="session-form"
          onSubmit={async (event) => {
            event.preventDefault();
            const text = brief.trim();
            if (!text || !project) return;
            const instruccion = equipo
              ? text +
                "\n\nForma equipo usando la skill equipo-cuatro-fases cuando sea útil."
              : text;
            const ok = await run(() =>
              teamApi("/agentes/sesiones", {
                motor: engine,
                origen: "sala",
                proyecto: project,
                brief: instruccion,
                ...(proceed ? { continuar: proceed } : {}),
                ...choicePayload(modelos, eleccion),
              }),
            );
            if (ok) {
              saveChoice(engine, eleccion);
              setBrief("");
              setProceed(null);
              setOpen(false);
            }
          }}
        >
          <label>
            Agente
            <select
              aria-label="Agente"
              value={engine}
              onChange={(e) => {
                const created = e.target.value as Motor;
                setEngine(created);
                setEleccion(loadChoice(created));
              }}
            >
              {Object.entries(names).map(([id, name]) => (
                <option value={id} key={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <ModelEffortPicker
            models={modelos}
            choice={eleccion}
            onChange={setEleccion}
          />
          {engine === "deepseek" && (
            <p className="muted session-model-note">
              Marina corre en DeepSeek con un solo modelo; el razonamiento
              ajusta su presupuesto de pensamiento.
            </p>
          )}
          <label>
            Repositorio
            <select
              value={project}
              onChange={(e) => setProject(e.target.value)}
            >
              <option value="">Selecciona un repositorio</option>
              {projects.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label>
            Encargo
            <textarea
              ref={briefRef}
              value={brief}
              maxLength={60000}
              rows={3}
              onChange={(e) => setBrief(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === "Enter") {
                  if (e.ctrlKey || e.metaKey) {
                    e.preventDefault();
                    const target = e.currentTarget;
                    const start = target.selectionStart ?? target.value.length;
                    const end = target.selectionEnd ?? target.value.length;
                    const value = target.value;
                    const next =
                      value.slice(0, start) + "\n" + value.slice(end);
                    if (next !== value) briefCursor.current = start + 1;
                    setBrief(next);
                    target.setSelectionRange?.(start + 1, start + 1);
                    return;
                  }
                  if (!e.shiftKey) {
                    e.preventDefault();
                    if (brief.trim() && !busy && conectado && project) {
                      e.currentTarget.form?.requestSubmit();
                    }
                  }
                }
              }}
            />
          </label>
          <label className="session-team-choice">
            <input
              type="checkbox"
              checked={equipo}
              onChange={(e) => setTeam(e.target.checked)}
            />{" "}
            Formar equipo si hace falta
          </label>
          <button
            className="button primary"
            type="submit"
            disabled={busy || !conectado || !project || !brief.trim()}
          >
            {proceed ? "Enviar mensaje" : "Iniciar encargo"}
          </button>
        </form>
      )}
      {sessions.length ? (
        <ul className="session-list">
          {sessions
            .slice(-20)
            .reverse()
            .map((s, i) => (
              <li key={s.id}>
                <div>
                  <strong>
                    {names[s.motor]}
                    {s.copia ? ` · copia ${s.copia + 1}` : ""}
                  </strong>
                  <p>
                    {s.proyecto || "Sala general"} · {s.estado}
                    {s.fase ? ` · ${s.fase}` : ""}
                    {s.modelo
                      ? ` · ${s.modelo}${s.esfuerzo ? ` (${effortLabel(s.esfuerzo)})` : ""}`
                      : ""}
                  </p>
                  {s.creada && (
                    <p className="session-when">{cuando(s.creada)}</p>
                  )}
                  {s.encargo && <p className="session-brief">{s.encargo}</p>}
                  {s.remotoUrl &&
                    /^https:\/\/(claude\.ai|antigravity\.google\.com)\//.test(
                      s.remotoUrl,
                    ) && (
                      <a href={s.remotoUrl} target="_blank" rel="noreferrer">
                        Abrir la misma conversación en Remote Control
                      </a>
                    )}
                  {!!s.mensajes?.length && (
                    <details>
                      <summary>Conversación</summary>
                      {s.mensajes.map((m, j) => (
                        <div key={j}>
                          <strong>{m.rol === "user" ? "Tú" : "Agente"}</strong>
                          <Markdown texto={m.texto} />
                        </div>
                      ))}
                    </details>
                  )}
                  {s.conversacionId &&
                    s.origen !== "remote" &&
                    s.proyecto &&
                    ["claude", "agy"].includes(s.motor) &&
                    !["trabajando", "pendiente"].includes(s.estado) && (
                      <button
                        className="button"
                        onClick={() => {
                          setProceed(s.id);
                          setEngine(s.motor);
                          setProject(s.proyecto!);
                          setOpen(true);
                        }}
                      >
                        Continuar conversación
                      </button>
                    )}
                  {s.ultimaAccion && !s.resultado && <p>{s.ultimaAccion}</p>}
                  {s.error && <p className="inline-error">{s.error}</p>}
                  {s.resultado && (
                    <details className="session-result" open={i === 0}>
                      <summary>Resultado</summary>
                      <div className="session-result-body">
                        <Markdown texto={s.resultado} />
                      </div>
                    </details>
                  )}
                </div>
                {(s.interactiva ||
                  ["pendiente", "trabajando"].includes(s.estado)) && (
                  <button
                    type="button"
                    className="button"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        teamApi("/agentes/sesiones/cancelar", { id: s.id }),
                      )
                    }
                  >
                    Cancelar
                  </button>
                )}
              </li>
            ))}
        </ul>
      ) : (
        <p className="muted">
          {conectado
            ? "Sin sesiones registradas."
            : "Las sesiones aparecerán al conectar el lanzador."}
        </p>
      )}
    </section>
  );
}
