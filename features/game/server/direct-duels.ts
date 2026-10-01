import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import { DirectDuelService } from "./direct-duel-service";
import { generateTarget } from "./target";

const DIRECT_DUEL_ROUND_DURATION_MS = 120_000;
const DIRECT_DUEL_FINAL_WINDOW_MS = 10_000;
const DIRECT_DUEL_RESULT_PHASE_DURATION_MS = 10_000;
const DIRECT_DUEL_INVITE_TTL_MS = 10 * 60_000;
const DIRECT_DUEL_PRE_GAME_DURATION_MS = 5_000;

const globalForDirectDuels = globalThis as typeof globalThis & {
  worldrawingDirectDuels?: DirectDuelService;
};

export function directDuels() {
  if (!globalForDirectDuels.worldrawingDirectDuels) {
    globalForDirectDuels.worldrawingDirectDuels = new DirectDuelService({
      generateDuelId: randomUUID,
      generateInviteToken: () => randomBytes(18).toString("base64url"),
      generateTarget,
      inviteTtlMs: DIRECT_DUEL_INVITE_TTL_MS,
      preGameDurationMs: DIRECT_DUEL_PRE_GAME_DURATION_MS,
      roundDurationMs: DIRECT_DUEL_ROUND_DURATION_MS,
      finalWindowMs: DIRECT_DUEL_FINAL_WINDOW_MS,
      resultPhaseDurationMs: DIRECT_DUEL_RESULT_PHASE_DURATION_MS,
      now: () => new Date(),
      schedule: (callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        return () => clearTimeout(timer);
      },
    });
  }

  return globalForDirectDuels.worldrawingDirectDuels;
}
