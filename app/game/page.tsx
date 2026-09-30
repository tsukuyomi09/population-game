import { WorldMap } from "../../features/map/world-map";
import { isGameDifficulty } from "../../features/game/single-player";
import { DesktopGameGate } from "../../components/desktop-play-gate";

export default async function GamePage({
  searchParams,
}: {
  searchParams: Promise<{ difficulty?: string | string[] }>;
}) {
  const { difficulty } = await searchParams;

  return (
    <DesktopGameGate>
      <WorldMap
        initialDifficulty={isGameDifficulty(difficulty) ? difficulty : undefined}
      />
    </DesktopGameGate>
  );
}
