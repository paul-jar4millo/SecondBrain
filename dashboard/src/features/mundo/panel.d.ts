export function montarPanel(
  raiz: HTMLElement,
  opciones: {
    api: (path: string, body?: unknown) => Promise<unknown>;
    confirm?: (
      message: string,
      options?: { confirmLabel?: string; danger?: boolean },
    ) => Promise<boolean>;
  },
): () => void;
