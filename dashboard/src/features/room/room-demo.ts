import { demoReferences as banco } from "./demo-references";
const demoKey = "sb-refugio-orders-v1";
const boardKey = "sb-refugio-board-v1";
export async function apiDemo(path: string, body?: unknown) {
  const orders = JSON.parse(localStorage.getItem(demoKey) || "{}");
  const boards = JSON.parse(localStorage.getItem(boardKey) || "{}");
  // One synthetic request waiting for the owner's OK, so the bubble can be seen.
  if (path === "/approvals")
    return [
      {
        id: "demo-aprobacion",
        actor: "agente:menta",
        estado: "pendiente",
        vence: Date.now() + 1800000,
        operacion: { op: "charge", amount: "10.00", desc: "Ejemplo" },
      },
    ];
  if (path.startsWith("/room?")) {
    const project =
      new URLSearchParams(path.split("?")[1]).get("espacio") || "general";
    return { ...banco, tablero: boards[project] || [], encargos: orders };
  }
  if (path === "/room/work-orders") {
    const order = body as { id: string };
    orders[order.id] = order;
    localStorage.setItem(demoKey, JSON.stringify(orders));
    return order;
  }
  if (path === "/room/board") {
    const {
      id,
      guardar: save,
      espacio: space = "general",
    } = body as { id: string; guardar: boolean; espacio: string };
    const board: string[] = boards[space] || [];
    boards[space] = save
      ? [...new Set([id, ...board])]
      : board.filter((x) => x !== id);
    localStorage.setItem(boardKey, JSON.stringify(boards));
    return boards[space];
  }
  throw new Error("Acción no disponible en la demo.");
}
