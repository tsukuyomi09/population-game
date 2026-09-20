export const CENTER_INCLUSION_TARGET_THRESHOLD = 20_000_000;

export type PopulationCalculationMode = "fractional" | "center";

export function selectPopulationCalculationMode(
  targetPopulation: number,
): PopulationCalculationMode {
  return targetPopulation >= CENTER_INCLUSION_TARGET_THRESHOLD
    ? "center"
    : "fractional";
}
