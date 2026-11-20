// Standalone package-lock.json for one npm workspace, cut from the root
// lockfile. The repository installs every module from one root lockfile, but
// the release keeps installing each module on its own (`npm ci --prefix
// <module>` in deploy-release.sh and the Dockerfile), so each released module
// carries a lockfile with exactly the versions the root lockfile resolved.

/**
 * @typedef {{
 *   name?: string,
 *   version?: string,
 *   link?: boolean,
 *   dependencies?: Record<string, string>,
 *   optionalDependencies?: Record<string, string>,
 *   peerDependencies?: Record<string, string>,
 *   peerDependenciesMeta?: Record<string, { optional?: boolean }>,
 *   devDependencies?: Record<string, string>,
 *   [key: string]: unknown,
 * }} LockEntry
 * @typedef {{ lockfileVersion: number, packages: Record<string, LockEntry>, [key: string]: unknown }} Lockfile
 */

/**
 * Folder that holds a lock location: "a/node_modules/b" → "a",
 * "node_modules/@s/x" → "", a workspace folder → "".
 * @param {string} location
 */
function parentOf(location) {
  const at = location.lastIndexOf("node_modules/");
  return at <= 0 ? "" : location.slice(0, at - 1);
}

/**
 * Node's lookup: the closest node_modules/<name> walking up from `from`.
 * @param {Record<string, LockEntry>} packages
 * @param {string} from
 * @param {string} name
 */
function resolve(packages, from, name) {
  for (let location = from; ; location = parentOf(location)) {
    const candidate = `${location ? `${location}/` : ""}node_modules/${name}`;
    if (packages[candidate]) return candidate;
    if (!location) return null;
  }
}

/**
 * @param {Lockfile} rootLock the repository's package-lock.json
 * @param {string} workspace the workspace folder, e.g. "launcher"
 * @returns {Lockfile}
 */
export function workspaceLock(rootLock, workspace) {
  if (rootLock.lockfileVersion < 2)
    throw new Error("Se necesita un package-lock.json v2 o posterior.");
  const { packages } = rootLock;
  const root = packages[workspace];
  if (!root) throw new Error(`El lockfile no tiene el workspace ${workspace}.`);

  /** @type {Set<string>} */
  const reached = new Set();
  /** @type {string[]} */
  const pending = [workspace];
  while (pending.length) {
    const location = /** @type {string} */ (pending.pop());
    const entry = packages[location];
    const optional = new Set([
      ...Object.keys(entry.optionalDependencies ?? {}),
      ...Object.entries(entry.peerDependenciesMeta ?? {})
        .filter(([, meta]) => meta.optional)
        .map(([name]) => name),
    ]);
    for (const name of new Set([
      ...Object.keys(entry.dependencies ?? {}),
      ...Object.keys(entry.optionalDependencies ?? {}),
      ...Object.keys(entry.peerDependencies ?? {}),
    ])) {
      const found = resolve(packages, location, name);
      if (!found) {
        if (optional.has(name)) continue;
        throw new Error(
          `${location} necesita ${name} y el lockfile no lo tiene.`,
        );
      }
      if (packages[found].link)
        throw new Error(
          `${location} depende del workspace ${name}; el paquete no lo admite.`,
        );
      if (!reached.has(found)) {
        reached.add(found);
        pending.push(found);
      }
    }
  }

  /** @type {Record<string, LockEntry>} */
  const out = {
    "": Object.fromEntries(
      Object.entries(root).filter(([key]) => key !== "devDependencies"),
    ),
  };
  /** @type {Map<string, string>} */
  const origin = new Map();
  for (const location of [...reached].sort()) {
    const target = location.startsWith(`${workspace}/`)
      ? location.slice(workspace.length + 1)
      : location;
    const previous = origin.get(target);
    if (previous)
      throw new Error(
        `${previous} y ${location} quedarían en ${target}; ajusta las versiones.`,
      );
    origin.set(target, location);
    out[target] = packages[location];
  }
  return {
    name: root.name,
    version: root.version,
    lockfileVersion: rootLock.lockfileVersion,
    requires: true,
    packages: out,
  };
}
