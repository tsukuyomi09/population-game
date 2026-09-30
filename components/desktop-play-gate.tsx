"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft, Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";

const DESKTOP_PLAY_MIN_WIDTH = 1024;

export function isDesktopPlayViewport() {
  return window.matchMedia(`(min-width: ${DESKTOP_PLAY_MIN_WIDTH}px)`).matches;
}

export function DesktopRequiredMessage({ titleId }: { titleId: string }) {
  return (
    <>
      <h2 id={titleId} className="text-2xl font-black tracking-tight">
        Desktop required
      </h2>
      <p className="mt-3 leading-6 text-muted-foreground">
        GuessThePop is currently designed for mouse and keyboard.
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        Open it on a desktop or laptop to play.
      </p>
    </>
  );
}

export function DesktopGameGate({ children }: { children: ReactNode }) {
  const [canPlay, setCanPlay] = useState<boolean | null>(null);

  useEffect(() => {
    setCanPlay(isDesktopPlayViewport());
  }, []);

  if (canPlay === null) {
    return <main className="dark h-screen bg-background" aria-busy="true" />;
  }

  if (canPlay) return children;

  return (
    <main className="dark grid h-screen place-items-center bg-background p-5 text-foreground">
      <section className="w-full max-w-sm text-center">
        <div className="mx-auto grid size-12 place-items-center rounded-full border border-sky-300/20 bg-sky-300/10 text-sky-200">
          <Monitor className="size-5" aria-hidden="true" />
        </div>
        <div className="mt-5">
          <DesktopRequiredMessage titleId="desktop-required-page-title" />
        </div>
        <Button asChild variant="outline" className="mt-6">
          <Link href="/">
            <ArrowLeft aria-hidden="true" />
            Back home
          </Link>
        </Button>
      </section>
    </main>
  );
}
