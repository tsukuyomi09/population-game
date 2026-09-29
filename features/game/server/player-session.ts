import { createHash, randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { auth } from "../../../auth";
import {
  registeredRuntimePlayer,
  type GuestRuntimePlayer,
  type RuntimePlayer,
} from "../runtime-player";

const GUEST_SESSION_COOKIE = "worldrawing_guest_session";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function runtimePlayerId(guestSessionId: string) {
  const digest = createHash("sha256").update(guestSessionId).digest("hex");
  return `guest_${digest.slice(0, 24)}`;
}

function isSecureRequest(request: Request) {
  const forwardedProtocol = request.headers
    .get("x-forwarded-proto")
    ?.split(",", 1)[0]
    .trim();

  return forwardedProtocol
    ? forwardedProtocol === "https"
    : new URL(request.url).protocol === "https:";
}

export async function currentRuntimePlayer(
  request: Request,
): Promise<RuntimePlayer> {
  const session = await auth();

  if (session?.worldrawingUserId) {
    return registeredRuntimePlayer(session.worldrawingUserId);
  }

  const cookieStore = await cookies();
  const existingSessionId = cookieStore.get(GUEST_SESSION_COOKIE)?.value;
  const guestSessionId =
    existingSessionId && UUID_PATTERN.test(existingSessionId)
      ? existingSessionId
      : randomUUID();

  if (guestSessionId !== existingSessionId) {
    cookieStore.set(GUEST_SESSION_COOKIE, guestSessionId, {
      httpOnly: true,
      sameSite: "lax",
      secure: isSecureRequest(request),
      path: "/",
    });
  }

  return {
    kind: "guest",
    runtimePlayerId: runtimePlayerId(guestSessionId),
    guestSessionId,
  };
}
