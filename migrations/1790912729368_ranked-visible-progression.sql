-- Up Migration

ALTER TABLE competitive_ratings
  ADD COLUMN visible_rank_score integer;

UPDATE competitive_ratings
SET visible_rank_score = CASE
  WHEN mmr >= 2200 THEN 1500 + (mmr - 2200)
  WHEN mmr >= 2075 THEN 1400 + ((mmr - 2075) * 100 / 125)
  WHEN mmr >= 1950 THEN 1300 + ((mmr - 1950) * 100 / 125)
  WHEN mmr >= 1825 THEN 1200 + ((mmr - 1825) * 100 / 125)
  WHEN mmr >= 1700 THEN 1100 + ((mmr - 1700) * 100 / 125)
  WHEN mmr >= 1575 THEN 1000 + ((mmr - 1575) * 100 / 125)
  WHEN mmr >= 1450 THEN 900 + ((mmr - 1450) * 100 / 125)
  WHEN mmr >= 1350 THEN 800 + (mmr - 1350)
  WHEN mmr >= 1250 THEN 700 + (mmr - 1250)
  WHEN mmr >= 1150 THEN 600 + (mmr - 1150)
  WHEN mmr >= 1050 THEN 500 + (mmr - 1050)
  WHEN mmr >= 950 THEN 400 + (mmr - 950)
  WHEN mmr >= 850 THEN 300 + (mmr - 850)
  WHEN mmr >= 750 THEN 200 + (mmr - 750)
  WHEN mmr >= 600 THEN 100 + ((mmr - 600) * 100 / 150)
  ELSE (mmr - 400) * 100 / 200
END
WHERE ranked_games_completed = 10;

ALTER TABLE competitive_ratings
  ADD CONSTRAINT competitive_ratings_visible_rank_score_nonnegative
    CHECK (visible_rank_score IS NULL OR visible_rank_score >= 0),
  ADD CONSTRAINT competitive_ratings_visible_rank_placement_state
    CHECK (
      (ranked_games_completed < 10 AND visible_rank_score IS NULL)
      OR
      (ranked_games_completed = 10 AND visible_rank_score IS NOT NULL)
    );

CREATE INDEX competitive_ratings_difficulty_visible_rank_idx
  ON competitive_ratings (difficulty, visible_rank_score DESC)
  WHERE visible_rank_score IS NOT NULL;

DROP INDEX competitive_ratings_difficulty_legacy_visible_idx;

ALTER TABLE competitive_ratings
  DROP CONSTRAINT competitive_ratings_legacy_visible_floor,
  DROP COLUMN legacy_visible_rating;

-- Down Migration

ALTER TABLE competitive_ratings
  ADD COLUMN legacy_visible_rating integer;

UPDATE competitive_ratings
SET legacy_visible_rating = mmr;

ALTER TABLE competitive_ratings
  ALTER COLUMN legacy_visible_rating SET NOT NULL,
  ADD CONSTRAINT competitive_ratings_legacy_visible_floor
    CHECK (legacy_visible_rating >= 400);

CREATE INDEX competitive_ratings_difficulty_legacy_visible_idx
  ON competitive_ratings (difficulty, legacy_visible_rating DESC);

DROP INDEX competitive_ratings_difficulty_visible_rank_idx;

ALTER TABLE competitive_ratings
  DROP CONSTRAINT competitive_ratings_visible_rank_placement_state,
  DROP CONSTRAINT competitive_ratings_visible_rank_score_nonnegative,
  DROP COLUMN visible_rank_score;
