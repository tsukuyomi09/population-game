export const USERNAME_MAX_LENGTH = 32;

export function normalizeUsername(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const username = value.trim();
  if (username.length === 0 || username.length > USERNAME_MAX_LENGTH) {
    return null;
  }

  return username;
}
