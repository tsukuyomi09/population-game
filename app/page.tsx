import Image from "next/image";
import Link from "next/link";
import {
  ChevronDown,
  CircleUserRound,
  Globe2,
  LogIn,
  ShieldCheck,
  Trophy,
} from "lucide-react";
import { auth, signIn } from "../auth";
import { PlayModeDialog } from "@/components/play-mode-dialog";
import { Button } from "@/components/ui/button";
import { avatarDefinition } from "@/features/account/avatars";
import type { GameDifficulty } from "@/features/game/single-player";
import {
  rankedLeaderboard,
  type RankedLeaderboardEntry,
} from "@/features/leaderboard/server/ranked-leaderboard";
import {
  singleLeaderboard,
  type SingleLeaderboardEntry,
} from "@/features/leaderboard/server/single-leaderboard";

type SingleLeaderboardResult = {
  entries: SingleLeaderboardEntry[];
  unavailable: boolean;
};

type RankedLeaderboardResult = {
  entries: RankedLeaderboardEntry[];
  unavailable: boolean;
};

async function loadSingleLeaderboard(
  difficulty: GameDifficulty,
): Promise<SingleLeaderboardResult> {
  try {
    return {
      entries: await singleLeaderboard(difficulty),
      unavailable: false,
    };
  } catch (error) {
    console.error(`${difficulty} leaderboard failed to load:`, error);
    return { entries: [], unavailable: true };
  }
}

async function loadRankedLeaderboard(
  difficulty: GameDifficulty,
): Promise<RankedLeaderboardResult> {
  try {
    return {
      entries: await rankedLeaderboard(difficulty),
      unavailable: false,
    };
  } catch (error) {
    console.error(`${difficulty} Ranked leaderboard failed to load:`, error);
    return { entries: [], unavailable: true };
  }
}

function formatCompletionDate(value: string | null) {
  if (!value) return "—";

  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));
}

function WorldMapBackdrop() {
  const drawingPath =
    "M555 222 C594 188 658 189 704 218 C750 248 748 298 708 328 C663 362 594 344 564 305 C541 276 536 240 555 222 Z";

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      <svg
        className="absolute inset-0 h-full w-full"
        viewBox="0 0 1200 600"
        preserveAspectRatio="xMidYMid slice"
        role="presentation"
      >
        <defs>
          <pattern id="home-map-grid" width="48" height="48" patternUnits="userSpaceOnUse">
            <path d="M48 0H0V48" fill="none" stroke="currentColor" strokeWidth="1" />
          </pattern>
          <radialGradient id="home-map-glow" cx="50%" cy="42%" r="58%">
            <stop offset="0" stopColor="var(--primary)" stopOpacity="0.1" />
            <stop offset="1" stopColor="var(--background)" stopOpacity="0" />
          </radialGradient>
        </defs>

        <rect width="1200" height="600" className="text-white/5" fill="url(#home-map-grid)" />
        <rect width="1200" height="600" fill="url(#home-map-glow)" />

        <g className="home-map-land">
          <path d="M73 153 109 111l54-22 39 9 27-18 46 14 26 30 43 4 48 42-8 37-36 18-12 29-43 7-29 37-37-8-19-29-47-11-36-34-49-6-28-29Z" />
          <path d="m177 76 33-37 69-11 48 19-24 31-56 19Z" />
          <path d="m329 302 53 10 37 34 18 52-13 48-21 22-8 62-25 42-21-52 4-53-26-42-9-57-25-27Z" />
          <path d="m528 167 34-24 48 3 22 19 49-12 56 15 41-9 52 21 42-7 61 22 47-4 57 31-16 33-50 5-32 26-57-3-30 25-54-13-34 22-49-13-20-32-45-11-15-36-39-10-21-29-38 2-21-19Z" />
          <path d="m574 284 49-13 50 18 27 48-14 59-32 53-42 2-25-45-31-29 5-48-22-31Z" />
          <path d="m895 343 29-24 43 16 28 31-23 22-40-6Z" />
          <path d="m929 441 45-25 69 10 55 38-15 43-73 20-64-24Z" />
          <path d="m1104 503 20-8 18 17-17 20-22-11Z" />
          <path d="m793 340 18-9 13 16-11 17-21-8Z" />
          <path d="m850 371 20-10 17 14-10 17-22-5Z" />
        </g>

        <path
          d={drawingPath}
          pathLength="1"
          className="home-draw-path"
          fill="none"
        />
        <g className="home-draw-cursor">
          <circle r="7" fill="var(--primary)" />
          <circle r="16" fill="none" stroke="var(--primary)" strokeOpacity="0.28" />
          <animateMotion
            dur="7s"
            repeatCount="indefinite"
            path={drawingPath}
            keyPoints="0;1;1"
            keyTimes="0;0.72;1"
            calcMode="linear"
          />
        </g>
      </svg>
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_0%,rgba(6,14,24,0.22)_48%,rgba(6,14,24,0.88)_100%)]" />
      <div className="absolute inset-x-0 bottom-0 h-48 bg-gradient-to-b from-transparent to-background" />
    </div>
  );
}

function AccountAction({
  isGoogleAuthenticated,
  isRegistered,
}: {
  isGoogleAuthenticated: boolean;
  isRegistered: boolean;
}) {
  const buttonClassName =
    "h-12 w-full border-sky-200/70 bg-sky-300 px-6 text-base font-bold text-slate-950 shadow-lg shadow-sky-950/20 hover:bg-sky-200 hover:text-slate-950 sm:w-40";

  if (isRegistered) {
    return (
      <Button
        asChild
        variant="outline"
        size="lg"
        className={buttonClassName}
      >
        <Link href="/profile">
          <CircleUserRound aria-hidden="true" />
          Profile
        </Link>
      </Button>
    );
  }

  if (isGoogleAuthenticated) {
    return (
      <Button
        asChild
        variant="outline"
        size="lg"
        className={buttonClassName}
      >
        <Link href="/onboarding">Finish account</Link>
      </Button>
    );
  }

  return (
    <form
      className="w-full sm:w-40"
      action={async () => {
        "use server";
        await signIn("google", { redirectTo: "/onboarding" });
      }}
    >
      <Button
        type="submit"
        variant="outline"
        size="lg"
        className={buttonClassName}
      >
        <LogIn aria-hidden="true" />
        Sign in
      </Button>
    </form>
  );
}

function SingleLeaderboard({
  difficulty,
  result,
}: {
  difficulty: GameDifficulty;
  result: SingleLeaderboardResult;
}) {
  const isEasy = difficulty === "EASY";

  return (
    <section
      className="overflow-hidden rounded-2xl border border-border bg-card/80"
      aria-labelledby={`${difficulty.toLowerCase()}-leaderboard-title`}
    >
      <div className="flex items-end justify-between gap-4 border-b border-border px-5 py-5 sm:px-6">
        <div>
          <p className="mb-1 text-[0.68rem] font-bold tracking-[0.2em] text-muted-foreground uppercase">
            Single Player
          </p>
          <h2
            id={`${difficulty.toLowerCase()}-leaderboard-title`}
            className="text-2xl font-black tracking-tight"
          >
            {isEasy ? "Easy" : "Real"} Top 10
          </h2>
        </div>
        <Trophy
          className={isEasy ? "size-6 text-primary" : "size-6 text-sky-300"}
          aria-hidden="true"
        />
      </div>

      {result.unavailable ? (
        <p className="px-6 py-12 text-center text-sm text-muted-foreground">
          The standings are taking a quick breather. Try again soon.
        </p>
      ) : result.entries.length === 0 ? (
        <p className="px-6 py-12 text-center text-sm text-muted-foreground">
          No completed runs yet. The first mark is yours to set.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[28rem] border-collapse text-left">
            <thead>
              <tr className="text-[0.65rem] tracking-[0.16em] text-muted-foreground uppercase">
                <th scope="col" className="w-14 px-5 py-3 font-bold sm:px-6">
                  Rank
                </th>
                <th scope="col" className="px-3 py-3 font-bold">
                  Player
                </th>
                <th scope="col" className="px-3 py-3 text-right font-bold">
                  Score
                </th>
                <th scope="col" className="px-5 py-3 text-right font-bold sm:px-6">
                  Completed
                </th>
              </tr>
            </thead>
            <tbody>
              {result.entries.map((entry) => {
                const avatar = avatarDefinition(entry.avatarId);

                return (
                  <tr
                    key={entry.gameId}
                    className="border-t border-border/70 transition-colors hover:bg-white/[0.025]"
                  >
                    <td className="px-5 py-3.5 font-mono text-sm font-black text-muted-foreground sm:px-6">
                      {String(entry.rank).padStart(2, "0")}
                    </td>
                    <td className="px-3 py-3.5">
                      <div className="flex items-center gap-3">
                        {avatar ? (
                          <Image
                            src={avatar.src}
                            alt=""
                            width={36}
                            height={36}
                            className="size-9 rounded-full border border-border bg-secondary object-cover"
                          />
                        ) : (
                          <span className="grid size-9 place-items-center rounded-full border border-border bg-secondary font-bold">
                            {entry.username.slice(0, 1).toUpperCase()}
                          </span>
                        )}
                        <span className="max-w-40 truncate text-sm font-bold">
                          {entry.username}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-3.5 text-right font-mono text-sm font-black">
                      {entry.score.toLocaleString("en-US")}
                    </td>
                    <td className="px-5 py-3.5 text-right text-xs text-muted-foreground sm:px-6">
                      {formatCompletionDate(entry.completedAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RankedLeaderboard({
  difficulty,
  result,
}: {
  difficulty: GameDifficulty;
  result: RankedLeaderboardResult;
}) {
  const isEasy = difficulty === "EASY";

  return (
    <section
      className="overflow-hidden rounded-2xl border border-border bg-card/80"
      aria-labelledby={`${difficulty.toLowerCase()}-ranked-leaderboard-title`}
    >
      <div className="flex items-end justify-between gap-4 border-b border-border px-5 py-5 sm:px-6">
        <div>
          <p className="mb-1 text-[0.68rem] font-bold tracking-[0.2em] text-muted-foreground uppercase">
            Ranked
          </p>
          <h2
            id={`${difficulty.toLowerCase()}-ranked-leaderboard-title`}
            className="text-2xl font-black tracking-tight"
          >
            {isEasy ? "Easy" : "Real"} Top 10
          </h2>
        </div>
        <ShieldCheck
          className={isEasy ? "size-6 text-primary" : "size-6 text-sky-300"}
          aria-hidden="true"
        />
      </div>

      {result.unavailable ? (
        <p className="px-6 py-12 text-center text-sm text-muted-foreground">
          The standings are taking a quick breather. Try again soon.
        </p>
      ) : result.entries.length === 0 ? (
        <p className="px-6 py-12 text-center text-sm text-muted-foreground">
          No rated players yet. The first ranking is yours to claim.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[24rem] border-collapse text-left">
            <thead>
              <tr className="text-[0.65rem] tracking-[0.16em] text-muted-foreground uppercase">
                <th scope="col" className="w-14 px-5 py-3 font-bold sm:px-6">
                  Rank
                </th>
                <th scope="col" className="px-3 py-3 font-bold">
                  Player
                </th>
                <th scope="col" className="px-5 py-3 text-right font-bold sm:px-6">
                  Rating
                </th>
              </tr>
            </thead>
            <tbody>
              {result.entries.map((entry) => {
                const avatar = avatarDefinition(entry.avatarId);

                return (
                  <tr
                    key={entry.username}
                    className="border-t border-border/70 transition-colors hover:bg-white/[0.025]"
                  >
                    <td className="px-5 py-3.5 font-mono text-sm font-black text-muted-foreground sm:px-6">
                      {String(entry.rank).padStart(2, "0")}
                    </td>
                    <td className="px-3 py-3.5">
                      <div className="flex items-center gap-3">
                        {avatar ? (
                          <Image
                            src={avatar.src}
                            alt=""
                            width={36}
                            height={36}
                            className="size-9 rounded-full border border-border bg-secondary object-cover"
                          />
                        ) : (
                          <span className="grid size-9 place-items-center rounded-full border border-border bg-secondary font-bold">
                            {entry.username.slice(0, 1).toUpperCase()}
                          </span>
                        )}
                        <span className="max-w-40 truncate text-sm font-bold">
                          {entry.username}
                        </span>
                      </div>
                    </td>
                    <td className="px-5 py-3.5 text-right font-mono text-sm font-black sm:px-6">
                      {entry.rating.toLocaleString("en-US")}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default async function Home() {
  const [
    session,
    easyLeaderboard,
    realLeaderboard,
    easyRankedLeaderboard,
    realRankedLeaderboard,
  ] = await Promise.all([
    auth(),
    loadSingleLeaderboard("EASY"),
    loadSingleLeaderboard("REAL"),
    loadRankedLeaderboard("EASY"),
    loadRankedLeaderboard("REAL"),
  ]);
  const isGoogleAuthenticated = Boolean(session?.googleSub);
  const isRegistered = Boolean(session?.worldrawingUserId);

  return (
    <div className="dark h-screen overflow-y-auto bg-background text-foreground">
      <main>
        <section className="relative flex min-h-[84svh] items-center justify-center overflow-hidden px-5 py-20 text-center sm:min-h-[88svh]">
          <WorldMapBackdrop />

          <div className="relative z-10 flex max-w-5xl flex-col items-center">
            <div className="grid size-16 place-items-center rounded-full border border-primary/40 bg-primary/12 text-primary shadow-[0_0_45px_rgba(74,222,128,0.16)] sm:size-20">
              <Globe2 className="size-9 sm:size-11" strokeWidth={1.6} aria-hidden="true" />
            </div>
            <p className="mt-6 text-xs font-black tracking-[0.28em] text-primary uppercase">
              Draw · Guess · Score
            </p>
            <h1 className="mt-3 text-[clamp(3.75rem,12vw,9rem)] leading-[0.88] font-black tracking-[-0.07em] text-balance drop-shadow-2xl">
              GuessThePop
            </h1>
            <p className="mt-6 max-w-xl text-base leading-7 text-muted-foreground sm:text-lg">
              Are you sure you know where people live?
              <br />
              Find out.
            </p>

            <div className="mt-9 flex w-full max-w-sm flex-col justify-center gap-3 sm:max-w-none sm:flex-row">
              <PlayModeDialog isRegistered={isRegistered} />
              <AccountAction
                isGoogleAuthenticated={isGoogleAuthenticated}
                isRegistered={isRegistered}
              />
            </div>
          </div>

          <a
            href="#leaderboards"
            className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 flex-col items-center gap-1 text-[0.65rem] font-bold tracking-[0.18em] text-muted-foreground uppercase transition-colors hover:text-foreground sm:bottom-6"
          >
            Top runs
            <ChevronDown className="size-4 animate-bounce" aria-hidden="true" />
          </a>
        </section>

        <section id="leaderboards" className="scroll-mt-4 border-t border-border bg-card/30">
          <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 sm:py-16 lg:px-8">
            <div className="mb-8 flex items-end justify-between gap-5">
              <div>
                <p className="text-xs font-bold tracking-[0.2em] text-primary uppercase">
                  World rankings
                </p>
                <h2 className="mt-2 text-3xl font-black tracking-tight sm:text-4xl">
                  Best Single Player runs
                </h2>
              </div>
              <span className="hidden font-mono text-xs text-muted-foreground sm:block">
                MAX 50,000
              </span>
            </div>

            <div className="grid gap-6 xl:grid-cols-2">
              <SingleLeaderboard difficulty="EASY" result={easyLeaderboard} />
              <SingleLeaderboard difficulty="REAL" result={realLeaderboard} />
            </div>

            <div className="mt-12 mb-8 flex items-end justify-between gap-5">
              <div>
                <p className="text-xs font-bold tracking-[0.2em] text-primary uppercase">
                  Competitive ratings
                </p>
                <h2 className="mt-2 text-3xl font-black tracking-tight sm:text-4xl">
                  Top Ranked players
                </h2>
              </div>
              <span className="hidden font-mono text-xs text-muted-foreground sm:block">
                CURRENT RATING
              </span>
            </div>

            <div className="grid gap-6 xl:grid-cols-2">
              <RankedLeaderboard
                difficulty="EASY"
                result={easyRankedLeaderboard}
              />
              <RankedLeaderboard
                difficulty="REAL"
                result={realRankedLeaderboard}
              />
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border bg-card/30">
        <div className="mx-auto flex max-w-7xl flex-col gap-2 px-4 py-7 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <span className="font-black text-foreground">GuessThePop</span>
          <span>Population stays hidden until you commit.</span>
        </div>
      </footer>
    </div>
  );
}
