import Link from "next/link";
import { auth, signIn } from "../auth";

export default async function Home() {
  const session = await auth();

  return (
    <main className="grid min-h-screen place-items-center bg-slate-950 px-6 text-white">
      <div className="text-center">
        <h1 className="text-5xl font-extrabold tracking-tight">Worldrawing</h1>
        <p className="mt-4 text-slate-300">
          Estimate populations by drawing directly on the world map.
        </p>
        <nav className="mt-8 flex flex-wrap justify-center gap-3">
          <Link
            href="/game"
            className="rounded-md bg-sky-600 px-5 py-3 font-semibold hover:bg-sky-500"
          >
            {session?.worldrawingUserId ? "Play" : "Play as guest"}
          </Link>
          {session?.worldrawingUserId ? (
            <Link
              href="/profile"
              className="rounded-md border border-slate-600 px-5 py-3 font-semibold hover:bg-slate-900"
            >
              Profile
            </Link>
          ) : session?.googleSub ? (
            <Link
              href="/onboarding"
              className="rounded-md border border-slate-600 px-5 py-3 font-semibold hover:bg-slate-900"
            >
              Complete account
            </Link>
          ) : (
            <form
              action={async () => {
                "use server";
                await signIn("google", { redirectTo: "/onboarding" });
              }}
            >
              <button
                type="submit"
                className="rounded-md border border-slate-600 px-5 py-3 font-semibold hover:bg-slate-900"
              >
                Sign in with Google
              </button>
            </form>
          )}
        </nav>
      </div>
    </main>
  );
}
