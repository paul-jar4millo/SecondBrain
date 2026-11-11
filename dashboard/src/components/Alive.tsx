import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { onOwnerNameChange, ownerName } from "../core/store";
import { getLang, t } from "../core/i18n";

const reducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const BUBBLES = [
  { x: 6, size: 14, duration: 11, delay: 0 },
  { x: 17, size: 8, duration: 8, delay: 3 },
  { x: 29, size: 20, duration: 13, delay: 5 },
  { x: 41, size: 10, duration: 9, delay: 1 },
  { x: 55, size: 16, duration: 12, delay: 7 },
  { x: 68, size: 9, duration: 10, delay: 2 },
  { x: 82, size: 18, duration: 14, delay: 4 },
  { x: 93, size: 11, duration: 9, delay: 6 },
];
const STARS = [
  { x: 36, y: 18, size: 22, delay: 0 },
  { x: 8, y: 66, size: 14, delay: 1.4 },
  { x: 47, y: 62, size: 16, delay: 2.6 },
];

/** Decorative bubbles and stars; the parent must be positioned. */
export function Ambient({ bubbles = 8 }: { bubbles?: number }) {
  return (
    <div className="ambient" aria-hidden="true">
      {BUBBLES.slice(0, bubbles).map((b) => (
        <i
          key={b.x}
          className="bubble"
          style={
            {
              "--x": b.x + "%",
              "--size": b.size + "px",
              "--duration": b.duration + "s",
              "--delay": -b.delay + "s",
            } as React.CSSProperties
          }
        />
      ))}
      {STARS.map((s) => (
        <i
          key={s.x}
          className="twinkle"
          style={
            {
              "--x": s.x + "%",
              "--y": s.y + "%",
              "--size": s.size + "px",
              "--delay": s.delay + "s",
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}

/** Two looping wave layers that give a panel a water edge. */
export function Waves() {
  const path =
    "M0 22C100 2 200 2 300 22S500 42 600 22 800 2 900 22s200 20 300 0V60H0Z";
  return (
    <div className="waves" aria-hidden="true">
      <svg viewBox="0 0 1200 60" preserveAspectRatio="none">
        <path d={path} />
      </svg>
      <svg viewBox="0 0 1200 60" preserveAspectRatio="none">
        <path d={path} />
      </svg>
    </div>
  );
}

/** Moves the element's --px/--py with the pointer, for hover parallax. */
export function useParallax<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const node = ref.current;
    if (
      !node ||
      reducedMotion() ||
      !window.matchMedia("(hover: hover)").matches
    )
      return;
    let frame = 0;
    const move = (e: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const box = node.getBoundingClientRect();
        node.style.setProperty(
          "--px",
          ((e.clientX - box.left) / box.width - 0.5).toFixed(3),
        );
        node.style.setProperty(
          "--py",
          ((e.clientY - box.top) / box.height - 0.5).toFixed(3),
        );
      });
    };
    const leave = () => {
      cancelAnimationFrame(frame);
      node.style.setProperty("--px", "0");
      node.style.setProperty("--py", "0");
    };
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerleave", leave);
    return () => {
      cancelAnimationFrame(frame);
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerleave", leave);
    };
  }, []);
  return ref;
}

/** Droplet burst from an element: the reward for finishing something. */
export function splash(origin: Element, count = 10) {
  if (reducedMotion()) return;
  const box = origin.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  for (let i = 0; i < count; i++) {
    const drop = document.createElement("i");
    drop.className = i % 3 ? "splash-drop" : "splash-drop star";
    drop.style.left = x + "px";
    drop.style.top = y + "px";
    document.body.append(drop);
    const angle = (i / count) * Math.PI * 2 + Math.random() * 0.5;
    const reach = 26 + Math.random() * 34;
    drop
      .animate(
        [
          { transform: "translate(-50%, -50%) scale(0.4)", opacity: 1 },
          {
            transform: `translate(calc(-50% + ${Math.cos(angle) * reach}px), calc(-50% + ${Math.sin(angle) * reach + 14}px)) scale(1) rotate(120deg)`,
            opacity: 0,
          },
        ],
        {
          duration: 520 + Math.random() * 240,
          easing: "cubic-bezier(0.16, 1, 0.3, 1)",
        },
      )
      .finished.finally(() => drop.remove());
  }
}

const greeting = (hour: number) =>
  hour < 6
    ? t("greeting.night")
    : hour < 12
      ? t("greeting.morning")
      : hour < 19
        ? t("greeting.afternoon")
        : t("greeting.night");

export function Greeting() {
  const [now, setNow] = useState(() => new Date());
  const owner = useSyncExternalStore(onOwnerNameChange, () => ownerName);
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <p className="greeting">
      <strong>
        {greeting(now.getHours())}
        {owner ? `, ${owner}` : ""}
      </strong>
      <time dateTime={now.toISOString()}>
        {now.toLocaleTimeString(getLang() === "en" ? "en-US" : "es-MX", {
          hour: "2-digit",
          minute: "2-digit",
        })}
      </time>
    </p>
  );
}
