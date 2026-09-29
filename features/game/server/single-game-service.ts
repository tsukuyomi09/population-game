import { randomUUID } from "node:crypto";
import {
  calculateRoundScore,
  ROUND_COUNT,
  type GameDifficulty,
  type SubmissionType,
} from "../single-player";
import {
  isRegisteredRuntimePlayer,
  type RuntimePlayer,
} from "../runtime-player";

export type PersistentSingleGame = {
  gameId: string;
  gamePlayerId: string;
  roundId: string;
};

export type SingleGamePersistence = {
  createGame(input: {
    userId: string;
    difficulty: GameDifficulty;
    roundNumber: number;
    targetPopulation: number;
    startedAt: Date;
  }): Promise<PersistentSingleGame>;
  createRound(input: {
    gameId: string;
    gamePlayerId: string;
    roundNumber: number;
    targetPopulation: number;
    startedAt: Date;
  }): Promise<{ roundId: string }>;
  resolveRound(input: {
    gameId: string;
    gamePlayerId: string;
    roundId: string;
    roundNumber: number;
    calculatedPopulation: number;
    score: number;
    submissionType: SubmissionType;
    submittedAt: Date;
    completeGame: boolean;
  }): Promise<{ totalScore: number }>;
  abandonGame(input: {
    gameId: string;
    gamePlayerId: string;
    endedAt: Date;
  }): Promise<{ totalScore: number }>;
};

type RuntimeRoundResult = {
  calculatedPopulation: number;
  score: number;
  submissionType: SubmissionType;
  totalScore: number;
  complete: boolean;
};

type RuntimeSingleGame = {
  runtimeGameId: string;
  player: RuntimePlayer;
  difficulty: GameDifficulty;
  status: "ACTIVE" | "COMPLETED" | "ABANDONED";
  totalScore: number;
  actionPending: boolean;
  currentRound: {
    roundNumber: number;
    targetPopulation: number;
    persistentRoundId?: string;
    result?: RuntimeRoundResult;
  };
  persistent?: {
    gameId: string;
    gamePlayerId: string;
  };
};

export type SingleRoundState = {
  runtimeGameId: string;
  difficulty: GameDifficulty;
  roundNumber: number;
  target: number;
};

export class SingleGameError extends Error {
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

  return (
    left.kind === "guest" ||
    (right.kind === "registered" && left.userId === right.userId)
  );
}

export class SingleGameService {
  private readonly games = new Map<string, RuntimeSingleGame>();

  constructor(
    private readonly persistence: SingleGamePersistence,
    private readonly generateTarget: () => number,
    private readonly generateRuntimeGameId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async startGame(
    player: RuntimePlayer,
    difficulty: GameDifficulty,
  ): Promise<SingleRoundState> {
    const runtimeGameId = this.generateRuntimeGameId();
    const targetPopulation = this.generateTarget();
    const startedAt = this.now();
    const game: RuntimeSingleGame = {
      runtimeGameId,
      player,
      difficulty,
      status: "ACTIVE",
      totalScore: 0,
      actionPending: false,
      currentRound: {
        roundNumber: 1,
        targetPopulation,
      },
    };

    if (isRegisteredRuntimePlayer(player)) {
      const persistent = await this.persistence.createGame({
        userId: player.userId,
        difficulty,
        roundNumber: 1,
        targetPopulation,
        startedAt,
      });
      game.persistent = {
        gameId: persistent.gameId,
        gamePlayerId: persistent.gamePlayerId,
      };
      game.currentRound.persistentRoundId = persistent.roundId;
    }

    this.games.set(runtimeGameId, game);
    return this.roundState(game);
  }

  async startNextRound(
    player: RuntimePlayer,
    runtimeGameId: string,
  ): Promise<SingleRoundState> {
    const game = this.ownedGame(player, runtimeGameId);
    if (game.status !== "ACTIVE") {
      throw new SingleGameError("The game is already finished.", 409);
    }
    if (game.actionPending) {
      throw new SingleGameError("Another game action is already pending.", 409);
    }
    if (!game.currentRound.result) {
      throw new SingleGameError("The current round is not resolved.", 409);
    }
    if (game.currentRound.roundNumber >= ROUND_COUNT) {
      throw new SingleGameError("The game has no next round.", 409);
    }

    game.actionPending = true;
    try {
      const roundNumber = game.currentRound.roundNumber + 1;
      const targetPopulation = this.generateTarget();
      const startedAt = this.now();
      let persistentRoundId: string | undefined;

      if (game.persistent) {
        const round = await this.persistence.createRound({
          ...game.persistent,
          roundNumber,
          targetPopulation,
          startedAt,
        });
        persistentRoundId = round.roundId;
      }

      game.currentRound = {
        roundNumber,
        targetPopulation,
        persistentRoundId,
      };

      return this.roundState(game);
    } finally {
      game.actionPending = false;
    }
  }

  async resolveRound(
    player: RuntimePlayer,
    runtimeGameId: string,
    submissionType: SubmissionType,
    calculatePopulation: () => Promise<number>,
  ): Promise<RuntimeRoundResult> {
    const game = this.ownedGame(player, runtimeGameId);
    if (game.currentRound.result) {
      throw new SingleGameError("The current round is already resolved.", 409);
    }
    if (game.status !== "ACTIVE") {
      throw new SingleGameError("The game is already finished.", 409);
    }
    if (game.actionPending) {
      throw new SingleGameError("Another game action is already pending.", 409);
    }

    game.actionPending = true;
    try {
      const population = await calculatePopulation();
      if (!Number.isFinite(population) || population < 0) {
        throw new SingleGameError("Population calculation was invalid.", 502);
      }

      const calculatedPopulation = Math.round(population);
      const score = calculateRoundScore(
        population,
        game.currentRound.targetPopulation,
      );
      const complete = game.currentRound.roundNumber === ROUND_COUNT;
      let totalScore = game.totalScore + score;

      if (game.persistent) {
        const roundId = game.currentRound.persistentRoundId;
        if (!roundId) {
          throw new Error("A persistent game is missing its current round id.");
        }

        const resolved = await this.persistence.resolveRound({
          ...game.persistent,
          roundId,
          roundNumber: game.currentRound.roundNumber,
          calculatedPopulation,
          score,
          submissionType,
          submittedAt: this.now(),
          completeGame: complete,
        });
        totalScore = resolved.totalScore;
      }

      const result = {
        calculatedPopulation,
        score,
        submissionType,
        totalScore,
        complete,
      };
      game.currentRound.result = result;
      game.totalScore = totalScore;
      if (complete) game.status = "COMPLETED";

      return result;
    } finally {
      game.actionPending = false;
    }
  }

  async abandonGame(player: RuntimePlayer, runtimeGameId: string) {
    const game = this.ownedGame(player, runtimeGameId);
    if (game.status === "ABANDONED") {
      return { totalScore: game.totalScore };
    }
    if (game.status !== "ACTIVE") {
      throw new SingleGameError("The game is already finished.", 409);
    }
    if (game.actionPending) {
      throw new SingleGameError("Another game action is already pending.", 409);
    }

    game.actionPending = true;
    try {
      let totalScore = game.totalScore;
      if (game.persistent) {
        const abandoned = await this.persistence.abandonGame({
          ...game.persistent,
          endedAt: this.now(),
        });
        totalScore = abandoned.totalScore;
      }

      game.totalScore = totalScore;
      game.status = "ABANDONED";
      return { totalScore };
    } finally {
      game.actionPending = false;
    }
  }

  private ownedGame(player: RuntimePlayer, runtimeGameId: string) {
    const game = this.games.get(runtimeGameId);
    if (!game || !samePlayer(game.player, player)) {
      throw new SingleGameError("Game not found.", 404);
    }

    return game;
  }

  private roundState(game: RuntimeSingleGame): SingleRoundState {
    return {
      runtimeGameId: game.runtimeGameId,
      difficulty: game.difficulty,
      roundNumber: game.currentRound.roundNumber,
      target: game.currentRound.targetPopulation,
    };
  }
}
