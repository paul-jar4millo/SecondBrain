/**
 * @param {Pick<import("./session-types.d.ts").LauncherSession, "id" | "motor" | "modelo" | "conversacionId">} sesion
 * @param {string} brief
 */
export function remoteCommand(sesion, brief) {
  if (sesion.motor === "claude")
    return {
      bin: "claude",
      args: [
        "--remote-control=SecondBrain",
        ...(sesion.conversacionId
          ? ["--resume", sesion.conversacionId]
          : ["--session-id", sesion.id]),
        "--permission-mode",
        "bypassPermissions",
        ...(sesion.modelo ? ["--model", sesion.modelo] : []),
        "--",
        brief,
      ],
    };
  if (sesion.motor === "agy")
    return {
      bin: "agy",
      args: [
        "--remote-control",
        "--dangerously-skip-permissions",
        ...(sesion.conversacionId
          ? ["--conversation", sesion.conversacionId]
          : []),
        ...(sesion.modelo ? ["--model", sesion.modelo] : []),
      ],
    };
  throw new Error("Motor remoto no disponible");
}
