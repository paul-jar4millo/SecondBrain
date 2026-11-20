import { useEffect, useRef, useState, type FormEvent } from "react";
import { ImagePlus, X } from "lucide-react";
import { Modal, useUI } from "../../components/ui";
import { dateLabel, money, today } from "../../core/model";
import { financeUpdatePrompt } from "../../core/agent-prompt";
import { uploadForAgents, type UploadedFile } from "../files/upload";
import { preference, setPreference } from "../settings/preferences";
import { characters } from "../agents/characters";
import { AgentPortrait } from "../agents/TeamPrimitives";
import type { FinanceOverview } from "./useFinance";

// iOS converts HEIC to JPEG when the picker does not accept HEIC.
const ACCEPT = "image/png,image/jpeg,image/webp,application/pdf";
const CAPTURE_PATTERN = /\.(png|jpe?g|webp|pdf)$/i;

interface Capture {
  key: string;
  file: File;
  preview?: string;
  uploaded?: UploadedFile;
}

/**
 * Leaves the bank captures in the Maletín, saves the balances the owner typed and
 * opens the chosen agent with the message ready. No model starts until he sends it.
 */
export function UpdateWithAgent({
  data,
  run,
  hidden,
  onClose,
}: {
  data: FinanceOverview;
  run: (op: Record<string, unknown>) => Promise<unknown>;
  hidden: boolean;
  onClose: () => void;
}) {
  const { openThread } = useUI();
  const cards = data.cards || [];
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [balances, setBalances] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [agentId, setAgentId] = useState(() => preference("financeAgent"));
  const [over, setOver] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const latest = useRef(captures);
  latest.current = captures;
  useEffect(
    () => () =>
      latest.current.forEach(
        (c) => c.preview && URL.revokeObjectURL(c.preview),
      ),
    [],
  );
  const agent = characters.find((a) => a.id === agentId) || characters[0];
  const typed = cards.filter((c) => balances[c.id]?.trim());
  const busy = Boolean(progress);

  function add(files: File[]) {
    const valid = files.filter((f) => CAPTURE_PATTERN.test(f.name));
    setError(
      valid.length < files.length
        ? "Solo se admiten imágenes PNG, JPG o WebP y archivos PDF."
        : "",
    );
    setCaptures((current) => [
      ...current,
      ...valid.map((file) => ({
        key: crypto.randomUUID(),
        file,
        preview: file.type.startsWith("image/")
          ? URL.createObjectURL(file)
          : undefined,
      })),
    ]);
  }
  function drop(key: string) {
    setCaptures((current) => {
      const target = current.find((c) => c.key === key);
      if (target?.preview) URL.revokeObjectURL(target.preview);
      return current.filter((c) => c.key !== key);
    });
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || (!captures.length && !typed.length)) return;
    setError("");
    const day = today();
    try {
      for (const card of typed) {
        setProgress(`Guardando el saldo de ${card.name}…`);
        await run({
          op: "card-set",
          card: card.id,
          balance: balances[card.id],
        });
      }
      // A retry after a failure skips what already reached the Maletín.
      const done: Capture[] = [];
      for (const [index, capture] of captures.entries()) {
        setProgress(`Subiendo ${index + 1} de ${captures.length}…`);
        done.push(
          capture.uploaded
            ? capture
            : {
                ...capture,
                uploaded: await uploadForAgents(
                  capture.file,
                  `Finanzas · actualización ${day}`,
                ),
              },
        );
        setCaptures((current) =>
          current.map((c) => done.find((d) => d.key === c.key) || c),
        );
      }
      setPreference("financeAgent", agent.id);
      if (!captures.length) {
        onClose();
        return;
      }
      const brief = financeUpdatePrompt({
        day,
        files: done.map((c) => c.uploaded!),
        balances: typed.map((c) => ({
          card: c.name,
          amount: balances[c.id].trim(),
        })),
        note,
      });
      onClose();
      openThread({ engine: agent.engine, prompt: brief });
    } catch (x) {
      setError((x as Error).message);
    } finally {
      setProgress("");
    }
  }
  return (
    <Modal
      title="Actualizar con una agente"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form className="agent-update" onSubmit={(e) => void submit(e)}>
        <section>
          <h3>Capturas del banco</h3>
          <p className="form-hint">
            Estados de cuenta, movimientos o capturas de la app. Se guardan en
            el Maletín para que la agente las lea.
          </p>
          <div
            className={"agent-update-drop" + (over ? " over" : "")}
            tabIndex={-1}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              add(Array.from(e.dataTransfer.files));
            }}
            onPaste={(e) => {
              if (e.clipboardData.files.length)
                add(Array.from(e.clipboardData.files));
            }}
          >
            {captures.length > 0 && (
              <ul>
                {captures.map((c) => (
                  <li key={c.key}>
                    {c.preview ? (
                      <img src={c.preview} alt="" />
                    ) : (
                      <span className="agent-update-file">PDF</span>
                    )}
                    <small>{c.file.name}</small>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Quitar ${c.file.name}`}
                      disabled={busy}
                      onClick={() => drop(c.key)}
                    >
                      <X size={16} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => input.current?.click()}
            >
              <ImagePlus size={16} aria-hidden="true" />
              {captures.length ? "Añadir más" : "Elegir fotos"}
            </button>
            <span className="muted">o arrástralas y pégalas aquí</span>
            <input
              ref={input}
              type="file"
              multiple
              hidden
              accept={ACCEPT}
              aria-label="Elegir capturas del banco"
              onChange={(e) => {
                add(Array.from(e.target.files || []));
                e.target.value = "";
              }}
            />
          </div>
        </section>
        <section>
          <h3>Saldo actual de tus tarjetas</h3>
          <p className="form-hint">
            Opcional. Lo que escribas se guarda como verificado hoy; deja vacío
            lo que no cambió.
          </p>
          <div className="agent-update-balances">
            {cards.map((c) => (
              <label key={c.id}>
                <span>
                  {c.name}
                  <small>
                    {hidden ? "Registrado oculto" : money(c.balanceMinor)}
                    {c.asOf ? ` · al ${dateLabel(c.asOf)}` : ""}
                  </small>
                </span>
                <input
                  inputMode="decimal"
                  placeholder="Sin cambios"
                  value={balances[c.id] || ""}
                  disabled={busy}
                  onChange={(e) =>
                    setBalances((current) => ({
                      ...current,
                      [c.id]: e.target.value,
                    }))
                  }
                />
              </label>
            ))}
          </div>
        </section>
        {captures.length > 0 && (
          <>
            <section>
              <h3>¿Quién lo revisa?</h3>
              <div
                className="agent-update-agents"
                role="radiogroup"
                aria-label="Agente que revisa las capturas"
              >
                {characters.map((a) => (
                  <label
                    key={a.id}
                    className={a.id === agent.id ? "active" : ""}
                  >
                    <input
                      type="radio"
                      name="finance-agent"
                      className="sr-only"
                      checked={a.id === agent.id}
                      onChange={() => setAgentId(a.id)}
                    />
                    <AgentPortrait id={a.id} />
                    <span>{a.name}</span>
                  </label>
                ))}
              </div>
              {agent.id === "marina" && (
                <p className="form-hint">
                  Marina usa la API de DeepSeek y consume su saldo.
                </p>
              )}
            </section>
            <label className="field">
              Indicaciones (opcional)
              <textarea
                rows={2}
                maxLength={1000}
                value={note}
                disabled={busy}
                onChange={(e) => setNote(e.target.value)}
                placeholder="El pago de la tarjeta ya salió ayer…"
              />
            </label>
            <p className="form-hint">
              Abrirás a {agent.name} con el mensaje listo y lo revisas antes de
              enviarlo. Antes de escribir en tus finanzas te pedirá aprobación
              en Finanzas.
            </p>
          </>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          {progress && <span role="status">{progress}</span>}
          <span className="spacer" />
          <button
            type="button"
            className="button subtle"
            disabled={busy}
            onClick={onClose}
          >
            Cancelar
          </button>
          <button
            className="button primary"
            disabled={busy || (!captures.length && !typed.length)}
          >
            {captures.length || !typed.length
              ? `Subir y pasar con ${agent.name}`
              : "Guardar saldos"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
