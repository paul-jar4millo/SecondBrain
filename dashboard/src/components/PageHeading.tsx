import { createContext, useContext } from "react";
import { createPortal } from "react-dom";
import { Plus } from "lucide-react";

/** Nodes in the top stage where each page places its title and actions. */
export const HeadingSlots = createContext<{
  title: HTMLElement | null;
  actions: HTMLElement | null;
  fab: HTMLElement | null;
}>({ title: null, actions: null, fab: null });

/** The tool's one creation action, pinned to the corner of the tool dialog. */
export function ToolFab({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  const { fab } = useContext(HeadingSlots);
  return fab
    ? createPortal(
        <button className="button primary tool-fab" onClick={onClick}>
          <Plus size={18} aria-hidden="true" />
          {label}
        </button>,
        fab,
      )
    : null;
}

export function PageHeading({
  title,
  description,
  note,
  action,
}: {
  title: string;
  description?: string;
  note?: React.ReactNode;
  action?: React.ReactNode;
}) {
  const slots = useContext(HeadingSlots);
  return (
    <>
      {slots.title &&
        createPortal(
          <div className={"page-heading" + (note ? " has-note" : "")}>
            <h1>{title}</h1>
            {description && <p>{description}</p>}
            {note}
          </div>,
          slots.title,
        )}
      {slots.actions && action && createPortal(action, slots.actions)}
    </>
  );
}
