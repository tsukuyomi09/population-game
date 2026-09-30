import { redirect } from "next/navigation";
import { auth } from "../../auth";
import { ProfileView } from "../../components/profile-view";
import { singleProfileStats } from "../../features/account/server/profile-stats";
import { findUserById } from "../../features/account/server/users";

export default async function ProfilePage() {
  const session = await auth();
  if (!session?.googleSub) redirect("/");
  if (!session.worldrawingUserId) redirect("/onboarding");

  const [user, easyStats, realStats] = await Promise.all([
    findUserById(session.worldrawingUserId),
    singleProfileStats(session.worldrawingUserId, "EASY"),
    singleProfileStats(session.worldrawingUserId, "REAL"),
  ]);
  if (!user) redirect("/onboarding");

  return (
    <ProfileView
      username={user.username}
      avatarId={user.avatarId}
      stats={{ EASY: easyStats, REAL: realStats }}
    />
  );
}
