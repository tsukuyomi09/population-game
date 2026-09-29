import "server-only";

import type {
  PopulationResult,
  PopulationShape,
} from "../types";
import { localRasterPopulationProvider } from "./local-raster";
import { worldPopPopulationProvider } from "./worldpop";

export type PopulationProvider = (
  shapes: PopulationShape[],
) => Promise<PopulationResult[]>;

export const populationProvider: PopulationProvider = (shapes) => {
  const configuredProvider = process.env.POPULATION_PROVIDER ?? "worldpop";

  if (configuredProvider === "worldpop") {
    return worldPopPopulationProvider(shapes);
  }

  if (configuredProvider === "local") {
    return localRasterPopulationProvider(shapes);
  }

  throw new Error(
    `Unsupported POPULATION_PROVIDER value ${JSON.stringify(configuredProvider)}. Expected "worldpop" or "local".`,
  );
};
