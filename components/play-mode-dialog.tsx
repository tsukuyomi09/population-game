"use client";

import { useRef } from "react";
import Link from "next/link";
import { ArrowRight, Crosshair, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";

const modes = [
  {
    difficulty: "EASY",
    name: "Easy",
    description: "A Single Player run with the Easy ruleset.",
    bullets: ["Five rounds", "Up to 10,000 points each", "Details being refined"],
    icon: Sparkles,
    accent: "text-primary",
  },
  {
    difficulty: "REAL",
    name: "Real",
    description: "A Single Player run with the Real ruleset.",
    bullets: ["Five rounds", "Up to 50,000 points total", "Final rules coming later"],
    icon: Crosshair,
    accent: "text-sky-300",
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
        <div className="p-5 sm:p-7">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-bold tracking-[0.18em] text-primary uppercase">
                Single Player
              </p>
              <h2 id="play-dialog-title" className="mt-2 text-3xl font-black">
                Choose your mode
              </h2>
            </div>
            <form method="dialog">
              <Button type="submit" variant="ghost" size="icon" aria-label="Close">
                <X aria-hidden="true" />
              </Button>
            </form>
          </div>

          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            {modes.map((mode) => (
              <Link
                key={mode.difficulty}
                href={`/game?difficulty=${mode.difficulty}`}
                className="group rounded-xl border border-border bg-background/45 p-5 text-left transition-colors hover:border-primary/50 hover:bg-background/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div className="flex items-center justify-between gap-4">
                  <mode.icon className={`size-6 ${mode.accent}`} aria-hidden="true" />
                  <ArrowRight
                    className="size-5 text-muted-foreground transition-transform group-hover:translate-x-1 group-hover:text-foreground"
                    aria-hidden="true"
                  />
                </div>
                <h3 className="mt-5 text-2xl font-black">{mode.name}</h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  {mode.description}
                </p>
                <ul className="mt-4 space-y-2 text-xs text-muted-foreground">
                  {mode.bullets.map((bullet) => (
                    <li key={bullet} className="flex items-center gap-2">
                      <span className="size-1.5 rounded-full bg-current opacity-60" />
                      {bullet}
                    </li>
                  ))}
                </ul>
              </Link>
            ))}
          </div>
        </div>
      </dialog>
    </>
  );
}
