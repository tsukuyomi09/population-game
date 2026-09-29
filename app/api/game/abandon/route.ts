import { gameErrorResponse, requestBody, runtimeGameId } from "../../../../features/game/server/http";
import { currentRuntimePlayer } from "../../../../features/game/server/player-session";
import { singleGames } from "../../../../features/game/server/single-games";

export async function POST(request: Request) {
  try {
    const body = await requestBody(request);
    const gameId = runtimeGameId(body.runtimeGameId);
    const player = await currentRuntimePlayer(request);
    const result = await singleGames().abandonGame(player, gameId);

    return Response.json({ status: "ABANDONED", ...result });
  } catch (error) {
    return gameErrorResponse(error);
  }
}
