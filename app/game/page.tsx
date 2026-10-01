import { WorldMap } from "../../features/map/world-map";
import { isGameDifficulty } from "../../features/game/single-player";
import { DesktopGameGate } from "../../components/desktop-play-gate";

export default async function GamePage({
  searchParams,
}: {
  searchParams: Promise<{
    difficulty?: string | string[];
    duelId?: string | string[];
    invite?: string | string[];
  }>;
}) {
  const { difficulty, duelId, invite } = await searchParams;

  return (
    <DesktopGameGate>
      <WorldMap
        initialDifficulty={isGameDifficulty(difficulty) ? difficulty : undefined}
        duelId={typeof duelId === "string" && duelId.length > 0 ? duelId : undefined}
        inviteToken={
          typeof invite === "string" && invite.length > 0 ? invite : undefined
        }
      />
    </DesktopGameGate>
  );
}
