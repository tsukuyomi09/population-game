"use server";

import { redirect } from "next/navigation";
import { auth } from "../../../auth";
import { isAvatarId } from "../avatars";
import { normalizeUsername } from "../username";
import {
  createUser,
  findUserByGoogleSub,
  isUniqueConstraintError,
} from "./users";

export async function createAccount(formData: FormData) {
  const session = await auth();

  if (!session?.googleSub || !session.googleEmail) redirect("/");
  if (session.worldrawingUserId) redirect("/profile");

  const username = normalizeUsername(formData.get("username"));
  if (!username) redirect("/onboarding?error=invalid-username");

  const avatarId = formData.get("avatarId");
  if (!isAvatarId(avatarId)) redirect("/onboarding?error=invalid-avatar");

  const existingUser = await findUserByGoogleSub(session.googleSub);
  if (existingUser) redirect("/profile");

  try {
    await createUser({
      googleSub: session.googleSub,
      email: session.googleEmail,
      username,
      avatarId,
    });
  } catch (error) {
    if (isUniqueConstraintError(error, "users_username_unique")) {
      redirect("/onboarding?error=username-taken");
    }

    if (isUniqueConstraintError(error, "users_google_sub_unique")) {
      redirect("/profile");
    }

    redirect("/onboarding?error=account-creation-failed");
  }

  redirect("/profile");
}
