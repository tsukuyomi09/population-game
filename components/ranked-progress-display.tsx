import { Crown, ShieldCheck, Sparkles, Target } from "lucide-react";
import type { GameDifficulty } from "@/features/game/single-player";
import { rankedResultFeedback } from "@/features/rating/ranked-presentation";
import type {
  RankedProgress,
  RankedTier,
} from "@/features/rating/server/ranked-visible-progression";
import { cn } from "@/lib/utils";

const TIER_TONES: Record<RankedTier, string> = {
  BRONZE: "border-amber-700/40 bg-amber-800/15 text-amber-300",
  SILVER: "border-slate-300/35 bg-slate-300/10 text-slate-200",
  GOLD: "border-yellow-300/35 bg-yellow-300/10 text-yellow-200",
  PLATINUM: "border-cyan-300/35 bg-cyan-300/10 text-cyan-200",
  DIAMOND: "border-violet-300/35 bg-violet-300/10 text-violet-200",
  MASTER: "border-fuchsia-300/40 bg-fuchsia-300/12 text-fuchsia-200",
};

export function RankedTierBadge({
  tier,
  label,
  compact = false,
}: {
  tier: RankedTier;
  label: string;
  compact?: boolean;
}) {
  const Icon = tier === "MASTER" ? Crown : ShieldCheck;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border font-black tracking-wide",
        compact ? "gap-1.5 px-2.5 py-1 text-[0.68rem]" : "gap-2 px-3 py-1.5 text-xs",
        TIER_TONES[tier],
      )}
    >
      <Icon className={compact ? "size-3" : "size-3.5"} aria-hidden="true" />
      {label}
    </span>
  );
}

export function RankedLpProgress({
  tier,
  lp,
  compact = false,
}: {
  tier: RankedTier;
  lp: number;
  compact?: boolean;
}) {
  const isMaster = tier === "MASTER";
  return (
    <div className={compact ? "mt-2" : "mt-4"}>
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-bold text-muted-foreground">
          {isMaster ? "Master LP" : "League Points"}
        </span>
        <span className="font-mono font-black text-foreground">{lp} LP</span>
      </div>
      <div
        role={isMaster ? undefined : "progressbar"}
        aria-label={isMaster ? undefined : "League Points"}
        aria-valuemin={isMaster ? undefined : 0}
        aria-valuemax={isMaster ? undefined : 100}
        aria-valuenow={isMaster ? undefined : lp}
        className={cn(
          "mt-2 overflow-hidden rounded-full bg-white/8",
          compact ? "h-1.5" : "h-2.5",
        )}
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-700 ease-out",
            isMaster
              ? "w-full animate-pulse bg-gradient-to-r from-violet-400 via-fuchsia-300 to-amber-200"
              : "bg-gradient-to-r from-sky-400 to-primary",
          )}
          style={isMaster ? undefined : { width: `${Math.min(100, lp)}%` }}
        />
      </div>
      {isMaster && !compact && (
        <p className="mt-2 text-[0.68rem] text-muted-foreground">
          Master LP is open-ended.
        </p>
      )}
    </div>
  );
}

function PlacementProgress({ progress }: { progress: Extract<RankedProgress, { status: "UNRANKED" }> }) {
  const percent =
    (progress.rankedGamesCompleted / progress.placementsRequired) * 100;
  return (
    <div className="mt-4">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-bold text-muted-foreground">Placements</span>
        <span className="font-mono font-black">
          {progress.rankedGamesCompleted} / {progress.placementsRequired}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label="Ranked placements"
        aria-valuemin={0}
        aria-valuemax={progress.placementsRequired}
        aria-valuenow={progress.rankedGamesCompleted}
        className="mt-2 h-2.5 overflow-hidden rounded-full bg-white/8"
      >
        <div
          className="h-full rounded-full bg-gradient-to-r from-slate-500 to-sky-300 transition-[width] duration-700 ease-out"
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="mt-2 text-[0.68rem] text-muted-foreground">
        Complete 10 Ranked games to reveal your rank.
      </p>
    </div>
  );
}

export function RankedProgressCard({
  difficulty,
  progress,
}: {
  difficulty: GameDifficulty;
  progress: RankedProgress;
}) {
  const DifficultyIcon = difficulty === "EASY" ? Sparkles : Target;
  return (
    <article
      className={cn(
        "relative overflow-hidden rounded-2xl border bg-card p-5 text-left shadow-sm transition-colors sm:p-6",
        progress.status === "RANKED" && progress.tier === "MASTER"
          ? "border-fuchsia-300/25"
          : "border-border",
      )}
    >
      {progress.status === "RANKED" && progress.tier === "MASTER" && (
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-fuchsia-300 to-transparent"
          aria-hidden="true"
        />
      )}
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-xs font-black tracking-[0.16em] text-muted-foreground uppercase">
          <DifficultyIcon className="size-4" aria-hidden="true" />
          {difficulty === "EASY" ? "Easy" : "Real"}
        </p>
        {progress.status === "RANKED" && (
          <RankedTierBadge
            tier={progress.tier}
            label={progress.tier === "MASTER" ? "MASTER" : progress.tier}
            compact
          />
        )}
      </div>

      {progress.status === "UNRANKED" ? (
        <>
          <h3 className="mt-5 text-3xl font-black tracking-tight">UNRANKED</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Placement progress
          </p>
          <PlacementProgress progress={progress} />
        </>
      ) : (
        <>
          <h3 className="mt-5 text-3xl font-black tracking-tight">
            {progress.label}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {progress.tier === "MASTER"
              ? "The open-ended top rank"
              : `${progress.division} division`}
          </p>
          <RankedLpProgress tier={progress.tier} lp={progress.lp} />
        </>
      )}
    </article>
  );
}

export function RankedResultProgress({
  before,
  after,
  lpChange,
}: {
  before: RankedProgress;
  after: RankedProgress;
  lpChange: number | null;
}) {
  const feedback = rankedResultFeedback({ before, after, lpChange });
  const positive =
    feedback.kind === "PROMOTION" ||
    feedback.kind === "RANK_REVEAL" ||
    feedback.kind === "LP_GAIN";
  const negative = feedback.kind === "DEMOTION" || feedback.kind === "LP_LOSS";

  return (
    <section
      className={cn(
        "animate-in fade-in slide-in-from-bottom-2 mt-6 rounded-2xl border p-5 text-left duration-500",
        positive
          ? "border-primary/30 bg-primary/8"
          : negative
            ? "border-red-300/25 bg-red-300/8"
            : "border-border bg-card",
      )}
      aria-label="Ranked progression result"
    >
      <p className="text-[0.68rem] font-black tracking-[0.18em] text-muted-foreground uppercase">
        Ranked progression
      </p>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-black">{feedback.title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{feedback.detail}</p>
        </div>
        {after.status === "RANKED" && (
          <RankedTierBadge tier={after.tier} label={after.label} />
        )}
      </div>

      {before.status === "RANKED" &&
        after.status === "RANKED" &&
        before.label !== after.label && (
          <p className="mt-4 text-xs font-bold text-muted-foreground">
            {before.label} <span aria-hidden="true">→</span> {after.label}
          </p>
        )}

      {after.status === "UNRANKED" ? (
        <PlacementProgress progress={after} />
      ) : (
        <RankedLpProgress tier={after.tier} lp={after.lp} />
      )}
    </section>
  );
}
