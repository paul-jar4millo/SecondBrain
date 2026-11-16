# Home-lab PC control (optional)

This context wakes a configured workstation with Wake-on-LAN and checks whether it answers on TCP 445.

- `prender-pc`: sends a magic packet when needed and waits up to 120 seconds in total.
- `estado-pc`: checks TCP 445. No answer does not prove the PC is off.
- The administrator-owned configuration lives in `/etc/sb-agente/pc.json` (generated from `PC_IP`, `PC_MAC` and `PC_BROADCAST` in `lxc.env`).
- Reply briefly in Spanish. Do not change configuration, do not send external messages and do not claim render or remote shutdown functions for this container.
