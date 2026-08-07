import { describe, expect, it } from "vitest";
import type { Assignment, AssignmentPlan, BaseLayout, RotationWindow, ScheduleState } from "../types";
import { aggregateResourceLedgers, createResourceLedger, scaleResourceLedger } from "./resourceLedger";
import { evaluatePlanSustainability } from "./planSustainabilityEvaluator";

const twoShiftSchedule: ScheduleState = {
  cycleHours: 24,
  groups: [{ id: "A" }, { id: "B" }],
  shifts: [
    { id: "day", startHour: 0, endHour: 12, activeGroupIds: ["A"], recoveryGroupIds: ["B"] },
    { id: "night", startHour: 12, endHour: 24, activeGroupIds: ["B"], recoveryGroupIds: ["A"] }
  ]
};

const threeShiftSchedule: ScheduleState = {
  cycleHours: 24,
  groups: [{ id: "A" }, { id: "B" }, { id: "C" }],
  shifts: [
    { id: "first", startHour: 0, endHour: 8, activeGroupIds: ["A"], recoveryGroupIds: [] },
    { id: "middle", startHour: 8, endHour: 16, activeGroupIds: ["B"], recoveryGroupIds: [] },
    { id: "last", startHour: 16, endHour: 24, activeGroupIds: ["C"], recoveryGroupIds: [] }
  ]
};

function assignment(operatorId: string, facilityId = "factory-1", overrides: Partial<Assignment> = {}): Assignment {
  return {
    facilityId,
    operatorId,
    skillId: `${operatorId}-skill`,
    score: 1,
    efficiency: 0,
    fatigueHours: 24,
    recoveryHours: 3,
    moraleConsumptionPerHour: 1,
    dormitoryRecoveryPerHour: 4,
    recoveryProvenance: {
      baseRecoveryRatePerHour: 4,
      conditionalModifiers: [],
      sources: []
    },
    reason: "synthetic sustainability fixture",
    ...overrides
  };
}

function rotationFor(
  schedule: ScheduleState,
  assignmentsByShift: readonly (readonly Assignment[])[],
  incompleteByShift: readonly string[][] = schedule.shifts.map(() => [])
): RotationWindow[] {
  return schedule.shifts.map((shift, index) => {
    const assignments = [...assignmentsByShift[index]];
    for (const facilityId of ["factory-1", "trading-1", "power-1"]) {
      if (!assignments.some((assignment) => assignment.facilityId === facilityId)) {
        assignments.push(assignment(`resource-${shift.id}-${facilityId}`, facilityId, {
          moraleConsumptionPerHour: 0,
          fatigueHours: Number.POSITIVE_INFINITY,
          recoveryHours: 0
        }));
      }
    }
    return {
    label: shift.id,
    hours: shift.endHour - shift.startHour,
    shiftId: shift.id,
    startHour: shift.startHour,
    endHour: shift.endHour,
    activeGroupIds: [...shift.activeGroupIds],
    recoveryGroupIds: [...shift.recoveryGroupIds],
    incompleteGroupIds: [...incompleteByShift[index]],
    assignments,
    recovery: []
    };
  });
}

function completeResources(schedule: ScheduleState) {
  const windows = schedule.shifts.map((shift, index) => ({
    shiftId: shift.id,
    startHour: shift.startHour,
    endHour: shift.endHour,
    durationHours: shift.endHour - shift.startHour,
    activeGroupIds: shift.activeGroupIds,
    facilities: [{
      facilityId: "factory-1",
      facilityType: "factory" as const,
      product: "gold" as const,
      operatorIds: [`worker-${index}`],
      additiveEfficiency: 0,
      ledger: createResourceLedger({ natural: { goldProduced: index === 0 ? 0 : 2 * (shift.endHour - shift.startHour) } })
    }, {
      facilityId: "trading-1",
      facilityType: "trading" as const,
      product: "lmd" as const,
      operatorIds: [`resource-${shift.id}-trading-1`],
      additiveEfficiency: 0,
      ledger: createResourceLedger()
    }]
  }));
  const natural = aggregateResourceLedgers(windows.flatMap((window) => window.facilities.map((facility) => facility.ledger)));
  const dronePer24 = createResourceLedger({ drone: { goldConsumed: 2, lmd: 1000 }, dronesGenerated: 10, dronesUsed: 10 });
  const droneCycle = scaleResourceLedger(dronePer24, schedule.cycleHours / 24);
  return {
    status: "complete" as const,
    assumptions: {
      facilityProductionCalculator: "simulateFacilityProduction" as const,
      droneCalculator: "simulateTradingPostDrones24h" as const,
      facilityLevel: 3 as const,
      storage: "unbounded-no-plan-state" as const,
      teamEfficiencyProvenance: "optimizer-evaluated-facility-efficiency-for-selected-schedule-group" as const,
      initialDrones: 0 as const,
      droneAllocationPolicy: "all-completed-to-highest-marginal-normal-order-gain-facility-id-tiebreak" as const,
      allocationTimingAssumption: "slot-batch-consumption" as const,
      capOverflowAccounting: "before-slot-allocation" as const,
      scheduleFeasibility: "evaluated-at-slot-boundaries" as const,
      normalization: "cycle-ledger-scaled-linearly-to-24-hours" as const
    },
    windows,
    missing: [],
    drone: {
      targetFacilityId: "trading-1",
      dronesAllocated: 10,
      per24Ledger: dronePer24,
      semantics: {
        allocationTimingAssumption: "slot-batch-consumption" as const,
        capOverflowAccounting: "before-slot-allocation" as const,
        scheduleFeasibility: "evaluated-at-slot-boundaries" as const
      }
    },
    cycleLedger: aggregateResourceLedgers([natural, droneCycle]),
    per24Ledger: scaleResourceLedger(aggregateResourceLedgers([natural, droneCycle]), 24 / schedule.cycleHours)
  };
}

function planFor(
  schedule: ScheduleState,
  assignmentsByShift: readonly (readonly Assignment[])[],
  overrides: Partial<AssignmentPlan> = {}
): AssignmentPlan {
  return {
    generatedAt: "2026-08-04T00:00:00.000Z",
    totalScore: 0,
    dailyValue: 0,
    facilityPlans: [],
    schedule,
    rotation: rotationFor(schedule, assignmentsByShift),
    diagnostics: [],
    resources: completeResources(schedule),
    sustainability: { status: "incomplete", missing: [], assumptions: undefined as never },
    warnings: [],
    ...overrides
  };
}

function evaluate(plan: AssignmentPlan, layout: BaseLayout = "243") {
  return evaluatePlanSustainability({ plan, layout });
}

describe("assignment plan sustainability adapter", () => {
  it("builds exact canonical shifts and aggregates each natural window plus proportional drones exactly once", () => {
    const plan = planFor(twoShiftSchedule, [[assignment("worker-a")], [assignment("worker-b")]]);
    const before = structuredClone(plan);

    const first = evaluate(plan);
    const second = evaluate(plan);

    expect(first.status).toBe("evaluated");
    expect(first).toEqual(second);
    expect(plan).toEqual(before);
    if (first.status !== "evaluated") return;
    expect(first.input.shifts.map((shift) => ({
      id: shift.id,
      startHour: shift.startHour,
      endHour: shift.endHour,
      groupIds: shift.groupIds,
      operators: shift.assignments.filter((item) => !item.operatorId.startsWith("resource-")).map((item) => item.operatorId)
    }))).toEqual([
      { id: "day", startHour: 0, endHour: 12, groupIds: ["A"], operators: ["worker-a"] },
      { id: "night", startHour: 12, endHour: 24, groupIds: ["B"], operators: ["worker-b"] }
    ]);
    expect(aggregateResourceLedgers(first.input.shifts.flatMap((shift) =>
      shift.resourceContributions.map((contribution) => contribution.ledger)
    ))).toEqual(plan.resources.cycleLedger);
    expect(first.assumptions).toMatchObject({
      startingGold: 0,
      droneDistributionPolicy: "duration-proportional-from-strict-slot-batch-plan-ledger",
      baseContext: "max-level-243-verified-4x5-dormitories"
    });
    expect(first.convergence.iterations).toBeGreaterThan(0);
    expect(first.result.gold.starting).toBe(0);
    expect(first.result.failures).toContainEqual(expect.objectContaining({ code: "gold-prefix-underflow" }));
  });

  it("returns stable incomplete reasons without a sustainable boolean", () => {
    const worker = assignment("worker");
    const incompleteResources = {
      ...completeResources(twoShiftSchedule),
      status: "incomplete" as const,
      cycleLedger: undefined,
      per24Ledger: undefined,
      missing: [{ code: "schedule-group-unpopulated" as const, path: "rotation/night/groups/B", message: "B missing" }]
    };
    const plan = planFor(twoShiftSchedule, [[worker], []], {
      resources: incompleteResources,
      rotation: rotationFor(twoShiftSchedule, [[worker], []], [[], ["B"]])
    });

    const result = evaluate(plan);

    expect(result.status).toBe("incomplete");
    expect(result).not.toHaveProperty("sustainable");
    expect(result).not.toHaveProperty("result");
    expect(result.missing).toContainEqual({
      code: "plan-resources-incomplete",
      path: "resources/rotation/night/groups/B",
      message: "B missing",
      shiftId: "night",
      groupId: "B"
    });
  });

  it("does not fabricate missing recovery provenance or treat non-slot prerequisites as workers", () => {
    const missing = assignment("missing", "factory-1", { recoveryProvenance: undefined });
    const prerequisite = assignment("prerequisite", "base", { doesNotConsumeFacilitySlot: true, recoveryProvenance: undefined });
    const plan = planFor(twoShiftSchedule, [[missing, prerequisite], [assignment("other")]]);

    const result = evaluate(plan);

    expect(result.status).toBe("incomplete");
    expect(result.missing).toContainEqual(expect.objectContaining({
      code: "recovery-provenance-unavailable",
      path: "rotation/day/assignments/missing/recoveryProvenance",
      operatorId: "missing",
      shiftId: "day"
    }));
    expect(result.missing).not.toContainEqual(expect.objectContaining({ operatorId: "prerequisite" }));
  });

  it("uses all windows for a complete JP 36h A+B/B+C/C+A schedule and CN 24h three-shift schedule", () => {
    const jpSchedule: ScheduleState = {
      cycleHours: 36,
      groups: [{ id: "A" }, { id: "B" }, { id: "C" }],
      shifts: [
        { id: "ab", startHour: 0, endHour: 12, activeGroupIds: ["A", "B"], recoveryGroupIds: ["C"] },
        { id: "bc", startHour: 12, endHour: 24, activeGroupIds: ["B", "C"], recoveryGroupIds: ["A"] },
        { id: "ca", startHour: 24, endHour: 36, activeGroupIds: ["C", "A"], recoveryGroupIds: ["B"] }
      ]
    };
    const cnSchedule: ScheduleState = {
      cycleHours: 24,
      groups: [{ id: "A" }, { id: "B" }, { id: "C" }],
      shifts: [
        { id: "one", startHour: 0, endHour: 8, activeGroupIds: ["A"], recoveryGroupIds: [] },
        { id: "two", startHour: 8, endHour: 16, activeGroupIds: ["B"], recoveryGroupIds: [] },
        { id: "three", startHour: 16, endHour: 24, activeGroupIds: ["C"], recoveryGroupIds: [] }
      ]
    };

    for (const [schedule, shifts] of [
      [jpSchedule, [[assignment("a")], [assignment("b")], [assignment("c")]]],
      [cnSchedule, [[assignment("a")], [assignment("b")], [assignment("c")]]]
    ] as const) {
      const result = evaluate(planFor(schedule, shifts));
      expect(result.status).toBe("evaluated");
      if (result.status === "evaluated") {
        expect(result.input.shifts.map((shift) => shift.id)).toEqual(schedule.shifts.map((shift) => shift.id));
        expect(result.input.shifts).toHaveLength(3);
      }
    }
  });

  it("preserves threshold recovery and full-morale exchange provenance in packed dormitory events", () => {
    const thresholdWorker = assignment("threshold-worker", "factory-1", {
      recoveryHours: 4,
      recoveryProvenance: {
        baseRecoveryRatePerHour: 0.25,
        conditionalModifiers: [{ moraleAtMost: 20, additionalRatePerHour: 0.75, sourceOperatorIds: ["perfumer"] }],
        sources: [{
          operatorId: "perfumer", role: "recovery-source", allocation: "room-shareable",
          occupiesDormitorySlot: true, ownedAtEvaluation: true
        }]
      }
    });
    const exchangeTarget = assignment("exchange-target", "factory-1", {
      recoveryHours: 0,
      moraleExchangeApplied: true,
      moraleExchangeSourceOperatorId: "fiammetta",
      recoveryProvenance: {
        baseRecoveryRatePerHour: 4,
        conditionalModifiers: [],
        sources: [{
          operatorId: "fiammetta", role: "recovery-source", allocation: "exchange",
          occupiesDormitorySlot: true, ownedAtEvaluation: true
        }]
      }
    });
    const plan = planFor(twoShiftSchedule, [
      [thresholdWorker, exchangeTarget],
      [assignment("other-a"), assignment("other-b")]
    ]);

    const result = evaluate(plan);

    expect(result.status).toBe("evaluated");
    if (result.status !== "evaluated") return;
    expect(result.input.recoveryPlacements).toEqual(expect.arrayContaining([
      expect.objectContaining({
        operatorId: "threshold-worker",
        conditionalModifiers: [{ moraleAtMost: 20, additionalRatePerHour: 0.75 }]
      }),
      expect.objectContaining({ operatorId: "perfumer", dormitoryId: expect.stringMatching(/^dormitory-[1-4]$/) }),
      expect.objectContaining({
        operatorId: "exchange-target",
        moraleExchange: { atHour: 12, sourceOperatorId: "fiammetta" }
      }),
      expect.objectContaining({ operatorId: "fiammetta", dormitoryId: expect.stringMatching(/^dormitory-[1-4]$/) })
    ]));
    expect(result.result.operators.find((operator) => operator.operatorId === "threshold-worker")?.timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ mode: "recovery", ratePerHour: 1 }),
        expect.objectContaining({ mode: "recovery", ratePerHour: 0.25 })
      ])
    );
    expect(result.result.exchanges).toContainEqual(expect.objectContaining({
      sourceOperatorId: "fiammetta",
      targetOperatorId: "exchange-target",
      hour: 12
    }));
  });

  it("applies one exchange at the first cyclic idle segment after middle-shift work", () => {
    const exchangeTarget = assignment("exchange-target", "factory-1", {
      recoveryHours: 0,
      moraleExchangeApplied: true,
      moraleExchangeSourceOperatorId: "fiammetta",
      recoveryProvenance: {
        baseRecoveryRatePerHour: 4,
        conditionalModifiers: [],
        sources: [{
          operatorId: "fiammetta", role: "recovery-source", allocation: "exchange",
          occupiesDormitorySlot: true, ownedAtEvaluation: true
        }]
      }
    });
    const result = evaluate(planFor(threeShiftSchedule, [
      [assignment("first-worker")],
      [exchangeTarget],
      [assignment("last-worker")]
    ]));

    expect(result.status).toBe("evaluated");
    if (result.status !== "evaluated") return;
    expect(result.input.recoveryPlacements.filter((placement) =>
      placement.operatorId === "exchange-target" && placement.moraleExchange
    ).map((placement) => placement.moraleExchange)).toEqual([
      { atHour: 16, sourceOperatorId: "fiammetta" }
    ]);
    expect(result.input.recoveryPlacements.filter((placement) =>
      placement.operatorId === "fiammetta" &&
      [[0, 8], [16, 24]].some(([start, end]) => placement.startHour === start && placement.endHour === end)
    )).toHaveLength(2);
    expect(result.result.exchanges.filter((exchange) => exchange.targetOperatorId === "exchange-target")).toEqual([
      expect.objectContaining({ hour: 16, sourceOperatorId: "fiammetta" })
    ]);
  });

  it("applies the exchange at hour zero when work ends at the cycle boundary", () => {
    const exchangeTarget = assignment("exchange-target", "factory-1", {
      recoveryHours: 0,
      moraleExchangeApplied: true,
      moraleExchangeSourceOperatorId: "fiammetta",
      recoveryProvenance: {
        baseRecoveryRatePerHour: 4,
        conditionalModifiers: [],
        sources: [{
          operatorId: "fiammetta", role: "recovery-source", allocation: "exchange",
          occupiesDormitorySlot: true, ownedAtEvaluation: true
        }]
      }
    });
    const result = evaluate(planFor(threeShiftSchedule, [
      [assignment("first-worker")],
      [assignment("middle-worker")],
      [exchangeTarget]
    ]));

    expect(result.status).toBe("evaluated");
    if (result.status !== "evaluated") return;
    expect(result.input.recoveryPlacements.filter((placement) =>
      placement.operatorId === "exchange-target" && placement.moraleExchange
    ).map((placement) => placement.moraleExchange)).toEqual([
      { atHour: 0, sourceOperatorId: "fiammetta" }
    ]);
    expect(result.result.exchanges.filter((exchange) => exchange.targetOperatorId === "exchange-target")).toEqual([
      expect.objectContaining({ hour: 0, sourceOperatorId: "fiammetta" })
    ]);
  });

  it("co-locates unequal recovery intervals with one shared room helper placement", () => {
    const roomSource = {
      operatorId: "room-helper",
      role: "recovery-source" as const,
      allocation: "room-shareable" as const,
      occupiesDormitorySlot: true,
      ownedAtEvaluation: true
    };
    const short = assignment("short", "factory-1", {
      recoveryProvenance: { baseRecoveryRatePerHour: 4, conditionalModifiers: [], sources: [roomSource] }
    });
    const long = assignment("long", "factory-1", {
      recoveryProvenance: { baseRecoveryRatePerHour: 2, conditionalModifiers: [], sources: [roomSource] }
    });

    const result = evaluate(planFor(twoShiftSchedule, [[short, long], []]));

    expect(result.status).toBe("evaluated");
    if (result.status !== "evaluated") return;
    const recoveries = result.input.recoveryPlacements.filter((placement) => ["short", "long"].includes(placement.operatorId));
    const helpers = result.input.recoveryPlacements.filter((placement) => placement.operatorId === "room-helper");
    expect(new Set(recoveries.map((placement) => placement.dormitoryId))).toEqual(new Set(["dormitory-1"]));
    expect(helpers).toEqual([
      expect.objectContaining({ dormitoryId: "dormitory-1", startHour: 12, endHour: 18 })
    ]);
    expect(result.result.failures).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "overlapping-recovery", operatorId: "room-helper" }),
      expect.objectContaining({ code: "dormitory-overflow" })
    ]));
  });

  it("coalesces a shared helper that is also recovering into one placement", () => {
    const recoveringHelper = {
      operatorId: "recovering-helper",
      role: "recovery-source" as const,
      allocation: "room-shareable" as const,
      occupiesDormitorySlot: true,
      ownedAtEvaluation: true
    };
    const dependent = assignment("dependent", "factory-1", {
      recoveryProvenance: { baseRecoveryRatePerHour: 4.2, conditionalModifiers: [], sources: [recoveringHelper] }
    });
    const helper = assignment("recovering-helper");

    const result = evaluate(planFor(twoShiftSchedule, [[dependent, helper], []]));

    expect(result.status).toBe("evaluated");
    if (result.status !== "evaluated") return;
    expect(result.input.recoveryPlacements.filter((placement) => placement.operatorId === "recovering-helper")).toHaveLength(1);
    expect(result.result.failures).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "overlapping-recovery", operatorId: "recovering-helper" })
    ]));
  });

  it("uses interval-aware first-fit at the five-slot boundary instead of rotating into an overlap", () => {
    const workers = [
      ...Array.from({ length: 5 }, (_, index) => assignment(`duration-1-${index}`, "factory-1", {
        moraleConsumptionPerHour: 1 / 3,
        recoveryProvenance: { baseRecoveryRatePerHour: 4, conditionalModifiers: [], sources: [] }
      })),
      ...Array.from({ length: 5 }, (_, index) => assignment(`duration-2-${index}`, "factory-1", {
        moraleConsumptionPerHour: 2 / 3,
        recoveryProvenance: { baseRecoveryRatePerHour: 4, conditionalModifiers: [], sources: [] }
      })),
      ...Array.from({ length: 5 }, (_, index) => assignment(`duration-3-${index}`, "factory-1", {
        moraleConsumptionPerHour: 1,
        recoveryProvenance: { baseRecoveryRatePerHour: 4, conditionalModifiers: [], sources: [] }
      })),
      assignment("duration-4", "factory-1", {
        moraleConsumptionPerHour: 4 / 3,
        recoveryProvenance: { baseRecoveryRatePerHour: 4, conditionalModifiers: [], sources: [] }
      }),
      assignment("duration-5", "factory-1", {
        moraleConsumptionPerHour: 5 / 3,
        recoveryProvenance: { baseRecoveryRatePerHour: 4, conditionalModifiers: [], sources: [] }
      })
    ];

    const result = evaluate(planFor(twoShiftSchedule, [workers, []]));

    expect(result.status).toBe("evaluated");
    if (result.status !== "evaluated") return;
    expect(result.input.recoveryPlacements.find((placement) => placement.operatorId === "duration-4")?.dormitoryId).toBe("dormitory-4");
    expect(result.input.recoveryPlacements.find((placement) => placement.operatorId === "duration-5")?.dormitoryId).toBe("dormitory-4");
    expect(result.result.failures).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "dormitory-overflow" })
    ]));
  });

  it("returns typed incomplete when one single-other source would serve simultaneous targets", () => {
    const exclusiveSource = {
      operatorId: "exclusive-helper",
      role: "recovery-source" as const,
      allocation: "single-other-exclusive" as const,
      occupiesDormitorySlot: true,
      ownedAtEvaluation: true
    };
    const targets = ["target-a", "target-b"].map((operatorId) => assignment(operatorId, "factory-1", {
      recoveryProvenance: { baseRecoveryRatePerHour: 4.55, conditionalModifiers: [], sources: [exclusiveSource] }
    }));

    const result = evaluate(planFor(twoShiftSchedule, [targets, []]));

    expect(result).toMatchObject({
      status: "incomplete",
      missing: [expect.objectContaining({
        code: "recovery-allocation-unavailable",
        sourceOperatorId: "exclusive-helper"
      })]
    });
    expect(result).not.toHaveProperty("result");
    expect(result).not.toHaveProperty("sustainable");
  });

  it("shares one room source through exactly four targets but rejects a sixth simultaneous slot", () => {
    const roomSource = {
      operatorId: "room-helper",
      role: "recovery-source" as const,
      allocation: "room-shareable" as const,
      occupiesDormitorySlot: true,
      ownedAtEvaluation: true
    };
    const makeTargets = (count: number) => Array.from({ length: count }, (_, index) => assignment(`target-${index}`, "factory-1", {
      recoveryProvenance: { baseRecoveryRatePerHour: 4.2, conditionalModifiers: [], sources: [roomSource] }
    }));

    const boundary = evaluate(planFor(twoShiftSchedule, [makeTargets(4), []]));
    const overflow = evaluate(planFor(twoShiftSchedule, [makeTargets(5), []]));

    expect(boundary.status).toBe("evaluated");
    if (boundary.status === "evaluated") {
      expect(boundary.input.recoveryPlacements.filter((placement) => placement.dormitoryId === "dormitory-1")).toHaveLength(5);
      expect(boundary.input.recoveryPlacements.filter((placement) => placement.operatorId === "room-helper")).toHaveLength(1);
    }
    expect(overflow).toMatchObject({
      status: "incomplete",
      missing: [expect.objectContaining({
        code: "recovery-allocation-unavailable",
        sourceOperatorId: "room-helper"
      })]
    });
  });

  it("does not hide a recovery source that is simultaneously assigned to work", () => {
    const workingSource = {
      operatorId: "working-helper",
      role: "recovery-source" as const,
      allocation: "room-shareable" as const,
      occupiesDormitorySlot: true,
      ownedAtEvaluation: true
    };
    const target = assignment("target", "factory-1", {
      recoveryProvenance: { baseRecoveryRatePerHour: 4.2, conditionalModifiers: [], sources: [workingSource] }
    });
    const helperAtWork = assignment("working-helper", "factory-1");

    const result = evaluate(planFor(twoShiftSchedule, [[target], [helperAtWork]]));

    expect(result).toMatchObject({
      status: "incomplete",
      missing: [expect.objectContaining({
        code: "recovery-allocation-unavailable",
        operatorId: "target",
        sourceOperatorId: "working-helper"
      })]
    });
    expect(result).not.toHaveProperty("result");
    expect(result).not.toHaveProperty("sustainable");
  });

  it("lets the standalone authority expose assignment overlap and rejects unallocatable 4x5 recovery", () => {
    const duplicate = assignment("duplicate");
    const duplicatePlan = planFor(twoShiftSchedule, [[duplicate, { ...duplicate, facilityId: "factory-2" }], []]);
    const crowded = Array.from({ length: 21 }, (_, index) => assignment(`crowded-${String(index).padStart(2, "0")}`));
    const crowdedPlan = planFor(twoShiftSchedule, [crowded, []]);

    const duplicateResult = evaluate(duplicatePlan);
    const crowdedResult = evaluate(crowdedPlan);

    expect(duplicateResult.status).toBe("evaluated");
    expect(crowdedResult).toMatchObject({
      status: "incomplete",
      missing: [expect.objectContaining({ code: "recovery-allocation-unavailable" })]
    });
    if (duplicateResult.status === "evaluated") {
      expect(duplicateResult.result.failures).toContainEqual(expect.objectContaining({
        category: "overlap",
        code: "simultaneous-operator-occupancy",
        operatorId: "duplicate"
      }));
    }
    expect(crowdedResult).not.toHaveProperty("result");
    expect(crowdedResult).not.toHaveProperty("sustainable");
  });

  it("solves repeating morale phase instead of accepting a single non-fatiguing day from full morale", () => {
    const slowRecovery = assignment("worker", "factory-1", {
      recoveryHours: 12,
      recoveryProvenance: { baseRecoveryRatePerHour: 0.5, conditionalModifiers: [], sources: [] }
    });
    const plan = planFor(twoShiftSchedule, [[slowRecovery], []]);

    const result = evaluate(plan);

    expect(result.status).toBe("evaluated");
    if (result.status !== "evaluated") return;
    expect(result.convergence.iterations).toBeGreaterThan(1);
    expect(result.result.sustainable).toBe(false);
    expect(result.result.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "fatigued-before-shift-end", operatorId: "worker" })
    ]));
  });

  it("returns incomplete for unsupported layout and for an exchange with no source provenance", () => {
    const exchange = assignment("target", "factory-1", { moraleExchangeApplied: true, recoveryHours: 0 });

    expect(evaluate(planFor(twoShiftSchedule, [[assignment("a")], [assignment("b")]]), "153")).toMatchObject({
      status: "incomplete",
      missing: [expect.objectContaining({ code: "unsupported-layout", path: "layout" })]
    });
    expect(evaluate(planFor(twoShiftSchedule, [[exchange], [assignment("other")]]))).toMatchObject({
      status: "incomplete",
      missing: [expect.objectContaining({
        code: "morale-exchange-source-unavailable",
        path: "rotation/day/assignments/target/moraleExchangeSourceOperatorId",
        operatorId: "target"
      })]
    });
  });
});
