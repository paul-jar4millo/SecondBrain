import { useRef, useState } from "react";
import { Copy } from "lucide-react";
import { Modal, useUI } from "../../components/ui";

/** Prepares a prompt for an external agent; it never runs one by itself. */
export function AgentHandoff({
  prompt,
  onClose,
}: {
  prompt: string;
  onClose: () => void;
}) {
  const { notify } = useUI();
  const [text, setText] = useState(prompt);
  const field = useRef<HTMLTextAreaElement>(null);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // The Clipboard API needs HTTPS; plain-HTTP LAN access falls back here.
      field.current?.select();
      if (!document.execCommand("copy")) {
        notify("No se pudo copiar. Selecciona el texto y cópialo a mano.");
        return;
      }
    }
    notify("Encargo copiado. Pégalo en Claude Code o Codex.");
    onClose();
  }
  return (
    <Modal title="Pedir a un agente" onClose={onClose}>
      <p className="muted handoff-help">
        Copia este encargo y pégalo en Claude Code o Codex. Ese agente entra a
        tu vault y hace el trabajo; esta app no lo ejecuta por sí sola.
      </p>
      <textarea
        ref={field}
        className="handoff-text"
        aria-label="Encargo para el agente"
        rows={11}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="handoff-actions">
        <button className="button subtle" onClick={onClose}>
          Cancelar
        </button>
        <button
          className="button primary"
          disabled={!text.trim()}
          onClick={() => void copy()}
        >
          <Copy size={16} />
          Copiar encargo
        </button>
      </div>
    </Modal>
  );
}
