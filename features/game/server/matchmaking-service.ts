import type { RuntimePlayer } from "../runtime-player";
import type { GameDifficulty } from "../single-player";

export type MatchmakingIntent = "DUEL" | "RANKED";

export type MatchmakingMatch = {
  status: "MATCHED";
  duelId: string;
  intent: MatchmakingIntent;
  difficulty: GameDifficulty;
  rated: boolean;
};

export type MatchmakingWaiting = {
  status: "WAITING";
  intent: MatchmakingIntent;
  difficulty: GameDifficulty;
};

export type MatchmakingState = MatchmakingMatch | MatchmakingWaiting;

export type MatchmakingEvent = MatchmakingState | { status: "LEFT" };

type QueueEntry = {
  player: RuntimePlayer;
  intent: MatchmakingIntent;
  difficulty: GameDifficulty;
};

type CreateMatchmadeDuel = (
  firstPlayer: RuntimePlayer,
  secondPlayer: RuntimePlayer,
  difficulty: GameDifficulty,
  rated: boolean,
) => { duelId: string; rated: boolean };

export class MatchmakingError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function queueKey(intent: MatchmakingIntent, difficulty: GameDifficulty) {
  return `${intent}:${difficulty}`;
}

export class MatchmakingService {
  private readonly queues = new Map<string, QueueEntry[]>();
  private readonly entriesByPlayer = new Map<string, QueueEntry>();
  private readonly pendingMatches = new Map<string, MatchmakingMatch>();
  private readonly listeners = new Map<
    string,
    Set<(event: MatchmakingEvent) => void>
  >();

  constructor(private readonly createDuel: CreateMatchmadeDuel) {}

  join(
    player: RuntimePlayer,
    intent: MatchmakingIntent,
    difficulty: GameDifficulty,
  ): MatchmakingState {
    if (intent === "RANKED" && player.kind !== "registered") {
      throw new MatchmakingError(
        "Ranked matchmaking requires a registered account.",
        403,
      );
    }

    const pendingMatch = this.pendingMatches.get(player.runtimePlayerId);
    if (pendingMatch) return pendingMatch;

    const existing = this.entriesByPlayer.get(player.runtimePlayerId);
    if (existing) {
      if (
        existing.intent === intent &&
        existing.difficulty === difficulty
      ) {
        return { status: "WAITING", intent, difficulty };
      }
      throw new MatchmakingError(
        "Leave the current matchmaking queue before joining another.",
        409,
      );
    }

    const key = queueKey(intent, difficulty);
    const queue = this.queues.get(key) ?? [];
    const opponent = queue.shift();

    if (!opponent) {
      const entry = { player, intent, difficulty };
      queue.push(entry);
      this.queues.set(key, queue);
      this.entriesByPlayer.set(player.runtimePlayerId, entry);
      return { status: "WAITING", intent, difficulty };
    }

    this.entriesByPlayer.delete(opponent.player.runtimePlayerId);
    if (queue.length === 0) this.queues.delete(key);

    let created;
    try {
      created = this.createDuel(
        opponent.player,
        player,
        difficulty,
        intent === "RANKED",
      );
    } catch (error) {
      queue.unshift(opponent);
      this.queues.set(key, queue);
      this.entriesByPlayer.set(opponent.player.runtimePlayerId, opponent);
      throw error;
    }

    const match: MatchmakingMatch = {
      status: "MATCHED",
      duelId: created.duelId,
      intent,
      difficulty,
      rated: created.rated,
    };
    this.pendingMatches.set(opponent.player.runtimePlayerId, match);
    this.emit(opponent.player.runtimePlayerId, match);

    return match;
  }

  leave(player: RuntimePlayer): MatchmakingEvent {
    const match = this.pendingMatches.get(player.runtimePlayerId);
    if (match) {
      this.pendingMatches.delete(player.runtimePlayerId);
      return match;
    }

    const entry = this.entriesByPlayer.get(player.runtimePlayerId);
    if (!entry) return { status: "LEFT" };

    this.removeEntry(entry);
    this.emit(player.runtimePlayerId, { status: "LEFT" });
    return { status: "LEFT" };
  }

  subscribe(
    player: RuntimePlayer,
    listener: (event: MatchmakingEvent) => void,
  ) {
    let playerListeners = this.listeners.get(player.runtimePlayerId);
    if (!playerListeners) {
      playerListeners = new Set();
      this.listeners.set(player.runtimePlayerId, playerListeners);
    }
    playerListeners.add(listener);

    const pendingMatch = this.pendingMatches.get(player.runtimePlayerId);
    const entry = this.entriesByPlayer.get(player.runtimePlayerId);
    if (pendingMatch) {
      listener(pendingMatch);
      this.pendingMatches.delete(player.runtimePlayerId);
    } else if (entry) {
      listener({
        status: "WAITING",
        intent: entry.intent,
        difficulty: entry.difficulty,
      });
    } else {
      listener({ status: "LEFT" });
    }

    return () => {
      playerListeners?.delete(listener);
      if (playerListeners?.size === 0) {
        this.listeners.delete(player.runtimePlayerId);
        const queuedEntry = this.entriesByPlayer.get(player.runtimePlayerId);
        if (queuedEntry) this.removeEntry(queuedEntry);
      }
    };
  }

  private removeEntry(entry: QueueEntry) {
    const key = queueKey(entry.intent, entry.difficulty);
    const queue = this.queues.get(key);
    if (queue) {
      const index = queue.indexOf(entry);
      if (index >= 0) queue.splice(index, 1);
      if (queue.length === 0) this.queues.delete(key);
    }
    this.entriesByPlayer.delete(entry.player.runtimePlayerId);
  }

  private emit(runtimePlayerId: string, event: MatchmakingEvent) {
    const listeners = this.listeners.get(runtimePlayerId);
    for (const listener of listeners ?? []) {
      listener(event);
    }
    if (event.status === "MATCHED" && listeners?.size) {
      this.pendingMatches.delete(runtimePlayerId);
    }
  }
}
