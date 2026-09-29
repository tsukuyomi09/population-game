import assert from "node:assert/strict";
import test from "node:test";
import {
  isRegisteredRuntimePlayer,
  isRuntimePlayerSummary,
  toRuntimePlayerSummary,
  type RuntimePlayer,
} from "./runtime-player";

test("keeps guest identity ephemeral and out of the client summary", () => {
  const player: RuntimePlayer = {
    kind: "guest",
    runtimePlayerId: "guest_runtime",
    guestSessionId: "guest_session",
  };

  assert.equal(isRegisteredRuntimePlayer(player), false);
  assert.deepEqual(toRuntimePlayerSummary(player), {
    kind: "guest",
    runtimePlayerId: "guest_runtime",
  });
});

test("represents registered identity with a durable user id", () => {
  const player: RuntimePlayer = {
    kind: "registered",
    runtimePlayerId: "registered_runtime",
    userId: "user_id",
  };

  assert.equal(isRegisteredRuntimePlayer(player), true);
  assert.deepEqual(toRuntimePlayerSummary(player), player);
});

test("validates the discriminated runtime player summary", () => {
  assert.equal(
    isRuntimePlayerSummary({ kind: "guest", runtimePlayerId: "guest_runtime" }),
    true,
  );
  assert.equal(
    isRuntimePlayerSummary({
      kind: "registered",
      runtimePlayerId: "registered_runtime",
      userId: "user_id",
    }),
    true,
  );
  assert.equal(
    isRuntimePlayerSummary({
      kind: "guest",
      runtimePlayerId: "guest_runtime",
      userId: "unexpected",
    }),
    false,
  );
  assert.equal(
    isRuntimePlayerSummary({ kind: "registered", runtimePlayerId: "runtime" }),
    false,
  );
});
