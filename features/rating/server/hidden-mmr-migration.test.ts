import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const migration = readFileSync(
  join(
    process.cwd(),
    "migrations/1790911531786_hidden-mmr-foundation.sql",
  ),
  "utf8",
);

test("migration preserves existing ratings as MMR and adapts snapshots", () => {
  assert.match(migration, /RENAME COLUMN rating TO mmr/);
  assert.match(migration, /RENAME COLUMN rating_before TO mmr_before/);
  assert.match(migration, /RENAME COLUMN rating_after TO mmr_after/);
  assert.doesNotMatch(migration, /SET mmr = 1000/);
});

test("migration backfills capped placement progress from valid Ranked history", () => {
  assert.match(
    migration,
    /SET ranked_games_completed = LEAST\(10, ranked_history\.completed_games\)/,
  );
  assert.match(migration, /games\.type = 'DUEL'/);
  assert.match(migration, /games\.rated = true/);
  assert.match(migration, /games\.status = 'COMPLETED'/);
  assert.match(migration, /game_players\.result IS NOT NULL/);
  assert.match(
    migration,
    /GROUP BY game_players\.user_id, games\.difficulty/,
  );
});

test("R1 migration creates the temporary bridge that R2 removes", () => {
  assert.match(migration, /ADD COLUMN legacy_visible_rating integer/);
  assert.match(migration, /SET legacy_visible_rating = mmr/);
  assert.match(migration, /CHECK \(legacy_visible_rating >= 400\)/);
});
