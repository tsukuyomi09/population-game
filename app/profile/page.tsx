import { redirect } from "next/navigation";
import { auth } from "../../auth";
import { ProfileView } from "../../components/profile-view";
import {
  duelProfileStats,
  singleProfileStats,
} from "../../features/account/server/profile-stats";
import { findUserById } from "../../features/account/server/users";
import { currentRankedProgress } from "../../features/rating/server/current-ranked-progression";

export default async function ProfilePage() {
  const session = await auth();
  if (!session?.googleSub) redirect("/");
  if (!session.worldrawingUserId) redirect("/onboarding");

  const [
    user,
    easyStats,
    realStats,
    rankedProgress,
    easyDuels,
    easyRanked,
    realDuels,
    realRanked,
  ] = await Promise.all([
    findUserById(session.worldrawingUserId),
    singleProfileStats(session.worldrawingUserId, "EASY"),
    singleProfileStats(session.worldrawingUserId, "REAL"),
    currentRankedProgress(session.worldrawingUserId),
    duelProfileStats(session.worldrawingUserId, "EASY", "DUEL"),
    duelProfileStats(session.worldrawingUserId, "EASY", "RANKED"),
    duelProfileStats(session.worldrawingUserId, "REAL", "DUEL"),
    duelProfileStats(session.worldrawingUserId, "REAL", "RANKED"),
  ]);
  if (!user) redirect("/onboarding");

  return (
    <ProfileView
      username={user.username}
      avatarId={user.avatarId}
      stats={{ EASY: easyStats, REAL: realStats }}
      rankedProgress={rankedProgress}
      duelStats={{
        EASY: { DUEL: easyDuels, RANKED: easyRanked },
        REAL: { DUEL: realDuels, RANKED: realRanked },
      }}
    />
  );
}
