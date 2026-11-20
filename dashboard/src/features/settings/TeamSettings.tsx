import { useState } from "react";
import { isDemo } from "../../core/store";
import { useUI } from "../../components/ui";
import { characters } from "../agents/characters";
import { AgentPortrait } from "../agents/TeamPrimitives";
import { useThreadProjection } from "../threads/thread-projection";
import { isWorkingThread } from "../threads/thread-store";
import { useModels } from "../threads/Composer";
import {
  loadChoice,
  ModelEffortPicker,
  saveChoice,
} from "../agents/ModelEffortPicker";
import { preference, setPreference } from "./preferences";

/** Who answers by default and which model each one opens with on this device. */
export function TeamSettings() {
  const { notify } = useUI();
  const team = useThreadProjection();
  const [defaultAgent, setDefaultAgent] = useState(() =>
    preference("defaultAgent"),
  );
  const [financeAgent, setFinanceAgent] = useState(() =>
    preference("financeAgent"),
  );
  const catalog = useModels();
  const [choices, setChoices] = useState(() =>
    Object.fromEntries(
      characters.map(({ engine }) => [engine, loadChoice(engine)]),
    ),
  );
  const agentOptions = characters.map((a) => (
    <option key={a.id} value={a.id}>
      {a.name} · {a.provider}
    </option>
  ));
  const running = team.threads.filter(isWorkingThread).length;
  return (
    <>
      <div className="setting-row">
        <div>
          <h3>Agente predeterminada</h3>
          <p>Agente que se propone al crear un thread.</p>
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
        Modelo y razonamiento al crear un thread
      </h3>
      <p className="settings-note">
        Se puede cambiar en cada thread nuevo. Los modelos más potentes gastan
        más de tu plan.
      </p>
      {characters.map((a) => {
        const engine = a.engine;
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
                : !team.error
                  ? running
                    ? `Conectado · ${running} ${running === 1 ? "thread en curso" : "threads en curso"}.`
                    : "Conectado · sin threads en curso."
                  : "Sin conexión. Los threads guardados se conservan."}
          </p>
        </div>
        <i
          className={
            "status-dot " + (team.loaded && team.error ? "offline" : "")
          }
          aria-hidden="true"
        />
      </div>
    </>
  );
}
