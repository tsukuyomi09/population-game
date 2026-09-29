import { isGameDifficulty } from "../../../../features/game/single-player";
import { singleLeaderboard } from "../../../../features/leaderboard/server/single-leaderboard";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const difficulty = new URL(request.url).searchParams.get("difficulty");

  if (!isGameDifficulty(difficulty)) {
    return Response.json(
      { error: "Difficulty must be EASY or REAL." },
      { status: 400 },
    );
  }

  try {
    const entries = await singleLeaderboard(difficulty);
    return Response.json({ difficulty, entries });
  } catch (error) {
    console.error("Single leaderboard query failed:", error);
    return Response.json(
      { error: "Leaderboard query failed." },
      { status: 500 },
    );
  }
}
