// Replays a team's recorded handoffs one by one over the scene.
import type { Relay } from "./room-types";
import type { TeamEvent } from "../team/team-controller";

export function createRelayReplay(
  root: HTMLElement,
  {
    isAlive,
    playRelay,
    onStart,
    onStop,
  }: {
    isAlive: () => boolean;
    playRelay: (relay: Relay, replay: boolean) => void;
    /** Brings the refuge to the front. */
    onStart: () => void;
    /** Stops the relay animation and returns to the team flows. */
    onStop: () => void;
  },
) {
  const q = (selector: string) => root.querySelector<HTMLElement>(selector)!;
  let timer: ReturnType<typeof setTimeout>;
  const replay = (event: Event) => {
    clearTimeout(timer);
    onStart();
    const events = (event as CustomEvent<{ events: TeamEvent[] }>).detail
      .events;
    let index = 0;
    q(".equipo-replay").hidden = false;
    const next = () => {
      if (!isAlive()) return;
      if (index >= events.length) {
        q("#team-replay-status").textContent = "Repetición terminada";
        return;
      }
      const e = events[index++];
      playRelay(
        {
          id: e.id || "replay",
          tipo: "relevo",
          de: e.de || "",
          para: e.para || "",
          texto: e.texto || "",
        },
        true,
      );
      q("#team-replay-status").textContent =
        `Reproduciendo ${index}/${events.length}: ${e.texto}`;
      timer = setTimeout(next, 4500);
    };
    q("#team-replay-stop").onclick = () => {
      clearTimeout(timer);
      q(".equipo-replay").hidden = true;
      onStop();
    };
    next();
    q("#team-replay-stop").focus();
  };
  addEventListener("sb-team-replay", replay);
  return () => {
    clearTimeout(timer);
    removeEventListener("sb-team-replay", replay);
  };
}
