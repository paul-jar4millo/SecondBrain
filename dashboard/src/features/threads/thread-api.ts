import { api } from "../../core/store";
import type {
  AgentRef,
  FileDiff,
  InboxEntry,
  Item,
  RequestAnswer,
  Thread,
  ThreadSnapshot,
  UserRequest,
} from "./thread-types";

const post = <T>(path: string, data: unknown) =>
  api<T>(path, { method: "POST", body: JSON.stringify(data) });

export interface NewThread {
  prompt: string;
  kind: "repo" | "scratch";
  title?: string;
  repoPath?: string;
  baseBranch?: string;
  agent: AgentRef;
  autonomy?: Thread["autonomy"];
}

export const threadsApi = {
  list: (status?: string) =>
    api<{ threads: Thread[]; globalSeq?: number }>(
      `/threads${status ? `?status=${encodeURIComponent(status)}` : ""}`,
    ),
  snapshot: (id: string) =>
    api<ThreadSnapshot>(`/threads/detail?id=${encodeURIComponent(id)}`),
  create: (data: NewThread) => post<{ thread: Thread }>("/threads", data),
  send: (
    id: string,
    text: string,
    mode: "send" | "steer" | "queue",
    agent?: AgentRef,
  ) =>
    post<{ item: Item; delivery: string }>("/threads/messages", {
      id,
      text,
      mode,
      ...(agent ? { agent } : {}),
    }),
  interrupt: (id: string) => post("/threads/interrupt", { id }),
  answer: (id: string, requestId: string, answer: RequestAnswer) =>
    post<{ request: UserRequest }>("/threads/answer", {
      id,
      requestId,
      answer,
    }),
  close: (
    id: string,
    mode: "pr" | "merge" | "discard",
    title?: string,
    body?: string,
  ) =>
    post<{ thread: Thread }>("/threads/close", {
      id,
      mode,
      ...(title ? { title } : {}),
      ...(body ? { body } : {}),
    }),
  archive: (id: string) => post<{ thread: Thread }>("/threads/archive", { id }),
  diff: (id: string, turnId?: string) =>
    api<{ files: FileDiff[] }>(
      `/threads/diff?id=${encodeURIComponent(id)}${turnId ? `&turnId=${encodeURIComponent(turnId)}` : ""}`,
    ),
  inbox: () => api<{ entries: InboxEntry[] }>("/inbox"),
  models: () =>
    api<Record<string, { id: string; nombre: string; esfuerzos?: string[] }[]>>(
      "/agents/models",
    ),
  projects: () => api<string[]>("/agents/projects"),
};
