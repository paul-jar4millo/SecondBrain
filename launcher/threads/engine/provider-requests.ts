// Provider requests (ctx.ask) ↔ contract user requests. Providers ask two
// things: questions (Codex requestUserInput, Claude AskUserQuestion) and
// approvals (commands, file changes, MCP elicitation forms).
import type {
  RequestAnswer,
  UserRequest,
} from "../../../contracts/src/index.ts";

export interface ProviderQuestion {
  id: string;
  header?: string;
  question?: string;
  options?: { label: string }[];
  multiSelect?: boolean;
  /** The provider also accepts free text besides the options. */
  isOther?: boolean;
}

export interface ProviderAsk {
  kind?: string;
  title?: string;
  detail?: string;
  questions?: ProviderQuestion[];
  choices?: string[];
  mode?: string;
  requestedSchema?: {
    properties?: Record<
      string,
      { type?: string; enum?: unknown[]; title?: string; description?: string }
    >;
    required?: string[];
  } | null;
}

export type ProviderAnswer =
  | Record<string, string | string[]>
  | { decision: string; content?: Record<string, unknown> };

const optionId = (label: string, index: number) =>
  label.trim().slice(0, 64) || `option-${index + 1}`;

/** True for plain approvals of commands or file changes (no form). */
export const isPlainApproval = (ask: ProviderAsk) =>
  ask.kind === "approval" && !ask.requestedSchema;

export function toUserRequest(
  ask: ProviderAsk,
  base: Pick<UserRequest, "id" | "threadId" | "turnId" | "createdAt">,
): UserRequest {
  const common = {
    ...base,
    status: "open" as const,
    answer: null,
    origin: null,
    answeredAt: null,
  };
  const title = (ask.title || "El agente necesita tu respuesta").slice(0, 300);
  if (ask.kind === "question" && ask.questions?.length) {
    return {
      ...common,
      kind:
        ask.questions.length === 1 && ask.questions[0]?.options?.length
          ? "question"
          : "form",
      title,
      body: ask.questions.map((q) => q.question || q.header || "").join("\n\n"),
      fields: ask.questions.map((q) => ({
        id: /^[A-Za-z][\w-]{0,63}$/.test(q.id) ? q.id : `q${q.id}`.slice(0, 64),
        label: (q.question || q.header || q.id).slice(0, 300) || q.id,
        type: q.options?.length ? ("select" as const) : ("textarea" as const),
        required: true,
        ...(q.options?.length
          ? {
              options: q.options.map((o, i) => ({
                id: optionId(o.label, i),
                label: o.label.slice(0, 200),
              })),
            }
          : {}),
      })),
    };
  }
  if (ask.requestedSchema) {
    const properties = ask.requestedSchema.properties ?? {};
    const required = new Set(ask.requestedSchema.required ?? []);
    return {
      ...common,
      kind: "form",
      title,
      body: ask.detail ?? "",
      fields: Object.entries(properties)
        .filter(([id]) => /^[A-Za-z][\w-]{0,63}$/.test(id))
        .map(([id, prop]) => ({
          id,
          label: (prop.title || prop.description || id).slice(0, 300),
          type: prop.enum
            ? ("select" as const)
            : prop.type === "boolean"
              ? ("boolean" as const)
              : ("text" as const),
          required: required.has(id),
          ...(prop.enum
            ? {
                options: prop.enum.map((value, i) => ({
                  id: String(value).slice(0, 64) || `option-${i + 1}`,
                  label: String(value).slice(0, 200) || `option-${i + 1}`,
                })),
              }
            : {}),
        })),
    };
  }
  const choices = ask.choices?.length ? ask.choices : ["accept", "decline"];
  return {
    ...common,
    kind: "approval",
    title,
    body: ask.detail ?? "",
    options: choices.map((c) => ({ id: c, label: c })),
  };
}

const coerce = (value: string | boolean, type: string | undefined): unknown => {
  if (type === "integer" || type === "number") {
    const number = Number(value);
    return Number.isFinite(number) ? number : value;
  }
  if (type === "boolean") return value === true || value === "true";
  return value;
};

/** Converts the owner's answer into what the provider callback expects. */
export function toProviderAnswer(
  ask: ProviderAsk,
  request: UserRequest,
  answer: RequestAnswer,
): ProviderAnswer {
  if (ask.kind === "question" && ask.questions?.length) {
    const out: Record<string, string> = {};
    for (const [index, field] of (request.fields ?? []).entries()) {
      const question = ask.questions[index];
      if (!question) continue;
      const raw =
        answer.values?.[field.id] ??
        (request.fields?.length === 1
          ? (answer.optionId ?? answer.text)
          : undefined);
      const option = field.options?.find((o) => o.id === raw);
      if (field.options?.length && !option && !question.isOther)
        throw new Error(`Opción inválida: ${field.label}`);
      const value = option?.label ?? (raw === undefined ? "" : String(raw));
      if (!value.trim()) throw new Error(`Falta la respuesta: ${field.label}`);
      out[question.id] = value;
    }
    return out;
  }
  if (ask.requestedSchema) {
    if (answer.approved === false) return { decision: "decline" };
    const properties = ask.requestedSchema.properties ?? {};
    const content: Record<string, unknown> = {};
    for (const [id, value] of Object.entries(answer.values ?? {}))
      if (id in properties) content[id] = coerce(value, properties[id]?.type);
    return { decision: "accept", content };
  }
  const choices = ask.choices?.length ? ask.choices : ["accept", "decline"];
  const decision =
    answer.optionId ??
    (answer.approved === true
      ? "accept"
      : answer.approved === false
        ? "decline"
        : undefined);
  if (!decision || !choices.includes(decision))
    throw new Error("Decisión inválida.");
  return { decision };
}
