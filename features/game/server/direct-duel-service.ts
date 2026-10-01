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
  type RuntimeResultPhaseSnapshot,
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
export type DirectDuelCompletionReason = "ROUNDS_COMPLETE" | "ABANDON";

export type DirectDuelResultPhase = {
  roundNumber: number;
  startedAt: string;
  endsAt: string;
  readyRuntimePlayerIds: string[];
};

export type DirectDuelPreGame = {
  startedAt: string;
  endsAt: string;
};

export type DirectDuelEvent = {
  sequence: number;
  duelId: string;
  type:
    | "connected"
    | "waiting_for_opponent"
    | "pre_game_started"
    | "game_started"
    | "round_started"
    | "round_deadline_updated"
    | "submission_accepted"
    | "opponent_submitted"
    | "timeout_submission_requested"
    | "round_resolved"
    | "result_phase_started"
    | "player_ready"
    | "opponent_abandoned"
    | "game_completed";
  player?: RuntimePlayerSummary;
  players?: RuntimePlayerSummary[];
  difficulty?: GameDifficulty;
  rated?: false;
  preGame?: DirectDuelPreGame;
  round?: DirectDuelRound;
  resultPhase?: DirectDuelResultPhase;
  readyRuntimePlayerIds?: string[];
  roundNumber?: number;
  runtimePlayerId?: string;
  requestedAt?: string;
  result?: RuntimeRoundResolution;
  results?: RuntimeRoundResolution[];
  totals?: Record<string, number>;
  outcome?: DirectDuelOutcome;
  completionReason?: DirectDuelCompletionReason;
  abandonedRuntimePlayerId?: string;
  totalScore?: number;
  opponentTotalScore?: number;
};

type DirectDuelSession = {
  duelId: string;
  difficulty: GameDifficulty;
  rated: false;
  joinKind: "DUEL_ID" | "INVITE";
  players: RuntimePlayer[];
  game?: RuntimeGame;
  preGame?: {
    startedAt: Date;
    endsAt: Date;
  };
  sequence: number;
  listeners: Map<string, Set<(event: DirectDuelEvent) => void>>;
  cancelPreGameTimer?: () => void;
  cancelRoundTimer?: () => void;
  cancelResultTimer?: () => void;
};

type DirectDuelInvite = {
  duelId: string;
  expiresAt: Date;
  usedByRuntimePlayerId?: string;
};

type DirectDuelServiceOptions = {
  generateDuelId: () => string;
  generateInviteToken: () => string;
  generateTarget: () => number;
  inviteTtlMs: number;
  preGameDurationMs: number;
  roundDurationMs: number;
  finalWindowMs: number;
  resultPhaseDurationMs: number;
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

function resultPhaseDefinition(
  resultPhase: RuntimeResultPhaseSnapshot,
): DirectDuelResultPhase {
  if (
    resultPhase.state !== "WAITING" ||
    !resultPhase.startedAt ||
    !resultPhase.endsAt
  ) {
    throw new Error("Duel result wait has not started.");
  }
  return {
    roundNumber: resultPhase.roundNumber,
    startedAt: resultPhase.startedAt.toISOString(),
    endsAt: resultPhase.endsAt.toISOString(),
    readyRuntimePlayerIds: resultPhase.readyRuntimePlayerIds,
  };
}

function outcome(totalScore: number, opponentTotalScore: number) {
  if (totalScore > opponentTotalScore) return "WIN" as const;
  if (totalScore < opponentTotalScore) return "LOSS" as const;
  return "DRAW" as const;
}

function preGameDefinition(preGame: {
  startedAt: Date;
  endsAt: Date;
}): DirectDuelPreGame {
  return {
    startedAt: preGame.startedAt.toISOString(),
    endsAt: preGame.endsAt.toISOString(),
  };
}

export class DirectDuelService {
  private readonly sessions = new Map<string, DirectDuelSession>();
  private readonly invites = new Map<string, DirectDuelInvite>();

  constructor(private readonly options: DirectDuelServiceOptions) {}

  create(player: RuntimePlayer, difficulty: GameDifficulty) {
    const session = this.createSession(player, difficulty, "DUEL_ID");

    return {
      duelId: session.duelId,
      player: toRuntimePlayerSummary(player),
      difficulty,
      rated: false as const,
      status: "WAITING" as const,
    };
  }

  createInvite(player: RuntimePlayer, difficulty: GameDifficulty) {
    const session = this.createSession(player, difficulty, "INVITE");
    const inviteToken = this.options.generateInviteToken();
    if (this.invites.has(inviteToken)) {
      this.sessions.delete(session.duelId);
      throw new DirectDuelError("Generated invite token already exists.", 500);
    }

    const expiresAt = new Date(
      this.options.now().getTime() + this.options.inviteTtlMs,
    );
    this.invites.set(inviteToken, {
      duelId: session.duelId,
      expiresAt,
    });

    return {
      duelId: session.duelId,
      inviteToken,
      inviteExpiresAt: expiresAt.toISOString(),
      player: toRuntimePlayerSummary(player),
      difficulty,
      rated: false as const,
      status: "WAITING" as const,
    };
  }

  private createSession(
    player: RuntimePlayer,
    difficulty: GameDifficulty,
    joinKind: DirectDuelSession["joinKind"],
  ) {
    const duelId = this.options.generateDuelId();
    if (this.sessions.has(duelId)) {
      throw new DirectDuelError("Generated Duel id already exists.", 500);
    }

    this.sessions.set(duelId, {
      duelId,
      difficulty,
      rated: false,
      joinKind,
      players: [player],
      sequence: 0,
      listeners: new Map(),
    });

    return this.sessions.get(duelId)!;
  }

  join(player: RuntimePlayer, duelId: string) {
    const session = this.session(duelId);
    if (session.joinKind === "INVITE") {
      throw new DirectDuelError("This Duel requires its invite link.", 403);
    }
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
    this.startGame(session);

    return this.joinedState(session, player);
  }

  joinInvite(player: RuntimePlayer, inviteToken: string) {
    const invite = this.invites.get(inviteToken);
    if (!invite) {
      throw new DirectDuelError("Invite not found.", 404);
    }

    const session = this.session(invite.duelId);
    const existingPlayer = session.players.find((candidate) =>
      samePlayer(candidate, player),
    );

    if (invite.expiresAt.getTime() <= this.options.now().getTime()) {
      this.invites.delete(inviteToken);
      throw new DirectDuelError("This invite has expired.", 410);
    }

    if (invite.usedByRuntimePlayerId) {
      if (
        existingPlayer?.runtimePlayerId === invite.usedByRuntimePlayerId
      ) {
        return this.inviteJoinedState(session, player);
      }
      throw new DirectDuelError("This invite has already been used.", 409);
    }

    if (existingPlayer) {
      throw new DirectDuelError(
        "A Duel invite requires a second distinct player.",
        409,
      );
    }
    if (session.players.length >= 2) {
      throw new DirectDuelError("The Duel is full.", 409);
    }

    session.players.push(player);
    invite.usedByRuntimePlayerId = player.runtimePlayerId;
    const startedAt = this.options.now();
    session.preGame = {
      startedAt,
      endsAt: new Date(startedAt.getTime() + this.options.preGameDurationMs),
    };

    this.broadcast(session, {
      type: "pre_game_started",
      players: session.players.map(toRuntimePlayerSummary),
      difficulty: session.difficulty,
      rated: session.rated,
      preGame: preGameDefinition(session.preGame),
    });
    this.schedulePreGame(session);

    return this.inviteJoinedState(session, player);
  }

  subscribe(
    duelId: string,
    player: RuntimePlayer,
    listener: (event: DirectDuelEvent) => void,
  ) {
    const session = this.session(duelId);
    const participant = this.sessionPlayer(session, player);

    let listeners = session.listeners.get(player.runtimePlayerId);
    if (!listeners) {
      listeners = new Set();
      session.listeners.set(player.runtimePlayerId, listeners);
    }
    listeners.add(listener);
    this.emit(session, listener, {
      type: "connected",
      player: toRuntimePlayerSummary(participant),
    });
    const snapshot = session.game?.snapshot();
    if (snapshot) {
      this.emit(session, listener, {
        type: "game_started",
        players: session.players.map(toRuntimePlayerSummary),
        difficulty: session.difficulty,
        rated: session.rated,
      });
      if (snapshot.currentRound) {
        this.emit(session, listener, {
          type: "round_started",
          round: roundDefinition(snapshot.currentRound),
        });
      } else if (snapshot.resultPhase) {
        const resolvedRound = snapshot.rounds.find(
          (round) => round.roundNumber === snapshot.resultPhase?.roundNumber,
        );
        if (resolvedRound) {
          this.emit(session, listener, {
            type: "round_resolved",
            roundNumber: resolvedRound.roundNumber,
            results: resolvedRound.players.flatMap((state) =>
              state.resolution ? [state.resolution] : [],
            ),
            totals: snapshot.totals,
          });
          if (snapshot.resultPhase.state === "WAITING") {
            this.emit(session, listener, {
              type: "result_phase_started",
              roundNumber: snapshot.resultPhase.roundNumber,
              resultPhase: resultPhaseDefinition(snapshot.resultPhase),
            });
          }
        }
      }
    } else if (session.preGame) {
      this.emit(session, listener, {
        type: "pre_game_started",
        players: session.players.map(toRuntimePlayerSummary),
        difficulty: session.difficulty,
        rated: session.rated,
        preGame: preGameDefinition(session.preGame),
      });
    } else {
      this.emit(session, listener, {
        type: "waiting_for_opponent",
        players: session.players.map(toRuntimePlayerSummary),
        difficulty: session.difficulty,
        rated: session.rated,
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

    if (resolution.deadlineUpdated) {
      const activeRound = game.snapshot().currentRound;
      if (!activeRound) {
        throw new Error("Updated Duel deadline has no active round.");
      }
      this.broadcast(session, {
        type: "round_deadline_updated",
        round: roundDefinition(activeRound),
        roundNumber,
      });
      this.scheduleRound(session, activeRound);
    }

    if (resolution.roundResultStarted || resolution.gameFinalized) {
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

      session.cancelRoundTimer?.();
      session.cancelRoundTimer = undefined;

      if (resolution.gameFinalized) {
        this.sendCompletion(session, snapshot);
      }
    }

    return resolution;
  }

  completeResultAnimation(
    duelId: string,
    player: RuntimePlayer,
    roundNumber: number,
  ) {
    const session = this.session(duelId);
    this.sessionPlayer(session, player);
    const game = session.game;
    if (!game) throw new DirectDuelError("The Duel has not started.", 409);

    const completion = game.completeResultAnimation(
      player,
      roundNumber,
      this.options.now(),
    );
    if (completion.resultWaitStarted && completion.resultPhase) {
      this.broadcast(session, {
        type: "result_phase_started",
        roundNumber,
        resultPhase: resultPhaseDefinition(completion.resultPhase),
      });
      this.scheduleResultPhase(session, completion.resultPhase);
    }

    return completion;
  }

  abandon(duelId: string, player: RuntimePlayer) {
    const session = this.session(duelId);
    this.sessionPlayer(session, player);
    const game = session.game;
    if (!game) throw new DirectDuelError("The Duel has not started.", 409);

    let abandonment;
    try {
      abandonment = game.abandon(player, this.options.now());
    } catch (error) {
      if (error instanceof RuntimeGameTransitionError) {
        throw new DirectDuelError(error.message, 409);
      }
      throw error;
    }

    if (abandonment.status === "APPLIED" && abandonment.abandonment) {
      session.cancelRoundTimer?.();
      session.cancelRoundTimer = undefined;
      session.cancelResultTimer?.();
      session.cancelResultTimer = undefined;

      this.sendToOpponent(session, player.runtimePlayerId, {
        type: "opponent_abandoned",
        completionReason: "ABANDON",
        abandonedRuntimePlayerId:
          abandonment.abandonment.abandonedRuntimePlayerId,
      });
      this.sendCompletion(session, game.snapshot());
    }

    return abandonment;
  }

  readyForNextRound(
    duelId: string,
    player: RuntimePlayer,
    roundNumber: number,
  ) {
    const session = this.session(duelId);
    this.sessionPlayer(session, player);
    const game = session.game;
    if (!game) throw new DirectDuelError("The Duel has not started.", 409);

    let readiness;
    try {
      readiness = game.readyForNextRound(
        player,
        roundNumber,
        this.options.now(),
      );
    } catch (error) {
      if (error instanceof RuntimeGameTransitionError) {
        throw new DirectDuelError(error.message, 409);
      }
      throw error;
    }

    if (readiness.status === "APPLIED") {
      this.broadcast(session, {
        type: "player_ready",
        roundNumber,
        runtimePlayerId: player.runtimePlayerId,
        readyRuntimePlayerIds: readiness.readyRuntimePlayerIds,
      });
    }

    if (readiness.roundAdvanced && readiness.nextRound) {
      session.cancelResultTimer?.();
      session.cancelResultTimer = undefined;
      this.startRound(session, readiness.nextRound);
    }

    return readiness;
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
      difficulty: session.difficulty,
      rated: session.rated,
      status: "ACTIVE" as const,
      round: roundDefinition(snapshot.currentRound),
    };
  }

  private inviteJoinedState(
    session: DirectDuelSession,
    player: RuntimePlayer,
  ) {
    if (session.game) return this.joinedState(session, player);
    if (!session.preGame) {
      throw new DirectDuelError("The invite is not ready to start.", 409);
    }

    return {
      duelId: session.duelId,
      player: toRuntimePlayerSummary(player),
      players: session.players.map(toRuntimePlayerSummary),
      difficulty: session.difficulty,
      rated: session.rated,
      status: "COUNTDOWN" as const,
      preGame: preGameDefinition(session.preGame),
    };
  }

  private schedulePreGame(session: DirectDuelSession) {
    const preGame = session.preGame;
    if (!preGame) throw new Error("Cannot schedule a missing pre-game state.");

    session.cancelPreGameTimer?.();
    const delayMs = Math.max(
      0,
      preGame.endsAt.getTime() - this.options.now().getTime(),
    );
    session.cancelPreGameTimer = this.options.schedule(() => {
      session.cancelPreGameTimer = undefined;
      if (session.game || session.preGame !== preGame) return;
      this.startGame(session);
    }, delayMs);
  }

  private startGame(session: DirectDuelSession) {
    if (session.game) return;
    if (session.players.length !== 2) {
      throw new Error("A Duel requires two players before it can start.");
    }

    const game = new RuntimeGame({
      runtimeGameId: session.duelId,
      type: "DUEL",
      difficulty: session.difficulty,
      players: session.players,
      roundDurationMs: this.options.roundDurationMs,
      finalWindowMs: this.options.finalWindowMs,
      resultPhaseDurationMs: this.options.resultPhaseDurationMs,
      generateTarget: this.options.generateTarget,
    });
    session.game = game;
    session.preGame = undefined;
    const round = game.start(this.options.now());

    this.broadcast(session, {
      type: "game_started",
      players: session.players.map(toRuntimePlayerSummary),
      difficulty: session.difficulty,
      rated: session.rated,
    });
    this.startRound(session, round);
  }

  private scheduleRound(session: DirectDuelSession, round: RuntimeRoundSnapshot) {
    session.cancelRoundTimer?.();
    const delayMs = Math.max(0, round.endsAt.getTime() - this.options.now().getTime());
    session.cancelRoundTimer = this.options.schedule(() => {
      session.cancelRoundTimer = undefined;
      this.requestTimeoutSubmissions(session, round);
    }, delayMs);
  }

  private scheduleResultPhase(
    session: DirectDuelSession,
    resultPhase: RuntimeResultPhaseSnapshot,
  ) {
    if (resultPhase.state !== "WAITING" || !resultPhase.endsAt) {
      throw new Error("Cannot schedule a Duel result wait before it starts.");
    }
    session.cancelResultTimer?.();
    const delayMs = Math.max(
      0,
      resultPhase.endsAt.getTime() - this.options.now().getTime(),
    );
    session.cancelResultTimer = this.options.schedule(() => {
      session.cancelResultTimer = undefined;
      const advanced = session.game?.advanceResultPhase(
        resultPhase.roundNumber,
        this.options.now(),
      );
      if (advanced?.roundAdvanced && advanced.nextRound) {
        this.startRound(session, advanced.nextRound);
      }
    }, delayMs);
  }

  private startRound(session: DirectDuelSession, round: RuntimeRoundSnapshot) {
    this.broadcast(session, {
      type: "round_started",
      round: roundDefinition(round),
    });
    this.scheduleRound(session, round);
  }

  private requestTimeoutSubmissions(
    session: DirectDuelSession,
    round: RuntimeRoundSnapshot,
  ) {
    const game = session.game;
    if (!game) return;
    if (game.snapshot().state === "COMPLETE") return;

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
    const completionReason = snapshot.abandonment
      ? "ABANDON"
      : "ROUNDS_COMPLETE";
    const firstOutcome = snapshot.abandonment
      ? snapshot.abandonment.abandonedRuntimePlayerId === first.runtimePlayerId
        ? "LOSS"
        : "WIN"
      : outcome(firstTotal, secondTotal);
    const secondOutcome = snapshot.abandonment
      ? snapshot.abandonment.abandonedRuntimePlayerId === second.runtimePlayerId
        ? "LOSS"
        : "WIN"
      : outcome(secondTotal, firstTotal);

    this.sendToPlayer(session, first.runtimePlayerId, {
      type: "game_completed",
      outcome: firstOutcome,
      completionReason,
      abandonedRuntimePlayerId:
        snapshot.abandonment?.abandonedRuntimePlayerId,
      totalScore: firstTotal,
      opponentTotalScore: secondTotal,
      totals: snapshot.totals,
    });
    this.sendToPlayer(session, second.runtimePlayerId, {
      type: "game_completed",
      outcome: secondOutcome,
      completionReason,
      abandonedRuntimePlayerId:
        snapshot.abandonment?.abandonedRuntimePlayerId,
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
