import "server-only";
import { SingleGameService } from "./single-game-service";
import { singleGamePersistence } from "./single-game-persistence";
import { generateTarget } from "./target";

const globalForSingleGames = globalThis as typeof globalThis & {
  worldrawingSingleGames?: SingleGameService;
};

export function singleGames() {
  if (!globalForSingleGames.worldrawingSingleGames) {
    globalForSingleGames.worldrawingSingleGames = new SingleGameService(
      singleGamePersistence,
      generateTarget,
    );
  }

  return globalForSingleGames.worldrawingSingleGames;
}
