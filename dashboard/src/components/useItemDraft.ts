import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { Item } from "../core/model";
import { db } from "../core/store";
export function useItemDraft(
  draftKey: string,
  item: Item,
  set: Dispatch<SetStateAction<Item>>,
) {
  const [draftReady, setDraftReady] = useState(false);
  const [draftStatus, setDraftStatus] = useState("");
  const savedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void db.meta.get(draftKey).then((draft) => {
      if (cancelled) return;
      if (draft) {
        try {
          set(JSON.parse(draft.value));
          setDraftStatus("Borrador local recuperado.");
        } catch {}
      }
      setDraftReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [draftKey, set]);
  useEffect(() => {
    if (!draftReady || savedRef.current) return;
    const persist = () => {
      if (savedRef.current) return;
      void db.meta
        .put({ key: draftKey, value: JSON.stringify(item) })
        .then(() => setDraftStatus("Borrador guardado en este dispositivo."))
        .catch(() => setDraftStatus("No se pudo guardar el borrador local."));
    };
    const timer = setTimeout(persist, 350);
    return () => {
      clearTimeout(timer);
      persist();
    };
  }, [item, draftReady, draftKey]);
  async function saved() {
    savedRef.current = true;
    await db.meta.delete(draftKey);
  }
  return { draftStatus, saved };
}
