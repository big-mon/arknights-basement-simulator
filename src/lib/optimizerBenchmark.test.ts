import { describe, expect, it } from "vitest";
import { optimizerBenchmarkFixtures } from "../data/optimizer-benchmarks";
import { operatorAvailabilitySnapshot } from "./operatorAvailability";
import { isPassFailEligible, validateOptimizerBenchmark } from "./optimizerBenchmark";

const validResourceBenchmark = () => ({
  kind: "resource-output",
  scope: "facility-team",
  id: "example-output",
  region: "JP",
  referenceProvenance: { version: "example composition v1", observedAt: "2026-08-04" },
  runtimeDataProvenance: { operatorAvailabilitySourceCommit: "7faf192d15eeac8b236c561a1938679f4642279e" },
  confidence: "corroborated",
  sources: [
    {
      url: "https://example.com/source",
      title: "Example source",
      accessedAt: "2026-08-04",
      language: "en",
      role: "throughput"
    }
  ],
  assumptions: {
    layout: "243",
    drones: "excluded",
    facilityProducts: ["lmd"],
    objectiveProfile: "lmd",
    notes: ["A documented assumption"]
  },
  roster: { mode: "explicit", operatorIds: ["char_009_12fce"] },
  rotation: {
    cycleHours: 24,
    shifts: [
      {
        id: "shift-1",
        durationHours: 24,
        assignments: { "trading-1": { operatorIds: ["char_009_12fce"] } }
      }
    ]
  },
  expected: {
    output: { lmd: 100 },
    formulas: ["lmd = 100"],
    tolerance: { type: "absolute", value: 0 }
  }
});

type FacilityFixture = {
  id: string;
  type: "tradingPost" | "factory" | "powerPlant" | "controlCenter" | "reception" | "office";
  level: number;
  capacity: number;
  product?: "lmd" | "gold" | "battleRecord";
};

const create243Facilities = (): FacilityFixture[] => [
  ...[1, 2].map((number) => ({ id: `trading-post-${number}`, type: "tradingPost" as const, product: "lmd" as const, level: 3, capacity: 3 })),
  ...[1, 2].map((number) => ({ id: `factory-gold-${number}`, type: "factory" as const, product: "gold" as const, level: 3, capacity: 3 })),
  ...[1, 2].map((number) => ({ id: `factory-record-${number}`, type: "factory" as const, product: "battleRecord" as const, level: 3, capacity: 3 })),
  ...[1, 2, 3].map((number) => ({ id: `power-${number}`, type: "powerPlant" as const, level: 3, capacity: 1 })),
  { id: "control", type: "controlCenter", level: 5, capacity: 5 },
  { id: "reception", type: "reception", level: 3, capacity: 2 },
  { id: "office", type: "office", level: 3, capacity: 1 }
];

const createAssignments = (facilities: FacilityFixture[], operatorIds: string[]) => {
  let offset = 0;
  return Object.fromEntries(facilities.map((facility) => {
    const assigned = operatorIds.slice(offset, offset + facility.capacity);
    offset += facility.capacity;
    return [facility.id, { operatorIds: assigned }];
  }));
};

const validStrictBenchmark = () => {
  const facilities = create243Facilities();
  const fullCycleOperatorIds = operatorAvailabilitySnapshot.regions.JP.operatorIds.slice(0, 88);
  const workerGroups = [0, 1, 2].map((group) => fullCycleOperatorIds.slice(group * 29, (group + 1) * 29));
  const helperId = fullCycleOperatorIds[87];
  const recoveryCounts = [19, 20, 20];
  const statePlans = [
    [
      { activity: "work", start: 24, end: 18, delta: -6 },
      { activity: "idle", start: 24, end: 24, delta: 0 },
      { activity: "recovery", start: 18, end: 24, delta: 6 }
    ],
    [
      { activity: "recovery", start: 18, end: 24, delta: 6 },
      { activity: "work", start: 24, end: 18, delta: -6 },
      { activity: "idle", start: 24, end: 24, delta: 0 }
    ],
    [
      { activity: "idle", start: 24, end: 24, delta: 0 },
      { activity: "recovery", start: 18, end: 24, delta: 6 },
      { activity: "work", start: 24, end: 18, delta: -6 }
    ]
  ] as const;
  const resources = [
    { goldProduced: 60, goldConsumed: 40, battleRecordExp: 10000, lmd: 20000, dronesGenerated: 10, dronesUsed: 5, droneLmd: 1000, droneGoldConsumed: 1, goldInventoryStart: 50, goldInventoryEnd: 70, droneInventoryStart: 20, droneInventoryEnd: 25 },
    { goldProduced: 40, goldConsumed: 50, battleRecordExp: 20000, lmd: 30000, dronesGenerated: 10, dronesUsed: 15, droneLmd: 3000, droneGoldConsumed: 3, goldInventoryStart: 70, goldInventoryEnd: 60, droneInventoryStart: 25, droneInventoryEnd: 20 },
    { goldProduced: 30, goldConsumed: 25, battleRecordExp: 15000, lmd: 25000, dronesGenerated: 10, dronesUsed: 10, droneLmd: 2000, droneGoldConsumed: 2, goldInventoryStart: 60, goldInventoryEnd: 65, droneInventoryStart: 20, droneInventoryEnd: 20 }
  ];
  const operatorStates = statePlans.map((shiftPlans) => [
    ...workerGroups.flatMap((group, groupIndex) => group.map((operatorId, operatorIndex) => {
      const planned = shiftPlans[groupIndex];
      const plan = operatorIndex >= recoveryCounts[groupIndex] && planned.activity !== "idle"
        ? { activity: planned.activity === "work" ? "work" as const : "idle" as const, start: 24, end: 24, delta: 0 }
        : planned;
      return {
        operatorId,
        activity: plan.activity,
        durationHours: 12,
        moraleStart: plan.start,
        moraleDelta: plan.delta,
        moraleEnd: plan.end,
      };
    })),
    {
      operatorId: helperId,
      activity: (["exchange-support", "recovery", "idle"] as const)[shiftPlans === statePlans[0] ? 0 : shiftPlans === statePlans[1] ? 1 : 2],
      durationHours: 12,
      moraleStart: shiftPlans === statePlans[1] ? 18 : 24,
      moraleDelta: shiftPlans === statePlans[0] ? -6 : shiftPlans === statePlans[1] ? 6 : 0,
      moraleEnd: shiftPlans === statePlans[0] ? 18 : 24
    }
  ]);
  const exchangeTargetId = workerGroups[2][20];
  Object.assign(operatorStates[0].find((state) => state.operatorId === exchangeTargetId)!, {
    activity: "exchange-support",
    moraleStart: 0,
    moraleDelta: 24,
    moraleEnd: 24
  });
  Object.assign(operatorStates[2].find((state) => state.operatorId === exchangeTargetId)!, {
    moraleStart: 24,
    moraleDelta: -24,
    moraleEnd: 0
  });
  Object.assign(operatorStates[0].find((state) => state.operatorId === helperId)!, {
    moraleStart: 24,
    moraleDelta: -24,
    moraleEnd: 0
  });
  Object.assign(operatorStates[1].find((state) => state.operatorId === helperId)!, {
    moraleStart: 0,
    moraleDelta: 24,
    moraleEnd: 24
  });

  return ({
  ...validResourceBenchmark(),
  scope: "full-base",
  contractVersion: "phase1-pass-fail-v1",
  sources: [{
    url: "https://example.com/source",
    title: "Example source",
    accessedAt: "2026-08-04",
    language: "en",
    role: "composition",
    contentSha256: "a".repeat(64)
  }],
  assumptions: {
    layout: "243",
    drones: "trading-post-1",
    facilityProducts: ["gold", "battleRecord"],
    objectiveProfile: "balanced",
    assumptionBundle: {
      id: "phase1-project-assumptions",
      version: 1,
      contentSha256: "b".repeat(64),
      allowedAssumptionIds: [
        "phase1.high-value-order-probability.v1",
        "phase1.perception-information-factory-efficiency.v1",
        "phase1.signed-equivalent-morale-delta.v1"
      ]
    },
    notes: ["All drones go to trading posts"]
  },
  roster: {
    mode: "explicit",
    operatorIds: [...fullCycleOperatorIds]
  },
  evaluationWindow: {
    start: {
      mode: "absolute",
      timestamp: "2026-08-04T00:00:00+09:00",
      sourceIndex: 0
    },
    durationHours: 24,
    shiftHours: 12,
    workSlotCount: 2,
    workerGroupCount: 3,
    shiftIds: ["shift-1", "shift-2"]
  },
  rotation: {
    cycleHours: 36,
    workerGroupCount: 3,
    compositionSourceIndex: 0,
    fullCycleSourceIndex: 0,
    moraleCap: 24,
    fullCycleOperatorIds,
    facilities,
    supportDependencies: [],
    supportContexts: [
      ...[1, 2, 3, 4].map((number) => ({
        id: `dormitory-${number}`,
        type: "dormitory" as const,
        activity: "recovery" as const,
        level: 5,
        capacity: 5
      })),
      { id: "exchange-support", type: "operator-support", activity: "exchange-support", capacity: 1 }
    ],
    goldInventory: { initial: 50, final: 65, boundaryPolicy: "carryover" },
    droneInventory: { initial: 20, final: 20, boundaryPolicy: "return-to-initial" },
    shifts: ["group-a", "group-b", "group-c"].map((groupId, index) => ({
      id: `shift-${index + 1}`,
      durationHours: 12,
      workerGroupIds: [["group-a", "group-b"], ["group-b", "group-c"], ["group-c", "group-a"]][index],
      factoryProducts: { gold: 2, battleRecord: 2 },
      assignments: createAssignments(facilities, workerGroups[index]),
      operatorStates: operatorStates[index],
      resources: { ...resources[index], droneDestination: "trading-post-1" }
    }))
  },
  expected: {
    outputBasis: "concrete-24-hour-window",
    output: { goldProduced: 100, goldConsumed: 90, goldNetChange: 10, battleRecordExp: 30000, lmd: 50000, dronesGenerated: 20, dronesUsed: 20, droneLmd: 4000, droneGoldConsumed: 4 },
    formulas: ["Concrete output from shift-1 and shift-2"],
    tolerance: { type: "relative", value: 0.01 }
  }
  });
};

describe("validateOptimizerBenchmark", () => {
  it("accepts a minimal valid formula benchmark", () => {
    const result = validateOptimizerBenchmark({
      kind: "formula",
      id: "example-formula",
      region: "GLOBAL",
      referenceProvenance: { version: "example formula v1", observedAt: "2026-08-04" },
      confidence: "confirmed",
      sources: [
        {
          url: "https://example.com/source",
          title: "Example source",
          accessedAt: "2026-08-04",
          language: "en",
          role: "formula"
        }
      ],
      assumptions: {
        layout: "243",
        drones: "not-applicable",
        facilityProducts: ["gold"],
        objectiveProfile: "formula-only",
        notes: ["A documented assumption"]
      },
      formulas: [{ id: "constant", expression: "1", expectedValue: 1, unit: "count" }]
    });

    expect(result.ok).toBe(true);
  });

  it("accepts a valid resource-output benchmark", () => {
    expect(validateOptimizerBenchmark(validResourceBenchmark()).ok).toBe(true);
  });

  it("accepts a source-available explicit roster identity absent from the optimizer catalog", () => {
    const benchmark = validResourceBenchmark();
    benchmark.roster.operatorIds = ["char_2014_nian"];
    benchmark.rotation.shifts[0].assignments["trading-1"].operatorIds = ["char_2014_nian"];

    expect(validateOptimizerBenchmark(benchmark)).toEqual(expect.objectContaining({ ok: true }));
  });

  it("rejects an arbitrary runtime operator availability commit", () => {
    const benchmark = validResourceBenchmark();
    benchmark.runtimeDataProvenance.operatorAvailabilitySourceCommit = "jp-runtime-commit";

    expect(validateOptimizerBenchmark(benchmark)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        "runtimeDataProvenance.operatorAvailabilitySourceCommit must be exactly 40 hexadecimal characters",
        "runtimeDataProvenance.operatorAvailabilitySourceCommit must equal JP operator availability boundary 7faf192d15eeac8b236c561a1938679f4642279e"
      ])
    }));
  });

  it("rejects a full runtime operator availability commit from the wrong region", () => {
    const benchmark = validResourceBenchmark();
    benchmark.runtimeDataProvenance.operatorAvailabilitySourceCommit =
      "81c6d458a1778a9ba878a95c4e6fe48fb4254041";

    expect(validateOptimizerBenchmark(benchmark)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        "runtimeDataProvenance.operatorAvailabilitySourceCommit must equal JP operator availability boundary 7faf192d15eeac8b236c561a1938679f4642279e"
      ])
    }));
  });

  it("requires runtime operator availability provenance on resource-output benchmarks", () => {
    const benchmark = validResourceBenchmark() as Record<string, unknown>;
    delete benchmark.runtimeDataProvenance;

    expect(validateOptimizerBenchmark(benchmark)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        "runtimeDataProvenance.operatorAvailabilitySourceCommit is required for resource-output benchmark and must equal JP operator availability boundary 7faf192d15eeac8b236c561a1938679f4642279e"
      ])
    }));
  });

  it("rejects duplicate, unknown, and region-unavailable explicit roster operator IDs with precise paths", () => {
    const benchmark = validResourceBenchmark();
    benchmark.roster.operatorIds = [
      "char_009_12fce",
      "char_009_12fce",
      "char_unknown",
      "char_4228_closur"
    ];

    expect(validateOptimizerBenchmark(benchmark)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        "roster.operatorIds[1] duplicates roster.operatorIds[0]",
        "roster.operatorIds[2] contains unknown operator ID char_unknown",
        "roster.operatorIds[3] contains operator ID char_4228_closur unavailable in JP"
      ])
    }));
  });

  it("rejects an unknown rotation assignment operator", () => {
    const benchmark = validResourceBenchmark();
    benchmark.rotation.shifts[0].assignments["trading-1"].operatorIds = ["char_unknown"];

    expect(validateOptimizerBenchmark(benchmark)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        "rotation.shifts[0].assignments.trading-1.operatorIds[0] contains unknown operator ID char_unknown"
      ])
    }));
  });

  it("rejects a region-valid rotation assignment operator omitted from the explicit roster", () => {
    const benchmark = validResourceBenchmark();
    benchmark.rotation.shifts[0].assignments["trading-1"].operatorIds = ["char_002_amiya"];

    expect(validateOptimizerBenchmark(benchmark)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        "rotation.shifts[0].assignments.trading-1.operatorIds[0] contains operator ID char_002_amiya outside the explicit roster"
      ])
    }));
  });

  it("still validates catalog and region references for an all-unlocked roster", () => {
    const benchmark = validResourceBenchmark();
    Object.assign(benchmark, { roster: { mode: "all-unlocked" } });
    benchmark.rotation.shifts[0].assignments["trading-1"].operatorIds = ["char_4228_closur"];

    expect(validateOptimizerBenchmark(benchmark)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        "rotation.shifts[0].assignments.trading-1.operatorIds[0] contains operator ID char_4228_closur unavailable in JP"
      ])
    }));
  });

  it.each([
    ["region", { region: "KR" }],
    ["confidence", { confidence: "likely" }],
    ["reference provenance", { referenceProvenance: { version: "example", observedAt: "August 4" } }],
    ["sources", { sources: [{ url: "not-a-url" }] }],
    ["assumptions", { assumptions: { layout: "153" } }]
  ])("rejects malformed %s metadata", (_field, replacement) => {
    expect(validateOptimizerBenchmark({ ...validResourceBenchmark(), ...replacement }).ok).toBe(false);
  });

  it("rejects the old ambiguous version metadata instead of migrating it implicitly", () => {
    const benchmark = validResourceBenchmark() as Record<string, unknown>;
    delete benchmark.referenceProvenance;
    benchmark.version = { gameDataVersion: "could-be-reference-or-runtime", observedAt: "2026-08-04" };

    expect(validateOptimizerBenchmark(benchmark)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        "version is ambiguous; use referenceProvenance and runtimeDataProvenance"
      ])
    }));
  });

  it("accepts distinct reference and runtime provenance without substituting either string", () => {
    const benchmark = validResourceBenchmark();

    expect(benchmark.referenceProvenance.version).not.toBe(
      benchmark.runtimeDataProvenance.operatorAvailabilitySourceCommit
    );
    expect(validateOptimizerBenchmark(benchmark).ok).toBe(true);
  });

  it("rejects shifts whose durations do not match the cycle", () => {
    const benchmark = validResourceBenchmark();
    benchmark.rotation.shifts[0].durationHours = 12;

    expect(validateOptimizerBenchmark(benchmark).ok).toBe(false);
  });

  it.each([-1, Number.POSITIVE_INFINITY, Number.NaN])("rejects invalid resource output %s", (lmd) => {
    const benchmark = validResourceBenchmark();
    benchmark.expected.output.lmd = lmd;

    expect(validateOptimizerBenchmark(benchmark).ok).toBe(false);
  });

  it.each([-25, 0, 25])("accepts signed finite gold net change %s in expected and shift reference outputs", (goldNetChange) => {
    const benchmark = validResourceBenchmark();
    Object.assign(benchmark.expected.output, { goldNetChange });
    Object.assign(benchmark.rotation.shifts[0], {
      referenceOutputPer24Hours: { goldNetChange }
    });

    expect(validateOptimizerBenchmark(benchmark)).toEqual(expect.objectContaining({ ok: true }));
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects non-finite gold net change %s",
    (goldNetChange) => {
      const benchmark = validResourceBenchmark();
      Object.assign(benchmark.expected.output, { goldNetChange });

      expect(validateOptimizerBenchmark(benchmark)).toEqual(expect.objectContaining({
        ok: false,
        errors: expect.arrayContaining([
          "expected.output.goldNetChange must be a finite number"
        ])
      }));
    }
  );

  it.each([
    "goldProduced",
    "goldConsumed",
    "battleRecordExp",
    "dronesGenerated",
    "dronesUsed",
    "droneLmd",
    "droneGoldConsumed"
  ])("continues to reject negative %s flow", (resource) => {
    const benchmark = validResourceBenchmark();
    Object.assign(benchmark.expected.output, { [resource]: -1 });

    expect(validateOptimizerBenchmark(benchmark)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        `expected.output.${resource} must be a finite non-negative number`
      ])
    }));
  });

  it("rejects an explicit roster without operator IDs", () => {
    const benchmark = validResourceBenchmark();
    benchmark.roster = { mode: "explicit", operatorIds: [] };

    expect(validateOptimizerBenchmark(benchmark).ok).toBe(false);
  });

  it("validates the relative-tolerance zero fallback", () => {
    const benchmark = validResourceBenchmark();
    benchmark.expected.output.lmd = 0;
    Object.assign(benchmark.expected.tolerance, {
      type: "relative",
      value: 0.01,
      zeroExpectedAbsolute: 0.25
    });

    expect(validateOptimizerBenchmark(benchmark).ok).toBe(true);

    Object.assign(benchmark.expected.tolerance, { zeroExpectedAbsolute: -1 });
    expect(validateOptimizerBenchmark(benchmark)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        "expected.tolerance.zeroExpectedAbsolute must be a finite non-negative number for relative tolerance"
      ])
    }));
  });

  it("requires a zero fallback when relative tolerance covers an expected zero", () => {
    const benchmark = validResourceBenchmark();
    benchmark.expected.output.lmd = 0;
    Object.assign(benchmark.expected.tolerance, { type: "relative", value: 0.01 });

    expect(validateOptimizerBenchmark(benchmark)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        "expected.tolerance.zeroExpectedAbsolute is required when an expected resource is zero"
      ])
    }));
  });

  it("validates explicitly declared equivalent compositions", () => {
    const benchmark = validResourceBenchmark();
    benchmark.roster.operatorIds.push("char_002_amiya");
    Object.assign(benchmark.expected, {
      equivalentCompositions: [{
        shifts: [{
          shiftId: "shift-1",
          assignments: { "trading-1": ["char_002_amiya"] }
        }]
      }]
    });

    expect(validateOptimizerBenchmark(benchmark).ok).toBe(true);

    Object.assign(benchmark.expected, {
      equivalentCompositions: [{
        shifts: [{ shiftId: "missing", assignments: { "trading-1": [] } }]
      }]
    });
    expect(validateOptimizerBenchmark(benchmark).ok).toBe(false);
  });

  it("rejects an equivalent-composition operator unavailable in the region and outside the explicit roster", () => {
    const benchmark = validResourceBenchmark();
    Object.assign(benchmark.expected, {
      equivalentCompositions: [{
        shifts: [{
          shiftId: "shift-1",
          assignments: { "trading-1": ["char_4228_closur"] }
        }]
      }]
    });

    expect(validateOptimizerBenchmark(benchmark)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        "expected.equivalentCompositions[0].shifts[0].assignments.trading-1[0] contains operator ID char_4228_closur unavailable in JP",
        "expected.equivalentCompositions[0].shifts[0].assignments.trading-1[0] contains operator ID char_4228_closur outside the explicit roster"
      ])
    }));
  });

  it("rejects a strict evaluation window whose duration is not exactly 24 hours", () => {
    const benchmark = validStrictBenchmark();
    benchmark.evaluationWindow.durationHours = 12 as 24;

    expect(validateOptimizerBenchmark(benchmark)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        "evaluationWindow.durationHours must be exactly 24"
      ])
    }));
    expect(isPassFailEligible(benchmark)).toBe(false);
  });

  it("accepts both absolute and source-relative evaluation boundaries", () => {
    const absolute = validStrictBenchmark();
    const sourceRelative = validStrictBenchmark();
    Object.assign(sourceRelative.evaluationWindow, { start: {
      mode: "source-relative",
      sourceIndex: 0,
      shiftId: "shift-1"
    } });

    expect(validateOptimizerBenchmark(absolute).ok).toBe(true);
    expect(isPassFailEligible(absolute)).toBe(true);
    expect(validateOptimizerBenchmark(sourceRelative).ok).toBe(true);
    expect(isPassFailEligible(sourceRelative)).toBe(true);
  });

  it("accepts the real Issue #53-shaped assumption bundle", () => {
    const benchmark = validStrictBenchmark();

    expect(benchmark.assumptions.assumptionBundle).toEqual({
      id: "phase1-project-assumptions",
      version: 1,
      contentSha256: "b".repeat(64),
      allowedAssumptionIds: [
        "phase1.high-value-order-probability.v1",
        "phase1.perception-information-factory-efficiency.v1",
        "phase1.signed-equivalent-morale-delta.v1"
      ]
    });
    expect(validateOptimizerBenchmark(benchmark).ok).toBe(true);
    expect(isPassFailEligible(benchmark)).toBe(true);
  });

  it("accepts the actual generated v2 assumption-bundle tuple through the strict validator", async () => {
    const artifactV2 = (await import("../data/phase1-project-assumption-bundle-v2.json")).default;
    const benchmark = validStrictBenchmark();
    benchmark.assumptions.assumptionBundle = {
      id: artifactV2.id,
      version: artifactV2.version,
      contentSha256: artifactV2.contentSha256,
      allowedAssumptionIds: [...artifactV2.allowedAssumptionIds]
    };

    expect(validateOptimizerBenchmark(benchmark).ok).toBe(true);
    expect(isPassFailEligible(benchmark)).toBe(true);
  });

  it("accepts signed work, recovery, idle, and a conserved exchange-support morale pair", () => {
    const benchmark = validStrictBenchmark();
    const cappedRecovery = benchmark.rotation.shifts[0].operatorStates.find(
      (state) => state.activity === "recovery"
    );
    const exchangeDeltas = benchmark.rotation.shifts[0].operatorStates
      .filter((state) => state.activity === "exchange-support")
      .map((state) => state.moraleDelta);

    expect(cappedRecovery).toEqual(expect.objectContaining({
      moraleStart: 18,
      moraleDelta: 6,
      moraleEnd: 24
    }));
    expect(benchmark.rotation.shifts[0].operatorStates.some((state) => state.activity === "idle")).toBe(true);
    expect(exchangeDeltas).toEqual([24, -24]);
    expect(validateOptimizerBenchmark(benchmark)).toEqual(expect.objectContaining({ ok: true }));
    expect(isPassFailEligible(benchmark)).toBe(true);
  });

  it("rejects a lone exchange actor with a stable odd-count diagnostic", () => {
    const benchmark = validStrictBenchmark();
    const exchangeTargetId = benchmark.rotation.shifts[0].operatorStates.find(
      (state) => state.activity === "exchange-support" && state.moraleDelta > 0
    )!.operatorId;
    Object.assign(benchmark.rotation.shifts[0].operatorStates.find((state) => state.operatorId === exchangeTargetId)!, {
      activity: "idle",
      moraleStart: 24,
      moraleDelta: 0,
      moraleEnd: 24
    });
    Object.assign(benchmark.rotation.shifts[2].operatorStates.find((state) => state.operatorId === exchangeTargetId)!, {
      moraleStart: 24,
      moraleDelta: 0,
      moraleEnd: 24
    });

    expect(validateOptimizerBenchmark(benchmark)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        "rotation.shifts[0].operatorStates exchange-support actor count 1 must be even"
      ])
    }));
  });

  it("rejects a non-conserved exchange pair with a stable aggregate diagnostic", () => {
    const benchmark = validStrictBenchmark();
    const exchangeSourceId = benchmark.rotation.shifts[0].operatorStates.find(
      (state) => state.activity === "exchange-support" && state.moraleDelta < 0
    )!.operatorId;
    Object.assign(benchmark.rotation.shifts[0].operatorStates.find((state) => state.operatorId === exchangeSourceId)!, {
      moraleDelta: -23,
      moraleEnd: 1
    });
    Object.assign(benchmark.rotation.shifts[1].operatorStates.find((state) => state.operatorId === exchangeSourceId)!, {
      moraleStart: 1,
      moraleDelta: 23,
      moraleEnd: 24
    });

    expect(validateOptimizerBenchmark(benchmark)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        "rotation.shifts[0].operatorStates exchange-support aggregate moraleDelta must equal 0"
      ])
    }));
  });

  it("rejects four exchange actors with a stable pair-capacity diagnostic", () => {
    const benchmark = validStrictBenchmark();
    const sourceId = benchmark.rotation.fullCycleOperatorIds[29];
    const targetId = benchmark.rotation.fullCycleOperatorIds[79];
    Object.assign(benchmark.rotation.shifts[0].operatorStates.find((state) => state.operatorId === sourceId)!, {
      activity: "exchange-support",
      moraleStart: 24,
      moraleDelta: -24,
      moraleEnd: 0
    });
    Object.assign(benchmark.rotation.shifts[1].operatorStates.find((state) => state.operatorId === sourceId)!, {
      moraleStart: 0,
      moraleDelta: 0,
      moraleEnd: 0
    });
    Object.assign(benchmark.rotation.shifts[2].operatorStates.find((state) => state.operatorId === sourceId)!, {
      activity: "recovery",
      moraleStart: 0,
      moraleDelta: 24,
      moraleEnd: 24
    });
    Object.assign(benchmark.rotation.shifts[0].operatorStates.find((state) => state.operatorId === targetId)!, {
      activity: "exchange-support",
      moraleStart: 0,
      moraleDelta: 24,
      moraleEnd: 24
    });
    Object.assign(benchmark.rotation.shifts[2].operatorStates.find((state) => state.operatorId === targetId)!, {
      moraleStart: 24,
      moraleDelta: -24,
      moraleEnd: 0
    });

    expect(validateOptimizerBenchmark(benchmark)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        "rotation.shifts[0].operatorStates exchange-support pair occupancy 2 exceeds rotation.supportContexts capacity 1"
      ])
    }));
  });

  it("keeps a readable one-room legacy-shaped full-base fixture ineligible without crashing", () => {
    const benchmark = validStrictBenchmark();
    benchmark.rotation.facilities = [benchmark.rotation.facilities[0]];
    benchmark.rotation.shifts.forEach((shift) => {
      shift.assignments = { "trading-post-1": shift.assignments["trading-post-1"] };
    });

    expect(() => validateOptimizerBenchmark(benchmark)).not.toThrow();
    expect(validateOptimizerBenchmark(benchmark)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        "rotation.facilities must declare exactly 2 trading posts"
      ])
    }));
    expect(isPassFailEligible(benchmark)).toBe(false);
  });

  it.each([
    ["wrong product", (benchmark: any) => { benchmark.rotation.facilities[2].product = "battleRecord"; }, "rotation.facilities[2].product must preserve exactly 2 gold and 2 battleRecord factories"],
    ["wrong capacity", (benchmark: any) => { benchmark.rotation.facilities[0].capacity = 2; }, "rotation.facilities[0].capacity must be exactly 3 for tradingPost"],
    ["underfilled occupancy", (benchmark: any) => { benchmark.rotation.shifts[0].assignments["trading-post-1"].operatorIds.pop(); }, "rotation.shifts[0].assignments.trading-post-1.operatorIds must contain exactly 3 operators"],
    ["overfilled occupancy", (benchmark: any) => { benchmark.rotation.shifts[0].assignments["trading-post-1"].operatorIds.push(benchmark.rotation.fullCycleOperatorIds[87]); }, "rotation.shifts[0].assignments.trading-post-1.operatorIds must contain exactly 3 operators"],
    ["missing active room assignment", (benchmark: any) => { delete benchmark.rotation.shifts[0].assignments.office; }, "rotation.shifts[0].assignments.office must cover declared active facility"],
    ["extra assignment key", (benchmark: any) => { benchmark.rotation.shifts[0].assignments.extra = { operatorIds: [benchmark.rotation.fullCycleOperatorIds[87]] }; }, "rotation.shifts[0].assignments.extra must identify a declared active facility"],
    ["duplicate facility identity", (benchmark: any) => { benchmark.rotation.facilities[1].id = "trading-post-1"; }, "rotation.facilities[1].id duplicates rotation.facilities[0].id"],
    ["wrong facility type", (benchmark: any) => { benchmark.rotation.facilities[0].type = "factory"; }, "rotation.facilities must declare exactly 2 trading posts"],
    ["wrong facility level", (benchmark: any) => { benchmark.rotation.facilities[0].level = 2; }, "rotation.facilities[0].level must be exactly 3 for tradingPost"],
    ["extra undeclared room", (benchmark: any) => { benchmark.rotation.facilities.push({ id: "extra", type: "office", level: 3, capacity: 1 }); }, "rotation.facilities[12] must be an explicitly declared support dependency"]
  ])("rejects full-base facility composition with %s at a stable path", (_case, mutate, expectedError) => {
    const benchmark = validStrictBenchmark();
    mutate(benchmark);

    expect(validateOptimizerBenchmark(benchmark)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([expectedError])
    }));
    expect(isPassFailEligible(benchmark)).toBe(false);
  });

  it("accepts a non-working helper and validates full-cycle membership against region and benchmark roster", () => {
    const valid = validStrictBenchmark();
    const helperIndex = valid.rotation.fullCycleOperatorIds.length - 1;
    const helperId = valid.rotation.fullCycleOperatorIds[helperIndex];

    expect(valid.rotation.shifts.every((shift) =>
      !Object.values(shift.assignments).some((assignment) => assignment.operatorIds.includes(helperId))
    )).toBe(true);
    expect(valid.rotation.shifts.map((shift) => shift.operatorStates[helperIndex].activity)).toEqual([
      "exchange-support", "recovery", "idle"
    ]);
    expect(validateOptimizerBenchmark(valid).ok).toBe(true);

    const unavailable = validStrictBenchmark();
    unavailable.rotation.fullCycleOperatorIds[helperIndex] = "char_4228_closur";
    unavailable.roster.operatorIds[helperIndex] = "char_4228_closur";
    unavailable.rotation.shifts.forEach((shift) => {
      shift.operatorStates[helperIndex].operatorId = "char_4228_closur";
    });
    expect(validateOptimizerBenchmark(unavailable)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        `rotation.fullCycleOperatorIds[${helperIndex}] contains operator ID char_4228_closur unavailable in JP`
      ])
    }));

    const unknown = validStrictBenchmark();
    unknown.rotation.fullCycleOperatorIds[helperIndex] = "char_unknown";
    unknown.roster.operatorIds[helperIndex] = "char_unknown";
    unknown.rotation.shifts.forEach((shift) => {
      shift.operatorStates[helperIndex].operatorId = "char_unknown";
    });
    expect(validateOptimizerBenchmark(unknown)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        `rotation.fullCycleOperatorIds[${helperIndex}] contains unknown operator ID char_unknown`
      ])
    }));

    const outsideRoster = validStrictBenchmark();
    outsideRoster.roster.operatorIds.pop();
    expect(validateOptimizerBenchmark(outsideRoster)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        `rotation.fullCycleOperatorIds[${helperIndex}] contains operator ID ${helperId} outside the explicit roster`
      ])
    }));
  });

  it.each([
    ["morale above cap", (benchmark: any) => { benchmark.rotation.shifts[0].operatorStates[0].moraleStart = 25; }, "rotation.shifts[0].operatorStates[0].moraleStart must be between 0 and rotation.moraleCap"],
    ["assigned recovery", (benchmark: any) => { benchmark.rotation.shifts[0].operatorStates[0].activity = "recovery"; }, "rotation.shifts[0].operatorStates[0].activity must be work for assignment membership"],
    ["unassigned work", (benchmark: any) => { benchmark.rotation.shifts[0].operatorStates[29].activity = "work"; }, "rotation.shifts[0].operatorStates[29].activity must not be work without assignment membership"],
    ["idle nonzero delta", (benchmark: any) => { benchmark.rotation.shifts[0].operatorStates[29].moraleDelta = 1; benchmark.rotation.shifts[0].operatorStates[29].moraleEnd = 25; }, "rotation.shifts[0].operatorStates[29].moraleDelta must be zero for idle"],
    ["work positive delta", (benchmark: any) => { benchmark.rotation.shifts[0].operatorStates[0].moraleDelta = 1; benchmark.rotation.shifts[0].operatorStates[0].moraleEnd = 25; }, "rotation.shifts[0].operatorStates[0].moraleDelta must be non-positive for work"],
    ["recovery negative delta", (benchmark: any) => { benchmark.rotation.shifts[0].operatorStates[58].moraleDelta = -1; benchmark.rotation.shifts[0].operatorStates[58].moraleEnd = 17; }, "rotation.shifts[0].operatorStates[58].moraleDelta must be non-negative for recovery"],
    ["broken delta arithmetic", (benchmark: any) => { benchmark.rotation.shifts[0].operatorStates[0].moraleEnd = 19; }, "rotation.shifts[0].operatorStates[0].moraleEnd must equal moraleStart plus moraleDelta"],
    ["legacy per-hour field", (benchmark: any) => { benchmark.rotation.shifts[0].operatorStates[0].moraleCostPerHour = 0.5; }, "rotation.shifts[0].operatorStates[0] must not declare per-hour morale fields in the strict contract"]
  ])("rejects invalid morale semantics for %s", (_case, mutate, expectedError) => {
    const benchmark = validStrictBenchmark();
    mutate(benchmark);
    expect(validateOptimizerBenchmark(benchmark)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([expectedError])
    }));
  });

  it.each([
    ["exchange event timestamps", (benchmark: any) => { benchmark.rotation.shifts[0].exchangeEvents = [{ at: "2026-08-04T01:00:00+09:00" }]; }, "rotation.shifts[0].exchangeEvents is not allowed in the strict contract"],
    ["dormitory ordering", (benchmark: any) => { benchmark.rotation.supportContexts[0].operatorOrder = ["char_009_12fce"]; }, "rotation.supportContexts[0].operatorOrder is not allowed in the strict contract"]
  ])("rejects strict-schema-only %s fields", (_case, mutate, expectedError) => {
    const benchmark = validStrictBenchmark();
    mutate(benchmark);
    expect(validateOptimizerBenchmark(benchmark)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([expectedError])
    }));
  });

  it("validates drone generation, inventory arithmetic, continuity, and explicit cycle boundary closure", () => {
    const carryover = validStrictBenchmark();
    carryover.rotation.droneInventory = { initial: 20, final: 50, boundaryPolicy: "carryover" };
    let inventory = 20;
    carryover.rotation.shifts.forEach((shift) => {
      shift.resources.droneInventoryStart = inventory;
      shift.resources.dronesGenerated = 20;
      shift.resources.dronesUsed = 10;
      inventory += 10;
      shift.resources.droneInventoryEnd = inventory;
    });
    carryover.expected.output.dronesGenerated = 40;
    carryover.expected.output.dronesUsed = 20;

    expect(validateOptimizerBenchmark(carryover)).toEqual(expect.objectContaining({ ok: true }));
  });

  it.each([
    ["drone overuse", (benchmark: any) => { benchmark.rotation.shifts[0].resources.dronesUsed = 31; benchmark.rotation.shifts[0].resources.droneInventoryEnd = -1; }, "rotation.shifts[0].resources.droneInventoryEnd must not be negative"],
    ["broken drone arithmetic", (benchmark: any) => { benchmark.rotation.shifts[0].resources.droneInventoryEnd = 24; }, "rotation.shifts[0].resources.droneInventoryEnd must equal start plus generated minus used"],
    ["broken drone continuity", (benchmark: any) => { benchmark.rotation.shifts[1].resources.droneInventoryStart = 24; }, "rotation.shifts[1].resources.droneInventoryStart must equal the preceding drone inventory"],
    ["broken drone cycle boundary", (benchmark: any) => { benchmark.rotation.droneInventory.final = 21; }, "rotation.droneInventory.final must equal the final shift drone inventory"]
  ])("rejects %s", (_case, mutate, expectedError) => {
    const benchmark = validStrictBenchmark();
    mutate(benchmark);
    expect(validateOptimizerBenchmark(benchmark)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([expectedError])
    }));
  });

  it("rejects a source-relative boundary whose anchor is not the first evaluated shift", () => {
    const benchmark = validStrictBenchmark();
    Object.assign(benchmark.evaluationWindow, { start: {
      mode: "source-relative",
      sourceIndex: 0,
      shiftId: "shift-2"
    } });

    expect(validateOptimizerBenchmark(benchmark)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        "evaluationWindow.start.shiftId must equal evaluationWindow.shiftIds[0]"
      ])
    }));
    expect(isPassFailEligible(benchmark)).toBe(false);
  });

  it("binds a source-relative anchor to the pinned ordered full-cycle source", () => {
    const benchmark = validStrictBenchmark();
    benchmark.sources.push({
      ...benchmark.sources[0],
      url: "https://example.com/other-cycle",
      contentSha256: "c".repeat(64)
    });
    Object.assign(benchmark.evaluationWindow, { start: {
      mode: "source-relative",
      sourceIndex: 1,
      shiftId: "shift-1"
    } });

    expect(validateOptimizerBenchmark(benchmark)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        "evaluationWindow.start.sourceIndex must equal rotation.fullCycleSourceIndex for a source-relative boundary"
      ])
    }));
  });

  it.each([
    ["missing bundle", (benchmark: any) => { delete benchmark.assumptions.assumptionBundle; }, "assumptions.assumptionBundle must be an object for a pass/fail candidate"],
    ["missing ID", (benchmark: any) => { benchmark.assumptions.assumptionBundle.id = ""; }, "assumptions.assumptionBundle.id must be a non-empty stable ID"],
    ["string version", (benchmark: any) => { benchmark.assumptions.assumptionBundle.version = "1"; }, "assumptions.assumptionBundle.version must be a positive integer"],
    ["bad hash", (benchmark: any) => { benchmark.assumptions.assumptionBundle.contentSha256 = "xyz"; }, "assumptions.assumptionBundle.contentSha256 must be exactly 64 lowercase hexadecimal characters"],
    ["uppercase hash", (benchmark: any) => { benchmark.assumptions.assumptionBundle.contentSha256 = "B".repeat(64); }, "assumptions.assumptionBundle.contentSha256 must be exactly 64 lowercase hexadecimal characters"],
    ["missing domain", (benchmark: any) => { benchmark.assumptions.assumptionBundle.allowedAssumptionIds.pop(); }, "assumptions.assumptionBundle.allowedAssumptionIds must include phase1.signed-equivalent-morale-delta.v1"],
    ["extra domain", (benchmark: any) => { benchmark.assumptions.assumptionBundle.allowedAssumptionIds.push("unknown-effect"); }, "assumptions.assumptionBundle.allowedAssumptionIds[3] is not an allowed Phase 1 assumption domain"],
    ["duplicate domain", (benchmark: any) => { benchmark.assumptions.assumptionBundle.allowedAssumptionIds[2] = benchmark.assumptions.assumptionBundle.allowedAssumptionIds[0]; }, "assumptions.assumptionBundle.allowedAssumptionIds[2] duplicates assumptions.assumptionBundle.allowedAssumptionIds[0]"],
    ["legacy placeholder IDs", (benchmark: any) => { benchmark.assumptions.assumptionBundle.allowedAssumptionIds = ["high-value-order-probability-by-work-hours", "perception-information-manufacturing-efficiency-by-work-slot", "full-cycle-recovery-witness-equivalent-morale-delta"]; }, "assumptions.assumptionBundle.allowedAssumptionIds[0] is not an allowed Phase 1 assumption domain"],
    ["domain drift", (benchmark: any) => { benchmark.assumptions.assumptionBundle.allowedAssumptionIds[0] = "high-value-order-probability"; }, "assumptions.assumptionBundle.allowedAssumptionIds[0] is not an allowed Phase 1 assumption domain"]
  ])("rejects assumption bundle with %s at a stable path", (_case, mutate, expectedError) => {
    const benchmark = validStrictBenchmark();
    mutate(benchmark);

    expect(validateOptimizerBenchmark(benchmark)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([expectedError])
    }));
    expect(isPassFailEligible(benchmark)).toBe(false);
  });

  it.each([
    ["recovery", 0, 4, "rotation.shifts[0].operatorStates recovery occupancy 20 exceeds rotation.supportContexts capacity 19"],
    ["exchange-support", 4, 0, "rotation.shifts[0].operatorStates exchange-support pair occupancy 1 exceeds rotation.supportContexts capacity 0"]
  ])("rejects %s support capacity overflow", (_activity, contextIndex, capacity, expectedError) => {
    const benchmark = validStrictBenchmark();
    benchmark.rotation.supportContexts[contextIndex].capacity = capacity;

    expect(validateOptimizerBenchmark(benchmark)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([expectedError])
    }));
  });

  it("rejects exchange-support declaration capacity 2 at a stable path", () => {
    const benchmark = validStrictBenchmark();
    benchmark.rotation.supportContexts[4].capacity = 2;

    expect(validateOptimizerBenchmark(benchmark)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        "rotation.supportContexts[4].capacity must be exactly 1 for exchange-support"
      ])
    }));
    expect(isPassFailEligible(benchmark)).toBe(false);
  });

  it("rejects strict roster extras and duplicate assigned operators", () => {
    const rosterExtra = validStrictBenchmark();
    rosterExtra.roster.operatorIds.push(operatorAvailabilitySnapshot.regions.JP.operatorIds[88]);
    expect(validateOptimizerBenchmark(rosterExtra)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        `roster.operatorIds contains extra operator ID ${operatorAvailabilitySnapshot.regions.JP.operatorIds[88]} outside rotation.fullCycleOperatorIds`
      ])
    }));

    const duplicateAssignment = validStrictBenchmark();
    duplicateAssignment.rotation.shifts[0].assignments["factory-gold-1"].operatorIds[0] =
      duplicateAssignment.rotation.shifts[0].assignments["trading-post-1"].operatorIds[0];
    expect(validateOptimizerBenchmark(duplicateAssignment)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        `rotation.shifts[0] assigns ${duplicateAssignment.rotation.shifts[0].assignments["trading-post-1"].operatorIds[0]} more than once`
      ])
    }));
  });

  it.each([
    ["broken gold arithmetic", (benchmark: any) => { benchmark.rotation.shifts[0].resources.goldInventoryEnd = 69; }, "rotation.shifts[0].resources.goldInventoryEnd must equal start plus produced minus consumed"],
    ["broken gold continuity", (benchmark: any) => { benchmark.rotation.shifts[1].resources.goldInventoryStart = 69; }, "rotation.shifts[1].resources.goldInventoryStart must equal the preceding gold inventory"],
    ["broken gold final", (benchmark: any) => { benchmark.rotation.goldInventory.final = 64; }, "rotation.goldInventory.final must equal the final shift gold inventory"]
  ])("rejects %s", (_case, mutate, expectedError) => {
    const benchmark = validStrictBenchmark();
    mutate(benchmark);
    expect(validateOptimizerBenchmark(benchmark)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([expectedError])
    }));
  });

  it("rejects label-only assignments plus a bare sustainability declaration", () => {
    const benchmark = validStrictBenchmark();
    Object.assign(benchmark.rotation, { returnsToInitialState: true });
    benchmark.rotation.shifts.forEach((shift: any) => {
      shift.assignments = { "full-base": { label: "Declared team" } };
    });

    expect(validateOptimizerBenchmark(benchmark)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        "rotation.shifts[0].assignments.full-base.operatorIds must contain concrete operator IDs for a pass/fail candidate"
      ])
    }));
    expect(isPassFailEligible(benchmark)).toBe(false);
  });

  it("mechanically validates a sustainable 36h 3x12 full cycle with accumulating gold", () => {
    const benchmark = validStrictBenchmark();

    expect((benchmark.rotation as typeof benchmark.rotation & { returnsToInitialState?: boolean }).returnsToInitialState)
      .toBeUndefined();
    expect(benchmark.rotation.goldInventory.final).toBeGreaterThan(benchmark.rotation.goldInventory.initial);
    expect(validateOptimizerBenchmark(benchmark)).toEqual(expect.objectContaining({ ok: true }));
    expect(isPassFailEligible(benchmark)).toBe(true);
  });

  it.each([
    [
      "a morale deficit",
      (benchmark: any) => {
        benchmark.rotation.shifts[0].operatorStates[0].moraleDelta = -36;
        benchmark.rotation.shifts[0].operatorStates[0].moraleEnd = -12;
      },
      "rotation.shifts[0].operatorStates[0].moraleEnd must be between 0 and rotation.moraleCap"
    ],
    [
      "work/recovery overlap",
      (benchmark: any) => {
        benchmark.rotation.shifts[0].operatorStates.push({
          operatorId: "char_009_12fce",
          activity: "recovery",
          durationHours: 12,
          moraleStart: 6,
          moraleDelta: 0,
          moraleEnd: 6
        });
      },
      "rotation.shifts[0].operatorStates[88].operatorId overlaps another work/recovery state for char_009_12fce"
    ],
    [
      "the wrong work duration",
      (benchmark: any) => { benchmark.rotation.shifts[0].operatorStates[0].durationHours = 6; },
      "rotation.shifts[0].operatorStates[0].durationHours must equal rotation.shifts[0].durationHours"
    ],
    [
      "incorrect cycle closure",
      (benchmark: any) => {
        benchmark.rotation.shifts[2].operatorStates[0].moraleDelta = 1;
        benchmark.rotation.shifts[2].operatorStates[0].moraleEnd = 11;
      },
      "rotation.operatorStates.char_002_amiya must return to its initial morale at cycle end"
    ],
    [
      "a negative gold prefix",
      (benchmark: any) => {
        benchmark.rotation.shifts[0].resources.goldConsumed = 120;
        benchmark.rotation.shifts[0].resources.goldInventoryEnd = -10;
      },
      "rotation.shifts[0].resources.goldInventoryEnd must not be negative"
    ],
    [
      "an incorrect expected 24h resource sum",
      (benchmark: any) => { benchmark.expected.output.battleRecordExp = 30001; },
      "expected.output.battleRecordExp must equal the sum of evaluationWindow.shiftIds resources"
    ],
    [
      "a drone attribution mismatch",
      (benchmark: any) => { benchmark.rotation.shifts[0].resources.droneDestination = "trading-post-2"; },
      "rotation.shifts[0].resources.droneDestination must be trading-post-1 when dronesUsed is positive in the evaluation window"
    ]
  ])("rejects strict mechanical contract with %s at a stable path", (_case, mutate, expectedError) => {
    const benchmark = validStrictBenchmark();
    mutate(benchmark);

    expect(validateOptimizerBenchmark(benchmark)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([expectedError])
    }));
    expect(isPassFailEligible(benchmark)).toBe(false);
  });

  it.each([
    [
      "a missing concrete start boundary",
      (benchmark: any) => { delete benchmark.evaluationWindow.start; },
      "evaluationWindow.start must be an absolute or source-relative boundary"
    ],
    [
      "an unsupported work-slot model",
      (benchmark: any) => { benchmark.evaluationWindow.shiftHours = 6; },
      "evaluationWindow.shiftHours must be 12 for 2 work slots or 8 for 3 work slots"
    ],
    [
      "a work-slot count inferred from the worker-group count",
      (benchmark: any) => { benchmark.evaluationWindow.workSlotCount = 3; },
      "evaluationWindow.workSlotCount must equal evaluationWindow.shiftIds.length"
    ],
    [
      "a non-24-hour evaluated selection",
      (benchmark: any) => { benchmark.rotation.shifts[1].durationHours = 8; },
      "evaluationWindow.shiftIds must select full work slots totaling exactly 24 hours"
    ],
    [
      "a missing evaluated shift",
      (benchmark: any) => { benchmark.evaluationWindow.shiftIds[1] = "missing"; },
      "evaluationWindow.shiftIds[1] must identify a rotation shift"
    ],
    [
      "non-consecutive evaluated shifts",
      (benchmark: any) => { benchmark.evaluationWindow.shiftIds = ["shift-1", "shift-3"]; },
      "evaluationWindow.shiftIds[1] must identify the next consecutive rotation shift"
    ],
    [
      "an evaluated worker-group count that does not match represented groups",
      (benchmark: any) => { benchmark.evaluationWindow.workerGroupCount = 2; },
      "evaluationWindow.workerGroupCount must equal 3 distinct worker groups in the evaluated shifts"
    ],
    [
      "a full-cycle worker-group count that does not match represented groups",
      (benchmark: any) => { benchmark.rotation.workerGroupCount = 2; },
      "rotation.workerGroupCount must equal 3 distinct worker groups in rotation.shifts"
    ],
    [
      "a non-full-cycle work slot",
      (benchmark: any) => { benchmark.rotation.shifts[2].durationHours = 8; },
      "rotation.shifts[2].durationHours must equal evaluationWindow.shiftHours"
    ],
    [
      "a full cycle whose slots do not total cycleHours",
      (benchmark: any) => { benchmark.rotation.cycleHours = 48; },
      "rotation shift durations must sum to cycleHours"
    ],
    [
      "factory product switching or wrong gold count",
      (benchmark: any) => { benchmark.rotation.shifts[2].factoryProducts.gold = 1; },
      "rotation.shifts[2].factoryProducts.gold must be exactly 2"
    ],
    [
      "factory product switching or wrong battle-record count",
      (benchmark: any) => { benchmark.rotation.shifts[1].factoryProducts.battleRecord = 3; },
      "rotation.shifts[1].factoryProducts.battleRecord must be exactly 2"
    ],
    [
      "drones allocated outside trading posts",
      (benchmark: any) => { benchmark.assumptions.drones = "factory"; },
      "assumptions.drones must be trading-post-1 for a pass/fail candidate"
    ],
    [
      "a full-cycle average normalized to 24 hours",
      (benchmark: any) => { benchmark.expected.outputBasis = "full-cycle-average-normalized-to-24-hours"; },
      "expected.outputBasis must be concrete-24-hour-window for a pass/fail candidate"
    ],
    [
      "an invalid saved-artifact SHA-256 pin",
      (benchmark: any) => { benchmark.sources[0].contentSha256 = "not-a-sha"; },
      "sources[0].contentSha256 must be exactly 64 hexadecimal characters"
    ],
    [
      "mutable source provenance without a content pin",
      (benchmark: any) => { delete benchmark.sources[0].contentSha256; },
      "sources[0].contentSha256 is required when immutableUrl is not an immutable commit/blob URL"
    ],
    [
      "an unpinned evaluation-window evidence link",
      (benchmark: any) => {
        benchmark.sources.push({
          url: "https://example.com/evaluation",
          title: "Mutable evaluation evidence",
          accessedAt: "2026-08-04",
          language: "en",
          role: "throughput"
        });
        benchmark.evaluationWindow.start.sourceIndex = 1;
      },
      "sources[1].contentSha256 is required when immutableUrl is not an immutable commit/blob URL"
    ],
    [
      "an unpinned composition evidence link",
      (benchmark: any) => {
        benchmark.sources.push({
          url: "https://example.com/composition",
          title: "Mutable composition evidence",
          accessedAt: "2026-08-04",
          language: "en",
          role: "composition"
        });
        benchmark.rotation.compositionSourceIndex = 1;
      },
      "sources[1].contentSha256 is required when immutableUrl is not an immutable commit/blob URL"
    ],
    [
      "an unpinned full-cycle evidence link",
      (benchmark: any) => {
        benchmark.sources.push({
          url: "https://example.com/full-cycle",
          title: "Mutable full-cycle evidence",
          accessedAt: "2026-08-04",
          language: "en",
          role: "composition"
        });
        benchmark.rotation.fullCycleSourceIndex = 1;
      },
      "sources[1].contentSha256 is required when immutableUrl is not an immutable commit/blob URL"
    ],
    [
      "a composition evidence link whose pinned source has the wrong role",
      (benchmark: any) => {
        benchmark.sources.push({
          url: "https://example.com/throughput",
          title: "Pinned throughput evidence",
          accessedAt: "2026-08-04",
          language: "en",
          role: "throughput",
          contentSha256: "b".repeat(64)
        });
        benchmark.rotation.compositionSourceIndex = 1;
      },
      "rotation.compositionSourceIndex must identify a composition source"
    ],
    [
      "a full-cycle evidence link whose pinned source has the wrong role",
      (benchmark: any) => {
        benchmark.sources.push({
          url: "https://example.com/formula",
          title: "Pinned formula evidence",
          accessedAt: "2026-08-04",
          language: "en",
          role: "formula",
          contentSha256: "b".repeat(64)
        });
        benchmark.rotation.fullCycleSourceIndex = 1;
      },
      "rotation.fullCycleSourceIndex must identify a composition source"
    ]
  ])("rejects strict candidate with %s using a stable path", (_case, mutate, expectedError) => {
    const benchmark = validStrictBenchmark();
    mutate(benchmark);

    expect(validateOptimizerBenchmark(benchmark)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([expectedError])
    }));
    expect(isPassFailEligible(benchmark)).toBe(false);
  });

  it("accepts an unpinned supplemental formula source that is not referenced as strict evidence", () => {
    const benchmark = validStrictBenchmark();
    benchmark.sources.push({
      url: "https://example.com/formula",
      title: "Supplemental formula source",
      accessedAt: "2026-08-04",
      language: "en",
      role: "formula"
    } as typeof benchmark.sources[number]);

    expect(validateOptimizerBenchmark(benchmark)).toEqual(expect.objectContaining({ ok: true }));
    expect(isPassFailEligible(benchmark)).toBe(true);
  });

  it("accepts an immutable commit URL as the source pin instead of a saved-artifact hash", () => {
    const benchmark = validStrictBenchmark();
    delete (benchmark.sources[0] as any).contentSha256;
    Object.assign(benchmark.sources[0], {
      immutableUrl: "https://github.com/example/project/commit/0123456789abcdef0123456789abcdef01234567"
    });

    expect(validateOptimizerBenchmark(benchmark).ok).toBe(true);
    expect(isPassFailEligible(benchmark)).toBe(true);
  });
});

describe("isPassFailEligible", () => {
  it("allows corroborated, rejects assumption-backed confirmed with validation error, and keeps disputed ineligible", () => {
    const corroborated = validStrictBenchmark();
    expect(validateOptimizerBenchmark(corroborated).ok).toBe(true);
    expect(isPassFailEligible(corroborated)).toBe(true);

    const confirmed = validStrictBenchmark();
    confirmed.confidence = "confirmed";
    expect(validateOptimizerBenchmark(confirmed)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        "confidence must not be confirmed when assumptions.assumptionBundle is used"
      ])
    }));
    expect(isPassFailEligible(confirmed)).toBe(false);

    const disputed = validStrictBenchmark();
    disputed.confidence = "disputed";
    expect(validateOptimizerBenchmark(disputed).ok).toBe(true);
    expect(isPassFailEligible(disputed)).toBe(false);
  });

  it("accepts valid strict 12h x 2 and 8h x 3 concrete-window contracts", () => {
    const twelveHour = validStrictBenchmark();
    const eightHour = validStrictBenchmark();
    eightHour.evaluationWindow = {
      ...eightHour.evaluationWindow,
      shiftHours: 8,
      workSlotCount: 3,
      workerGroupCount: 3,
      shiftIds: ["shift-1", "shift-2", "shift-3"]
    };
    const eightHourStates = eightHour.rotation.shifts.map((shift) =>
      shift.operatorStates.map((state) => ({
        ...state,
        durationHours: 8
      }))
    );
    eightHour.rotation = {
      ...eightHour.rotation,
      cycleHours: 24,
      workerGroupCount: 3,
      shifts: eightHour.rotation.shifts.map((shift: any, index: number) => ({
        ...shift,
        durationHours: 8,
        operatorStates: eightHourStates[index]
      }))
    };
    eightHour.expected.output = {
      goldProduced: 130,
      goldConsumed: 115,
      goldNetChange: 15,
      battleRecordExp: 45000,
      lmd: 75000,
      dronesGenerated: 30,
      dronesUsed: 30,
      droneLmd: 6000,
      droneGoldConsumed: 6
    };

    expect(validateOptimizerBenchmark(twelveHour).ok).toBe(true);
    expect(isPassFailEligible(twelveHour)).toBe(true);
    expect(validateOptimizerBenchmark(eightHour)).toEqual(expect.objectContaining({ ok: true }));
    expect(isPassFailEligible(eightHour)).toBe(true);
  });

  it("keeps compatibility-only and disputed benchmarks ineligible", () => {
    expect(validateOptimizerBenchmark(validResourceBenchmark()).ok).toBe(true);
    expect(isPassFailEligible(validResourceBenchmark())).toBe(false);

    const disputed = validStrictBenchmark();
    disputed.confidence = "disputed";
    expect(isPassFailEligible(disputed)).toBe(false);
  });
});

const wikiruBundleTuple = {
  id: "arknights-basement.phase1-project-assumptions",
  version: 2,
  contentSha256: "5aca766b23d7eabfbb924d460b878d07351c5377ec0007ee12194de7fe1565ba",
  allowedAssumptionIds: [
    "phase1.high-value-order-probability.v1",
    "phase1.perception-information-factory-efficiency.v1",
    "phase1.signed-equivalent-morale-delta.v1"
  ]
};

describe("checked-in optimizer benchmark fixtures", () => {
  it("discovers exactly one strict JP Wikiru backup 38 fixture from the checked-in registry", () => {
    const fixtures = optimizerBenchmarkFixtures.filter((fixture) =>
      (fixture as { id?: unknown }).id === "jp-wikiru-backup38-12h-v2"
    );

    expect(fixtures).toHaveLength(1);
  });

  it("loads every fixture offline and validates it", () => {
    const results = optimizerBenchmarkFixtures.map(validateOptimizerBenchmark);

    expect(results.filter((result) => !result.ok)).toEqual([]);
    expect(results.flatMap((result) => (result.ok ? [result.value.id] : []))).toEqual([
      "jp-243-factory-3group-2025-11",
      "jp-glasgow-trading-125",
      "cn-243-3shift-2026-06",
      "base-mechanics-2026-07",
      "jp-wikiru-backup38-12h-v2"
    ]);
  });

  it("keeps the disputed Glasgow case out of pass/fail eligibility", () => {
    const glasgow = optimizerBenchmarkFixtures
      .map(validateOptimizerBenchmark)
      .find((result) => result.ok && result.value.id === "jp-glasgow-trading-125");

    expect(glasgow?.ok && isPassFailEligible(glasgow.value)).toBe(false);
  });

  it.each([
    "jp-243-factory-3group-2025-11",
    "cn-243-3shift-2026-06"
  ])("keeps unverified composition fixture %s disputed and out of pass/fail eligibility", (id) => {
    const fixture = optimizerBenchmarkFixtures
      .map(validateOptimizerBenchmark)
      .find((result) => result.ok && result.value.id === id);

    expect(fixture?.ok && fixture.value.confidence).toBe("disputed");
    expect(fixture?.ok && isPassFailEligible(fixture.value)).toBe(false);
  });

  it("preserves the accepted packet as an exact strict corroborated JP full-base fixture", () => {
    const fixture = optimizerBenchmarkFixtures.find((candidate) =>
      (candidate as { id?: unknown }).id === "jp-wikiru-backup38-12h-v2"
    ) as any;
    const availability = new Set(operatorAvailabilitySnapshot.regions.JP.operatorIds);
    const packetHashes = [
      "ca24367c26aec53981b046abb01743708c3d0fb0e1d05ad6544288f86082613d",
      "63df946eb2b65270e4a2185285974d377fc18dbf139f0a8da2cf05931ab63da6",
      "e50cbc4e5110af168ca145075d2da711109bf01d394fc6786c338b8781240a7a",
      "af44f691c7708fa7f2e024df47d4a9fa05610d62f95e60ba9c2c3e40a840b923",
      "33b7f7d08f5249b0d93efad441ef1dd7ec95d7e5939fdda7e02c9625d9cb45a8",
      "8a8e03596fda0f77cf4169914126a48d3abd8d27e1518a4d76fce4e374567edf",
      "5aca766b23d7eabfbb924d460b878d07351c5377ec0007ee12194de7fe1565ba"
    ];
    const serialized = JSON.stringify(fixture);

    expect(validateOptimizerBenchmark(fixture)).toEqual(expect.objectContaining({ ok: true }));
    expect(isPassFailEligible(fixture)).toBe(true);
    expect(fixture).toEqual(expect.objectContaining({
      contractVersion: "phase1-pass-fail-v1",
      kind: "resource-output",
      scope: "full-base",
      region: "JP",
      confidence: "corroborated",
      runtimeDataProvenance: {
        operatorAvailabilitySourceCommit: "7faf192d15eeac8b236c561a1938679f4642279e"
      },
      evaluationWindow: {
        start: { mode: "source-relative", sourceIndex: 0, shiftId: "groups-a-b" },
        durationHours: 24,
        shiftHours: 12,
        workSlotCount: 2,
        workerGroupCount: 3,
        shiftIds: ["groups-a-b", "groups-b-c"]
      }
    }));
    packetHashes.forEach((hash) => expect(serialized).toContain(hash));
    expect(fixture.assumptions.assumptionBundle).toEqual(wikiruBundleTuple);
    expect(fixture.expected.tolerance).toEqual({ type: "absolute", value: 0 });
    expect(fixture.expected.output).toEqual({
      goldProduced: 91.183333333333,
      goldConsumed: 123.352939249246,
      goldNetChange: -32.169605915912,
      battleRecordExp: 34220,
      lmd: 66853.59406102607,
      dronesGenerated: 387.6,
      dronesUsed: 387.6,
      droneLmd: 11587.04085343678,
      droneGoldConsumed: 23.174081706874
    });

    expect(fixture.roster.operatorIds).toHaveLength(51);
    expect(fixture.roster.operatorIds).toEqual(fixture.rotation.fullCycleOperatorIds);
    expect(fixture.roster.operatorIds.every((operatorId: string) => availability.has(operatorId))).toBe(true);
    expect(fixture.rotation.shifts.map((shift: any) => shift.id)).toEqual([
      "groups-a-b", "groups-b-c", "groups-c-a"
    ]);
    expect(fixture.rotation.shifts.map((shift: any) => shift.workerGroupIds)).toEqual([
      ["group-a", "group-b"], ["group-b", "group-c"], ["group-c", "group-a"]
    ]);
    expect(fixture.rotation.facilities.map((facility: any) => facility.id).sort()).toEqual(
      Object.keys(fixture.rotation.shifts[0].assignments).sort()
    );
    expect(fixture.rotation.shifts.every((shift: any) =>
      Object.values(shift.assignments).reduce(
        (count: number, assignment: any) => count + assignment.operatorIds.length,
        0
      ) === 29
    )).toBe(true);
    expect(fixture.rotation.shifts.every((shift: any) => shift.operatorStates.length === 51)).toBe(true);
    expect(fixture.rotation.fullCycleOperatorIds.every((operatorId: string) => {
      const states = fixture.rotation.shifts.map((shift: any) =>
        shift.operatorStates.find((state: any) => state.operatorId === operatorId)
      );
      return states.every((state: any) => state !== undefined) &&
        states.every((state: any, index: number) =>
          state.moraleEnd === state.moraleStart + state.moraleDelta &&
          state.moraleEnd === states[(index + 1) % states.length].moraleStart
        );
    })).toBe(true);
    expect(fixture.rotation.shifts.every((shift: any) => {
      const assigned = new Set(Object.values(shift.assignments).flatMap(
        (assignment: any) => assignment.operatorIds
      ));
      return shift.operatorStates.every((state: any) =>
        assigned.has(state.operatorId) === (state.activity === "work")
      );
    })).toBe(true);
    expect(fixture.rotation.shifts[1].operatorStates).toEqual(expect.arrayContaining([
      expect.objectContaining({ operatorId: "char_002_amiya", activity: "recovery", durationHours: 12, moraleStart: 24, moraleDelta: 0, moraleEnd: 24 }),
      expect.objectContaining({ operatorId: "char_2014_nian", activity: "recovery", durationHours: 12, moraleStart: 24, moraleDelta: 0, moraleEnd: 24 })
    ]));

    const resources = fixture.rotation.shifts.map((shift: any) => shift.resources);
    expect(resources.map((entry: any) => entry.goldInventoryStart)).toEqual([
      200, resources[0].goldInventoryEnd, resources[1].goldInventoryEnd
    ]);
    expect(resources.map((entry: any) => [entry.droneInventoryStart, entry.droneInventoryEnd])).toEqual([
      [0, 0], [0, 0], [0, 0]
    ]);
    expect(fixture.rotation.goldInventory).toEqual({
      initial: 200, final: 147.332311488218, boundaryPolicy: "carryover"
    });
    expect(fixture.rotation.droneInventory).toEqual({
      initial: 0, final: 0, boundaryPolicy: "return-to-initial"
    });
    expect(fixture.expected.output.goldProduced).toBe(resources[0].goldProduced + resources[1].goldProduced);
    expect(fixture.expected.output.battleRecordExp).toBe(resources[0].battleRecordExp + resources[1].battleRecordExp);
    expect(fixture.expected.output.lmd).toBe(resources[0].lmd + resources[1].lmd);
    expect(fixture.expected.output.goldProduced).not.toBe(
      resources.reduce((total: number, entry: any) => total + entry.goldProduced, 0)
    );

    const reverseObjectKeys = (value: any): any => Array.isArray(value)
      ? value.map(reverseObjectKeys)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reverseObjectKeys(value[key])]))
        : value;
    const semanticallyIdentical = reverseObjectKeys(fixture);
    expect(validateOptimizerBenchmark(semanticallyIdentical)).toEqual(expect.objectContaining({ ok: true }));
    expect(isPassFailEligible(semanticallyIdentical)).toBe(true);
  });

  it("fails closed for packet-specific cloned mutations with stable diagnostics", () => {
    const source = optimizerBenchmarkFixtures.find((candidate) =>
      (candidate as { id?: unknown }).id === "jp-wikiru-backup38-12h-v2"
    ) as any;

    const includesThirdShift = structuredClone(source);
    includesThirdShift.evaluationWindow.workSlotCount = 3;
    includesThirdShift.evaluationWindow.shiftIds.push("groups-c-a");
    for (const field of ["goldProduced", "goldConsumed", "battleRecordExp", "lmd", "dronesGenerated", "dronesUsed", "droneLmd", "droneGoldConsumed"]) {
      includesThirdShift.expected.output[field] += includesThirdShift.rotation.shifts[2].resources[field];
    }
    includesThirdShift.expected.output.goldNetChange =
      includesThirdShift.expected.output.goldProduced - includesThirdShift.expected.output.goldConsumed;
    expect(validateOptimizerBenchmark(includesThirdShift)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        "evaluationWindow.shiftHours must be 12 for 2 work slots or 8 for 3 work slots",
        "evaluationWindow.shiftIds must select full work slots totaling exactly 24 hours"
      ])
    }));

    const bareReturnClaim = structuredClone(source);
    bareReturnClaim.rotation.returnsToInitialState = true;
    bareReturnClaim.rotation.shifts[0].operatorStates[0].moraleEnd += 1;
    bareReturnClaim.rotation.shifts[2].operatorStates[0].moraleEnd += 1;
    const returnClaimResult = validateOptimizerBenchmark(bareReturnClaim);
    expect(returnClaimResult).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        "rotation.shifts[0].operatorStates[0].moraleEnd must equal moraleStart plus moraleDelta",
        `rotation.operatorStates.${bareReturnClaim.rotation.fullCycleOperatorIds[0]} must return to its initial morale at cycle end`
      ])
    }));

    const incompleteBase = structuredClone(source);
    incompleteBase.rotation.facilities.pop();
    expect(validateOptimizerBenchmark(incompleteBase)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        "rotation.facilities must declare exactly 1 office",
        "rotation.shifts[0].assignments.office must identify a declared active facility"
      ])
    }));

    const bundleDrift = structuredClone(source);
    bundleDrift.assumptions.assumptionBundle.version = 3;
    expect(validateOptimizerBenchmark(bundleDrift)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        "jp-wikiru-backup38-12h-v2 must match its canonical authority SHA-256"
      ])
    }));
    expect(isPassFailEligible(bundleDrift)).toBe(false);

    const confirmed = structuredClone(source);
    confirmed.confidence = "confirmed";
    expect(validateOptimizerBenchmark(confirmed)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        "confidence must not be confirmed when assumptions.assumptionBundle is used"
      ])
    }));

    for (const tolerance of [{ type: "absolute", value: 0.01 }, { type: "relative", value: 0.01 }]) {
      const sensitivityAsTolerance = structuredClone(source);
      sensitivityAsTolerance.expected.tolerance = tolerance;
      expect(validateOptimizerBenchmark(sensitivityAsTolerance)).toEqual(expect.objectContaining({
        ok: false,
        errors: expect.arrayContaining([
          "jp-wikiru-backup38-12h-v2 must match its canonical authority SHA-256"
        ])
      }));
      expect(isPassFailEligible(sensitivityAsTolerance)).toBe(false);
    }

    const sourceMetadataDrift = structuredClone(source);
    sourceMetadataDrift.sources[0].title += " changed";
    expect(validateOptimizerBenchmark(sourceMetadataDrift)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        "jp-wikiru-backup38-12h-v2 must match its canonical authority SHA-256"
      ])
    }));
    expect(isPassFailEligible(sourceMetadataDrift)).toBe(false);
  });

  it("gives resource fixtures runtime boundaries without inventing one for the formula fixture", () => {
    const fixtures = optimizerBenchmarkFixtures.map(validateOptimizerBenchmark);
    const validFixtures = fixtures.flatMap((result) => result.ok ? [result.value] : []);
    const formula = validFixtures.find((fixture) => fixture.kind === "formula");
    const resources = validFixtures.filter((fixture) => fixture.kind === "resource-output");

    expect(resources).toHaveLength(4);
    expect(resources.every((fixture) => fixture.runtimeDataProvenance !== undefined)).toBe(true);
    expect(formula?.runtimeDataProvenance).toBeUndefined();
  });

  it("promotes only the accepted Wikiru fixture to the strict pass/fail contract", () => {
    const fixtures = optimizerBenchmarkFixtures.map(validateOptimizerBenchmark);

    expect(fixtures.every((result) => result.ok)).toBe(true);
    expect(fixtures.flatMap((result) =>
      result.ok && isPassFailEligible(result.value) ? [result.value.id] : []
    )).toEqual(["jp-wikiru-backup38-12h-v2"]);
  });
});
