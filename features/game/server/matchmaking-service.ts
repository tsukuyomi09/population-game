import { randomUUID } from "node:crypto";
import type { RuntimePlayer } from "../runtime-player";
import type { GameDifficulty } from "../single-player";

export type MatchmakingIntent = "DUEL" | "RANKED";

export type MatchmakingMatch = {
  status: "MATCHED";
  attemptId: string;
  duelId: string;
  intent: MatchmakingIntent;
  difficulty: GameDifficulty;
  rated: boolean;
};

export type MatchmakingWaiting = {
  status: "WAITING";
  attemptId: string;
  intent: MatchmakingIntent;
  difficulty: GameDifficulty;
};

export type MatchmakingState = MatchmakingMatch | MatchmakingWaiting;

export type MatchmakingEvent =
  | MatchmakingState
  | { status: "LEFT"; attemptId: string };

type QueueEntry = {
  attemptId: string;
  player: RuntimePlayer;
  intent: MatchmakingIntent;
  difficulty: GameDifficulty;
  joinedAt: number;
  sequence: number;
  mmr: number | null;
};

type CreateMatchmadeDuel = (
  firstPlayer: RuntimePlayer,
  secondPlayer: RuntimePlayer,
  difficulty: GameDifficulty,
  rated: boolean,
) => { duelId: string; rated: boolean };

type MatchmakingServiceOptions = {
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => () => void;
};

type RankedPair = {
  first: QueueEntry;
  second: QueueEntry;
  difference: number;
};

const RANKED_SEARCH_STEPS = [
  { untilMs: 10_000, range: 50 },
  { untilMs: 20_000, range: 100 },
  { untilMs: 30_000, range: 150 },
  { untilMs: 45_000, range: 200 },
  { untilMs: 60_000, range: 300 },
] as const;

export const MAXIMUM_RANKED_MATCHMAKING_DIFFERENCE = 400;

export function rankedMatchmakingRange(waitTimeMs: number) {
  const elapsed = Math.max(0, waitTimeMs);
  return (
    RANKED_SEARCH_STEPS.find(({ untilMs }) => elapsed < untilMs)?.range ??
    MAXIMUM_RANKED_MATCHMAKING_DIFFERENCE
  );
}

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
    Map<string, Set<(event: MatchmakingEvent) => void>>
  >();
  private readonly rankedReevaluationTimers = new Map<
    string,
    { cancel: () => void }
  >();
  private readonly now: () => number;
  private readonly schedule: (
    callback: () => void,
    delayMs: number,
  ) => () => void;
  private nextSequence = 0;

  constructor(
    private readonly createDuel: CreateMatchmadeDuel,
    options: MatchmakingServiceOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.schedule =
      options.schedule ??
      ((callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        timer.unref();
        return () => clearTimeout(timer);
      });
  }

  join(
    player: RuntimePlayer,
    intent: MatchmakingIntent,
    difficulty: GameDifficulty,
    rankedMmr?: number,
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
        return {
          status: "WAITING",
          attemptId: existing.attemptId,
          intent,
          difficulty,
        };
      }
      throw new MatchmakingError(
        "Leave the current matchmaking queue before joining another.",
        409,
      );
    }

    if (
      intent === "RANKED" &&
      (!Number.isInteger(rankedMmr) || (rankedMmr as number) < 400)
    ) {
      throw new MatchmakingError("Ranked matchmaking MMR is invalid.", 500);
    }

    const key = queueKey(intent, difficulty);
    const queue = this.queues.get(key) ?? [];
    const entry: QueueEntry = {
      attemptId: randomUUID(),
      player,
      intent,
      difficulty,
      joinedAt: this.now(),
      sequence: this.nextSequence++,
      mmr: intent === "RANKED" ? (rankedMmr as number) : null,
    };

    if (intent === "RANKED") {
      queue.push(entry);
      this.queues.set(key, queue);
      this.entriesByPlayer.set(player.runtimePlayerId, entry);
      this.reevaluateRankedQueue(key);

      const match = this.pendingMatches.get(player.runtimePlayerId);
      if (match) {
        return match;
      }
      return {
        status: "WAITING",
        attemptId: entry.attemptId,
        intent,
        difficulty,
      };
    }

    const opponent = queue.shift();

    if (!opponent) {
      queue.push(entry);
      this.queues.set(key, queue);
      this.entriesByPlayer.set(player.runtimePlayerId, entry);
      return {
        status: "WAITING",
        attemptId: entry.attemptId,
        intent,
        difficulty,
      };
    }

    this.entriesByPlayer.delete(opponent.player.runtimePlayerId);
    if (queue.length === 0) this.queues.delete(key);

    let created;
    try {
      created = this.createDuel(
        opponent.player,
        player,
        difficulty,
        false,
      );
    } catch (error) {
      queue.unshift(opponent);
      this.queues.set(key, queue);
      this.entriesByPlayer.set(opponent.player.runtimePlayerId, opponent);
      throw error;
    }

    const opponentMatch: MatchmakingMatch = {
      status: "MATCHED",
      attemptId: opponent.attemptId,
      duelId: created.duelId,
      intent,
      difficulty,
      rated: created.rated,
    };
    const playerMatch: MatchmakingMatch = {
      ...opponentMatch,
      attemptId: entry.attemptId,
    };
    this.pendingMatches.set(opponent.player.runtimePlayerId, opponentMatch);
    this.pendingMatches.set(player.runtimePlayerId, playerMatch);
    this.emit(
      opponent.player.runtimePlayerId,
      opponent.attemptId,
      opponentMatch,
    );

    return playerMatch;
  }

  leave(player: RuntimePlayer, attemptId: string): MatchmakingEvent {
    const match = this.pendingMatches.get(player.runtimePlayerId);
    if (match?.attemptId === attemptId) return match;

    const entry = this.entriesByPlayer.get(player.runtimePlayerId);
    if (entry?.attemptId !== attemptId) return { status: "LEFT", attemptId };

    this.removeEntry(entry);
    const event: MatchmakingEvent = { status: "LEFT", attemptId };
    this.emit(player.runtimePlayerId, attemptId, event);
    return event;
  }

  acknowledgeMatch(
    player: RuntimePlayer,
    attemptId: string,
    duelId: string,
  ) {
    const match = this.pendingMatches.get(player.runtimePlayerId);
    if (!match || match.attemptId !== attemptId) return;
    if (match.duelId !== duelId) {
      throw new MatchmakingError("Matchmaking result does not match.", 409);
    }
    this.pendingMatches.delete(player.runtimePlayerId);
  }

  subscribe(
    player: RuntimePlayer,
    attemptId: string,
    listener: (event: MatchmakingEvent) => void,
  ) {
    let attempts = this.listeners.get(player.runtimePlayerId);
    if (!attempts) {
      attempts = new Map();
      this.listeners.set(player.runtimePlayerId, attempts);
    }
    let playerListeners = attempts.get(attemptId);
    if (!playerListeners) {
      playerListeners = new Set();
      attempts.set(attemptId, playerListeners);
    }
    playerListeners.add(listener);

    const pendingMatch = this.pendingMatches.get(player.runtimePlayerId);
    const entry = this.entriesByPlayer.get(player.runtimePlayerId);
    if (pendingMatch?.attemptId === attemptId) {
      listener(pendingMatch);
    } else if (entry?.attemptId === attemptId) {
      listener({
        status: "WAITING",
        attemptId,
        intent: entry.intent,
        difficulty: entry.difficulty,
      });
    } else {
      listener({ status: "LEFT", attemptId });
    }

    return () => {
      playerListeners?.delete(listener);
      if (playerListeners?.size === 0) {
        attempts?.delete(attemptId);
        if (attempts?.size === 0) {
          this.listeners.delete(player.runtimePlayerId);
        }
        const queuedEntry = this.entriesByPlayer.get(player.runtimePlayerId);
        if (queuedEntry?.attemptId === attemptId) {
          this.removeEntry(queuedEntry);
        }
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
    if (this.entriesByPlayer.get(entry.player.runtimePlayerId) === entry) {
      this.entriesByPlayer.delete(entry.player.runtimePlayerId);
    }
    if (entry.intent === "RANKED") {
      this.scheduleRankedReevaluation(key);
    }
  }

  private reevaluateRankedQueue(key: string) {
    this.cancelRankedReevaluation(key);

    try {
      while (true) {
        const queue = this.queues.get(key);
        if (!queue || queue.length < 2) break;
        const pair = this.bestRankedPair(queue, this.now());
        if (!pair) break;
        this.createRankedMatch(key, pair);
      }
    } finally {
      this.scheduleRankedReevaluation(key);
    }
  }

  private bestRankedPair(queue: readonly QueueEntry[], now: number) {
    const pairs: RankedPair[] = [];

    for (let firstIndex = 0; firstIndex < queue.length; firstIndex += 1) {
      for (
        let secondIndex = firstIndex + 1;
        secondIndex < queue.length;
        secondIndex += 1
      ) {
        const first = queue[firstIndex];
        const second = queue[secondIndex];
        if (first.mmr === null || second.mmr === null) continue;
        const difference = Math.abs(first.mmr - second.mmr);
        if (difference > MAXIMUM_RANKED_MATCHMAKING_DIFFERENCE) continue;
        const firstRange = rankedMatchmakingRange(now - first.joinedAt);
        const secondRange = rankedMatchmakingRange(now - second.joinedAt);
        if (difference > firstRange || difference > secondRange) continue;
        pairs.push({ first, second, difference });
      }
    }

    pairs.sort((left, right) => {
      if (left.difference !== right.difference) {
        return left.difference - right.difference;
      }
      const leftOldest = Math.min(left.first.joinedAt, left.second.joinedAt);
      const rightOldest = Math.min(right.first.joinedAt, right.second.joinedAt);
      if (leftOldest !== rightOldest) return leftOldest - rightOldest;
      const leftNewest = Math.max(left.first.joinedAt, left.second.joinedAt);
      const rightNewest = Math.max(right.first.joinedAt, right.second.joinedAt);
      if (leftNewest !== rightNewest) return leftNewest - rightNewest;
      const leftSequence = Math.min(left.first.sequence, left.second.sequence);
      const rightSequence = Math.min(right.first.sequence, right.second.sequence);
      return leftSequence - rightSequence;
    });
    return pairs[0];
  }

  private createRankedMatch(key: string, pair: RankedPair) {
    const queue = this.queues.get(key);
    if (!queue) return;
    this.removeRankedPairFromQueue(queue, pair);
    if (queue.length === 0) this.queues.delete(key);

    let created;
    try {
      created = this.createDuel(
        pair.first.player,
        pair.second.player,
        pair.first.difficulty,
        true,
      );
    } catch (error) {
      queue.push(pair.first, pair.second);
      queue.sort((left, right) => left.sequence - right.sequence);
      this.queues.set(key, queue);
      this.entriesByPlayer.set(
        pair.first.player.runtimePlayerId,
        pair.first,
      );
      this.entriesByPlayer.set(
        pair.second.player.runtimePlayerId,
        pair.second,
      );
      throw error;
    }

    for (const entry of [pair.first, pair.second]) {
      const match: MatchmakingMatch = {
        status: "MATCHED",
        attemptId: entry.attemptId,
        duelId: created.duelId,
        intent: "RANKED",
        difficulty: pair.first.difficulty,
        rated: created.rated,
      };
      this.pendingMatches.set(entry.player.runtimePlayerId, match);
      this.emit(entry.player.runtimePlayerId, entry.attemptId, match);
    }
  }

  private removeRankedPairFromQueue(queue: QueueEntry[], pair: RankedPair) {
    for (const entry of [pair.first, pair.second]) {
      const index = queue.indexOf(entry);
      if (index >= 0) queue.splice(index, 1);
      if (this.entriesByPlayer.get(entry.player.runtimePlayerId) === entry) {
        this.entriesByPlayer.delete(entry.player.runtimePlayerId);
      }
    }
  }

  private scheduleRankedReevaluation(key: string) {
    this.cancelRankedReevaluation(key);
    const queue = this.queues.get(key);
    if (!queue?.length || queue[0]?.intent !== "RANKED") return;
    const now = this.now();
    const nextWideningAt = Math.min(
      ...queue.map((entry) => this.nextWideningAt(entry, now)),
    );
    if (!Number.isFinite(nextWideningAt)) return;

    const timer: { cancel: () => void } = { cancel: () => undefined };
    this.rankedReevaluationTimers.set(key, timer);
    timer.cancel = this.schedule(() => {
      if (this.rankedReevaluationTimers.get(key) !== timer) return;
      this.rankedReevaluationTimers.delete(key);
      try {
        this.reevaluateRankedQueue(key);
      } catch (error) {
        console.error("Ranked matchmaking re-evaluation failed:", error);
      }
    }, Math.max(0, nextWideningAt - now));
  }

  private nextWideningAt(entry: QueueEntry, now: number) {
    const elapsed = Math.max(0, now - entry.joinedAt);
    const step = RANKED_SEARCH_STEPS.find(({ untilMs }) => elapsed < untilMs);
    return step ? entry.joinedAt + step.untilMs : Number.POSITIVE_INFINITY;
  }

  private cancelRankedReevaluation(key: string) {
    const timer = this.rankedReevaluationTimers.get(key);
    timer?.cancel();
    this.rankedReevaluationTimers.delete(key);
  }

  private emit(
    runtimePlayerId: string,
    attemptId: string,
    event: MatchmakingEvent,
  ) {
    const listeners = this.listeners.get(runtimePlayerId)?.get(attemptId);
    for (const listener of listeners ?? []) {
      listener(event);
    }
  }
}
