import { describe, expect, it } from "vitest";
import { createDefaultState } from "../data/defaults";
import type {
  Assignment,
  RotationWindow,
  SupportFacilityType,
  SupportResourceScenarioInput,
  SupportResourceSource
} from "../types";
import { generateAssignmentPlan } from "./optimizer";
import { resolveSupportResourceScenario } from "./supportResourceScenario";

const duskSupportSource: SupportResourceSource = {
  id: "dusk-control-perception-shift-b",
  scheduleWindowId: "shift-b",
  operatorId: "char_2015_dusk",
  region: "JP",
  facility: {
    backing: "app-state",
    id: "control-1",
    type: "control",
    level: 5,
    slot: 1,
    capacity: 5
  },
  resourceKey: "perceptionInfo",
  amount: 10,
  provenance: {
    source: "approved normalized-theoretical scenario",
    detail: "Dusk contributes Perception Information while above the documented morale threshold"
  },
  assumptions: ["Dusk begins the window above 12 morale"],
  simplifications: ["Morale transitions are not integrated within this window"]
};

const whisperainSupportSource: SupportResourceSource = {
  id: "whisperain-office-perception-groups-a-b",
  scheduleWindowId: "groups-a-b",
  operatorId: "char_436_whispr",
  region: "JP",
  facility: {
    backing: "fixed-normalized-theoretical",
    id: "office-1",
    type: "office",
    level: 2,
    slot: 1,
    capacity: 1,
    provenance: {
      source: "approved JP normalized-theoretical scenario",
      detail: "A fixed Level 2 office with three recruitment slots"
    },
    assumptions: ["The office has three recruitment slots"],
    simplifications: ["Recruitment slot progression is fixed for this normalized window"]
  },
  resourceKey: "perceptionInfo",
  amount: 20,
  provenance: {
    source: "checked-in Whisperain HIRE base-skill metadata",
    detail: "Two recruitment slots after the initial slot yield 20 Perception Information"
  },
  assumptions: ["Whisperain occupies the office for groups-a-b"],
  simplifications: ["Office recruitment progression is fixed rather than fully simulated"]
};

function stateWithOwnedDusk() {
  const state = createDefaultState();
  state.roster.char_2015_dusk.owned = true;
  return state;
}

function capacityTestRotation(assignments: Assignment[]): RotationWindow[] {
  return [{
    label: "capacity-test",
    hours: 12,
    shiftId: "shift-b",
    startHour: 12,
    endHour: 24,
    activeGroupIds: [],
    recoveryGroupIds: [],
    incompleteGroupIds: [],
    assignments,
    recovery: []
  }];
}

function cyclicTestRotation(
  windows: readonly { id: string; startHour: number; endHour: number }[]
): RotationWindow[] {
  return windows.map((window) => ({
    label: window.id,
    hours: window.endHour - window.startHour,
    shiftId: window.id,
    startHour: window.startHour,
    endHour: window.endHour,
    activeGroupIds: [],
    recoveryGroupIds: [],
    incompleteGroupIds: [],
    assignments: [],
    recovery: []
  }));
}

function cyclicFactorySource(
  id: string,
  scheduleWindowId: string,
  operatorId: string,
  slot: number
): SupportResourceSource {
  return {
    ...duskSupportSource,
    id,
    scheduleWindowId,
    operatorId,
    amount: 0,
    facility: {
      backing: "app-state",
      id: "factory-1",
      type: "factory",
      level: 3,
      slot,
      capacity: 3
    }
  };
}

function cyclicFactoryState() {
  const state = createDefaultState();
  state.facilities = [
    { id: "factory-1", type: "factory", name: "Factory", slotCount: 3, product: "battleRecord" }
  ];
  state.schedule.cycleHours = 24;
  for (const operatorId of ["char_240_wyvern", "char_391_rosmon"]) {
    state.roster[operatorId].owned = true;
    state.roster[operatorId].elite = 2;
    state.roster[operatorId].level = 1;
  }
  return state;
}

function capacityTestAssignment(operatorId: string, facilityId = "control-1"): Assignment {
  return {
    facilityId,
    operatorId,
    skillId: "capacity-test",
    score: 0,
    efficiency: 0,
    fatigueHours: 12,
    recoveryHours: 0,
    reason: "capacity test"
  };
}

function controlCapacitySource(
  source: SupportResourceSource,
  overrides: Partial<SupportResourceSource> = {}
): SupportResourceSource {
  return {
    ...source,
    facility: { ...source.facility, capacity: 2 },
    ...overrides
  };
}

function stateWithOwnedWhisperain() {
  const state = createDefaultState();
  state.schedule = {
    cycleHours: 36,
    groups: [{ id: "A" }, { id: "B" }, { id: "C" }],
    shifts: [
      { id: "groups-a-b", startHour: 0, endHour: 12, activeGroupIds: ["A", "B"], recoveryGroupIds: ["C"] },
      { id: "groups-b-c", startHour: 12, endHour: 24, activeGroupIds: ["B", "C"], recoveryGroupIds: ["A"] },
      { id: "groups-c-a", startHour: 24, endHour: 36, activeGroupIds: ["C", "A"], recoveryGroupIds: ["B"] }
    ]
  };
  state.roster.char_436_whispr.owned = true;
  return state;
}

const fixedDormitoryOccupancy = {
  backing: "fixed-normalized-theoretical" as const,
  amount: 20,
  provenance: {
    source: "approved JP normalized-theoretical scenario",
    detail: "All four dormitories are treated as fully occupied throughout the normalized cycle"
  },
  assumptions: ["Dormitory occupancy remains 20 in every schedule window"],
  simplifications: ["Occupancy transitions are not simulated"]
};

function stateForExactWindowResourceEvaluation() {
  const state = createDefaultState();
  state.schedule = {
    cycleHours: 36,
    groups: [{ id: "A" }],
    shifts: [
      { id: "groups-a-b", startHour: 0, endHour: 12, activeGroupIds: ["A"], recoveryGroupIds: [] },
      { id: "groups-b-c", startHour: 12, endHour: 24, activeGroupIds: ["A"], recoveryGroupIds: [] },
      { id: "groups-c-a", startHour: 24, endHour: 36, activeGroupIds: ["A"], recoveryGroupIds: [] }
    ]
  };
  state.facilities = state.facilities.filter((facility) =>
    ["factory-1", "control-1", "dormitory-1", "dormitory-2", "dormitory-3", "dormitory-4"].includes(facility.id)
  ).map((facility) => facility.id === "factory-1" || facility.id === "control-1"
    ? { ...facility, slotCount: 1 }
    : facility
  );
  for (const operatorId of ["char_391_rosmon", "char_2015_dusk", "char_436_whispr", "char_002_amiya"]) {
    state.roster[operatorId].owned = true;
    state.roster[operatorId].elite = 2;
    state.roster[operatorId].level = 1;
  }
  return state;
}

function exactWindowScenario(includeFixedDormitoryOccupancy = true): SupportResourceScenarioInput {
  return {
    sources: [
      { ...whisperainSupportSource, scheduleWindowId: "groups-a-b", amount: 20 },
      {
        ...duskSupportSource,
        scheduleWindowId: "groups-b-c",
        amount: 10,
        facility: { ...duskSupportSource.facility, capacity: 1 }
      }
    ],
    ...(includeFixedDormitoryOccupancy
      ? { fixedContext: { dormitoryOccupancy: fixedDormitoryOccupancy } }
      : {})
  };
}

function stateForSupportAwareFactorySelection() {
  const state = stateForExactWindowResourceEvaluation();
  state.facilities = state.facilities.map((facility) =>
    facility.id === "control-1" ? { ...facility, slotCount: 2 } : facility
  );
  state.roster.char_240_wyvern.owned = true;
  state.roster.char_240_wyvern.elite = 0;
  state.roster.char_240_wyvern.level = 1;
  return state;
}

function supportAwareFactorySelectionScenario(): SupportResourceScenarioInput {
  const scenario = exactWindowScenario();
  return {
    ...scenario,
    sources: scenario.sources.map((source) =>
      source.operatorId === "char_2015_dusk"
        ? { ...source, facility: { ...source.facility, capacity: 2 } }
        : source
    )
  };
}

function selectedTeamSignature(plan: ReturnType<typeof generateAssignmentPlan>) {
  return plan.facilityPlans.map((facilityPlan) => ({
    facilityId: facilityPlan.facility.id,
    active: facilityPlan.assignments.map((assignment) => assignment.operatorId),
    alternatives: facilityPlan.alternatives.map((assignment) => assignment.operatorId)
  }));
}

function stateForFinalSourceConflictProbe() {
  const state = createDefaultState();
  state.facilities = [
    { id: "factory-1", type: "factory", name: "Factory", slotCount: 3, product: "battleRecord" }
  ];
  for (const rosterEntry of Object.values(state.roster)) rosterEntry.owned = false;
  for (const operatorId of ["char_391_rosmon", "char_240_wyvern", "char_2015_dusk"]) {
    state.roster[operatorId].owned = true;
    state.roster[operatorId].elite = 2;
    state.roster[operatorId].level = 1;
  }
  return state;
}

function finalSourceConflictScenario(): SupportResourceScenarioInput {
  return {
    sources: [{
      ...duskSupportSource,
      scheduleWindowId: "shift-a",
      amount: 20,
      facility: {
        backing: "fixed-normalized-theoretical",
        id: "fixed-control-1",
        type: "control",
        level: 5,
        slot: 1,
        capacity: 5,
        provenance: { source: "review probe", detail: "Fixed control center" },
        assumptions: [],
        simplifications: []
      }
    }]
  };
}

describe("support-resource scenario source resolution", () => {
  it("reserves a preliminarily valid fixed source before support-aware team selection", () => {
    const state = stateForFinalSourceConflictProbe();
    const ordinary = generateAssignmentPlan(state);
    const supported = generateAssignmentPlan(state, {
      supportResourceScenario: finalSourceConflictScenario()
    });
    const factoryOperators = (plan: typeof ordinary) =>
      plan.facilityPlans[0].assignments.map((assignment) => assignment.operatorId);

    expect(factoryOperators(ordinary)).toContain("char_240_wyvern");
    expect(factoryOperators(supported)).toContain("char_391_rosmon");
    expect(factoryOperators(supported)).toHaveLength(2);
    expect(factoryOperators(supported)).not.toContain("char_2015_dusk");
    expect(supported.supportResourceScenario?.complete).toBe(true);
    expect(supported.resources.status).toBe("complete");
  });

  it("reserves maximum simultaneous AppState source capacity rather than summing adjacent windows", () => {
    const state = stateForFinalSourceConflictProbe();
    state.roster.char_124_kroos.owned = true;
    state.roster.char_124_kroos.elite = 0;
    state.roster.char_124_kroos.level = 1;
    const appFactory = {
      backing: "app-state" as const,
      id: "factory-1",
      type: "factory" as const,
      level: 3,
      capacity: 3
    };
    const scenario: SupportResourceScenarioInput = {
      sources: [
        { ...duskSupportSource, id: "vanilla-a", scheduleWindowId: "shift-a", operatorId: "char_240_wyvern", amount: 0,
          facility: { ...appFactory, slot: 1 } },
        { ...duskSupportSource, id: "rosmontis-a", scheduleWindowId: "shift-a", operatorId: "char_391_rosmon", amount: 0,
          facility: { ...appFactory, slot: 2 } },
        { ...duskSupportSource, id: "kroos-b", scheduleWindowId: "shift-b", operatorId: "char_124_kroos", amount: 0,
          facility: { ...appFactory, slot: 1 } }
      ]
    };

    const plan = generateAssignmentPlan(state, { supportResourceScenario: scenario });
    const reversed = generateAssignmentPlan(state, {
      supportResourceScenario: { sources: [...scenario.sources].reverse() }
    });

    expect(plan.facilityPlans[0].facility.slotCount).toBe(3);
    expect(plan.facilityPlans[0].assignments).toHaveLength(1);
    expect(plan.facilityPlans[0].assignments.map((assignment) => assignment.operatorId)).toEqual([
      "char_2015_dusk"
    ]);
    expect(plan.facilityPlans[0].alternatives).toEqual([]);
    expect(plan.supportResourceScenario?.complete).toBe(true);
    expect(plan.resources.status).toBe("complete");
    expect(selectedTeamSignature(reversed)).toEqual(selectedTeamSignature(plan));
    expect(reversed.facilityPlans[0].facility.slotCount).toBe(3);
  });

  it("rejects a same-operator reservation across cycle-wrap overlap", () => {
    const state = createDefaultState();
    state.facilities = [
      { id: "factory-1", type: "factory", name: "Factory", slotCount: 3, product: "battleRecord" }
    ];
    for (const rosterEntry of Object.values(state.roster)) {
      rosterEntry.owned = true;
      rosterEntry.elite = 2;
      rosterEntry.level = 1;
    }
    state.schedule = {
      cycleHours: 24,
      groups: [{ id: "A" }, { id: "B" }],
      shifts: [
        { id: "wrap", startHour: 20, endHour: 28, activeGroupIds: ["A"], recoveryGroupIds: ["B"] },
        { id: "early", startHour: 0, endHour: 8, activeGroupIds: ["B"], recoveryGroupIds: ["A"] }
      ]
    };
    const appFactory = {
      backing: "app-state" as const,
      id: "factory-1",
      type: "factory" as const,
      level: 3,
      capacity: 3
    };
    const sources: SupportResourceSource[] = [
      {
        ...duskSupportSource,
        id: "vanilla-wrap",
        scheduleWindowId: "wrap",
        operatorId: "char_240_wyvern",
        amount: 0,
        facility: { ...appFactory, slot: 1 }
      },
      {
        ...duskSupportSource,
        id: "vanilla-early",
        scheduleWindowId: "early",
        operatorId: "char_240_wyvern",
        amount: 0,
        facility: { ...appFactory, slot: 2 }
      }
    ];

    const rotation = cyclicTestRotation([
      { id: "wrap", startHour: 20, endHour: 28 },
      { id: "early", startHour: 0, endHour: 8 }
    ]);
    const plan = resolveSupportResourceScenario(state, { sources }, rotation);
    const reversed = resolveSupportResourceScenario(state, { sources: [...sources].reverse() }, rotation);

    expect(plan.complete).toBe(false);
    expect(plan.sources.map((evidence) => evidence.status)).toEqual([
      "unresolved",
      "unresolved"
    ]);
    expect(plan.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "source-operator-reservation-conflict",
      "source-operator-reservation-conflict"
    ]);
    expect(reversed).toEqual(plan);
  });

  it("counts valid distinct cycle-wrap reservations while keeping active and alternative slot counts immutable", () => {
    const state = createDefaultState();
    state.facilities = [
      { id: "factory-1", type: "factory", name: "Factory", slotCount: 3, product: "battleRecord" }
    ];
    for (const rosterEntry of Object.values(state.roster)) {
      rosterEntry.owned = true;
      rosterEntry.elite = 2;
      rosterEntry.level = 1;
    }
    state.schedule = {
      cycleHours: 24,
      groups: [{ id: "A" }, { id: "B" }],
      shifts: [
        { id: "wrap", startHour: 20, endHour: 28, activeGroupIds: ["A"], recoveryGroupIds: ["B"] },
        { id: "early", startHour: 0, endHour: 8, activeGroupIds: ["B"], recoveryGroupIds: ["A"] }
      ]
    };
    const sources = [
      cyclicFactorySource("vanilla-wrap", "wrap", "char_240_wyvern", 1),
      cyclicFactorySource("rosmontis-early", "early", "char_391_rosmon", 2)
    ];

    const rotation = cyclicTestRotation([
      { id: "wrap", startHour: 20, endHour: 28 },
      { id: "early", startHour: 0, endHour: 8 }
    ]);
    const plan = resolveSupportResourceScenario(state, { sources }, rotation);
    const reversed = resolveSupportResourceScenario(state, { sources: [...sources].reverse() }, rotation);

    expect(plan.complete).toBe(true);
    expect(plan.sources.map((evidence) => evidence.status)).toEqual(["resolved", "resolved"]);
    expect(reversed).toEqual(plan);
  });
  it("uses valid cycle-weighted fixed resources to select Rosmontis without changing fallback selection", () => {
    const state = stateForSupportAwareFactorySelection();
    const scenario = supportAwareFactorySelectionScenario();
    const ordinary = generateAssignmentPlan(state);
    const supported = generateAssignmentPlan(state, { supportResourceScenario: scenario });
    const reversed = generateAssignmentPlan(state, {
      supportResourceScenario: { ...scenario, sources: [...scenario.sources].reverse() }
    });
    const invalidState = stateForSupportAwareFactorySelection();
    invalidState.roster.char_436_whispr.owned = false;
    const invalidOrdinary = generateAssignmentPlan(invalidState);
    const invalid = generateAssignmentPlan(invalidState, { supportResourceScenario: scenario });
    const factoryOperators = (plan: typeof ordinary) =>
      plan.facilityPlans.find((facilityPlan) => facilityPlan.facility.id === "factory-1")!
        .assignments.map((assignment) => assignment.operatorId);
    const material = ({ generatedAt: _generatedAt, ...plan }: typeof supported) => plan;

    expect(factoryOperators(ordinary)).toEqual(["char_240_wyvern"]);
    expect(factoryOperators(supported)).toEqual(["char_391_rosmon"]);
    expect(supported.facilityPlans.find((facilityPlan) => facilityPlan.facility.id === "factory-1")!
      .expectedEfficiency).toBeCloseTo(0.3);
    expect(supported.supportResourceScenario?.complete).toBe(true);

    expect(factoryOperators(invalid)).toEqual(factoryOperators(invalidOrdinary));
    expect(selectedTeamSignature(invalid)).toEqual(selectedTeamSignature(invalidOrdinary));
    expect(invalid.supportResourceScenario?.complete).toBe(false);
    expect(invalid.resources.status).toBe("incomplete");
    expect(invalid.resources.missing).toContainEqual(expect.objectContaining({
      code: "support-resource-unresolved",
      sourceId: whisperainSupportSource.id,
      diagnosticCode: "source-operator-unowned"
    }));

    expect(selectedTeamSignature(reversed)).toEqual(selectedTeamSignature(supported));
    expect(material(reversed)).toEqual(material(supported));
    expect(supported.windowFacilityEfficiencyEvaluations
      ?.filter((evaluation) => evaluation.facilityId === "factory-1")
      .map((evaluation) => evaluation.fixedResourceAmounts)).toEqual([
      { perceptionInfo: 20 },
      { perceptionInfo: 10 },
      {}
    ]);
  });

  it("rejects a distinct support reservation when ordinary assignments already fill an AppState facility", () => {
    const state = stateWithOwnedDusk();
    state.facilities.find((facility) => facility.id === "control-1")!.slotCount = 2;
    const result = resolveSupportResourceScenario(
      state,
      { sources: [controlCapacitySource(duskSupportSource)] },
      capacityTestRotation([
        capacityTestAssignment("char_002_amiya"),
        capacityTestAssignment("char_420_flamtl")
      ])
    );

    expect(result.complete).toBe(false);
    expect(result.sources[0]).toMatchObject({
      status: "unresolved",
      diagnostics: [{ code: "source-facility-capacity-conflict" }]
    });
  });

  it("treats an ordinary same-facility assignment of the source operator as fulfilling its reservation", () => {
    const state = stateWithOwnedDusk();
    state.facilities.find((facility) => facility.id === "control-1")!.slotCount = 2;
    const result = resolveSupportResourceScenario(
      state,
      { sources: [controlCapacitySource(duskSupportSource)] },
      capacityTestRotation([
        capacityTestAssignment("char_2015_dusk"),
        capacityTestAssignment("char_002_amiya")
      ])
    );

    expect(result.complete).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.sources[0].status).toBe("resolved");
  });

  it("resolves when unique ordinary assignments plus distinct valid support reservations equal capacity", () => {
    const state = stateWithOwnedDusk();
    state.facilities.find((facility) => facility.id === "control-1")!.slotCount = 2;
    const result = resolveSupportResourceScenario(
      state,
      { sources: [controlCapacitySource(duskSupportSource)] },
      capacityTestRotation([capacityTestAssignment("char_002_amiya")])
    );

    expect(result.complete).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  it("counts multiple distinct support slots and unique ordinary assignments deterministically", () => {
    const state = stateWithOwnedDusk();
    state.roster.char_002_amiya.owned = true;
    state.facilities.find((facility) => facility.id === "control-1")!.slotCount = 2;
    const sources = [
      controlCapacitySource(duskSupportSource),
      controlCapacitySource(duskSupportSource, {
        id: "amiya-control-capacity-shift-b",
        operatorId: "char_002_amiya",
        facility: { ...duskSupportSource.facility, slot: 2, capacity: 2 }
      })
    ];
    const rotation = capacityTestRotation([
      capacityTestAssignment("char_420_flamtl"),
      capacityTestAssignment("char_420_flamtl")
    ]);

    const forward = resolveSupportResourceScenario(state, { sources }, rotation);
    const reversed = resolveSupportResourceScenario(state, { sources: [...sources].reverse() }, rotation);

    expect(forward).toEqual(reversed);
    expect(forward.complete).toBe(false);
    expect(forward.sources.map((source) => source.status)).toEqual(["unresolved", "unresolved"]);
    expect(forward.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "source-facility-capacity-conflict",
      "source-facility-capacity-conflict"
    ]);
  });

  it("keeps ordinary plan output unchanged when the optional scenario is omitted", () => {
    const state = createDefaultState();
    const ordinaryPlan = generateAssignmentPlan(state);
    const explicitlyOmittedPlan = generateAssignmentPlan(state, {});
    const withoutGeneratedAt = ({ generatedAt: _generatedAt, ...material }: typeof ordinaryPlan) => material;

    expect("supportResourceScenario" in ordinaryPlan).toBe(false);
    expect("supportResourceScenario" in explicitlyOmittedPlan).toBe(false);
    expect("windowFacilityEfficiencyEvaluations" in ordinaryPlan).toBe(false);
    expect("evidence" in ordinaryPlan.resources).toBe(false);
    expect(ordinaryPlan.resources.windows.flatMap((window) => window.facilities).some((facility) =>
      "efficiencyEvaluation" in facility
    )).toBe(false);
    expect(withoutGeneratedAt(explicitlyOmittedPlan)).toEqual(withoutGeneratedAt(ordinaryPlan));
  });

  it("applies resolved resources only to their exact windows and records typed evidence once", () => {
    const state = stateForExactWindowResourceEvaluation();
    const plan = generateAssignmentPlan(state, {
      supportResourceScenario: exactWindowScenario()
    });
    const factoryWindows = plan.resources.windows.map((window) =>
      window.facilities.find((facility) => facility.facilityId === "factory-1")!
    );
    const factoryPlan = plan.facilityPlans.find((candidate) => candidate.facility.id === "factory-1")!;
    const evidence = plan.resources.evidence!;

    expect(plan.supportResourceScenario?.diagnostics).toEqual([]);
    expect(plan.supportResourceScenario?.complete).toBe(true);
    expect(plan.resources.status).toBe("complete");
    expect(factoryPlan.assignments).toContainEqual(expect.objectContaining({ operatorId: "char_391_rosmon" }));
    expect(factoryPlan.expectedEfficiency).toBeCloseTo(0.3);
    expect(plan.windowFacilityEfficiencyEvaluations?.every((evaluation) =>
      Number.isFinite(evaluation.additiveEfficiency)
    )).toBe(true);
    const fixedPerceptionByWindow = [20, 10, 0];
    // Group A works one continuous 36h block. Morale carries across the 12h boundaries,
    // so exact-window Rosmontis efficiency is the active fixed Perception amount at 1% each.
    const expectedScheduleAwareEfficiency = fixedPerceptionByWindow.map((amount) => amount / 100);
    const baseGoldPerWindow = 10;
    expect(factoryWindows.map((facility) => facility.additiveEfficiency))
      .toEqual(expectedScheduleAwareEfficiency.map((efficiency) => expect.closeTo(efficiency)));
    expect(factoryWindows.map((facility) => facility.ledger.goldProduced)).toEqual(
      expectedScheduleAwareEfficiency.map((efficiency) => expect.closeTo(baseGoldPerWindow * (1 + efficiency)))
    );
    expect(plan.resources.cycleLedger?.goldProduced).toBeCloseTo(
      expectedScheduleAwareEfficiency.reduce(
        (gold, efficiency) => gold + baseGoldPerWindow * (1 + efficiency),
        0
      )
    );
    expect(plan.resources.per24Ledger?.goldProduced).toBeCloseTo(
      plan.resources.cycleLedger!.goldProduced * 24 / state.schedule.cycleHours
    );
    expect(factoryWindows[0].additiveEfficiency).not.toBeCloseTo(factoryPlan.expectedEfficiency);
    expect(factoryWindows[0].ledger.goldProduced).not.toBeCloseTo(11);
    const expectedDailyValue = plan.windowFacilityEfficiencyEvaluations!.reduce((sum, evaluation) => {
      const facility = plan.facilityPlans.find((candidate) => candidate.facility.id === evaluation.facilityId)!.facility;
      const window = plan.rotation.find((candidate) => candidate.shiftId === evaluation.scheduleWindowId)!;
      const weight = facility.product === "gold"
        ? state.preference.gold
        : facility.product === "battleRecord"
          ? state.preference.battleRecord
          : facility.product === "lmd"
            ? state.preference.lmd
            : facility.product === "power"
              ? (state.preference.gold + state.preference.battleRecord + state.preference.lmd) / 3
              : 0.2;
      return sum + evaluation.additiveEfficiency * weight *
        (window.endHour - window.startHour) * 24 / plan.schedule.cycleHours;
    }, 0);
    expect(plan.dailyValue).toBeCloseTo(expectedDailyValue);
    expect(factoryWindows.map((facility) => facility.efficiencyEvaluation)).toEqual([
      expect.objectContaining({
        provenance: "optimizer-normal-team-reevaluation-with-schedule-aware-contiguous-work-and-resolved-support-context",
        fixedResourceAmounts: { perceptionInfo: 20 },
        fixedDormitoryOccupancy: 20
      }),
      expect.objectContaining({
        provenance: "optimizer-normal-team-reevaluation-with-schedule-aware-contiguous-work-and-resolved-support-context",
        fixedResourceAmounts: { perceptionInfo: 10 },
        fixedDormitoryOccupancy: 20
      }),
      expect.objectContaining({
        provenance: "optimizer-normal-team-reevaluation-with-schedule-aware-contiguous-work-and-resolved-support-context",
        fixedResourceAmounts: {},
        fixedDormitoryOccupancy: 20
      })
    ]);
    expect(evidence.fixedSources).toHaveLength(2);
    expect(evidence.fixedSources.filter((source) => source.sourceId === whisperainSupportSource.id)).toHaveLength(1);
    expect(evidence.fixedSources.filter((source) => source.sourceId === duskSupportSource.id)).toHaveLength(1);
    expect(evidence.fixedSources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceId: whisperainSupportSource.id,
        scheduleWindowId: "groups-a-b",
        operatorId: "char_436_whispr",
        facilityId: "office-1",
        facilityType: "office",
        facilityLevel: 2,
        facilitySlot: 1,
        resourceKey: "perceptionInfo",
        amount: 20,
        provenance: whisperainSupportSource.provenance,
        assumptions: whisperainSupportSource.assumptions,
        simplifications: whisperainSupportSource.simplifications
      }),
      expect.objectContaining({
        sourceId: duskSupportSource.id,
        scheduleWindowId: "groups-b-c",
        operatorId: "char_2015_dusk",
        facilityId: "control-1",
        facilityType: "control",
        facilityLevel: 5,
        facilitySlot: 1,
        resourceKey: "perceptionInfo",
        amount: 10
      })
    ]));
    expect(evidence.fixedContexts).toEqual([
      expect.objectContaining({
        contextKey: "dormitoryOccupancy",
        amount: 20,
        provenance: fixedDormitoryOccupancy.provenance,
        assumptions: fixedDormitoryOccupancy.assumptions,
        simplifications: fixedDormitoryOccupancy.simplifications
      })
    ]);
    expect(evidence.fixedContexts.filter((context) => context.contextKey === "dormitoryOccupancy")).toHaveLength(1);
    for (const ledger of [
      ...factoryWindows.map((facility) => facility.ledger),
      plan.resources.cycleLedger,
      plan.resources.per24Ledger
    ]) {
      expect(JSON.stringify(ledger)).not.toMatch(/perceptionInfo|thoughtChain/);
    }
  });

  it("uses fixed dormitory occupancy without fabricating dormitory assignments", () => {
    const state = stateForExactWindowResourceEvaluation();
    const ordinaryPlan = generateAssignmentPlan(state);
    const plan = generateAssignmentPlan(state, {
      supportResourceScenario: { sources: [], fixedContext: { dormitoryOccupancy: fixedDormitoryOccupancy } }
    });

    expect(plan.rotation.flatMap((window) => window.assignments).some((assignment) =>
      assignment.facilityId.startsWith("dormitory-")
    )).toBe(false);
    expect(ordinaryPlan.resources.windows.map((window) =>
      window.facilities.find((facility) => facility.facilityId === "factory-1")!.additiveEfficiency
    )).toEqual([expect.closeTo(0.1), expect.closeTo(0.1), expect.closeTo(0.1)]);
    const factoryWindows = plan.resources.windows.map((window) =>
      window.facilities.find((facility) => facility.facilityId === "factory-1")!
    );
    const windowHours = 12;
    const moraleCapacity = 24;
    const controlAdjustedMoralePerHour = 0.95;
    const fixedDormitoryEfficiency = 0.1;
    // Rosmontis works continuously for 36h. The first two windows consume 22.8 morale;
    // only the remaining 1.2 morale is productive in the third window.
    const finalWindowUptime = (moraleCapacity - 2 * windowHours * controlAdjustedMoralePerHour) /
      (windowHours * controlAdjustedMoralePerHour);
    const expectedEfficiencies = [
      fixedDormitoryEfficiency,
      fixedDormitoryEfficiency,
      fixedDormitoryEfficiency * finalWindowUptime
    ];
    expect(factoryWindows.map((facility) => facility.additiveEfficiency))
      .toEqual(expectedEfficiencies.map((efficiency) => expect.closeTo(efficiency)));
    expect(factoryWindows.map((facility) => facility.ledger.goldProduced))
      .toEqual(expectedEfficiencies.map((efficiency) => expect.closeTo(10 * (1 + efficiency))));
    expect(factoryWindows.map((facility) => facility.efficiencyEvaluation)).toEqual(
      plan.schedule.shifts.map(() => expect.objectContaining({
        provenance: "optimizer-normal-team-reevaluation-with-schedule-aware-contiguous-work-and-resolved-support-context",
        fixedResourceAmounts: {},
        fixedDormitoryOccupancy: fixedDormitoryOccupancy.amount
      }))
    );
    expect(plan.resources.evidence?.fixedContexts).toEqual([
      expect.objectContaining({ contextKey: "dormitoryOccupancy", amount: fixedDormitoryOccupancy.amount })
    ]);
  });

  it("keeps a same-facility fixed source reserved instead of generating an ordinary assignment", () => {
    const state = stateForExactWindowResourceEvaluation();
    state.roster.char_002_amiya.owned = false;
    const scenario = exactWindowScenario();
    scenario.sources = [scenario.sources.find((source) => source.operatorId === "char_2015_dusk")!];
    const plan = generateAssignmentPlan(state, { supportResourceScenario: scenario });
    const efficiencies = plan.resources.windows.map((window) =>
      window.facilities.find((facility) => facility.facilityId === "factory-1")!.additiveEfficiency
    );

    expect(plan.rotation.flatMap((window) => window.assignments).map((assignment) => assignment.operatorId))
      .not.toContain("char_2015_dusk");
    expect(plan.supportResourceScenario?.complete).toBe(true);
    expect(plan.supportResourceScenario?.diagnostics).toEqual([]);
    expect(plan.windowFacilityEfficiencyEvaluations?.filter((evaluation) => evaluation.facilityId === "factory-1")
      .map((evaluation) => evaluation.fixedResourceAmounts)).toEqual([
      {},
      { perceptionInfo: 10 },
      {}
    ]);
    const fixedPerceptionByWindow = [0, 10, 0];
    // The same Rosmontis assignment spans the full 36h block; there is no per-window
    // morale reset, and the reserved Dusk source contributes only in groups-b-c.
    const expectedEfficiencies = fixedPerceptionByWindow.map((amount) => amount / 100);
    expect(efficiencies).toEqual(expectedEfficiencies.map((efficiency) => expect.closeTo(efficiency)));
    expect(plan.resources.windows.map((window) =>
      window.facilities.find((facility) => facility.facilityId === "factory-1")!.ledger.goldProduced
    )).toEqual(expectedEfficiencies.map((efficiency) => expect.closeTo(10 * (1 + efficiency))));
    expect(plan.windowFacilityEfficiencyEvaluations?.filter((evaluation) => evaluation.facilityId === "factory-1")
      .map((evaluation) => evaluation.provenance)).toEqual(plan.schedule.shifts.map(() =>
      "optimizer-normal-team-reevaluation-with-schedule-aware-contiguous-work-and-resolved-support-context"
    ));
  });

  it("marks plan resources typed incomplete when a support source is unresolved", () => {
    const state = stateForExactWindowResourceEvaluation();
    state.roster.char_436_whispr.owned = false;
    const plan = generateAssignmentPlan(state, {
      supportResourceScenario: exactWindowScenario()
    });

    expect(plan.resources.status).toBe("incomplete");
    expect(plan.resources.cycleLedger).toBeUndefined();
    expect(plan.resources.per24Ledger).toBeUndefined();
    expect(plan.resources.missing).toContainEqual(expect.objectContaining({
      code: "support-resource-unresolved",
      sourceId: whisperainSupportSource.id,
      scheduleWindowId: "groups-a-b",
      diagnosticCode: "source-operator-unowned"
    }));
  });

  it.each([
    {
      label: "unowned",
      mutate: (state: ReturnType<typeof stateForExactWindowResourceEvaluation>, scenario: SupportResourceScenarioInput) => {
        state.roster.char_436_whispr.owned = false;
        return scenario;
      },
      diagnosticCode: "source-operator-unowned"
    },
    {
      label: "region-mismatched",
      mutate: (_state: ReturnType<typeof stateForExactWindowResourceEvaluation>, scenario: SupportResourceScenarioInput) => ({
        ...scenario,
        sources: scenario.sources.map((source, index) => index === 0 ? { ...source, region: "CN" as const } : source)
      }),
      diagnosticCode: "source-region-mismatch"
    },
    {
      label: "different-facility conflict",
      mutate: (_state: ReturnType<typeof stateForExactWindowResourceEvaluation>, scenario: SupportResourceScenarioInput) => ({
        ...scenario,
        sources: scenario.sources.map((source, index) => index === 1 ? {
          ...source,
          facility: {
            backing: "app-state" as const,
            id: "dormitory-1",
            type: "dormitory" as const,
            level: 5,
            slot: 1,
            capacity: 5
          }
        } : source)
      }),
      diagnosticCode: "source-operator-conflict"
    }
  ])("makes $label support failure a typed incomplete plan resource result", ({ mutate, diagnosticCode }) => {
    const state = stateForExactWindowResourceEvaluation();
    const scenario = mutate(state, exactWindowScenario());
    const plan = generateAssignmentPlan(state, { supportResourceScenario: scenario });

    expect(plan.resources.status).toBe("incomplete");
    expect(plan.resources.cycleLedger).toBeUndefined();
    expect(plan.resources.missing).toContainEqual(expect.objectContaining({
      code: "support-resource-unresolved",
      diagnosticCode
    }));
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])(
    "rejects invalid fixed dormitory occupancy %s as typed incomplete",
    (amount) => {
      const state = stateForExactWindowResourceEvaluation();
      const plan = generateAssignmentPlan(state, {
        supportResourceScenario: {
          sources: [],
          fixedContext: { dormitoryOccupancy: { ...fixedDormitoryOccupancy, amount } }
        }
      });

      expect(plan.supportResourceScenario?.complete).toBe(false);
      expect(plan.supportResourceScenario?.fixedContext?.dormitoryOccupancy).toMatchObject({
        status: "unresolved",
        diagnostics: [{ code: "fixed-context-amount-invalid", contextKey: "dormitoryOccupancy" }]
      });
      expect(plan.resources.status).toBe("incomplete");
      expect(plan.resources.cycleLedger).toBeUndefined();
      expect(plan.resources.missing).toContainEqual(expect.objectContaining({
        code: "support-fixed-context-unresolved",
        contextKey: "dormitoryOccupancy",
        diagnosticCode: "fixed-context-amount-invalid"
      }));
    }
  );

  it("keeps material exact-window evaluation and evidence deterministic under reversed source input", () => {
    const state = stateForExactWindowResourceEvaluation();
    const forward = generateAssignmentPlan(state, { supportResourceScenario: exactWindowScenario() });
    const scenario = exactWindowScenario();
    const reversed = generateAssignmentPlan(state, {
      supportResourceScenario: { ...scenario, sources: [...scenario.sources].reverse() }
    });
    const material = ({ generatedAt: _generatedAt, ...value }: typeof forward) => value;

    expect(material(reversed)).toEqual(material(forward));
  });

  it("resolves checked-in JP Dusk and preserves typed source evidence for the exact window", () => {
    const plan = generateAssignmentPlan(stateWithOwnedDusk(), {
      supportResourceScenario: { sources: [duskSupportSource] }
    });

    expect(plan.supportResourceScenario).toEqual({
      complete: true,
      sources: [
        {
          source: duskSupportSource,
          status: "resolved",
          reservation: {
            scheduleWindowId: "shift-b",
            operatorId: "char_2015_dusk",
            facilityId: "control-1",
            facilityType: "control",
            facilityLevel: 5,
            slot: 1,
            capacity: 5
          },
          diagnostics: []
        }
      ],
      diagnostics: []
    });
  });

  it("resolves owned JP Whisperain from checked-in HIRE metadata at a fixed office source", () => {
    const plan = generateAssignmentPlan(stateWithOwnedWhisperain(), {
      supportResourceScenario: { sources: [whisperainSupportSource] }
    });

    expect(plan.supportResourceScenario).toEqual({
      complete: true,
      sources: [
        {
          source: whisperainSupportSource,
          status: "resolved",
          reservation: {
            scheduleWindowId: "groups-a-b",
            operatorId: "char_436_whispr",
            facilityId: "office-1",
            facilityType: "office",
            facilityLevel: 2,
            slot: 1,
            capacity: 1
          },
          diagnostics: []
        }
      ],
      diagnostics: []
    });
  });

  it.each([
    ["factory", 3, 3, "char_240_wyvern"],
    ["trading", 3, 3, "char_302_glaze"],
    ["power", 3, 1, "char_277_sqrrel"],
    ["control", 5, 5, "char_002_amiya"],
    ["dormitory", 5, 5, "char_002_amiya"],
    ["reception", 3, 2, "char_009_12fce"],
    ["office", 3, 1, "char_436_whispr"]
  ] as const)("accepts the physical %s fixed-facility maximum", (type, level, capacity, operatorId) => {
    const state = createDefaultState();
    state.roster[operatorId].owned = true;
    state.roster[operatorId].elite = 2;
    state.roster[operatorId].level = 90;
    const source: SupportResourceSource = {
      ...duskSupportSource,
      id: `${type}-physical-maximum`,
      operatorId,
      facility: {
        backing: "fixed-normalized-theoretical",
        id: `fixed-${type}-1`,
        type,
        level,
        slot: 1,
        capacity,
        provenance: { source: "physical bound test", detail: `${type} maximum` },
        assumptions: [],
        simplifications: []
      }
    };

    const result = resolveSupportResourceScenario(state, { sources: [source] }, capacityTestRotation([]));

    expect(result.complete).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  it.each([
    ["factory", 3, 3, "char_240_wyvern"],
    ["trading", 3, 3, "char_302_glaze"],
    ["power", 3, 1, "char_277_sqrrel"],
    ["control", 5, 5, "char_002_amiya"],
    ["dormitory", 5, 5, "char_002_amiya"],
    ["reception", 3, 2, "char_009_12fce"],
    ["office", 3, 1, "char_436_whispr"]
  ] as const)("rejects %s fixed-facility level and capacity overflow", (type, maxLevel, maxCapacity, operatorId) => {
    const state = createDefaultState();
    state.roster[operatorId].owned = true;
    state.roster[operatorId].elite = 2;
    state.roster[operatorId].level = 90;
    const sourceFor = (level: number, capacity: number): SupportResourceSource => ({
      ...duskSupportSource,
      id: `${type}-${level}-${capacity}`,
      operatorId,
      facility: {
        backing: "fixed-normalized-theoretical",
        id: `fixed-${type}-1`,
        type: type as SupportFacilityType,
        level,
        slot: 1,
        capacity,
        provenance: { source: "physical bound test", detail: `${type} overflow` },
        assumptions: [],
        simplifications: []
      }
    });
    const rotation = capacityTestRotation([]);

    const levelOverflow = resolveSupportResourceScenario(
      state,
      { sources: [sourceFor(maxLevel + 1, maxCapacity)] },
      rotation
    );
    const capacityOverflow = resolveSupportResourceScenario(
      state,
      { sources: [sourceFor(maxLevel, maxCapacity + 1)] },
      rotation
    );

    expect(levelOverflow.complete).toBe(false);
    expect(levelOverflow.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "source-fixed-facility-invalid"
    ]);
    expect(capacityOverflow.complete).toBe(false);
    expect(capacityOverflow.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "source-fixed-facility-invalid"
    ]);
  });

  it.each([0, 1.5])("marks a fixed support facility with invalid level %s as typed incomplete", (level) => {
    const source: SupportResourceSource = {
      ...whisperainSupportSource,
      facility: { ...whisperainSupportSource.facility, level }
    };
    const plan = generateAssignmentPlan(stateWithOwnedWhisperain(), {
      supportResourceScenario: { sources: [source] }
    });

    expect(plan.supportResourceScenario?.complete).toBe(false);
    expect(plan.supportResourceScenario?.sources[0].status).toBe("unresolved");
    expect(plan.supportResourceScenario?.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "source-fixed-facility-invalid"
    ]);
  });

  it.each([0, 1.5])("marks a fixed support facility with invalid capacity %s as typed incomplete", (capacity) => {
    const source: SupportResourceSource = {
      ...whisperainSupportSource,
      facility: { ...whisperainSupportSource.facility, capacity }
    };
    const plan = generateAssignmentPlan(stateWithOwnedWhisperain(), {
      supportResourceScenario: { sources: [source] }
    });

    expect(plan.supportResourceScenario?.complete).toBe(false);
    expect(plan.supportResourceScenario?.sources[0].status).toBe("unresolved");
    expect(plan.supportResourceScenario?.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "source-fixed-facility-invalid"
    ]);
  });

  it("marks a fixed support facility with an unsupported type as typed incomplete", () => {
    const source: SupportResourceSource = {
      ...whisperainSupportSource,
      facility: {
        ...whisperainSupportSource.facility,
        type: "training"
      } as unknown as SupportResourceSource["facility"]
    };
    const plan = generateAssignmentPlan(stateWithOwnedWhisperain(), {
      supportResourceScenario: { sources: [source] }
    });

    expect(plan.supportResourceScenario?.complete).toBe(false);
    expect(plan.supportResourceScenario?.sources[0].status).toBe("unresolved");
    expect(plan.supportResourceScenario?.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "source-fixed-facility-invalid"
    ]);
  });

  it.each([0, 1.5, 2])("marks invalid fixed support facility slot %s as typed incomplete", (slot) => {
    const source: SupportResourceSource = {
      ...whisperainSupportSource,
      facility: { ...whisperainSupportSource.facility, slot }
    };
    const plan = generateAssignmentPlan(stateWithOwnedWhisperain(), {
      supportResourceScenario: { sources: [source] }
    });

    expect(plan.supportResourceScenario?.complete).toBe(false);
    expect(plan.supportResourceScenario?.sources[0].status).toBe("unresolved");
    expect(plan.supportResourceScenario?.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "source-facility-slot-out-of-range"
    ]);
  });

  it("marks unowned JP Whisperain at a fixed office source as typed incomplete", () => {
    const state = stateWithOwnedWhisperain();
    state.roster.char_436_whispr.owned = false;
    const plan = generateAssignmentPlan(state, {
      supportResourceScenario: { sources: [whisperainSupportSource] }
    });

    expect(plan.supportResourceScenario?.complete).toBe(false);
    expect(plan.supportResourceScenario?.sources[0]).toMatchObject({
      source: whisperainSupportSource,
      status: "unresolved",
      diagnostics: [{ code: "source-operator-unowned" }]
    });
    expect(plan.supportResourceScenario?.sources[0].reservation).toBeUndefined();
  });

  it("marks fixed-office Whisperain whose source region differs from AppState as typed incomplete", () => {
    const source: SupportResourceSource = { ...whisperainSupportSource, region: "CN" };
    const plan = generateAssignmentPlan(stateWithOwnedWhisperain(), {
      supportResourceScenario: { sources: [source] }
    });

    expect(plan.supportResourceScenario?.complete).toBe(false);
    expect(plan.supportResourceScenario?.sources[0]).toMatchObject({
      source,
      status: "unresolved",
      diagnostics: [{ code: "source-region-mismatch" }]
    });
    expect(plan.supportResourceScenario?.sources[0].reservation).toBeUndefined();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "marks a non-finite source amount %s as typed incomplete",
    (amount) => {
      const source: SupportResourceSource = { ...duskSupportSource, amount };
      const plan = generateAssignmentPlan(stateWithOwnedDusk(), {
        supportResourceScenario: { sources: [source] }
      });

      expect(plan.supportResourceScenario?.complete).toBe(false);
      expect(plan.supportResourceScenario?.sources[0].status).toBe("unresolved");
      expect(plan.supportResourceScenario?.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
        "source-amount-invalid"
      ]);
    }
  );

  it("marks a negative source amount as typed incomplete", () => {
    const source: SupportResourceSource = { ...duskSupportSource, amount: -1 };
    const plan = generateAssignmentPlan(stateWithOwnedDusk(), {
      supportResourceScenario: { sources: [source] }
    });

    expect(plan.supportResourceScenario?.complete).toBe(false);
    expect(plan.supportResourceScenario?.sources[0].status).toBe("unresolved");
    expect(plan.supportResourceScenario?.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "source-amount-invalid"
    ]);
  });

  it("accepts a zero source amount", () => {
    const source: SupportResourceSource = { ...duskSupportSource, amount: 0 };
    const plan = generateAssignmentPlan(stateWithOwnedDusk(), {
      supportResourceScenario: { sources: [source] }
    });

    expect(plan.supportResourceScenario?.complete).toBe(true);
    expect(plan.supportResourceScenario?.sources[0].status).toBe("resolved");
    expect(plan.supportResourceScenario?.diagnostics).toEqual([]);
  });

  it("marks an unowned source as typed incomplete evidence", () => {
    const plan = generateAssignmentPlan(createDefaultState(), {
      supportResourceScenario: { sources: [duskSupportSource] }
    });

    expect(plan.supportResourceScenario?.complete).toBe(false);
    expect(plan.supportResourceScenario?.sources[0]).toMatchObject({
      source: duskSupportSource,
      status: "unresolved",
      diagnostics: [
        {
          code: "source-operator-unowned",
          sourceId: duskSupportSource.id,
          scheduleWindowId: "shift-b"
        }
      ]
    });
    expect(plan.supportResourceScenario?.sources[0].reservation).toBeUndefined();
    expect(plan.supportResourceScenario?.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "source-operator-unowned"
    ]);
  });

  it("marks a source whose declared region differs from AppState as typed incomplete", () => {
    const source: SupportResourceSource = { ...duskSupportSource, region: "CN" };
    const plan = generateAssignmentPlan(stateWithOwnedDusk(), {
      supportResourceScenario: { sources: [source] }
    });

    expect(plan.supportResourceScenario?.complete).toBe(false);
    expect(plan.supportResourceScenario?.sources[0].status).toBe("unresolved");
    expect(plan.supportResourceScenario?.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "source-region-mismatch"
    ]);
  });

  it("marks a catalog operator unavailable in the AppState region as typed incomplete", () => {
    const source: SupportResourceSource = {
      ...duskSupportSource,
      id: "bellone-control-perception-shift-b",
      operatorId: "char_4037_demetr"
    };
    const state = createDefaultState();
    state.roster.char_4037_demetr.owned = true;

    const plan = generateAssignmentPlan(state, {
      supportResourceScenario: { sources: [source] }
    });

    expect(plan.supportResourceScenario?.complete).toBe(false);
    expect(plan.supportResourceScenario?.sources[0].status).toBe("unresolved");
    expect(plan.supportResourceScenario?.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "source-operator-region-unavailable"
    ]);
  });

  it("marks a source with a missing schedule window as typed incomplete", () => {
    const source: SupportResourceSource = {
      ...duskSupportSource,
      scheduleWindowId: "missing-window"
    };
    const plan = generateAssignmentPlan(stateWithOwnedDusk(), {
      supportResourceScenario: { sources: [source] }
    });

    expect(plan.supportResourceScenario?.complete).toBe(false);
    expect(plan.supportResourceScenario?.sources[0].status).toBe("unresolved");
    expect(plan.supportResourceScenario?.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "schedule-window-not-found"
    ]);
  });

  it("marks a source operator missing from the checked-in catalog as typed incomplete", () => {
    const source: SupportResourceSource = {
      ...duskSupportSource,
      operatorId: "char_missing_support"
    };
    const state = createDefaultState();
    state.roster.char_missing_support = {
      owned: true,
      elite: 0,
      level: 1,
      potential: 1,
      moduleEnabled: false
    };
    const plan = generateAssignmentPlan(state, {
      supportResourceScenario: { sources: [source] }
    });

    expect(plan.supportResourceScenario?.complete).toBe(false);
    expect(plan.supportResourceScenario?.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "source-operator-not-found"
    ]);
  });

  it("marks a support facility slot outside its capacity as typed incomplete", () => {
    const source: SupportResourceSource = {
      ...duskSupportSource,
      facility: { ...duskSupportSource.facility, slot: 6 }
    };
    const plan = generateAssignmentPlan(stateWithOwnedDusk(), {
      supportResourceScenario: { sources: [source] }
    });

    expect(plan.supportResourceScenario?.complete).toBe(false);
    expect(plan.supportResourceScenario?.sources[0].reservation).toBeUndefined();
    expect(plan.supportResourceScenario?.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "source-facility-slot-out-of-range"
    ]);
  });

  it("marks a source facility missing from AppState as typed incomplete", () => {
    const source: SupportResourceSource = {
      ...duskSupportSource,
      facility: { ...duskSupportSource.facility, id: "control-missing" }
    };
    const plan = generateAssignmentPlan(stateWithOwnedDusk(), {
      supportResourceScenario: { sources: [source] }
    });

    expect(plan.supportResourceScenario?.complete).toBe(false);
    expect(plan.supportResourceScenario?.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "source-facility-not-found"
    ]);
  });

  it("marks a source facility type that contradicts AppState as typed incomplete", () => {
    const source: SupportResourceSource = {
      ...duskSupportSource,
      facility: { ...duskSupportSource.facility, type: "power" }
    };
    const plan = generateAssignmentPlan(stateWithOwnedDusk(), {
      supportResourceScenario: { sources: [source] }
    });

    expect(plan.supportResourceScenario?.complete).toBe(false);
    expect(plan.supportResourceScenario?.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "source-facility-mismatch"
    ]);
  });

  it("marks a source facility level that contradicts the AppState facility model as typed incomplete", () => {
    const source: SupportResourceSource = {
      ...duskSupportSource,
      facility: { ...duskSupportSource.facility, level: 4 }
    };
    const plan = generateAssignmentPlan(stateWithOwnedDusk(), {
      supportResourceScenario: { sources: [source] }
    });

    expect(plan.supportResourceScenario?.complete).toBe(false);
    expect(plan.supportResourceScenario?.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "source-facility-mismatch"
    ]);
  });

  it("marks a source facility capacity that contradicts AppState as typed incomplete", () => {
    const source: SupportResourceSource = {
      ...duskSupportSource,
      facility: { ...duskSupportSource.facility, capacity: 4 }
    };
    const plan = generateAssignmentPlan(stateWithOwnedDusk(), {
      supportResourceScenario: { sources: [source] }
    });

    expect(plan.supportResourceScenario?.complete).toBe(false);
    expect(plan.supportResourceScenario?.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "source-facility-mismatch"
    ]);
  });

  it("requires an unlocked base skill applicable to the declared source facility", () => {
    const source: SupportResourceSource = {
      ...duskSupportSource,
      facility: {
        backing: "app-state",
        id: "power-1",
        type: "power",
        level: 3,
        slot: 1,
        capacity: 1
      }
    };
    const plan = generateAssignmentPlan(stateWithOwnedDusk(), {
      supportResourceScenario: { sources: [source] }
    });

    expect(plan.supportResourceScenario?.complete).toBe(false);
    expect(plan.supportResourceScenario?.sources[0].status).toBe("unresolved");
    expect(plan.supportResourceScenario?.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "source-operator-facility-ineligible"
    ]);
  });

  it("rejects a facility skill that is still locked at the roster elite and level", () => {
    const source: SupportResourceSource = {
      ...duskSupportSource,
      id: "amiya-dormitory-support-shift-b",
      operatorId: "char_002_amiya",
      facility: {
        backing: "app-state",
        id: "dormitory-1",
        type: "dormitory",
        level: 5,
        slot: 1,
        capacity: 5
      }
    };
    const state = createDefaultState();
    state.roster.char_002_amiya = {
      owned: true,
      elite: 0,
      level: 1,
      potential: 1,
      moduleEnabled: false
    };
    const plan = generateAssignmentPlan(state, {
      supportResourceScenario: { sources: [source] }
    });

    expect(plan.supportResourceScenario?.complete).toBe(false);
    expect(plan.supportResourceScenario?.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "source-operator-facility-ineligible"
    ]);
  });

  it("marks both sources that double-book one support slot in an overlapping window as typed incomplete", () => {
    const secondSource: SupportResourceSource = {
      ...duskSupportSource,
      id: "amiya-control-perception-shift-b",
      operatorId: "char_002_amiya"
    };
    const state = stateWithOwnedDusk();
    state.roster.char_002_amiya.owned = true;

    const plan = generateAssignmentPlan(state, {
      supportResourceScenario: { sources: [duskSupportSource, secondSource] }
    });

    expect(plan.supportResourceScenario?.complete).toBe(false);
    expect(plan.supportResourceScenario?.sources.map((evidence) => evidence.status)).toEqual([
      "unresolved",
      "unresolved"
    ]);
    expect(plan.supportResourceScenario?.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "source-facility-slot-conflict",
      "source-facility-slot-conflict"
    ]);
  });

  it("marks both sources that reserve one operator in the same window as typed incomplete", () => {
    const secondSource: SupportResourceSource = {
      ...duskSupportSource,
      id: "dusk-control-perception-shift-b-slot-2",
      facility: { ...duskSupportSource.facility, slot: 2 }
    };
    const plan = generateAssignmentPlan(stateWithOwnedDusk(), {
      supportResourceScenario: { sources: [duskSupportSource, secondSource] }
    });

    expect(plan.supportResourceScenario?.complete).toBe(false);
    expect(plan.supportResourceScenario?.sources.map((evidence) => evidence.status)).toEqual([
      "unresolved",
      "unresolved"
    ]);
    expect(plan.supportResourceScenario?.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "source-operator-reservation-conflict",
      "source-operator-reservation-conflict"
    ]);
  });


  it("marks both same-operator sources unresolved across a cyclic wrap overlap", () => {
    const state = cyclicFactoryState();
    const rotation = cyclicTestRotation([
      { id: "wrap", startHour: 20, endHour: 28 },
      { id: "early", startHour: 0, endHour: 8 }
    ]);
    const sources = [
      cyclicFactorySource("vanilla-wrap", "wrap", "char_240_wyvern", 1),
      cyclicFactorySource("vanilla-early", "early", "char_240_wyvern", 2)
    ];

    const forward = resolveSupportResourceScenario(state, { sources }, rotation);
    const reversed = resolveSupportResourceScenario(state, { sources: [...sources].reverse() }, rotation);

    expect(forward.complete).toBe(false);
    expect(forward.sources.map((evidence) => evidence.status)).toEqual(["unresolved", "unresolved"]);
    expect(forward.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "source-operator-reservation-conflict",
      "source-operator-reservation-conflict"
    ]);
    expect(reversed).toEqual(forward);
  });

  it("marks both distinct-operator sources unresolved when one AppState slot overlaps across a cyclic wrap", () => {
    const state = cyclicFactoryState();
    const rotation = cyclicTestRotation([
      { id: "wrap", startHour: 20, endHour: 28 },
      { id: "early", startHour: 0, endHour: 8 }
    ]);
    const sources = [
      cyclicFactorySource("vanilla-wrap", "wrap", "char_240_wyvern", 1),
      cyclicFactorySource("rosmontis-early", "early", "char_391_rosmon", 1)
    ];

    const forward = resolveSupportResourceScenario(state, { sources }, rotation);
    const reversed = resolveSupportResourceScenario(state, { sources: [...sources].reverse() }, rotation);

    expect(forward.complete).toBe(false);
    expect(forward.sources.map((evidence) => evidence.status)).toEqual(["unresolved", "unresolved"]);
    expect(forward.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "source-facility-slot-conflict",
      "source-facility-slot-conflict"
    ]);
    expect(reversed).toEqual(forward);
  });

  it.each([
    [
      "cycle boundary",
      [{ id: "late", startHour: 20, endHour: 24 }, { id: "early", startHour: 0, endHour: 8 }]
    ],
    [
      "ordinary boundary",
      [{ id: "early", startHour: 0, endHour: 8 }, { id: "later", startHour: 8, endHour: 16 }]
    ]
  ])("allows same-operator sources adjacent at a %s", (_label, windows) => {
    const state = cyclicFactoryState();
    const sources = [
      cyclicFactorySource("vanilla-first", windows[0].id, "char_240_wyvern", 1),
      cyclicFactorySource("vanilla-second", windows[1].id, "char_240_wyvern", 2)
    ];

    const result = resolveSupportResourceScenario(state, { sources }, cyclicTestRotation(windows));

    expect(result.complete).toBe(true);
    expect(result.sources.map((evidence) => evidence.status)).toEqual(["resolved", "resolved"]);
  });

  it("allows the same operator in truly non-overlapping cyclic windows", () => {
    const state = cyclicFactoryState();
    const rotation = cyclicTestRotation([
      { id: "first", startHour: 2, endHour: 5 },
      { id: "second", startHour: 10, endHour: 14 }
    ]);
    const sources = [
      cyclicFactorySource("vanilla-first", "first", "char_240_wyvern", 1),
      cyclicFactorySource("vanilla-second", "second", "char_240_wyvern", 2)
    ];

    const result = resolveSupportResourceScenario(state, { sources }, rotation);

    expect(result.complete).toBe(true);
    expect(result.sources.map((evidence) => evidence.status)).toEqual(["resolved", "resolved"]);
  });

  it.each([
    { id: "full-cycle", startHour: 4, endHour: 28 },
    { id: "longer-than-cycle", startHour: -3, endHour: 25 }
  ])("treats $id duration as overlapping every non-empty window", (coveringWindow) => {
    const state = cyclicFactoryState();
    const rotation = cyclicTestRotation([
      coveringWindow,
      { id: "non-empty", startHour: 12, endHour: 13 }
    ]);
    const sources = [
      cyclicFactorySource("vanilla-covering", coveringWindow.id, "char_240_wyvern", 1),
      cyclicFactorySource("vanilla-non-empty", "non-empty", "char_240_wyvern", 2)
    ];

    const result = resolveSupportResourceScenario(state, { sources }, rotation);

    expect(result.complete).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "source-operator-reservation-conflict",
      "source-operator-reservation-conflict"
    ]);
  });

  it("marks every source with a duplicate source ID as typed incomplete", () => {
    const duplicateIdSource: SupportResourceSource = {
      ...duskSupportSource,
      operatorId: "char_002_amiya",
      facility: { ...duskSupportSource.facility, slot: 2 }
    };
    const state = stateWithOwnedDusk();
    state.roster.char_002_amiya.owned = true;
    const plan = generateAssignmentPlan(state, {
      supportResourceScenario: { sources: [duskSupportSource, duplicateIdSource] }
    });

    expect(plan.supportResourceScenario?.complete).toBe(false);
    expect(plan.supportResourceScenario?.sources.map((evidence) => evidence.status)).toEqual([
      "unresolved",
      "unresolved"
    ]);
    expect(plan.supportResourceScenario?.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "source-id-duplicate",
      "source-id-duplicate"
    ]);
  });

  it("returns the same complete material evaluation when source input order is reversed", () => {
    const sources: SupportResourceSource[] = [
      { ...duskSupportSource, id: "zeta-source", amount: -1 },
      {
        ...duskSupportSource,
        id: "alpha-source",
        operatorId: "char_002_amiya",
        facility: { ...duskSupportSource.facility, slot: 2, capacity: 4 }
      }
    ];
    const state = stateWithOwnedDusk();
    state.roster.char_002_amiya.owned = true;

    const forward = generateAssignmentPlan(state, {
      supportResourceScenario: { sources }
    }).supportResourceScenario;
    const reversed = generateAssignmentPlan(state, {
      supportResourceScenario: { sources: [...sources].reverse() }
    }).supportResourceScenario;

    expect(reversed).toEqual(forward);
  });

  it("reserves a generated-plan source instead of assigning it ordinarily", () => {
    const source: SupportResourceSource = {
      ...duskSupportSource,
      id: "amiya-control-support-shift-a",
      scheduleWindowId: "shift-a",
      operatorId: "char_002_amiya"
    };
    const state = createDefaultState();
    state.roster.char_002_amiya.owned = true;

    const plan = generateAssignmentPlan(state, {
      supportResourceScenario: { sources: [source] }
    });
    const shift = plan.rotation.find((window) => window.shiftId === "shift-a")!;

    expect(shift.assignments.some((assignment) => assignment.operatorId === "char_002_amiya")).toBe(false);
    expect(plan.supportResourceScenario?.complete).toBe(true);
    expect(plan.supportResourceScenario?.sources[0]).toMatchObject({
      source,
      status: "resolved",
      reservation: {
        scheduleWindowId: "shift-a",
        operatorId: "char_002_amiya",
        facilityId: "control-1"
      },
      diagnostics: []
    });
    expect(plan.supportResourceScenario?.diagnostics).toEqual([]);
  });

  it("prevents a preliminarily valid source from being assigned to a different facility", () => {
    const source: SupportResourceSource = {
      ...duskSupportSource,
      id: "amiya-dormitory-support-shift-a",
      scheduleWindowId: "shift-a",
      operatorId: "char_002_amiya",
      facility: {
        backing: "app-state",
        id: "dormitory-1",
        type: "dormitory",
        level: 5,
        slot: 1,
        capacity: 5
      }
    };
    const state = createDefaultState();
    state.roster.char_002_amiya.owned = true;

    const plan = generateAssignmentPlan(state, {
      supportResourceScenario: { sources: [source] }
    });
    const shift = plan.rotation.find((window) => window.shiftId === "shift-a")!;

    expect(shift.assignments.some((assignment) => assignment.operatorId === "char_002_amiya")).toBe(false);
    expect(plan.supportResourceScenario?.complete).toBe(true);
    expect(plan.supportResourceScenario?.sources[0].status).toBe("resolved");
    expect(plan.supportResourceScenario?.diagnostics).toEqual([]);
  });
});
