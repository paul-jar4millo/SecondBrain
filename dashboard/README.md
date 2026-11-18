# dashboard

React 19 + Three.js PWA for SecondBrain. See the
[module guide](../docs/modules/dashboard.md), [design](../DESIGN.md) and
[product](../PRODUCT.md).

```sh
npm run setup && npm run dev     # from the repository root
# http://127.0.0.1:5173/?demo=1  synthetic data, no backend
```

Without `VAULT_ROOT` only the interface starts. To try writes, point
`VAULT_ROOT` at a throw-away folder and `DATA_DIR` at another; never copy real
notes. Authentication is off in development unless `AUTH=on`.
