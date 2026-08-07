import { describe, expect, it } from "vitest";
import type { Assignment, FacilityPlan, FacilitySlot, RotationWindow, ScheduleState } from "../types";
import { evaluatePlanResources } from "./planResourceEvaluator";

const schedule: ScheduleState = {
  cycleHours: 24,
  groups: [{ id: "A" }, { id: "B" }],
  shifts: [
    { id: "day", startHour: 0, endHour: 12, activeGroupIds: ["A"], recoveryGroupIds: ["B"] },
    { id: "night", startHour: 12, endHour: 24, activeGroupIds: ["B"], recoveryGroupIds: ["A"] }
  ]
};

function assignment(facilityId: string, operatorId: string, efficiency = 0): Assignment {
  return {
    facilityId,
    operatorId,
    skillId: `${operatorId}-skill`,
    score: efficiency * 100,
    efficiency,
    fatigueHours: 24,
    recoveryHours: 6,
    reason: "synthetic plan-resource fixture"
  };
}

function facilityPlan(
  facility: FacilitySlot,
  activeEfficiency = 0,
  alternativeEfficiency = activeEfficiency
): FacilityPlan {
  return {
    facility,
    assignments: [assignment(facility.id, `${facility.id}-A`, activeEfficiency)],
    alternatives: [assignment(facility.id, `${facility.id}-B`, alternativeEfficiency)],
    expectedEfficiency: activeEfficiency,
    alternativeExpectedEfficiency: alternativeEfficiency,
    score: activeEfficiency * 100
  };
}

function rotation(plans: readonly FacilityPlan[], override: Partial<RotationWindow>[] = []): RotationWindow[] {
  return schedule.shifts.map((shift, index) => {
    const useAlternative = index === 1;
    return {
      label: shift.id,
      hours: shift.endHour - shift.startHour,
      shiftId: shift.id,
      startHour: shift.startHour,
      endHour: shift.endHour,
      activeGroupIds: [...shift.activeGroupIds],
      recoveryGroupIds: [...shift.recoveryGroupIds],
      incompleteGroupIds: [],
      assignments: plans.flatMap((plan) => useAlternative ? plan.alternatives : plan.assignments),
      recovery: plans.flatMap((plan) => useAlternative ? plan.assignments : plan.alternatives),
      ...override[index]
    };
  });
}

function input(plans: FacilityPlan[], override: Partial<{ schedule: ScheduleState; rotation: RotationWindow[] }> = {}) {
  return {
    schedule: override.schedule ?? schedule,
    facilityPlans: plans,
    rotation: override.rotation ?? rotation(plans)
  };
}

describe("assignment plan resource evaluation", () => {
  it("calculates a base-rate two-factory/two-trading 2x12 plan exactly once per window", () => {
    const plans = [
      facilityPlan({ id: "factory-gold", type: "factory", name: "Gold", slotCount: 1, product: "gold" }),
      facilityPlan({ id: "factory-record", type: "factory", name: "Records", slotCount: 1, product: "battleRecord" }),
      facilityPlan({ id: "trading-1", type: "trading", name: "Trading 1", slotCount: 1, product: "lmd" }),
      facilityPlan({ id: "trading-2", type: "trading", name: "Trading 2", slotCount: 1, product: "lmd" })
    ];

    const result = evaluatePlanResources(input(plans));
    const naturalOrders = 2 * (24 * 60 / 203.4);
    const droneOrders = 240 * 3 / 203.4;

    expect(result.status).toBe("complete");
    expect(result.windows).toHaveLength(2);
    expect(result.windows.flatMap((window) => window.facilities)).toHaveLength(8);
    expect(result.cycleLedger?.natural).toEqual(expect.objectContaining({
      goldProduced: 20,
      battleRecordExp: 8000
    }));
    expect(result.cycleLedger?.natural.goldConsumed).toBeCloseTo(naturalOrders * 2.9);
    expect(result.cycleLedger?.natural.lmd).toBeCloseTo(naturalOrders * 1450);
    expect(result.cycleLedger?.drone.goldConsumed).toBeCloseTo(droneOrders * 2.9);
    expect(result.cycleLedger?.drone.lmd).toBeCloseTo(droneOrders * 1450);
    expect(result.cycleLedger).toMatchObject({
      dronesGenerated: 240,
      dronesUsed: 240
    });
    expect(result.cycleLedger?.goldNetChange).toBeCloseTo(
      20 - (naturalOrders + droneOrders) * 2.9
    );
    expect(result.per24Ledger).toEqual(result.cycleLedger);
    expect(result.drone?.targetFacilityId).toBe("trading-1");
    expect(result.assumptions).toMatchObject({
      initialDrones: 0,
      allocationTimingAssumption: "slot-batch-consumption",
      scheduleFeasibility: "evaluated-at-slot-boundaries"
    });
  });

  it("uses active and alternative evaluated efficiencies for their own window once", () => {
    const plan = facilityPlan(
      { id: "factory-gold", type: "factory", name: "Gold", slotCount: 1, product: "gold" },
      0.2,
      0.5
    );

    const result = evaluatePlanResources(input([plan]));

    expect(result.windows.map((window) => window.facilities[0].additiveEfficiency)).toEqual([0.2, 0.5]);
    expect(result.windows.map((window) => window.facilities[0].ledger.goldProduced)).toEqual([12, 15]);
    expect(result.cycleLedger?.goldProduced).toBe(27);
  });

  it("keeps calculable window evidence but omits aggregates for an unpopulated third group", () => {
    const threeGroupSchedule: ScheduleState = {
      cycleHours: 24,
      groups: [{ id: "A" }, { id: "B" }, { id: "C" }],
      shifts: [
        { id: "one", startHour: 0, endHour: 8, activeGroupIds: ["A"], recoveryGroupIds: ["B", "C"] },
        { id: "two", startHour: 8, endHour: 16, activeGroupIds: ["B"], recoveryGroupIds: ["A", "C"] },
        { id: "three", startHour: 16, endHour: 24, activeGroupIds: ["C"], recoveryGroupIds: ["A", "B"] }
      ]
    };
    const plan = facilityPlan({ id: "factory-gold", type: "factory", name: "Gold", slotCount: 1, product: "gold" });
    const windows: RotationWindow[] = threeGroupSchedule.shifts.map((shift, index) => ({
      label: shift.id,
      hours: 8,
      shiftId: shift.id,
      startHour: shift.startHour,
      endHour: shift.endHour,
      activeGroupIds: [...shift.activeGroupIds],
      recoveryGroupIds: [...shift.recoveryGroupIds],
      incompleteGroupIds: index === 2 ? ["C"] : [],
      assignments: index === 0 ? plan.assignments : index === 1 ? plan.alternatives : [],
      recovery: []
    }));

    const result = evaluatePlanResources(input([plan], { schedule: threeGroupSchedule, rotation: windows }));

    expect(result.status).toBe("incomplete");
    expect(result.windows.slice(0, 2).every((window) => window.facilities.length === 1)).toBe(true);
    expect(result.windows[2].facilities).toEqual([]);
    expect(result.cycleLedger).toBeUndefined();
    expect(result.per24Ledger).toBeUndefined();
    expect(result.missing).toContainEqual(expect.objectContaining({
      code: "schedule-group-unpopulated",
      path: "rotation/three/groups/C"
    }));
  });

  it.each([
    { type: "fixedSpecialOrder", kind: "pepe", gold: 2, lmd: 1000, hours: 1, affectedByEfficiency: false } as const,
    { type: "defaultedOrderRule" } as const,
    { type: "highValueOrderProbability", level: "increased", warmupHours: 5 } as const
  ])("marks unsupported $type trading quantity effects missing instead of treating them as zero", (effect) => {
    const plan = facilityPlan({ id: "trading-1", type: "trading", name: "Trading", slotCount: 1, product: "lmd" });
    plan.assignments[0].tradingOrderEffects = [effect];
    const windows = rotation([plan]);

    const result = evaluatePlanResources(input([plan], { rotation: windows }));

    expect(result.status).toBe("incomplete");
    expect(result.cycleLedger).toBeUndefined();
    expect(result.per24Ledger).toBeUndefined();
    expect(result.missing).toContainEqual(expect.objectContaining({
      code: "unsupported-trading-order-effect",
      path: `rotation/day/facilities/trading-1/operators/${plan.assignments[0].operatorId}/effects/${plan.assignments[0].skillId}/tradingOrderEffects/0/${effect.type}${"kind" in effect ? `/${effect.kind}` : ""}`,
      operatorId: plan.assignments[0].operatorId,
      effectId: `${plan.assignments[0].skillId}:tradingOrderEffects[0]:${effect.type}${"kind" in effect ? `:${effect.kind}` : ""}`,
      effectIndex: 0,
      effectType: effect.type,
      ...("kind" in effect ? { effectKind: effect.kind } : {})
    }));
  });

  it("distinguishes multiple unsupported trading effects on the same skill with stable evidence", () => {
    const plan = facilityPlan({ id: "trading-1", type: "trading", name: "Trading", slotCount: 1, product: "lmd" });
    plan.assignments[0].tradingOrderEffects = [
      { type: "fixedSpecialOrder", kind: "pepe", gold: 2, lmd: 1000, hours: 1, affectedByEfficiency: false },
      { type: "highValueOrderProbability", level: "increased", warmupHours: 5 }
    ];

    const result = evaluatePlanResources(input([plan], { rotation: rotation([plan]) }));
    const unsupported = result.missing.filter((reason) => reason.code === "unsupported-trading-order-effect");

    expect(result.status).toBe("incomplete");
    expect(result.cycleLedger).toBeUndefined();
    expect(result.per24Ledger).toBeUndefined();
    expect(unsupported).toEqual([
      expect.objectContaining({
        path: `rotation/day/facilities/trading-1/operators/${plan.assignments[0].operatorId}/effects/${plan.assignments[0].skillId}/tradingOrderEffects/0/fixedSpecialOrder/pepe`,
        effectId: `${plan.assignments[0].skillId}:tradingOrderEffects[0]:fixedSpecialOrder:pepe`,
        effectIndex: 0,
        effectType: "fixedSpecialOrder",
        effectKind: "pepe"
      }),
      expect.objectContaining({
        path: `rotation/day/facilities/trading-1/operators/${plan.assignments[0].operatorId}/effects/${plan.assignments[0].skillId}/tradingOrderEffects/1/highValueOrderProbability`,
        effectId: `${plan.assignments[0].skillId}:tradingOrderEffects[1]:highValueOrderProbability`,
        effectIndex: 1,
        effectType: "highValueOrderProbability"
      })
    ]);
  });

  it("is deterministic and does not mutate the plan inputs", () => {
    const plans = [
      facilityPlan({ id: "trading-2", type: "trading", name: "Trading 2", slotCount: 1, product: "lmd" }, 0.25),
      facilityPlan({ id: "trading-1", type: "trading", name: "Trading 1", slotCount: 1, product: "lmd" }, 0.25),
      facilityPlan({ id: "power-1", type: "power", name: "Power", slotCount: 1, product: "power" }, 0.15)
    ];
    const evaluationInput = input(plans);
    const before = structuredClone(evaluationInput);

    const first = evaluatePlanResources(evaluationInput);
    const second = evaluatePlanResources(evaluationInput);

    expect(first).toEqual(second);
    expect(first.drone).toMatchObject({ targetFacilityId: "trading-1", dronesAllocated: 276 });
    expect(first.per24Ledger).toMatchObject({ dronesGenerated: 276, dronesUsed: 276 });
    expect(evaluationInput).toEqual(before);
  });
});
