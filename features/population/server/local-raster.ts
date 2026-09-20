import "server-only";

import type { PopulationResult, PopulationShape } from "../types";
import type { PopulationCalculationMode } from "./calculation-mode";
import {
  calculatePopulationWithService,
  populationServiceConfigFromEnvironment,
} from "./population-service-client";

export async function localRasterPopulationProvider(
  shapes: PopulationShape[],
  calculationMode: PopulationCalculationMode,
): Promise<PopulationResult[]> {
  if (shapes.length === 0) return [];
  return calculatePopulationWithService(
    shapes,
    calculationMode,
    populationServiceConfigFromEnvironment(process.env),
  );
}
