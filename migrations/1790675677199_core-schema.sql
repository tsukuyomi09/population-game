-- Up Migration

CREATE TYPE game_type AS ENUM ('SINGLE', 'DUEL');
CREATE TYPE game_difficulty AS ENUM ('EASY', 'REAL');
CREATE TYPE game_status AS ENUM ('ACTIVE', 'COMPLETED', 'ABANDONED');
CREATE TYPE game_end_reason AS ENUM (
  'NORMAL',
  'PLAYER_ABANDON',
  'DISCONNECT_FORFEIT'
);
CREATE TYPE duel_result AS ENUM ('WIN', 'LOSS', 'DRAW');
CREATE TYPE submission_type AS ENUM ('MANUAL', 'TIMEOUT');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  google_sub text NOT NULL,
  email text NOT NULL,
  username text NOT NULL,
  avatar_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_google_sub_unique UNIQUE (google_sub),
  CONSTRAINT users_email_unique UNIQUE (email),
  CONSTRAINT users_username_unique UNIQUE (username)
);

CREATE TABLE games (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type game_type NOT NULL,
  difficulty game_difficulty NOT NULL,
  rated boolean NOT NULL,
  status game_status NOT NULL,
  end_reason game_end_reason,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  CONSTRAINT games_single_not_rated CHECK (type <> 'SINGLE' OR rated = false)
);

CREATE TABLE game_players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES games (id),
  user_id uuid NOT NULL REFERENCES users (id),
  total_score integer,
  result duel_result,
  rating_before integer,
  rating_after integer,
  joined_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT game_players_game_user_unique UNIQUE (game_id, user_id)
);

CREATE TABLE rounds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES games (id),
  round_number smallint NOT NULL,
  target_population bigint NOT NULL,
  started_at timestamptz,
  ends_at timestamptz,
  CONSTRAINT rounds_game_number_unique UNIQUE (game_id, round_number),
  CONSTRAINT rounds_number_positive CHECK (round_number > 0),
  CONSTRAINT rounds_target_population_positive CHECK (target_population > 0)
);

CREATE TABLE round_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id uuid NOT NULL REFERENCES rounds (id),
  game_player_id uuid NOT NULL REFERENCES game_players (id),
  calculated_population bigint NOT NULL,
  score integer NOT NULL,
  submission_type submission_type NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT round_results_round_player_unique UNIQUE (round_id, game_player_id),
  CONSTRAINT round_results_population_nonnegative CHECK (calculated_population >= 0),
  CONSTRAINT round_results_score_range CHECK (score >= 0 AND score <= 10000)
);

CREATE TABLE competitive_ratings (
  user_id uuid NOT NULL REFERENCES users (id),
  difficulty game_difficulty NOT NULL,
  rating integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, difficulty),
  CONSTRAINT competitive_ratings_floor CHECK (rating >= 400)
);

CREATE INDEX game_players_user_game_idx
  ON game_players (user_id, game_id);

CREATE INDEX round_results_game_player_idx
  ON round_results (game_player_id);

CREATE INDEX competitive_ratings_difficulty_rating_idx
  ON competitive_ratings (difficulty, rating DESC);

CREATE INDEX games_type_difficulty_status_ended_at_idx
  ON games (type, difficulty, status, ended_at);

-- Down Migration

DROP TABLE competitive_ratings;
DROP TABLE round_results;
DROP TABLE rounds;
DROP TABLE game_players;
DROP TABLE games;
DROP TABLE users;

DROP TYPE submission_type;
DROP TYPE duel_result;
DROP TYPE game_end_reason;
DROP TYPE game_status;
DROP TYPE game_difficulty;
DROP TYPE game_type;
