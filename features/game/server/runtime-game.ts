import {
  calculateRoundScore,
  ROUND_COUNT,
  type GameDifficulty,
  type SubmissionType,
} from "../single-player";
import {
  toRuntimePlayerSummary,
  type RuntimePlayer,
  type RuntimePlayerSummary,
} from "../runtime-player";

export type RuntimeGameType = "SINGLE" | "DUEL";
export type RuntimeGameLifecycle =
  | "CREATED"
  | "ROUND_ACTIVE"
  | "ROUND_RESULT"
  | "COMPLETE";
export type RuntimeRoundLifecycle = "ACTIVE" | "RESOLVED";
export type RuntimePlayerRoundLifecycle = "PENDING" | "RESOLVED";

export type RuntimeRoundResolution = {
  runtimePlayerId: string;
  submissionType: SubmissionType;
  calculatedPopulation: number;
  score: number;
  resolvedAt: Date;
};

export type RuntimePlayerRoundSnapshot = {
  player: RuntimePlayerSummary;
  state: RuntimePlayerRoundLifecycle;
  resolution?: RuntimeRoundResolution;
};

export type RuntimeRoundSnapshot = {
  roundNumber: number;
  targetPopulation: number;
  startedAt: Date;
  endsAt: Date;
  state: RuntimeRoundLifecycle;
  players: RuntimePlayerRoundSnapshot[];
};

export type RuntimeGameSnapshot = {
  runtimeGameId: string;
  type: RuntimeGameType;
  difficulty: GameDifficulty;
  state: RuntimeGameLifecycle;
  rounds: RuntimeRoundSnapshot[];
  currentRound?: RuntimeRoundSnapshot;
  resultPhase?: RuntimeResultPhaseSnapshot;
  abandonment?: RuntimeAbandonmentSnapshot;
  disconnectCompletion?: RuntimeDisconnectCompletionSnapshot;
  totals: Record<string, number>;
  completedAt?: Date;
};

export type RuntimeAbandonmentSnapshot = {
  abandonedRuntimePlayerId: string;
  winnerRuntimePlayerId: string;
  abandonedAt: Date;
};

export type RuntimeDisconnectCompletionSnapshot = {
  outcome: "FORFEIT";
  winnerRuntimePlayerId: string;
  forfeitedRuntimePlayerId: string;
  completedAt: Date;
};

export type RuntimeResultPhaseSnapshot = {
  roundNumber: number;
  state: "ANIMATING" | "WAITING";
  animationCompleteRuntimePlayerIds: string[];
  readyRuntimePlayerIds: string[];
  startedAt?: Date;
  endsAt?: Date;
};

export type RuntimeResolutionOutcome = {
  status: "APPLIED" | "DUPLICATE";
  resolution: RuntimeRoundResolution;
  roundAdvanced: boolean;
  roundResultStarted: boolean;
  deadlineUpdated: boolean;
  gameFinalized: boolean;
};

export type RuntimeReadyOutcome = {
  status: "APPLIED" | "DUPLICATE";
  roundNumber: number;
  readyRuntimePlayerIds: string[];
  roundAdvanced: boolean;
  nextRound?: RuntimeRoundSnapshot;
};

export type RuntimeResultAdvanceOutcome = {
  status: "APPLIED" | "STALE";
  roundAdvanced: boolean;
  nextRound?: RuntimeRoundSnapshot;
};

export type RuntimeDisconnectForfeitOutcome = {
  status: "APPLIED" | "DUPLICATE" | "STALE";
  disconnectCompletion?: RuntimeDisconnectCompletionSnapshot;
};

export type RuntimeAnimationCompleteOutcome = {
  status: "APPLIED" | "DUPLICATE" | "STALE";
  roundNumber: number;
  resultWaitStarted: boolean;
  resultPhase?: RuntimeResultPhaseSnapshot;
};

export type RuntimeAbandonOutcome = {
  status: "APPLIED" | "DUPLICATE" | "STALE";
  abandonment?: RuntimeAbandonmentSnapshot;
};

export type RuntimeTimeoutSubmissionRequest = {
  runtimeGameId: string;
  runtimePlayerId: string;
  roundNumber: number;
  submissionType: "TIMEOUT";
  requestedAt: Date;
};

type PlayerRoundState = {
  player: RuntimePlayer;
  state: RuntimePlayerRoundLifecycle;
  resolution?: RuntimeRoundResolution;
};

type RuntimeRoundState = {
  roundNumber: number;
  targetPopulation: number;
  startedAt: Date;
  endsAt: Date;
  state: RuntimeRoundLifecycle;
  players: PlayerRoundState[];
};

type RuntimeResultPhaseState = {
  roundNumber: number;
  state: "ANIMATING" | "WAITING";
  animationCompleteRuntimePlayerIds: Set<string>;
  readyRuntimePlayerIds: Set<string>;
  startedAt?: Date;
  endsAt?: Date;
};

type RuntimeAbandonmentState = {
  abandonedRuntimePlayerId: string;
  winnerRuntimePlayerId: string;
  abandonedAt: Date;
};

type RuntimeDisconnectCompletionState = {
  outcome: "FORFEIT";
  winnerRuntimePlayerId: string;
  forfeitedRuntimePlayerId: string;
  completedAt: Date;
};

type RuntimeGameOptions = {
  runtimeGameId: string;
  type: RuntimeGameType;
  difficulty: GameDifficulty;
  players: RuntimePlayer[];
  roundDurationMs: number;
  finalWindowMs: number;
  resultPhaseDurationMs: number;
  generateTarget: () => number;
};

type ResolvePlayerInput = {
  player: RuntimePlayer;
  roundNumber: number;
  submissionType: SubmissionType;
  calculatedPopulation: number;
  resolvedAt: Date;
};

export class RuntimeGameTransitionError extends Error {}

function validDate(value: Date) {
  return Number.isFinite(value.getTime());
}

function samePlayer(left: RuntimePlayer, right: RuntimePlayer) {
  if (left.kind !== right.kind) return false;
  if (left.runtimePlayerId !== right.runtimePlayerId) return false;

  if (left.kind === "registered") {
    return right.kind === "registered" && left.userId === right.userId;
  }

  return (
    right.kind === "guest" && left.guestSessionId === right.guestSessionId
  );
}

function resolutionSnapshot(resolution: RuntimeRoundResolution) {
  return { ...resolution, resolvedAt: new Date(resolution.resolvedAt) };
}

export class RuntimeGame {
  private lifecycle: RuntimeGameLifecycle = "CREATED";
  private readonly rounds: RuntimeRoundState[] = [];
  private readonly totals = new Map<string, number>();
  private resultPhase?: RuntimeResultPhaseState;
  private abandonment?: RuntimeAbandonmentState;
  private disconnectCompletion?: RuntimeDisconnectCompletionState;
  private completedAt?: Date;

  constructor(private readonly options: RuntimeGameOptions) {
    const expectedPlayers = options.type === "SINGLE" ? 1 : 2;
    if (options.players.length !== expectedPlayers) {
      throw new RuntimeGameTransitionError(
        `${options.type} requires ${expectedPlayers} player(s).`,
      );
    }
    if (
      new Set(options.players.map((player) => player.runtimePlayerId)).size !==
      options.players.length
    ) {
      throw new RuntimeGameTransitionError("Runtime players must be unique.");
    }
    if (!Number.isFinite(options.roundDurationMs) || options.roundDurationMs <= 0) {
      throw new RuntimeGameTransitionError("Round duration must be positive.");
    }
    if (!Number.isFinite(options.finalWindowMs) || options.finalWindowMs <= 0) {
      throw new RuntimeGameTransitionError("Final window must be positive.");
    }
    if (
      !Number.isFinite(options.resultPhaseDurationMs) ||
      options.resultPhaseDurationMs <= 0
    ) {
      throw new RuntimeGameTransitionError(
        "Result phase duration must be positive.",
      );
    }

    for (const player of options.players) {
      this.totals.set(player.runtimePlayerId, 0);
    }
  }

  start(startedAt: Date) {
    if (this.lifecycle !== "CREATED") {
      throw new RuntimeGameTransitionError("The game has already started.");
    }
    if (!validDate(startedAt)) {
      throw new RuntimeGameTransitionError("Game start time is invalid.");
    }

    const round = this.createRound(1, startedAt);
    this.lifecycle = "ROUND_ACTIVE";
    return this.roundSnapshot(round);
  }

  timeoutSubmissionRequest(
    player: RuntimePlayer,
    roundNumber: number,
    requestedAt: Date,
  ): RuntimeTimeoutSubmissionRequest | null {
    const { playerState } = this.playerRound(player, roundNumber);
    if (playerState.resolution) return null;
    const { round } = this.activePlayerRound(player, roundNumber);
    if (!validDate(requestedAt)) {
      throw new RuntimeGameTransitionError("Timeout request time is invalid.");
    }
    if (requestedAt < round.endsAt) {
      throw new RuntimeGameTransitionError("The round deadline has not passed.");
    }

    return {
      runtimeGameId: this.options.runtimeGameId,
      runtimePlayerId: player.runtimePlayerId,
      roundNumber,
      submissionType: "TIMEOUT",
      requestedAt: new Date(requestedAt),
    };
  }

  resolvePlayer(input: ResolvePlayerInput): RuntimeResolutionOutcome {
    const round = this.rounds.find(
      (candidate) => candidate.roundNumber === input.roundNumber,
    );
    const playerState = round?.players.find((candidate) =>
      samePlayer(candidate.player, input.player),
    );

    if (!round || !playerState) {
      throw new RuntimeGameTransitionError("Round or player not found.");
    }
    if (playerState.resolution) {
      return {
        status: "DUPLICATE",
        resolution: resolutionSnapshot(playerState.resolution),
        roundAdvanced: false,
        roundResultStarted: false,
        deadlineUpdated: false,
        gameFinalized: false,
      };
    }
    if (
      this.lifecycle !== "ROUND_ACTIVE" ||
      round !== this.rounds[this.rounds.length - 1] ||
      round.state !== "ACTIVE"
    ) {
      throw new RuntimeGameTransitionError("The round is not active.");
    }
    if (!validDate(input.resolvedAt)) {
      throw new RuntimeGameTransitionError("Resolution time is invalid.");
    }
    if (input.resolvedAt < round.startedAt) {
      throw new RuntimeGameTransitionError("The round has not started.");
    }
    if (
      input.submissionType === "MANUAL" &&
      input.resolvedAt >= round.endsAt
    ) {
      throw new RuntimeGameTransitionError("The manual submission is late.");
    }
    if (
      input.submissionType === "TIMEOUT" &&
      input.resolvedAt < round.endsAt
    ) {
      throw new RuntimeGameTransitionError("The round deadline has not passed.");
    }
    if (
      !Number.isFinite(input.calculatedPopulation) ||
      input.calculatedPopulation < 0
    ) {
      throw new RuntimeGameTransitionError("Calculated population is invalid.");
    }

    const calculatedPopulation = Math.round(input.calculatedPopulation);
    const resolution: RuntimeRoundResolution = {
      runtimePlayerId: input.player.runtimePlayerId,
      submissionType: input.submissionType,
      calculatedPopulation,
      score: calculateRoundScore(calculatedPopulation, round.targetPopulation),
      resolvedAt: new Date(input.resolvedAt),
    };
    playerState.state = "RESOLVED";
    playerState.resolution = resolution;
    this.totals.set(
      input.player.runtimePlayerId,
      (this.totals.get(input.player.runtimePlayerId) ?? 0) + resolution.score,
    );

    let deadlineUpdated = false;
    if (
      this.options.type === "DUEL" &&
      input.submissionType === "MANUAL" &&
      round.players.some(
        (candidate) =>
          candidate.player.runtimePlayerId !== input.player.runtimePlayerId &&
          candidate.state === "PENDING",
      )
    ) {
      const cappedDeadline = new Date(
        input.resolvedAt.getTime() + this.options.finalWindowMs,
      );
      if (cappedDeadline < round.endsAt) {
        round.endsAt = cappedDeadline;
        deadlineUpdated = true;
      }
    }

    let roundAdvanced = false;
    let roundResultStarted = false;
    let gameFinalized = false;
    if (round.players.every((candidate) => candidate.state === "RESOLVED")) {
      round.state = "RESOLVED";
      if (round.roundNumber === ROUND_COUNT) {
        this.lifecycle = "COMPLETE";
        this.completedAt = new Date(input.resolvedAt);
        gameFinalized = true;
      } else if (this.options.type === "DUEL") {
        this.lifecycle = "ROUND_RESULT";
        this.resultPhase = {
          roundNumber: round.roundNumber,
          state: "ANIMATING",
          animationCompleteRuntimePlayerIds: new Set(),
          readyRuntimePlayerIds: new Set(),
        };
        roundResultStarted = true;
      } else {
        this.createRound(round.roundNumber + 1, input.resolvedAt);
        roundAdvanced = true;
      }
    }

    return {
      status: "APPLIED",
      resolution: resolutionSnapshot(resolution),
      roundAdvanced,
      roundResultStarted,
      deadlineUpdated,
      gameFinalized,
    };
  }

  completeResultAnimation(
    player: RuntimePlayer,
    roundNumber: number,
    completedAt: Date,
  ): RuntimeAnimationCompleteOutcome {
    if (!validDate(completedAt)) {
      throw new RuntimeGameTransitionError(
        "Result animation completion time is invalid.",
      );
    }
    if (
      this.lifecycle !== "ROUND_RESULT" ||
      this.resultPhase?.roundNumber !== roundNumber
    ) {
      return { status: "STALE", roundNumber, resultWaitStarted: false };
    }

    const phase = this.resultPhase;
    this.playerRound(player, roundNumber);
    if (
      phase.animationCompleteRuntimePlayerIds.has(player.runtimePlayerId)
    ) {
      return {
        status: "DUPLICATE",
        roundNumber,
        resultWaitStarted: false,
        resultPhase: this.resultPhaseSnapshot(phase),
      };
    }
    if (phase.state !== "ANIMATING") {
      return { status: "STALE", roundNumber, resultWaitStarted: false };
    }

    phase.animationCompleteRuntimePlayerIds.add(player.runtimePlayerId);
    if (
      phase.animationCompleteRuntimePlayerIds.size < this.options.players.length
    ) {
      return {
        status: "APPLIED",
        roundNumber,
        resultWaitStarted: false,
        resultPhase: this.resultPhaseSnapshot(phase),
      };
    }

    phase.state = "WAITING";
    phase.startedAt = new Date(completedAt);
    phase.endsAt = new Date(
      completedAt.getTime() + this.options.resultPhaseDurationMs,
    );
    return {
      status: "APPLIED",
      roundNumber,
      resultWaitStarted: true,
      resultPhase: this.resultPhaseSnapshot(phase),
    };
  }

  abandon(player: RuntimePlayer, abandonedAt: Date): RuntimeAbandonOutcome {
    if (this.options.type !== "DUEL") {
      throw new RuntimeGameTransitionError("Only a Duel can be abandoned here.");
    }
    if (!validDate(abandonedAt)) {
      throw new RuntimeGameTransitionError("Abandon time is invalid.");
    }
    const abandoningPlayer = this.gamePlayer(player);

    if (this.lifecycle === "COMPLETE") {
      return this.abandonment
        ? {
            status: "DUPLICATE",
            abandonment: this.abandonmentSnapshot(this.abandonment),
          }
        : { status: "STALE" };
    }
    if (
      this.lifecycle !== "ROUND_ACTIVE" &&
      this.lifecycle !== "ROUND_RESULT"
    ) {
      throw new RuntimeGameTransitionError("The Duel has not started.");
    }

    const winner = this.options.players.find(
      (candidate) =>
        candidate.runtimePlayerId !== abandoningPlayer.runtimePlayerId,
    );
    if (!winner) {
      throw new RuntimeGameTransitionError("The Duel opponent was not found.");
    }

    this.abandonment = {
      abandonedRuntimePlayerId: abandoningPlayer.runtimePlayerId,
      winnerRuntimePlayerId: winner.runtimePlayerId,
      abandonedAt: new Date(abandonedAt),
    };
    this.lifecycle = "COMPLETE";
    this.completedAt = new Date(abandonedAt);
    this.resultPhase = undefined;

    return {
      status: "APPLIED",
      abandonment: this.abandonmentSnapshot(this.abandonment),
    };
  }

  readyForNextRound(
    player: RuntimePlayer,
    roundNumber: number,
    readyAt: Date,
  ): RuntimeReadyOutcome {
    if (!validDate(readyAt)) {
      throw new RuntimeGameTransitionError("Ready time is invalid.");
    }
    const phase = this.activeResultWait(roundNumber);
    this.playerRound(player, roundNumber);

    if (phase.readyRuntimePlayerIds.has(player.runtimePlayerId)) {
      return {
        status: "DUPLICATE",
        roundNumber,
        readyRuntimePlayerIds: [...phase.readyRuntimePlayerIds],
        roundAdvanced: false,
      };
    }

    phase.readyRuntimePlayerIds.add(player.runtimePlayerId);
    if (phase.readyRuntimePlayerIds.size < this.options.players.length) {
      return {
        status: "APPLIED",
        roundNumber,
        readyRuntimePlayerIds: [...phase.readyRuntimePlayerIds],
        roundAdvanced: false,
      };
    }

    const readyRuntimePlayerIds = [...phase.readyRuntimePlayerIds];
    const nextRound = this.startNextRound(roundNumber, readyAt);
    return {
      status: "APPLIED",
      roundNumber,
      readyRuntimePlayerIds,
      roundAdvanced: true,
      nextRound,
    };
  }

  advanceResultPhase(
    roundNumber: number,
    advancedAt: Date,
  ): RuntimeResultAdvanceOutcome {
    if (!validDate(advancedAt)) {
      throw new RuntimeGameTransitionError("Result advance time is invalid.");
    }
    if (
      this.lifecycle !== "ROUND_RESULT" ||
      this.resultPhase?.roundNumber !== roundNumber ||
      this.resultPhase.state !== "WAITING" ||
      !this.resultPhase.endsAt
    ) {
      return { status: "STALE", roundAdvanced: false };
    }
    if (advancedAt < this.resultPhase.endsAt) {
      throw new RuntimeGameTransitionError("The result phase is still active.");
    }

    return {
      status: "APPLIED",
      roundAdvanced: true,
      nextRound: this.startNextRound(roundNumber, advancedAt),
    };
  }

  forfeitDisconnectedPlayer(
    player: RuntimePlayer,
    completedAt: Date,
  ): RuntimeDisconnectForfeitOutcome {
    if (this.options.type !== "DUEL") {
      throw new RuntimeGameTransitionError("Only a Duel can end by disconnect.");
    }
    if (!validDate(completedAt)) {
      throw new RuntimeGameTransitionError("Disconnect time is invalid.");
    }
    const forfeitedPlayer = this.gamePlayer(player);

    if (this.lifecycle === "COMPLETE") {
      return this.disconnectCompletion
        ? {
            status: "DUPLICATE",
            disconnectCompletion: this.disconnectCompletionSnapshot(
              this.disconnectCompletion,
            ),
          }
        : { status: "STALE" };
    }
    if (
      this.lifecycle !== "ROUND_ACTIVE" &&
      this.lifecycle !== "ROUND_RESULT"
    ) {
      throw new RuntimeGameTransitionError("The Duel has not started.");
    }

    const winner = this.options.players.find(
      (candidate) =>
        candidate.runtimePlayerId !== forfeitedPlayer.runtimePlayerId,
    );
    if (!winner) {
      throw new RuntimeGameTransitionError("The Duel opponent was not found.");
    }

    this.disconnectCompletion = {
      outcome: "FORFEIT",
      winnerRuntimePlayerId: winner.runtimePlayerId,
      forfeitedRuntimePlayerId: forfeitedPlayer.runtimePlayerId,
      completedAt: new Date(completedAt),
    };
    this.lifecycle = "COMPLETE";
    this.completedAt = new Date(completedAt);
    this.resultPhase = undefined;

    return {
      status: "APPLIED",
      disconnectCompletion: this.disconnectCompletionSnapshot(
        this.disconnectCompletion,
      ),
    };
  }

  snapshot(): RuntimeGameSnapshot {
    const rounds = this.rounds.map((round) => this.roundSnapshot(round));
    return {
      runtimeGameId: this.options.runtimeGameId,
      type: this.options.type,
      difficulty: this.options.difficulty,
      state: this.lifecycle,
      rounds,
      currentRound:
        this.lifecycle === "ROUND_ACTIVE" ? rounds[rounds.length - 1] : undefined,
      resultPhase: this.resultPhase
        ? this.resultPhaseSnapshot(this.resultPhase)
        : undefined,
      abandonment: this.abandonment
        ? this.abandonmentSnapshot(this.abandonment)
        : undefined,
      disconnectCompletion: this.disconnectCompletion
        ? this.disconnectCompletionSnapshot(this.disconnectCompletion)
        : undefined,
      totals: Object.fromEntries(this.totals),
      completedAt: this.completedAt ? new Date(this.completedAt) : undefined,
    };
  }

  private createRound(roundNumber: number, startedAt: Date) {
    const targetPopulation = this.options.generateTarget();
    if (!Number.isFinite(targetPopulation) || targetPopulation <= 0) {
      throw new RuntimeGameTransitionError("Generated target is invalid.");
    }

    const round: RuntimeRoundState = {
      roundNumber,
      targetPopulation: Math.round(targetPopulation),
      startedAt: new Date(startedAt),
      endsAt: new Date(startedAt.getTime() + this.options.roundDurationMs),
      state: "ACTIVE",
      players: this.options.players.map((player) => ({
        player,
        state: "PENDING",
      })),
    };
    this.rounds.push(round);
    return round;
  }

  private activeResultPhase(roundNumber: number) {
    if (
      this.options.type !== "DUEL" ||
      this.lifecycle !== "ROUND_RESULT" ||
      !this.resultPhase ||
      this.resultPhase.roundNumber !== roundNumber
    ) {
      throw new RuntimeGameTransitionError("The round result phase is not active.");
    }
    return this.resultPhase;
  }

  private activeResultWait(roundNumber: number) {
    const phase = this.activeResultPhase(roundNumber);
    if (phase.state !== "WAITING" || !phase.startedAt || !phase.endsAt) {
      throw new RuntimeGameTransitionError(
        "The round result wait has not started.",
      );
    }
    return phase;
  }

  private startNextRound(roundNumber: number, startedAt: Date) {
    this.activeResultPhase(roundNumber);
    const nextRound = this.createRound(roundNumber + 1, startedAt);
    this.resultPhase = undefined;
    this.lifecycle = "ROUND_ACTIVE";
    return this.roundSnapshot(nextRound);
  }

  private playerRound(player: RuntimePlayer, roundNumber: number) {
    const round = this.rounds.find(
      (candidate) => candidate.roundNumber === roundNumber,
    );
    const playerState = round?.players.find((candidate) =>
      samePlayer(candidate.player, player),
    );
    if (!round || !playerState) {
      throw new RuntimeGameTransitionError("Round or player not found.");
    }

    return { round, playerState };
  }

  private gamePlayer(player: RuntimePlayer) {
    const participant = this.options.players.find((candidate) =>
      samePlayer(candidate, player),
    );
    if (!participant) {
      throw new RuntimeGameTransitionError("Player not found.");
    }
    return participant;
  }

  private activePlayerRound(player: RuntimePlayer, roundNumber: number) {
    const { round, playerState } = this.playerRound(player, roundNumber);
    if (
      this.lifecycle !== "ROUND_ACTIVE" ||
      round !== this.rounds[this.rounds.length - 1] ||
      round.state !== "ACTIVE" ||
      playerState.state !== "PENDING"
    ) {
      throw new RuntimeGameTransitionError("The round is not active.");
    }

    return { round, playerState };
  }

  private roundSnapshot(round: RuntimeRoundState): RuntimeRoundSnapshot {
    return {
      roundNumber: round.roundNumber,
      targetPopulation: round.targetPopulation,
      startedAt: new Date(round.startedAt),
      endsAt: new Date(round.endsAt),
      state: round.state,
      players: round.players.map((playerState) => ({
        player: toRuntimePlayerSummary(playerState.player),
        state: playerState.state,
        resolution: playerState.resolution
          ? resolutionSnapshot(playerState.resolution)
          : undefined,
      })),
    };
  }

  private resultPhaseSnapshot(
    resultPhase: RuntimeResultPhaseState,
  ): RuntimeResultPhaseSnapshot {
    return {
      roundNumber: resultPhase.roundNumber,
      state: resultPhase.state,
      animationCompleteRuntimePlayerIds: [
        ...resultPhase.animationCompleteRuntimePlayerIds,
      ],
      readyRuntimePlayerIds: [...resultPhase.readyRuntimePlayerIds],
      startedAt: resultPhase.startedAt
        ? new Date(resultPhase.startedAt)
        : undefined,
      endsAt: resultPhase.endsAt ? new Date(resultPhase.endsAt) : undefined,
    };
  }

  private abandonmentSnapshot(
    abandonment: RuntimeAbandonmentState,
  ): RuntimeAbandonmentSnapshot {
    return {
      abandonedRuntimePlayerId: abandonment.abandonedRuntimePlayerId,
      winnerRuntimePlayerId: abandonment.winnerRuntimePlayerId,
      abandonedAt: new Date(abandonment.abandonedAt),
    };
  }

  private disconnectCompletionSnapshot(
    completion: RuntimeDisconnectCompletionState,
  ): RuntimeDisconnectCompletionSnapshot {
    return {
      outcome: completion.outcome,
      winnerRuntimePlayerId: completion.winnerRuntimePlayerId,
      forfeitedRuntimePlayerId: completion.forfeitedRuntimePlayerId,
      completedAt: new Date(completion.completedAt),
    };
  }
}
