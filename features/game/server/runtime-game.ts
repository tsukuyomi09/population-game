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
export type RuntimeGameLifecycle = "CREATED" | "ROUND_ACTIVE" | "COMPLETE";
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
  totals: Record<string, number>;
  completedAt?: Date;
};

export type RuntimeResolutionOutcome = {
  status: "APPLIED" | "DUPLICATE";
  resolution: RuntimeRoundResolution;
  roundAdvanced: boolean;
  gameFinalized: boolean;
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

type RuntimeGameOptions = {
  runtimeGameId: string;
  type: RuntimeGameType;
  difficulty: GameDifficulty;
  players: RuntimePlayer[];
  roundDurationMs: number;
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

    let roundAdvanced = false;
    let gameFinalized = false;
    if (round.players.every((candidate) => candidate.state === "RESOLVED")) {
      round.state = "RESOLVED";
      if (round.roundNumber === ROUND_COUNT) {
        this.lifecycle = "COMPLETE";
        this.completedAt = new Date(input.resolvedAt);
        gameFinalized = true;
      } else {
        this.createRound(round.roundNumber + 1, input.resolvedAt);
        roundAdvanced = true;
      }
    }

    return {
      status: "APPLIED",
      resolution: resolutionSnapshot(resolution),
      roundAdvanced,
      gameFinalized,
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
}
