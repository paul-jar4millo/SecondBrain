import { characters } from "../agents/characters";
import {
  isAttentionThread,
  isWorkingThread,
  STATUS_LABEL,
} from "../threads/thread-store";
import type { Thread } from "../threads/thread-types";
import type { AgentState } from "./room-types";

export interface ObservedCopy {
  id: string;
  baseId: string;
  copy: number;
}

export function conciliarCopias(actuales: string[], deseadas: string[]) {
  const actualesSet = new Set(actuales);
  const deseadasSet = new Set(deseadas);
  return {
    crear: deseadas.filter((id) => !actualesSet.has(id)),
    retirar: actuales.filter((id) => !deseadasSet.has(id)),
  };
}

export function sceneSessions(threads: Thread[]) {
  const copies: ObservedCopy[] = [];
  const figures = new Map<string, string>();
  const agents: AgentState[] = [];
  for (const character of characters) {
    const owned = threads.filter(
      (thread) => thread.agent.engine === character.engine,
    );
    const active = owned
      .filter(
        (thread) =>
          isWorkingThread(thread) ||
          (thread.status !== "failed" && isAttentionThread(thread)),
      )
      .sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      );
    const main = active[0] ?? owned[0];
    agents.push(sceneAgent(character.id, main));
    active.forEach((thread, copy) => {
      const id = copy ? character.id + "#" + copy : character.id;
      figures.set(thread.id, id);
      if (copy) {
        copies.push({ id, baseId: character.id, copy });
        agents.push(sceneAgent(id, thread));
      }
    });
  }
  return { agents, copies, figures };
}

function sceneAgent(id: string, thread?: Thread): AgentState {
  return {
    id,
    ocupada: thread ? isWorkingThread(thread) : false,
    ultimo: thread
      ? {
          jobId: thread.id,
          estado: thread.status === "done" ? "listo" : thread.status,
          actividad: {
            zona: thread.repo ? "workshop" : "terrace",
            etiqueta: STATUS_LABEL[thread.status],
          },
        }
      : null,
  };
}
