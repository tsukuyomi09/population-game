#!/usr/bin/env node
/** Measure game-score impact from center-inclusion population differences. */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";


const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIRECTORY, "../..");
const DEFAULT_INPUT = path.join(
  ROOT,
  "artifacts/population/area-threshold-benchmark.csv",
);
const DEFAULT_OUTPUT = path.join(
  ROOT,
  "artifacts/population/score-impact-benchmark.csv",
);
const GAME_MODULE = path.join(ROOT, "features/game/game.ts");
const ZERO_REFERENCE_TARGET = 1_000;


function parseCsv(source) {
  const lines = source.trim().split(/\r?\n/u);
  if (lines.length < 2) throw new Error("Population benchmark CSV is empty.");
  const headers = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const values = line.split(",");
    if (values.length !== headers.length) {
      throw new Error(`Malformed population benchmark CSV row: ${line}`);
    }
    return Object.fromEntries(headers.map((header, index) => [header, values[index]]));
  });
}


function csvValue(value) {
  const text = String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}


function serializeCsv(rows) {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvValue(row[header])).join(",")),
  ].join("\n") + "\n";
}


async function loadGameScoring() {
  const jiti = createJiti(import.meta.url);
  const game = await jiti.import(GAME_MODULE);
  if (
    typeof game.calculateRoundScore !== "function" ||
    typeof game.MAX_ROUND_SCORE !== "number"
  ) {
    throw new Error("Could not load the production game scoring exports.");
  }
  return game;
}


function numberField(row, field) {
  const value = Number(row[field]);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid ${field} for ${row.case}: ${row[field]}`);
  }
  return value;
}


function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}


function percentile95(values) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)];
}


function formatPopulation(value) {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  });
}


function printReport(results, maxRoundScore) {
  console.log(
    "case                                  fractional       center     pop diff %  fractional score  center score  score diff",
  );
  console.log("-".repeat(132));
  for (const result of results) {
    console.log(
      `${result.case.padEnd(36)} ` +
      `${formatPopulation(result.fractionalPopulation).padStart(14)} ` +
      `${formatPopulation(result.centerPopulation).padStart(12)} ` +
      `${result.populationDifferencePercentage.toFixed(6).padStart(14)} ` +
      `${String(result.fractionalScore).padStart(17)} ` +
      `${String(result.centerScore).padStart(13)} ` +
      `${String(result.scoreDifference).padStart(11)}`,
    );
  }

  const differences = results.map((result) => result.scoreDifference);
  const worst = results.reduce((current, result) =>
    result.scoreDifference > current.scoreDifference ? result : current,
  );
  const unchanged = results.filter((result) => result.scoreDifference === 0).length;
  const withinOne = results.filter((result) => result.scoreDifference <= 1).length;
  const withinTen = results.filter((result) => result.scoreDifference <= 10).length;

  console.log("\nOverall score impact");
  console.log(`  cases: ${results.length}`);
  console.log(`  median absolute score difference: ${median(differences)}`);
  console.log(
    `  worst absolute score difference: ${worst.scoreDifference} (${worst.case})`,
  );
  console.log(
    `  exactly unchanged: ${unchanged}/${results.length} (${(unchanged / results.length * 100).toFixed(1)}%)`,
  );
  console.log(
    `  <=1 point (${(1 / maxRoundScore * 100).toFixed(2)}% of a round): ` +
    `${withinOne}/${results.length} (${(withinOne / results.length * 100).toFixed(1)}%)`,
  );
  console.log(
    `  <=10 points (${(10 / maxRoundScore * 100).toFixed(2)}% of a round): ` +
    `${withinTen}/${results.length} (${(withinTen / results.length * 100).toFixed(1)}%)`,
  );

  const areas = [...new Set(results.map((result) => result.targetAreaKm2))]
    .sort((left, right) => left - right);
  console.log("\nScore impact by polygon scale");
  console.log("area km2  cases  median  p95  max  unchanged  <=1 point  <=10 points");
  console.log("-".repeat(75));
  for (const area of areas) {
    const group = results.filter((result) => result.targetAreaKm2 === area);
    const groupDifferences = group.map((result) => result.scoreDifference);
    console.log(
      `${area.toLocaleString("en-US").padStart(8)} ` +
      `${String(group.length).padStart(6)} ` +
      `${String(median(groupDifferences)).padStart(7)} ` +
      `${String(percentile95(groupDifferences)).padStart(4)} ` +
      `${String(Math.max(...groupDifferences)).padStart(4)} ` +
      `${String(groupDifferences.filter((value) => value === 0).length).padStart(9)} ` +
      `${String(groupDifferences.filter((value) => value <= 1).length).padStart(10)} ` +
      `${String(groupDifferences.filter((value) => value <= 10).length).padStart(12)}`,
    );
  }

  const geometryKinds = [...new Set(results.map((result) => result.geometry))].sort();
  console.log("\nMeaningful impact by geometry type (>1 point)");
  for (const geometry of geometryKinds) {
    const group = results.filter((result) => result.geometry === geometry);
    const meaningful = group.filter((result) => result.scoreDifference > 1);
    console.log(
      `  ${geometry}: ${meaningful.length}/${group.length}; ` +
      `worst ${Math.max(...group.map((result) => result.scoreDifference))}`,
    );
  }
}


async function main() {
  const inputPath = path.resolve(process.argv[2] ?? DEFAULT_INPUT);
  const outputPath = path.resolve(process.argv[3] ?? DEFAULT_OUTPUT);
  const [source, game] = await Promise.all([
    readFile(inputPath, "utf8"),
    loadGameScoring(),
  ]);
  const populationRows = parseCsv(source);
  const results = populationRows.map((row) => {
    const fractionalPopulation = numberField(row, "fractional_population");
    const centerPopulation = numberField(row, "center_population");
    const referenceTarget = fractionalPopulation > 0
      ? fractionalPopulation
      : ZERO_REFERENCE_TARGET;
    const fractionalScore = game.calculateRoundScore(
      fractionalPopulation,
      referenceTarget,
    );
    const centerScore = game.calculateRoundScore(centerPopulation, referenceTarget);
    return {
      case: row.case,
      location: row.location,
      geometry: row.geometry,
      targetAreaKm2: numberField(row, "target_area_km2"),
      measuredAreaKm2: numberField(row, "measured_area_km2"),
      referenceTarget,
      fractionalPopulation,
      centerPopulation,
      populationDifferencePercentage: numberField(row, "percentage_difference"),
      fractionalScore,
      centerScore,
      scoreDifference: Math.abs(centerScore - fractionalScore),
    };
  });
  if (results.length !== 104) {
    throw new Error(`Expected 104 population cases, found ${results.length}.`);
  }

  const outputRows = results.map((result) => ({
    case: result.case,
    location: result.location,
    geometry: result.geometry,
    target_area_km2: result.targetAreaKm2,
    measured_area_km2: result.measuredAreaKm2,
    reference_target: result.referenceTarget,
    fractional_population: result.fractionalPopulation,
    center_population: result.centerPopulation,
    population_difference_percentage: result.populationDifferencePercentage,
    fractional_score: result.fractionalScore,
    center_score: result.centerScore,
    absolute_score_difference: result.scoreDifference,
  }));
  await writeFile(outputPath, serializeCsv(outputRows), "utf8");
  console.log(`Scoring implementation: ${GAME_MODULE}`);
  console.log(`Detailed CSV: ${outputPath}\n`);
  printReport(results, game.MAX_ROUND_SCORE);
}


main().catch((error) => {
  console.error(`Score impact benchmark error: ${error.message}`);
  process.exitCode = 1;
});
