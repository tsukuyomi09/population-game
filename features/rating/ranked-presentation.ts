import type { RankedProgress } from "./server/ranked-visible-progression";

export type RankedResultFeedback = {
  kind:
    | "PLACEMENT_PROGRESS"
    | "RANK_REVEAL"
    | "PROMOTION"
    | "DEMOTION"
    | "LP_GAIN"
    | "LP_LOSS"
    | "NO_CHANGE";
  title: string;
  detail: string;
};

function signedLp(value: number) {
  return `${value > 0 ? "+" : ""}${value} LP`;
}

export function rankedResultFeedback(input: {
  before: RankedProgress;
  after: RankedProgress;
  lpChange: number | null;
}): RankedResultFeedback {
  if (input.before.status === "UNRANKED") {
    if (input.after.status === "UNRANKED") {
      const remaining =
        input.after.placementsRequired - input.after.rankedGamesCompleted;
      return {
        kind: "PLACEMENT_PROGRESS",
        title: `Placement ${input.after.rankedGamesCompleted} / ${input.after.placementsRequired}`,
        detail:
          remaining === 1
            ? "1 placement game remaining"
            : `${remaining} placement games remaining`,
      };
    }
    return {
      kind: "RANK_REVEAL",
      title: "Rank revealed",
      detail: `${input.after.label} · ${input.after.lp} LP`,
    };
  }

  if (input.after.status === "UNRANKED") {
    throw new Error("Ranked progress cannot return to placements.");
  }

  const lpChange = input.lpChange;
  if (lpChange === null) {
    throw new Error("Post-placement Ranked results require an LP change.");
  }
  if (input.before.label !== input.after.label) {
    if (lpChange > 0) {
      return {
        kind: "PROMOTION",
        title: `Promoted to ${input.after.label}`,
        detail: signedLp(lpChange),
      };
    }
    if (lpChange < 0) {
      return {
        kind: "DEMOTION",
        title: `Demoted to ${input.after.label}`,
        detail: signedLp(lpChange),
      };
    }
  }
  if (lpChange > 0) {
    return { kind: "LP_GAIN", title: signedLp(lpChange), detail: "LP gained" };
  }
  if (lpChange < 0) {
    return { kind: "LP_LOSS", title: signedLp(lpChange), detail: "LP lost" };
  }
  return { kind: "NO_CHANGE", title: "No LP change", detail: "Rank unchanged" };
}
