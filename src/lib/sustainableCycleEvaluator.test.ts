import { describe, expect, it } from "vitest";
import { createDefaultState } from "../data/defaults";
import { createMaxLevel243BenchmarkContext } from "./benchmarkBaseContext";
import { createResourceLedger } from "./resourceLedger";
import {
  evaluateSustainableCycle,
  type CycleFacilityResourceContribution,
  type SustainableCycleInput
} from "./sustainableCycleEvaluator";

const emptyLedger = () => createResourceLedger();
const moraleRecord = (values: Record<string, number>): Record<string, number> => values;

function contribution(
  id: string,
  facilityId: string,
  kind: CycleFacilityResourceContribution["kind"],
  ledger: CycleFacilityResourceContribution["ledger"]
): CycleFacilityResourceContribution {
  return { id, facilityId, kind, ledger };
}

function ensureResourceAssignment(input: SustainableCycleInput, shiftIndex: 0 | 1, facilityId: string): void {
  const shift = input.shifts[shiftIndex];
  if (shift.assignments.some((assignment) => assignment.facilityId === facilityId)) return;
  const operatorId = `resource-${shift.id}-${facilityId}`;
  shift.assignments.push({ facilityId, operatorId, moraleConsumptionPerHour: 0 });
  input.initialMorale[operatorId] = 24;
}

function setGoldFlows(
  input: SustainableCycleInput,
  shiftIndex: 0 | 1,
  goldProduced: number,
  goldConsumed: number
): void {
  const shift = input.shifts[shiftIndex];
  shift.resourceContributions = [];
  if (goldProduced !== 0) {
    ensureResourceAssignment(input, shiftIndex, "factory-1");
    shift.resourceContributions.push(contribution(
      `${shift.id}-factory-gold`,
      "factory-1",
      "factory-gold",
      createResourceLedger({ natural: { goldProduced } })
    ));
  }
  if (goldConsumed !== 0) {
    ensureResourceAssignment(input, shiftIndex, "trading-1");
    shift.resourceContributions.push(contribution(
      `${shift.id}-trading-gold`,
      "trading-1",
      "trading-post",
      createResourceLedger({ natural: { goldConsumed } })
    ));
  }
}

function setDroneFlows(
  input: SustainableCycleInput,
  shiftIndex: 0 | 1,
  dronesGenerated: number,
  dronesUsed: number
): void {
  const shift = input.shifts[shiftIndex];
  shift.resourceContributions = [];
  if (dronesGenerated !== 0) {
    ensureResourceAssignment(input, shiftIndex, "power-1");
    shift.resourceContributions.push(contribution(
      `${shift.id}-power-drone`,
      "power-1",
      "power-drone",
      createResourceLedger({ dronesGenerated })
    ));
  }
  if (dronesUsed !== 0) {
    ensureResourceAssignment(input, shiftIndex, "trading-1");
    shift.resourceContributions.push(contribution(
      `${shift.id}-trading-drone`,
      "trading-1",
      "trading-post",
      createResourceLedger({ dronesUsed })
    ));
  }
}

function steadyInput(): SustainableCycleInput {
  return {
    schedule: createDefaultState().schedule,
    shifts: [
      {
        id: "shift-a",
        startHour: 0,
        endHour: 12,
        groupIds: ["group-a"],
        assignments: [
          { facilityId: "factory-1", operatorId: "worker-a", moraleConsumptionPerHour: 1 },
          { facilityId: "trading-1", operatorId: "resource-a-trading", moraleConsumptionPerHour: 0 }
        ],
        resourceContributions: [
          contribution("A-factory-gold", "factory-1", "factory-gold", createResourceLedger({ natural: { goldProduced: 12 } })),
          contribution("A-trading-gold", "trading-1", "trading-post", createResourceLedger({ natural: { goldConsumed: 10 } }))
        ]
      },
      {
        id: "shift-b",
        startHour: 12,
        endHour: 24,
        groupIds: ["group-b"],
        assignments: [
          { facilityId: "factory-1", operatorId: "worker-b", moraleConsumptionPerHour: 1 },
          { facilityId: "trading-1", operatorId: "resource-b-trading", moraleConsumptionPerHour: 0 }
        ],
        resourceContributions: [
          contribution("B-factory-gold", "factory-1", "factory-gold", createResourceLedger({ natural: { goldProduced: 12 } })),
          contribution("B-trading-gold", "trading-1", "trading-post", createResourceLedger({ natural: { goldConsumed: 10 } }))
        ]
      }
    ],
    startingDrones: 0,
    initialMorale: {
      "worker-a": 24,
      "worker-b": 12,
      "resource-a-trading": 24,
      "resource-b-trading": 24
    },
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
    schedule: createDefaultState().schedule,
    shifts: [
      { id: "shift-a", startHour: 0, endHour: 12, groupIds: ["group-a"], assignments: [], resourceContributions: [] },
      { id: "shift-b", startHour: 12, endHour: 24, groupIds: ["group-b"], assignments: [], resourceContributions: [] }
    ],
    startingDrones: 0,
    initialMorale: {},
    recoveryPlacements: [],
    startingGold: 0,
    ...overrides
  };
}

function orderInvariantInput(): SustainableCycleInput {
  const shifts = [
    { id: "ab", startHour: 0, endHour: 8, groupIds: ["A", "B"], goldProduced: 4, goldConsumed: 1, drones: 1 },
    { id: "bc", startHour: 8, endHour: 16, groupIds: ["B", "C"], goldProduced: 2, goldConsumed: 3, drones: 2 },
    { id: "ca", startHour: 16, endHour: 24, groupIds: ["C", "A"], goldProduced: 5, goldConsumed: 2, drones: 3 }
  ].map(({ id, startHour, endHour, groupIds, goldProduced, goldConsumed, drones }) => ({
    id,
    startHour,
    endHour,
    groupIds,
    assignments: [
      { facilityId: "factory-1", operatorId: `${id}-factory`, moraleConsumptionPerHour: 0 },
      { facilityId: "trading-1", operatorId: `${id}-trading`, moraleConsumptionPerHour: 0 },
      { facilityId: "power-1", operatorId: `${id}-power`, moraleConsumptionPerHour: 0 }
    ],
    resourceContributions: [
      contribution(`${id}-factory`, "factory-1", "factory-gold", createResourceLedger({ natural: { goldProduced } })),
      contribution(`${id}-trading`, "trading-1", "trading-post", createResourceLedger({
        natural: { goldConsumed, lmd: goldConsumed * 500 },
        dronesUsed: drones
      })),
      contribution(`${id}-power`, "power-1", "power-drone", createResourceLedger({ dronesGenerated: drones }))
    ]
  }));

  return {
    schedule: {
      cycleHours: 24,
      groups: [{ id: "A" }, { id: "B" }, { id: "C" }],
      shifts: [
        { id: "ab", startHour: 0, endHour: 8, activeGroupIds: ["A", "B"], recoveryGroupIds: ["C"] },
        { id: "bc", startHour: 8, endHour: 16, activeGroupIds: ["B", "C"], recoveryGroupIds: ["A"] },
        { id: "ca", startHour: 16, endHour: 24, activeGroupIds: ["C", "A"], recoveryGroupIds: ["B"] }
      ]
    },
    shifts,
    startingDrones: 0,
    initialMorale: Object.fromEntries(
      shifts.flatMap((shift) => shift.assignments.map((assignment) => [assignment.operatorId, 24]))
    ),
    recoveryPlacements: [],
    startingGold: 10,
    baseContext: createMaxLevel243BenchmarkContext()
  };
}

describe("evaluateSustainableCycle", () => {
  it("rejects stale shift resourceLedger input instead of certifying ownerless production", () => {
    const input = emptyCycle();
    (input.shifts[0] as unknown as { resourceLedger: unknown }).resourceLedger =
      createResourceLedger({ natural: { goldProduced: 1 } });

    expect(() => evaluateSustainableCycle(input)).toThrowError(
      new RangeError("shifts[0].resourceLedger is unsupported; use resourceContributions")
    );
  });

  it("rejects a forged incomplete shift ledger with its precise authority path", () => {
    const input = emptyCycle();
    input.shifts[0].resourceContributions = [contribution("forged", "factory-1", "factory-gold", {
      ...emptyLedger(),
      natural: { goldProduced: 1 },
      goldProduced: 1,
      goldNetChange: 1
    } as unknown as CycleFacilityResourceContribution["ledger"])];

    expect(() => evaluateSustainableCycle(input)).toThrowError(
      new RangeError("shifts[0].resourceContributions[0].ledger.natural.goldConsumed is required")
    );
  });

  it("requires a contribution array and non-null, non-array contribution objects with precise paths", () => {
    const missingArray = emptyCycle();
    (missingArray.shifts[0] as unknown as { resourceContributions?: unknown }).resourceContributions = undefined;
    expect(() => evaluateSustainableCycle(missingArray)).toThrowError(
      new RangeError("shifts[0].resourceContributions must be an array")
    );

    for (const value of [null, []]) {
      const malformed = emptyCycle();
      malformed.shifts[0].resourceContributions = [value] as unknown as CycleFacilityResourceContribution[];
      expect(() => evaluateSustainableCycle(malformed)).toThrowError(
        new RangeError("shifts[0].resourceContributions[0] must be a non-null, non-array object")
      );
    }
  });

  it("rejects unknown or ownerless contribution facilities and incompatible kinds", () => {
    const unknown = emptyCycle();
    unknown.shifts[0].resourceContributions = [
      contribution("unknown", "missing", "factory-gold", emptyLedger())
    ];
    expect(() => evaluateSustainableCycle(unknown)).toThrowError(
      new RangeError("shifts[0].resourceContributions[0].facilityId references unknown facility missing")
    );

    const ownerless = emptyCycle();
    ownerless.shifts[0].resourceContributions = [
      contribution("ownerless", "factory-1", "factory-gold", createResourceLedger({ natural: { goldProduced: 1 } }))
    ];
    expect(() => evaluateSustainableCycle(ownerless)).toThrowError(
      new RangeError("shifts[0].resourceContributions[0].facilityId factory-1 has no matching assignment in shift shift-a")
    );

    const wrongKind = emptyCycle({ initialMorale: { witness: 24 } });
    wrongKind.shifts[0].assignments = [{ facilityId: "factory-3", operatorId: "witness", moraleConsumptionPerHour: 0 }];
    wrongKind.shifts[0].resourceContributions = [
      contribution("wrong-kind", "factory-3", "factory-gold", createResourceLedger({ natural: { goldProduced: 1 } }))
    ];
    expect(() => evaluateSustainableCycle(wrongKind)).toThrowError(
      new RangeError("shifts[0].resourceContributions[0].kind factory-gold is incompatible with facility factory-3")
    );
  });

  it("rejects duplicate contribution IDs and duplicate facility ownership within a shift", () => {
    const duplicateId = emptyCycle({ initialMorale: { factory: 24, power: 24 } });
    duplicateId.shifts[0].assignments = [
      { facilityId: "factory-1", operatorId: "factory", moraleConsumptionPerHour: 0 },
      { facilityId: "power-1", operatorId: "power", moraleConsumptionPerHour: 0 }
    ];
    duplicateId.shifts[0].resourceContributions = [
      contribution("duplicate", "factory-1", "factory-gold", emptyLedger()),
      contribution("duplicate", "power-1", "power-drone", emptyLedger())
    ];
    expect(() => evaluateSustainableCycle(duplicateId)).toThrowError(
      new RangeError("shifts[0].resourceContributions[1].id duplicates contribution ID duplicate in shift shift-a")
    );

    const duplicateFacility = emptyCycle({ initialMorale: { trading: 24 } });
    duplicateFacility.shifts[0].assignments = [
      { facilityId: "trading-1", operatorId: "trading", moraleConsumptionPerHour: 0 }
    ];
    duplicateFacility.shifts[0].resourceContributions = [
      contribution("natural-orders", "trading-1", "trading-post", createResourceLedger({ natural: { goldConsumed: 1, lmd: 500 } })),
      contribution("drone-orders", "trading-1", "trading-post", createResourceLedger({ drone: { goldConsumed: 1, lmd: 500 }, dronesUsed: 1 }))
    ];
    expect(() => evaluateSustainableCycle(duplicateFacility)).toThrowError(
      new RangeError("shifts[0].resourceContributions[1].facilityId duplicates facility trading-1 in shift shift-a")
    );
  });

  it.each([
    ["factory-gold", "factory-1", createResourceLedger({ natural: { goldConsumed: 1 } }), "natural.goldConsumed"],
    ["factory-battle-record", "factory-3", createResourceLedger({ drone: { battleRecordExp: 1 } }), "drone.battleRecordExp"],
    ["trading-post", "trading-1", createResourceLedger({ dronesGenerated: 1 }), "dronesGenerated"],
    ["power-drone", "power-1", createResourceLedger({ dronesUsed: 1 }), "dronesUsed"]
  ] as const)("fails closed on disallowed %s contribution fields", (kind, facilityId, ledger, field) => {
    const input = emptyCycle({ initialMorale: { witness: 24 } });
    input.shifts[0].assignments = [{ facilityId, operatorId: "witness", moraleConsumptionPerHour: 0 }];
    input.shifts[0].resourceContributions = [contribution("invalid-fields", facilityId, kind, ledger)];

    expect(() => evaluateSustainableCycle(input)).toThrowError(
      new RangeError(`shifts[0].resourceContributions[0].ledger.${field} must be exactly zero for ${kind}`)
    );
  });

  it("derives aggregate, gold, and drone timelines from sorted facility contributions", () => {
    const input = emptyCycle({
      startingGold: 10,
      initialMorale: { factory: 24, trading: 24, "power-1": 24, "power-2": 24, "power-3": 24 }
    });
    input.shifts[0].assignments = [
      { facilityId: "factory-1", operatorId: "factory", moraleConsumptionPerHour: 0 },
      { facilityId: "trading-1", operatorId: "trading", moraleConsumptionPerHour: 0 },
      { facilityId: "power-1", operatorId: "power-1", moraleConsumptionPerHour: 0 },
      { facilityId: "power-2", operatorId: "power-2", moraleConsumptionPerHour: 0 },
      { facilityId: "power-3", operatorId: "power-3", moraleConsumptionPerHour: 0 }
    ];
    input.shifts[0].resourceContributions = [
      contribution("a-power", "power-1", "power-drone", createResourceLedger({ dronesGenerated: 0.1 })),
      contribution("m-power", "power-2", "power-drone", createResourceLedger({ dronesGenerated: 0.2 })),
      contribution("z-power", "power-3", "power-drone", createResourceLedger({ dronesGenerated: 0.3 })),
      contribution("a-factory", "factory-1", "factory-gold", createResourceLedger({ natural: { goldProduced: 8 } })),
      contribution("m-trading", "trading-1", "trading-post", createResourceLedger({
        natural: { goldConsumed: 3, lmd: 1_500 },
        drone: { goldConsumed: 2, lmd: 1_000 },
        dronesUsed: 0.6000000000000001
      }))
    ];
    const permuted = structuredClone(input);
    permuted.shifts[0].resourceContributions.reverse();

    const result = evaluateSustainableCycle(input);
    expect(evaluateSustainableCycle(permuted)).toEqual(result);
    expect(result.sustainable).toBe(true);
    expect(result.aggregateLedger).toEqual(createResourceLedger({
      natural: { goldProduced: 8, goldConsumed: 3, lmd: 1_500 },
      drone: { goldConsumed: 2, lmd: 1_000 },
      dronesGenerated: 0.6000000000000001,
      dronesUsed: 0.6000000000000001
    }));
    expect(result.gold).toEqual({
      starting: 10,
      produced: 8,
      consumed: 5,
      netChange: 3,
      ending: 13,
      timeline: [{ hour: 0, gold: 10 }, { hour: 12, gold: 13 }, { hour: 24, gold: 13 }]
    });
    expect(result.drones).toEqual({
      cap: 235,
      starting: 0,
      generated: 0.6000000000000001,
      used: 0.6000000000000001,
      overflow: 0,
      ending: 0,
      timeline: [
        { hour: 12, shiftId: "shift-a", opening: 0, generated: 0.6000000000000001, overflow: 0, available: 0.6000000000000001, used: 0.6000000000000001, ending: 0 },
        { hour: 24, shiftId: "shift-b", opening: 0, generated: 0, overflow: 0, available: 0, used: 0, ending: 0 }
      ]
    });
  });

  it("rejects daily drone depletion and accepts exact inventory closure", () => {
    const depleted = emptyCycle({ startingDrones: 10 });
    setDroneFlows(depleted, 0, 0, 5);
    setDroneFlows(depleted, 1, 0, 5);

    const depletedResult = evaluateSustainableCycle(depleted);
    expect(depletedResult.failures).toContainEqual(expect.objectContaining({
      category: "cycle-closure",
      code: "drone-state-not-closed",
      hour: 24
    }));

    const closed = emptyCycle({ startingDrones: 0 });
    setDroneFlows(closed, 0, 5, 5);
    setDroneFlows(closed, 1, 2.5, 2.5);

    const closedResult = evaluateSustainableCycle(closed);
    expect(closedResult.sustainable).toBe(true);
    expect(closedResult.drones).toEqual({
      cap: 235,
      starting: 0,
      generated: 7.5,
      used: 7.5,
      overflow: 0,
      ending: 0,
      timeline: [
        { hour: 12, shiftId: "shift-a", opening: 0, generated: 5, overflow: 0, available: 5, used: 5, ending: 0 },
        { hour: 24, shiftId: "shift-b", opening: 0, generated: 2.5, overflow: 0, available: 2.5, used: 2.5, ending: 0 }
      ]
    });
  });

  it("applies the drone cap before each shift spend and rejects prefix underflow", () => {
    const capped = emptyCycle({ startingDrones: 230 });
    setDroneFlows(capped, 0, 10, 5);
    setDroneFlows(capped, 1, 10, 5);

    const cappedResult = evaluateSustainableCycle(capped);
    expect(cappedResult.sustainable).toBe(true);
    expect(cappedResult.drones).toMatchObject({
      starting: 230,
      generated: 20,
      used: 10,
      overflow: 10,
      ending: 230
    });
    expect(cappedResult.drones.timeline).toEqual([
      { hour: 12, shiftId: "shift-a", opening: 230, generated: 10, overflow: 5, available: 235, used: 5, ending: 230 },
      { hour: 24, shiftId: "shift-b", opening: 230, generated: 10, overflow: 5, available: 235, used: 5, ending: 230 }
    ]);

    const underflow = emptyCycle({ startingDrones: 0 });
    setDroneFlows(underflow, 0, 4.5, 5);
    const underflowResult = evaluateSustainableCycle(underflow);
    expect(underflowResult.failures).toContainEqual(expect.objectContaining({
      category: "resource",
      code: "drone-prefix-underflow",
      shiftId: "shift-a",
      hour: 12
    }));
  });

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

  it("allows a worker reused in non-overlapping shifts", () => {
    const input = steadyInput();
    input.recoveryPlacements = [];
    input.shifts[1].assignments[0] = {
      facilityId: "factory-1",
      operatorId: "worker-a",
      moraleConsumptionPerHour: 1
    };

    const result = evaluateSustainableCycle(input);
    expect(result.failures).not.toContainEqual(expect.objectContaining({ category: "overlap", operatorId: "worker-a" }));
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
    input.shifts[0].resourceContributions = [];
    Object.assign(input.initialMorale, {
      "slot-0": 24, "slot-1": 24, "slot-2": 24, "slot-3": 24, "unknown-worker": 24
    });

    const result = evaluateSustainableCycle(input);
    expect(result.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "overlap", code: "facility-slot-overflow" }),
      expect.objectContaining({ category: "overlap", code: "unknown-facility" })
    ]));
  });

  it("uses canonical 243 work-facility validation when baseContext is omitted", () => {
    const input = emptyCycle({
      initialMorale: Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`worker-${index}`, 24]))
    });
    input.shifts[0].assignments = Array.from({ length: 6 }, (_, index) => ({
      facilityId: "factory-1",
      operatorId: `worker-${index}`,
      moraleConsumptionPerHour: 0
    }));

    const result = evaluateSustainableCycle(input);
    expect(result.sustainable).toBe(false);
    expect(result.failures).toContainEqual(expect.objectContaining({
      category: "overlap",
      code: "facility-slot-overflow",
      facilityId: "factory-1"
    }));
  });

  it("uses canonical 243 dormitory validation when baseContext is omitted", () => {
    const fakeDorm = evaluateSustainableCycle(emptyCycle({
      initialMorale: { resting: 0 },
      recoveryPlacements: [{
        dormitoryId: "fake-dormitory",
        operatorId: "resting",
        startHour: 0,
        endHour: 12,
        recoveryRatePerHour: 0
      }]
    }));
    expect(fakeDorm.failures).toContainEqual(expect.objectContaining({
      category: "dormitory",
      code: "unknown-dormitory",
      dormitoryId: "fake-dormitory"
    }));

    const placements = Array.from({ length: 21 }, (_, index) => ({
      dormitoryId: `dormitory-${(index % 4) + 1}`,
      operatorId: `rest-${index}`,
      startHour: 0,
      endHour: 12,
      recoveryRatePerHour: 0
    }));
    const overCapacity = evaluateSustainableCycle(emptyCycle({
      initialMorale: Object.fromEntries(placements.map((placement) => [placement.operatorId, 0])),
      recoveryPlacements: placements
    }));
    expect(overCapacity.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "dormitory", code: "dormitory-overflow" }),
      expect.objectContaining({ category: "dormitory", code: "total-bed-overflow" })
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

  it("reports partial uptime only until morale reaches zero before a shift ends", () => {
    const input = emptyCycle({ initialMorale: { tired: 5 } });
    input.shifts[0].assignments.push({
      facilityId: "factory-1",
      operatorId: "tired",
      moraleConsumptionPerHour: 1
    });

    const result = evaluateSustainableCycle(input);
    expect(result.failures.filter((item) => item.code === "fatigued-before-shift-end")).toEqual([expect.objectContaining({
      category: "morale",
      operatorId: "tired",
      shiftId: "shift-a",
      hour: 5
    })]);
    expect(result.operators[0]).toMatchObject({ productiveHours: 5, uptime: 5 / 12, finalMorale: 0 });
    expect(result.operators[0].timeline.slice(0, 2)).toEqual([
      expect.objectContaining({ startHour: 0, endHour: 5, startMorale: 5, endMorale: 0, ratePerHour: -1 }),
      expect.objectContaining({ startHour: 5, endHour: 12, startMorale: 0, endMorale: 0, ratePerHour: 0 })
    ]);
  });

  it("keeps a worker productive when morale reaches zero exactly at shift end", () => {
    const input = emptyCycle({
      initialMorale: { exact: 12 },
      recoveryPlacements: [{
        dormitoryId: "dormitory-1",
        operatorId: "exact",
        startHour: 12,
        endHour: 24,
        recoveryRatePerHour: 1
      }]
    });
    input.shifts[0].assignments.push({
      facilityId: "factory-1",
      operatorId: "exact",
      moraleConsumptionPerHour: 1
    });

    const result = evaluateSustainableCycle(input);
    expect(result.failures).toEqual([]);
    expect(result.operators[0]).toMatchObject({
      scheduledWorkHours: 12,
      productiveHours: 12,
      uptime: 1,
      finalMorale: 12
    });
    expect(result.operators[0].timeline[0]).toEqual(expect.objectContaining({
      startHour: 0,
      endHour: 12,
      startMorale: 12,
      endMorale: 0,
      ratePerHour: -1
    }));
  });

  it("fails closed when a zero-morale operator starts work, including at zero consumption rate", () => {
    const input = emptyCycle({ initialMorale: { exhausted: 0 } });
    input.shifts[0].assignments.push({
      facilityId: "factory-1",
      operatorId: "exhausted",
      moraleConsumptionPerHour: 0
    });

    const result = evaluateSustainableCycle(input);
    expect(result.failures.filter((item) => item.code === "fatigued-before-shift-end")).toEqual([expect.objectContaining({
      category: "morale",
      operatorId: "exhausted",
      facilityId: "factory-1",
      shiftId: "shift-a",
      hour: 0
    })]);
    expect(result.operators[0]).toMatchObject({
      scheduledWorkHours: 12,
      productiveHours: 0,
      uptime: 0,
      finalMorale: 0
    });
    expect(result.operators[0].timeline[0]).toEqual(expect.objectContaining({
      startHour: 0,
      endHour: 12,
      mode: "work",
      startMorale: 0,
      endMorale: 0,
      ratePerHour: 0
    }));
  });

  it("rejects stale runtime postZeroOutputModeled values instead of granting output", () => {
    for (const staleValue of [true, false]) {
      const input = emptyCycle({ initialMorale: { tired: 5 } });
      input.shifts[0].assignments.push({
        facilityId: "factory-1",
        operatorId: "tired",
        moraleConsumptionPerHour: 1,
        postZeroOutputModeled: staleValue
      } as unknown as SustainableCycleInput["shifts"][number]["assignments"][number]);

      expect(() => evaluateSustainableCycle(input)).toThrowError(
        new RangeError("shifts[0].assignments[0].postZeroOutputModeled is unsupported")
      );
    }
  });

  it("keeps productive hours and uptime within their general bounds", () => {
    const results = [0, 5, 12, 24].flatMap((initialMorale) =>
      [0, 1, 2].map((moraleConsumptionPerHour) => {
        const input = emptyCycle({ initialMorale: { worker: initialMorale, resting: initialMorale } });
        input.shifts[0].assignments.push({
          facilityId: "factory-1",
          operatorId: "worker",
          moraleConsumptionPerHour
        });
        return evaluateSustainableCycle(input);
      })
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

  it("rejects finite base and active conditional recovery rates whose total overflows", () => {
    const input = emptyCycle({
      initialMorale: { recovering: 0 },
      recoveryPlacements: [{
        dormitoryId: "dormitory-1",
        operatorId: "recovering",
        startHour: 0,
        endHour: 12,
        recoveryRatePerHour: Number.MAX_VALUE,
        conditionalModifiers: [{ moraleAtMost: 24, additionalRatePerHour: Number.MAX_VALUE }]
      }]
    });

    expect(() => evaluateSustainableCycle(input)).toThrowError(
      new RangeError(
        "recovery arithmetic for operator recovering at recoveryPlacements[0].baseRatePlusModifierSum must be finite"
      )
    );
  });

  it("advances a single huge finite recovery rate to the morale cap", () => {
    const result = evaluateSustainableCycle(emptyCycle({
      initialMorale: { recovering: 0 },
      recoveryPlacements: [{
        dormitoryId: "dormitory-1",
        operatorId: "recovering",
        startHour: 0,
        endHour: 12,
        recoveryRatePerHour: Number.MAX_VALUE
      }]
    }));
    const recovering = result.operators[0];

    expect(recovering.finalMorale).toBe(24);
    expect(recovering.timeline[0]).toMatchObject({
      startHour: 0,
      endMorale: 24,
      ratePerHour: Number.MAX_VALUE
    });
    expect(recovering.timeline[0].endHour).toBeGreaterThan(0);
    expect(recovering.timeline[0].endHour).toBeLessThan(1e-12);
    for (const segment of recovering.timeline) {
      expect(Object.values(segment).filter((value): value is number => typeof value === "number").every(Number.isFinite)).toBe(true);
    }
  });

  it("normalizes active modifier order and publishes only finite recovery timeline values", () => {
    const modifiers = [
      { moraleAtMost: 24, additionalRatePerHour: 1e16 },
      { moraleAtMost: 24, additionalRatePerHour: 1 },
      { moraleAtMost: 24, additionalRatePerHour: 1 }
    ];
    const evaluate = (conditionalModifiers: typeof modifiers) => evaluateSustainableCycle(emptyCycle({
      initialMorale: { recovering: 0 },
      recoveryPlacements: [{
        dormitoryId: "dormitory-1",
        operatorId: "recovering",
        startHour: 0,
        endHour: 12,
        recoveryRatePerHour: 0,
        conditionalModifiers
      }]
    })).operators[0];

    const canonical = evaluate(modifiers);
    const permuted = evaluate([modifiers[2], modifiers[0], modifiers[1]]);

    expect(permuted).toEqual(canonical);
    expect(canonical.finalMorale).toBe(24);
    for (const segment of canonical.timeline) {
      expect(Object.values(segment).filter((value): value is number => typeof value === "number").every(Number.isFinite)).toBe(true);
    }
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

  it("does not let cycle closure tolerance make an almost-full exchange source eligible", () => {
    const input = emptyCycle({
      cycleClosureTolerance: 1e-6,
      initialMorale: { source: 24 - 5e-7, target: 10 },
      recoveryPlacements: [
        { dormitoryId: "dormitory-1", operatorId: "source", startHour: 0, endHour: 12, recoveryRatePerHour: 0 },
        {
          dormitoryId: "dormitory-1", operatorId: "target", startHour: 0, endHour: 12, recoveryRatePerHour: 0,
          moraleExchange: { atHour: 0, sourceOperatorId: "source" }
        }
      ]
    });

    const result = evaluateSustainableCycle(input);
    expect(result.exchanges).toEqual([]);
    expect(result.failures).toContainEqual(expect.objectContaining({
      category: "morale",
      code: "exchange-source-not-full",
      operatorId: "source",
      hour: 0
    }));
  });

  it("accepts cycle closure tolerance through 1e-6 and rejects larger values", () => {
    expect(() => evaluateSustainableCycle(emptyCycle({ cycleClosureTolerance: 1e-6 }))).not.toThrow();
    expect(() => evaluateSustainableCycle(emptyCycle({ cycleClosureTolerance: 1e-6 + Number.EPSILON }))).toThrowError(
      new RangeError("cycleClosureTolerance must not exceed 0.000001")
    );
  });

  it("canonicalizes disjoint same-hour exchanges independently of declaration order", () => {
    const placements: SustainableCycleInput["recoveryPlacements"] = [
      { dormitoryId: "dormitory-1", operatorId: "source-a", startHour: 0, endHour: 12, recoveryRatePerHour: 0 },
      {
        dormitoryId: "dormitory-1", operatorId: "target-b", startHour: 0, endHour: 12, recoveryRatePerHour: 0,
        moraleExchange: { atHour: 0, sourceOperatorId: "source-a" }
      },
      { dormitoryId: "dormitory-2", operatorId: "source-c", startHour: 0, endHour: 12, recoveryRatePerHour: 0 },
      {
        dormitoryId: "dormitory-2", operatorId: "target-d", startHour: 0, endHour: 12, recoveryRatePerHour: 0,
        moraleExchange: { atHour: 0, sourceOperatorId: "source-c" }
      }
    ];
    const common = {
      initialMorale: { "source-a": 24, "target-b": 10, "source-c": 24, "target-d": 8 }
    };

    const canonical = evaluateSustainableCycle(emptyCycle({ ...common, recoveryPlacements: placements }));
    const permuted = evaluateSustainableCycle(emptyCycle({ ...common, recoveryPlacements: [...placements].reverse() }));

    expect(permuted).toEqual(canonical);
    expect(canonical.exchanges).toEqual([
      expect.objectContaining({ hour: 0, dormitoryId: "dormitory-1", sourceOperatorId: "source-a", targetOperatorId: "target-b" }),
      expect.objectContaining({ hour: 0, dormitoryId: "dormitory-2", sourceOperatorId: "source-c", targetOperatorId: "target-d" })
    ]);
  });

  it("rejects same-hour exchange chains identically before mutation for every declaration order", () => {
    const placements: SustainableCycleInput["recoveryPlacements"] = [
      { dormitoryId: "dormitory-1", operatorId: "operator-a", startHour: 0, endHour: 12, recoveryRatePerHour: 0 },
      {
        dormitoryId: "dormitory-1", operatorId: "operator-b", startHour: 0, endHour: 12, recoveryRatePerHour: 0,
        moraleExchange: { atHour: 0, sourceOperatorId: "operator-a" }
      },
      {
        dormitoryId: "dormitory-1", operatorId: "operator-c", startHour: 0, endHour: 12, recoveryRatePerHour: 0,
        moraleExchange: { atHour: 0, sourceOperatorId: "operator-b" }
      }
    ];
    const makeInput = (recoveryPlacements: SustainableCycleInput["recoveryPlacements"]) => emptyCycle({
      initialMorale: { "operator-a": 24, "operator-b": 10, "operator-c": 8 },
      recoveryPlacements
    });
    const expected = new RangeError("same-hour morale exchanges at hour 0 reuse operators: operator-b");

    expect(() => evaluateSustainableCycle(makeInput(placements))).toThrowError(expected);
    expect(() => evaluateSustainableCycle(makeInput([...placements].reverse()))).toThrowError(expected);
  });

  it.each([
    {
      name: "repeated source",
      initialMorale: moraleRecord({ source: 24, "target-a": 10, "target-b": 8 }),
      placements: [
        { dormitoryId: "dormitory-1", operatorId: "source", startHour: 0, endHour: 12, recoveryRatePerHour: 0 },
        { dormitoryId: "dormitory-1", operatorId: "target-a", startHour: 0, endHour: 12, recoveryRatePerHour: 0, moraleExchange: { atHour: 0, sourceOperatorId: "source" } },
        { dormitoryId: "dormitory-1", operatorId: "target-b", startHour: 0, endHour: 12, recoveryRatePerHour: 0, moraleExchange: { atHour: 0, sourceOperatorId: "source" } }
      ],
      reused: "source"
    },
    {
      name: "repeated target",
      initialMorale: moraleRecord({ "source-a": 24, "source-b": 24, target: 10 }),
      placements: [
        { dormitoryId: "dormitory-1", operatorId: "source-a", startHour: 0, endHour: 12, recoveryRatePerHour: 0 },
        { dormitoryId: "dormitory-1", operatorId: "source-b", startHour: 0, endHour: 12, recoveryRatePerHour: 0 },
        { dormitoryId: "dormitory-1", operatorId: "target", startHour: 0, endHour: 12, recoveryRatePerHour: 0, moraleExchange: { atHour: 0, sourceOperatorId: "source-a" } },
        { dormitoryId: "dormitory-1", operatorId: "target", startHour: 0, endHour: 12, recoveryRatePerHour: 0, moraleExchange: { atHour: 0, sourceOperatorId: "source-b" } }
      ],
      reused: "target"
    },
    {
      name: "reciprocal pair",
      initialMorale: moraleRecord({ "operator-a": 24, "operator-b": 24 }),
      placements: [
        { dormitoryId: "dormitory-1", operatorId: "operator-a", startHour: 0, endHour: 12, recoveryRatePerHour: 0, moraleExchange: { atHour: 0, sourceOperatorId: "operator-b" } },
        { dormitoryId: "dormitory-1", operatorId: "operator-b", startHour: 0, endHour: 12, recoveryRatePerHour: 0, moraleExchange: { atHour: 0, sourceOperatorId: "operator-a" } }
      ],
      reused: "operator-a, operator-b"
    }
  ])("rejects a $name collision before processing", ({ initialMorale, placements, reused }) => {
    expect(() => evaluateSustainableCycle(emptyCycle({
      initialMorale,
      recoveryPlacements: placements
    }))).toThrowError(new RangeError(`same-hour morale exchanges at hour 0 reuse operators: ${reused}`));
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
    setGoldFlows(input, 0, 0, 3);
    setGoldFlows(input, 1, 10, 0);

    const result = evaluateSustainableCycle(input);
    expect(result.failures).toContainEqual(expect.objectContaining({
      category: "resource",
      code: "gold-prefix-underflow",
      hour: 12
    }));
  });

  it("fails closed when a finite gold inventory transition overflows", () => {
    const input = emptyCycle({ startingGold: 1e308 });
    setGoldFlows(input, 0, 1e308, 0);

    expect(() => evaluateSustainableCycle(input)).toThrowError(
      new RangeError("gold inventory after shifts[0] at hour 12 must be finite")
    );
  });

  it("accepts carryover-funded gold consumption when every shift boundary remains non-negative", () => {
    const input = emptyCycle({ startingGold: 200 });
    setGoldFlows(input, 0, 0, 22.972105208756);
    setGoldFlows(input, 1, 0, 9.197500707156);

    const result = evaluateSustainableCycle(input);
    expect(result.failures).toEqual([]);
    expect(result.failures).not.toContainEqual(expect.objectContaining({ code: "negative-daily-gold-net" }));
    expect(result.sustainable).toBe(true);
    expect(result.aggregateLedger).toMatchObject({
      goldProduced: 0,
      goldConsumed: 32.169605915912,
      goldNetChange: -32.169605915912
    });
    expect(result.gold).toEqual({
      starting: 200,
      produced: 0,
      consumed: 32.169605915912,
      netChange: -32.169605915912,
      ending: 167.830394084088,
      timeline: [
        { hour: 0, gold: 200 },
        { hour: 12, gold: 177.027894791244 },
        { hour: 24, gold: 167.830394084088 }
      ]
    });
  });

  it("rejects invalid rates, boundaries, morale, and malformed ledgers", () => {
    const missingStartingDrones = { ...steadyInput(), startingDrones: undefined };
    expect(() => evaluateSustainableCycle(missingStartingDrones as unknown as SustainableCycleInput)).toThrow(/startingDrones.*finite non-negative/);

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
    malformedLedger.shifts[0].resourceContributions[0].ledger = { ...emptyLedger(), goldProduced: -1 };
    expect(() => evaluateSustainableCycle(malformedLedger)).toThrow(/resourceContributions\[0\]\.ledger/);
  });

  it("does not mutate input and returns deterministic output", () => {
    const input = steadyInput();
    const snapshot = structuredClone(input);

    const first = evaluateSustainableCycle(input);
    const second = evaluateSustainableCycle(input);

    expect(input).toEqual(snapshot);
    expect(first).toEqual(second);
  });

  it("canonicalizes three multi-group shifts and every groupIds list independently of input order", () => {
    const chronological = orderInvariantInput();
    const permuted = structuredClone(chronological);
    permuted.shifts.reverse();
    permuted.shifts.forEach((shift) => shift.groupIds.reverse());

    expect(evaluateSustainableCycle(permuted)).toEqual(evaluateSustainableCycle(chronological));
  });

  it("requires the input shifts to be the complete unique schedule shift ID set", () => {
    const duplicate = orderInvariantInput();
    duplicate.shifts[2] = structuredClone(duplicate.shifts[0]);
    expect(() => evaluateSustainableCycle(duplicate)).toThrowError(new RangeError("duplicate shift ID: ab"));

    const missing = orderInvariantInput();
    missing.shifts.pop();
    expect(() => evaluateSustainableCycle(missing)).toThrowError(new RangeError("shifts is missing schedule shift ca"));

    const extra = orderInvariantInput();
    extra.shifts.push({
      id: "extra",
      startHour: 24,
      endHour: 25,
      groupIds: ["A"],
      assignments: [],
      resourceContributions: []
    });
    expect(() => evaluateSustainableCycle(extra)).toThrowError(
      new RangeError("shifts[3].id references unknown schedule shift extra")
    );

    const mismatchedBoundaries = orderInvariantInput();
    mismatchedBoundaries.shifts.reverse();
    mismatchedBoundaries.shifts[2].endHour = 9;
    expect(() => evaluateSustainableCycle(mismatchedBoundaries)).toThrowError(
      new RangeError("shifts[2] boundaries must match schedule shift ab 0..8")
    );
  });

  it("requires duplicate-free exact active group sets while distinguishing unknown and inactive groups", () => {
    const duplicate = orderInvariantInput();
    duplicate.shifts[0].groupIds = ["A", "A"];
    expect(() => evaluateSustainableCycle(duplicate)).toThrowError(
      new RangeError("shifts[0].groupIds contains duplicate group ID A")
    );

    const missing = orderInvariantInput();
    missing.shifts[0].groupIds = ["A"];
    expect(() => evaluateSustainableCycle(missing)).toThrowError(
      new RangeError("shifts[0].groupIds is missing active group B for schedule shift ab")
    );

    const unknown = orderInvariantInput();
    unknown.shifts[0].groupIds = ["A", "unknown"];
    expect(() => evaluateSustainableCycle(unknown)).toThrowError(
      new RangeError("shifts[0].groupIds references unknown group unknown")
    );

    const inactive = orderInvariantInput();
    inactive.shifts[0].groupIds = ["A", "C"];
    expect(() => evaluateSustainableCycle(inactive)).toThrowError(
      new RangeError("shifts[0].groupIds contains inactive group C for schedule shift ab")
    );
  });

  it("uses a 36-hour three-shift schedule and permits non-overlapping operator reuse", () => {
    const input = emptyCycle({
      schedule: {
        cycleHours: 36,
        groups: [{ id: "A" }, { id: "B" }, { id: "C" }],
        shifts: [
          { id: "ab", startHour: 0, endHour: 12, activeGroupIds: ["A", "B"], recoveryGroupIds: ["C"] },
          { id: "bc", startHour: 12, endHour: 24, activeGroupIds: ["B", "C"], recoveryGroupIds: ["A"] },
          { id: "ca", startHour: 24, endHour: 36, activeGroupIds: ["C", "A"], recoveryGroupIds: ["B"] }
        ]
      },
      shifts: [
        { id: "ab", startHour: 0, endHour: 12, groupIds: ["A", "B"], assignments: [{ facilityId: "factory-1", operatorId: "worker" }], resourceContributions: [] },
        { id: "bc", startHour: 12, endHour: 24, groupIds: ["B", "C"], assignments: [], resourceContributions: [] },
        { id: "ca", startHour: 24, endHour: 36, groupIds: ["C", "A"], assignments: [{ facilityId: "factory-1", operatorId: "worker" }], resourceContributions: [] }
      ],
      initialMorale: { worker: 24 }
    });

    const result = evaluateSustainableCycle(input);
    expect(result.operators[0]).toMatchObject({ scheduledWorkHours: 24, productiveHours: 24 });
    expect(result.operators[0].timeline.at(-1)?.endHour).toBe(36);
  });

  it("uses uneven schedule boundaries without a hidden 12-hour or 24-hour cycle", () => {
    const input = emptyCycle({
      schedule: {
        cycleHours: 30,
        groups: [{ id: "A" }, { id: "B" }, { id: "C" }],
        shifts: [
          { id: "five", startHour: 0, endHour: 5, activeGroupIds: ["A"], recoveryGroupIds: [] },
          { id: "ten", startHour: 5, endHour: 15, activeGroupIds: ["B"], recoveryGroupIds: [] },
          { id: "fifteen", startHour: 15, endHour: 30, activeGroupIds: ["C"], recoveryGroupIds: [] }
        ]
      },
      shifts: [
        { id: "five", startHour: 0, endHour: 5, groupIds: ["A"], assignments: [{ facilityId: "factory-1", operatorId: "gold-five", moraleConsumptionPerHour: 0 }], resourceContributions: [contribution("five-gold", "factory-1", "factory-gold", createResourceLedger({ natural: { goldProduced: 1 } }))] },
        { id: "ten", startHour: 5, endHour: 15, groupIds: ["B"], assignments: [{ facilityId: "factory-1", operatorId: "gold-ten", moraleConsumptionPerHour: 0 }], resourceContributions: [contribution("ten-gold", "factory-1", "factory-gold", createResourceLedger({ natural: { goldProduced: 2 } }))] },
        { id: "fifteen", startHour: 15, endHour: 30, groupIds: ["C"], assignments: [{ facilityId: "factory-1", operatorId: "gold-fifteen", moraleConsumptionPerHour: 0 }], resourceContributions: [contribution("fifteen-gold", "factory-1", "factory-gold", createResourceLedger({ natural: { goldProduced: 3 } }))] }
      ],
      initialMorale: { "gold-five": 24, "gold-ten": 24, "gold-fifteen": 24 }
    });

    const result = evaluateSustainableCycle(input);

    expect(result.gold.timeline).toEqual([
      { hour: 0, gold: 0 },
      { hour: 5, gold: 1 },
      { hour: 15, gold: 3 },
      { hour: 30, gold: 6 }
    ]);
  });

  it("rejects exchange events at or beyond the cycle boundary", () => {
    for (const atHour of [24, 25]) {
      const input = emptyCycle({
        initialMorale: { source: 24, target: 10 },
        recoveryPlacements: [
          { dormitoryId: "dormitory-1", operatorId: "source", startHour: 12, endHour: 24 },
          {
            dormitoryId: "dormitory-1",
            operatorId: "target",
            startHour: 12,
            endHour: 24,
            moraleExchange: { atHour, sourceOperatorId: "source" }
          }
        ]
      });

      expect(() => evaluateSustainableCycle(input)).toThrow(/moraleExchange\.atHour must be within its recovery event/);
    }
  });

  it("rejects simultaneous duplicate occupancy with both facility and shift evidence", () => {
    const input = emptyCycle({ initialMorale: { "worker-a": 24 } });
    input.shifts[0].assignments.push(
      { facilityId: "factory-1", operatorId: "worker-a" },
      { facilityId: "factory-2", operatorId: "worker-a" }
    );

    const result = evaluateSustainableCycle(input);
    expect(result.failures).toContainEqual(expect.objectContaining({
      code: "simultaneous-operator-occupancy",
      operatorId: "worker-a",
      facilityId: "factory-2",
      shiftId: "shift-a",
      overlappingFacilityId: "factory-1",
      overlappingShiftId: "shift-a",
      overlapStartHour: 0,
      overlapEndHour: 12
    }));
  });
});
