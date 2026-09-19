import "server-only";

const TARGET_BANDS = [
  [1_000, 100_000],
  [100_000, 1_000_000],
  [1_000_000, 10_000_000],
  [10_000_000, 100_000_000],
  [100_000_000, 1_000_000_000],
] as const;

export function generateTarget() {
  const band = TARGET_BANDS[Math.floor(Math.random() * TARGET_BANDS.length)];
  const value = band[0] + Math.random() * (band[1] - band[0]);

  return Math.round(value / 100) * 100;
}
