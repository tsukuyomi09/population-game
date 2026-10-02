import assert from "node:assert/strict";
import test from "node:test";
import { rankedResultFeedback } from "./ranked-presentation";
import { rankedProgress } from "./server/ranked-visible-progression";

test("presents placement progress and the game-ten reveal", () => {
  assert.deepEqual(
    rankedResultFeedback({
      before: rankedProgress(7, null),
      after: rankedProgress(8, null),
      lpChange: null,
    }),
    {
      kind: "PLACEMENT_PROGRESS",
      title: "Placement 8 / 10",
      detail: "2 placement games remaining",
    },
  );

  assert.deepEqual(
    rankedResultFeedback({
      before: rankedProgress(9, null),
      after: rankedProgress(10, 474),
      lpChange: null,
    }),
    {
      kind: "RANK_REVEAL",
      title: "Rank revealed",
      detail: "Silver II · 74 LP",
    },
  );
});

test("presents LP gain, loss, and draw without hidden rating", () => {
  const progress = rankedProgress(10, 450);
  assert.deepEqual(
    rankedResultFeedback({
      before: progress,
      after: rankedProgress(10, 466),
      lpChange: 16,
    }),
    { kind: "LP_GAIN", title: "+16 LP", detail: "LP gained" },
  );
  assert.deepEqual(
    rankedResultFeedback({
      before: progress,
      after: rankedProgress(10, 434),
      lpChange: -16,
    }),
    { kind: "LP_LOSS", title: "-16 LP", detail: "LP lost" },
  );
  assert.deepEqual(
    rankedResultFeedback({ before: progress, after: progress, lpChange: 0 }),
    { kind: "NO_CHANGE", title: "No LP change", detail: "Rank unchanged" },
  );
});

test("presents promotion, demotion, and Master transitions", () => {
  assert.deepEqual(
    rankedResultFeedback({
      before: rankedProgress(10, 1_492),
      after: rankedProgress(10, 1_508),
      lpChange: 16,
    }),
    {
      kind: "PROMOTION",
      title: "Promoted to Master",
      detail: "+16 LP",
    },
  );
  assert.deepEqual(
    rankedResultFeedback({
      before: rankedProgress(10, 300),
      after: rankedProgress(10, 282),
      lpChange: -18,
    }),
    {
      kind: "DEMOTION",
      title: "Demoted to Bronze I",
      detail: "-18 LP",
    },
  );
  assert.deepEqual(
    rankedResultFeedback({
      before: rankedProgress(10, 1_508),
      after: rankedProgress(10, 1_524),
      lpChange: 16,
    }),
    { kind: "LP_GAIN", title: "+16 LP", detail: "LP gained" },
  );
});
