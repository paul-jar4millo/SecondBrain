import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useUI } from "../../components/ui";
import { api, isDemo } from "../../core/store";
import { mount } from "./room";
import { agentApi } from "../agents/agent-api";
import { threadProjection } from "../threads/thread-projection";
import { today } from "../../core/model";
import { useFinance } from "../finance/useFinance";
import { roomSummary } from "./room-summary";
import "./room.css";

const apiRoom = (path: string, body?: unknown) =>
  api(path, body ? { method: "POST", body: JSON.stringify(body) } : undefined);

export default function RoomPage() {
  const { items, notify, openThread } = useUI();
  const { data: finance, error: financeError } = useFinance();
  const [hidden, setHidden] = useState(
    () => localStorage.getItem("sb-hide-money") === "true",
  );
  const [day, setDay] = useState(today);
  const summary = useMemo(
    () => roomSummary(items, day, { hidden, finance, financeError }),
    [items, day, hidden, finance, financeError],
  );
  const root = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const latest = useRef({
    items,
    notify,
    navigate,
    summary,
    openThread,
  });
  latest.current = { items, notify, navigate, summary, openThread };
  useEffect(() => {
    const refresh = () => {
      setHidden(localStorage.getItem("sb-hide-money") === "true");
      setDay(today());
    };
    const clock = setInterval(refresh, 30000);
    window.addEventListener("storage", refresh);
    window.addEventListener("sb-money-visibility", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(clock);
      window.removeEventListener("storage", refresh);
      window.removeEventListener("sb-money-visibility", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  useEffect(() => {
    root.current?.dispatchEvent(
      new CustomEvent("room-data", { detail: summary }),
    );
  }, [summary]);
  useEffect(
    () =>
      mount(root.current!, {
        api: isDemo
          ? async (path, body) =>
              (await import("./room-demo")).apiDemo(path, body)
          : apiRoom,
        toast: (message) => latest.current.notify(message),
        threads: threadProjection,
        openThread: (target) => latest.current.openThread(target),
        datos: () => latest.current.summary,
        irAEspacio: (path) => latest.current.navigate(path),
        aprobaciones: () => agentApi("/aprobaciones"),
      }),
    [],
  );
  return <div ref={root} className="sala" />;
}
