import { isGameDifficulty } from "../../../../features/game/single-player";
import { rankedLeaderboard } from "../../../../features/leaderboard/server/ranked-leaderboard";

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
    const entries = await rankedLeaderboard(difficulty);
    return Response.json({ difficulty, entries });
  } catch (error) {
    console.error("Ranked leaderboard query failed:", error);
    return Response.json(
      { error: "Leaderboard query failed." },
      { status: 500 },
    );
  }
}
