# Product

SecondBrain lets one person organize projects, tasks, calendar and finances
from a personal space connected to their own Markdown knowledge base, and
delegate work to a small team of AI agents without giving up control.

## Experience

The entry point is a blue 3D loft with a game-like HUD. Tools open over the
scene and keep the user's position. **Projects** is the priority tool.
**Tasks** also collects unsorted ideas; plain notes do not appear in regular
navigation.

A sentence typed in the PromptBar (Create in the HUD) is parsed locally into a
reviewable action. **Finance** can upload screenshots to the briefcase and
prepare a work order for an agent; balances typed by the owner are saved
immediately and the work order only runs when sent. Choosing a character
opens **Team** with its conversation and a project selector; no model runs
until the first message is sent. Team groups history by project and agent,
structured messages and requests from the provider, and approvals. Each
project can link an optional server repository; without one it gets an
isolated workspace.

## Agents

Four base characters represent Claude, Codex, Antigravity and DeepSeek. The
runner executes their CLIs outside the HTTP process. A lead agent decides how
to collaborate through team tools; the refuge represents observed sessions
and events. Copies of the same engine get different colors.

## Data and boundaries

The service writes the Markdown vault with hash revisions and no SQL mirror.
The vault has its own repository. The briefcase and sessions are operational
state, not notes.

Finance privacy applies to figures and charts everywhere, including boards in
the 3D world. Without WebGL every tool stays usable. The "world" panel reads a
published video package; producing videos needs a separate engine.

Design: [DESIGN](DESIGN.md). Technical contracts:
[architecture](docs/architecture/README.md) and [MCP tools](docs/mcp-tools.md).
