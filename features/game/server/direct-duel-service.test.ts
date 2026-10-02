import assert from "node:assert/strict";
import test from "node:test";
import type { PopulationShape } from "../../population/types";
import type {
  GuestRuntimePlayer,
  RegisteredRuntimePlayer,
  RuntimePlayer,
} from "../runtime-player";
import {
  createMatchmadeDuel,
  directDuelInviteIntent,
  DirectDuelService,
  type DirectDuelEvent,
  type DirectDuelFinalizationInput,
  type DirectDuelFinalizationResult,
} from "./direct-duel-service";
import { MatchmakingService } from "./matchmaking-service";

function guest(id: string): GuestRuntimePlayer {
  return {
    kind: "guest",
    runtimePlayerId: id,
    guestSessionId: `${id}-session`,
  };
}

function registered(id: string): RegisteredRuntimePlayer {
  return {
    kind: "registered",
    runtimePlayerId: id,
    userId: `${id}-user`,
    username: id,
    avatarId: "cat",
  };
}

function shape(population: number): PopulationShape {
  return {
    id: population,
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [0, 1],
          [0, 0],
        ],
      ],
    },
  };
}

class FakeRuntime {
  now = new Date("2026-01-01T00:00:00.000Z");
  private timers: Array<{ callback: () => void; cancelled: boolean }> = [];

  schedule = (callback: () => void) => {
    const timer = { callback, cancelled: false };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };

  moveTo(value: string | Date) {
    this.now = new Date(value);
  }

  fireRoundDeadline(round: { endsAt: string }) {
    this.fireNextTimerAt(round.endsAt);
  }

  fireNextTimerAt(value: string | Date) {
    this.moveTo(value);
    const timer = this.timers.find((candidate) => !candidate.cancelled);
    assert.ok(timer);
    timer.cancelled = true;
    timer.callback();
  }

  activeTimerCount() {
    return this.timers.filter((timer) => !timer.cancelled).length;
  }
}

function service(
  runtime: FakeRuntime,
  finalizeDuel?: (
    input: DirectDuelFinalizationInput,
  ) => Promise<DirectDuelFinalizationResult | void>,
) {
  return new DirectDuelService({
    generateDuelId: () => "duel-1",
    generateInviteToken: () => "invite-token-123456",
    generateTarget: () => 1_000,
    inviteTtlMs: 600_000,
    preGameDurationMs: 5_000,
    roundDurationMs: 120_000,
    finalWindowMs: 10_000,
    resultPhaseDurationMs: 10_000,
    now: () => new Date(runtime.now),
    schedule: runtime.schedule,
    finalizeDuel,
  });
}

async function population(shapes: PopulationShape[]) {
  return Number(shapes[0]?.id ?? 0);
}

test("guest and registered creators make unrated short-lived invites", () => {
  for (const creator of [guest("guest-creator"), registered("member-creator")]) {
    const runtime = new FakeRuntime();
    const created = service(runtime).createInvite(creator, "REAL");

    assert.equal(created.status, "WAITING");
    assert.equal(created.rated, false);
    assert.equal(created.difficulty, "REAL");
    assert.equal(created.inviteToken, "invite-token-123456");
    assert.equal(
      new Date(created.inviteExpiresAt).getTime() - runtime.now.getTime(),
      600_000,
    );
  }
});

test("client invite input cannot set rated directly", () => {
  assert.equal(directDuelInviteIntent({ rated: true }), "DUEL");
  assert.equal(
    directDuelInviteIntent({ intent: "DUEL", rated: true }),
    "DUEL",
  );
  assert.equal(directDuelInviteIntent({ intent: "RANKED" }), "RANKED");
  assert.throws(
    () => directDuelInviteIntent({ intent: "RATED" }),
    /DUEL or RANKED/,
  );
});

test("Ranked invites require two registered players and start exactly once", () => {
  const runtime = new FakeRuntime();
  const duels = service(runtime);
  const creator = registered("ranked-creator");
  const joiner = registered("ranked-joiner");
  const creatorEvents: DirectDuelEvent[] = [];

  assert.throws(
    () => duels.createRankedInvite(guest("guest-creator"), "EASY"),
    /registered players/,
  );

  const created = duels.createRankedInvite(creator, "REAL");
  assert.equal(created.status, "WAITING");
  assert.equal(created.rated, true);
  assert.equal(created.difficulty, "REAL");
  assert.doesNotMatch(JSON.stringify(created), /mmr/i);
  duels.subscribe(created.duelId, creator, (event) =>
    creatorEvents.push(event),
  );

  assert.throws(
    () => duels.joinInvite(guest("guest-joiner"), created.inviteToken),
    /registered players/,
  );
  assert.throws(
    () => duels.joinInvite(creator, created.inviteToken),
    /second distinct player/,
  );
  assert.equal(runtime.activeTimerCount(), 0);

  const joined = duels.joinInvite(joiner, created.inviteToken);
  assert.equal(joined.status, "COUNTDOWN");
  assert.equal(joined.rated, true);
  assert.equal(joined.players.length, 2);
  assert.equal(runtime.activeTimerCount(), 1);
  assert.equal(
    creatorEvents.filter((event) => event.type === "pre_game_started").length,
    1,
  );

  assert.equal(
    duels.joinInvite(joiner, created.inviteToken).status,
    "COUNTDOWN",
  );
  assert.throws(
    () =>
      duels.joinInvite(registered("ranked-third"), created.inviteToken),
    /already been used/,
  );
  assert.equal(runtime.activeTimerCount(), 1);

  runtime.fireNextTimerAt(joined.preGame.endsAt);
  assert.equal(
    creatorEvents.filter((event) => event.type === "game_started").length,
    1,
  );
  assert.equal(
    creatorEvents.find((event) => event.type === "game_started")?.rated,
    true,
  );
  assert.equal(
    creatorEvents.filter((event) => event.type === "round_started").length,
    1,
  );
  assert.equal(runtime.activeTimerCount(), 1);
  assert.doesNotMatch(JSON.stringify(creatorEvents), /mmr/i);
});

test("matchmaking creates a Duel retrievable through the canonical runtime lookup", () => {
  const runtime = new FakeRuntime();
  const duels = service(runtime);
  const canonicalDuels = () => duels;
  const matchmaking = new MatchmakingService(
    (firstPlayer, secondPlayer, difficulty, rated) =>
      createMatchmadeDuel(
        canonicalDuels(),
        firstPlayer,
        secondPlayer,
        difficulty,
        rated,
      ),
  );
  const first = registered("member-a");
  const second = registered("member-b");
  assert.equal(
    matchmaking.join(first, "RANKED", "REAL", 1_000).status,
    "WAITING",
  );
  const created = matchmaking.join(second, "RANKED", "REAL", 1_000);
  const events: DirectDuelEvent[] = [];

  assert.equal(created.status, "MATCHED");
  assert.equal(created.rated, true);
  assert.equal(runtime.activeTimerCount(), 1);
  canonicalDuels().subscribe(created.duelId, first, (event) =>
    events.push(event),
  );
  const preGame = events.find(
    (event) => event.type === "pre_game_started",
  );
  assert.equal(preGame?.rated, true);
  assert.equal(preGame?.players?.length, 2);
  assert.ok(preGame?.preGame);

  runtime.fireNextTimerAt(preGame.preGame.endsAt);
  assert.equal(events.find((event) => event.type === "game_started")?.rated, true);
  assert.equal(
    events.filter((event) => event.type === "round_started").length,
    1,
  );

  assert.throws(
    () =>
      createMatchmadeDuel(
        service(new FakeRuntime()),
        guest("guest"),
        second,
        "EASY",
        true,
      ),
    /require registered players/,
  );
});

test("Ranked invite abandon invokes terminal persistence exactly once", async () => {
  const runtime = new FakeRuntime();
  const finalizations: DirectDuelFinalizationInput[] = [];
  const duels = service(runtime, async (input) => {
    finalizations.push(input);
    return {
      status: "APPLIED",
      competitiveChanges: [
        {
          userId: "member-a-user",
          outcome: "LOSS",
          progressBefore: {
            status: "RANKED",
            rankedGamesCompleted: 10,
            tier: "SILVER",
            division: "II",
            label: "Silver II",
            lp: 44,
          },
          progressAfter: {
            status: "RANKED",
            rankedGamesCompleted: 10,
            tier: "SILVER",
            division: "II",
            label: "Silver II",
            lp: 28,
          },
          lpChange: -16,
        },
        {
          userId: "member-b-user",
          outcome: "WIN",
          progressBefore: {
            status: "UNRANKED",
            rankedGamesCompleted: 8,
            placementsRequired: 10,
          },
          progressAfter: {
            status: "UNRANKED",
            rankedGamesCompleted: 9,
            placementsRequired: 10,
          },
          lpChange: null,
        },
      ],
    };
  });
  const first = registered("member-a");
  const second = registered("member-b");
  const firstEvents: DirectDuelEvent[] = [];
  const invitation = duels.createRankedInvite(first, "REAL");
  const created = duels.joinInvite(second, invitation.inviteToken);
  if (created.status !== "COUNTDOWN") {
    throw new Error("Ranked match did not enter its pre-game countdown.");
  }
  runtime.fireNextTimerAt(created.preGame.endsAt);
  duels.subscribe(created.duelId, first, (event) => firstEvents.push(event));

  assert.equal((await duels.abandon(created.duelId, first)).status, "APPLIED");
  assert.equal((await duels.abandon(created.duelId, first)).status, "DUPLICATE");
  assert.equal(finalizations.length, 1);
  assert.equal(finalizations[0]?.rated, true);
  assert.equal(finalizations[0]?.difficulty, "REAL");
  assert.equal(finalizations[0]?.completionReason, "ABANDON");
  assert.equal(
    finalizations[0]?.abandonedRuntimePlayerId,
    first.runtimePlayerId,
  );
  assert.equal(finalizations[0]?.rounds.length, 1);
  const completed = firstEvents.find((event) => event.type === "game_completed");
  assert.deepEqual(completed?.rankedProgress, {
    before: {
      status: "RANKED",
      rankedGamesCompleted: 10,
      tier: "SILVER",
      division: "II",
      label: "Silver II",
      lp: 44,
    },
    after: {
      status: "RANKED",
      rankedGamesCompleted: 10,
      tier: "SILVER",
      division: "II",
      label: "Silver II",
      lp: 28,
    },
    lpChange: -16,
  });
  assert.doesNotMatch(JSON.stringify(completed), /mmr/i);
});

test("invite identity combinations join the same Duel and start once after countdown", async (t) => {
  const combinations: Array<{
    name: string;
    creator: RuntimePlayer;
    joiner: RuntimePlayer;
  }> = [
    {
      name: "guest vs guest",
      creator: guest("guest-a"),
      joiner: guest("guest-b"),
    },
    {
      name: "guest vs registered",
      creator: guest("guest-a"),
      joiner: registered("member-b"),
    },
    {
      name: "registered vs guest",
      creator: registered("member-a"),
      joiner: guest("guest-b"),
    },
    {
      name: "registered vs registered",
      creator: registered("member-a"),
      joiner: registered("member-b"),
    },
  ];

  for (const combination of combinations) {
    await t.test(combination.name, () => {
      const runtime = new FakeRuntime();
      const duels = service(runtime);
      const creatorEvents: DirectDuelEvent[] = [];
      const joinerEvents: DirectDuelEvent[] = [];
      const created = duels.createInvite(combination.creator, "EASY");
      duels.subscribe(created.duelId, combination.creator, (event) =>
        creatorEvents.push(event),
      );

      assert.equal(
        creatorEvents.filter((event) => event.type === "round_started").length,
        0,
      );
      assert.equal(
        creatorEvents.filter((event) => event.type === "pre_game_started")
          .length,
        0,
      );

      const joined = duels.joinInvite(
        combination.joiner,
        created.inviteToken,
      );
      assert.equal(joined.duelId, created.duelId);
      assert.equal(joined.status, "COUNTDOWN");
      assert.equal(joined.rated, false);
      assert.equal(joined.players.length, 2);
      assert.equal(
        new Date(joined.preGame.endsAt).getTime() -
          new Date(joined.preGame.startedAt).getTime(),
        5_000,
      );
      assert.equal(
        creatorEvents.filter((event) => event.type === "pre_game_started")
          .length,
        1,
      );
      assert.equal(
        creatorEvents.filter((event) => event.type === "round_started").length,
        0,
      );

      duels.subscribe(created.duelId, combination.joiner, (event) =>
        joinerEvents.push(event),
      );
      assert.equal(
        joinerEvents.filter((event) => event.type === "pre_game_started")
          .length,
        1,
      );

      const duplicate = duels.joinInvite(
        combination.joiner,
        created.inviteToken,
      );
      assert.equal(duplicate.status, "COUNTDOWN");
      assert.equal(runtime.activeTimerCount(), 1);

      runtime.fireNextTimerAt(joined.preGame.endsAt);
      const rounds = creatorEvents.filter(
        (event) => event.type === "round_started",
      );
      assert.equal(rounds.length, 1);
      assert.equal(rounds[0]?.round?.roundNumber, 1);
      assert.equal(
        new Date(rounds[0]!.round!.endsAt).getTime() -
          new Date(rounds[0]!.round!.startedAt).getTime(),
        120_000,
      );
      assert.equal(
        creatorEvents.find((event) => event.type === "game_started")?.rated,
        false,
      );

      const staleDuplicate = duels.joinInvite(
        combination.joiner,
        created.inviteToken,
      );
      assert.equal(staleDuplicate.status, "ACTIVE");
      assert.equal(
        creatorEvents.filter((event) => event.type === "round_started").length,
        1,
      );
      assert.equal(runtime.activeTimerCount(), 1);
    });
  }
});

test("invalid, expired, creator-used, and third-player invites fail safely", () => {
  const invalidDuels = service(new FakeRuntime());
  assert.throws(
    () => invalidDuels.joinInvite(guest("joiner"), "missing-token"),
    /not found/,
  );

  const expiredRuntime = new FakeRuntime();
  const expiredDuels = service(expiredRuntime);
  const expired = expiredDuels.createInvite(guest("creator"), "EASY");
  expiredRuntime.moveTo(
    new Date(expiredRuntime.now.getTime() + 600_000),
  );
  assert.throws(
    () => expiredDuels.joinInvite(guest("joiner"), expired.inviteToken),
    /expired/,
  );

  const usedRuntime = new FakeRuntime();
  const usedDuels = service(usedRuntime);
  const creator = guest("creator");
  const used = usedDuels.createInvite(creator, "EASY");
  assert.throws(
    () => usedDuels.join(guest("bypass"), used.duelId),
    /requires its invite link/,
  );
  assert.throws(
    () => usedDuels.joinInvite(creator, used.inviteToken),
    /second distinct player/,
  );
  usedDuels.joinInvite(guest("second"), used.inviteToken);
  assert.throws(
    () => usedDuels.joinInvite(registered("third"), used.inviteToken),
    /already been used/,
  );
  assert.equal(usedRuntime.activeTimerCount(), 1);
});

test("direct Duel streams five authoritative rounds and one final result", async () => {
  const runtime = new FakeRuntime();
  const duels = service(runtime);
  const first = guest("player-1");
  const second = guest("player-2");
  const firstEvents: DirectDuelEvent[] = [];
  const secondEvents: DirectDuelEvent[] = [];
  const created = duels.create(first, "EASY");
  duels.subscribe(created.duelId, first, (event) => firstEvents.push(event));
  const joined = duels.join(second, created.duelId);
  duels.subscribe(created.duelId, second, (event) => secondEvents.push(event));

  const firstRound = firstEvents.find(
    (event) => event.type === "round_started",
  )?.round;
  const secondRound = secondEvents.find(
    (event) => event.type === "round_started",
  )?.round;
  assert.ok(firstRound);
  assert.deepEqual(firstRound, joined.round);
  assert.deepEqual(secondRound, firstRound);
  assert.equal(firstRound.target, 1_000);
  assert.equal(
    new Date(firstRound.endsAt).getTime() -
      new Date(firstRound.startedAt).getTime(),
    120_000,
  );
  assert.throws(() => duels.join(guest("player-3"), created.duelId), /full/);

  runtime.fireRoundDeadline(firstRound);
  assert.equal(
    firstEvents.filter((event) => event.type === "timeout_submission_requested")
      .length,
    1,
  );
  assert.equal(
    secondEvents.filter((event) => event.type === "timeout_submission_requested")
      .length,
    1,
  );

  await duels.submit(
    created.duelId,
    first,
    1,
    "TIMEOUT",
    [shape(1_000)],
    population,
  );
  assert.equal(
    secondEvents.filter((event) => event.type === "opponent_submitted").length,
    1,
  );
  assert.equal(
    firstEvents.filter((event) => event.type === "round_resolved").length,
    0,
  );

  await duels.submit(
    created.duelId,
    second,
    1,
    "TIMEOUT",
    [shape(0)],
    population,
  );
  const eventCountBeforeDuplicate = firstEvents.length + secondEvents.length;
  const duplicate = await duels.submit(
    created.duelId,
    first,
    1,
    "TIMEOUT",
    [shape(0)],
    population,
  );
  assert.equal(duplicate.status, "DUPLICATE");
  assert.equal(firstEvents.length + secondEvents.length, eventCountBeforeDuplicate);
  assert.equal(
    firstEvents.filter((event) => event.type === "round_started").length,
    1,
  );
  assert.equal(
    firstEvents.filter((event) => event.type === "result_phase_started").length,
    0,
  );
  const firstAnimationComplete = duels.completeResultAnimation(
    created.duelId,
    first,
    1,
  );
  assert.equal(firstAnimationComplete.resultWaitStarted, false);
  assert.equal(
    firstEvents.filter((event) => event.type === "result_phase_started").length,
    0,
  );
  const secondAnimationComplete = duels.completeResultAnimation(
    created.duelId,
    second,
    1,
  );
  assert.equal(secondAnimationComplete.resultWaitStarted, true);
  const firstResultPhase = [...firstEvents]
    .reverse()
    .find((event) => event.type === "result_phase_started")?.resultPhase;
  assert.ok(firstResultPhase);
  assert.equal(
    new Date(firstResultPhase.endsAt).getTime() -
      new Date(firstResultPhase.startedAt).getTime(),
    10_000,
  );
  runtime.fireNextTimerAt(firstResultPhase.endsAt);

  for (let roundNumber = 2; roundNumber <= 5; roundNumber += 1) {
    const currentRound = [...firstEvents]
      .reverse()
      .find((event) => event.type === "round_started")?.round;
    assert.equal(currentRound?.roundNumber, roundNumber);
    runtime.moveTo(new Date(new Date(currentRound.startedAt).getTime() + 1_000));

    await duels.submit(
      created.duelId,
      first,
      roundNumber,
      "MANUAL",
      [shape(1_000)],
      population,
    );
    await duels.submit(
      created.duelId,
      second,
      roundNumber,
      "MANUAL",
      [shape(0)],
      population,
    );

    if (roundNumber < 5) {
      duels.completeResultAnimation(
        created.duelId,
        first,
        roundNumber,
      );
      duels.completeResultAnimation(
        created.duelId,
        second,
        roundNumber,
      );
      const resultPhase = [...firstEvents]
        .reverse()
        .find(
          (event) =>
            event.type === "result_phase_started" &&
            event.roundNumber === roundNumber,
        )?.resultPhase;
      assert.ok(resultPhase);
      runtime.fireNextTimerAt(resultPhase.endsAt);
    }
  }

  assert.equal(
    firstEvents.filter((event) => event.type === "round_started").length,
    5,
  );
  assert.equal(
    firstEvents.filter((event) => event.type === "round_resolved").length,
    5,
  );
  assert.equal(
    secondEvents.filter((event) => event.type === "round_started").length,
    5,
  );
  assert.equal(
    secondEvents.filter((event) => event.type === "round_resolved").length,
    5,
  );
  const firstComplete = firstEvents.find(
    (event) => event.type === "game_completed",
  );
  const secondComplete = secondEvents.find(
    (event) => event.type === "game_completed",
  );
  assert.equal(firstComplete?.outcome, "WIN");
  assert.equal(firstComplete?.totalScore, 50_000);
  assert.equal(secondComplete?.outcome, "LOSS");
  assert.equal(secondComplete?.totalScore, 0);
});

test("manual submission broadcasts one authoritative 10-second deadline cap", async () => {
  const runtime = new FakeRuntime();
  const duels = service(runtime);
  const first = guest("player-1");
  const second = guest("player-2");
  const firstEvents: DirectDuelEvent[] = [];
  const secondEvents: DirectDuelEvent[] = [];
  const { duelId } = duels.create(first, "EASY");
  duels.subscribe(duelId, first, (event) => firstEvents.push(event));
  duels.join(second, duelId);
  duels.subscribe(duelId, second, (event) => secondEvents.push(event));
  const round = firstEvents.find(
    (event) => event.type === "round_started",
  )?.round;
  assert.ok(round);
  runtime.moveTo(new Date(new Date(round.startedAt).getTime() + 20_000));

  await duels.submit(
    duelId,
    first,
    1,
    "MANUAL",
    [shape(1_000)],
    population,
  );
  const firstDeadlineEvent = firstEvents.find(
    (event) => event.type === "round_deadline_updated",
  );
  const secondDeadlineEvent = secondEvents.find(
    (event) => event.type === "round_deadline_updated",
  );
  assert.ok(firstDeadlineEvent?.round);
  assert.deepEqual(secondDeadlineEvent?.round, firstDeadlineEvent.round);
  assert.equal(
    new Date(firstDeadlineEvent.round.endsAt).getTime(),
    runtime.now.getTime() + 10_000,
  );

  await duels.submit(
    duelId,
    first,
    1,
    "MANUAL",
    [shape(0)],
    population,
  );
  assert.equal(
    firstEvents.filter((event) => event.type === "round_deadline_updated")
      .length,
    1,
  );
});

test("ready actions wait for both players and reject stale rounds", async () => {
  const runtime = new FakeRuntime();
  const duels = service(runtime);
  const first = guest("player-1");
  const second = guest("player-2");
  const events: DirectDuelEvent[] = [];
  const { duelId } = duels.create(first, "EASY");
  duels.subscribe(duelId, first, (event) => events.push(event));
  duels.join(second, duelId);
  duels.subscribe(duelId, second, () => undefined);
  runtime.moveTo("2026-01-01T00:00:01.000Z");
  await duels.submit(
    duelId,
    first,
    1,
    "MANUAL",
    [shape(1_000)],
    population,
  );
  await duels.submit(
    duelId,
    second,
    1,
    "MANUAL",
    [shape(1_000)],
    population,
  );

  assert.throws(
    () => duels.readyForNextRound(duelId, first, 1),
    /result wait has not started/,
  );
  const firstAnimation = duels.completeResultAnimation(duelId, first, 1);
  const duplicateAnimation = duels.completeResultAnimation(duelId, first, 1);
  assert.equal(firstAnimation.status, "APPLIED");
  assert.equal(duplicateAnimation.status, "DUPLICATE");
  assert.equal(duplicateAnimation.resultWaitStarted, false);
  duels.completeResultAnimation(duelId, second, 1);

  const firstReady = duels.readyForNextRound(duelId, first, 1);
  assert.equal(firstReady.roundAdvanced, false);
  assert.equal(
    events.filter(
      (event) =>
        event.type === "round_started" && event.round?.roundNumber === 2,
    ).length,
    0,
  );

  const readyEventCount = events.filter(
    (event) => event.type === "player_ready",
  ).length;
  const duplicate = duels.readyForNextRound(duelId, first, 1);
  assert.equal(duplicate.status, "DUPLICATE");
  assert.equal(
    events.filter((event) => event.type === "player_ready").length,
    readyEventCount,
  );

  const secondReady = duels.readyForNextRound(duelId, second, 1);
  assert.equal(secondReady.roundAdvanced, true);
  assert.equal(
    events.filter(
      (event) =>
        event.type === "round_started" && event.round?.roundNumber === 2,
    ).length,
    1,
  );
  assert.throws(
    () => duels.readyForNextRound(duelId, first, 1),
    /result phase is not active/,
  );
  const staleAnimation = duels.completeResultAnimation(duelId, first, 1);
  assert.equal(staleAnimation.status, "STALE");
  assert.equal(staleAnimation.resultWaitStarted, false);
});

test("active-round abandon sends one terminal LOSS/WIN result", async () => {
  const runtime = new FakeRuntime();
  const duels = service(runtime);
  const first = guest("player-1");
  const second = guest("player-2");
  const firstEvents: DirectDuelEvent[] = [];
  const secondEvents: DirectDuelEvent[] = [];
  const { duelId } = duels.create(first, "EASY");
  duels.subscribe(duelId, first, (event) => firstEvents.push(event));
  duels.join(second, duelId);
  duels.subscribe(duelId, second, (event) => secondEvents.push(event));

  const abandoned = await duels.abandon(duelId, first);
  const eventCount = firstEvents.length + secondEvents.length;
  const duplicate = await duels.abandon(duelId, first);
  const firstCompletion = firstEvents.find(
    (event) => event.type === "game_completed",
  );
  const secondCompletion = secondEvents.find(
    (event) => event.type === "game_completed",
  );
  const opponentAbandoned = secondEvents.find(
    (event) => event.type === "opponent_abandoned",
  );

  assert.equal(abandoned.status, "APPLIED");
  assert.equal(duplicate.status, "DUPLICATE");
  assert.equal(firstEvents.length + secondEvents.length, eventCount);
  assert.equal(firstCompletion?.outcome, "LOSS");
  assert.equal(secondCompletion?.outcome, "WIN");
  assert.equal(firstCompletion?.completionReason, "ABANDON");
  assert.equal(secondCompletion?.completionReason, "ABANDON");
  assert.equal(
    opponentAbandoned?.abandonedRuntimePlayerId,
    first.runtimePlayerId,
  );
  assert.equal(firstCompletion?.totalScore, 0);
  assert.equal(secondCompletion?.totalScore, 0);
  assert.equal(runtime.activeTimerCount(), 0);

  await assert.rejects(
    () =>
      duels.submit(
        duelId,
        second,
        1,
        "MANUAL",
        [shape(1_000)],
        population,
      ),
    /round is not active/,
  );
  assert.throws(
    () => duels.readyForNextRound(duelId, second, 1),
    /result phase is not active/,
  );
  assert.equal(
    duels.completeResultAnimation(duelId, second, 1).status,
    "STALE",
  );
  assert.equal(
    firstEvents.filter((event) => event.type === "round_started").length,
    1,
  );
});

test("abandon during result animation is terminal without starting result wait", async () => {
  const runtime = new FakeRuntime();
  const duels = service(runtime);
  const first = guest("player-1");
  const second = guest("player-2");
  const events: DirectDuelEvent[] = [];
  const { duelId } = duels.create(first, "EASY");
  duels.subscribe(duelId, first, (event) => events.push(event));
  duels.join(second, duelId);
  duels.subscribe(duelId, second, () => undefined);
  runtime.moveTo("2026-01-01T00:00:01.000Z");
  await duels.submit(
    duelId,
    first,
    1,
    "MANUAL",
    [shape(1_000)],
    population,
  );
  await duels.submit(
    duelId,
    second,
    1,
    "MANUAL",
    [shape(1_000)],
    population,
  );

  const abandoned = await duels.abandon(duelId, first);

  assert.equal(abandoned.status, "APPLIED");
  assert.equal(
    events.filter((event) => event.type === "result_phase_started").length,
    0,
  );
  assert.equal(
    duels.completeResultAnimation(duelId, second, 1).status,
    "STALE",
  );
  assert.equal(runtime.activeTimerCount(), 0);
  assert.equal(
    events.filter((event) => event.type === "round_started").length,
    1,
  );
});

test("abandon during result waiting cancels auto-advance", async () => {
  const runtime = new FakeRuntime();
  const duels = service(runtime);
  const first = guest("player-1");
  const second = guest("player-2");
  const events: DirectDuelEvent[] = [];
  const { duelId } = duels.create(first, "EASY");
  duels.subscribe(duelId, first, (event) => events.push(event));
  duels.join(second, duelId);
  duels.subscribe(duelId, second, () => undefined);
  runtime.moveTo("2026-01-01T00:00:01.000Z");
  await duels.submit(
    duelId,
    first,
    1,
    "MANUAL",
    [shape(1_000)],
    population,
  );
  await duels.submit(
    duelId,
    second,
    1,
    "MANUAL",
    [shape(1_000)],
    population,
  );
  duels.completeResultAnimation(duelId, first, 1);
  duels.completeResultAnimation(duelId, second, 1);
  assert.equal(runtime.activeTimerCount(), 1);

  const abandoned = await duels.abandon(duelId, second);

  assert.equal(abandoned.status, "APPLIED");
  assert.equal(runtime.activeTimerCount(), 0);
  assert.throws(
    () => duels.readyForNextRound(duelId, first, 1),
    /result phase is not active/,
  );
  assert.equal(
    events.filter((event) => event.type === "round_started").length,
    1,
  );
});

test("equal five-round totals deliver DRAW to both clients", async () => {
  const runtime = new FakeRuntime();
  const duels = service(runtime);
  const first = guest("player-1");
  const second = guest("player-2");
  const firstEvents: DirectDuelEvent[] = [];
  const secondEvents: DirectDuelEvent[] = [];
  const { duelId } = duels.create(first, "EASY");
  duels.subscribe(duelId, first, (event) => firstEvents.push(event));
  duels.join(second, duelId);
  duels.subscribe(duelId, second, (event) => secondEvents.push(event));

  for (let roundNumber = 1; roundNumber <= 5; roundNumber += 1) {
    const currentRound = [...firstEvents]
      .reverse()
      .find((event) => event.type === "round_started")?.round;
    assert.equal(currentRound?.roundNumber, roundNumber);
    runtime.moveTo(new Date(new Date(currentRound.startedAt).getTime() + 1_000));
    await duels.submit(
      duelId,
      first,
      roundNumber,
      "MANUAL",
      [shape(1_000)],
      population,
    );
    await duels.submit(
      duelId,
      second,
      roundNumber,
      "MANUAL",
      [shape(1_000)],
      population,
    );
    if (roundNumber < 5) {
      duels.completeResultAnimation(duelId, first, roundNumber);
      duels.completeResultAnimation(duelId, second, roundNumber);
      duels.readyForNextRound(duelId, first, roundNumber);
      duels.readyForNextRound(duelId, second, roundNumber);
    }
  }

  assert.equal(
    firstEvents.find((event) => event.type === "game_completed")?.outcome,
    "DRAW",
  );
  assert.equal(
    secondEvents.find((event) => event.type === "game_completed")?.outcome,
    "DRAW",
  );
});
