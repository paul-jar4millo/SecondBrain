// Hand-offs between flow stages (phase B2). The agent says where the thread
// goes next and why; the system adds the hard data it can observe.
import type {
  FileDiff,
  HandoffBrief,
  Item,
  ItemOf,
  Thread,
  ThreadStage,
} from "../../../contracts/src/index.ts";
import { currentStage } from "./flows.ts";

const TEST_COMMAND =
  /\b(test|tests|vitest|jest|pytest|mocha|ava|playwright|node --test|go test|cargo test)\b/;
const MAX_LIST = 50;

/** Stage keys the current stage may hand the thread to. */
export function handoffTargets(thread: Thread): string[] {
  const stage = currentStage(thread);
  if (!thread.flow || !stage) return [];
  return thread.flow.handoffs
    .filter((rule) => rule.from === stage.key)
    .map((rule) => rule.to);
}

/** Index of the target stage, or an error the agent can act on. */
export function resolveHandoff(
  thread: Thread,
  toStage: string,
): { index: number } | { error: string } {
  if (!thread.flow || thread.flow.stages.length < 2)
    return { error: "Este thread no tiene un flujo con varias etapas." };
  const targets = handoffTargets(thread);
  if (!targets.includes(toStage))
    return {
      error: targets.length
        ? `Desde «${currentStage(thread)?.key}» solo puedes pasar a: ${targets.join(", ")}.`
        : `La etapa «${currentStage(thread)?.key}» no traspasa a ninguna otra.`,
    };
  return {
    index: thread.flow.stages.findIndex((stage) => stage.key === toStage),
  };
}

const cap = <T>(list: T[]) => list.slice(-MAX_LIST);

/**
 * Hard data of one stage: its items since it began and the thread's diff
 * against its base (repo threads).
 */
export function collectBrief(items: Item[], diff: FileDiff[]): HandoffBrief {
  const commands = items.filter(
    (item): item is ItemOf<"command"> => item.kind === "command",
  );
  const changed = new Set<string>();
  for (const item of items)
    if (item.kind === "file_change")
      for (const file of item.diffs) changed.add(file.path);
  for (const file of diff) changed.add(file.path);
  const failed = commands.filter(
    (item) => item.exitCode !== null && item.exitCode !== 0,
  );
  return {
    diffstat: diff.map(({ path, additions, deletions }) => ({
      path,
      additions,
      deletions,
    })),
    commands: cap(
      commands.map(({ command, exitCode }) => ({
        command: command.slice(0, 500),
        exitCode,
      })),
    ),
    failedTests: cap(
      failed
        .filter((item) => TEST_COMMAND.test(item.command))
        .map((item) => item.command.slice(0, 500)),
    ),
    errors: cap([
      ...items
        .filter(
          (item): item is ItemOf<"notice"> =>
            item.kind === "notice" && item.level === "error",
        )
        .map((item) => item.text.slice(0, 500)),
      ...failed
        .filter((item) => !TEST_COMMAND.test(item.command))
        .map(
          (item) =>
            `«${item.command.slice(0, 200)}» salió con ${item.exitCode}`,
        ),
    ]),
    files: [...changed].sort().slice(0, 200),
  };
}

const describeStage = (thread: Thread, stage: ThreadStage, index: number) =>
  `${index + 1}/${thread.flow?.stages.length} «${stage.name}» (${stage.key}${stage.readOnly ? ", solo lectura" : ""})`;

/** What a stage's agent reads before its first message in the stage. */
/**
 * What the agent of the current stage reads first. Later stages start a new
 * conversation, so they also get the owner's original task.
 */
export function stagePreamble(thread: Thread, task = ""): string {
  const stage = currentStage(thread);
  if (!thread.flow || thread.flow.stages.length < 2 || !stage) return "";
  const targets = handoffTargets(thread);
  const lines = [
    `[SecondBrain] Trabajas en la etapa ${describeStage(thread, stage, thread.stageIndex)} de un flujo de ${thread.flow.stages.length} etapas.`,
  ];
  if (thread.stageIndex > 0 && task.trim()) {
    const text = task.trim();
    lines.push(
      "La tarea original del dueño:",
      ...(text.length > 4000 ? `${text.slice(0, 4000)}…` : text)
        .split("\n")
        .map((line) => `> ${line}`),
    );
  }
  if (stage.readOnly)
    lines.push(
      "En esta etapa no modificas archivos: solo lees, analizas y, si hace falta, corres tests.",
    );
  if (stage.role === "review")
    lines.push(
      `Revisa el trabajo de la rama (git diff contra la base, tests si hace falta) y reporta tu veredicto con thread_report_review: approved, changes-requested con hallazgos concretos, o comment. Hasta ahora la revisión pidió cambios ${thread.counters.reviewRounds} de un máximo de ${thread.limits.maxReviewRounds} veces. Si pides cambios, el thread vuelve a la etapa anterior al terminar tu turno.`,
    );
  else if (targets.length)
    lines.push(
      `Cuando termines tu parte, llama a la herramienta thread_handoff con toStage (${targets.join(" o ")}), una narrativa de lo que hiciste y decidiste, y los pendientes en openItems. El traspaso ocurre al terminar tu turno. Si te falta información, pregúntale al dueño con thread_ask_user.`,
    );
  return lines.join("\n");
}

/** The first message of the next stage: the narrative plus the brief. */
export function briefMessage(input: {
  thread: Thread;
  from: number;
  narrative: string;
  openItems: string[];
  brief: HandoffBrief;
}): string {
  const { thread, from, narrative, openItems, brief } = input;
  const source = thread.flow?.stages[from];
  const lines = [
    `Traspaso desde la etapa «${source?.name ?? from + 1}».`,
    "",
    narrative.trim(),
  ];
  if (openItems.length)
    lines.push("", "Pendientes:", ...openItems.map((item) => `- ${item}`));
  if (brief.diffstat.length)
    lines.push(
      "",
      "Cambios en la rama:",
      ...brief.diffstat.map(
        (file) => `- ${file.path} (+${file.additions} −${file.deletions})`,
      ),
    );
  if (brief.commands.length)
    lines.push(
      "",
      "Comandos de la etapa:",
      ...brief.commands.map(
        (c) => `- ${c.command} → ${c.exitCode ?? "sin código"}`,
      ),
    );
  if (brief.failedTests.length)
    lines.push(
      "",
      "Tests que fallaron:",
      ...brief.failedTests.map((t) => `- ${t}`),
    );
  if (brief.errors.length)
    lines.push("", "Errores:", ...brief.errors.map((e) => `- ${e}`));
  return lines.join("\n");
}
