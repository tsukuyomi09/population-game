"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Crosshair,
  Link2,
  ShieldCheck,
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
import {
  requestActiveDirectDuel,
  requestDirectDuelAbandon,
  requestDirectDuelInviteCreate,
  type ActiveDirectDuelState,
} from "@/features/game/direct-duel";
import {
  requestMatchmakingJoin,
  requestMatchmakingLeave,
  requestMatchmakingMatchAcknowledge,
} from "@/features/game/matchmaking";
import type {
  MatchmakingEvent,
  MatchmakingIntent,
  MatchmakingMatch,
  MatchmakingWaiting,
} from "@/features/game/server/matchmaking-service";
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

export function PlayModeDialog({ isRegistered }: { isRegistered: boolean }) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const desktopRequiredDialogRef = useRef<HTMLDialogElement>(null);
  const [selectedMode, setSelectedMode] =
    useState<"SINGLE" | "DUEL" | "RANKED">("SINGLE");
  const [duelDifficulty, setDuelDifficulty] =
    useState<GameDifficulty>("EASY");
  const [isCreatingInvite, setIsCreatingInvite] = useState(false);
  const [isJoiningQueue, setIsJoiningQueue] = useState(false);
  const [queuedAttempt, setQueuedAttempt] =
    useState<MatchmakingWaiting | null>(null);
  const queuedAttemptRef = useRef<MatchmakingWaiting | null>(null);
  const joiningAttemptRef = useRef<string | null>(null);
  const transitioningAttemptRef = useRef<string | null>(null);
  const queuedIntent = queuedAttempt?.intent ?? null;
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [activeDuel, setActiveDuel] = useState<Extract<
    ActiveDirectDuelState,
    { status: "ACTIVE" }
  > | null>(null);
  const [isAbandoning, setIsAbandoning] = useState(false);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      void requestActiveDirectDuel()
        .then((state) => {
          if (active) setActiveDuel(state.status === "ACTIVE" ? state : null);
        })
        .catch(() => undefined);
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, []);

  const enterMatch = (match: MatchmakingMatch) => {
    if (transitioningAttemptRef.current) return;
    transitioningAttemptRef.current = match.attemptId;
    void requestMatchmakingMatchAcknowledge(match.attemptId, match.duelId).catch(
      () => undefined,
    );

    if (queuedAttemptRef.current?.attemptId === match.attemptId) {
      queuedAttemptRef.current = null;
      setQueuedAttempt(null);
    }
    dialogRef.current?.close();
    router.push(
      `/game?duelId=${encodeURIComponent(match.duelId)}` +
        `&difficulty=${match.difficulty}`,
    );
  };

  useEffect(() => {
    if (!queuedAttempt) return;

    const source = new EventSource(
      `/api/duel/matchmaking?attemptId=${encodeURIComponent(queuedAttempt.attemptId)}`,
    );
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as MatchmakingEvent;
      if (event.attemptId !== queuedAttemptRef.current?.attemptId) return;
      if (event.status === "MATCHED") {
        void enterMatch(event);
      } else if (event.status === "LEFT") {
        queuedAttemptRef.current = null;
        setQueuedAttempt(null);
        setInviteError("Matchmaking stopped. Join the queue to try again.");
      }
    };
    source.onerror = () => {
      if (queuedAttemptRef.current?.attemptId === queuedAttempt.attemptId) {
        setInviteError("Matchmaking connection lost. Reconnecting…");
      }
    };

    return () => source.close();
  }, [queuedAttempt]);

  const findPlayer = async (intent: MatchmakingIntent) => {
    if (isJoiningQueue || queuedAttemptRef.current || joiningAttemptRef.current) {
      return;
    }

    const attemptId = crypto.randomUUID();
    joiningAttemptRef.current = attemptId;
    setIsJoiningQueue(true);
    setInviteError(null);
    try {
      const state = await requestMatchmakingJoin(
        intent,
        duelDifficulty,
        attemptId,
      );
      if (joiningAttemptRef.current !== attemptId) {
        if (state.status === "MATCHED") {
          setActiveDuel({
            status: "ACTIVE",
            duelId: state.duelId,
            difficulty: state.difficulty,
            rated: state.rated,
          });
        }
        void requestMatchmakingLeave(attemptId).catch(() => undefined);
        return;
      }
      joiningAttemptRef.current = null;
      if (state.status === "MATCHED") {
        enterMatch(state);
      } else if (state.status === "WAITING") {
        queuedAttemptRef.current = state;
        setQueuedAttempt(state);
      }
    } catch (error) {
      setInviteError(
        error instanceof Error ? error.message : "Could not join matchmaking.",
      );
    } finally {
      if (
        joiningAttemptRef.current === attemptId ||
        joiningAttemptRef.current === null
      ) {
        if (joiningAttemptRef.current === attemptId) {
          joiningAttemptRef.current = null;
        }
        setIsJoiningQueue(false);
      }
    }
  };

  const cancelMatchmaking = async () => {
    const attempt = queuedAttemptRef.current;
    const joiningAttemptId = joiningAttemptRef.current;
    const attemptId = attempt?.attemptId ?? joiningAttemptId;
    if (!attemptId) return;

    joiningAttemptRef.current = null;
    if (attempt) {
      queuedAttemptRef.current = null;
      setQueuedAttempt(null);
    }

    try {
      const state = await requestMatchmakingLeave(attemptId);
      if (state.status === "MATCHED") {
        if (attempt) enterMatch(state);
        else {
          setActiveDuel({
            status: "ACTIVE",
            duelId: state.duelId,
            difficulty: state.difficulty,
            rated: state.rated,
          });
        }
        return;
      }
    } catch {
      // The attempt id remains known, so a late JOIN response retries LEAVE.
    }
  };

  const abandonActiveDuel = async () => {
    if (!activeDuel || isAbandoning) return;
    setIsAbandoning(true);
    setInviteError(null);
    try {
      await requestDirectDuelAbandon(activeDuel.duelId);
      const state = await requestActiveDirectDuel();
      setActiveDuel(state.status === "ACTIVE" ? state : null);
    } catch (error) {
      setInviteError(
        error instanceof Error ? error.message : "Could not abandon match.",
      );
    } finally {
      setIsAbandoning(false);
    }
  };

  const createInvite = async (intent: MatchmakingIntent) => {
    if (isCreatingInvite) return;
    if (intent === "RANKED" && !isRegistered) {
      setInviteError("Ranked invites require a registered account.");
      return;
    }

    setIsCreatingInvite(true);
    setInviteError(null);
    try {
      const invite = await requestDirectDuelInviteCreate(
        duelDifficulty,
        intent,
      );
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

  if (activeDuel) {
    return (
      <div className="w-full rounded-xl border border-primary/30 bg-primary/8 p-4 sm:w-auto">
        <p className="text-sm font-black">Match in progress</p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <Button
            type="button"
            size="lg"
            className="h-12 font-black"
            onClick={() =>
              router.push(
                `/game?duelId=${encodeURIComponent(activeDuel.duelId)}` +
                  `&difficulty=${activeDuel.difficulty}`,
              )
            }
          >
            Return to game
          </Button>
          <Button
            type="button"
            size="lg"
            variant="outline"
            className="h-12 font-black"
            disabled={isAbandoning}
            onClick={() => void abandonActiveDuel()}
          >
            {isAbandoning ? "Abandoning…" : "Abandon match"}
          </Button>
        </div>
        {inviteError && (
          <p className="mt-3 text-sm text-destructive">{inviteError}</p>
        )}
      </div>
    );
  }

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
        onClose={() => void cancelMatchmaking()}
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
            className="mt-6 grid grid-cols-3 overflow-hidden rounded-xl border border-border bg-background/45"
          >
            <Button
              type="button"
              variant="ghost"
              onClick={() => setSelectedMode("SINGLE")}
              disabled={queuedIntent !== null}
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
              disabled={queuedIntent !== null}
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
            <Button
              type="button"
              variant="ghost"
              onClick={() => setSelectedMode("RANKED")}
              disabled={queuedIntent !== null}
              aria-pressed={selectedMode === "RANKED"}
              className={`h-12 rounded-none border-l border-border font-black ${
                selectedMode === "RANKED"
                  ? "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <ShieldCheck aria-hidden="true" />
              Ranked
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
              {queuedIntent ? (
                <div className="rounded-xl border border-primary/30 bg-primary/8 p-7 text-center">
                  <UsersRound
                    className="mx-auto size-9 animate-pulse text-primary"
                    aria-hidden="true"
                  />
                  <h3 className="mt-4 text-2xl font-black">Finding a player</h3>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {queuedIntent === "RANKED" ? "Ranked" : "1v1"} · {" "}
                    {queuedAttempt?.difficulty === "EASY" ? "Easy" : "Real"}
                  </p>
                  <p className="mx-auto mt-3 max-w-sm text-xs leading-5 text-muted-foreground">
                    {queuedIntent === "RANKED"
                      ? "Searching for the closest available skill match. The search widens gradually within a competitive limit."
                      : "Waiting for the next available player in this difficulty."}
                  </p>
                  <div
                    className="mt-4 flex items-center justify-center gap-1.5"
                    aria-hidden="true"
                  >
                    {[0, 1, 2].map((step) => (
                      <span
                        key={step}
                        className="size-1.5 animate-pulse rounded-full bg-primary"
                        style={{ animationDelay: `${step * 180}ms` }}
                      />
                    ))}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void cancelMatchmaking()}
                    className="mt-5 h-11 w-full font-black"
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <>
                  <p className="text-sm font-bold text-foreground">
                    Choose difficulty
                  </p>
                  <div
                    role="group"
                    aria-label={`${selectedMode === "RANKED" ? "Ranked" : "1v1"} difficulty`}
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

                  {selectedMode === "DUEL" ? (
                    <div className="mt-4 grid gap-3 sm:grid-cols-2">
                      <Button
                        type="button"
                        onClick={() => void createInvite("DUEL")}
                        disabled={isCreatingInvite || isJoiningQueue}
                        className="h-12 font-black"
                      >
                        <Link2 aria-hidden="true" />
                        {isCreatingInvite ? "Creating…" : "Invite Player"}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void findPlayer("DUEL")}
                        disabled={isCreatingInvite || isJoiningQueue}
                        className="h-12 font-black"
                      >
                        <UsersRound aria-hidden="true" />
                        {isJoiningQueue ? "Joining…" : "Find Player"}
                      </Button>
                    </div>
                  ) : (
                    <div className="mt-4 grid gap-3 sm:grid-cols-2">
                      <Button
                        type="button"
                        onClick={() => void createInvite("RANKED")}
                        disabled={
                          !isRegistered || isCreatingInvite || isJoiningQueue
                        }
                        className="h-12 font-black"
                      >
                        <Link2 aria-hidden="true" />
                        {!isRegistered
                          ? "Account required"
                          : isCreatingInvite
                            ? "Creating…"
                            : "Invite Player"}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void findPlayer("RANKED")}
                        disabled={
                          !isRegistered || isCreatingInvite || isJoiningQueue
                        }
                        className="h-12 font-black"
                      >
                        <UsersRound aria-hidden="true" />
                        {!isRegistered
                          ? "Account required"
                          : isJoiningQueue
                            ? "Joining…"
                            : "Find Player"}
                      </Button>
                    </div>
                  )}

                  <p className="mt-3 text-center text-xs text-muted-foreground">
                    {selectedMode === "RANKED"
                      ? "Ranked is rated and available to registered players only."
                      : "1v1 is unrated. Guests and registered players can join."}
                  </p>
                </>
              )}
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
