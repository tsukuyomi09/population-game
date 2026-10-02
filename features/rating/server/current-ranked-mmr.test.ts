import assert from "node:assert/strict";
import test from "node:test";
import {
  currentRankedMmr,
  type RankedMmrQuery,
} from "./current-ranked-mmr";

function normalizedSql(sql: string) {
  return sql.replace(/\s+/g, " ").trim();
}

test("uses the logical initial MMR when the selected difficulty has no row", async () => {
  const calls: Array<{ text: string; values: readonly unknown[] }> = [];
  const query: RankedMmrQuery = async (text, values) => {
    calls.push({ text: normalizedSql(text), values });
    return { rows: [] };
  };

  assert.equal(await currentRankedMmr("user-1", "EASY", query), 1_000);
  assert.deepEqual(calls[0]?.values, ["user-1", "EASY"]);
  assert.match(calls[0]?.text ?? "", /^SELECT mmr FROM competitive_ratings/);
  assert.doesNotMatch(calls[0]?.text ?? "", /visible_rank|INSERT|UPDATE|DELETE/);
});

test("loads only the selected difficulty's persisted hidden MMR", async () => {
  const query: RankedMmrQuery = async (_text, values) => {
    assert.deepEqual(values, ["user-1", "REAL"]);
    return { rows: [{ mmr: 1_237 }] };
  };

  assert.equal(await currentRankedMmr("user-1", "REAL", query), 1_237);
});

test("rejects invalid persisted MMR instead of admitting it to the queue", async () => {
  await assert.rejects(
    currentRankedMmr("user-1", "EASY", async () => ({
      rows: [{ mmr: 399 }],
    })),
    /Stored Ranked MMR is invalid/,
  );
});
