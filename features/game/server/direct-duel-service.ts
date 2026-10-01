import type { PopulationShape } from "../../population/types";
import {
  toRuntimePlayerSummary,
  type RuntimePlayer,
  type RuntimePlayerSummary,
} from "../runtime-player";
import type { GameDifficulty, SubmissionType } from "../single-player";
import {
  RuntimeGame,
  RuntimeGameTransitionError,
  type RuntimeGameSnapshot,
  type RuntimeRoundResolution,
  type RuntimeRoundSnapshot,
} from "./runtime-game";
import { resolveRuntimeSubmission } from "./runtime-submission";

export type DirectDuelRound = {
  roundNumber: number;
  target: number;
  startedAt: string;
  endsAt: string;
};

export type DirectDuelOutcome = "WIN" | "LOSS" | "DRAW";

export type DirectDuelEvent = {
  sequence: number;
  duelId: string;
  type:
    | "connected"
    | "game_started"
    | "round_started"
    | "submission_accepted"
    | "opponent_submitted"
    | "timeout_submission_requested"
    | "round_resolved"
    | "game_completed";
  player?: RuntimePlayerSummary;
  players?: RuntimePlayerSummary[];
  round?: DirectDuelRound;
  roundNumber?: number;
  runtimePlayerId?: string;
  requestedAt?: string;
  result?: RuntimeRoundResolution;
  results?: RuntimeRoundResolution[];
  totals?: Record<string, number>;
  outcome?: DirectDuelOutcome;
  totalScore?: number;
  opponentTotalScore?: number;
};

type DirectDuelSession = {
  duelId: string;
  difficulty: GameDifficulty;
  players: RuntimePlayer[];
  game?: RuntimeGame;
  sequence: number;
  listeners: Map<string, Set<(event: DirectDuelEvent) => void>>;
  cancelRoundTimer?: () => void;
};

type DirectDuelServiceOptions = {
  generateDuelId: () => string;
  generateTarget: () => number;
  roundDurationMs: number;
  now: () => Date;
  schedule: (callback: () => void, delayMs: number) => () => void;
};

type CalculatePopulation = (shapes: PopulationShape[]) => Promise<number>;

export class DirectDuelError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function samePlayer(left: RuntimePlayer, right: RuntimePlayer) {
  if (left.kind !== right.kind) return false;
  if (left.runtimePlayerId !== right.runtimePlayerId) return false;

  return left.kind === "registered"
    ? right.kind === "registered" && left.userId === right.userId
    : right.kind === "guest" && left.guestSessionId === right.guestSessionId;
}

function roundDefinition(round: RuntimeRoundSnapshot): DirectDuelRound {
  return {
    roundNumber: round.roundNumber,
    target: round.targetPopulation,
    startedAt: round.startedAt.toISOString(),
    endsAt: round.endsAt.toISOString(),
  };
}

function outcome(totalScore: number, opponentTotalScore: number) {
  if (totalScore > opponentTotalScore) return "WIN" as const;
  if (totalScore < opponentTotalScore) return "LOSS" as const;
  return "DRAW" as const;
}

export class DirectDuelService {
  private readonly sessions = new Map<string, DirectDuelSession>();

  constructor(private readonly options: DirectDuelServiceOptions) {}

  create(player: RuntimePlayer, difficulty: GameDifficulty) {
    const duelId = this.options.generateDuelId();
    if (this.sessions.has(duelId)) {
      throw new DirectDuelError("Generated Duel id already exists.", 500);
    }

    this.sessions.set(duelId, {
      duelId,
      difficulty,
      players: [player],
      sequence: 0,
      listeners: new Map(),
    });

    return {
      duelId,
      player: toRuntimePlayerSummary(player),
      status: "WAITING" as const,
    };
  }

  join(player: RuntimePlayer, duelId: string) {
    const session = this.session(duelId);
    const existingPlayer = session.players.find((candidate) =>
      samePlayer(candidate, player),
    );

    if (session.game) {
      if (!existingPlayer) throw new DirectDuelError("The Duel is full.", 409);
      return this.joinedState(session, player);
    }
    if (existingPlayer) {
      throw new DirectDuelError("A Duel requires two distinct players.", 409);
    }

    session.players.push(player);
    const game = new RuntimeGame({
      runtimeGameId: duelId,
      type: "DUEL",
      difficulty: session.difficulty,
      players: session.players,
      roundDurationMs: this.options.roundDurationMs,
      generateTarget: this.options.generateTarget,
    });
    session.game = game;
    const round = game.start(this.options.now());

    this.broadcast(session, {
      type: "game_started",
      players: session.players.map(toRuntimePlayerSummary),
    });
    this.broadcast(session, {
      type: "round_started",
      round: roundDefinition(round),
    });
    this.scheduleRound(session, round);

    return this.joinedState(session, player);
  }

  subscribe(
    duelId: string,
    player: RuntimePlayer,
    listener: (event: DirectDuelEvent) => void,
  ) {
    const session = this.session(duelId);
    this.sessionPlayer(session, player);

    let listeners = session.listeners.get(player.runtimePlayerId);
    if (!listeners) {
      listeners = new Set();
      session.listeners.set(player.runtimePlayerId, listeners);
    }
    listeners.add(listener);
    this.emit(session, listener, {
      type: "connected",
      player: toRuntimePlayerSummary(player),
    });
    const snapshot = session.game?.snapshot();
    if (snapshot?.currentRound) {
      this.emit(session, listener, {
        type: "game_started",
        players: session.players.map(toRuntimePlayerSummary),
      });
      this.emit(session, listener, {
        type: "round_started",
        round: roundDefinition(snapshot.currentRound),
      });
    }

    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) {
        session.listeners.delete(player.runtimePlayerId);
      }
    };
  }

  async submit(
    duelId: string,
    player: RuntimePlayer,
    roundNumber: number,
    submissionType: SubmissionType,
    shapes: PopulationShape[],
    calculatePopulation: CalculatePopulation,
  ) {
    const session = this.session(duelId);
    this.sessionPlayer(session, player);
    const game = session.game;
    if (!game) throw new DirectDuelError("The Duel has not started.", 409);

    let resolution;
    try {
      resolution = await resolveRuntimeSubmission(
        game,
        {
          player,
          roundNumber,
          submissionType,
          shapes,
          receivedAt: this.options.now(),
        },
        calculatePopulation,
      );
    } catch (error) {
      if (error instanceof RuntimeGameTransitionError) {
        throw new DirectDuelError(error.message, 409);
      }
      throw error;
    }

    if (resolution.status === "DUPLICATE") return resolution;

    this.sendToPlayer(session, player.runtimePlayerId, {
      type: "submission_accepted",
      roundNumber,
      result: resolution.resolution,
    });
    this.sendToOpponent(session, player.runtimePlayerId, {
      type: "opponent_submitted",
      roundNumber,
      runtimePlayerId: player.runtimePlayerId,
    });

    if (resolution.roundAdvanced || resolution.gameFinalized) {
      const snapshot = game.snapshot();
      const resolvedRound = snapshot.rounds.find(
        (round) => round.roundNumber === roundNumber,
      );
      if (!resolvedRound) {
        throw new Error("Resolved Duel round is missing from runtime state.");
      }

      this.broadcast(session, {
        type: "round_resolved",
        roundNumber,
        results: resolvedRound.players.flatMap((state) =>
          state.resolution ? [state.resolution] : [],
        ),
        totals: snapshot.totals,
      });

      if (resolution.gameFinalized) {
        session.cancelRoundTimer?.();
        session.cancelRoundTimer = undefined;
        this.sendCompletion(session, snapshot);
      } else if (snapshot.currentRound) {
        this.broadcast(session, {
          type: "round_started",
          round: roundDefinition(snapshot.currentRound),
        });
        this.scheduleRound(session, snapshot.currentRound);
      }
    }

    return resolution;
  }

  private joinedState(session: DirectDuelSession, player: RuntimePlayer) {
    const snapshot = session.game?.snapshot();
    if (!snapshot?.currentRound) {
      throw new DirectDuelError("The Duel has not started.", 409);
    }

    return {
      duelId: session.duelId,
      player: toRuntimePlayerSummary(player),
      players: session.players.map(toRuntimePlayerSummary),
      status: "ACTIVE" as const,
      round: roundDefinition(snapshot.currentRound),
    };
  }

  private scheduleRound(session: DirectDuelSession, round: RuntimeRoundSnapshot) {
    session.cancelRoundTimer?.();
    const delayMs = Math.max(0, round.endsAt.getTime() - this.options.now().getTime());
    session.cancelRoundTimer = this.options.schedule(() => {
      session.cancelRoundTimer = undefined;
      this.requestTimeoutSubmissions(session, round);
    }, delayMs);
  }

  private requestTimeoutSubmissions(
    session: DirectDuelSession,
    round: RuntimeRoundSnapshot,
  ) {
    const game = session.game;
    if (!game) return;

    for (const player of session.players) {
      if (!session.listeners.get(player.runtimePlayerId)?.size) continue;

      const request = game.timeoutSubmissionRequest(
        player,
        round.roundNumber,
        round.endsAt,
      );
      if (!request) continue;

      this.sendToPlayer(session, player.runtimePlayerId, {
        type: "timeout_submission_requested",
        roundNumber: request.roundNumber,
        runtimePlayerId: request.runtimePlayerId,
        requestedAt: request.requestedAt.toISOString(),
      });
    }
  }

  private sendCompletion(
    session: DirectDuelSession,
    snapshot: RuntimeGameSnapshot,
  ) {
    const [first, second] = session.players;
    const firstTotal = snapshot.totals[first.runtimePlayerId] ?? 0;
    const secondTotal = snapshot.totals[second.runtimePlayerId] ?? 0;

    this.sendToPlayer(session, first.runtimePlayerId, {
      type: "game_completed",
      outcome: outcome(firstTotal, secondTotal),
      totalScore: firstTotal,
      opponentTotalScore: secondTotal,
      totals: snapshot.totals,
    });
    this.sendToPlayer(session, second.runtimePlayerId, {
      type: "game_completed",
      outcome: outcome(secondTotal, firstTotal),
      totalScore: secondTotal,
      opponentTotalScore: firstTotal,
      totals: snapshot.totals,
    });
  }

  private broadcast(
    session: DirectDuelSession,
    event: Omit<DirectDuelEvent, "sequence" | "duelId">,
  ) {
    for (const listeners of session.listeners.values()) {
      for (const listener of listeners) this.emit(session, listener, event);
    }
  }

  private sendToPlayer(
    session: DirectDuelSession,
    runtimePlayerId: string,
    event: Omit<DirectDuelEvent, "sequence" | "duelId">,
  ) {
    for (const listener of session.listeners.get(runtimePlayerId) ?? []) {
      this.emit(session, listener, event);
    }
  }

  private sendToOpponent(
    session: DirectDuelSession,
    runtimePlayerId: string,
    event: Omit<DirectDuelEvent, "sequence" | "duelId">,
  ) {
    for (const player of session.players) {
      if (player.runtimePlayerId !== runtimePlayerId) {
        this.sendToPlayer(session, player.runtimePlayerId, event);
      }
    }
  }

  private emit(
    session: DirectDuelSession,
    listener: (event: DirectDuelEvent) => void,
    event: Omit<DirectDuelEvent, "sequence" | "duelId">,
  ) {
    session.sequence += 1;
    listener({ ...event, sequence: session.sequence, duelId: session.duelId });
  }

  private session(duelId: string) {
    const session = this.sessions.get(duelId);
    if (!session) throw new DirectDuelError("Duel not found.", 404);
    return session;
  }

  private sessionPlayer(session: DirectDuelSession, player: RuntimePlayer) {
    const participant = session.players.find((candidate) =>
      samePlayer(candidate, player),
    );
    if (!participant) {
      throw new DirectDuelError("Player does not belong to this Duel.", 403);
    }
    return participant;
  }
}
