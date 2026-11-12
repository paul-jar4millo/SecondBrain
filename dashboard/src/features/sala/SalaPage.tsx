import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useUI } from "../../components/ui";
import { api, isDemo } from "../../core/store";
import { montar } from "./sala";
import { teamApi, teamController } from "../team/team-store";
import { today } from "../../core/model";
import { useFinance } from "../finance/useFinance";
import { roomSummary } from "./sala-summary";
import "./sala.css";
import "./agentes-panel.css";

const apiSala = (path: string, body?: unknown) =>
  api(path, body ? { method: "POST", body: JSON.stringify(body) } : undefined);

export default function SalaPage() {
  const { items, notify, openAgent, openTeam } = useUI();
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
    openAgent,
    openTeam,
  });
  latest.current = { items, notify, navigate, summary, openAgent, openTeam };
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
      montar(root.current!, {
        api: isDemo
          ? async (path, body) =>
              (await import("./sala-demo")).apiDemo(path, body)
          : apiSala,
        toast: (message) => latest.current.notify(message),
        team: teamController,
        openAgent: (target) => latest.current.openAgent(target),
        openTeam: (target) => latest.current.openTeam(target),
        datos: () => latest.current.summary,
        irAEspacio: (path) => latest.current.navigate(path),
        aprobaciones: () => teamApi("/aprobaciones"),
      }),
    [],
  );
  return <div ref={root} className="sala" />;
}
