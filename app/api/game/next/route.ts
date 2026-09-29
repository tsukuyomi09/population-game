import { gameErrorResponse, requestBody, runtimeGameId } from "../../../../features/game/server/http";
import { currentRuntimePlayer } from "../../../../features/game/server/player-session";
import { singleGames } from "../../../../features/game/server/single-games";
import { toRuntimePlayerSummary } from "../../../../features/game/runtime-player";

export async function POST(request: Request) {
  try {
    const body = await requestBody(request);
    const gameId = runtimeGameId(body.runtimeGameId);
    const player = await currentRuntimePlayer(request);
    const round = await singleGames().startNextRound(player, gameId);

    return Response.json({
      player: toRuntimePlayerSummary(player),
      ...round,
    });
  } catch (error) {
    return gameErrorResponse(error);
  }
}
