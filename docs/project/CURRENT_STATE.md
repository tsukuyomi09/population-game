# Worldrawing — Current State

**Last updated:** 2026-09-20

## Current status

The core game is playable end to end.

Active development branch: `dev`.

Latest major checkpoint:

`refactor: replace Terra Draw with custom drawing and shape editing`

## Working

### Game

- 5-round game flow is complete.
- Each round receives a server-generated population target.
- Targets currently range from 1,000 to 1,000,000,000 using five probability bands.
- Submit calculates the selected population and round score.
- Each round awards 0–10,000 points.
- Final score is out of 50,000.
- Abandon and End Game correctly reset the game.

### Map

- MapLibre is working with the current OpenFreeMap basemap.
- 2D / Globe switching works.
- 2D is currently preferred.

### Drawing

Terra Draw has been removed. Drawing and editing are now custom.

Current interaction:

- Hold Space to draw freehand.
- Unfinished strokes can be paused and resumed.
- Closing a stroke creates a filled shape.
- Multiple independent shapes are supported.
- Shapes cannot overlap.
- Space + drag inside a shape moves it directly.
- Right-click inside a shape opens Delete.
- Hovering a border exposes local editing.
- Left-dragging the border performs smooth deformation.
- No vertex handles or select-first workflow.

The full game flow has been tested successfully with the custom drawing system.

### Population

`POST /api/population` currently uses the WorldPop API and returns real population data.

Normal-size selections work correctly.

## Main blocker

The external WorldPop API cannot support the full game.

Large valid selections such as continental-scale areas exceed its polygon-area limits, and its request quota is unsuitable for production.

This is now the main technical blocker.

## Next milestone

Replace the external WorldPop calculation with our own population calculation while preserving the existing `/api/population` contract.

First step:

- use one WorldPop 2026 100 m GeoTIFF, initially Italy
- calculate population locally for a submitted polygon
- compare the result with the current WorldPop API
- do not change the frontend contract

If validated, expand the solution to multiple rasters and eventually global coverage.

## Later

After population calculation works without external API limits, return to gameplay/UI refinement, result presentation, map polish, and later game modes.

## Immediate next task

Improve the frontend UI foundation.

The current UI is still mostly custom React + CSS and is visually provisional.

Next:
- introduce Tailwind CSS
- introduce shadcn/ui for reusable UI primitives
- migrate the existing UI away from legacy custom styling
- remove obsolete application CSS after migration
- preserve MapLibre-required/global CSS
- keep all gameplay and interactions unchanged during the migration

This first step is infrastructure only, not the visual redesign itself.

After the migration, redesign the game HUD, score/results, controls, buttons, overlays, and interaction feedback with a cohesive game-oriented visual language.

Use shadcn as infrastructure, not as a default SaaS/dashboard aesthetic.
