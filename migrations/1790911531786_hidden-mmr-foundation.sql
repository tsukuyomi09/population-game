-- Up Migration

ALTER TABLE game_players
  RENAME COLUMN rating_before TO mmr_before;

ALTER TABLE game_players
  RENAME COLUMN rating_after TO mmr_after;

ALTER TABLE competitive_ratings
  RENAME COLUMN rating TO mmr;

ALTER TABLE competitive_ratings
  RENAME CONSTRAINT competitive_ratings_floor TO competitive_ratings_mmr_floor;

ALTER INDEX competitive_ratings_difficulty_rating_idx
  RENAME TO competitive_ratings_difficulty_mmr_idx;

ALTER TABLE competitive_ratings
  ADD COLUMN ranked_games_completed integer NOT NULL DEFAULT 0,
  ADD COLUMN legacy_visible_rating integer;

UPDATE competitive_ratings
SET legacy_visible_rating = mmr;

ALTER TABLE competitive_ratings
  ALTER COLUMN legacy_visible_rating SET NOT NULL,
  ADD CONSTRAINT competitive_ratings_games_completed_range
    CHECK (ranked_games_completed >= 0 AND ranked_games_completed <= 10),
  ADD CONSTRAINT competitive_ratings_legacy_visible_floor
    CHECK (legacy_visible_rating >= 400);

UPDATE competitive_ratings AS competitive_state
SET ranked_games_completed = LEAST(10, ranked_history.completed_games)
FROM (
  SELECT
    game_players.user_id,
    games.difficulty,
    COUNT(*)::integer AS completed_games
  FROM game_players
  JOIN games ON games.id = game_players.game_id
  WHERE games.type = 'DUEL'
    AND games.rated = true
    AND games.status = 'COMPLETED'
    AND game_players.result IS NOT NULL
  GROUP BY game_players.user_id, games.difficulty
) AS ranked_history
WHERE competitive_state.user_id = ranked_history.user_id
  AND competitive_state.difficulty = ranked_history.difficulty;

CREATE INDEX competitive_ratings_difficulty_legacy_visible_idx
  ON competitive_ratings (difficulty, legacy_visible_rating DESC);

-- Down Migration

DROP INDEX competitive_ratings_difficulty_legacy_visible_idx;

ALTER TABLE competitive_ratings
  DROP CONSTRAINT competitive_ratings_legacy_visible_floor,
  DROP CONSTRAINT competitive_ratings_games_completed_range,
  DROP COLUMN legacy_visible_rating,
  DROP COLUMN ranked_games_completed;

ALTER INDEX competitive_ratings_difficulty_mmr_idx
  RENAME TO competitive_ratings_difficulty_rating_idx;

ALTER TABLE competitive_ratings
  RENAME CONSTRAINT competitive_ratings_mmr_floor TO competitive_ratings_floor;

ALTER TABLE competitive_ratings
  RENAME COLUMN mmr TO rating;

ALTER TABLE game_players
  RENAME COLUMN mmr_after TO rating_after;

ALTER TABLE game_players
  RENAME COLUMN mmr_before TO rating_before;
