"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth, signOut } from "../../../auth";
import { isAvatarId } from "../avatars";
import { deleteUserAndOwnedData } from "./account-deletion";
import { updateUserAvatar } from "./users";

async function authenticatedUserId() {
  const session = await auth();
  if (!session?.worldrawingUserId) redirect("/");
  return session.worldrawingUserId;
}

export async function updateProfileAvatar(formData: FormData) {
  const userId = await authenticatedUserId();
  const avatarId = formData.get("avatarId");
  if (!isAvatarId(avatarId)) redirect("/profile");

  const updated = await updateUserAvatar(userId, avatarId);
  if (!updated) redirect("/onboarding");

  revalidatePath("/profile");
  revalidatePath("/");
  redirect("/profile");
}

export async function logoutAccount() {
  await signOut({ redirectTo: "/" });
}

export async function deleteProfileAccount() {
  const userId = await authenticatedUserId();
  await deleteUserAndOwnedData(userId);
  revalidatePath("/");
  await signOut({ redirectTo: "/" });
}
