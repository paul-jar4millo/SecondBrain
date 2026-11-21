# Documentation

Technical documentation is in English; the product UI is Spanish by default.
Start with the architecture, then read the decision records for the "why".

## Understand the system

| Document                                          | What it covers                                                         |
| ------------------------------------------------- | ---------------------------------------------------------------------- |
| [Architecture](architecture/README.md)            | C4 context and containers, key properties, who owns which data         |
| [Request flows](architecture/sequences.md)        | Writing a note, running an agent in a thread, approving a finance step |
| [Decision records](adr/README.md)                 | Every hard-to-reverse choice, with options and consequences            |
| [Roadmap](roadmap.md)                             | What shipped by phase and what comes next                              |
| [Product](../PRODUCT.md) · [Design](../DESIGN.md) | What the app is for and how it looks                                   |

## Modules

| Module                           | Guide                                                   | Rules for contributors              |
| -------------------------------- | ------------------------------------------------------- | ----------------------------------- |
| `service` — API and vault writer | [service](modules/service.md)                           | [AGENTS.md](../service/AGENTS.md)   |
| `mcp` — MCP adapter and CLI      | [mcp](modules/mcp.md)                                   | [AGENTS.md](../mcp/AGENTS.md)       |
| `launcher` — agent thread runner | [launcher](modules/launcher.md)                         | [AGENTS.md](../launcher/AGENTS.md)  |
| `dashboard` — PWA and 3D refuge  | [dashboard](modules/dashboard.md)                       | [AGENTS.md](../dashboard/AGENTS.md) |
| `contracts` — shared Zod schemas | [ADR 0011](adr/0011-native-typescript-and-contracts.md) | [AGENTS.md](../contracts/AGENTS.md) |
| `ops` — packaging and hosting    | [deployment](deployment.md)                             | [root AGENTS.md](../AGENTS.md)      |

## Interfaces

| Document                          | What it covers                                                   |
| --------------------------------- | ---------------------------------------------------------------- |
| [HTTP API](api.md)                | `/api/v1` routes, credentials, conventions                       |
| [MCP tools](mcp-tools.md)         | Transports, tools, writing rules for agents, remote OAuth access |
| [Configuration](configuration.md) | Environment variables and host files                             |

## Run and operate

| Document                                          | What it covers                                        |
| ------------------------------------------------- | ----------------------------------------------------- |
| [Deployment](deployment.md)                       | Docker Compose, the full Proxmox VE container install |
| [Operations](operations.md)                       | Health, backups, alerts, rollback, recovering a note  |
| [CI/CD](ci-cd.md)                                 | Workflows, coverage floors, releases                  |
| [Host layout migration](host-layout-migration.md) | One-time move of an older host to the English layout  |
| [Agent CLI pins](../ops/agents/README.md)         | Installing and checking the pinned agent CLIs         |

## Contributing

[CONTRIBUTING](../CONTRIBUTING.md) (setup, checks, commit format, language,
when to write an ADR), [security policy](../SECURITY.md) and
[code of conduct](../CODE_OF_CONDUCT.md).
