# HTTP API

`service` exposes a JSON API under `/api/v1`. The route table is
`service/routes.mjs`; each route declares whether it is public, whether agent
("room") credentials may call it, and a [Zod](https://zod.dev) schema for its
body. Unknown routes return `404`; invalid bodies return `400`.

## Authentication

| Caller                                   | Credential                                               | Notes                                                                          |
| ---------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Browser                                  | `sb.session` cookie (HttpOnly, Secure, SameSite)         | State-changing requests also need `X-CSRF-Token` from `GET /auth/csrf`         |
| MCP / `brain` CLI on the owner's machine | Bearer token                                             | Full owner access                                                              |
| Agent sessions                           | Bearer "room credential"                                 | Only routes marked **room** below; cannot manage auth or edit vault rule files |
| Remote MCP clients                       | OAuth 2.1 access token (PKCE S256, dynamic registration) | See [MCP tools](mcp-tools.md#remote-access)                                    |

Login supports a password and optional TOTP. Requests are rate-limited per
client and per IP for token exchanges.

## Conventions

- **Optimistic concurrency.** Note writes send `expectedHash` (SHA-256 of the
  version read; `null` to create). A mismatch returns `409`.
- **Idempotency.** Finance operations, approvals, user requests and effects
  accept a `requestId`; repeating it returns the stored result.
- **Live updates.** `GET /events` is a Server-Sent Events stream of change
  notifications; conversations stream on their own SSE endpoints.
- **Errors** are `{ "error": "<message>" }` with a matching status code.
  Messages are in Spanish, like the UI.

## Endpoints

Legend: **public** = no session; **room** = also callable by agents.

### Health and authentication

| Method | Path                                    |                                                           |
| ------ | --------------------------------------- | --------------------------------------------------------- |
| GET    | `/health`                               | public — availability and maintenance status              |
| GET    | `/auth/status`                          | public — whether setup is done, session state, owner name |
| GET    | `/auth/csrf`                            | public — CSRF token for the session                       |
| POST   | `/auth/setup`                           | public — create the owner account (first run only)        |
| POST   | `/auth/login`                           | public — password (+ TOTP code)                           |
| POST   | `/auth/logout`                          |                                                           |
| POST   | `/auth/totp/start`, `/auth/totp/enable` | Enroll a TOTP authenticator                               |
| GET    | `/oauth/clientes`                       | Remote MCP clients                                        |
| POST   | `/oauth/clientes/revocar`               | Revoke a client                                           |

### Vault and items

| Method | Path            |                                                         |
| ------ | --------------- | ------------------------------------------------------- |
| GET    | `/vault/files`  | room — list note paths                                  |
| GET    | `/vault/note`   | room — read a note and its hash                         |
| POST   | `/vault/note`   | room — write a full note with `expectedHash`            |
| GET    | `/vault/status` | Git and journal status                                  |
| GET    | `/items`        | Tasks, projects, events and ideas parsed from the vault |
| POST   | `/mutations`    | Apply an offline mutation from the dashboard outbox     |
| POST   | `/imports`      | Bulk import (CSV)                                       |
| GET    | `/export`       | Export items                                            |
| GET    | `/events`       | SSE change feed                                         |

### Finance and approvals

| Method | Path                    |                                                       |
| ------ | ----------------------- | ----------------------------------------------------- |
| GET    | `/finance/overview`     | room — accounts, cards, cash-flow, utilization        |
| POST   | `/finance/ops`          | room — structured operation; agents wait for approval |
| GET    | `/finance/ledger`       | Ledger entries                                        |
| GET    | `/aprobaciones`         | Pending and recent approvals                          |
| POST   | `/aprobaciones/decidir` | Approve or reject, with an idempotent receipt         |

### Briefcase (files shared with agents)

| Method | Path                                        |                                                     |
| ------ | ------------------------------------------- | --------------------------------------------------- |
| GET    | `/files`, `/files/download`, `/files/chunk` | room — list, download, read in chunks               |
| POST   | `/files`, `/files/raw`                      | room — upload (JSON or streamed body, up to 100 MB) |
| POST   | `/files/trash`                              | room — move own file to trash                       |
| POST   | `/files/restore`, `/files/pin`              | Owner only                                          |

### Agents (proxied to the launcher)

Threads replaced sessions, teams and work orders
([ADR 0010](adr/0010-threads-replace-sessions.md)); their routes are listed
in [modules/service.md](modules/service.md#threads-adr-0010).

| Method     | Path                                                                |                                            |
| ---------- | ------------------------------------------------------------------- | ------------------------------------------ |
| GET        | `/agentes/modelos-lanzador`, `/agentes/uso`, `/agentes/capacidades` | Models, usage windows, capabilities        |
| GET        | `/agentes/mi-capacidad`                                             | room — capabilities of the calling thread  |
| GET / POST | `/agentes/espacios`                                                 | Project ↔ repository links                 |
| GET        | `/agentes/proyectos-lanzador`                                       | Registered repositories                    |
| GET        | `/agentes/sesiones`                                                 | Always empty; kept for the scene until A10 |
| GET        | `/agentes/herramientas/catalogo`                                    | room — tool and skill catalog              |
| POST       | `/agentes/herramientas/perfiles`                                    | Tool profiles                              |
| POST       | `/agentes/herramientas/skills/resolver`                             | room — resolve skills for a profile        |
| POST       | `/agentes/capacidades/token`                                        | Issue a scoped capability token            |

### Requests and effects

| Method | Path                                                                                   |                                              |
| ------ | -------------------------------------------------------------------------------------- | -------------------------------------------- |
| GET    | `/solicitudes`, `/solicitudes/detalle`                                                 | room — persistent questions to the owner     |
| POST   | `/solicitudes/{preguntar,esperar,aprobacion,cerrar-turno,verificar-ejecucion,entrega}` | room                                         |
| POST   | `/solicitudes/responder`                                                               | Owner answers                                |
| GET    | `/efectos`, `/efectos/detalle`                                                         | room — effects with external consequences    |
| POST   | `/efectos/preparar`, `/efectos/ejecutar`                                               | room — prepare; execute only after approval  |
| POST   | `/efectos/conciliar`                                                                   | Reconcile an effect whose outcome is unknown |

### Refuge and world panel

| Method | Path                                                                       |                                         |
| ------ | -------------------------------------------------------------------------- | --------------------------------------- |
| GET    | `/sala`, `/sala/imagen`                                                    | 3D refuge state and reference images    |
| POST   | `/sala/tablero`, `/sala/encargos`, `/sala/agentes`, `/sala/agentes/borrar` | Boards, room work orders, agent copies  |
| GET    | `/mundo/overview`, `/mundo/document`, `/mundo/media`                       | Published video package                 |
| POST   | `/mundo/briefs`, `/mundo/agents`, `/mundo/tasks`, `/mundo/tasks/status`    | Briefs and tasks for the video pipeline |

## Remote MCP

`/mcp` (Streamable HTTP), `/oauth/*` and `/.well-known/oauth-*` are served by
the same process; see [MCP tools](mcp-tools.md).
