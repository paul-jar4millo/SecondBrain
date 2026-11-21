# Container install (Proxmox VE)

`ops/lxc` installs SecondBrain into a Debian container with reproducible
settings. Values live in `lxc.env` (copy `lxc.env.example`; git-ignored, no
secrets). The full guide is [docs/deployment.md](../../docs/deployment.md).

| File                  | Responsibility                                      |
| --------------------- | --------------------------------------------------- |
| `install.sh`          | Build, create or reuse, provision and verify        |
| `host/create-lxc.sh`  | Create the container; never deletes an existing one |
| `inside/provision.sh` | Base system, vault, deployment and runner stages    |
| `inside/connect.sh`   | Connect provider accounts interactively             |
| `inside/verify.sh`    | Check services, network rules and accounts          |
| `templates/`          | systemd units and nftables rules                    |

```sh
cp ops/lxc/lxc.env.example ops/lxc/lxc.env
npm run setup
bash ops/lxc/install.sh            # from Git Bash or any POSIX shell
```

- `--reusar` provisions an existing container. It is not a routine
  deployment; review each stage before running it on production.
- The vault is cloned from `REPO_VAULT` only during an authorized install.
  Never `checkout`, `pull` or `reset` the live copy.
- Provider accounts are connected by hand inside the container; the runner is
  registered with a short-lived token read from stdin. The vault deploy key is
  separate and never part of the software.
- Rehearse with a copy of `lxc.env` using a free VMID and IP, and empty
  `REPO_VAULT`, `RUNNER_NOMBRE` and `HEALTH_PUBLICO`. Never reuse the
  production VMID for a rehearsal.
- The reverse proxy is not created here.
