import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { AVATARS, avatarDefinition, isAvatarId } from "./avatars";
import { verifiedGoogleIdentity } from "./google-identity";
import { USERNAME_MAX_LENGTH, normalizeUsername } from "./username";

test("accepts only a verified Google profile with the stable subject", () => {
  assert.deepEqual(
    verifiedGoogleIdentity(
      { sub: "google-subject", email: "player@example.com", email_verified: true },
      "google-subject",
    ),
    { googleSub: "google-subject", email: "player@example.com" },
  );
  assert.equal(
    verifiedGoogleIdentity(
      { sub: "other-subject", email: "player@example.com", email_verified: true },
      "google-subject",
    ),
    null,
  );
  assert.equal(
    verifiedGoogleIdentity(
      { sub: "google-subject", email: "player@example.com", email_verified: false },
      "google-subject",
    ),
    null,
  );
});

test("defines unique avatar ids backed by public assets", () => {
  assert.equal(new Set(AVATARS.map((avatar) => avatar.id)).size, AVATARS.length);

  for (const avatar of AVATARS) {
    assert.equal(isAvatarId(avatar.id), true);
    assert.equal(avatarDefinition(avatar.id), avatar);
    assert.equal(
      existsSync(join(process.cwd(), "public", avatar.src.replace(/^\//, ""))),
      true,
    );
  }
});

test("rejects avatar ids outside the canonical allowlist", () => {
  assert.equal(isAvatarId("invalid-avatar-id"), false);
  assert.equal(isAvatarId(""), false);
  assert.equal(isAvatarId(undefined), false);
});

test("normalizes a non-empty username within the v1 length limit", () => {
  assert.equal(normalizeUsername("  mapmaker  "), "mapmaker");
  assert.equal(normalizeUsername("   "), null);
  assert.equal(normalizeUsername("x".repeat(USERNAME_MAX_LENGTH + 1)), null);
});
