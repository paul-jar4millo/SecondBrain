import { useCallback, useEffect, useState } from "react";
import { api, isDemo } from "../../core/store";
import { useUI } from "../../components/ui";

interface Cliente {
  id: string;
  nombre: string;
  creado: string;
}

/** Remote MCP connections (claude.ai, phone, Claude Desktop), revocable one by one. */
export function McpClients() {
  const { notify } = useUI();
  const [clientes, setClientes] = useState<Cliente[] | null>(null);
  const cargar = useCallback(async () => {
    try {
      setClientes(await api<Cliente[]>("/oauth/clientes"));
    } catch {
      setClientes([]);
    }
  }, []);
  useEffect(() => {
    if (!isDemo) void cargar();
  }, [cargar]);
  if (isDemo) return null;
  return (
    <div className="setting-row">
      <div>
        <h3>Conexiones MCP remotas</h3>
        <p>
          Agrega <code>{location.origin}/mcp</code> como conector personalizado
          en claude.ai. Cada conexión se puede revocar.
        </p>
        {clientes?.length === 0 && <p>Sin conexiones.</p>}
        <ul>
          {clientes?.map((c) => (
            <li key={c.id}>
              {c.nombre} · {c.creado.slice(0, 10)}{" "}
              <button
                className="button"
                onClick={async () => {
                  try {
                    await api("/oauth/clientes/revocar", {
                      method: "POST",
                      body: JSON.stringify({ id: c.id }),
                    });
                    notify("Conexión revocada.");
                    await cargar();
                  } catch (error) {
                    notify((error as Error).message);
                  }
                }}
              >
                Revocar
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
