// Flow templates (phase B1). A thread freezes its template's stages when it
// is created, so editing a template never changes threads already running.
import {
  FlowTemplate,
  newId,
  type AgentRef,
  type Thread,
  type ThreadFlow,
  type ThreadStage,
} from "../../../contracts/src/index.ts";

export const FLOW_TEMPLATES: readonly FlowTemplate[] = [
  {
    id: "single",
    name: "Un agente",
    description: "Un solo agente hace todo el trabajo.",
    stages: [
      { key: "work", name: "Trabajo", role: "implement", readOnly: false },
    ],
    handoffs: [],
    maxReviewRounds: 0,
  },
  {
    id: "plan-implement-review",
    name: "Planificar → Implementar → Revisar",
    description:
      "Un agente planifica en solo lectura, otro implementa y un tercero revisa sin escribir. La revisión puede devolver el trabajo al implementador hasta 3 veces.",
    stages: [
      { key: "plan", name: "Planificar", role: "plan", readOnly: true },
      {
        key: "implement",
        name: "Implementar",
        role: "implement",
        readOnly: false,
      },
      { key: "review", name: "Revisar", role: "review", readOnly: true },
    ],
    handoffs: [
      { from: "plan", to: "implement" },
      { from: "implement", to: "review" },
      { from: "review", to: "implement" },
    ],
    maxReviewRounds: 3,
  },
].map((template) => FlowTemplate.parse(template));

export function flowTemplate(id: string): FlowTemplate | undefined {
  return FLOW_TEMPLATES.find((template) => template.id === id);
}

/**
 * Copies a template into a thread. Each stage takes, in order, the agent
 * chosen for its key, the template default, or the thread's agent.
 */
export function freezeFlow(
  template: FlowTemplate,
  agent: AgentRef,
  stageAgents: Record<string, AgentRef> = {},
): ThreadFlow {
  const unknown = Object.keys(stageAgents).filter(
    (key) => !template.stages.some((stage) => stage.key === key),
  );
  if (unknown.length)
    throw new Error(`Etapa desconocida en el flujo: ${unknown.join(", ")}`);
  return {
    templateId: template.id,
    stages: template.stages.map((stage): ThreadStage => ({
      id: newId("stage"),
      key: stage.key,
      name: stage.name,
      role: stage.role,
      readOnly: stage.readOnly,
      agent: stageAgents[stage.key] ?? stage.defaultAgent ?? agent,
    })),
    handoffs: template.handoffs.map((rule) => ({ ...rule })),
    maxReviewRounds: template.maxReviewRounds,
  };
}

export function currentStage(thread: Thread): ThreadStage | null {
  return thread.flow?.stages[thread.stageIndex] ?? null;
}

/** A read-only stage narrows the thread's autonomy for its turns. */
export function isReadOnly(thread: Thread): boolean {
  return thread.autonomy === "read-only" || !!currentStage(thread)?.readOnly;
}
