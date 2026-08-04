import { describe, expect, it } from "vitest";
import { createMaxLevel243BenchmarkContext } from "./benchmarkBaseContext";
import { createResourceLedger } from "./resourceLedger";
import {
  evaluateSustainableCycle,
  type SustainableCycleInput
} from "./sustainableCycleEvaluator";

const emptyLedger = () => createResourceLedger();
const goldLedger = (goldProduced: number, goldConsumed: number) =>
  createResourceLedger({ natural: { goldProduced, goldConsumed } });

function steadyInput(): SustainableCycleInput {
  return {
    shifts: [
      {
        id: "A",
        startHour: 0,
        endHour: 12,
        assignments: [{ facilityId: "factory-1", operatorId: "worker-a", moraleConsumptionPerHour: 1 }],
        resourceLedger: goldLedger(12, 10)
      },
      {
        id: "B",
        startHour: 12,
        endHour: 24,
        assignments: [{ facilityId: "factory-1", operatorId: "worker-b", moraleConsumptionPerHour: 1 }],
        resourceLedger: goldLedger(12, 10)
      }
    ],
    initialMorale: { "worker-a": 24, "worker-b": 12 },
    recoveryPlacements: [
      {
        dormitoryId: "dormitory-1",
        operatorId: "worker-b",
        startHour: 0,
        endHour: 12,
        recoveryRatePerHour: 1
      },
      {
        dormitoryId: "dormitory-1",
        operatorId: "worker-a",
        startHour: 12,
        endHour: 24,
        recoveryRatePerHour: 1
      }
    ],
    startingGold: 20,
    baseContext: createMaxLevel243BenchmarkContext()
  };
}

function emptyCycle(overrides: Partial<SustainableCycleInput> = {}): SustainableCycleInput {
  return {
    shifts: [
      { id: "A", startHour: 0, endHour: 12, assignments: [], resourceLedger: emptyLedger() },
      { id: "B", startHour: 12, endHour: 24, assignments: [], resourceLedger: emptyLedger() }
    ],
    initialMorale: {},
    recoveryPlacements: [],
    startingGold: 0,
    ...overrides
  };
}

describe("evaluateSustainableCycle", () => {
  it("accepts a deterministic steady repeating two-group cycle", () => {
    const result = evaluateSustainableCycle(steadyInput());

    expect(result.sustainable).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.aggregateLedger.goldProduced).toBe(24);
    expect(result.aggregateLedger.goldConsumed).toBe(20);
    expect(result.gold).toEqual({
      starting: 20,
      produced: 24,
      consumed: 20,
      netChange: 4,
      ending: 24,
      timeline: [
        { hour: 0, gold: 20 },
        { hour: 12, gold: 22 },
        { hour: 24, gold: 24 }
      ]
    });
    expect(result.operators.find((operator) => operator.operatorId === "worker-b")).toMatchObject({
      initialMorale: 12,
      finalMorale: 12,
      productiveHours: 12,
      uptime: 1
    });
  });

  it("rejects duplicate operators and duplicate assignment records within a shift", () => {
    const input = steadyInput();
    input.shifts[0].assignments.push(
      { facilityId: "factory-2", operatorId: "worker-a", moraleConsumptionPerHour: 1 },
      { facilityId: "factory-1", operatorId: "worker-a", moraleConsumptionPerHour: 1 }
    );

    const result = evaluateSustainableCycle(input);
    expect(result.sustainable).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "overlap", code: "duplicate-operator-in-shift" }),
      expect.objectContaining({ category: "overlap", code: "duplicate-assignment" })
    ]));
  });

  it("rejects a worker reused across the two work groups", () => {
    const input = steadyInput();
    input.recoveryPlacements = [];
    input.shifts[1].assignments[0] = {
      facilityId: "factory-1",
      operatorId: "worker-a",
      moraleConsumptionPerHour: 1
    };

    const result = evaluateSustainableCycle(input);
    expect(result.failures).toContainEqual(expect.objectContaining({
      category: "overlap",
      code: "cross-group-worker-reuse",
      operatorId: "worker-a"
    }));
  });

  it("rejects unknown facilities and facility slot overflow when context is supplied", () => {
    const input = steadyInput();
    input.shifts[0].assignments = [
      ...Array.from({ length: 4 }, (_, index) => ({
        facilityId: "factory-1",
        operatorId: `slot-${index}`,
        moraleConsumptionPerHour: 1
      })),
      { facilityId: "missing", operatorId: "unknown-worker", moraleConsumptionPerHour: 1 }
    ];
    Object.assign(input.initialMorale, {
      "slot-0": 24, "slot-1": 24, "slot-2": 24, "slot-3": 24, "unknown-worker": 24
    });

    const result = evaluateSustainableCycle(input);
    expect(result.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "overlap", code: "facility-slot-overflow" }),
      expect.objectContaining({ category: "overlap", code: "unknown-facility" })
    ]));
  });

  it("rejects dorm overflow and overlapping recovery placements for one operator", () => {
    const placements = Array.from({ length: 6 }, (_, index) => ({
      dormitoryId: "dormitory-1",
      operatorId: `rest-${index}`,
      startHour: 0,
      endHour: 12,
      recoveryRatePerHour: 1
    }));
    placements.push({ ...placements[0], dormitoryId: "dormitory-2", startHour: 6, endHour: 12 });
    const result = evaluateSustainableCycle(emptyCycle({
      initialMorale: Object.fromEntries(placements.map((placement) => [placement.operatorId, 12])),
      recoveryPlacements: placements,
      baseContext: createMaxLevel243BenchmarkContext()
    }));

    expect(result.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "dormitory", code: "dormitory-overflow" }),
      expect.objectContaining({ category: "dormitory", code: "overlapping-recovery" })
    ]));
  });

  it("reports partial uptime when morale reaches zero before a shift ends", () => {
    const input = emptyCycle({ initialMorale: { tired: 5 } });
    input.shifts[0].assignments.push({
      facilityId: "factory-1",
      operatorId: "tired",
      moraleConsumptionPerHour: 1
    });

    const result = evaluateSustainableCycle(input);
    expect(result.failures).toContainEqual(expect.objectContaining({ category: "morale", code: "fatigued-before-shift-end" }));
    expect(result.operators[0]).toMatchObject({ productiveHours: 5, uptime: 5 / 12, finalMorale: 0 });

    input.shifts[0].assignments[0].postZeroOutputModeled = true;
    const modeledResult = evaluateSustainableCycle(input);
    expect(modeledResult.failures).not.toContainEqual(
      expect.objectContaining({ code: "fatigued-before-shift-end" })
    );
    expect(modeledResult.operators[0]).toMatchObject({
      scheduledWorkHours: 12,
      productiveHours: 12,
      uptime: 1,
      finalMorale: 0
    });
    expect(modeledResult.operators[0].productiveHours).toBeLessThanOrEqual(
      modeledResult.operators[0].scheduledWorkHours
    );
    expect(modeledResult.operators[0].uptime).toBeLessThanOrEqual(1);
    expect(modeledResult.operators[0].timeline.slice(0, 2)).toEqual([
      expect.objectContaining({ startHour: 0, endHour: 5, startMorale: 5, endMorale: 0 }),
      expect.objectContaining({ startHour: 5, endHour: 12, startMorale: 0, endMorale: 0 })
    ]);
  });

  it("keeps productive hours and uptime within their general bounds", () => {
    const results = [0, 5, 12, 24].flatMap((initialMorale) =>
      [false, true].flatMap((postZeroOutputModeled) =>
        [0, 1, 2].map((moraleConsumptionPerHour) => {
          const input = emptyCycle({ initialMorale: { worker: initialMorale, resting: initialMorale } });
          input.shifts[0].assignments.push({
            facilityId: "factory-1",
            operatorId: "worker",
            moraleConsumptionPerHour,
            postZeroOutputModeled
          });
          return evaluateSustainableCycle(input);
        })
      )
    );

    for (const result of results) {
      for (const operator of result.operators) {
        expect(operator.productiveHours).toBeGreaterThanOrEqual(0);
        expect(operator.productiveHours).toBeLessThanOrEqual(operator.scheduledWorkHours);
        expect(operator.uptime).toBeGreaterThanOrEqual(0);
        expect(operator.uptime).toBeLessThanOrEqual(1);
      }
    }
  });

  it("splits continuous recovery exactly where a threshold modifier stops applying", () => {
    const result = evaluateSustainableCycle(emptyCycle({
      initialMorale: { recovering: 19 },
      recoveryPlacements: [{
        dormitoryId: "dormitory-1",
        operatorId: "recovering",
        startHour: 0,
        endHour: 2,
        recoveryRatePerHour: 0.25,
        conditionalModifiers: [{ moraleAtMost: 20, additionalRatePerHour: 0.75 }]
      }]
    }));
    const recovering = result.operators[0];

    expect(recovering.finalMorale).toBeCloseTo(20.25);
    expect(recovering.timeline.slice(0, 2)).toEqual([
      expect.objectContaining({ startHour: 0, endHour: 1, startMorale: 19, endMorale: 20, ratePerHour: 1 }),
      expect.objectContaining({ startHour: 1, endHour: 2, startMorale: 20, endMorale: 20.25, ratePerHour: 0.25 })
    ]);
  });

  it("swaps morale at an explicit same-dorm event and limits each full source to one use", () => {
    const input = emptyCycle({
      initialMorale: { source: 24, target: 10, other: 8 },
      recoveryPlacements: [
        { dormitoryId: "dormitory-1", operatorId: "source", startHour: 0, endHour: 12, recoveryRatePerHour: 0 },
        {
          dormitoryId: "dormitory-1", operatorId: "target", startHour: 0, endHour: 12, recoveryRatePerHour: 0,
          moraleExchange: { atHour: 0, sourceOperatorId: "source" }
        },
        {
          dormitoryId: "dormitory-1", operatorId: "other", startHour: 0, endHour: 12, recoveryRatePerHour: 0,
          moraleExchange: { atHour: 6, sourceOperatorId: "source" }
        }
      ]
    });

    const result = evaluateSustainableCycle(input);
    expect(result.exchanges).toEqual([
      expect.objectContaining({
        hour: 0,
        sourceOperatorId: "source",
        targetOperatorId: "target",
        dormitoryId: "dormitory-1"
      })
    ]);
    expect(result.operators.find((operator) => operator.operatorId === "source")?.finalMorale).toBe(10);
    expect(result.operators.find((operator) => operator.operatorId === "target")?.finalMorale).toBe(24);
    expect(result.failures).toContainEqual(expect.objectContaining({
      category: "morale",
      code: "exchange-source-already-used"
    }));
  });

  it("rejects exchange when the source is not full, is outside the event dorm, or worked in the recovery interval", () => {
    const input = emptyCycle({
      initialMorale: { source: 23, target: 10 },
      recoveryPlacements: [
        { dormitoryId: "dormitory-2", operatorId: "source", startHour: 12, endHour: 24, recoveryRatePerHour: 1 },
        {
          dormitoryId: "dormitory-1", operatorId: "target", startHour: 12, endHour: 24, recoveryRatePerHour: 1,
          moraleExchange: { atHour: 12, sourceOperatorId: "source" }
        }
      ]
    });
    input.shifts[0].assignments.push({ facilityId: "factory-1", operatorId: "source", moraleConsumptionPerHour: 0 });

    const result = evaluateSustainableCycle(input);
    expect(result.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "morale", code: "exchange-source-not-full" }),
      expect.objectContaining({ category: "morale", code: "exchange-source-worked" }),
      expect.objectContaining({ category: "dormitory", code: "exchange-dorm-mismatch" })
    ]));
  });

  it("flags a one-day-only schedule that does not close its morale phase", () => {
    const input = steadyInput();
    input.recoveryPlacements[1].recoveryRatePerHour = 0.5;
    const result = evaluateSustainableCycle(input);

    expect(result.sustainable).toBe(false);
    expect(result.failures).toContainEqual(expect.objectContaining({
      category: "cycle-closure",
      code: "morale-state-not-closed",
      operatorId: "worker-a"
    }));
  });

  it("rejects a gold prefix underflow", () => {
    const input = emptyCycle({ startingGold: 2 });
    input.shifts[0].resourceLedger = goldLedger(0, 3);
    input.shifts[1].resourceLedger = goldLedger(10, 0);

    const result = evaluateSustainableCycle(input);
    expect(result.failures).toContainEqual(expect.objectContaining({
      category: "resource",
      code: "gold-prefix-underflow",
      hour: 12
    }));
  });

  it("rejects negative daily gold net even when initial stock covers consumption", () => {
    const input = emptyCycle({ startingGold: 100 });
    input.shifts[0].resourceLedger = goldLedger(0, 3);
    input.shifts[1].resourceLedger = goldLedger(2, 0);

    const result = evaluateSustainableCycle(input);
    expect(result.gold.ending).toBe(99);
    expect(result.failures).toContainEqual(expect.objectContaining({
      category: "resource",
      code: "negative-daily-gold-net"
    }));
  });

  it("rejects invalid rates, boundaries, morale, and malformed ledgers", () => {
    const invalidRate = steadyInput();
    invalidRate.shifts[0].assignments[0].moraleConsumptionPerHour = Number.NaN;
    expect(() => evaluateSustainableCycle(invalidRate)).toThrow(/finite non-negative/);

    const invalidBoundary = steadyInput();
    invalidBoundary.recoveryPlacements[0].endHour = 25;
    expect(() => evaluateSustainableCycle(invalidBoundary)).toThrow(/within 0\.\.24/);

    const invalidMorale = steadyInput();
    invalidMorale.initialMorale["worker-a"] = 25;
    expect(() => evaluateSustainableCycle(invalidMorale)).toThrow(/morale cap/);

    const malformedLedger = steadyInput();
    malformedLedger.shifts[0].resourceLedger = { ...emptyLedger(), goldProduced: -1 };
    expect(() => evaluateSustainableCycle(malformedLedger)).toThrow(/resourceLedger/);
  });

  it("does not mutate input and returns deterministic output", () => {
    const input = steadyInput();
    const snapshot = structuredClone(input);

    const first = evaluateSustainableCycle(input);
    const second = evaluateSustainableCycle(input);

    expect(input).toEqual(snapshot);
    expect(first).toEqual(second);
  });
});
