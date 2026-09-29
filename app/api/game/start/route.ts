import { generateTarget } from "../../../../features/game/server/target";
import { currentRuntimePlayer } from "../../../../features/game/server/player-session";
import { toRuntimePlayerSummary } from "../../../../features/game/runtime-player";

export async function POST(request: Request) {
  const player = await currentRuntimePlayer(request);

  return Response.json({
    player: toRuntimePlayerSummary(player),
    target: generateTarget(),
  });
}
