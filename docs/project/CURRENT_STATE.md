# Worldrawing — Current State

**Last updated:** 2026-09-20

## Current status

The core game is playable end to end.

Active development branch: `dev`.

Latest major checkpoint:

`perf: add target-aware hybrid population calculation`

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

The local population engine is now validated end to end and can replace the WorldPop API at runtime.

Current architecture:

- `/api/population` contract remains unchanged externally.
- Provider selection is environment-driven; WorldPop remains available as reference/fallback.
- Local mode discovers compatible WorldPop 2026 constrained 100 m country rasters automatically.
- Multi-country and cross-border shapes are supported.
- Population raster values are summed locally; no WorldPop request is required in local mode.
- Raster data stays outside Git.

Performance architecture:

- Country rasters are preaggregated into 512×512-pixel tile totals.
- Fully-inside tiles use cached totals.
- Only boundary tiles touch the original 100 m raster.
- Boundary rasters are processed concurrently with bounded workers.
- Tile indexes are persisted, validated, and rebuilt when stale.

Boundary calculation is target-aware:

- target < 20,000,000 → fractional exactextract
- target >= 20,000,000 → pixel-center inclusion

This rule was chosen for gameplay performance, not maximum GIS precision. Benchmarks showed that center inclusion changes the score by at most 1 point out of 10,000 in the tested high-target cases.

Validated local data currently includes eight European country rasters: Italy, Switzerland, France, Germany, Austria, Spain, Belgium, and the Netherlands.

Recent in-game local benchmarks with warm indexes were approximately 270–374 ms for tested single-shape submissions using the hybrid engine. Earlier large-Europe full-fractional calculation was reduced from several seconds to sub-second tiled processing.

## Main blocker

The WorldPop API is no longer the architectural blocker.

The remaining population-engine work is operational scale:

- acquire and manage global 2026 100 m country rasters
- generate/maintain tile indexes for global coverage
- choose production storage/cache/deployment architecture
- benchmark real server hardware and concurrent users

## Next milestone

Expand the validated local engine from the current eight-country dataset to global coverage without changing the population API or gameplay.

Initial production direction:

- country GeoTIFF/COG files stored server-side/object storage, not in the application repository
- cached/precomputed tile indexes
- population service with fast access to the required rasters
- keep WorldPop only as a validation/reference path until the local engine is fully deployed

## Later

After population calculation works without external API limits, return to gameplay/UI refinement, result presentation, map polish, and later game modes.

## Immediate next task

Population engine: move from the current eight-country validation set toward global raster coverage and production deployment.

The Tailwind CSS + shadcn/ui foundation migration is already complete. The actual visual redesign of the HUD, results, controls, overlays, and game identity remains a later product/UI phase.
