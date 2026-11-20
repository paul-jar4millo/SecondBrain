import { throttled } from "../core/throttle";
import { t } from "../core/i18n";
import { RemindersDialog } from "./RemindersDialog";
import { visibleReminders } from "../core/reminders";
import { fetchBackupAlert, type BackupAlert } from "../core/maintenance";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useRef,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { NavLink, Link, useLocation, useNavigate } from "react-router-dom";
import { X, LoaderCircle } from "lucide-react";
import { type Item, type Kind } from "../core/model";
import {
  UI,
  ItemEditor,
  SearchDialog,
  TransactionDetail,
  Modal,
} from "../components/ui";
import {
  subscribe,
  getSnapshot,
  init,
  isDemo,
  remove,
  save,
  db,
  sync,
} from "../core/store";
import { HeadingSlots } from "../components/PageHeading";
import { HudGlyph, HudMoon, type GlyphName } from "../components/HudGlyph";
import { AgentHandoff } from "../features/assist/AgentHandoff";
import { PromptBar } from "../features/assist/PromptBar";
import { preference } from "../features/settings/preferences";
import type { ThreadTarget } from "../features/threads/thread-target";
const NewThreadDialog = lazy(() =>
  import("../features/threads/dialogs").then((m) => ({
    default: m.NewThreadDialog,
  })),
);
const ToolRoutes = lazy(() => import("./ToolRoutes"));
const RoomPage = lazy(() => import("../features/room/RoomPage"));
const shortcutLabel = /Mac|iPhone|iPad/.test(navigator.platform)
  ? "⌘ K"
  : "Ctrl K";
export function Workspace() {
  const state = useSyncExternalStore(subscribe, getSnapshot);
  const [editing, setEditing] = useState<Item | Kind | null>(null);
  const [search, setSearch] = useState(false);
  const [notifications, setNotifications] = useState(false);
  const [composing, setComposing] = useState(false);
  const [handoff, setHandoff] = useState<string | null>(null);
  const [toast, setToast] = useState<{
    message: string;
    undo?: () => void;
  } | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [backup, setBackup] = useState<BackupAlert | null>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const [threadDraft, setThreadDraft] = useState<ThreadTarget | null>(null);
  const openThread = useCallback(
    (target?: ThreadTarget) => {
      if (!target || target.id)
        navigate(target?.id ? "/threads/" + target.id : "/threads");
      else setThreadDraft(target);
    },
    [navigate],
  );
  const inRoom = ["/", "/sala"].includes(location.pathname);
  const [titleSlot, setTitleSlot] = useState<HTMLElement | null>(null);
  const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null);
  const [fabSlot, setFabSlot] = useState<HTMLElement | null>(null);
  const slots = useMemo(
    () => ({ title: titleSlot, actions: actionsSlot, fab: fabSlot }),
    [titleSlot, actionsSlot, fabSlot],
  );
  // Only the first load honours the preference; the HUD can still reach the room.
  const startView = useRef(
    location.pathname === "/" ? preference("startView") : "/",
  );
  useEffect(() => {
    if (startView.current !== "/")
      navigate(startView.current, { replace: true });
  }, [navigate]);
  const notify = useCallback((message: string) => setToast({ message }), []);
  useEffect(() => {
    // The off-host backup runs on another machine; a failure there is only
    // noticed if the app shows it.
    if (isDemo) return;
    let active = true;
    const check = throttled(() => {
      if (document.hidden) return;
      void fetchBackupAlert().then((alert) => active && setBackup(alert));
    }, 60_000);
    const tick = setInterval(check, 30 * 60_000);
    document.addEventListener("visibilitychange", check);
    check();
    return () => {
      active = false;
      clearInterval(tick);
      check.cancel();
      document.removeEventListener("visibilitychange", check);
    };
  }, []);
  const edit = useCallback((item: Item | Kind) => setEditing(item), []);
  useEffect(() => {
    void init().catch((e) => notify(e.message));
    const listener = () => setOnline(navigator.onLine);
    window.addEventListener("online", listener);
    window.addEventListener("offline", listener);
    return () => {
      window.removeEventListener("online", listener);
      window.removeEventListener("offline", listener);
    };
  }, [notify]);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearch(true);
      }
      const target = e.target as HTMLElement;
      if (
        e.key === "n" &&
        !e.repeat &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !target.isContentEditable &&
        !["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) &&
        // An open dialog may hold an unsaved draft; never replace it.
        !document.querySelector("dialog[open]")
      )
        setComposing(true);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timer);
  }, [toast]);
  const reminders = useMemo(() => visibleReminders(state.items), [state.items]);
  const trash = useCallback(
    (item: Item) => {
      void remove(item)
        .then(() =>
          setToast({
            message: "Movido a la papelera.",
            undo: () => {
              void db.items
                .get(item.id)
                .then((latest) => save({ ...(latest || item), deleted: false }))
                .catch((e) => notify(e.message));
              setToast(null);
            },
          }),
        )
        .catch((e) => notify(e.message));
    },
    [notify],
  );
  const context = useMemo(
    () => ({
      items: state.items,
      edit,
      notify,
      trash,
      ask: setHandoff,
      openThread,
    }),
    [state.items, edit, notify, trash, openThread],
  );
  const tools: { path: string; label: string; glyph: GlyphName }[] = [
    { path: "/projects", label: t("tools.projects"), glyph: "proyectos" },
    { path: "/threads", label: t("tools.threads"), glyph: "equipo" },
    { path: "/tasks", label: t("tools.tasks"), glyph: "tareas" },
    { path: "/finance", label: t("tools.finance"), glyph: "finanzas" },
    { path: "/files", label: t("tools.files"), glyph: "maletin" },
    { path: "/settings", label: t("tools.settings"), glyph: "ajustes" },
  ];
  const toastNode = toast ? (
    <div className="toast" role="status">
      <span>{toast.message}</span>
      {toast.undo && <button onClick={toast.undo}>{t("actions.undo")}</button>}
      <button
        aria-label={t("actions.closeNotice")}
        onClick={() => setToast(null)}
      >
        <X size={15} />
      </button>
    </div>
  ) : null;
  const toastInToolModal =
    !inRoom &&
    state.ready &&
    !editing &&
    !notifications &&
    !composing &&
    handoff === null &&
    !search &&
    !threadDraft;
  return (
    <UI.Provider value={context}>
      <HeadingSlots.Provider value={slots}>
        <div className="room-shell">
          <header className="world-header">
            <Link to="/" className="world-brand">
              <HudGlyph name="agenda" size={26} />
              <span>Second Brain</span>
            </Link>
            <span className="world-save" role="status">
              <i className={"status-dot " + (!online ? "offline" : "")} />
              {isDemo
                ? t("status.demo")
                : !online
                  ? t("status.offline")
                  : state.error
                    ? t("status.unsynced")
                    : state.pending.length
                      ? t("status.pending")
                      : t("status.connected")}
            </span>
            <div className="world-actions">
              <button
                aria-label={
                  backup
                    ? t("actions.remindersAlert")
                    : reminders.some((x) => x.status === "unread")
                      ? t("actions.remindersUnread")
                      : t("actions.reminders")
                }
                onClick={() => setNotifications(true)}
              >
                <HudGlyph name="avisos" size={22} />
                {(backup || reminders.some((x) => x.status === "unread")) && (
                  <i />
                )}
              </button>
              <button
                aria-label={t("actions.search") + " · " + shortcutLabel}
                onClick={() => setSearch(true)}
              >
                <HudGlyph name="buscar" size={22} />
                <span>{t("actions.search")}</span>
              </button>
              <button
                className="world-capture"
                aria-label={t("actions.create")}
                onClick={() => setComposing(true)}
              >
                <HudGlyph name="capturar" size={22} />
                <span>{t("actions.create")}</span>
              </button>
            </div>
          </header>
          <main id="main-content" className="world-main">
            {state.ready ? (
              <Suspense
                fallback={<p className="world-loading">{t("loading.room")}</p>}
              >
                <RoomPage />
              </Suspense>
            ) : (
              <div className="world-loading">
                <LoaderCircle size={22} className="spin" />
                {t("loading.connecting")}
              </div>
            )}
          </main>
          {state.error && (
            <div className="world-warning" role="alert">
              {state.error}
              <button onClick={() => void sync()}>{t("actions.retry")}</button>
            </div>
          )}
          <nav className="world-shortcuts" aria-label={t("tools.hudNav")}>
            <HudMoon />
            <Link
              to="/"
              className={inRoom ? "selected" : ""}
              style={{ "--slot": -3 } as CSSProperties}
            >
              <HudGlyph name="sala" />
              <span>{t("tools.room")}</span>
            </Link>
            {tools.map(({ path, label, glyph }, index) => (
              <NavLink
                key={path}
                to={path}
                style={{ "--slot": index - 2 } as CSSProperties}
              >
                <HudGlyph name={glyph} />
                <span>{label}</span>
              </NavLink>
            ))}
          </nav>
        </div>
        {!inRoom && state.ready && (
          <Modal
            title={t("tools.title")}
            wide
            className="tool-workspace"
            onClose={() => navigate("/")}
          >
            <div className="workspace-body">
              <div className="tool-base">
                <nav className="tool-tabs" aria-label={t("tools.switch")}>
                  {tools.map(({ path, label }) => (
                    <NavLink key={path} to={path}>
                      {label}
                    </NavLink>
                  ))}
                </nav>
                <div className="tool-heading">
                  <div ref={setTitleSlot} />
                  <div className="page-actions" ref={setActionsSlot} />
                </div>
                <div className="tool-content">
                  <Suspense fallback={<p role="status">{t("loading.tool")}</p>}>
                    <ToolRoutes />
                  </Suspense>
                </div>
              </div>
              <div className="tool-fab-slot" ref={setFabSlot} />
              {toastInToolModal && toastNode}
            </div>
          </Modal>
        )}
        {editing &&
          (typeof editing !== "string" &&
          editing.kind === "transaction" &&
          state.items.some((x) => x.id === editing.id) ? (
            <TransactionDetail
              key={editing.id}
              item={editing}
              onClose={() => setEditing(null)}
            />
          ) : (
            <ItemEditor
              key={typeof editing === "string" ? editing : editing.id}
              value={editing}
              onClose={() => setEditing(null)}
            />
          ))}
        {notifications && (
          <RemindersDialog
            reminders={reminders}
            backup={backup}
            onClose={() => setNotifications(false)}
          />
        )}
        {composing && (
          <Modal title={t("create.title")} onClose={() => setComposing(false)}>
            <PromptBar
              autoFocus
              placeholder={t("create.placeholder")}
              onDone={() => setComposing(false)}
            />
          </Modal>
        )}
        {handoff !== null && (
          <AgentHandoff
            key={handoff}
            prompt={handoff}
            onClose={() => setHandoff(null)}
          />
        )}
        {threadDraft && (
          <Suspense fallback={null}>
            <NewThreadDialog
              initialEngine={threadDraft.engine}
              initialPrompt={threadDraft.prompt}
              projectId={threadDraft.projectId}
              onClose={() => setThreadDraft(null)}
              onCreated={(thread) => {
                setThreadDraft(null);
                openThread({ id: thread.id });
              }}
            />
          </Suspense>
        )}
        {search && <SearchDialog onClose={() => setSearch(false)} />}
        {!toastInToolModal && toastNode}
      </HeadingSlots.Provider>
    </UI.Provider>
  );
}
