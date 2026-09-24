# Agent Guidelines

Before making changes, read the project documents relevant to the task:

- `docs/project/PROJECT_OVERVIEW.md` for product intent and core game principles.
- `docs/project/TECHNICAL.md` for architecture, boundaries, and technical constraints.
- `docs/project/CURRENT_STATE.md` for the current implementation state and immediate priorities.
- `docs/POPULATION_ENGINE.md` for population-engine work.
- `docs/DEPLOYMENT.md` and `docs/RAILWAY.md` for deployment-related work.

Use these documents as context, not as an exhaustive description of the implementation. Inspect the relevant code before making changes.

Treat the repository and its code as the source of truth whenever documentation and implementation disagree.

Treat task prompts as deltas. Preserve existing behavior unless the requested change requires otherwise.

Keep changes focused. Avoid unrelated refactors, speculative features, and unnecessary abstractions.

`docs/project/` and `docs/POPULATION_ENGINE.md` are intentionally local and git-ignored internal project context. Do not delete, move, restore, stage, or commit them unless explicitly requested.

Update `docs/project/CURRENT_STATE.md` only after meaningful checkpoints and only when explicitly requested.