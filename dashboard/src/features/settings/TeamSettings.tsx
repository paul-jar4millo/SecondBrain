import { useEffect, useState } from "react";
import { isDemo } from "../../core/store";
import { useUI } from "../../components/ui";
import { engines } from "../team/agent-draft";
import { characters } from "../team/characters";
import { AgentPortrait } from "../team/TeamPrimitives";
import { teamApi, useTeam } from "../team/team-store";
import {
  loadChoice,
  ModelEffortPicker,
  saveChoice,
  type Model,
} from "../team/ModelEffortPicker";
import { preference, setPreference } from "./preferences";

/** Who answers by default and which model each one opens with on this device. */
export function TeamSettings() {
  const { notify } = useUI();
  const team = useTeam();
  const [defaultAgent, setDefaultAgent] = useState(() =>
    preference("defaultAgent"),
  );
  const [financeAgent, setFinanceAgent] = useState(() =>
    preference("financeAgent"),
  );
  const [catalog, setCatalog] = useState<Record<string, Model[]> | null>(null);
  const [choices, setChoices] = useState(() =>
    Object.fromEntries(
      Object.values(engines).map((engine) => [engine, loadChoice(engine)]),
    ),
  );
  useEffect(() => {
    if (isDemo) return;
    let live = true;
    void teamApi("/agentes/modelos-lanzador")
      .then((c) => {
        if (live) setCatalog(c as Record<string, Model[]>);
      })
      .catch(() => {
        if (live) setCatalog({});
      });
    return () => {
      live = false;
    };
  }, []);
  const agentOptions = characters.map((a) => (
    <option key={a.id} value={a.id}>
      {a.name} · {a.provider}
    </option>
  ));
  const running = (team.sessions || []).filter((s) =>
    ["pendiente", "trabajando"].includes(s.estado),
  ).length;
  return (
    <>
      <div className="setting-row">
        <div>
          <h3>Agente predeterminada</h3>
          <p>A quién abre Equipo en un proyecto donde aún no has elegido.</p>
        </div>
        <select
          aria-label="Agente predeterminada"
          value={defaultAgent}
          onChange={(e) => {
            setDefaultAgent(e.target.value);
            setPreference("defaultAgent", e.target.value);
          }}
        >
          {agentOptions}
        </select>
      </div>
      <div className="setting-row">
        <div>
          <h3>Agente para finanzas</h3>
          <p>La que propone «Actualizar con agente» al subir tus capturas.</p>
        </div>
        <select
          aria-label="Agente para finanzas"
          value={financeAgent}
          onChange={(e) => {
            setFinanceAgent(e.target.value);
            setPreference("financeAgent", e.target.value);
          }}
        >
          {agentOptions}
        </select>
      </div>
      <h3 className="settings-subtitle">
        Modelo y razonamiento al abrir una conversación
      </h3>
      <p className="settings-note">
        Se puede cambiar en cada conversación nueva. Los modelos más potentes
        gastan más de tu plan.
      </p>
      {characters.map((a) => {
        const engine = engines[a.id];
        const list = catalog?.[engine] || [];
        return (
          <div className="setting-row setting-agent" key={a.id}>
            <AgentPortrait id={a.id} />
            <div>
              <h3>{a.name}</h3>
              <p>{a.provider}</p>
            </div>
            <ModelEffortPicker
              owner={a.name}
              models={list}
              choice={choices[engine]}
              defaultLabel={
                catalog && !list.length
                  ? "Sin catálogo del lanzador"
                  : "Predeterminado"
              }
              onChange={(choice) => {
                if (!saveChoice(engine, choice))
                  notify("No se pudo guardar en este navegador.");
                setChoices((current) => ({ ...current, [engine]: choice }));
              }}
            />
          </div>
        );
      })}
      <div className="setting-row">
        <div>
          <h3>Lanzador de agentes</h3>
          <p>
            {isDemo
              ? "No se usa en la demostración."
              : !team.loaded
                ? "Comprobando conexión…"
                : team.connected
                  ? running
                    ? `Conectado · ${running} ${running === 1 ? "sesión en curso" : "sesiones en curso"}.`
                    : "Conectado · sin sesiones en curso."
                  : "Sin conexión. Las conversaciones guardadas se conservan."}
          </p>
        </div>
        <i
          className={
            "status-dot " + (team.loaded && !team.connected ? "offline" : "")
          }
          aria-hidden="true"
        />
      </div>
    </>
  );
}
