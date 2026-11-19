# Security policy

## Supported versions

Only the latest release on `main` receives security fixes.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through
[GitHub private vulnerability reporting](../../security/advisories/new)
(the "Report a vulnerability" button in the Security tab).

Include the affected module (`service`, `mcp`, `dashboard`, `lanzador` or
`ops`), the version or commit, reproduction steps and the impact you expect.
You should receive an acknowledgement within 7 days. Fixes are released as a
new version and credited in the advisory unless you prefer otherwise.

## Scope and design notes

SecondBrain is designed for a single owner on a self-hosted machine:

- The service is the only writer of the vault and requires authentication in
  production (password + optional TOTP, CSRF-protected cookies).
- Agents run as a separate unprivileged user, in isolated sessions, with a
  network policy (nftables) that blocks the local network.
- Effects with external consequences (messages, payments) require an explicit
  approval in the UI.
- Deployment only happens from version tags, after a manual approval, on a
  self-hosted runner that never executes code from pull requests.

Reports about these boundaries are especially welcome.
