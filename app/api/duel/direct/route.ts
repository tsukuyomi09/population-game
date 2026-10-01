import {
  DirectDuelError,
  type DirectDuelEvent,
} from "../../../../features/game/server/direct-duel-service";
import { directDuels } from "../../../../features/game/server/direct-duels";
import { requestBody } from "../../../../features/game/server/http";
import { currentRuntimePlayer } from "../../../../features/game/server/player-session";
import { isGameDifficulty } from "../../../../features/game/single-player";
import { populationProvider } from "../../../../features/population/server/provider";
import type { PopulationResponse } from "../../../../features/population/types";
import { isPopulationShape } from "../../../../features/population/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function duelId(value: unknown) {
  if (typeof value !== "string" || value.length === 0) {
    throw new DirectDuelError("A duelId is required.", 400);
  }
  return value;
}

function roundNumber(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new DirectDuelError("A valid roundNumber is required.", 400);
  }
  return value;
}

function errorResponse(error: unknown) {
  if (error instanceof DirectDuelError) {
    return Response.json({ error: error.message }, { status: error.status });
  }

  console.error("Direct Duel action failed:", error);
  return Response.json({ error: "Direct Duel action failed." }, { status: 500 });
}

export async function POST(request: Request) {
  try {
    const body = await requestBody(request);
    const player = await currentRuntimePlayer(request);

    if (body.action === "CREATE") {
      const difficulty = body.difficulty ?? "EASY";
      if (!isGameDifficulty(difficulty)) {
        throw new DirectDuelError("Difficulty must be EASY or REAL.", 400);
      }
      return Response.json(directDuels().create(player, difficulty));
    }

    if (body.action === "JOIN") {
      return Response.json(directDuels().join(player, duelId(body.duelId)));
    }

    if (body.action === "SUBMIT") {
      const id = duelId(body.duelId);
      const currentRound = roundNumber(body.roundNumber);
      const submissionType = body.submissionType;
      const shapes = body.shapes;
      if (submissionType !== "MANUAL" && submissionType !== "TIMEOUT") {
        throw new DirectDuelError(
          "submissionType must be MANUAL or TIMEOUT.",
          400,
        );
      }
      if (!Array.isArray(shapes) || !shapes.every(isPopulationShape)) {
        throw new DirectDuelError(
          "Every shape must have an id and Polygon geometry.",
          400,
        );
      }

      let population: PopulationResponse | undefined;
      const result = await directDuels().submit(
        id,
        player,
        currentRound,
        submissionType,
        shapes,
        async (submittedShapes) => {
          const results = await populationProvider(submittedShapes);
          population = {
            results,
            totalPopulation: results.reduce(
              (total, item) => total + item.population,
              0,
            ),
          };
          return population.totalPopulation;
        },
      );

      return Response.json({
        status: result.status,
        resolution: result.resolution,
        roundAdvanced: result.roundAdvanced,
        gameFinalized: result.gameFinalized,
        population,
      });
    }

    throw new DirectDuelError("Unknown Direct Duel action.", 400);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET(request: Request) {
  try {
    const id = duelId(new URL(request.url).searchParams.get("duelId"));
    const player = await currentRuntimePlayer(request);
    const encoder = new TextEncoder();
    const pendingEvents: DirectDuelEvent[] = [];
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let closed = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    const send = (event: DirectDuelEvent) => {
      if (!controller) {
        pendingEvents.push(event);
        return;
      }
      try {
        controller.enqueue(
          encoder.encode(
            `id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`,
          ),
        );
      } catch {
        cleanup();
      }
    };
    const unsubscribe = directDuels().subscribe(id, player, send);
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
