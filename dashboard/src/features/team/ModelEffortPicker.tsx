export interface Model {
  id: string;
  nombre: string;
  esfuerzos?: string[];
  esfuerzo?: string;
}
export interface ModelChoice {
  modelo: string;
  esfuerzo: string;
}

export const EFFORT_LABELS: Record<string, string> = {
  none: "Ninguno",
  minimal: "Mínimo",
  low: "Bajo",
  medium: "Medio",
  high: "Alto",
  xhigh: "Muy alto",
  max: "Máximo",
  ultra: "Ultra",
};
export const effortLabel = (effort: string) => EFFORT_LABELS[effort] ?? effort;

const key = (engine: string) => `sb-modelo-${engine}`;

/** The last choice per agent, on this device; older installs only kept the model. */
export function loadChoice(engine: string): ModelChoice {
  try {
    const stored = JSON.parse(localStorage.getItem(key(engine)) || "null");
    if (stored)
      return {
        modelo: typeof stored.modelo === "string" ? stored.modelo : "",
        esfuerzo: typeof stored.esfuerzo === "string" ? stored.esfuerzo : "",
      };
    return {
      modelo: localStorage.getItem(`sb-chat-model:${engine}`) || "",
      esfuerzo: "",
    };
  } catch {
    return { modelo: "", esfuerzo: "" };
  }
}

export function saveChoice(engine: string, choice: ModelChoice) {
  try {
    localStorage.setItem(key(engine), JSON.stringify(choice));
    return true;
  } catch {
    return false; // Private mode: the choice simply is not remembered.
  }
}

/**
 * What a choice means right now: a model the CLI stopped offering falls back to
 * the default, and an effort the model lacks to the model's own default.
 */
export function resolveChoice(models: Model[], choice: ModelChoice) {
  const model =
    models.find((m) => m.id === choice.modelo) ||
    (models.length === 1 ? models[0] : undefined);
  const efforts = model
    ? model.esfuerzos || []
    : [...new Set(models.flatMap((m) => m.esfuerzos || []))];
  return {
    model,
    efforts,
    effort: efforts.includes(choice.esfuerzo) ? choice.esfuerzo : "",
  };
}

/** Fields for POST /agentes/sesiones: what is not chosen is left to the program. */
export function choicePayload(models: Model[], choice: ModelChoice) {
  const { model, effort } = resolveChoice(models, choice);
  return {
    ...(model ? { modelo: model.id } : {}),
    ...(effort ? { esfuerzo: effort } : {}),
  };
}

/** The single model and reasoning selector of every view, for every agent. */
export function ModelEffortPicker({
  models,
  choice,
  onChange,
  owner,
  defaultLabel = "Predeterminado",
}: {
  models: Model[];
  choice: ModelChoice;
  onChange: (choice: ModelChoice) => void;
  /** Names the selects when one screen lists several agents. */
  owner?: string;
  defaultLabel?: string;
}) {
  const { model, efforts, effort } = resolveChoice(models, choice);
  const modelDefault = model?.esfuerzo && effortLabel(model.esfuerzo);
  return (
    <div className="conversation-model">
      <label>
        Modelo
        <select
          aria-label={owner ? `Modelo de ${owner}` : undefined}
          value={model?.id ?? ""}
          disabled={!models.length}
          onChange={(e) =>
            onChange({ modelo: e.target.value, esfuerzo: choice.esfuerzo })
          }
        >
          {models.length !== 1 && <option value="">{defaultLabel}</option>}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.nombre}
            </option>
          ))}
        </select>
      </label>
      <label>
        Razonamiento
        <select
          aria-label={owner ? `Razonamiento de ${owner}` : undefined}
          value={effort}
          disabled={!efforts.length}
          title={
            efforts.length ? undefined : "Este modelo no permite elegirlo aquí."
          }
          onChange={(e) =>
            onChange({ modelo: model?.id ?? "", esfuerzo: e.target.value })
          }
        >
          <option value="">
            {modelDefault
              ? `Predeterminado (${modelDefault})`
              : efforts.length || !models.length
                ? "Predeterminado"
                : "Lo fija el modelo"}
          </option>
          {efforts.map((v) => (
            <option key={v} value={v}>
              {effortLabel(v)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
