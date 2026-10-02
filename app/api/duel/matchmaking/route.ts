import { findUserById } from "../../../../features/account/server/users";
import { requestBody } from "../../../../features/game/server/http";
import {
  MatchmakingError,
  type MatchmakingEvent,
  type MatchmakingIntent,
} from "../../../../features/game/server/matchmaking-service";
import { matchmaking } from "../../../../features/game/server/matchmaking";
import { currentRuntimePlayer } from "../../../../features/game/server/player-session";
import { isGameDifficulty } from "../../../../features/game/single-player";
import { currentRankedMmr } from "../../../../features/rating/server/current-ranked-mmr";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function matchmakingIntent(value: unknown): MatchmakingIntent {
  if (value !== "DUEL" && value !== "RANKED") {
    throw new MatchmakingError("Queue intent must be DUEL or RANKED.", 400);
  }
  return value;
}

async function playerWithProfile(
  player: Awaited<ReturnType<typeof currentRuntimePlayer>>,
) {
  if (player.kind === "guest") return player;

  const user = await findUserById(player.userId);
  return user
    ? { ...player, username: user.username, avatarId: user.avatarId }
    : player;
}

function errorResponse(error: unknown) {
  if (error instanceof MatchmakingError) {
    return Response.json({ error: error.message }, { status: error.status });
  }

  console.error("Matchmaking action failed:", error);
  return Response.json({ error: "Matchmaking action failed." }, { status: 500 });
}

export async function POST(request: Request) {
  try {
    const body = await requestBody(request);
    const player = await currentRuntimePlayer(request);

    if (body.action === "JOIN") {
      if (!isGameDifficulty(body.difficulty)) {
        throw new MatchmakingError("Difficulty must be EASY or REAL.", 400);
      }
      const intent = matchmakingIntent(body.intent);
      const profiledPlayer = await playerWithProfile(player);
      const rankedMmr =
        intent === "RANKED" && profiledPlayer.kind === "registered"
          ? await currentRankedMmr(profiledPlayer.userId, body.difficulty)
          : undefined;
      return Response.json(
        matchmaking().join(
          profiledPlayer,
          intent,
          body.difficulty,
          rankedMmr,
        ),
      );
    }

    if (body.action === "LEAVE") {
      return Response.json(matchmaking().leave(player));
    }

    throw new MatchmakingError("Unknown matchmaking action.", 400);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET(request: Request) {
  try {
    const player = await currentRuntimePlayer(request);
    const encoder = new TextEncoder();
    const pendingEvents: MatchmakingEvent[] = [];
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let closed = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    const send = (event: MatchmakingEvent) => {
      if (!controller) {
        pendingEvents.push(event);
        return;
      }
      try {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      } catch {
        cleanup();
      }
    };
    const unsubscribe = matchmaking().subscribe(player, send);
    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe();
    };
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
        for (const event of pendingEvents.splice(0)) send(event);
        heartbeat = setInterval(() => {
          try {
            controller?.enqueue(encoder.encode(": keepalive\n\n"));
          } catch {
            cleanup();
          }
        }, 15_000);
        request.signal.addEventListener("abort", cleanup, { once: true });
      },
      cancel() {
        cleanup();
      },
    });

    return new Response(stream, {
      headers: {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
