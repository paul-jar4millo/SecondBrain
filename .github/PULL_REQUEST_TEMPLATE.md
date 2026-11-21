## What and why

<!-- One or two sentences: the problem and the change. Link the issue: "Closes #123". -->

## How it was verified

- [ ] `npm test` and `npm run test:api`
- [ ] `npm run lint`, `npm run format:check` and `npm run typecheck`
- [ ] Browser suites (`npm --prefix dashboard run verify:browser`) for UI changes
- [ ] Docs updated where behavior changed

## Checklist

- [ ] The title follows Conventional Commits (`type(scope): description`)
- [ ] A hard-to-reverse decision has an ADR in `docs/adr/`
- [ ] New user-facing strings are in both `dashboard/src/i18n/` dictionaries
- [ ] No vault content, credentials, host names, IPs or personal data

## Notes for the reviewer

<!-- Risks, follow-ups, screenshots for visual changes. -->
