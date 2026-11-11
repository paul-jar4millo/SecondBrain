import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Modal } from "./ui";

interface Options {
  title?: string;
  confirmLabel?: string;
  danger?: boolean;
}
interface Request extends Options {
  message: string;
  opener: HTMLElement | null;
  resolve: (accepted: boolean) => void;
}

function Confirmation({
  request,
  finish,
}: {
  request: Request;
  finish: (accepted: boolean) => void;
}) {
  useEffect(
    () => () => {
      queueMicrotask(() => {
        if (request.opener?.isConnected) request.opener.focus();
      });
    },
    [request],
  );
  return createPortal(
    <Modal
      title={request.title || "Confirmar acción"}
      onClose={() => finish(false)}
    >
      <p>{request.message}</p>
      <div className="modal-actions">
        <button
          type="button"
          className="button"
          autoFocus
          onClick={() => finish(false)}
        >
          Cancelar
        </button>
        <button
          type="button"
          className={`button ${request.danger ? "danger" : "primary"}`}
          onClick={() => finish(true)}
        >
          {request.confirmLabel || "Confirmar"}
        </button>
      </div>
    </Modal>,
    document.body,
  );
}

/** One pending decision per owner; leaving the screen always cancels it. */
export function useConfirmation() {
  const active = useRef(true);
  const pending = useRef<Request | null>(null);
  const [request, setRequest] = useState<Request | null>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      pending.current?.resolve(false);
      pending.current = null;
    };
  }, []);
  const confirm = useCallback(
    (message: string, options: Options = {}): Promise<boolean> => {
      if (!active.current || pending.current) return Promise.resolve(false);
      return new Promise((resolve) => {
        const next = {
          ...options,
          message,
          opener:
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null,
          resolve,
        };
        pending.current = next;
        setRequest(next);
      });
    },
    [],
  );
  const finish = (accepted: boolean) => {
    const current = pending.current;
    pending.current = null;
    setRequest(null);
    current?.resolve(accepted);
  };
  return {
    confirm,
    confirmation: request ? (
      <Confirmation request={request} finish={finish} />
    ) : null,
  };
}
