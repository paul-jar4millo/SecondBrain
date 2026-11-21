# Configuration

All settings are environment variables. In the container they are set by
the systemd units in `ops/lxc/templates/` and by host-only files under
`/etc/secondbrain/`. No setting belongs in the repository.

## service

| Variable                                         | Default                       | Purpose                                                      |
| ------------------------------------------------ | ----------------------------- | ------------------------------------------------------------ |
| `VAULT_ROOT`                                     | `/srv/secondbrain/vault`      | Folder with the Markdown vault                               |
| `DATA_DIR`                                       | `.data` next to the app       | Auth, journal, history, briefcase, approvals                 |
| `API_PORT` / `PORT`                              | `5080`                        | HTTP port (`8080` in the container)                          |
| `HOST`                                           | `127.0.0.1`                   | Bind address                                                 |
| `AUTH`                                           | on when `NODE_ENV=production` | `on` requires login; local development is passwordless       |
| `TRUSTED_PROXY`                                  | `127.0.0.1`                   | Proxy address allowed to set `X-Forwarded-*`                 |
| `VAULT_GIT`                                      | off                           | `on` commits confirmed transactions with isomorphic-git      |
| `SERVE_DASHBOARD`                                | on                            | `off` runs the API without serving the built dashboard       |
| `WEB_ROOT`                                       | `dashboard/dist`              | Folder with the built dashboard                              |
| `SHARED_DIR`                                     | `DATA_DIR/shared`             | Briefcase (files shared with agents)                         |
| `HISTORY_DAYS`                                   | `90`                          | Retention of note history                                    |
| `TZ_APP`                                         | `America/Mexico_City`         | Time zone for dates, reminders and finance                   |
| `SB_OWNER_NAME`                                  | empty                         | Display name used in greetings and agent instructions        |
| `SB_REFERENCE_BANK`                              | empty                         | Optional JSON file with reference images for the refuge      |
| `SB_LAUNCHER_URL`                                | empty                         | Agent runner URL (loopback); empty disables agents           |
| `SB_LAUNCHER_TOKEN_FILE`                         | empty                         | Bearer token file for the runner                             |
| `AGENTES_TOKEN_FILE`, `AGENTES_BRAIN_TOKEN_FILE` | empty                         | Hashes of the scoped agent credentials                       |
| `SB_ALLOW_BILLED_DEEPSEEK`                       | off                           | `1` allows delegating to the pay-per-token provider          |
| `MUNDO_PAQUETE`                                  | empty                         | Path to a published video package shown in the "world" panel |

## mcp

| Variable              | Default                        | Purpose                        |
| --------------------- | ------------------------------ | ------------------------------ |
| `SB_BRAIN_URL`        | `http://127.0.0.1:8080/api/v1` | Service API                    |
| `SB_BRAIN_TOKEN_FILE` | per-user default               | Bearer token for the API       |
| `SB_OWNER_NAME`       | `tu usuario`                   | Name used in tool descriptions |

## launcher

| Variable                            | Default            | Purpose                                           |
| ----------------------------------- | ------------------ | ------------------------------------------------- |
| `SB_LAUNCHER_PORT`                  | `8092`             | Loopback control port                             |
| `SB_LAUNCHER_DATA_DIR`              | required, absolute | `threads.sqlite` and per-thread state             |
| `SB_CONTROL_HASH_FILE`              | required           | Hash of the control token                         |
| `SB_PROJECTS_FILE`                  | required           | JSON catalog of repositories agents may work on   |
| `SB_AGY_ACP_BIN`, `SB_AGY_ACP_ARGS` | `agy`, `["acp"]`   | Antigravity ACP command (operator only)           |
| `SB_MAX_ACTIVE_TURNS`               | `6` (max 16)       | Concurrent thread turns (scheduler slots)         |
| `SB_SESSION_SCOPES`                 | off                | `1` runs each turn in its own `systemd-run` scope |

Limits are read by `launcher/limits.mjs`. The two Spanish variable names are
older than the naming check and are scheduled to be renamed.

## dashboard (build time)

| Variable            | Purpose                                                     |
| ------------------- | ----------------------------------------------------------- |
| `VITE_BASE`         | Public base path (`/SecondBrain/` on GitHub Pages)          |
| `VITE_DEMO`         | `1` builds the static demo with synthetic data              |
| `VITE_DEFAULT_LANG` | `es` or `en`; users can switch in Settings or with `?lang=` |

## Host files (`/etc/secondbrain/`)

| File         | Keys                                                                  | Used by                          |
| ------------ | --------------------------------------------------------------------- | -------------------------------- |
| `backup.env` | `VAULT_ROOT`, `DATA_DIR`, `RESTIC_REPOSITORY`, `RESTIC_PASSWORD_FILE` | `secondbrain-backup.timer`       |
| `aviso.env`  | `AVISO_URL`, `AVISO_FORMATO`                                          | Failure alerts (ntfy or webhook) |
| `ops.env`    | `PROXY_IP`, `GATEWAY`, `AGENTE_UID`                                   | Rendering units and nftables     |
| `health-url` | public health URL                                                     | Deployment helper                |

Each file is `root:root 0600`; a missing file disables that feature.
