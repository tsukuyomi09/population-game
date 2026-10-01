export type GuestRuntimePlayer = {
  kind: "guest";
  runtimePlayerId: string;
  guestSessionId: string;
};

export type RegisteredRuntimePlayer = {
  kind: "registered";
  runtimePlayerId: string;
  userId: string;
  username?: string;
  avatarId?: string;
};

export type RuntimePlayer = GuestRuntimePlayer | RegisteredRuntimePlayer;

export type RuntimePlayerSummary =
  | Pick<GuestRuntimePlayer, "kind" | "runtimePlayerId">
  | Pick<
      RegisteredRuntimePlayer,
      "kind" | "runtimePlayerId" | "userId" | "username" | "avatarId"
    >;

export function registeredRuntimePlayer(userId: string): RegisteredRuntimePlayer {
  return {
    kind: "registered",
    runtimePlayerId: `registered_${userId}`,
    userId,
  };
}

export function isRegisteredRuntimePlayer(
  player: RuntimePlayer,
): player is RegisteredRuntimePlayer {
  return player.kind === "registered";
}

export function toRuntimePlayerSummary(
  player: RuntimePlayer,
): RuntimePlayerSummary {
  if (isRegisteredRuntimePlayer(player)) {
    const summary: RuntimePlayerSummary = {
      kind: player.kind,
      runtimePlayerId: player.runtimePlayerId,
      userId: player.userId,
    };
    if (player.username !== undefined) summary.username = player.username;
    if (player.avatarId !== undefined) summary.avatarId = player.avatarId;
    return summary;
  }

  return {
    kind: player.kind,
    runtimePlayerId: player.runtimePlayerId,
  };
}

export function isRuntimePlayerSummary(
  value: unknown,
): value is RuntimePlayerSummary {
  if (typeof value !== "object" || value === null) return false;

  const player = value as Record<string, unknown>;
  if (
    typeof player.runtimePlayerId !== "string" ||
    player.runtimePlayerId.length === 0
  ) {
    return false;
  }

  if (player.kind === "guest") {
    return (
      player.userId === undefined &&
      player.username === undefined &&
      player.avatarId === undefined
    );
  }

  return (
    player.kind === "registered" &&
    typeof player.userId === "string" &&
    player.userId.length > 0 &&
    (player.username === undefined || typeof player.username === "string") &&
    (player.avatarId === undefined || typeof player.avatarId === "string")
  );
}
