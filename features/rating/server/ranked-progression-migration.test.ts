import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const migration = readFileSync(
  join(
    process.cwd(),
    "migrations/1790912729368_ranked-visible-progression.sql",
  ),
  "utf8",
);

test("R2 migration adds one nullable canonical visible progression value", () => {
  assert.match(migration, /ADD COLUMN visible_rank_score integer/);
  assert.match(migration, /ranked_games_completed < 10 AND visible_rank_score IS NULL/);
  assert.match(migration, /ranked_games_completed = 10 AND visible_rank_score IS NOT NULL/);
  assert.doesNotMatch(migration, /ADD COLUMN (tier|division|lp) /);
});

test("R2 migration reveals existing placement-complete players from MMR", () => {
  assert.match(migration, /SET visible_rank_score = CASE/);
  assert.match(migration, /WHEN mmr >= 2200 THEN 1500 \+ \(mmr - 2200\)/);
  assert.match(migration, /WHEN mmr >= 950 THEN 400 \+ \(mmr - 950\)/);
  assert.match(migration, /WHERE ranked_games_completed = 10/);

  for (const threshold of [
    600, 750, 850, 950, 1_050, 1_150, 1_250, 1_350, 1_450, 1_575,
    1_700, 1_825, 1_950, 2_075, 2_200,
  ]) {
    assert.match(migration, new RegExp(`mmr >= ${threshold}`));
  }
});

test("R2 migration removes the temporary legacy visible-rating bridge", () => {
  assert.match(migration, /DROP COLUMN legacy_visible_rating/);
  assert.match(migration, /DROP INDEX competitive_ratings_difficulty_legacy_visible_idx/);
  assert.match(migration, /difficulty, visible_rank_score DESC/);
});
