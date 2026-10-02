import { MINIMUM_RANKED_MMR, RANKED_PLACEMENT_GAMES } from "./ranked-mmr";

export const MASTER_VISIBLE_RANK_SCORE = 1_500;

export type RankedTier =
  | "BRONZE"
  | "SILVER"
  | "GOLD"
  | "PLATINUM"
  | "DIAMOND"
  | "MASTER";

export type RankedDivision = "III" | "II" | "I";

export type RankedProgress =
  | {
      status: "UNRANKED";
      rankedGamesCompleted: number;
      placementsRequired: typeof RANKED_PLACEMENT_GAMES;
    }
  | {
      status: "RANKED";
      rankedGamesCompleted: typeof RANKED_PLACEMENT_GAMES;
      tier: RankedTier;
      division: RankedDivision | null;
      label: string;
      lp: number;
    };

export type RankedVisibleOutcome = "WIN" | "LOSS" | "DRAW";

type RankedBand = {
  tier: Exclude<RankedTier, "MASTER">;
  division: RankedDivision;
  lowerMmr: number;
  upperMmrExclusive: number;
};

const RANKED_BANDS: readonly RankedBand[] = [
  { tier: "BRONZE", division: "III", lowerMmr: 400, upperMmrExclusive: 600 },
  { tier: "BRONZE", division: "II", lowerMmr: 600, upperMmrExclusive: 750 },
  { tier: "BRONZE", division: "I", lowerMmr: 750, upperMmrExclusive: 850 },
  { tier: "SILVER", division: "III", lowerMmr: 850, upperMmrExclusive: 950 },
  { tier: "SILVER", division: "II", lowerMmr: 950, upperMmrExclusive: 1_050 },
  { tier: "SILVER", division: "I", lowerMmr: 1_050, upperMmrExclusive: 1_150 },
  { tier: "GOLD", division: "III", lowerMmr: 1_150, upperMmrExclusive: 1_250 },
  { tier: "GOLD", division: "II", lowerMmr: 1_250, upperMmrExclusive: 1_350 },
  { tier: "GOLD", division: "I", lowerMmr: 1_350, upperMmrExclusive: 1_450 },
  { tier: "PLATINUM", division: "III", lowerMmr: 1_450, upperMmrExclusive: 1_575 },
  { tier: "PLATINUM", division: "II", lowerMmr: 1_575, upperMmrExclusive: 1_700 },
  { tier: "PLATINUM", division: "I", lowerMmr: 1_700, upperMmrExclusive: 1_825 },
  { tier: "DIAMOND", division: "III", lowerMmr: 1_825, upperMmrExclusive: 1_950 },
  { tier: "DIAMOND", division: "II", lowerMmr: 1_950, upperMmrExclusive: 2_075 },
  { tier: "DIAMOND", division: "I", lowerMmr: 2_075, upperMmrExclusive: 2_200 },
];

function assertRankedGamesCompleted(value: number) {
  if (
    !Number.isInteger(value) ||
    value < 0 ||
    value > RANKED_PLACEMENT_GAMES
  ) {
    throw new Error("Ranked games completed must be an integer from 0 to 10.");
  }
}

function assertVisibleRankScore(value: number) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("Visible rank score must be a nonnegative integer.");
  }
}

function assertMmr(value: number) {
  if (!Number.isInteger(value) || value < MINIMUM_RANKED_MMR) {
    throw new Error("MMR must be an integer at or above the MMR floor.");
  }
}

function titleCaseTier(tier: RankedTier) {
  return `${tier.slice(0, 1)}${tier.slice(1).toLowerCase()}`;
}

export function visibleRankScoreFromMmr(mmr: number) {
  assertMmr(mmr);

  if (mmr >= 2_200) {
    return MASTER_VISIBLE_RANK_SCORE + (mmr - 2_200);
  }

  const bandIndex = RANKED_BANDS.findIndex(
    ({ lowerMmr, upperMmrExclusive }) =>
      mmr >= lowerMmr && mmr < upperMmrExclusive,
  );
  const band = RANKED_BANDS[bandIndex];
  if (!band) throw new Error("MMR does not map to a Ranked band.");
  const bandWidth = band.upperMmrExclusive - band.lowerMmr;
  const lp = Math.floor(((mmr - band.lowerMmr) / bandWidth) * 100);
  return bandIndex * 100 + lp;
}

export function rankedProgress(
  rankedGamesCompleted: number,
  visibleRankScore: number | null,
): RankedProgress {
  assertRankedGamesCompleted(rankedGamesCompleted);

  if (rankedGamesCompleted < RANKED_PLACEMENT_GAMES) {
    if (visibleRankScore !== null) {
      throw new Error(
        "Unranked competitive state cannot have a visible rank score.",
      );
    }
    return {
      status: "UNRANKED",
      rankedGamesCompleted,
      placementsRequired: RANKED_PLACEMENT_GAMES,
    };
  }

  if (visibleRankScore === null) {
    throw new Error(
      "Placement-complete competitive state needs a visible rank score.",
    );
  }
  assertVisibleRankScore(visibleRankScore);

  if (visibleRankScore >= MASTER_VISIBLE_RANK_SCORE) {
    return {
      status: "RANKED",
      rankedGamesCompleted: RANKED_PLACEMENT_GAMES,
      tier: "MASTER",
      division: null,
      label: "Master",
      lp: visibleRankScore - MASTER_VISIBLE_RANK_SCORE,
    };
  }

  const bandIndex = Math.floor(visibleRankScore / 100);
  const band = RANKED_BANDS[bandIndex];
  if (!band) throw new Error("Visible rank score does not map to a Ranked band.");
  return {
    status: "RANKED",
    rankedGamesCompleted: RANKED_PLACEMENT_GAMES,
    tier: band.tier,
    division: band.division,
    label: `${titleCaseTier(band.tier)} ${band.division}`,
    lp: visibleRankScore % 100,
  };
}

export function expectedMmrFromVisibleRankScore(visibleRankScore: number) {
  assertVisibleRankScore(visibleRankScore);
  if (visibleRankScore >= MASTER_VISIBLE_RANK_SCORE) {
    return 2_200 + (visibleRankScore - MASTER_VISIBLE_RANK_SCORE);
  }

  const bandIndex = Math.floor(visibleRankScore / 100);
  const band = RANKED_BANDS[bandIndex];
  if (!band) throw new Error("Visible rank score does not map to a Ranked band.");
  const lp = visibleRankScore % 100;
  const bandWidth = band.upperMmrExclusive - band.lowerMmr;
  return band.lowerMmr + (lp / 100) * bandWidth;
}

export function visibleLpChange(input: {
  mmrBefore: number;
  visibleRankScoreBefore: number;
  outcome: RankedVisibleOutcome;
}) {
  assertMmr(input.mmrBefore);
  assertVisibleRankScore(input.visibleRankScoreBefore);
  if (input.outcome === "DRAW") return 0;
  const representedMmr = expectedMmrFromVisibleRankScore(
    input.visibleRankScoreBefore,
  );
  const difference = input.mmrBefore - representedMmr;

  if (Math.abs(difference) <= 100) {
    return input.outcome === "WIN" ? 16 : -16;
  }
  if (difference > 200) return input.outcome === "WIN" ? 20 : -12;
  if (difference > 100) return input.outcome === "WIN" ? 18 : -14;
  if (difference < -200) return input.outcome === "WIN" ? 12 : -20;
  return input.outcome === "WIN" ? 14 : -18;
}

export function visibleRankScoreAfterMatch(input: {
  mmrBefore: number;
  visibleRankScoreBefore: number;
  outcome: RankedVisibleOutcome;
}) {
  assertVisibleRankScore(input.visibleRankScoreBefore);
  return Math.max(
    0,
    input.visibleRankScoreBefore + visibleLpChange(input),
  );
}
