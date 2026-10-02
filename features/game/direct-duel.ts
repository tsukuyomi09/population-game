import type { PopulationShape } from "../population/types";
import type { DirectDuelRound } from "./server/direct-duel-service";
import {
  isRuntimePlayerSummary,
  type RuntimePlayerSummary,
} from "./runtime-player";
import {
  isGameDifficulty,
  type GameDifficulty,
  type SubmissionType,
} from "./single-player";

type DirectDuelStart = {
  duelId: string;
  player: RuntimePlayerSummary;
  difficulty?: GameDifficulty;
  rated?: boolean;
  round?: DirectDuelRound;
};

type DirectDuelInviteStart = DirectDuelStart & {
  inviteToken: string;
  inviteExpiresAt: string;
};

export type DirectDuelInviteIntent = "DUEL" | "RANKED";

export type ActiveDirectDuelState =
  | { status: "NONE" }
  | {
      status: "ACTIVE";
      duelId: string;
      difficulty: GameDifficulty;
      rated: boolean;
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
    difficulty: isGameDifficulty(data.difficulty)
      ? data.difficulty
      : undefined,
    rated: typeof data.rated === "boolean" ? data.rated : undefined,
    round: data.round as DirectDuelRound | undefined,
  };
}

function directDuelInviteStart(
  data: Record<string, unknown>,
): DirectDuelInviteStart {
  const start = directDuelStart(data);
  if (
    typeof data.inviteToken !== "string" ||
    data.inviteToken.length === 0 ||
    typeof data.inviteExpiresAt !== "string" ||
    !Number.isFinite(Date.parse(data.inviteExpiresAt))
  ) {
    throw new Error("Duel action returned an invalid invite.");
  }

  return {
    ...start,
    inviteToken: data.inviteToken,
    inviteExpiresAt: data.inviteExpiresAt,
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

export async function requestDirectDuelInviteCreate(
  difficulty: GameDifficulty,
  intent: DirectDuelInviteIntent = "DUEL",
) {
  return directDuelInviteStart(
    await postDirectDuelAction({ action: "CREATE_INVITE", difficulty, intent }),
  );
}

export async function requestDirectDuelInviteJoin(inviteToken: string) {
  return directDuelStart(
    await postDirectDuelAction({ action: "JOIN_INVITE", inviteToken }),
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

export async function requestActiveDirectDuel() {
  const response = await fetch("/api/duel/direct", { cache: "no-store" });
  const data = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(
      typeof data.error === "string" ? data.error : "Could not load match.",
    );
  }
  if (data.status === "NONE") return { status: "NONE" } as const;
  if (
    data.status !== "ACTIVE" ||
    typeof data.duelId !== "string" ||
    !isGameDifficulty(data.difficulty) ||
    typeof data.rated !== "boolean"
  ) {
    throw new Error("Active Duel response is invalid.");
  }
  return {
    status: "ACTIVE",
    duelId: data.duelId,
    difficulty: data.difficulty,
    rated: data.rated,
  } satisfies ActiveDirectDuelState;
}
