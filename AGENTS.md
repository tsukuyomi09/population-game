# Agent Guidelines

Before making changes, read the project documents relevant to the task:

- `docs/project/PROJECT_OVERVIEW.md` for product intent and core game principles.
- `docs/project/TECHNICAL.md` for architecture, boundaries, and technical constraints.
- `docs/project/CURRENT_STATE.md` for the current implementation state and immediate priorities.
- `docs/project/WORLDRAWING_DOCUMENTATION_GUIDELINES.md` when creating or updating project documentation.
- `docs/POPULATION_ENGINE.md` for population-engine work.
- `docs/DEPLOYMENT.md` and `docs/RAILWAY.md` for deployment-related work.

Use these documents as context, not as an exhaustive description of the implementation. Inspect the relevant code before making changes.

Treat the repository and its code as the source of truth whenever documentation and implementation disagree.

Treat task prompts as deltas. Preserve existing behavior unless the requested change requires otherwise.

Keep changes focused. Avoid unrelated refactors, speculative features, and unnecessary abstractions.

`docs/project/` and `docs/POPULATION_ENGINE.md` are intentionally local and git-ignored internal project context. Do not delete, move, restore, stage, or commit them unless explicitly requested.

Update `docs/project/CURRENT_STATE.md` only after meaningful checkpoints and only when explicitly requested.

When updating documentation, follow `docs/project/WORLDRAWING_DOCUMENTATION_GUIDELINES.md`. Determine the changed truths first, map each one to its canonical owner, update only affected documents, and remove superseded statements rather than preserving stale history.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
