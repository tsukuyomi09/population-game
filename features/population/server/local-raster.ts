import "server-only";

import type { PopulationResult, PopulationShape } from "../types";
import {
  calculatePopulationWithService,
  populationServiceConfigFromEnvironment,
} from "./population-service-client";

export async function localRasterPopulationProvider(
  shapes: PopulationShape[],
): Promise<PopulationResult[]> {
  if (shapes.length === 0) return [];
  return calculatePopulationWithService(
    shapes,
    populationServiceConfigFromEnvironment(process.env),
  );
}
