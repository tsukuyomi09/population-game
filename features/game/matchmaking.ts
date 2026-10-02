import type {
  MatchmakingEvent,
  MatchmakingIntent,
  MatchmakingState,
} from "./server/matchmaking-service";
import type { GameDifficulty } from "./single-player";

async function postMatchmakingAction(body: Record<string, unknown>) {
  const response = await fetch("/api/duel/matchmaking", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json()) as Record<string, unknown>;

  if (!response.ok) {
    throw new Error(
      typeof data.error === "string"
        ? data.error
        : "Matchmaking action failed.",
    );
  }

  return data;
}

export async function requestMatchmakingJoin(
  intent: MatchmakingIntent,
  difficulty: GameDifficulty,
) {
  return (await postMatchmakingAction({
    action: "JOIN",
    intent,
    difficulty,
  })) as MatchmakingState;
}

export async function requestMatchmakingLeave(attemptId: string) {
  return (await postMatchmakingAction({
    action: "LEAVE",
    attemptId,
  })) as MatchmakingEvent;
}

export async function requestMatchmakingMatchAcknowledge(
  attemptId: string,
  duelId: string,
) {
  await postMatchmakingAction({
    action: "ACK_MATCH",
    attemptId,
    duelId,
  });
}
