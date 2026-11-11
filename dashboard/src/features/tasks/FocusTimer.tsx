import { useEffect, useRef, useState } from "react";
import { Pause, Play, RotateCcw } from "lucide-react";
import { useUI } from "../../components/ui";
import { Waves, splash } from "../../components/Alive";

const FOCUS_SECONDS = 25 * 60;
const FOCUS_KEY = "sb-focus-deadline";
const PAUSED_KEY = "sb-focus-paused";
const savedDeadline = () => {
  const value = Number(sessionStorage.getItem(FOCUS_KEY));
  return value > Date.now() ? value : null;
};
const savedPaused = () => {
  const raw = sessionStorage.getItem(PAUSED_KEY);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 && value < FOCUS_SECONDS
    ? value
    : null;
};
export function FocusTimer() {
  const { notify } = useUI();
  const box = useRef<HTMLDivElement>(null);
  // The deadline outlives this component so a route change keeps the session.
  const [deadline, setDeadline] = useState(savedDeadline);
  const [seconds, setSeconds] = useState(() => {
    const saved = savedDeadline();
    if (saved) return Math.ceil((saved - Date.now()) / 1000);
    return savedPaused() ?? FOCUS_SECONDS;
  });
  useEffect(() => {
    if (!deadline) return;
    const interval = setInterval(() => {
      const remain = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setSeconds(remain);
      if (remain) return;
      setDeadline(null);
      sessionStorage.removeItem(FOCUS_KEY);
      sessionStorage.removeItem(PAUSED_KEY);
      notify("Terminó tu bloque de enfoque.");
      if (box.current) splash(box.current, 16);
    }, 1000);
    return () => clearInterval(interval);
  }, [deadline, notify]);
  const start = () => {
    const next = Date.now() + (seconds || FOCUS_SECONDS) * 1000;
    if (!seconds) setSeconds(FOCUS_SECONDS);
    sessionStorage.removeItem(PAUSED_KEY);
    sessionStorage.setItem(FOCUS_KEY, String(next));
    setDeadline(next);
  };
  const stop = () => {
    sessionStorage.removeItem(FOCUS_KEY);
    sessionStorage.setItem(PAUSED_KEY, String(seconds));
    setDeadline(null);
  };
  const reset = () => {
    sessionStorage.removeItem(FOCUS_KEY);
    sessionStorage.removeItem(PAUSED_KEY);
    setDeadline(null);
    setSeconds(FOCUS_SECONDS);
  };
  return (
    <div className={"focus-timer" + (deadline ? " running" : "")} ref={box}>
      <div
        className="focus-water"
        aria-hidden="true"
        style={
          {
            "--fill": (1 - seconds / FOCUS_SECONDS) * 100 + "%",
          } as React.CSSProperties
        }
      >
        <Waves />
      </div>
      <div>
        <span>Enfoque</span>
        <strong>
          {Math.floor(seconds / 60)
            .toString()
            .padStart(2, "0")}
          <span>:</span>
          {(seconds % 60).toString().padStart(2, "0")}
        </strong>
      </div>
      <button
        className="icon-button"
        aria-label={deadline ? "Pausar enfoque" : "Iniciar enfoque"}
        onClick={deadline ? stop : start}
      >
        {deadline ? <Pause size={17} /> : <Play size={17} />}
      </button>
      <button
        className="icon-button"
        aria-label="Reiniciar enfoque"
        onClick={reset}
      >
        <RotateCcw size={15} />
      </button>
    </div>
  );
}
