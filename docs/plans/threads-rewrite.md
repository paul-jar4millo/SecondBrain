# Plan: reescritura del chat de agentes como sistema de **Threads**

> **Estado (2026-11-20).** A0–A10 quedan incluidos en v0.4.2. El paso de
> datos de A9 está hecho. La prueba con Codex real en el LXC pasó sobre
> v0.4.1: turno, redirección dentro del mismo turno, diff, merge y archivado
> sin worktree, rama ni scope residual. También se comprobaron los límites
> del scope activo y las reglas de nftables del lanzador. Sigue la
> **fase 1.5** (despliegue robusto y servidor en inglés), luego B, C y D.

## Contexto

El chat actual integra mal los harnesses: solo 3 tipos de item (`usuario|asistente|herramienta`), el composer desaparece mientras el agente trabaja (el backend ya soporta steer/queue pero la UI no lo usa), el SSE reenvía el snapshot completo en cada cambio, se descartan razonamiento/plan/todo/diffs/uso, y cada mensaje crea una sesión `continuar`. No sirve para hand-offs. Se rehace inspirado en T3 Code (sin copiar código, ADR 0004 se mantiene): **thread = tarea**, con worktree propio, log de eventos, flujos con traspaso autónomo, revisión cruzada, sub-tareas, bandeja, push, refugio y bot de Discord.

Decisiones del usuario (cerradas): TS nativo (Node ≥24, type stripping, sin build) solo para código nuevo; lo salvado queda `.mjs`. Zod 4. SQLite (`node:sqlite`) en el launcher. Threads de repo (worktree + rama `sb/…`) y sin repo. Autonomía por defecto "auto en su worktree". Flujos elegibles; traspaso autónomo por MCP; brief = datos duros del sistema + narrativa del agente. Revisión cruzada, máx. 3 rondas + tope de turnos; los agentes ven sus límites de uso. Sub-tareas con aprobación. Cierre: diff → PR / merge local / descartar. Discord bidireccional sin modo restringido; merge/PR/permisos solo en la app. Resumen 08:00 en #resumen con sugerencias de un agente de suscripción. Se borra todo lo legacy (PTY, sesiones, `sb-hilo`) y los datos viejos sin respaldo (con confirmación en el momento).

## Arquitectura

**Propiedad del estado**

- `launcher/` → todo el estado de agentes en `$SB_LANZADOR_DATA_DIR/threads.sqlite` (WAL, migraciones con `user_version`). Nuevo ADR: ADR 0002 solo aplica al vault.
- `service/` → único escritor del vault y única superficie HTTP; guarda suscripciones push + outbox en `notifications.sqlite`.
- `discord/` → `links.sqlite` (thread ↔ hilo de Discord), reconstruible; solo habla con la API del service.

**`contracts/`** (workspace nuevo, Zod 4, `.ts`): `ids, thread, items, events, commands, requests, flows, inbox, usage, stream`.

- `Thread {kind: repo|scratch, status, autonomy, branch, parentId, flow, stageIndex, counters, limits, lastSeq}`; estados `setting-up|idle|running|waiting-user|in-review|ready-for-review|needs-decision|closing|done|failed|archived`.
- `Item` por `kind`: `user_message, assistant_message, reasoning, plan, todo_list, file_change{diffs}, command{output,exitCode}, tool_call, user_request, subagent, handoff, review, notice, usage`.
- `ThreadEvent` con `{threadId, seq, globalSeq}`; `item.delta` efímero (no persistido).
- Commands: `CreateThread, SendMessage{send|steer|queue}, Interrupt, AnswerRequest{origin}, CloseThread{pr|merge|discard}, Archive, ApproveSubtask`.
- Dashboard usa `zod/mini`.

**SQLite**: `threads, events (PK thread_id+seq, global_seq UNIQUE), items (proyección), turns, requests, stages, handoffs, reviews, usage_snapshots`, vista `inbox_view`. Sub-tareas = threads con `parent_id`.

**Stream**: `GET /threads/:id/stream` reanuda con `Last-Event-ID`/`?after=`; replay + `item.snapshot` de items en curso; `snapshot-required` si el seq no es servible. Feed global `GET /threads/stream` por `globalSeq` (lista, bandeja, refugio). Snapshot `GET /threads/:id`.

**Launcher** (`launcher/threads/`, TS; `index.mjs` sigue como entrada):

- `store/{db,migrations,event-log,projections}.ts`
- `engine/{thread-engine,turn-runner,event-mapper,scheduler,workspace,setup,checkpoints,closing}.ts` (+ fase B: `flows,handoff,review,subtasks,usage-tracker`)
- `http/{routes,stream}.ts`, `provider-context.ts`
- Contrato de controladores: añadir `emit(ProviderEvent)` en `launcher/lib/providers/controller-types.d.mts`; `event-mapper.ts` lo traduce a items.

**Service** (rutas nuevas en inglés, cada una con política en `service/routes.mjs`): `/api/v1/threads[/:id[/stream|/messages|/interrupt|/requests/:rid|/diff|/turns/:tid/diff|/close|/archive]]`, `/threads/stream`, `/inbox`, `/flows`, `/agents`, `/usage`, `/push/subscriptions`, `/summary/daily`.

**Auth Discord**: nueva credencial `bot` en `service/auth.mjs` (hash en archivo, solo loopback) con ops `threads.read|create|message`, `requests.answer`, `inbox.read`, `summary.read`; close/archive/ajustes denegados por política (con test).

**MCP** (inglés; `equipo_*` se retiran; `usuario_*` quedan como alias): `thread_ask_user, thread_handoff, thread_report_review, thread_request_subtask, thread_subtask_status, thread_integrate_subtask, agent_usage`. Identidad por turno: `sbcap_` con alcance `thread.self.*` + cabecera `x-sb-thread`.

## PRs por fase

### Fase A — base

- **A0 Spike + ADRs.** Verificar en el LXC: `node:sqlite`, `.ts` importando `../contracts/src/index.ts` por ruta relativa (repo y release empaquetado), steer a mitad de turno con Claude SDK (`streamInput`), coste de `git worktree add -b` + `npm ci --cache`. ADRs `0009-operational-state-in-sqlite`, `0010-threads-replace-sessions` (supera parte de 0003/0005, retira PTY y `sb-hilo`), `0011-native-typescript-and-contracts` (con fallback: el empaquetador usa `module.stripTypeScriptTypes` si falla la importación relativa).
- **A1 Tooling TS.** Workspace `contracts`; `tsconfig.node.json` (`allowImportingTsExtensions`, `erasableSyntaxOnly`, `verbatimModuleSyntax`); typescript-eslint para `.ts` fuera del dashboard; prettier `.ts`; `ops/naming.mjs` escanea `contracts/`, `discord/`, `.ts`; `ops/coverage.mjs` y `ci.yml` con módulos nuevos; `ops/package-release.mjs` copia `.ts` + `threads/`, módulo de release `contracts`, marcador estático `lanzador/version-registry.mjs`; `ops/tests/operational-package.test.mjs` y `dashboard/ops/deploy-release.sh` instalan `contracts`.
- **A2 Contratos.** `contracts/src/*.ts` + tests (round-trip, exhaustividad, export JSON Schema).
- **A3 Store SQLite.** `openStore, append (una transacción), readAfter, readGlobalAfter, snapshot, inbox, migrate`. Tests: seq monótono, replay del log == proyección, migración idempotente.
- **A4 Eventos ricos de proveedores** (paralelo a A3) en `launcher/lib/providers/{claude,codex,acp,shared}.mjs`:
  - Claude (`claude.mjs:144-256`): thinking, TodoWrite→`todo_list`, ExitPlanMode→`plan`, Task→`subagent`, atribución por `parent_tool_use_id` (corrige bug), uso/coste, `rate_limit_event`, `supportsSteer` vía input queue.
  - Codex (`codex.mjs:260-416`): reasoning, plan, `turn/diff/updated`, `commandExecution/outputDelta`, diffs por archivo (sin aplanar :323), `tokenUsage`, `account/rateLimits/updated`, `collabAgentToolCall`.
  - ACP (`acp.mjs:250-385`): `agent_thought_chunk`, plan, contenido diff/terminal, modo.
  - Tests con `launcher/tests/helpers/provider-fakes.mjs` y `createClaudeController(queryOverride)`.
- **A5 Motor de threads.** `workspace.ts` (worktree con rama real — hoy `execution/start.mjs:161-229` usa `--detach`, que `pr.crear` rechaza; setup `npm ci --prefer-offline` como item `command`; scratch vía `workspaces.mjs`); `turn-runner.ts` porta `conversation/turn.mjs:276-457` + reutilización por `configSignature`; env/MCP/skills de `execution/run-local.mjs`, `tool-catalog.mjs`, `limits.mjs sessionCommand`; checkpoints antes/después de cada turno sobre `createCheckpoints`; `scheduler.ts` con slots (`capacity.mjs`) y estado "esperando capacidad"; steer/queue/interrupt; rutas HTTP + SSE. Tests e2e con `helpers-git.mjs repoSintetico` + CLIs falsos.
- **A6 Cierre.** `closing.ts`: diff total/por turno; PR (`pr.crear`), merge local con detección de conflictos sin dejar cambios a medias, descartar; archivar = borrar worktree y rama (salvo PR abierto). Desacoplar `pr.mjs` de `conversations.mjs` y de `engineCommand` (`redactar` usa un turno one-shot).
- **A7 Proxy service + MCP.** `service/http/routes/{threads,inbox}.mjs`, stream con seq en `service/launcher-client.mjs`; `mcp/index.mjs`: `thread_ask_user`, `usuario_*` sobre requests de threads, arreglar `isToolAllowedForOperations`.
- **A8 UI Threads** en `dashboard/src/features/threads/`: `ThreadsPage, ThreadList, Timeline, WorkGroup ("Trabajó 42 s", plegable), items/*` (renderer por kind), `Composer` (send/steer/queue/interrupt, tarjetas de request inline, selector agente/modelo reutilizando `ModelEffortPicker`), `SidePanel` (Diff/Plan), `DiffView` (reutiliza `splitPatch`/`lineKind` de `harness-changes.ts`), `CloseDialog, NewThreadDialog, InboxList`, `thread-stream.ts` (resume + fallback), `thread-store.ts` (reducer). Rutas en `ToolRoutes.tsx`, nav en `Workspace.tsx`, i18n `es.ts`/`en.ts`. Móvil: una columna, panel lateral como hoja, composer pegado al teclado, objetivos de 44 px.
- **A9 Borrado legacy backend + ops.** Launcher: `terminal.py, harness, remote*, hook, flow, items, conversations, sessions, version-registry, cli` (+ `bin`), `conversation/*`, `provider-conversations`, `teams`, `execution/{delegation,terminal-io,run-remote,conversation-queue}`, deps `@xterm/*`. Service: `agents-sessions, agents-conversation, team-actions, agent-bridges, work-orders, change-feed`. MCP: `equipo_*`. Ops: `sb-hilo`, `ops/compat/hook.mjs`; portar `resumen-matutino.sh` a `POST /threads`; actualizar `configure.mjs, check-drift.sh, verificar.sh`. **Paso de datos en el LXC**: parar launcher, listar lo que se borra (`sesiones.json`, conversaciones, detalles), **pedir confirmación al usuario**, borrar.
- **A10 Borrado legacy dashboard + refugio + suites.** Borrar `AgentWorkspace, ProviderConversation, HarnessChanges, SessionPanel, team-store/controller`; mover `UsageBars, ModelEffortPicker, TeamPrimitives` y un único mapa motor→personaje a `features/agents/`; conservar `ApprovalPanel` (finanzas). `room-sessions.ts` lee la proyección de threads; renombrar `room-threads.ts`→`room-team-lines.ts`. Recablear proyectos/tareas/finanzas/ajustes a `openThread`/`NewThreadDialog`. Reescribir `ops/verify-conversations.mjs` + `verify-workspaces.mjs` como `verify-threads.mjs` (escritorio + 375 px), `fake-stream.mjs`, regex de CI.

### Fase 1.5 — despliegue robusto y servidor en inglés

Va entre A (cuando pasen la lista e2e y A10) y B. B, C y D añaden servicios
(bot de Discord, push, resumen), y cada uno multiplica lo que hoy se rompe al
desplegar.

**Lo que se rompió en el camino (2026-11)**

- v0.3.1: la release no traía `registro-version.mjs` y el host se quedó con el
  launcher de v0.1.2 sin avisar (capa de compatibilidad
  `launcher-compatible.mjs` + marcadores de versión).
- v0.4.0: el deploy cambió el código, pero no las unidades systemd. Hubo
  deriva hasta correr `aprovisionar.sh desplegar` a mano. `verificar.sh` no
  viaja en la release y hubo que copiarlo.
- v0.4.0: todos los threads de Codex morían al arrancar. CI usa proveedores
  falsos, y Codex 0.167 rechazó una opción `-c` que el falso aceptaba. Solo la
  e2e manual lo encontró (#53).
- Estado repartido entre `/opt`, `/etc`, `/var/lib` y `/srv`, con nombres en
  español y en inglés mezclados (`lanzador`, `estado`, `proyectos`,
  `SB_LANZADOR_*`, `/agentes/*`, `/sala/*`…).

**Decisión: contenedor para lo que no ejecuta agentes; el launcher sigue
nativo.**

- **Service + MCP + dashboard → imagen OCI.** Ya existen
  `dashboard/Dockerfile` y `compose.yml`. CI construye la imagen una vez, la
  publica en GHCR y despliega por _digest_. El rollback es volver al digest
  anterior. Desaparecen `npm ci` en el host, `releases/<sha>`, el symlink y
  `deploy-release.sh`. El LXC 204 ya es `unprivileged` con `nesting=1`; se
  usa **Podman + Quadlet**: sin daemon, la unidad es un archivo systemd
  declarativo y `podman auto-update` sigue el digest fijado. Docker queda
  como alternativa si Quadlet da problemas en el LXC.
- **El launcher no va en contenedor.** Depende de cosas que un contenedor
  anidado en un LXC sin privilegios complica sin ganar nada:
  - aislamiento por usuario (`sb-agente`) con nftables;
  - un scope `systemd-run --user` por thread, con límites de memoria y CPU;
  - las CLIs con sesiones iniciadas;
  - worktrees en `/srv`.

  Se vuelve declarativo:
  - un solo `install` idempotente que el deploy corre siempre;
  - unidades y configuración generadas y aplicadas en cada deploy (deriva
    = el deploy falla);
  - versiones de las CLIs (`codex`, `claude`, `agy`) fijadas en un
    manifiesto.

- Se descarta una VM o un LXC con Docker para todo: duplica el aislamiento que
  ya da el LXC, y los agentes necesitan el host tal cual.

**PRs**

- **P1 El deploy aplica todo y se comprueba solo.**
  - `deploy-release.sh` corre `configure.mjs`, `daemon-reload` y
    `install.sh` del launcher. Al final ejecuta `verificar.sh`, que ahora
    viaja en la release, y si falla vuelve atrás.
  - Se borran `launcher-compatible.mjs`, los marcadores
    `registro-version.mjs` / `version-registry.mjs` y `ops/compat/`.
  - Se actualiza el helper del host (`/usr/local/sbin/secondbrain-deploy`)
    en un paso manual único y documentado.
- **P2 Contrato real con las CLIs en CI.**
  - Manifiesto `ops/agents/versions.json` con las versiones fijadas. El
    host instala exactamente esas.
  - Un job de CI instala esas versiones y valida, sin cuenta, los
    argumentos que genera el launcher: `codex app-server` con nuestros
    `-c` y `--print-startup-config`, `claude --mcp-config` y el `initialize`
    de ACP.
  - Dependabot propone las subidas, y el job las prueba antes del merge.
    Con esto, #53 se habría detectado en CI.
- **P3 Imagen del service.**
  - El `Dockerfile` pasa a ser multi-módulo (`service`, `mcp`, `dashboard`,
    `contracts`) sin el launcher, con usuario no root.
  - Healthcheck y SBOM. El job `build` publica
    `ghcr.io/<dueño>/secondbrain@sha256:…`.
  - Smoke del contenedor en CI (ya existe `smoke-container.mjs`).
- **P4 Service en Podman en el LXC.**
  - Unidad Quadlet `secondbrain.container`.
  - Volúmenes: vault, datos y el socket/puerto del launcher en loopback.
  - Se migran el estado y las credenciales sin perder sesiones de login.
  - `deploy.yml` fija el digest y espera la salud.
  - Rollback probado a propósito (digest anterior).
  - `verificar.sh` comprueba la imagen activa. Se retira el flujo
    `releases/<sha>` del service.
- **P5 Nombres del servidor en inglés (host).**
  - **Rutas:**
    - `/var/lib/sb-agente/estado/lanzador` → `/var/lib/sb-agent/state/launcher`;
    - `/srv/sb-agente/proyectos` → `/srv/sb-agent/projects`;
    - `entregables` → `deliverables`.
  - **Unidades:**
    - `secondbrain-lanzador` → `secondbrain-launcher`;
    - `resumen-matutino` → `morning-summary`;
    - `secondbrain-aviso@` → `secondbrain-notify@`.
  - **Scripts:**
    - `aprovisionar`, `verificar`, `conectar` → `provision`, `verify`, `connect`;
    - `agregar-repo` → `add-repo`;
    - `enviar-aviso` → `send-notice`;
    - `estado-pc` y `prender-pc` → `pc-status` y `pc-wake`;
    - carpetas `dentro/` y `plantillas/` → `inside/` y `templates/`.
  - **Release y variables:**
    - la carpeta `lanzador/` de la release → `launcher/`;
    - `SB_LANZADOR_*` → `SB_LAUNCHER_*`;
    - `SB_PROYECTOS_FILE` → `SB_PROJECTS_FILE`;
    - `SB_AGENTE` → `SB_AGENT`;
    - `SB_SKILL_RESUMEN` → `SB_SKILL_SUMMARY`;
    - `ACTIVAR_AUTOMATIZACIONES` → `ENABLE_AUTOMATIONS`.
  - **Mensajes:** los de operador (shell, logs) en inglés.
  - **Migración:** un script único, idempotente y con dry-run por defecto:
    para servicios, mueve, reescribe las unidades y arranca. Durante una
    release, los nombres viejos siguen como alias. Lo que no se renombra es
    la cuenta Unix `sb-agente`; cambiarla rompe sesiones de las CLIs y
    permisos, así que se decide aparte.
- **P6 API y datos en inglés.**
  - **Rutas del service:**
    - `/agentes/*` → `/agents/*`;
    - `/sala/*` → `/room/*`;
    - `/solicitudes/*` → `/requests/*`;
    - `/efectos/*` → `/effects/*`;
    - `/aprobaciones` → `/approvals`;
    - `/bandeja` → `/inbox`;
    - `/mundo/*` → `/world/*`;
    - `/oauth/clientes` → `/oauth/clients`.
  - **Rutas del launcher:** `/estado`, `/capacidades`, `/proyectos`,
    `/modelos`, `/uso`, `/espacios`, `/herramientas/*`.
  - **Claves JSON** (`espacios.json`: `revision/vinculos`, campos de
    respuesta).
  - Las rutas viejas responden como alias con cabecera `Deprecation` durante
    una release. Políticas de `routes.mjs`, dashboard, MCP y docs en el mismo
    PR. El texto de la UI sigue en español.
- **P7 Retirar alias** y extender `ops/naming.mjs` a rutas HTTP, variables
  `SB_*`, nombres de archivo de `ops/` y unidades systemd. CI falla si
  aparece un nombre nuevo en español fuera del texto de UI.

**Verificación de la fase**

- Un deploy desde cero en un LXC nuevo con `instalar.sh` + tag.
- Un deploy de actualización.
- Un rollback forzado (healthcheck roto a propósito).
- `verificar.sh` en verde tras cada uno, sin pasos manuales.
- La e2e con Codex y con Claude contra el LXC.

### Fase B — multiagente

- **B1 Flujos**: `FlowTemplate`, plantillas "Un agente" y "Planificar → Implementar → Revisar"; etapas congeladas al crear; selector por etapa.
- **B2 Traspaso autónomo**: `thread_handoff {toStage, narrative, openItems}` validado contra reglas; brief = diffstat, comandos con exit code, tests fallidos, errores, archivos + narrativa; controlador nuevo; item `handoff` + aviso.
- **B3 Revisión cruzada**: etapa de revisión con otro agente en solo lectura; `thread_report_review`; `changes-requested` vuelve al implementador; 3 rondas / `maxTurns` → `needs-decision`.
- **B4 Sub-tareas**: `thread_request_subtask` → request de aprobación; worktree hijo desde la rama del padre; `thread_integrate_subtask` con detección de conflictos (idea de `teams.mjs integrar`).
- **B5 Uso**: `usage-tracker.ts` persiste rate limits de A4; `usage.mjs` lee `usage_snapshots` (+ fallback Codex) y se elimina el status-line; MCP `agent_usage`; reinicios visibles en `UsageBars`.

### Fase C — avisos y Discord

- **C1 Dispatcher**: el service se suscribe al feed global → outbox; reglas: request abierta, needs-decision, ready-for-review, failed, handoff; badge de bandeja en el HUD.
- **C2 Web push**: `web-push` + VAPID en archivo de secretos; `/api/v1/push/subscriptions`; `public/sw.js` con `push` y `notificationclick` → `/threads/:id`; opt-in en ajustes.
- **C3 Refugio**: estado por personaje desde threads (trabajando, esperando, revisión, listo); clic abre el thread; nunca inventa trabajo.
- **C4 Esqueleto `discord/`**: `discord/src/{index,client,api,links-store,auth}.ts` con `discord.js`; filtro por ID del dueño; unidad `ops/discord/secondbrain-discord.service`, token en `/etc/secondbrain/discord.env` (0600); añadir a `package-release`, `configure.mjs`, `check-drift.sh`, `deploy-release.sh` (sin reiniciar si la unidad no existe).
- **C5 Interacciones**: un hilo de Discord por thread con items resumidos; botones/modales para aprobar, responder, formularios, steer; `/new`; merge/PR enlazan a la app.

### Fase D — resumen diario

- **D1** `/api/v1/summary/daily` + post 08:00 America/Mexico_City en #resumen (planificador en proceso, recupera ejecuciones perdidas): threads hechos/en curso/bloqueados, uso/coste por agente, decisiones pendientes por antigüedad con botones, higiene (threads inactivos, worktrees huérfanos vs DB, disco del LXC).
- **D2** Sugerencias: thread scratch de solo lectura con modelo barato de suscripción (Claude Haiku / Codex mini) → 1–3 sugerencias estructuradas con botón "encargar".

## Reutilizar

`createCheckpoints` (`launcher/checkpoints.mjs:49`), `createPrClient` (`launcher/pr.mjs:146`), `createGit` (`launcher/git.mjs`), `environmentOf`/`effortEnvironment`/`validateEngineAttachments`/`CAPABILITIES` (`launcher/engines.mjs`), `createModelCatalog` (`models.mjs`), `sanitizeChildEnv`/`cleanMemberWorkspace` (`execution/process-tools.mjs`), `buildMcpConfigForProfile`/`materializeSkillsForSession`/`narrowChildProfile` (`tool-catalog.mjs`), `sessionCommand`/`stopSessionScope` (`limits.mjs`), `openWorkspaces` (`workspaces.mjs`), `provider-rpc.mjs`, `user-requests.mjs` (campo `origin`), capacidades `sbcap_` (`service/auth.mjs`); dashboard: `Markdown`, `Modal`, `useConfirmation`, `api()`, `throttled`, `upload.ts`, `splitPatch`/`lineKind`, `approval-receipts.newRequestId`, tokens de `styles/refuge.css`.

## Riesgos y mitigaciones

1. `SB_MAX_ACTIVOS=2` frente a revisión/sub-tareas → cola con prioridad (turnos del usuario > revisiones > sub-tareas), estado visible "esperando capacidad", el traspaso libera el slot antes.
2. `MemoryMax=3G` → controladores ociosos con TTL; `npm ci` dentro del scope del turno; medir `MemoryCurrent` en e2e.
3. Coste de `npm ci` por worktree → caché compartida, `--prefer-offline`, setup solo si hay lockfile.
4. Steer en Claude SDK → si A0 falla, "encolar e interrumpir en el siguiente límite de herramienta" y la UI lo dice.
5. `node:sqlite` → acceso solo vía `store/db.ts`, un escritor, `VACUUM INTO` nocturno.
6. TS en release → imports relativos, `contracts` como módulo de release, fallback de strip-types.
7. Compatibilidad del helper de deploy (ADR 0008) → marcador estático, shim `server/lanzador.mjs`, borrado de datos antes del primer deploy de threads; test con helper viejo.
8. "Auto en worktree" no es aislamiento → documentarlo; aprobaciones solo de lo interceptable (Codex/ACP, `canUseTool`).
9. Discord sin restricción (riesgo aceptado) → filtro por ID, credencial loopback, denegación dura de close/merge/ajustes.
10. Borrado grande → A5–A8 aterrizan detrás de entrada de nav; A9/A10 solo tras checklist e2e; rollback con el symlink del release.

## Verificación

- Por PR: `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:api`, `npm run test:ops`; CI con coverage, build, package y suites Playwright.
- Launcher: `node --test` con CLIs falsos, repos sintéticos, SQLite temporal, test replay-log == proyección.
- Service: completitud de políticas, resume del stream proxy, deny-list de la credencial `bot`.
- Dashboard: vitest (reducer, resume, items) + `verify-threads.mjs` en 375 px y escritorio: bandeja → responder, steer, revisar diff, crear, cerrar por PR y por merge.
- E2E en el LXC tras A9/A10: crear thread de repo en un repo de prueba, turno con Codex, steer, revisar diff, merge local, archivar; comprobar limpieza de worktree/rama, scopes systemd y nftables; `ops/verify-runtime.mjs`. Fase B/C/D: flujo Plan→Implementar→Revisar con fakes y con un agente real barato; push en móvil; aprobar desde Discord; resumen 08:00 forzado manualmente.
  </pasted_content id="2fcb">
