"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Crosshair,
  Link2,
  Sparkles,
  Swords,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";
import {
  DesktopRequiredMessage,
  isDesktopPlayViewport,
} from "@/components/desktop-play-gate";
import { Button } from "@/components/ui/button";
import { requestDirectDuelInviteCreate } from "@/features/game/direct-duel";
import type { GameDifficulty } from "@/features/game/single-player";

const modes = [
  {
    difficulty: "EASY",
    name: "Easy",
    description: "The current playable mode.",
    bullets: ["Five rounds", "10,000 points per round"],
    icon: Sparkles,
    accent: "text-primary",
    available: true,
  },
  {
    difficulty: "REAL",
    name: "Real",
    description: "How the game is supposed to be played.",
    bullets: [],
    icon: Crosshair,
    accent: "text-sky-300",
    available: false,
  },
] as const;

export function PlayModeDialog() {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const desktopRequiredDialogRef = useRef<HTMLDialogElement>(null);
  const [selectedMode, setSelectedMode] =
    useState<"SINGLE" | "DUEL">("SINGLE");
  const [duelDifficulty, setDuelDifficulty] =
    useState<GameDifficulty>("EASY");
  const [isCreatingInvite, setIsCreatingInvite] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  const createInvite = async () => {
    if (isCreatingInvite) return;

    setIsCreatingInvite(true);
    setInviteError(null);
    try {
      const invite = await requestDirectDuelInviteCreate(duelDifficulty);
      dialogRef.current?.close();
      router.push(
        `/game?duelId=${encodeURIComponent(invite.duelId)}` +
          `&invite=${encodeURIComponent(invite.inviteToken)}` +
          `&difficulty=${duelDifficulty}`,
      );
    } catch (error) {
      setInviteError(
        error instanceof Error ? error.message : "Could not create invite.",
      );
      setIsCreatingInvite(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        size="lg"
        className="h-12 w-full px-8 text-base font-black sm:w-40"
        onClick={() => {
          if (isDesktopPlayViewport()) dialogRef.current?.showModal();
          else desktopRequiredDialogRef.current?.showModal();
        }}
      >
        Play
        <ArrowRight aria-hidden="true" />
      </Button>

      <dialog
        ref={desktopRequiredDialogRef}
        aria-labelledby="desktop-required-dialog-title"
        className="m-auto w-[calc(100%-2rem)] max-w-sm rounded-2xl border border-border bg-card p-0 text-foreground shadow-2xl backdrop:bg-black/75 backdrop:backdrop-blur-sm"
        onClick={(event) => {
          if (event.target === event.currentTarget) event.currentTarget.close();
        }}
      >
        <div className="relative p-5 pr-14 sm:p-6 sm:pr-16">
          <DesktopRequiredMessage titleId="desktop-required-dialog-title" />
          <form method="dialog" className="absolute top-4 right-4">
            <Button type="submit" variant="ghost" size="icon" aria-label="Close">
              <X aria-hidden="true" />
            </Button>
          </form>
        </div>
      </dialog>

      <dialog
        ref={dialogRef}
        aria-labelledby="play-dialog-title"
        className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-2xl overflow-y-auto rounded-2xl border border-border bg-card p-0 text-foreground shadow-2xl backdrop:bg-black/75 backdrop:backdrop-blur-sm"
        onClick={(event) => {
          if (event.target === event.currentTarget) event.currentTarget.close();
        }}
      >
        <div className="relative p-5 sm:p-7">
          <div className="pr-12">
            <p className="text-xs font-bold tracking-[0.18em] text-primary uppercase">
              Play Where Humans
            </p>
            <h2 id="play-dialog-title" className="mt-2 text-3xl font-black">
              Choose your mode
            </h2>
            <form
              method="dialog"
              className="absolute top-5 right-5 sm:top-7 sm:right-7"
            >
              <Button type="submit" variant="ghost" size="icon" aria-label="Close">
                <X aria-hidden="true" />
              </Button>
            </form>
          </div>

          <div
            role="group"
            aria-label="Game mode"
            className="mt-6 grid grid-cols-2 overflow-hidden rounded-xl border border-border bg-background/45"
          >
            <Button
              type="button"
              variant="ghost"
              onClick={() => setSelectedMode("SINGLE")}
              aria-pressed={selectedMode === "SINGLE"}
              className={`h-12 rounded-none font-black ${
                selectedMode === "SINGLE"
                  ? "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <UserRound aria-hidden="true" />
              Single Player
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setSelectedMode("DUEL")}
              aria-pressed={selectedMode === "DUEL"}
              className={`h-12 rounded-none border-l border-border font-black ${
                selectedMode === "DUEL"
                  ? "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Swords aria-hidden="true" />
              1v1
            </Button>
          </div>

          {selectedMode === "SINGLE" ? (
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {modes.map((mode) => {
                const content = (
                  <div className="grid h-full grid-rows-[1.5rem_auto_auto_1fr]">
                    <div className="h-6">
                      <mode.icon
                        className={`size-6 ${mode.accent}`}
                        aria-hidden="true"
                      />
                    </div>
                    {mode.available ? (
                      <ArrowRight
                        className="absolute top-5 right-5 size-5 text-muted-foreground transition-transform group-hover:translate-x-1 group-hover:text-foreground"
                        aria-hidden="true"
                      />
                    ) : (
                      <span className="absolute top-5 right-5 rounded-full border border-sky-300/20 bg-sky-300/10 px-2.5 py-1 text-[0.62rem] font-black tracking-wider text-sky-200 uppercase">
                        Coming soon
                      </span>
                    )}
                    <h3 className="mt-5 text-2xl font-black">{mode.name}</h3>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                      {mode.description}
                    </p>
                    {mode.bullets.length > 0 && (
                      <ul className="mt-4 space-y-2 text-xs text-muted-foreground">
                        {mode.bullets.map((bullet) => (
                          <li key={bullet} className="flex items-center gap-2">
                            <span className="size-1.5 rounded-full bg-current opacity-60" />
                            {bullet}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );

                return mode.available ? (
                  <Link
                    key={mode.difficulty}
                    href={`/game?difficulty=${mode.difficulty}`}
                    className="group relative h-full rounded-xl border border-border bg-background/45 p-5 text-left transition-colors hover:border-primary/50 hover:bg-background/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {content}
                  </Link>
                ) : (
                  <button
                    key={mode.difficulty}
                    type="button"
                    disabled
                    className="relative h-full cursor-not-allowed rounded-xl border border-sky-300/10 bg-background/25 p-5 text-left opacity-70"
                  >
                    {content}
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="mt-4">
              <p className="text-sm font-bold text-foreground">
                Choose difficulty
              </p>
              <div
                role="group"
                aria-label="1v1 difficulty"
                className="mt-3 grid grid-cols-2 gap-3"
              >
                {(["EASY", "REAL"] as const).map((difficulty) => (
                  <button
                    key={difficulty}
                    type="button"
                    onClick={() => setDuelDifficulty(difficulty)}
                    aria-pressed={duelDifficulty === difficulty}
                    className={`rounded-xl border p-5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      duelDifficulty === difficulty
                        ? "border-primary/60 bg-primary/10"
                        : "border-border bg-background/45 hover:border-primary/35 hover:bg-background/80"
                    }`}
                  >
                    {difficulty === "EASY" ? (
                      <Sparkles
                        className="size-6 text-primary"
                        aria-hidden="true"
                      />
                    ) : (
                      <Crosshair
                        className="size-6 text-sky-300"
                        aria-hidden="true"
                      />
                    )}
                    <span className="mt-4 block text-xl font-black capitalize">
                      {difficulty.toLowerCase()}
                    </span>
                  </button>
                ))}
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <Button
                  type="button"
                  onClick={() => void createInvite()}
                  disabled={isCreatingInvite}
                  className="h-12 font-black"
                >
                  <Link2 aria-hidden="true" />
                  {isCreatingInvite ? "Creating…" : "Invite Player"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled
                  className="h-12 font-black"
                >
                  <UsersRound aria-hidden="true" />
                  Find Player · Soon
                </Button>
              </div>

              <p className="mt-3 text-center text-xs text-muted-foreground">
                Direct 1v1 is unrated. Guests and registered players can join.
              </p>
              {inviteError && (
                <p className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                  {inviteError}
                </p>
              )}
            </div>
          )}
        </div>
      </dialog>
    </>
  );
}
