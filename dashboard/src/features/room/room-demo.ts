import { demoReferences as banco } from "./demo-references";
import { demoAgentsApi } from "./room-agents-demo";
const demoKey = "sb-refugio-orders-v1";
const boardKey = "sb-refugio-board-v1";
export async function apiDemo(path: string, body?: unknown) {
  const orders = JSON.parse(localStorage.getItem(demoKey) || "{}");
  const boards = JSON.parse(localStorage.getItem(boardKey) || "{}");
  if (path.startsWith("/agentes")) return demoAgentsApi(path, body);
  // One synthetic request waiting for the owner's OK, so the bubble can be seen.
  if (path === "/aprobaciones")
    return [
      {
        id: "demo-aprobacion",
        actor: "agente:menta",
        estado: "pendiente",
        vence: Date.now() + 1800000,
        operacion: { op: "charge", amount: "10.00", desc: "Ejemplo" },
      },
    ];
  if (path.startsWith("/sala?")) {
    const project =
      new URLSearchParams(path.split("?")[1]).get("espacio") || "general";
    return { ...banco, tablero: boards[project] || [], encargos: orders };
  }
  if (path === "/sala/encargos") {
    const order = body as { id: string };
    orders[order.id] = order;
    localStorage.setItem(demoKey, JSON.stringify(orders));
    return order;
  }
  if (path === "/sala/tablero") {
    const {
      id,
      guardar,
      espacio = "general",
    } = body as { id: string; guardar: boolean; espacio: string };
    const board: string[] = boards[espacio] || [];
    boards[espacio] = guardar
      ? [...new Set([id, ...board])]
      : board.filter((x) => x !== id);
    localStorage.setItem(boardKey, JSON.stringify(boards));
    return boards[espacio];
  }
  throw new Error("Acción no disponible en la demo.");
}
