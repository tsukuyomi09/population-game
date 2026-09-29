import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, signOut } from "../../auth";
import { avatarDefinition } from "../../features/account/avatars";
import { findUserById } from "../../features/account/server/users";

export default async function ProfilePage() {
  const session = await auth();
  if (!session?.googleSub) redirect("/");
  if (!session.worldrawingUserId) redirect("/onboarding");

  const user = await findUserById(session.worldrawingUserId);
  if (!user) redirect("/onboarding");

  const avatar = avatarDefinition(user.avatarId);

  return (
    <main className="grid min-h-screen place-items-center bg-slate-950 px-6 text-center text-white">
      <div className="w-full max-w-sm rounded-xl border border-slate-800 bg-slate-900 p-8">
        <h1 className="text-3xl font-bold">Profile</h1>
        {avatar ? (
          <Image
            src={avatar.src}
            alt={`${user.username}'s avatar`}
            width={128}
            height={128}
            className="mx-auto mt-6 h-32 w-32 rounded-full object-cover"
          />
        ) : null}
        <p className="mt-4 text-xl font-semibold">{user.username}</p>

        <div className="mt-8 grid gap-3">
          <Link
            href="/game"
            className="rounded-md bg-sky-600 px-5 py-3 font-semibold hover:bg-sky-500"
          >
            Play
          </Link>
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/" });
            }}
          >
            <button
              type="submit"
              className="w-full rounded-md border border-slate-600 px-5 py-3 font-semibold hover:bg-slate-800"
            >
              Logout
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
