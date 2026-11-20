import { ArrowUpRight, Bell, TriangleAlert } from "lucide-react";
import { Modal, useUI } from "../components/ui";
import { save } from "../core/store";
import type { Item } from "../core/model";
import type { BackupAlert } from "../core/maintenance";
import { getLang, t } from "../core/i18n";
function BackupNotice({ alert }: { alert: BackupAlert }) {
  const when = alert.lastSuccess
    ? t("backup.lastSuccess", {
        date: new Date(alert.lastSuccess).toLocaleString(getLang(), {
          dateStyle: "medium",
          timeStyle: "short",
        }),
      })
    : t("backup.noSuccess");
  return (
    <div className="unread system-notice" role="alert">
      <TriangleAlert size={17} />
      <span>
        <strong>{t(`backup.${alert.status}`)}</strong>
        <small>
          {when} {t("backup.hint")}
        </small>
      </span>
    </div>
  );
}
export function RemindersDialog({
  reminders,
  backup = null,
  onClose,
}: {
  reminders: Item[];
  backup?: BackupAlert | null;
  onClose: () => void;
}) {
  const { items, notify, edit } = useUI();
  return (
    <Modal title="Recordatorios" onClose={onClose}>
      <p className="muted">
        Avisos dentro de la app. No son una alarma garantizada: requieren que el
        servidor esté en funcionamiento. Para compromisos críticos, exporta tu
        agenda al calendario del dispositivo.
      </p>
      <div className="notification-list">
        {backup && <BackupNotice alert={backup} />}
        {reminders.map((n) => {
          const source = items.find((x) => x.id === n.source && !x.deleted);
          return (
            <button
              key={n.id}
              className={n.status === "unread" ? "unread" : ""}
              onClick={() => {
                void save({ ...n, status: "read" }).catch((e) =>
                  notify(e.message),
                );
                onClose();
                if (source && source.kind !== "note") edit(source);
              }}
            >
              <Bell size={17} />
              <span>
                <strong>{n.title}</strong>
                <small>{n.body}</small>
              </span>
              {source && source.kind !== "note" && <ArrowUpRight size={15} />}
            </button>
          );
        })}
        {!reminders.length && !backup && (
          <p className="muted notification-empty">
            No hay recordatorios pendientes.
          </p>
        )}
      </div>
    </Modal>
  );
}
