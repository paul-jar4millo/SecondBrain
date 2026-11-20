export function thumbAxis(dx, dy, radius) {
  const length = Math.hypot(dx, dy);
  if (!Number.isFinite(length) || radius <= 0 || length <= radius * 0.16)
    return { x: 0, y: 0 };
  const strength = Math.min(1, (length / radius - 0.16) / 0.84);
  return { x: (dx / length) * strength, y: (dy / length) * strength };
}
export const advanceTour = (step, event) =>
  ["walk", "zone", "open"][step] === event ? step + 1 : step;
export const waitingFlow = (flows, agentId) =>
  flows.find(
    (flow) =>
      ["esperando", "en-cola"].includes(flow.estado) &&
      flow.pasos[flow.indice]?.agente === agentId,
  );
export function observedCompletions(previous, next) {
  if (!previous?.conectado || !next?.conectado) return [];
  return next.agentes
    .filter((a) => {
      const before = previous.agentes.find((p) => p.id === a.id)?.ultimo;
      return (
        before &&
        a.ultimo?.jobId &&
        a.ultimo.estado === "listo" &&
        (before.jobId !== a.ultimo.jobId || before.estado !== "listo")
      );
    })
    .map((a) => a.id);
}

// Audio is opt-in, created lazily inside a user gesture; no assets or network.
export function createRoomSound(volume = 0) {
  volume = Math.max(0, Math.min(1, Number(volume) || 0));
  let context;
  return {
    volume(value) {
      volume = Math.max(0, Math.min(1, Number(value) || 0));
    },
    play(level = "move") {
      if (!volume) return;
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (!Audio) return;
      try {
        context ||= new Audio();
        // A server event never resumes suspended audio without a user gesture.
        if (context.state === "suspended") {
          if (level === "complete") return;
          void context.resume().catch(() => {});
        }
        const tones =
          level === "complete"
            ? [523.25, 659.25, 783.99]
            : level === "open"
              ? [392, 523.25]
              : [294];
        tones.forEach((frequency, i) => {
          const start = context.currentTime + i * 0.09;
          const oscillator = context.createOscillator(),
            gain = context.createGain();
          oscillator.type = "sine";
          oscillator.frequency.value = frequency;
          gain.gain.setValueAtTime(0, start);
          gain.gain.linearRampToValueAtTime(volume * 0.07, start + 0.012);
          gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
          oscillator.connect(gain).connect(context.destination);
          oscillator.start(start);
          oscillator.stop(start + 0.2);
          oscillator.onended = () => {
            oscillator.disconnect();
            gain.disconnect();
          };
        });
      } catch {
        /* Unsupported audio leaves the visual response intact. */
      }
    },
    dispose() {
      void context?.close().catch(() => {});
    },
  };
}
