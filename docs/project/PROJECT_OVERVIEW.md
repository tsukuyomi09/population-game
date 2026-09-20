# Worldrawing — Project Overview

## What is Worldrawing?

Worldrawing is a geography game about estimating population by drawing areas directly on a world map.

The player receives a target population and draws one or more areas that they believe contain approximately that many people.

Population remains hidden while drawing. The result is calculated only when the player submits the attempt.

The core challenge is geographic intuition: understanding where people live, relative population density, settlement patterns, and the amount of territory required to reach a population target.

## Core gameplay

A game consists of multiple rounds.

For each round:

1. The player receives a population target.
2. The player draws one or more areas on the map.
3. The player submits the attempt.
4. The game calculates the population contained by the submitted areas.
5. The player receives a score based on how close the result is to the target.

Scores accumulate across the game into a final result.

## Product principles

### Drawing is the game

Drawing is the primary interaction, not a secondary tool.

It should feel immediate and natural, closer to drawing on a map with a pencil than operating GIS software.

The player should not need to think about polygons, vertices, handles, GeoJSON, or editing modes.

### Direct manipulation

Whenever possible, the player should manipulate what they see directly.

Moving, reshaping, deleting, and creating areas should require minimal intermediate states or controls.

Avoid workflows such as selecting an object only to unlock another interaction unless there is a strong UX reason.

### The map is the canvas

The map exists to support geographic reasoning.

It should remain readable, responsive, and visually useful without distracting from the player's drawings.

### Population stays hidden until submission

No population information should be revealed while the player is drawing.

The game should test geographic judgement rather than allow the player to iteratively tune an area against live numerical feedback.

### Multiple areas are part of the game

A player may use multiple separate areas for the same target.

They should behave as independent drawings during interaction and be evaluated together when submitted.

Overlapping areas should not result in population being counted more than once.

## Product philosophy

The core game should be excellent before additional systems are layered on top.

Features such as competitive modes, daily challenges, leaderboards, progression, social systems, and monetization should support the core geographic game rather than compensate for weak drawing or scoring mechanics.