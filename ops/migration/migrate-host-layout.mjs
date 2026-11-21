import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chown,
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  HOST_COMMANDS,
  HOST_DATA_PATHS,
  HOST_LAYOUT_MARKER,
  HOST_UNITS,
  hostUnitText,
  remapHostPath,
} from "./host-layout.mjs";

const run = promisify(execFile);
const STATE = "/etc/secondbrain/host-layout.state.json";
const UNITS = "/etc/systemd/system/";
const LAUNCHER = HOST_UNITS[0];
const ONGOING = [
  "secondbrain.service",
  "secondbrain-container.service",
  "claude-sb-agente.service",
];
const PROJECTS = "/etc/sb-agente/proyectos.json";
const SETTINGS = "/var/lib/sb-agente/.gemini/antigravity-cli/settings.json";
// Claude keys workspace trust by absolute path (CLAUDE_CONFIG_DIR per account).
const CLAUDE_CONFIGS = [
  "/var/lib/sb-agente/claude/.claude.json",
  "/var/lib/sb-agente/deepseek/.claude.json",
];

async function metadata(file) {
  try {
    return await lstat(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  }
}

async function readJson(file) {
  return (await metadata(file))
    ? JSON.parse(await readFile(file, "utf8"))
    : undefined;
}

async function atomicWrite(file, text, attributes) {
  const temporary = file + "." + randomUUID();
  try {
    const mode = attributes ? attributes.mode & 0o777 : 0o600;
    await writeFile(temporary, text, { flag: "wx", mode });
    if (attributes && process.platform !== "win32")
      await chown(temporary, attributes.uid, attributes.gid);
    await chmod(temporary, mode);
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function checkParents(root, candidate) {
  const relative = path.relative(root, path.dirname(candidate));
  let parent = root;
  for (const piece of relative.split(path.sep).filter(Boolean)) {
    parent = path.join(parent, piece);
    const entry = await metadata(parent);
    if (entry && !entry.isDirectory())
      throw new Error("Unsafe parent for managed path: " + parent);
  }
}

async function installDirectory(destination, source) {
  if (await metadata(destination)) return;
  await installDirectory(path.dirname(destination), source);
  await mkdir(destination, { mode: source.mode & 0o777 });
  if (process.platform !== "win32")
    await chown(destination, source.uid, source.gid);
  await chmod(destination, source.mode & 0o777);
}

function relativeLink(alias, destination) {
  return path.relative(path.dirname(alias), destination);
}

async function matchesAlias(alias, destination) {
  const entry = await metadata(alias);
  if (!entry?.isSymbolicLink()) return false;
  if (path.resolve(path.dirname(alias), await readlink(alias)) !== destination)
    throw new Error("Unexpected alias target: " + alias);
  return true;
}

async function preflightPair(from, to, { text, directory }) {
  const source = await metadata(from);
  const destination = await metadata(to);
  if (source?.isSymbolicLink() && !(await matchesAlias(from, to)))
    throw new Error("Invalid source alias: " + from);
  if (destination?.isSymbolicLink() && !(await matchesAlias(to, from)))
    throw new Error("Invalid destination alias: " + to);
  if (source?.isSymbolicLink() && destination?.isSymbolicLink())
    throw new Error("Circular aliases: " + from + " and " + to);
  for (const [file, entry] of [
    [from, source],
    [to, destination],
  ])
    if (
      entry &&
      !entry.isSymbolicLink() &&
      !(directory ? entry.isDirectory() : entry.isFile())
    )
      throw new Error("Unexpected type of managed path: " + file);
  if (
    source &&
    !source.isSymbolicLink() &&
    destination &&
    !destination.isSymbolicLink()
  ) {
    // Resume only if a previous atomic copy of a unit was committed.
    if (
      !text ||
      text(await readFile(from, "utf8")) !== (await readFile(to, "utf8"))
    )
      throw new Error("Both managed paths exist: " + from + " and " + to);
  }
  if (directory && source?.isDirectory() && !destination?.isDirectory()) {
    let parent = path.dirname(to);
    while (!(await metadata(parent))) parent = path.dirname(parent);
    if ((await stat(parent)).dev !== source.dev)
      throw new Error(
        "Migration requires both paths on the same filesystem: " + from,
      );
  }
}

async function relocate(from, to, { alias, text, directory }) {
  const source = await metadata(from);
  if (source && !source.isSymbolicLink()) {
    if (await matchesAlias(to, from)) await unlink(to);
    await installDirectory(path.dirname(to), await stat(path.dirname(from)));
    if (text) {
      await atomicWrite(to, text(await readFile(from, "utf8")), source);
      await unlink(from);
    } else {
      await rename(from, to);
    }
  }
  if (!(await metadata(to))) return;
  if (alias && !(await metadata(from)))
    await symlink(relativeLink(from, to), from, directory ? "dir" : "file");
  if (!alias && (await matchesAlias(from, to))) await unlink(from);
}

function rewriteLocation(value, reverse) {
  if (!value || typeof value !== "object") return;
  if (typeof value.workspace === "string")
    value.workspace = remapHostPath(value.workspace, reverse);
  if (value.repo && typeof value.repo === "object")
    for (const key of ["path", "worktree"])
      if (typeof value.repo[key] === "string")
        value.repo[key] = remapHostPath(value.repo[key], reverse);
}

export function rewriteThreadPaths(db, reverse = false) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const updateThread = db.prepare("UPDATE threads SET data = ? WHERE id = ?");
    for (const row of db.prepare("SELECT id, data FROM threads").all()) {
      const data = JSON.parse(row.data);
      rewriteLocation(data, reverse);
      const next = JSON.stringify(data);
      if (next !== row.data) updateThread.run(next, row.id);
    }
    const updateEvent = db.prepare(
      "UPDATE events SET data = ? WHERE thread_id = ? AND seq = ?",
    );
    const events = db.prepare(
      "SELECT thread_id, seq, data FROM events WHERE type IN ('thread.created', 'thread.updated')",
    );
    for (const row of events.all()) {
      const data = JSON.parse(row.data);
      rewriteLocation(data.thread ?? data.patch, reverse);
      const next = JSON.stringify(data);
      if (next !== row.data) updateEvent.run(next, row.thread_id, row.seq);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

async function rewriteConfiguration(file, transform) {
  const original = await metadata(file);
  if (!original) return;
  if (!original.isFile())
    throw new Error("Unexpected type of configuration: " + file);
  const value = await readJson(file);
  const previous = JSON.stringify(value);
  transform(value);
  if (JSON.stringify(value) !== previous)
    await atomicWrite(file, JSON.stringify(value, null, 2) + "\n", original);
}

async function rewriteHostState(at, host, reverse) {
  const remap = (value) =>
    typeof value === "string" ? remapHostPath(value, reverse) : value;
  await rewriteConfiguration(at(PROJECTS), (projects) => {
    for (const key of Object.keys(projects))
      projects[key] = remap(projects[key]);
  });
  await rewriteConfiguration(
    at("/etc/secondbrain/parameters.json"),
    (settings) => {
      if (settings.remoteWorkdir)
        settings.remoteWorkdir = remap(settings.remoteWorkdir);
    },
  );
  await rewriteConfiguration(at(SETTINGS), (settings) => {
    if (Array.isArray(settings.trustedWorkspaces))
      settings.trustedWorkspaces = [
        ...new Set(settings.trustedWorkspaces.map(remap)),
      ];
  });
  // Old keys stay: the legacy paths remain as aliases during the release.
  for (const file of CLAUDE_CONFIGS)
    await rewriteConfiguration(at(file), (config) => {
      const projects = config.projects;
      if (!projects || typeof projects !== "object") return;
      for (const key of Object.keys(projects)) {
        const next = remapHostPath(key, reverse);
        if (next !== key && !Object.hasOwn(projects, next))
          projects[next] = structuredClone(projects[key]);
      }
    });

  const database = at(HOST_DATA_PATHS[0][reverse ? 0 : 1] + "/threads.sqlite");
  const dataPath = HOST_DATA_PATHS[0][reverse ? 0 : 1];
  const worktreeRoot = dataPath + "/threads/worktrees/";
  const knownProjects = new Set(
    Object.values((await readJson(at(PROJECTS))) ?? {}),
  );
  const worktrees = new Map();
  const info = await metadata(database);
  if (info) {
    if (!info.isFile())
      throw new Error("Launcher database is not a regular file");
    const db = new DatabaseSync(database);
    try {
      rewriteThreadPaths(db, reverse);
      for (const row of db
        .prepare(
          "SELECT data FROM threads WHERE kind = 'repo' AND status <> 'archived'",
        )
        .all()) {
        const { repo } = JSON.parse(row.data);
        if (
          repo &&
          knownProjects.has(repo.path) &&
          typeof repo.worktree === "string" &&
          repo.worktree.startsWith(worktreeRoot) &&
          path.posix.normalize(repo.worktree) === repo.worktree &&
          !repo.worktree.slice(worktreeRoot.length).includes("/") &&
          (await metadata(at(repo.worktree)))?.isDirectory()
        ) {
          if (!worktrees.has(repo.path)) worktrees.set(repo.path, []);
          worktrees.get(repo.path).push(repo.worktree);
        }
      }
    } finally {
      db.close();
    }
  }
  for (const [repo, directories] of worktrees)
    await host.repairWorktrees(repo, directories);
}

function systemHost() {
  const systemctl = (...args) =>
    run("/usr/bin/systemctl", args, { timeout: 120_000 });
  const hasState = async (command, unit) =>
    systemctl(command, "--quiet", unit).then(
      () => true,
      (error) => {
        if ([1, 3, 4].includes(error.code)) return false;
        throw error;
      },
    );
  return {
    run: systemctl,
    state: async (unit) => ({
      active: await hasState("is-active", unit),
      enabled: await hasState("is-enabled", unit),
    }),
    waitForLauncher: () =>
      run(
        process.execPath,
        [
          fileURLToPath(
            new URL("../deploy/wait-launcher.mjs", import.meta.url),
          ),
        ],
        {
          timeout: 930_000,
          env: { ...process.env, SB_DEPLOY_WAIT_MS: "900000" },
        },
      ),
    // Regenerates every managed unit and script for the layout the marker selects.
    configure: () =>
      run(
        process.execPath,
        [
          fileURLToPath(new URL("../deploy/configure.mjs", import.meta.url)),
          "--release",
          fileURLToPath(new URL("../..", import.meta.url)),
          "--parameters",
          "/etc/secondbrain/parameters.json",
          "--skip-helper",
        ],
        { timeout: 120_000 },
      ),
    repairWorktrees: (repo, directories) =>
      run(
        "/usr/sbin/runuser",
        [
          "-u",
          "sb-agente",
          "--",
          "/usr/bin/git",
          "-C",
          repo,
          "worktree",
          "repair",
          "--",
          ...directories,
        ],
        { timeout: 120_000 },
      ),
  };
}

/**
 * Filesystem migration with an on-disk journal, so an interrupted command can
 * resume or roll back with the same enabled/running unit state.
 */
export async function migrateHostLayout({
  root = "/",
  host = systemHost(),
  mode = "plan",
} = {}) {
  root = await realpath(root);
  const at = (absolute) => path.resolve(root, "." + absolute);
  const marker = at(HOST_LAYOUT_MARKER);
  const stateFile = at(STATE);
  await checkParents(root, stateFile);
  for (const file of [marker, stateFile]) {
    const entry = await metadata(file);
    if (entry && !entry.isFile())
      throw new Error("Invalid host layout metadata: " + file);
  }
  const state = await readJson(stateFile);
  const installed = Boolean(await metadata(marker));
  const reverse = mode === "rollback";
  if (mode === "plan") {
    const moves = [...HOST_DATA_PATHS, ...HOST_UNITS, ...HOST_COMMANDS];
    return {
      layout: installed ? "english" : "legacy",
      pending: state?.mode ?? null,
      moves,
    };
  }
  if (mode !== "apply" && !reverse) throw new Error("Unknown migration mode");
  if (!state && installed === !reverse) return { changed: false };

  const units = HOST_UNITS.filter(([old]) => !old.includes("@"));
  const primary = state?.primary ?? (installed ? 1 : 0);
  const journal = state ?? {
    primary,
    unitStates: Object.fromEntries(
      await Promise.all(
        [...ONGOING, ...units.map((pair) => pair[primary])].map(
          async (unit) => [unit, await host.state(unit)],
        ),
      ),
    ),
    phase: "prepared",
    mode,
  };
  const pairs = [
    ...HOST_DATA_PATHS.map(([a, b]) => [a, b, { directory: true }]),
    ...HOST_COMMANDS.map(([a, b]) => [a, b, {}]),
    ...HOST_UNITS.map(([a, b]) => [
      UNITS + a,
      UNITS + b,
      { text: (content) => hostUnitText(content, reverse) },
    ]),
    ...HOST_UNITS.map(([a, b]) => [
      UNITS + a + ".d",
      UNITS + b + ".d",
      { directory: true },
    ]),
  ];
  for (const [old, next, options] of pairs) {
    await checkParents(root, at(old));
    await checkParents(root, at(next));
    await preflightPair(
      at(reverse ? next : old),
      at(reverse ? old : next),
      options,
    );
  }

  // Stop request producers first, let an in-flight turn finish, then stop its
  // writer. This prevents a new turn between the readiness check and shutdown.
  journal.mode = mode;
  if (!state) {
    await mkdir(path.dirname(stateFile), { recursive: true, mode: 0o755 });
    await atomicWrite(stateFile, JSON.stringify(journal));
  }
  if (journal.phase === "prepared" || journal.phase === "starting") {
    const launcher = LAUNCHER[primary];
    const producers = [
      ...units
        .filter(([old]) => !old.startsWith("secondbrain-"))
        .map((pair) => pair[primary]),
      ...ONGOING,
    ];
    const running = [];
    try {
      for (const unit of producers)
        if ((await host.state(unit)).active) {
          await host.run("stop", unit);
          running.push(unit);
        }
      // A resumed migration may have started the new launcher before its journal was cleared.
      for (const unit of new Set([launcher, LAUNCHER[1 - primary]]))
        if ((await host.state(unit)).active) {
          await host.waitForLauncher();
          await host.run("stop", unit);
          running.push(unit);
        }
      for (const pair of units) {
        const unit = pair[installed ? 1 : 0];
        if ((await host.state(unit)).enabled) await host.run("disable", unit);
      }
    } catch (error) {
      for (const pair of units) {
        const unit = pair[installed ? 1 : 0];
        if (journal.unitStates[pair[primary]]?.enabled)
          await host.run("enable", unit);
      }
      for (const unit of running.reverse()) await host.run("start", unit);
      throw error;
    }
    journal.phase = "stopped";
    await atomicWrite(stateFile, JSON.stringify(journal));
  }

  for (const [old, next, options] of pairs)
    await relocate(at(reverse ? next : old), at(reverse ? old : next), {
      ...options,
      alias: !reverse && !old.endsWith(".d"),
    });
  for (const [old, next] of HOST_UNITS) {
    const dropins = at(UNITS + (reverse ? old : next) + ".d");
    if (!(await metadata(dropins))) continue;
    for (const entry of await readdir(dropins, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".conf")) continue;
      const file = path.join(dropins, entry.name);
      const text = await readFile(file, "utf8");
      const translated = hostUnitText(text, reverse);
      if (translated !== text)
        await atomicWrite(file, translated, await stat(file));
    }
  }
  await rewriteHostState(at, host, reverse);
  if (reverse) {
    if (await metadata(marker)) await unlink(marker);
  } else {
    await atomicWrite(marker, "1\n");
  }
  journal.phase = "starting";
  await atomicWrite(stateFile, JSON.stringify(journal));

  await host.configure();
  await host.run("daemon-reload");
  for (const pair of units) {
    const target = pair[reverse ? 0 : 1];
    const original = journal.unitStates[pair[primary]];
    if (original?.enabled) await host.run("enable", target);
    if (original?.active) await host.run("start", target);
  }
  for (const unit of ONGOING)
    if (journal.unitStates[unit]?.active) await host.run("start", unit);
  await unlink(stateFile);
  return { changed: true, layout: reverse ? "legacy" : "english" };
}

if (
  process.argv[1] &&
  // Operators call it through /opt/secondbrain/current, a symlink.
  (await realpath(process.argv[1])) === fileURLToPath(import.meta.url)
) {
  try {
    const args = process.argv.slice(2);
    const mode =
      args[0] === "--apply"
        ? "apply"
        : args[0] === "--rollback"
          ? "rollback"
          : "plan";
    if (
      args.length > 1 ||
      (args.length && !["--apply", "--rollback", "--dry-run"].includes(args[0]))
    )
      throw new Error(
        "Usage: node migrate-host-layout.mjs [--dry-run|--apply|--rollback]",
      );
    if (mode !== "plan" && process.getuid?.() !== 0)
      throw new Error("This operation requires root");
    if (mode !== "plan" && process.env.SB_LAYOUT_LOCK_HELD !== "1") {
      await run(
        "/usr/bin/flock",
        [
          "-n",
          "/run/lock/secondbrain-deploy.lock",
          process.execPath,
          process.argv[1],
          ...args,
        ],
        { env: { ...process.env, SB_LAYOUT_LOCK_HELD: "1" }, timeout: 1200000 },
      ).then(({ stdout }) => process.stdout.write(stdout));
    } else {
      console.log(JSON.stringify(await migrateHostLayout({ mode }), null, 2));
    }
  } catch (error) {
    console.error(error.stderr?.trim() || error.message);
    process.exitCode = 1;
  }
}
