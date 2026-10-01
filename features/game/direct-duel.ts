import type { PopulationShape } from "../population/types";
import type { DirectDuelRound } from "./server/direct-duel-service";
import {
  isRuntimePlayerSummary,
  type RuntimePlayerSummary,
} from "./runtime-player";
import type { GameDifficulty, SubmissionType } from "./single-player";

type DirectDuelStart = {
  duelId: string;
  player: RuntimePlayerSummary;
  round?: DirectDuelRound;
};

async function postDirectDuelAction(body: Record<string, unknown>) {
  const response = await fetch("/api/duel/direct", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json()) as Record<string, unknown>;

  if (!response.ok) {
    throw new Error(
      typeof data.error === "string" ? data.error : "Duel action failed.",
    );
  }

  return data;
}

function directDuelStart(data: Record<string, unknown>): DirectDuelStart {
  if (
    typeof data.duelId !== "string" ||
    data.duelId.length === 0 ||
    !isRuntimePlayerSummary(data.player)
  ) {
    throw new Error("Duel action returned an invalid session.");
  }

  return {
    duelId: data.duelId,
    player: data.player,
    round: data.round as DirectDuelRound | undefined,
  };
}

export async function requestDirectDuelCreate(difficulty: GameDifficulty) {
  return directDuelStart(
    await postDirectDuelAction({ action: "CREATE", difficulty }),
  );
}

export async function requestDirectDuelJoin(duelId: string) {
  return directDuelStart(
    await postDirectDuelAction({ action: "JOIN", duelId }),
  );
}

export async function requestDirectDuelSubmission(
  duelId: string,
  roundNumber: number,
  submissionType: SubmissionType,
  shapes: PopulationShape[],
) {
  return postDirectDuelAction({
    action: "SUBMIT",
    duelId,
    roundNumber,
    submissionType,
    shapes,
  });
}

export async function requestDirectDuelReady(
  duelId: string,
  roundNumber: number,
) {
  return postDirectDuelAction({
    action: "READY_NEXT_ROUND",
    duelId,
    roundNumber,
  });
}

export async function requestDirectDuelResultAnimationComplete(
  duelId: string,
  roundNumber: number,
) {
  return postDirectDuelAction({
    action: "RESULT_ANIMATION_COMPLETE",
    duelId,
    roundNumber,
  });
}

export async function requestDirectDuelAbandon(duelId: string) {
  return postDirectDuelAction({
    action: "ABANDON",
    duelId,
  });
}
