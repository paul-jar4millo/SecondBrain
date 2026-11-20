# dashboard

An installable PWA built with React 19, TypeScript, Vite and Three.js. The
entry is a low-poly 3D "refuge" with a game-like HUD; tools open over the
scene in a shared dialog. Visual direction: [DESIGN](../../DESIGN.md).

```sh
npm run dev                                   # from the repository root
open http://127.0.0.1:5173/?demo=1            # synthetic data, no backend
npm --prefix dashboard test                   # Vitest + Testing Library
npm --prefix dashboard run verify:browser     # Playwright suites
```

## Layout

| Path                                                                      | Content                                                                        |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `src/app/`                                                                | `App`, `Workspace` (scene + tool dialog), routing, auth screen                 |
| `src/core/`                                                               | Store and offline outbox (Dexie), API client, events (SSE), i18n, demo data    |
| `src/i18n/`                                                               | Spanish and English dictionaries (`MessageKey` is checked at compile time)     |
| `src/features/room/`                                                      | The 3D refuge: scene, camera, characters, boards, quality levels               |
| `src/features/{projects,tasks,finance,files,team,settings,assist,mundo}/` | Tools                                                                          |
| `src/styles/`                                                             | `refuge.css` (HUD) and `tools.css` (dialogs and forms)                         |
| `ops/`                                                                    | Dev server, precache, Blender scene script, Playwright suites, demo smoke test |

## Behavior

- **Offline first.** Items are cached in IndexedDB; edits go to an outbox and
  are replayed as `POST /mutations` with the base version, so conflicts are
  detected server-side.
- **Live.** `GET /events` (SSE) invalidates cached data; a disconnection keeps
  the last visible state and shows how old it is.
- **Accessible without WebGL.** Every tool works without the scene; reduced
  motion, visible focus, 44 px targets and Escape handling are checked by the
  browser suites.
- **Finance privacy.** Amounts and charts can be masked everywhere, including
  boards inside the 3D scene.
- **Languages.** Spanish by default, English with `?lang=en` or in Settings.
  Shell, authentication and settings are translated; tool content is
  being migrated to the dictionaries.

## Static demo

`VITE_DEMO=1` replaces the API with `src/core/demo.ts` and disables the service
worker and live events. `VITE_BASE` sets the public path. This is what
[`pages.yml`](../ci-cd.md#pagesyml--live-demo) publishes.

## The 3D scene

`ops/room-refuge.py` builds the refuge in Blender and exports
`public/models/sala/refugio.glb` and `refugio-nav.json` (walkable areas and
obstacles); the editable file is `ops/room-refuge.blend`:

```sh
blender -b --factory-startup -P ops/room-refuge.py   # from dashboard/
```

`src/features/room/room-world.js` applies materials and movement. Keep the
object name prefixes the script, navigation and obstacle contract rely on.
Portraits in `public/portraits` are rendered from the GLB characters by
`ops/render-agent-portraits.mjs`. Asset provenance:
`public/art/PROVENANCE.md`.

## Project dashboards

Custom panels are software components, never HTML or scripts taken from
notes. `src/features/projects/dashboards.tsx` registers each one with `id`,
`title`, `description`, `path`, `projectPath` (its canonical note), `fixed`
and a lazily loaded `Component`. To add one: implement it with the existing
authenticated APIs, register a unique route and its note path, and verify
routes, errors, desktop and mobile with synthetic fixtures.

The built-in "world" panel (`src/features/world/`) reads a published video
package that `service/world.mjs` validates and serves after authentication;
`MUNDO_PAQUETE` points to it. It never reads the external project's files or
runs its scripts.

## Browser suites

`npm run verify:browser` runs the Playwright scripts in `ops/` (refuge,
approvals, project dashboards, tools, conversations, workspaces) with
synthetic data and fake CLIs. They use `BROWSER_EXECUTABLE` when set, then an
installed Chrome or Edge, then Playwright's Chromium. A headless run does not
measure a physical GPU or phone.

## Threads (ADR 0010)

`src/features/threads/` is the Threads tool (`/threads`, `/threads/:id`):

- `thread-store.ts`: pure reducer from a snapshot plus stream messages
  (events, deltas, live item snapshots); `groupTurns` folds each turn's work
  ("Trabajó 42 s") apart from its messages.
- `thread-stream.ts`: snapshot, then SSE (`/threads/flujo`, resumes with
  `Last-Event-ID`); `snapshot-required` reloads; repeated failures fall back
  to polling. The list follows `/threads/feed` from `globalSeq`.
- `Timeline`, `items.tsx` (one renderer per item kind), `RequestCard`
  (questions, approvals and forms inline), `Composer` (send, steer, queue,
  stop; agent and model per message), `DiffView`, `dialogs.tsx` (new thread,
  close by PR, merge or discard).
- Types come from `contracts` as `import type`, so Zod never reaches the
  bundle. Mobile: one column, the side panel is a bottom sheet, 44 px
  targets. `ops/verify-threads.mjs` checks desktop and 375 px.
