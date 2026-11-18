# Configuration

All settings are environment variables. In the container they are set by
the systemd units in `ops/lxc/plantillas/` and by host-only files under
`/etc/secondbrain/`. No setting belongs in the repository.

## service

| Variable | Default | Purpose |
| --- | --- | --- |
| `VAULT_ROOT` | `/srv/secondbrain/vault` | Folder with the Markdown vault |
| `DATA_DIR` | `.data` next to the app | Auth, journal, history, briefcase, approvals |
| `API_PORT` / `PORT` | `5080` | HTTP port (`8080` in the container) |
| `HOST` | `127.0.0.1` | Bind address |
| `AUTH` | on when `NODE_ENV=production` | `on` requires login; local development is passwordless |
| `TRUSTED_PROXY` | `127.0.0.1` | Proxy address allowed to set `X-Forwarded-*` |
| `VAULT_GIT` | off | `on` commits confirmed transactions with isomorphic-git |
| `SERVE_DASHBOARD` | on | `off` runs the API without serving the built dashboard |
| `WEB_ROOT` | `dashboard/dist` | Folder with the built dashboard |
| `SHARED_DIR` | `DATA_DIR/shared` | Briefcase (files shared with agents) |
| `HISTORY_DAYS` | `90` | Retention of note history |
| `TZ_APP` | `America/Mexico_City` | Time zone for dates, reminders and finance |
| `SB_OWNER_NAME` | empty | Display name used in greetings and agent instructions |
| `SB_REFERENCE_BANK` | empty | Optional JSON file with reference images for the refuge |
| `LANZADOR_URL` | empty | Agent runner URL (loopback); empty disables agents |
| `LANZADOR_TOKEN_FILE` | empty | Bearer token file for the runner |
| `AGENTES_TOKEN_FILE`, `AGENTES_BRAIN_TOKEN_FILE` | empty | Hashes of the scoped agent credentials |
| `SB_ALLOW_BILLED_DEEPSEEK` | off | `1` allows delegating to the pay-per-token provider |
| `MUNDO_PAQUETE` | empty | Path to a published video package shown in the "world" panel |

## mcp

| Variable | Default | Purpose |
| --- | --- | --- |
| `SB_BRAIN_URL` | `http://127.0.0.1:8080/api/v1` | Service API |
| `SB_BRAIN_TOKEN_FILE` | per-user default | Bearer token for the API |
| `SB_OWNER_NAME` | `tu usuario` | Name used in tool descriptions |

## lanzador

| Variable | Default | Purpose |
| --- | --- | --- |
| `SB_LANZADOR_PORT` | `8092` | Loopback control port |
| `SB_LANZADOR_DATA_DIR` | required, absolute | Sessions, conversations, checkpoints |
| `SB_CONTROL_HASH_FILE`, `SB_HOOK_HASH_FILE` | required | Hashes of the control and hook tokens |
| `SB_PROYECTOS_FILE` | required | JSON catalog of repositories agents may work on |
| `SB_AGY_ACP_BIN`, `SB_AGY_ACP_ARGS` | `agy`, `["acp"]` | Antigravity ACP command (operator only) |

Session and team limits (active sessions, members, depth) are read by
`lanzador/limits.mjs`; see [ADR 0005](adr/0005-team-manifests.md).

## dashboard (build time)

| Variable | Purpose |
| --- | --- |
| `VITE_BASE` | Public base path (`/SecondBrain/` on GitHub Pages) |
| `VITE_DEMO` | `1` builds the static demo with synthetic data |
| `VITE_DEFAULT_LANG` | `es` or `en`; users can switch in Settings or with `?lang=` |

## Host files (`/etc/secondbrain/`)

| File | Keys | Used by |
| --- | --- | --- |
| `backup.env` | `VAULT_ROOT`, `DATA_DIR`, `RESTIC_REPOSITORY`, `RESTIC_PASSWORD_FILE` | `secondbrain-backup.timer` |
| `aviso.env` | `AVISO_URL`, `AVISO_FORMATO` | Failure alerts (ntfy or webhook) |
| `ops.env` | `PROXY_IP`, `GATEWAY`, `AGENTE_UID` | Rendering units and nftables |
| `health-url` | public health URL | Deployment helper |

Each file is `root:root 0600`; a missing file disables that feature.
