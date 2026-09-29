import { gameErrorResponse, requestBody, runtimeGameId } from "../../../../features/game/server/http";
import { currentRuntimePlayer } from "../../../../features/game/server/player-session";
import { singleGames } from "../../../../features/game/server/single-games";
import { populationProvider } from "../../../../features/population/server/provider";
import type { PopulationResponse } from "../../../../features/population/types";
import { isPopulationShape } from "../../../../features/population/validation";

export async function POST(request: Request) {
  try {
    const body = await requestBody(request);
    const gameId = runtimeGameId(body.runtimeGameId);
    const shapes = body.shapes;
    if (!Array.isArray(shapes) || !shapes.every(isPopulationShape)) {
      return Response.json(
        { error: "Every shape must have an id and Polygon geometry." },
        { status: 400 },
      );
    }

    const player = await currentRuntimePlayer(request);
    let populationResponse: PopulationResponse | null = null;
    const result = await singleGames().resolveRound(
      player,
      gameId,
      "MANUAL",
      async () => {
        const results = await populationProvider(shapes);
        populationResponse = {
          results,
          totalPopulation: results.reduce(
            (total, item) => total + item.population,
            0,
          ),
        };
        return populationResponse.totalPopulation;
      },
    );

    if (!populationResponse) {
      throw new Error("Population calculation returned no response.");
    }

    return Response.json({
      population: populationResponse,
      roundScore: result.score,
      totalScore: result.totalScore,
      submissionType: result.submissionType,
      complete: result.complete,
    });
  } catch (error) {
    return gameErrorResponse(error);
  }
}
