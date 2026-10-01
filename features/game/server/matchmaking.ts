import "server-only";
import { createMatchmadeDuel } from "./direct-duels";
import { MatchmakingService } from "./matchmaking-service";

const MATCHMAKING_API_VERSION = 2;

const globalForMatchmaking = globalThis as typeof globalThis & {
  worldrawingMatchmaking?: MatchmakingService;
  worldrawingMatchmakingApiVersion?: number;
};

export function matchmaking() {
  if (
    !globalForMatchmaking.worldrawingMatchmaking ||
    globalForMatchmaking.worldrawingMatchmakingApiVersion !==
      MATCHMAKING_API_VERSION
  ) {
    globalForMatchmaking.worldrawingMatchmaking = new MatchmakingService(
      createMatchmadeDuel,
    );
    globalForMatchmaking.worldrawingMatchmakingApiVersion =
      MATCHMAKING_API_VERSION;
  }

  return globalForMatchmaking.worldrawingMatchmaking;
}
