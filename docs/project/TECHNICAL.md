# Worldrawing — Technical Overview

## Architecture

Worldrawing is a Next.js + React + TypeScript application.

The codebase follows a feature-oriented structure, with the main domains separated into:

- map
- drawing
- game
- population

Keep domain responsibilities separate. Avoid generic abstractions unless they are genuinely shared.

## Map

MapLibre is responsible for map rendering, camera interaction, projections, and geographic coordinate conversion.

The map provider/style should remain replaceable without affecting game or population logic.

## Drawing

Drawing is implemented as a custom interaction system rather than a GIS editing workflow.

A drawing is represented by a stable ID and an ordered outline of geographic coordinates.

The drawing system owns:

- freehand input
- open/closed drawing state
- moving drawings
- reshaping drawings
- deletion
- overlap validation

Drawings must remain geographically anchored through pan and zoom.

The drawing representation should remain simple and should not duplicate authoritative geometry unnecessarily.

## Submission boundary

Drawings remain game-domain objects while the player edits them.

When a round is submitted, the current closed drawings are converted into GeoJSON polygons for population calculation.

Each submitted shape must retain its stable ID.

Multiple shapes must remain separate through the request/response pipeline.

## Population

Population calculation is accessed through a server-side application boundary.

The frontend should depend on the population contract, not on a specific population data provider.

Conceptually:

```text
game/drawing
    ↓
population API
    ↓
population provider
    ↓
population dataset/service