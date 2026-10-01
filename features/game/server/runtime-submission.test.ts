import assert from "node:assert/strict";
import test from "node:test";
import type { PopulationShape } from "../../population/types";
import { registeredRuntimePlayer } from "../runtime-player";
import { RuntimeGame } from "./runtime-game";
import { resolveRuntimeSubmission } from "./runtime-submission";

const startedAt = new Date("2026-01-01T00:00:00.000Z");
const deadline = new Date("2026-01-01T00:01:00.000Z");
const player = registeredRuntimePlayer("user-1");
const currentDrawing: PopulationShape[] = [
  {
    id: "current",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [0, 1],
          [0, 0],
        ],
      ],
    },
  },
];

test("timeout request waits for the client drawing submission", async () => {
  const game = new RuntimeGame({
    runtimeGameId: "game-1",
    type: "SINGLE",
    difficulty: "EASY",
    players: [player],
    roundDurationMs: 60_000,
    finalWindowMs: 10_000,
    resultPhaseDurationMs: 4_000,
    generateTarget: () => 1_000,
  });
  game.start(startedAt);

  const request = game.timeoutSubmissionRequest(player, 1, deadline);
  assert.ok(request);
  assert.deepEqual(request, {
    runtimeGameId: "game-1",
    runtimePlayerId: player.runtimePlayerId,
    roundNumber: 1,
    submissionType: "TIMEOUT",
    requestedAt: deadline,
  });
  assert.equal(game.snapshot().rounds[0].players[0].state, "PENDING");

  const timeout = await resolveRuntimeSubmission(
    game,
    {
      player,
      roundNumber: 1,
      submissionType: request.submissionType,
      shapes: currentDrawing,
      receivedAt: deadline,
    },
    async (shapes) => {
      assert.equal(shapes, currentDrawing);
      return 1_000;
    },
  );
  const manual = await resolveRuntimeSubmission(
    game,
    {
      player,
      roundNumber: 1,
      submissionType: "MANUAL",
      shapes: currentDrawing,
      receivedAt: new Date(deadline.getTime() - 1),
    },
    async () => 0,
  );

  assert.equal(timeout.status, "APPLIED");
  assert.equal(timeout.resolution.submissionType, "TIMEOUT");
  assert.equal(manual.status, "DUPLICATE");
  assert.equal(game.snapshot().rounds[0].players[0].state, "RESOLVED");
});
