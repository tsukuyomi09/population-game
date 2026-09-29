import "server-only";
import { SingleGameError } from "./single-game-service";

export async function requestBody(
  request: Request,
  allowEmpty = false,
): Promise<Record<string, unknown>> {
  let body: unknown;

  try {
    const text = await request.text();
    if (allowEmpty && text.trim().length === 0) return {};
    body = JSON.parse(text);
  } catch {
    throw new SingleGameError("Malformed JSON.", 400);
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new SingleGameError("A JSON object is required.", 400);
  }

  return body as Record<string, unknown>;
}

export function runtimeGameId(value: unknown) {
  if (typeof value !== "string" || value.length === 0) {
    throw new SingleGameError("A runtimeGameId is required.", 400);
  }

  return value;
}

export function gameErrorResponse(error: unknown) {
  if (error instanceof SingleGameError) {
    return Response.json({ error: error.message }, { status: error.status });
  }

  console.error("Single game action failed:", error);
  return Response.json({ error: "Game action failed." }, { status: 500 });
}
