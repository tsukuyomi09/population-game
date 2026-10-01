"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Swords } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  requestDirectDuelCreate,
  requestDirectDuelJoin,
} from "@/features/game/direct-duel";

export default function DirectDuelTestPage() {
  const router = useRouter();
  const [joinId, setJoinId] = useState("");
  const [pending, setPending] = useState<"CREATE" | "JOIN" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const enterGame = (duelId: string) => {
    router.push(`/game?duelId=${encodeURIComponent(duelId)}&difficulty=EASY`);
  };

  const create = async () => {
    try {
      setPending("CREATE");
      setError(null);
      enterGame((await requestDirectDuelCreate("EASY")).duelId);
    } catch (createError) {
      setError(
        createError instanceof Error ? createError.message : "Create failed.",
      );
      setPending(null);
    }
  };

  const join = async () => {
    try {
      setPending("JOIN");
      setError(null);
      enterGame((await requestDirectDuelJoin(joinId.trim())).duelId);
    } catch (joinError) {
      setError(joinError instanceof Error ? joinError.message : "Join failed.");
      setPending(null);
    }
  };

  return (
    <main className="dark grid min-h-screen place-items-center bg-background p-5 text-foreground">
      <section className="w-full max-w-xl rounded-2xl border border-border bg-card p-6 shadow-2xl sm:p-8">
        <div className="grid size-12 place-items-center rounded-full border border-primary/25 bg-primary/10 text-primary">
          <Swords className="size-6" aria-hidden="true" />
        </div>
        <p className="mt-5 text-xs font-black tracking-[0.18em] text-primary uppercase">
          E1 development launcher
        </p>
        <h1 className="mt-2 text-3xl font-black">Direct 1v1</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Use two browser profiles so each participant has a distinct runtime
          identity. The creator copies the Duel ID from the waiting game screen.
        </p>

        <Button
          type="button"
          onClick={create}
          disabled={pending !== null}
          className="mt-7 h-12 w-full font-black"
        >
          {pending === "CREATE" ? "Creating…" : "Create Duel"}
        </Button>

        <div className="my-5 flex items-center gap-3 text-xs font-bold tracking-widest text-muted-foreground uppercase">
          <span className="h-px flex-1 bg-border" />
          Join
          <span className="h-px flex-1 bg-border" />
        </div>

        <div className="flex gap-2">
          <input
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
            value={joinId}
            onChange={(event) => setJoinId(event.target.value)}
            placeholder="Duel ID"
            aria-label="Duel ID"
          />
          <Button
            type="button"
            variant="outline"
            onClick={join}
            disabled={pending !== null || joinId.trim().length === 0}
            className="font-black"
          >
            {pending === "JOIN" ? "Joining…" : "Join Duel"}
          </Button>
        </div>

        {error && (
          <p className="mt-5 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </p>
        )}
      </section>
    </main>
  );
}
