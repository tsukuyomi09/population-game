"use client";

import { useRef } from "react";
import Link from "next/link";
import { ArrowRight, Crosshair, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";

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
  const dialogRef = useRef<HTMLDialogElement>(null);

  return (
    <>
      <Button
        type="button"
        size="lg"
        className="h-12 w-full px-8 text-base font-black sm:w-40"
        onClick={() => dialogRef.current?.showModal()}
      >
        Play
        <ArrowRight aria-hidden="true" />
      </Button>

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
              Single Player
            </p>
            <h2 id="play-dialog-title" className="mt-2 text-3xl font-black">
              Choose your mode
            </h2>
            <form method="dialog" className="absolute top-5 right-5 sm:top-7 sm:right-7">
              <Button type="submit" variant="ghost" size="icon" aria-label="Close">
                <X aria-hidden="true" />
              </Button>
            </form>
          </div>

          <div className="mt-6 grid gap-3 sm:grid-cols-2">
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
        </div>
      </dialog>
    </>
  );
}
