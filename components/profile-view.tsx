"use client";

import { useRef, useState, type ComponentProps, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import Image from "next/image";
import Link from "next/link";
import {
  ArrowLeft,
  Camera,
  LogOut,
  Sparkles,
  Target,
  Trash2,
  Trophy,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { PlayModeDialog } from "@/components/play-mode-dialog";
import { AVATARS, avatarDefinition } from "@/features/account/avatars";
import {
  deleteProfileAccount,
  logoutAccount,
  updateProfileAvatar,
} from "@/features/account/server/profile-actions";
import type { SingleProfileStats } from "@/features/account/server/profile-stats";
import type { GameDifficulty } from "@/features/game/single-player";

type ProfileViewProps = {
  username: string;
  avatarId: string;
  stats: Record<GameDifficulty, SingleProfileStats>;
};

function PendingButton({
  pendingLabel,
  children,
  disabled,
  ...props
}: ComponentProps<typeof Button> & { pendingLabel: string }) {
  const { pending } = useFormStatus();

  return (
    <Button {...props} disabled={disabled || pending}>
      {pending ? pendingLabel : children}
    </Button>
  );
}

function formatDate(value: string | null) {
  if (!value) return "—";

  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));
}

function AvatarDialog({
  currentAvatarId,
  children,
}: {
  currentAvatarId: string;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  return (
    <div className="relative">
      {children}
      <Button
        type="button"
        size="icon"
        aria-label="Change avatar"
        className="absolute right-1 bottom-1 size-8 rounded-full border-2 border-background bg-sky-500 text-slate-950 shadow-lg hover:bg-sky-400"
        onClick={() => dialogRef.current?.showModal()}
      >
        <Camera className="size-3.5" aria-hidden="true" />
      </Button>

      <dialog
        ref={dialogRef}
        aria-labelledby="avatar-dialog-title"
        className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-xl overflow-y-auto rounded-2xl border border-border bg-card p-0 text-foreground shadow-2xl backdrop:bg-black/75 backdrop:backdrop-blur-sm"
        onClick={(event) => {
          if (event.target === event.currentTarget) event.currentTarget.close();
        }}
      >
        <form action={updateProfileAvatar} className="p-5 sm:p-7">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-black tracking-[0.18em] text-primary uppercase">
                Player look
              </p>
              <h2 id="avatar-dialog-title" className="mt-2 text-3xl font-black">
                Choose your avatar
              </h2>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Close"
              onClick={() => dialogRef.current?.close()}
            >
              <X aria-hidden="true" />
            </Button>
          </div>

          <fieldset className="mt-6">
            <legend className="sr-only">Avatar</legend>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {AVATARS.map((avatar) => (
                <label
                  key={avatar.id}
                  className="cursor-pointer rounded-xl border border-border bg-background/45 p-3 text-center transition-colors has-checked:border-primary has-checked:bg-primary/10"
                >
                  <input
                    type="radio"
                    name="avatarId"
                    value={avatar.id}
                    required
                    defaultChecked={avatar.id === currentAvatarId}
                    className="sr-only"
                  />
                  <Image
                    src={avatar.src}
                    alt=""
                    width={80}
                    height={80}
                    className="mx-auto size-16 rounded-full object-cover"
                  />
                  <span className="mt-2 block text-xs font-bold">{avatar.label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="mt-6 flex justify-end gap-3">
            <Button
              type="button"
              variant="ghost"
              onClick={() => dialogRef.current?.close()}
            >
              Cancel
            </Button>
            <PendingButton type="submit" pendingLabel="Saving…" className="font-black">
              Save avatar
            </PendingButton>
          </div>
        </form>
      </dialog>
    </div>
  );
}

function DeleteAccountDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="text-muted-foreground hover:bg-destructive/10 hover:text-red-200"
        onClick={() => dialogRef.current?.showModal()}
      >
        <Trash2 aria-hidden="true" />
        Delete account
      </Button>

      <dialog
        ref={dialogRef}
        aria-labelledby="delete-dialog-title"
        className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-2xl border border-red-300/20 bg-card p-0 text-foreground shadow-2xl backdrop:bg-black/80 backdrop:backdrop-blur-sm"
        onClick={(event) => {
          if (event.target === event.currentTarget) event.currentTarget.close();
        }}
      >
        <form action={deleteProfileAccount} className="p-6 sm:p-7">
          <div className="grid size-11 place-items-center rounded-full bg-destructive/15 text-red-300">
            <Trash2 className="size-5" aria-hidden="true" />
          </div>
          <h2 id="delete-dialog-title" className="mt-5 text-2xl font-black">
            Delete your account?
          </h2>
          <p className="mt-3 leading-7 text-muted-foreground">
            This permanently deletes your GuessThePop account, profile, game
            results, statistics and leaderboard entries. This cannot be undone.
          </p>
          <div className="mt-7 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="ghost"
              onClick={() => dialogRef.current?.close()}
            >
              Cancel
            </Button>
            <PendingButton
              type="submit"
              variant="destructive"
              pendingLabel="Deleting…"
              className="font-black"
            >
              Delete account permanently
            </PendingButton>
          </div>
        </form>
      </dialog>
    </>
  );
}

function LogoutButton({ compact = false }: { compact?: boolean }) {
  return (
    <form action={logoutAccount}>
      <PendingButton
        type="submit"
        variant="ghost"
        size="sm"
        pendingLabel="Signing out…"
        className={
          compact
            ? "text-muted-foreground hover:text-foreground"
            : "text-muted-foreground hover:text-foreground"
        }
      >
        <LogOut aria-hidden="true" />
        Logout
      </PendingButton>
    </form>
  );
}

export function ProfileView({ username, avatarId, stats }: ProfileViewProps) {
  const [difficulty, setDifficulty] = useState<GameDifficulty>("EASY");
  const selectedStats = stats[difficulty];
  const avatar = avatarDefinition(avatarId);
  const statItems = [
    ["Best score", selectedStats.bestScore.toLocaleString("en-US")],
    ["Games played", selectedStats.completedGames.toLocaleString("en-US")],
    ["Average score", selectedStats.averageScore.toLocaleString("en-US")],
    ["Perfect rounds", selectedStats.perfectRounds.toLocaleString("en-US")],
    ["Zero rounds", selectedStats.zeroRounds.toLocaleString("en-US")],
  ] as const;

  return (
    <main className="dark h-screen overflow-y-auto bg-background text-foreground">
      <div className="mx-auto w-full max-w-5xl px-4 py-5 sm:px-6 sm:py-8">
        <nav className="flex items-center justify-between" aria-label="Profile">
          <Button asChild variant="ghost" size="sm">
            <Link href="/">
              <ArrowLeft aria-hidden="true" />
              Home
            </Link>
          </Button>
          <LogoutButton compact />
        </nav>

        <header className="flex flex-col items-center py-10 text-center sm:py-14">
          <AvatarDialog currentAvatarId={avatarId}>
            {avatar ? (
              <Image
                src={avatar.src}
                alt={`${username}'s avatar`}
                width={176}
                height={176}
                className="size-40 rounded-full border-4 border-primary/25 bg-card object-cover shadow-[0_0_55px_rgba(74,222,128,0.12)] sm:size-44"
                priority
              />
            ) : (
              <div className="grid size-40 place-items-center rounded-full border-4 border-primary/25 bg-card text-6xl font-black text-primary sm:size-44">
                {username.slice(0, 1).toUpperCase()}
              </div>
            )}
          </AvatarDialog>
          <h1 className="mt-5 text-4xl font-black tracking-tight sm:text-5xl">
            {username}
          </h1>
          <div className="mt-6 flex w-full max-w-sm justify-center">
            <PlayModeDialog />
          </div>
        </header>

        <section aria-labelledby="single-stats-heading">
          <div className="flex flex-col gap-5 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-black tracking-[0.18em] text-primary uppercase">
                Single Player
              </p>
              <h2 id="single-stats-heading" className="mt-2 text-3xl font-black">
                Your numbers
              </h2>
            </div>
            <div
              role="tablist"
              aria-label="Difficulty"
              className="grid grid-cols-2 overflow-hidden rounded-lg border border-border bg-card"
            >
              {(["EASY", "REAL"] as const).map((option) => (
                <Button
                  key={option}
                  type="button"
                  role="tab"
                  aria-selected={difficulty === option}
                  variant="ghost"
                  onClick={() => setDifficulty(option)}
                  className={
                    difficulty === option
                      ? "rounded-none bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground"
                      : "rounded-none text-muted-foreground hover:text-foreground"
                  }
                >
                  {option === "EASY" ? (
                    <Sparkles aria-hidden="true" />
                  ) : (
                    <Target aria-hidden="true" />
                  )}
                  {option === "EASY" ? "Easy" : "Real"}
                </Button>
              ))}
            </div>
          </div>

          <dl className="mt-6 grid grid-cols-2 overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-5">
            {statItems.map(([label, value], index) => (
              <div
                key={label}
                className={`bg-card px-4 py-5 text-center ${index === 4 ? "col-span-2 sm:col-span-1" : ""}`}
              >
                <dt className="text-[0.65rem] font-bold tracking-wider text-muted-foreground uppercase">
                  {label}
                </dt>
                <dd className="mt-2 font-mono text-2xl font-black">{value}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="mt-10" aria-labelledby="top-runs-heading">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-xs font-black tracking-[0.18em] text-primary uppercase">
                {difficulty}
              </p>
              <h2 id="top-runs-heading" className="mt-2 text-2xl font-black">
                Top 3 runs
              </h2>
            </div>
            <Trophy className="size-6 text-primary" aria-hidden="true" />
          </div>

          <ol className="mt-5 border-y border-border">
            {selectedStats.topRuns.length === 0 ? (
              <li className="py-10 text-center text-sm text-muted-foreground">
                No completed {difficulty === "EASY" ? "Easy" : "Real"} runs yet.
              </li>
            ) : (
              selectedStats.topRuns.map((run, index) => (
                <li
                  key={run.gameId}
                  className="grid grid-cols-[3rem_1fr_auto] items-center gap-3 border-b border-border py-4 last:border-b-0"
                >
                  <span className="font-mono text-sm font-black text-muted-foreground">
                    0{index + 1}
                  </span>
                  <span className="font-mono text-2xl font-black">
                    {run.score.toLocaleString("en-US")}
                  </span>
                  <time className="text-xs text-muted-foreground">
                    {formatDate(run.completedAt)}
                  </time>
                </li>
              ))
            )}
          </ol>
        </section>

        <section className="mt-16 border-t border-border pt-6" aria-labelledby="account-heading">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 id="account-heading" className="text-sm font-black">Account</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Session and account controls.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <LogoutButton />
              <DeleteAccountDialog />
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
