# Request flows

## Writing a note with optimistic concurrency

Every client (dashboard, MCP, CLI) reads the note's revision hash and sends it
back with the full new content. The service serializes writes, journals them
before touching the file and commits confirmed transactions to Git.

```mermaid
sequenceDiagram
  autonumber
  participant C as Client (dashboard / MCP)
  participant S as service
  participant J as Journal (DATA_DIR)
  participant V as Vault (Markdown)
  participant G as isomorphic-git

  C->>S: GET /vault/note?path=…
  S->>V: read file
  S-->>C: content + sha256
  C->>S: POST /vault/note {path, content, expectedHash}
  S->>S: queue (one writer)
  S->>V: hash current file
  alt hash differs
    S-->>C: 409 conflict (re-read and reconcile)
  else hash matches
    S->>J: append transaction (fsync)
    S->>V: write temp file + atomic rename
    S->>J: mark committed
    S-->>C: 200 {hash}
    S-)G: commit transaction (VAULT_GIT=on)
    Note over G: a timer pushes to the private<br/>remote every 10 minutes
  end
```

If the process stops between steps, the journal is replayed on start-up. A
failing Git commit is logged and never undoes a saved note.

## Running an agent in an isolated session

```mermaid
sequenceDiagram
  autonumber
  participant D as dashboard
  participant S as service
  participant L as lanzador (sb-agente)
  participant P as Provider controller
  participant CLI as Agent CLI
  participant M as brain CLI (MCP)

  D->>S: POST /agentes/sesiones {agent, project, brief}
  S->>L: POST /sesiones (loopback, bearer)
  L->>L: create workspace / worktree, checkpoint (git refs)
  L->>P: start(controller for codex · claude · acp)
  P->>CLI: spawn with allow-listed env and MCP config
  CLI->>M: brain_read / brain_search (scoped token)
  M->>S: HTTP /api/v1 (room credential)
  CLI-->>P: events (messages, tool calls, questions)
  P-->>L: normalized conversation items
  L-->>S: SSE
  S-->>D: GET /agentes/conversacion/stream (SSE)
  D->>S: POST /agentes/conversacion/responder (answer)
  S->>L: forward answer (idempotent requestId)
```

The HTTP service never runs a model. Each turn ends its process; the next
message resumes the provider's native session id.

## Approving an agent's finance operation

```mermaid
sequenceDiagram
  autonumber
  participant A as Agent (room credential)
  participant S as service
  participant Q as Approvals (DATA_DIR)
  participant D as dashboard (owner)
  participant F as Finance ledger (vault)

  A->>S: POST /finance/ops {op, requestId}
  S->>S: validate; a repeated requestId returns the earlier result
  S->>Q: create pending approval (expires in 30 min)
  Note over A,S: the agent's request stays open<br/>until the owner decides
  S-->>D: change event (SSE)
  D->>S: POST /aprobaciones/decidir {id, approve, requestId}
  S->>Q: store decision + receipt (one JSON line)
  S-->>D: receipt {decision, by, ts}
  alt approved
    S->>F: apply operation (idempotent by requestId)
    S->>Q: finalize ("applied")
    S-->>A: 200 result
  else rejected or expired
    S-->>A: 403 not approved
  end
  Note over D,S: Repeating the same decision requestId returns<br/>the same receipt with repetido: true
```
