import { databasePool } from "../../database/server/client";
import type { AvatarId } from "../avatars";

export type WorldrawingUser = {
  id: string;
  googleSub: string;
  email: string;
  username: string;
  avatarId: string;
};

const USER_COLUMNS = `
  id,
  google_sub AS "googleSub",
  email,
  username,
  avatar_id AS "avatarId"
`;

export async function findUserByGoogleSub(
  googleSub: string,
): Promise<WorldrawingUser | null> {
  const result = await databasePool().query<WorldrawingUser>(
    `SELECT ${USER_COLUMNS} FROM users WHERE google_sub = $1`,
    [googleSub],
  );

  return result.rows[0] ?? null;
}

export async function findUserById(
  userId: string,
): Promise<WorldrawingUser | null> {
  const result = await databasePool().query<WorldrawingUser>(
    `SELECT ${USER_COLUMNS} FROM users WHERE id = $1`,
    [userId],
  );

  return result.rows[0] ?? null;
}

export async function refreshExistingUserEmail(
  googleSub: string,
  email: string,
): Promise<WorldrawingUser | null> {
  const result = await databasePool().query<WorldrawingUser>(
    `
      UPDATE users
      SET email = $2, updated_at = now()
      WHERE google_sub = $1
      RETURNING ${USER_COLUMNS}
    `,
    [googleSub, email],
  );

  return result.rows[0] ?? null;
}

export async function createUser(input: {
  googleSub: string;
  email: string;
  username: string;
  avatarId: AvatarId;
}): Promise<WorldrawingUser> {
  const result = await databasePool().query<WorldrawingUser>(
    `
      INSERT INTO users (google_sub, email, username, avatar_id)
      VALUES ($1, $2, $3, $4)
      RETURNING ${USER_COLUMNS}
    `,
    [input.googleSub, input.email, input.username, input.avatarId],
  );

  return result.rows[0];
}

export async function updateUserAvatar(userId: string, avatarId: AvatarId) {
  const result = await databasePool().query(
    `
      UPDATE users
      SET avatar_id = $2, updated_at = now()
      WHERE id = $1
    `,
    [userId, avatarId],
  );

  return result.rowCount === 1;
}

export function isUniqueConstraintError(
  error: unknown,
  constraint: string,
): boolean {
  if (typeof error !== "object" || error === null) return false;

  const databaseError = error as { code?: unknown; constraint?: unknown };
  return databaseError.code === "23505" && databaseError.constraint === constraint;
}
