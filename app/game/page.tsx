import { WorldMap } from "../../features/map/world-map";
import { isGameDifficulty } from "../../features/game/single-player";

export default async function GamePage({
  searchParams,
}: {
  searchParams: Promise<{ difficulty?: string | string[] }>;
}) {
  const { difficulty } = await searchParams;

  return (
    <WorldMap
      initialDifficulty={isGameDifficulty(difficulty) ? difficulty : undefined}
    />
  );
}
