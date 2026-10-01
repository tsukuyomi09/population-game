import type { PopulationShape } from "../../population/types";
import type { RuntimePlayer } from "../runtime-player";
import type { SubmissionType } from "../single-player";
import {
  RuntimeGame,
  type RuntimeResolutionOutcome,
} from "./runtime-game";

export type RuntimeSubmission = {
  player: RuntimePlayer;
  roundNumber: number;
  submissionType: SubmissionType;
  shapes: PopulationShape[];
  receivedAt: Date;
};

type CalculatePopulation = (shapes: PopulationShape[]) => Promise<number>;

export async function resolveRuntimeSubmission(
  game: RuntimeGame,
  submission: RuntimeSubmission,
  calculatePopulation: CalculatePopulation,
): Promise<RuntimeResolutionOutcome> {
  const calculatedPopulation = await calculatePopulation(submission.shapes);

  return game.resolvePlayer({
    player: submission.player,
    roundNumber: submission.roundNumber,
    submissionType: submission.submissionType,
    calculatedPopulation,
    resolvedAt: submission.receivedAt,
  });
}
