#!/usr/bin/env node
/** Evaluate center-inclusion score impact across representative game targets. */

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
  "artifacts/population/target-score-impact-benchmark.csv",
);
const GAME_MODULE = path.join(ROOT, "features/game/game.ts");

// Valid 100-point targets spanning the five bands in features/game/server/target.ts.
const TARGETS = [
  1_000,
  2_500,
  5_000,
  10_000,
  25_000,
  50_000,
  75_000,
  100_000,
  250_000,
  500_000,
  750_000,
  1_000_000,
  1_250_000,
  1_500_000,
  1_750_000,
  2_000_000,
  2_500_000,
  5_000_000,
  7_500_000,
  10_000_000,
  12_500_000,
  15_000_000,
  17_500_000,
  20_000_000,
  25_000_000,
  50_000_000,
  75_000_000,
  100_000_000,
  250_000_000,
  500_000_000,
  750_000_000,
  1_000_000_000,
];
const HEADLINE_TARGETS = new Set([
  1_000,
  10_000,
  100_000,
  1_000_000,
  10_000_000,
  100_000_000,
  1_000_000_000,
]);


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


function percentage(count, total) {
  return count / total * 100;
}


function summarize(results) {
  const differences = results.map((result) => result.scoreDifference);
  return {
    median: median(differences),
    worst: Math.max(...differences),
    withinOne: percentage(differences.filter((value) => value <= 1).length, results.length),
    withinTen: percentage(differences.filter((value) => value <= 10).length, results.length),
    withinHundred: percentage(
      differences.filter((value) => value <= 100).length,
      results.length,
    ),
  };
}


function printSummary(results) {
  console.log("* marks the requested headline target scales.\n");
  console.log(
    "target          cases  median  worst  within 1 point  within 10 points  within 100 points",
  );
  console.log("-".repeat(89));
  for (const target of TARGETS) {
    const group = results.filter((result) => result.target === target);
    const summary = summarize(group);
    const marker = HEADLINE_TARGETS.has(target) ? "*" : " ";
    console.log(
      `${marker}${target.toLocaleString("en-US").padStart(13)} ` +
      `${String(group.length).padStart(6)} ` +
      `${String(summary.median).padStart(7)} ` +
      `${String(summary.worst).padStart(6)} ` +
      `${summary.withinOne.toFixed(1).padStart(14)}% ` +
      `${summary.withinTen.toFixed(1).padStart(17)}% ` +
      `${summary.withinHundred.toFixed(1).padStart(18)}%`,
    );
  }

  console.log("\nObserved cutoff audit across every sampled target at/above cutoff");
  for (const tolerance of [1, 10, 100]) {
    let observedCutoff = null;
    let observedWorst = null;
    for (const candidate of TARGETS) {
      const eligible = results.filter((result) => result.target >= candidate);
      const worst = Math.max(...eligible.map((result) => result.scoreDifference));
      if (worst <= tolerance) {
        observedCutoff = candidate;
        observedWorst = worst;
        break;
      }
    }
    if (observedCutoff === null) {
      console.log(`  <=${tolerance} points: no sampled cutoff`);
    } else {
      console.log(
        `  <=${tolerance} points: ${observedCutoff.toLocaleString("en-US")} ` +
        `(${results.filter((result) => result.target >= observedCutoff).length} ` +
        `comparisons; worst ${observedWorst})`,
      );
    }
  }
}


async function main() {
  const inputPath = path.resolve(process.argv[2] ?? DEFAULT_INPUT);
  const outputPath = path.resolve(process.argv[3] ?? DEFAULT_OUTPUT);
  const jiti = createJiti(import.meta.url);
  const [source, game] = await Promise.all([
    readFile(inputPath, "utf8"),
    jiti.import(GAME_MODULE),
  ]);
  if (typeof game.calculateRoundScore !== "function") {
    throw new Error("Could not load calculateRoundScore from features/game/game.ts.");
  }

  const polygons = parseCsv(source).map((row) => ({
    case: row.case,
    location: row.location,
    geometry: row.geometry,
    targetAreaKm2: numberField(row, "target_area_km2"),
    fractionalPopulation: numberField(row, "fractional_population"),
    centerPopulation: numberField(row, "center_population"),
    populationDifferencePercentage: numberField(row, "percentage_difference"),
  }));
  if (polygons.length !== 104) {
    throw new Error(`Expected 104 population cases, found ${polygons.length}.`);
  }

  const results = TARGETS.flatMap((target) =>
    polygons.map((polygon) => {
      const fractionalScore = game.calculateRoundScore(
        polygon.fractionalPopulation,
        target,
      );
      const centerScore = game.calculateRoundScore(polygon.centerPopulation, target);
      return {
        ...polygon,
        target,
        fractionalScore,
        centerScore,
        scoreDifference: Math.abs(centerScore - fractionalScore),
      };
    }),
  );
  const outputRows = results.map((result) => ({
    case: result.case,
    location: result.location,
    geometry: result.geometry,
    target_area_km2: result.targetAreaKm2,
    target: result.target,
    fractional_population: result.fractionalPopulation,
    center_population: result.centerPopulation,
    population_difference_percentage: result.populationDifferencePercentage,
    fractional_score: result.fractionalScore,
    center_score: result.centerScore,
    absolute_score_difference: result.scoreDifference,
  }));
  await writeFile(outputPath, serializeCsv(outputRows), "utf8");

  console.log(`Scoring implementation: ${GAME_MODULE}`);
  console.log(`Population cases: ${polygons.length}`);
  console.log(`Target samples: ${TARGETS.length}`);
  console.log(`Detailed comparisons: ${results.length}`);
  console.log(`Detailed CSV: ${outputPath}\n`);
  printSummary(results);
}


main().catch((error) => {
  console.error(`Target score impact benchmark error: ${error.message}`);
  process.exitCode = 1;
});
