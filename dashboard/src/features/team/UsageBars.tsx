import { useEffect, useState } from "react";
import { isDemo } from "../../core/store";
import { teamApi } from "./team-store";

interface UsageWindow {
  usado?: number;
  reinicia?: string | null;
  agotada?: boolean;
}
interface ProviderUsage {
  ventanas?: Record<string, UsageWindow>;
  actualizado?: string | null;
  contexto?: { usados: number; limite: number };
  contextoActualizado?: string | null;
}
const WINDOWS = [
  ["5h", "5 horas"],
  ["semanal", "Semanal"],
] as const;
const READ_EVERY = 60_000;
// Marina pays per token through an API: she has no plan windows to show.
const MEASURED = new Set(["codex", "claude", "agy"]);

const time = (iso: string, withDay: boolean) =>
  new Date(iso).toLocaleString("es-MX", {
    ...(withDay ? { weekday: "short" as const } : {}),
    hour: "2-digit",
    minute: "2-digit",
  });

/** What is left of a provider's plan. Reads what the CLI recorded; it costs no quota. */
export function UsageBars({
  motor,
  contexto,
}: {
  motor: string;
  contexto?: { usados: number; limite: number };
}) {
  const [usage, setUsage] = useState<Record<string, ProviderUsage>>({});
  const measured = MEASURED.has(motor);
  useEffect(() => {
    if (isDemo || !measured) return;
    let live = true;
    const read = () => {
      if (document.hidden) return;
      void Promise.resolve()
        .then(() => teamApi("/agentes/uso"))
        .then((value) => {
          if (live && value) setUsage(value as Record<string, ProviderUsage>);
        })
        .catch(() => {});
    };
    read();
    const tick = setInterval(read, READ_EVERY);
    document.addEventListener("visibilitychange", read);
    return () => {
      live = false;
      clearInterval(tick);
      document.removeEventListener("visibilitychange", read);
    };
  }, [measured]);
  const current = usage[motor];
  const staleClaude =
    motor === "claude" &&
    !!current?.actualizado &&
    Date.now() - Date.parse(current.actualizado) > 3 * 60_000;
  const rows = WINDOWS.flatMap(([id, label]) => {
    if (staleClaude) return [];
    const window = current?.ventanas?.[id];
    return window && typeof window.usado === "number"
      ? [{ id, label, window, left: Math.max(0, 100 - window.usado) }]
      : [];
  });
  const measuredContext =
    current?.contextoActualizado &&
    Date.now() - Date.parse(current.contextoActualizado) < 3 * 60_000
      ? current.contexto
      : contexto;
  const contextUsed =
    measuredContext && Number.isFinite(measuredContext.usados)
      ? Math.max(0, measuredContext.usados)
      : null;
  const contextPercent =
    contextUsed === null ? 0 : Math.min(100, contextUsed / 4000);
  return (
    <div
      className="usage-bars"
      role="group"
      aria-label="Uso y contexto del agente"
      title={
        current?.actualizado
          ? `Última lectura: ${time(current.actualizado, true)}`
          : undefined
      }
    >
      <div
        className="usage-bar"
        data-tone={
          contextPercent >= 90 ? "low" : contextPercent >= 75 ? "mid" : "ok"
        }
      >
        <span>
          <b>Contexto</b>{" "}
          {contextUsed === null
            ? "sin lectura"
            : `${Math.round(contextUsed / 1000)} mil / 400 mil tokens`}
        </span>
        <i
          role="meter"
          aria-label="Contexto utilizado"
          aria-valuemin={0}
          aria-valuemax={400000}
          aria-valuenow={contextUsed ?? 0}
          aria-valuetext={contextUsed === null ? "sin lectura" : undefined}
        >
          <i style={{ width: `${contextPercent}%` }} />
        </i>
      </div>
      {staleClaude && (
        <div className="usage-bar">
          <span>
            <b>Plan Claude</b> sin lectura reciente{" "}
            <small>· última {time(current!.actualizado!, true)}</small>
          </span>
        </div>
      )}
      {rows.map(({ id, label, window, left }) => (
        <div
          className="usage-bar"
          key={id}
          data-tone={left <= 15 ? "low" : left <= 40 ? "mid" : "ok"}
        >
          <span>
            <b>{label}</b> quedan {Math.round(left)} %
            {window.reinicia && (
              <small>
                {" "}
                · reinicia {time(window.reinicia, id === "semanal")}
              </small>
            )}
          </span>
          <i
            role="meter"
            aria-label={`${label}: uso restante`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(left)}
          >
            <i style={{ width: `${left}%` }} />
          </i>
        </div>
      ))}
    </div>
  );
}
