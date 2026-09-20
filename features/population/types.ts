import type { Polygon } from "geojson";

export type PopulationShape = {
  id: string | number;
  geometry: Polygon;
};

export type PopulationRequest = {
  shapes: PopulationShape[];
  targetPopulation: number;
};

export type PopulationResult = {
  id: string | number;
  population: number;
};

export type PopulationResponse = {
  results: PopulationResult[];
  totalPopulation: number;
};
