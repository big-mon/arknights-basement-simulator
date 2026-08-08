import { describe, expect, it } from "vitest";
import { optimizerBenchmarkFixtures } from "../data/optimizer-benchmarks";
import {
  effectiveBenchmarkScheduleAuthority,
  isPassFailEligible,
  validateOptimizerBenchmark,
  type OptimizerBenchmark,
  type ResourceOutputBenchmark
} from "./optimizerBenchmark";
import {
  operatorAvailabilitySnapshot,
  type OperatorAvailabilityRegion
} from "./operatorAvailability";
import type { PlanSustainabilityEvaluation } from "./planSustainabilityTypes";
import {
  formatOptimizerBenchmarkBatchResult,
  isAuthoritativeObjectiveSustainability,
  runOptimizerBenchmarkBatch,
  type BenchmarkObservation,
  type BenchmarkObservationMap
} from "./optimizerBenchmarkRunner";

const alternativeCommit = "0000000000000000000000000000000000000000";
const checkedGatingFixture = (() => {
  const fixture = optimizerBenchmarkFixtures.find((item) =>
    (item as { id?: string }).id === "jp-wikiru-backup38-12h-v2"
  ) as ResourceOutputBenchmark | undefined;
  if (!fixture || !isPassFailEligible(fixture)) {
    throw new Error("checked-in Wikiru benchmark fixture must remain pass/fail eligible");
  }
  return fixture;
})();

function genericOperatorIds(region: OperatorAvailabilityRegion): readonly [string, string, string, string] {
  const operatorIds = operatorAvailabilitySnapshot.regions[region].operatorIds;
  return [operatorIds[0], operatorIds[1], operatorIds[2], operatorIds[3]];
}

function resourceFixture(
  region: OperatorAvailabilityRegion,
  overrides: Record<string, unknown> = {}
): unknown {
  const [operatorA, operatorB, operatorC, operatorD] = genericOperatorIds(region);
  return {
    kind: "resource-output",
    scope: "facility-team",
    id: "runner-case",
    region,
    referenceProvenance: { version: "reference-plan-v1", observedAt: "2026-08-04" },
    runtimeDataProvenance: {
      operatorAvailabilitySourceCommit: operatorAvailabilitySnapshot.regions[region].source.commit
    },
    confidence: "corroborated",
    sources: [{
      url: "https://example.com/source",
      title: "Example",
      accessedAt: "2026-08-04",
      language: "en",
      role: "throughput"
    }],
    assumptions: {
      layout: "243",
      drones: "excluded",
      facilityProducts: ["lmd"],
      objectiveProfile: "balanced",
      notes: ["fixture"]
    },
    roster: { mode: "explicit", operatorIds: [operatorA, operatorB, operatorC, operatorD] },
    rotation: {
      cycleHours: 24,
      shifts: [{
        id: "day",
        durationHours: 24,
        assignments: {
          "trading-1": { operatorIds: [operatorA, operatorB] },
          "trading-label-only": { label: "not independently identified" }
        }
      }]
    },
    expected: {
      output: { lmd: 100 },
      formulas: ["lmd = 100"],
      tolerance: { type: "absolute", value: 0.5 }
    },
    ...overrides
  };
}

function observation(
  region: OperatorAvailabilityRegion,
  overrides: Partial<BenchmarkObservation> = {}
): BenchmarkObservation {
  const [operatorA, operatorB, operatorC, operatorD] = genericOperatorIds(region);
  return {
    metadata: {
      region,
      runtimeDataProvenance: {
        operatorAvailabilitySourceCommit: operatorAvailabilitySnapshot.regions[region].source.commit
      },
      roster: { mode: "explicit", operatorIds: [operatorA, operatorB, operatorC, operatorD] }
    },
    rotation: {
      cycleHours: 24,
      shifts: [{
        id: "day",
        durationHours: 24,
        assignments: { "trading-1": [operatorB, operatorA] }
      }]
    },
    resources: { lmd: 100 },
    ...overrides
  };
}

function gatingFixture(id: string): ResourceOutputBenchmark {
  const fixture = structuredClone(checkedGatingFixture);
  fixture.id = id;
  return fixture;
}

function strictSyntheticFixture(tolerance: ResourceOutputBenchmark["expected"]["tolerance"] = {
  type: "relative", value: 0.001, zeroExpectedAbsolute: 0
}): ResourceOutputBenchmark {
  const fixture = gatingFixture("runner-case");
  fixture.expected.tolerance = tolerance;
  const validation = validateOptimizerBenchmark(fixture);
  if (!validation.ok || validation.value.kind !== "resource-output") {
    throw new Error(validation.ok ? "strict synthetic fixture has wrong kind" : validation.errors.join("\n"));
  }
  if (!isPassFailEligible(validation.value)) {
    throw new Error("strict synthetic fixture must remain pass/fail eligible");
  }
  const authority = effectiveBenchmarkScheduleAuthority(validation.value);
  if (authority.status !== "complete") {
    throw new Error(authority.errors.join("\n"));
  }
  return validation.value;
}

function savedReferenceObservation(fixture: ResourceOutputBenchmark): BenchmarkObservation {
  const allWorkerGroupIds = [...new Set(
    fixture.rotation.shifts.flatMap((shift) => shift.workerGroupIds ?? [])
  )];
  const hasCompleteRotationWitness =
    fixture.rotation.workerGroupCount === allWorkerGroupIds.length &&
    fixture.rotation.shifts.every((shift) => (shift.workerGroupIds?.length ?? 0) > 0);
  let boundary = 0;
  return {
    metadata: {
      region: fixture.region,
      referenceProvenance: { version: fixture.referenceProvenance.version },
      runtimeDataProvenance: structuredClone(fixture.runtimeDataProvenance),
      roster: structuredClone(fixture.roster)
    },
    rotation: {
      cycleHours: fixture.rotation.cycleHours,
      shifts: fixture.rotation.shifts.map((shift) => ({
        id: shift.id,
        durationHours: shift.durationHours,
        ...(hasCompleteRotationWitness ? (() => {
          const startHour = boundary;
          boundary += shift.durationHours;
          return {
            startHour,
            endHour: boundary,
            activeGroupIds: [...shift.workerGroupIds!],
            recoveryGroupIds: allWorkerGroupIds.filter((groupId) => !shift.workerGroupIds!.includes(groupId))
          };
        })() : {}),
        assignments: Object.fromEntries(Object.entries(shift.assignments).flatMap(([facilityId, assignment]) =>
          assignment.operatorIds ? [[facilityId, [...assignment.operatorIds]]] : []
        ))
      }))
    },
    resources: { ...fixture.expected.output }
  };
}

function expectedResource(fixture: ResourceOutputBenchmark, resource: keyof ResourceOutputBenchmark["expected"]["output"]): number {
  const value = fixture.expected.output[resource];
  if (value === undefined) throw new Error(`${fixture.id} must define expected ${resource}`);
  return value;
}

function identifiedSupportFixture(id: string): {
  fixture: ResourceOutputBenchmark;
  shiftIndex: number;
  facilityId: string;
  supportIds: string[];
} {
  const fixture = gatingFixture(id);
  const rosterIds = fixture.roster.mode === "explicit" ? fixture.roster.operatorIds : [];
  const facilityId = "reception";
  const shiftIndex = fixture.rotation.shifts.findIndex((shift) => {
    const occupants = new Set(Object.values(shift.assignments).flatMap((assignment) => assignment.operatorIds ?? []));
    return rosterIds.filter((operatorId) => !occupants.has(operatorId)).length >= 2;
  });
  const shift = fixture.rotation.shifts[shiftIndex];
  const occupants = new Set(Object.values(shift.assignments).flatMap((assignment) => assignment.operatorIds ?? []));
  const supportIds = rosterIds.filter((operatorId) => !occupants.has(operatorId)).slice(0, 2);
  shift.assignments[facilityId].remoteSupport = {
    operatorIds: [...supportIds].reverse(),
    notes: ["Remote support is outside the facility slot count."]
  };
  return { fixture, shiftIndex, facilityId, supportIds };
}

function completePlanEvidence(
  fixture: ResourceOutputBenchmark = strictSyntheticFixture()
): NonNullable<BenchmarkObservation["planEvidence"]> {
  const authority = effectiveBenchmarkScheduleAuthority(fixture);
  if (authority.status !== "complete") throw new Error(authority.errors.join("\n"));
  const requiredWindowIds = authority.schedule.shifts.map((shift) => shift.id);
  const requiredFacilitySlots = fixture.rotation.shifts.flatMap((shift) =>
    Object.entries(shift.assignments).flatMap(([facilityId, assignment]) =>
      assignment.operatorIds
        ? [{ shiftId: shift.id, facilityId, slotCount: assignment.operatorIds.length }]
        : []
    )
  );
  return {
    search: {
      completion: "complete",
      proofStatus: "not-certified",
      diagnostics: [{
        code: "composition-search-not-certified",
        message: "bounded search",
        limitation: "candidate-generation-limited",
        visitedStates: 1,
        discardedStates: 0,
        feasibilityVisitedStates: 1,
        feasibilityWorkBudget: 1,
        feasibilityBudgetExhausted: false,
        optimizationVisitedStates: 1,
        optimizationWorkBudget: 1,
        optimizationBudgetExhausted: false,
        candidateGenerationInputCount: 1,
        candidateGenerationConstructedCount: 1,
        candidateGenerationRetainedCount: 1
      }]
    },
    production: {
      requiredWindowIds,
      completedWindowIds: [...requiredWindowIds],
      requiredFacilitySlots,
      actualFacilityOperators: fixture.rotation.shifts.flatMap((shift) =>
        Object.entries(shift.assignments).flatMap(([facilityId, assignment]) =>
          assignment.operatorIds
            ? [{ shiftId: shift.id, facilityId, operatorIds: [...assignment.operatorIds] }]
            : []
        )
      )
    },
    simultaneousOperatorConflicts: [],
    supportResourceScenario: {
      requested: true,
      complete: true,
      requestedSourceIds: fixture.supportResourceScenario?.sources.map((source) => source.id) ?? ["support-a"],
      resolvedSourceIds: fixture.supportResourceScenario?.sources.map((source) => source.id) ?? ["support-a"],
      fixedSourceEvidenceSourceIds: fixture.supportResourceScenario?.sources.map((source) => source.id) ?? ["support-a"],
      fixedContextRequested: true,
      fixedContextResolved: true
    },
    scheduledSupport: {
      completion: "complete",
      provenance: "bounded-scheduled-support-materialization-not-certified",
      supportPlacements: [{
        kind: "ordinary",
        operatorId: "supporter",
        facilityId: "control-1",
        groupId: "group-day",
        scheduleWindowIds: [...requiredWindowIds],
        recoveryWindowIds: []
      }],
      supportCapacityValidated: true,
      supportRecoveryValidated: true,
      issues: []
    },
    resourceEvaluation: {
      status: "complete",
      requiredWindowIds,
      evaluatedWindowIds: [...requiredWindowIds],
      missingCount: 0
    }
  };
}

function authoritativeObjective(value: number, fixture: ResourceOutputBenchmark = strictSyntheticFixture()) {
  const authority = effectiveBenchmarkScheduleAuthority(fixture);
  if (authority.status !== "complete") throw new Error(authority.errors.join("\n"));
  const requiredWindowIds = authority.schedule.shifts.map((shift) => shift.id);
  const requiredFacilityEvaluationCount = fixture.rotation.shifts.reduce((count, shift) =>
    count + Object.values(shift.assignments).filter((assignment) => assignment.operatorIds !== undefined).length,
  0);
  return {
    status: "complete" as const,
    authority: "authoritative" as const,
    value,
    objectiveProfile: "balanced" as const,
    weights: { gold: 0.5, battleRecord: 0.5, lmd: 0 },
    provenance: "exact-window-facility-normal-mechanics-evaluation" as const,
    completeness: {
      supportResourceScenario: "complete" as const,
      resourceEvaluation: "complete" as const,
      requiredWindowIds,
      evaluatedWindowIds: [...requiredWindowIds],
      requiredFacilityEvaluationCount,
      evaluatedFacilityEvaluationCount: requiredFacilityEvaluationCount
    },
    sustainability: {
      status: "evaluated" as const,
      assumptions: {},
      convergence: {},
      input: {},
      result: { sustainable: true, failures: [] },
      missing: [] as const
    } as unknown as PlanSustainabilityEvaluation
  };
}

function objectiveSuperiorFixture(tolerance: Record<string, unknown> = {
  type: "relative", value: 0.001, zeroExpectedAbsolute: 0
}) {
  return strictSyntheticFixture(tolerance as ResourceOutputBenchmark["expected"]["tolerance"]);
}

function objectiveSuperiorObservation(
  candidateValue = 10.02,
  referenceValue = 10,
  evidence: NonNullable<BenchmarkObservation["planEvidence"]> = completePlanEvidence()
): BenchmarkObservation {
  const fixture = strictSyntheticFixture();
  const actual = savedReferenceObservation(fixture);
  const firstShift = actual.rotation!.shifts[0];
  const firstFacilityId = Object.keys(firstShift.assignments)[0];
  firstShift.assignments[firstFacilityId] = [
    fixture.roster.mode === "explicit" ? fixture.roster.operatorIds.at(-1)! : "synthetic-alternative",
    ...firstShift.assignments[firstFacilityId].slice(1)
  ];
  const resourceName = Object.keys(fixture.expected.output)[0] as keyof typeof fixture.expected.output;
  return {
    ...actual,
    resources: { ...fixture.expected.output, [resourceName]: fixture.expected.output[resourceName]! * 0.9 },
    planSustainability: { status: "evaluated", sustainable: true, failures: [] },
    planEvidence: evidence,
    objectiveEvidence: {
      candidate: authoritativeObjective(candidateValue, fixture),
      reference: authoritativeObjective(referenceValue, fixture)
    }
  };
}

describe("runOptimizerBenchmarkBatch", () => {
  it("does not authorize objective evidence when a fixed support worker lacks morale provenance", () => {
    expect(isAuthoritativeObjectiveSustainability({
      status: "incomplete",
      assumptions: {} as never,
      missing: [{
        code: "recovery-provenance-unavailable",
        path: "rotation/day/assignments/char_2015_dusk/recoveryProvenance",
        message: "fixed support recovery provenance is unavailable",
        operatorId: "char_2015_dusk",
        facilityId: "control-1",
        shiftId: "day"
      }]
    })).toBe(false);
  });

  it("accepts a mechanically complete composition and output mismatch with authoritative objective superiority", () => {
    const fixture = objectiveSuperiorFixture();
    const actual = objectiveSuperiorObservation();

    const result = runOptimizerBenchmarkBatch([fixture], { "runner-case": actual });

    expect(result.cases[0]).toMatchObject({
      status: "passed",
      acceptanceMode: "objective-superior",
      searchProofStatus: "not-certified"
    });
    expect(result.cases[0].matchedComposition).toBeUndefined();
  });

  it.each([
    ["absent", undefined],
    ["incomplete", {
      status: "incomplete" as const,
      assumptions: {},
      missing: [{
        code: "morale-consumption-unavailable" as const,
        path: "rotation/day/assignments/fixed-support/moraleConsumptionPerHour",
        message: "fixed support morale is unavailable",
        operatorId: "fixed-support"
      }]
    }],
    ["unsustainable", {
      status: "evaluated" as const,
      assumptions: {}, convergence: {}, input: {},
      result: { sustainable: false, failures: [] }, missing: [] as const
    }],
    ["non-empty failures", {
      status: "evaluated" as const,
      assumptions: {}, convergence: {}, input: {},
      result: {
        sustainable: true,
        failures: [{ category: "morale" as const, code: "fixed-support-fatigue", message: "failure" }]
      },
      missing: [] as const
    }]
  ])("rejects objective superiority when reference objective sustainability is %s", (_name, sustainability) => {
    const actual = objectiveSuperiorObservation(10.02, 10);
    const reference = actual.objectiveEvidence!.reference as unknown as { sustainability?: unknown };
    if (sustainability === undefined) delete reference.sustainability;
    else reference.sustainability = sustainability;

    const result = runOptimizerBenchmarkBatch([objectiveSuperiorFixture()], { "runner-case": actual });

    expect(result.cases[0]).toMatchObject({ status: "failed" });
    expect(result.cases[0].acceptanceMode).toBeUndefined();
    expect(result.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "objective-comparison", severity: "error"
    }));
  });

  it("rejects objective superiority when plan sustainability evidence is absent", () => {
    const actual = objectiveSuperiorObservation();
    actual.planSustainability = undefined;

    const result = runOptimizerBenchmarkBatch([objectiveSuperiorFixture()], { "runner-case": actual });

    expect(result.cases[0]).toMatchObject({ status: "failed" });
    expect(result.cases[0].acceptanceMode).toBeUndefined();
    expect(result.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      code: "plan-sustainability-evidence-absent",
      path: "sustainable-cycle/evidence",
      category: "state-model",
      severity: "error",
      certainty: "proven"
    }));
  });

  it.each([
    ["incomplete", {
      status: "incomplete" as const,
      missing: []
    }, "plan-sustainability-incomplete"],
    ["evaluated but unsustainable", {
      status: "evaluated" as const,
      sustainable: false,
      failures: []
    }, "plan-sustainability-unsustainable"],
    ["evaluated with failures", {
      status: "evaluated" as const,
      sustainable: true,
      failures: [{ category: "morale" as const, code: "test-failure", message: "failure" }]
    }, "test-failure"]
  ])("rejects objective superiority when sustainability is %s", (_name, planSustainability, code) => {
    const actual = objectiveSuperiorObservation();
    actual.planSustainability = planSustainability;

    const result = runOptimizerBenchmarkBatch([objectiveSuperiorFixture()], { "runner-case": actual });

    expect(result.cases[0]).toMatchObject({ status: "failed" });
    expect(result.cases[0].acceptanceMode).toBeUndefined();
    expect(result.cases[0].diagnostics).toContainEqual(expect.objectContaining({ code, severity: "error" }));
  });

  it("rejects objective superiority when scheduled support materialization is incomplete", () => {
    const evidence = completePlanEvidence();
    evidence.scheduledSupport.completion = "incomplete";
    const actual = objectiveSuperiorObservation(10.02, 10, evidence);

    const result = runOptimizerBenchmarkBatch([objectiveSuperiorFixture()], { "runner-case": actual });

    expect(result.cases[0]).toMatchObject({ status: "failed" });
    expect(result.cases[0].acceptanceMode).toBeUndefined();
  });

  it.each([
    ["search completion", (e: ReturnType<typeof completePlanEvidence>) => { e.search.completion = "unknown"; }],
    ["required production windows", (e: ReturnType<typeof completePlanEvidence>) => { e.production.requiredWindowIds = []; }],
    ["completed production windows", (e: ReturnType<typeof completePlanEvidence>) => { e.production.completedWindowIds = []; }],
    ["declared production slots", (e: ReturnType<typeof completePlanEvidence>) => { e.production.requiredFacilitySlots = []; }],
    ["materialized production slots", (e: ReturnType<typeof completePlanEvidence>) => { e.production.actualFacilityOperators[0].operatorIds = ["x"]; }],
    ["simultaneous conflicts", (e: ReturnType<typeof completePlanEvidence>) => {
      e.simultaneousOperatorConflicts = [{ shiftId: "day", operatorId: "x" }];
    }],
    ["fixed support scenario", (e: ReturnType<typeof completePlanEvidence>) => { e.supportResourceScenario!.complete = false; }],
    ["fixed support source", (e: ReturnType<typeof completePlanEvidence>) => { e.supportResourceScenario!.resolvedSourceIds = []; }],
    ["fixed support source evidence", (e: ReturnType<typeof completePlanEvidence>) => {
      e.supportResourceScenario!.fixedSourceEvidenceSourceIds = [];
    }],
    ["fixed support context", (e: ReturnType<typeof completePlanEvidence>) => { e.supportResourceScenario!.fixedContextResolved = false; }],
    ["scheduled support materialization", (e: ReturnType<typeof completePlanEvidence>) => { e.scheduledSupport.completion = "incomplete"; }],
    ["scheduled support capacity", (e: ReturnType<typeof completePlanEvidence>) => { e.scheduledSupport.supportCapacityValidated = false; }],
    ["scheduled support recovery", (e: ReturnType<typeof completePlanEvidence>) => { e.scheduledSupport.supportRecoveryValidated = false; }],
    ["scheduled support issues", (e: ReturnType<typeof completePlanEvidence>) => {
      e.scheduledSupport.issues = [{
        code: "support-work-recovery-overlap",
        operatorId: "supporter",
        facilityId: "control-1",
        scheduleWindowIds: ["day"],
        message: "overlap"
      }];
    }],
    ["resource evaluation status", (e: ReturnType<typeof completePlanEvidence>) => { e.resourceEvaluation.status = "incomplete"; }],
    ["resource evaluation windows", (e: ReturnType<typeof completePlanEvidence>) => { e.resourceEvaluation.evaluatedWindowIds = []; }],
    ["resource missing count", (e: ReturnType<typeof completePlanEvidence>) => { e.resourceEvaluation.missingCount = 1; }]
  ])("rejects objective superiority with incomplete %s mechanical evidence", (_name, mutate) => {
    const evidence = completePlanEvidence();
    mutate(evidence);
    const result = runOptimizerBenchmarkBatch([objectiveSuperiorFixture()], {
      "runner-case": objectiveSuperiorObservation(10.02, 10, evidence)
    });

    expect(result.cases[0].status).toBe("failed");
    expect(result.cases[0].acceptanceMode).toBeUndefined();
  });

  it.each([
    ["exact boundary", 1001, 1000],
    ["below boundary", 1000.999, 1000]
  ])("rejects objective superiority at or below the relative tolerance: %s", (_name, candidate, reference) => {
    const result = runOptimizerBenchmarkBatch([objectiveSuperiorFixture()], {
      "runner-case": objectiveSuperiorObservation(candidate, reference)
    });

    expect(result.cases[0].status).toBe("failed");
    expect(result.cases[0].acceptanceMode).toBeUndefined();
  });

  it.each([
    ["missing objective authority", (o: BenchmarkObservation) => {
      o.objectiveEvidence = undefined;
    }],
    ["non-finite candidate", (o: BenchmarkObservation) => {
      o.objectiveEvidence!.candidate = authoritativeObjective(Number.NaN);
    }],
    ["zero reference", (o: BenchmarkObservation) => {
      o.objectiveEvidence!.reference = authoritativeObjective(0);
    }],
    ["non-finite reference", (o: BenchmarkObservation) => {
      o.objectiveEvidence!.reference = authoritativeObjective(Number.POSITIVE_INFINITY);
    }],
    ["unavailable candidate", (o: BenchmarkObservation) => {
      o.objectiveEvidence!.candidate = {
        ...authoritativeObjective(10.02), status: "incomplete", authority: "unavailable", reason: "missing exact mechanics"
      } as NonNullable<BenchmarkObservation["objectiveEvidence"]>["candidate"];
    }],
    ["unavailable reference", (o: BenchmarkObservation) => {
      o.objectiveEvidence!.reference = {
        ...authoritativeObjective(10), status: "incomplete", authority: "unavailable", reason: "missing exact mechanics"
      } as NonNullable<BenchmarkObservation["objectiveEvidence"]>["reference"];
    }],
    ["profile mismatch", (o: BenchmarkObservation) => {
      o.objectiveEvidence!.candidate = {
        ...authoritativeObjective(10.02), objectiveProfile: "lmd",
        weights: { gold: 0, battleRecord: 0, lmd: 1 }
      };
    }],
    ["weight mismatch", (o: BenchmarkObservation) => {
      o.objectiveEvidence!.candidate = { ...authoritativeObjective(10.02), weights: { gold: 1, battleRecord: 0, lmd: 0 } };
    }],
    ["provenance mismatch", (o: BenchmarkObservation) => {
      o.objectiveEvidence!.candidate = {
        ...authoritativeObjective(10.02), provenance: "raw-assignment-sum"
      } as unknown as NonNullable<BenchmarkObservation["objectiveEvidence"]>["candidate"];
    }],
    ["incomplete exact objective", (o: BenchmarkObservation) => {
      if (o.objectiveEvidence!.candidate.status === "complete") {
        o.objectiveEvidence!.candidate = {
          ...o.objectiveEvidence!.candidate,
          completeness: {
            ...o.objectiveEvidence!.candidate.completeness,
            evaluatedFacilityEvaluationCount: 0
          }
        };
      }
    }]
  ])("rejects objective superiority with %s evidence", (_name, mutate) => {
    const actual = objectiveSuperiorObservation();
    mutate(actual);
    const result = runOptimizerBenchmarkBatch([objectiveSuperiorFixture()], { "runner-case": actual });

    expect(result.cases[0].status).toBe("failed");
    expect(result.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "objective-comparison", severity: "error"
    }));
  });

  it("rejects objective superiority under a non-relative fixture tolerance", () => {
    const result = runOptimizerBenchmarkBatch([objectiveSuperiorFixture({ type: "absolute", value: 0.001 })], {
      "runner-case": objectiveSuperiorObservation()
    });

    expect(result.cases[0].status).toBe("failed");
  });

  it("retains composition and resource mismatches as warnings only after accepted superiority", () => {
    const fixture = objectiveSuperiorFixture();
    const result = runOptimizerBenchmarkBatch([fixture], {
      "runner-case": objectiveSuperiorObservation()
    });
    const resourceName = Object.keys(fixture.expected.output)[0] as keyof typeof fixture.expected.output;
    const expectedResourceValue = fixture.expected.output[resourceName]!;
    const resource = result.cases[0].diagnostics.find((item) =>
      item.path === `calculation/resource-values/${resourceName}`
    );

    expect(result.cases[0].acceptanceMode).toBe("objective-superior");
    expect(result.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "composition/search/groups-a-b/control-center", severity: "warning"
    }));
    expect(resource).toMatchObject({
      severity: "warning", expected: expectedResourceValue, actual: expectedResourceValue * 0.9,
      absoluteError: expectedResourceValue * 0.1, relativeError: 0.1,
      tolerance: { type: "relative", value: 0.001, zeroExpectedAbsolute: 0 },
      appliedTolerance: { type: "relative", value: 0.001 }
    });
    expect(result.cases[0].objectiveComparison).toMatchObject({
      candidateValue: 10.02,
      referenceValue: 10,
      objectiveProfile: "balanced",
      provenance: "exact-window-facility-normal-mechanics-evaluation"
    });
    expect(result.cases[0].objectiveComparison?.absoluteAdvantage).toBeCloseTo(0.02, 12);
    expect(result.cases[0].objectiveComparison?.relativeAdvantage).toBeCloseTo(0.002, 12);
    expect(result.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "objective-comparison",
      candidateValue: 10.02,
      referenceValue: 10,
      objectiveProfile: "balanced",
      objectiveWeights: { gold: 0.5, battleRecord: 0.5, lmd: 0 },
      objectiveProvenance: "exact-window-facility-normal-mechanics-evaluation",
      tolerance: { type: "relative", value: 0.001, zeroExpectedAbsolute: 0 }
    }));

    const rejected = objectiveSuperiorObservation();
    rejected.metadata.region = "CN";
    const rejectedResult = runOptimizerBenchmarkBatch([objectiveSuperiorFixture()], { "runner-case": rejected });
    expect(rejectedResult.cases[0]).toMatchObject({ status: "failed" });
    expect(rejectedResult.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "metadata/runtime-data-provenance/region", severity: "error"
    }));
    expect(rejectedResult.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: expect.stringMatching(/^calculation\/resource-values\//), severity: "error"
    }));
  });

  describe("strict output-equivalent acceptance", () => {
    function outputEquivalentObservation(
      evidence: NonNullable<BenchmarkObservation["planEvidence"]> = completePlanEvidence()
    ): BenchmarkObservation {
      const fixture = strictSyntheticFixture();
      const actual = savedReferenceObservation(fixture);
      const firstShift = actual.rotation!.shifts[0];
      const firstFacilityId = Object.keys(firstShift.assignments)[0];
      firstShift.assignments[firstFacilityId] = [
        fixture.roster.mode === "explicit" ? fixture.roster.operatorIds.at(-1)! : "synthetic-alternative",
        ...firstShift.assignments[firstFacilityId].slice(1)
      ];
      return { ...actual, resources: { ...fixture.expected.output }, planEvidence: evidence };
    }

    it("accepts only a mechanically complete within-tolerance composition mismatch as output-equivalent", () => {
      const fixture = strictSyntheticFixture();
      const result = runOptimizerBenchmarkBatch([fixture], {
        "runner-case": outputEquivalentObservation()
      });

      expect(result.cases[0]).toMatchObject({
        status: "passed",
        matchedComposition: "output-equivalent",
        acceptanceMode: "output-equivalent",
        searchProofStatus: "not-certified"
      });
      expect(result.cases[0].diagnostics).toContainEqual(expect.objectContaining({
        path: "composition/search/proof-status",
        severity: "info",
        actual: "not-certified"
      }));
    });

    it.each([
      ["production window", (e: ReturnType<typeof completePlanEvidence>) => { e.production.completedWindowIds = []; }],
      ["support scenario", (e: ReturnType<typeof completePlanEvidence>) => { e.supportResourceScenario!.complete = false; }],
      ["support source", (e: ReturnType<typeof completePlanEvidence>) => { e.supportResourceScenario!.resolvedSourceIds = []; }],
      ["fixed source evidence", (e: ReturnType<typeof completePlanEvidence>) => { e.supportResourceScenario!.fixedSourceEvidenceSourceIds = []; }],
      ["resources", (e: ReturnType<typeof completePlanEvidence>) => { e.resourceEvaluation.status = "incomplete"; }],
      ["operator conflict", (e: ReturnType<typeof completePlanEvidence>) => {
        e.simultaneousOperatorConflicts = [{ shiftId: "day", operatorId: "x" }];
      }]
    ])("rejects equal totals with incomplete %s evidence", (_name, mutate) => {
      const evidence = completePlanEvidence();
      mutate(evidence);
      const result = runOptimizerBenchmarkBatch([strictSyntheticFixture()], {
        "runner-case": outputEquivalentObservation(evidence)
      });
      expect(result.cases[0]).toMatchObject({ status: "failed" });
      expect(result.cases[0].matchedComposition).toBeUndefined();
    });

    it("uses the fixture relative tolerance and never turns output equivalence into certified optimality", () => {
      const fixture = strictSyntheticFixture();
      const resourceName = Object.keys(fixture.expected.output)[0] as keyof typeof fixture.expected.output;
      const expectedValue = fixture.expected.output[resourceName]!;
      const within = outputEquivalentObservation();
      within.resources = { ...fixture.expected.output, [resourceName]: expectedValue * 1.001 };
      const outside = outputEquivalentObservation();
      outside.resources = { ...fixture.expected.output, [resourceName]: expectedValue * 1.001001 };

      const accepted = runOptimizerBenchmarkBatch([fixture], { "runner-case": within });
      const rejected = runOptimizerBenchmarkBatch([fixture], { "runner-case": outside });
      expect(accepted.cases[0]).toMatchObject({ status: "passed", matchedComposition: "output-equivalent" });
      expect(accepted.cases[0].searchProofStatus).toBe("not-certified");
      expect(rejected.cases[0]).toMatchObject({
        status: "failed"
      });
      expect(rejected.cases[0].diagnostics).toContainEqual(expect.objectContaining({
        path: `calculation/resource-values/${resourceName}`,
        severity: "error",
        appliedTolerance: { type: "relative", value: 0.001 }
      }));
    });

    it.each([
      ["region", (o: BenchmarkObservation) => { o.metadata.region = "CN"; }],
      ["capacity", (o: BenchmarkObservation) => { o.planEvidence!.production.actualFacilityOperators[0].operatorIds = ["x"]; }],
      ["search completion", (o: BenchmarkObservation) => { o.planEvidence!.search.completion = "unknown"; }],
      ["calculation", (o: BenchmarkObservation) => { o.resources = { lmd: 99 }; }]
    ])("does not downgrade %s errors", (_name, mutate) => {
      const actual = outputEquivalentObservation();
      mutate(actual);
      const result = runOptimizerBenchmarkBatch([strictSyntheticFixture()], { "runner-case": actual });
      expect(result.cases[0].status).toBe("failed");
      expect(result.cases[0].matchedComposition).toBeUndefined();
    });
  });

  it("passes an exact observation and compares operator sets independent of order", () => {
    const result = runOptimizerBenchmarkBatch([resourceFixture("JP")], { "runner-case": observation("JP") });

    expect(result.aggregateStatus).toBe("passed");
    expect(result.counts).toEqual({ passed: 0, failed: 0, "not-run": 0, "non-gating": 1, invalid: 0 });
    expect(result.cases[0]).toMatchObject({ id: "runner-case", status: "non-gating", gating: false });
    expect(result.cases[0].diagnostics.filter((item) => item.severity === "error")).toHaveLength(0);
    expect(result.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "composition/search/day/trading-label-only",
      severity: "info",
      category: "search"
    }));
  });

  it("matches schedule boundaries and groups by stable shift ID rather than array position", () => {
    const fixture = resourceFixture("JP") as Record<string, any>;
    const [operatorA, operatorB] = genericOperatorIds("JP");
    delete fixture.rotation;
    fixture.schedule = {
      cycleHours: 24,
      groups: [{ id: "group-a" }, { id: "group-b" }],
      shifts: [
        { id: "day", startHour: 0, endHour: 12, activeGroupIds: ["group-a"], recoveryGroupIds: ["group-b"], assignments: { "trading-1": { operatorIds: [operatorA, operatorB] } } },
        { id: "night", startHour: 12, endHour: 24, activeGroupIds: ["group-b"], recoveryGroupIds: ["group-a"], assignments: { "trading-1": { operatorIds: [operatorA, operatorB] } } }
      ]
    };
    const scheduledObservation = observation("JP", {
      rotation: {
        cycleHours: 24,
        shifts: [
          { id: "night", durationHours: 12, startHour: 12, endHour: 24, activeGroupIds: ["group-b"], recoveryGroupIds: ["group-a"], assignments: { "trading-1": [operatorB, operatorA] } },
          { id: "day", durationHours: 12, startHour: 0, endHour: 12, activeGroupIds: ["group-a"], recoveryGroupIds: ["group-b"], assignments: { "trading-1": [operatorA, operatorB] } }
        ]
      }
    });

    const matched = runOptimizerBenchmarkBatch([fixture], { "runner-case": scheduledObservation });
    expect(matched.cases[0]).toMatchObject({ status: "non-gating", matchedComposition: "primary" });
    expect(matched.cases[0].diagnostics.filter((item) => item.severity === "error")).toHaveLength(0);

    scheduledObservation.rotation!.shifts[1].activeGroupIds = ["group-b"];
    const mismatched = runOptimizerBenchmarkBatch([fixture], { "runner-case": scheduledObservation });
    expect(mismatched.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "rotation/state-model/shifts/day/activeGroupIds",
      severity: "error"
    }));
    expect(mismatched.cases[0].matchedComposition).toBeUndefined();
  });

  it("rejects wrong group identity for the accepted Wikiru rotation witness", () => {
    const exactExceptGroups = savedReferenceObservation(checkedGatingFixture);
    let startHour = 0;
    exactExceptGroups.rotation!.shifts = exactExceptGroups.rotation!.shifts.map((shift) => {
      const endHour = startHour + shift.durationHours;
      const observedShift = {
        ...shift,
        startHour,
        endHour,
        activeGroupIds: ["WRONG"],
        recoveryGroupIds: ["ALSO-WRONG"]
      };
      startHour = endHour;
      return observedShift;
    });

    const result = runOptimizerBenchmarkBatch(
      [checkedGatingFixture],
      { [checkedGatingFixture.id]: exactExceptGroups }
    );

    expect(result.cases[0]).toMatchObject({ status: "failed", gating: true });
    expect(result.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "rotation/state-model/shifts/groups-a-b/activeGroupIds",
      severity: "error"
    }));
    expect(result.cases[0].matchedComposition).toBeUndefined();
  });

  it.each([
    {
      name: "a wrong boundary",
      mutate: (observation: BenchmarkObservation) => {
        observation.rotation!.shifts[0].endHour = 11;
      },
      path: "rotation/state-model/shifts/groups-a-b/endHour"
    },
    {
      name: "missing group arrays",
      mutate: (observation: BenchmarkObservation) => {
        delete observation.rotation!.shifts[0].activeGroupIds;
        delete observation.rotation!.shifts[0].recoveryGroupIds;
      },
      path: "rotation/state-model/shifts/groups-a-b/activeGroupIds"
    },
    {
      name: "a duplicate active group ID",
      mutate: (observation: BenchmarkObservation) => {
        observation.rotation!.shifts[0].activeGroupIds = ["group-a", "group-a"];
      },
      path: "rotation/state-model/shifts/groups-a-b/activeGroupIds"
    }
  ])("rejects $name against the accepted Wikiru schedule identity", ({ mutate, path }) => {
    const current = savedReferenceObservation(checkedGatingFixture);
    mutate(current);

    const result = runOptimizerBenchmarkBatch(
      [checkedGatingFixture],
      { [checkedGatingFixture.id]: current }
    );

    expect(result.cases[0]).toMatchObject({ status: "failed", gating: true });
    expect(result.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path,
      category: "state-model",
      severity: "error"
    }));
    expect(result.cases[0].matchedComposition).toBeUndefined();
  });

  it("passes the exact derived 36-hour Wikiru schedule identity and composition", () => {
    const exact = savedReferenceObservation(checkedGatingFixture);

    expect(exact.rotation).toMatchObject({
      cycleHours: 36,
      shifts: [
        { id: "groups-a-b", durationHours: 12, startHour: 0, endHour: 12, activeGroupIds: ["group-a", "group-b"], recoveryGroupIds: ["group-c"] },
        { id: "groups-b-c", durationHours: 12, startHour: 12, endHour: 24, activeGroupIds: ["group-b", "group-c"], recoveryGroupIds: ["group-a"] },
        { id: "groups-c-a", durationHours: 12, startHour: 24, endHour: 36, activeGroupIds: ["group-c", "group-a"], recoveryGroupIds: ["group-b"] }
      ]
    });

    const result = runOptimizerBenchmarkBatch(
      [checkedGatingFixture],
      { [checkedGatingFixture.id]: exact }
    );

    expect(result.cases[0]).toMatchObject({
      status: "passed",
      gating: true,
      matchedComposition: "primary"
    });
    expect(result.cases[0].diagnostics.filter((item) => item.severity === "error")).toHaveLength(0);
  });

  it("fails closed when a pass/fail rotation witness has incomplete schedule authority", () => {
    const fixture = gatingFixture("runner-incomplete-schedule-authority");
    for (const shift of fixture.rotation.shifts) {
      shift.workerGroupIds = shift.workerGroupIds?.map((groupId) =>
        groupId === "group-a" ? "not stable" : groupId
      );
    }
    const current = savedReferenceObservation(fixture);

    const result = runOptimizerBenchmarkBatch([fixture], { [fixture.id]: current });

    expect(validateOptimizerBenchmark(fixture)).toEqual(expect.objectContaining({ ok: true }));
    expect(result.cases[0]).toMatchObject({
      status: "failed",
      gating: true,
      smallestMismatchPath: "rotation/state-model/schedule-authority"
    });
    expect(result.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "rotation/state-model/schedule-authority",
      category: "state-model",
      severity: "error",
      actual: expect.arrayContaining([
        "rotation.shifts[0].workerGroupIds[0] must be a stable ID"
      ])
    }));
    expect(result.cases[0].matchedComposition).toBeUndefined();
  });

  it("does not report a composition match for a source-only unknown operator", () => {
    const fixture = resourceFixture("JP", {
      compositionEvidence: {
        status: "comparable",
        sourceOnlyOperators: [{
          sourceName: "Unknown Source Operator",
          operatorId: "source-only-unknown-operator",
          reason: "The source operator is not present in the runtime catalog."
        }],
        conflicts: [],
        disputedAssignments: []
      }
    }) as ResourceOutputBenchmark;
    fixture.rotation.shifts[0].assignments["trading-label-only"].sourceOnlyOperatorIds = [
      "source-only-unknown-operator"
    ];

    const result = runOptimizerBenchmarkBatch([fixture], { "runner-case": observation("JP") });

    expect(validateOptimizerBenchmark(fixture)).toEqual(expect.objectContaining({ ok: true }));
    expect(result.cases[0]).toMatchObject({ status: "non-gating", gating: false });
    expect(result.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "reference/source-only/day/trading-label-only/source-only-unknown-operator",
      severity: "info"
    }));
    expect(result.cases[0].matchedComposition).toBeUndefined();
  });

  it.each([
    {
      name: "disputed composition evidence",
      prepare: (fixture: ResourceOutputBenchmark) => {
        fixture.compositionEvidence = {
          status: "disputed",
          sourceOnlyOperators: [],
          conflicts: [],
          disputedAssignments: []
        };
      },
      diagnosticPath: "reference/disputed"
    },
    {
      name: "a composition evidence conflict",
      prepare: (fixture: ResourceOutputBenchmark) => {
        fixture.compositionEvidence = {
          status: "comparable",
          sourceOnlyOperators: [],
          conflicts: [{
            path: "day/trading-1",
            sourceValue: "source composition",
            benchmarkValue: "benchmark composition",
            notes: "The cited compositions conflict."
          }],
          disputedAssignments: []
        };
      },
      diagnosticPath: "reference/conflict/day/trading-1"
    },
    {
      name: "a disputed assignment",
      prepare: (fixture: ResourceOutputBenchmark) => {
        fixture.compositionEvidence = {
          status: "comparable",
          sourceOnlyOperators: [],
          conflicts: [],
          disputedAssignments: [{
            shiftId: "day",
            facilityIds: ["trading-1"],
            sourceOperators: [{
              sourceName: "Catalogued Operator",
              operatorId: genericOperatorIds("JP")[0]
            }],
            reason: "The cited assignment is disputed."
          }]
        };
      },
      diagnosticPath: "reference/disputed-assignment/day/trading-1"
    }
  ])("does not report a composition match with $name but retains diagnostics", ({ prepare, diagnosticPath }) => {
    const fixture = resourceFixture("JP") as ResourceOutputBenchmark;
    prepare(fixture);
    const mismatchedObservation = observation("JP", { resources: { lmd: 99 } });

    const result = runOptimizerBenchmarkBatch([fixture], { "runner-case": mismatchedObservation });

    expect(validateOptimizerBenchmark(fixture)).toEqual(expect.objectContaining({ ok: true }));
    expect(result.cases[0]).toMatchObject({
      status: "non-gating",
      gating: false,
      smallestMismatchPath: "calculation/resource-values/lmd"
    });
    expect(result.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: diagnosticPath,
      severity: "info"
    }));
    expect(result.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "calculation/resource-values/lmd",
      severity: "error"
    }));
    expect(result.cases[0].matchedComposition).toBeUndefined();
  });

  it.each([
    {
      name: "clean comparable composition evidence",
      prepare: (fixture: ResourceOutputBenchmark) => {
        fixture.compositionEvidence = {
          status: "comparable",
          sourceOnlyOperators: [],
          conflicts: [],
          disputedAssignments: []
        };
      }
    },
    {
      name: "clean legacy disputed confidence",
      prepare: (fixture: ResourceOutputBenchmark) => {
        fixture.confidence = "disputed";
      }
    }
  ])("may report a composition match for $name", ({ prepare }) => {
    const fixture = resourceFixture("JP") as ResourceOutputBenchmark;
    prepare(fixture);

    const result = runOptimizerBenchmarkBatch([fixture], { "runner-case": observation("JP") });

    expect(validateOptimizerBenchmark(fixture)).toEqual(expect.objectContaining({ ok: true }));
    expect(result.cases[0]).toMatchObject({
      status: "non-gating",
      gating: false,
      matchedComposition: "primary"
    });
  });

  it("compares remote support requirements deterministically without treating them as occupants", () => {
    const genericIds = genericOperatorIds("JP");
    const fixture = gatingFixture("runner-remote-support");
    const explicitRosterOperatorIds = fixture.roster.mode === "explicit" ? fixture.roster.operatorIds : [];
    const facilityId = "reception";
    const shiftIndex = fixture.rotation.shifts.findIndex((candidate: any) => {
      const occupants = new Set(
        Object.values(candidate.assignments).flatMap((item: any) => item.operatorIds)
      );
      return genericIds.filter((operatorId) =>
        explicitRosterOperatorIds.includes(operatorId) && !occupants.has(operatorId)
      ).length >= 2;
    });
    const shift = fixture.rotation.shifts[shiftIndex] as any;
    const assignment = shift.assignments[facilityId];
    const primaryOccupants = [...assignment.operatorIds];
    const shiftOccupants = new Set(
      Object.values(shift.assignments).flatMap((item: any) => item.operatorIds)
    );
    const remoteSupportOperatorIds = genericIds.filter((operatorId) =>
      explicitRosterOperatorIds.includes(operatorId) && !shiftOccupants.has(operatorId)
    ).slice(0, 2);
    assignment.remoteSupport = {
      operatorIds: [...remoteSupportOperatorIds].reverse(),
      notes: ["Remote support is outside the facility slot count."]
    };

    const matchedObservation = savedReferenceObservation(fixture);
    matchedObservation.rotation!.shifts[shiftIndex].assignments[facilityId] = [...primaryOccupants].reverse();
    matchedObservation.rotation!.shifts[shiftIndex].remoteSupportOperatorIds = {
      [facilityId]: remoteSupportOperatorIds
    };
    const matched = runOptimizerBenchmarkBatch([fixture], {
      [fixture.id]: matchedObservation
    });
    const missing = runOptimizerBenchmarkBatch([fixture], {
      [fixture.id]: savedReferenceObservation(fixture)
    });

    expect(validateOptimizerBenchmark(fixture)).toEqual(expect.objectContaining({ ok: true }));
    expect(primaryOccupants).toHaveLength(2);
    expect(remoteSupportOperatorIds).toHaveLength(2);
    expect(new Set([...primaryOccupants, ...remoteSupportOperatorIds])).toHaveProperty("size", 4);
    expect(remoteSupportOperatorIds.every((operatorId) => !shiftOccupants.has(operatorId))).toBe(true);
    expect(explicitRosterOperatorIds).toEqual(expect.arrayContaining(remoteSupportOperatorIds));
    expect(assignment.operatorIds).toEqual(primaryOccupants);
    expect(matched.cases[0]).toMatchObject({ status: "passed", matchedComposition: "primary" });
    expect(matched.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: `composition/remote-support/${shift.id}/${facilityId}`,
      passed: true
    }));
    expect(missing.cases[0]).toMatchObject({
      status: "failed",
      smallestMismatchPath: `composition/remote-support/${shift.id}/${facilityId}`
    });
    expect(missing.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: `composition/remote-support/${shift.id}/${facilityId}`,
      severity: "error",
      passed: false
    }));
  });

  it("ranks remote-support composition failures before calculation across declaration permutations", () => {
    const genericIds = genericOperatorIds("JP");
    const fixture = gatingFixture("remote-support-ranking");
    const explicitRosterOperatorIds = fixture.roster.mode === "explicit" ? fixture.roster.operatorIds : [];
    const facilityId = "reception";
    const shiftIndex = fixture.rotation.shifts.findIndex((candidate: any) => {
      const occupants = new Set(
        Object.values(candidate.assignments).flatMap((item: any) => item.operatorIds)
      );
      return genericIds.filter((operatorId) =>
        explicitRosterOperatorIds.includes(operatorId) && !occupants.has(operatorId)
      ).length >= 2;
    });
    const shift = fixture.rotation.shifts[shiftIndex] as any;
    const shiftOccupants = new Set(
      Object.values(shift.assignments).flatMap((item: any) => item.operatorIds)
    );
    const remoteSupportOperatorIds = genericIds.filter((operatorId) =>
      explicitRosterOperatorIds.includes(operatorId) && !shiftOccupants.has(operatorId)
    ).slice(0, 2);
    shift.assignments[facilityId].remoteSupport = {
      operatorIds: [...remoteSupportOperatorIds].reverse(),
      notes: ["Remote support is outside the facility slot count."]
    };
    shift.assignments.office.remoteSupport = {
      operatorIds: [remoteSupportOperatorIds[0]],
      notes: ["Remote support is outside the facility slot count."]
    };
    const expectedPath = `composition/remote-support/${shift.id}/office`;

    const observation = savedReferenceObservation(fixture);
    observation.resources = {
      ...observation.resources,
      goldProduced: expectedResource(fixture, "goldProduced") - 1
    };
    const permutedFixture = structuredClone(fixture);
    for (const candidate of permutedFixture.rotation.shifts) {
      candidate.assignments = Object.fromEntries(Object.entries(candidate.assignments).reverse());
    }
    const permutedObservation = savedReferenceObservation(permutedFixture);
    permutedObservation.resources = {
      ...permutedObservation.resources,
      goldProduced: expectedResource(permutedFixture, "goldProduced") - 1
    };

    const first = runOptimizerBenchmarkBatch([fixture], { [fixture.id]: observation });
    const second = runOptimizerBenchmarkBatch([permutedFixture], { [permutedFixture.id]: permutedObservation });

    expect(fixture.contractVersion).toBe("phase1-pass-fail-v1");
    expect(validateOptimizerBenchmark(fixture)).toEqual(expect.objectContaining({ ok: true }));
    expect(validateOptimizerBenchmark(permutedFixture)).toEqual(expect.objectContaining({ ok: true }));
    expect(remoteSupportOperatorIds).toHaveLength(2);
    expect(remoteSupportOperatorIds.every((operatorId) => !shiftOccupants.has(operatorId))).toBe(true);
    expect(first.cases[0].diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: expectedPath, category: "search", severity: "error" }),
      expect.objectContaining({ path: "calculation/resource-values/goldProduced", severity: "error" })
    ]));
    expect(first.cases[0].smallestMismatchPath).toBe(expectedPath);
    expect(formatOptimizerBenchmarkBatchResult(first)).toContain(`FAIL ${fixture.id} ${expectedPath}:`);
    expect(second.cases[0].smallestMismatchPath).toBe(expectedPath);
    expect(second.cases[0].diagnostics).toEqual(first.cases[0].diagnostics);
    expect(formatOptimizerBenchmarkBatchResult(second)).toBe(formatOptimizerBenchmarkBatchResult(first));
  });

  it("reports unresolved remote support informationally without making the fixture gate", () => {
    const fixture = resourceFixture("JP") as Record<string, any>;
    fixture.rotation.shifts[0].assignments["trading-1"].remoteSupport = {
      unresolved: [{ sourceName: "Unknown Support", reason: "Not mapped by the fixed source catalog." }],
      notes: ["Remote support is outside the trading-post slot count."]
    };

    const result = runOptimizerBenchmarkBatch([fixture], {
      "runner-case": observation("JP", { resources: { lmd: 99 } })
    });

    expect(validateOptimizerBenchmark(fixture)).toEqual(expect.objectContaining({ ok: true }));
    expect(result.cases[0]).toMatchObject({
      status: "non-gating",
      smallestMismatchPath: "calculation/resource-values/lmd"
    });
    expect(result.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "reference/unresolved-support/day/trading-1/Unknown Support",
      severity: "info"
    }));
    expect(result.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "calculation/resource-values/lmd",
      severity: "error"
    }));
    expect(result.cases[0].matchedComposition).toBeUndefined();
  });

  it("rejects an unexpected observed support facility without matching otherwise exact composition", () => {
    const fixture = gatingFixture("unexpected-remote-support");
    const observation = savedReferenceObservation(fixture);
    const shift = fixture.rotation.shifts[0];
    observation.rotation!.shifts[0].remoteSupportOperatorIds = {
      office: [fixture.roster.mode === "explicit" ? fixture.roster.operatorIds[0] : genericOperatorIds("JP")[0]]
    };

    const result = runOptimizerBenchmarkBatch([fixture], { [fixture.id]: observation });
    const path = `composition/remote-support/${shift.id}/office/unexpected`;

    expect(validateOptimizerBenchmark(fixture)).toEqual(expect.objectContaining({ ok: true }));
    expect(result.cases[0]).toMatchObject({ status: "failed", smallestMismatchPath: path });
    expect(result.cases[0].matchedComposition).toBeUndefined();
    expect(result.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path,
      expected: "absent",
      actual: "present",
      passed: false
    }));
  });

  it("rejects missing, wrong, and duplicate identified support without matching composition", () => {
    const { fixture, shiftIndex, facilityId, supportIds } = identifiedSupportFixture("wrong-remote-support");
    const rosterIds = fixture.roster.mode === "explicit" ? fixture.roster.operatorIds : [];
    const wrongSupportId = rosterIds.find((operatorId) => !supportIds.includes(operatorId))!;
    const shiftId = fixture.rotation.shifts[shiftIndex].id;
    const path = `composition/remote-support/${shiftId}/${facilityId}`;
    const observations = [
      savedReferenceObservation(fixture),
      savedReferenceObservation(fixture),
      savedReferenceObservation(fixture)
    ];
    observations[1].rotation!.shifts[shiftIndex].remoteSupportOperatorIds = {
      [facilityId]: [supportIds[0], wrongSupportId]
    };
    observations[2].rotation!.shifts[shiftIndex].remoteSupportOperatorIds = {
      [facilityId]: [supportIds[0], supportIds[0]]
    };

    for (const observation of observations) {
      const result = runOptimizerBenchmarkBatch([fixture], { [fixture.id]: observation });
      expect(result.cases[0]).toMatchObject({ status: "failed", smallestMismatchPath: path });
      expect(result.cases[0].matchedComposition).toBeUndefined();
    }
  });

  it("applies fixture-level identified support exactly to equivalent occupant candidates", () => {
    const { fixture, shiftIndex, facilityId, supportIds } = identifiedSupportFixture("equivalent-remote-support");
    const rosterIds = fixture.roster.mode === "explicit" ? fixture.roster.operatorIds : [];
    const equivalentShifts = fixture.rotation.shifts.map((shift) => ({
      shiftId: shift.id,
      assignments: Object.fromEntries(Object.entries(shift.assignments).flatMap(([id, assignment]) =>
        assignment.operatorIds ? [[id, [...assignment.operatorIds]]] : []
      ))
    }));
    const shiftOccupants = new Set(Object.values(equivalentShifts[shiftIndex].assignments).flat());
    const replacements = rosterIds.filter((operatorId) => !shiftOccupants.has(operatorId) && !supportIds.includes(operatorId)).slice(0, 2);
    equivalentShifts[shiftIndex].assignments[facilityId] = replacements;
    fixture.expected.equivalentCompositions = [{ shifts: equivalentShifts }];

    const exact = savedReferenceObservation(fixture);
    exact.rotation!.shifts = exact.rotation!.shifts.map((shift, index) => ({
      ...shift,
      assignments: structuredClone(equivalentShifts[index].assignments),
      ...(index === shiftIndex ? { remoteSupportOperatorIds: { [facilityId]: [...supportIds] } } : {})
    }));
    const missing = structuredClone(exact);
    missing.rotation!.shifts[shiftIndex].remoteSupportOperatorIds = {};
    const extra = structuredClone(exact);
    const extraSupportId = rosterIds.find((operatorId) => !supportIds.includes(operatorId))!;
    extra.rotation!.shifts[shiftIndex].remoteSupportOperatorIds = {
      [facilityId]: [...supportIds, extraSupportId]
    };

    const exactResult = runOptimizerBenchmarkBatch([fixture], { [fixture.id]: exact });
    const missingResult = runOptimizerBenchmarkBatch([fixture], { [fixture.id]: missing });
    const extraResult = runOptimizerBenchmarkBatch([fixture], { [fixture.id]: extra });

    expect(validateOptimizerBenchmark(fixture)).toEqual(expect.objectContaining({ ok: true }));
    expect(replacements).toHaveLength(2);
    expect(exactResult.cases[0]).toMatchObject({ status: "passed", matchedComposition: "equivalent[0]" });
    expect(missingResult.cases[0].matchedComposition).toBeUndefined();
    expect(extraResult.cases[0].matchedComposition).toBeUndefined();
    expect(extraResult.cases[0].smallestMismatchPath).toBe(
      `composition/remote-support/${fixture.rotation.shifts[shiftIndex].id}/${facilityId}`
    );
  });

  it("rejects an unexpected observed shift as a state-model mismatch", () => {
    const [operatorA, operatorB] = genericOperatorIds("JP");
    const result = runOptimizerBenchmarkBatch([resourceFixture("JP")], {
      "runner-case": observation("JP", {
        rotation: {
          cycleHours: 24,
          shifts: [
            { id: "day", durationHours: 24, assignments: { "trading-1": [operatorB, operatorA] } },
            { id: "night", durationHours: 24, assignments: { "trading-1": [operatorA, operatorB] } }
          ]
        }
      })
    });

    expect(result.cases[0]).toMatchObject({
      status: "non-gating",
      smallestMismatchPath: "rotation/state-model/shifts/night/unexpected"
    });
    expect(result.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "rotation/state-model/shifts/night/unexpected",
      category: "state-model",
      severity: "error",
      certainty: "suspected"
    }));
  });

  it("rejects duplicate observed shift IDs as a state-model mismatch", () => {
    const [operatorA, operatorB] = genericOperatorIds("JP");
    const result = runOptimizerBenchmarkBatch([resourceFixture("JP")], {
      "runner-case": observation("JP", {
        rotation: {
          cycleHours: 24,
          shifts: [
            { id: "day", durationHours: 24, assignments: { "trading-1": [operatorB, operatorA] } },
            { id: "day", durationHours: 24, assignments: { "trading-1": [operatorA, operatorB] } }
          ]
        }
      })
    });

    expect(result.cases[0]).toMatchObject({
      status: "non-gating",
      smallestMismatchPath: "rotation/state-model/shifts/day/duplicate-id"
    });
    expect(result.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "rotation/state-model/shifts/day/duplicate-id",
      category: "state-model",
      severity: "error",
      certainty: "suspected"
    }));
  });

  it("applies relative tolerance on both sides of the CN 1% boundary", () => {
    const fixture = resourceFixture("CN", {
      id: "cn-one-percent",
      referenceProvenance: { version: "cn-reference-v1", observedAt: "2026-08-04" },
      roster: { mode: "all-unlocked" },
      expected: {
        output: { lmd: 100 },
        formulas: ["lmd = 100"],
        tolerance: { type: "relative", value: 0.01, zeroExpectedAbsolute: 0.1 }
      }
    });
    const base = observation("CN", {
      metadata: {
        region: "CN",
        runtimeDataProvenance: {
          operatorAvailabilitySourceCommit: operatorAvailabilitySnapshot.regions.CN.source.commit
        },
        roster: { mode: "all-unlocked" }
      }
    });
    const within = runOptimizerBenchmarkBatch([fixture], { "cn-one-percent": { ...base, resources: { lmd: 101 } } });
    const outside = runOptimizerBenchmarkBatch([fixture], { "cn-one-percent": { ...base, resources: { lmd: 101.0001 } } });

    expect(within.cases[0]).toMatchObject({ status: "non-gating" });
    expect(within.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "calculation/resource-values/lmd",
      passed: true,
      absoluteError: 1,
      relativeError: 0.01,
      tolerance: { type: "relative", value: 0.01, zeroExpectedAbsolute: 0.1 }
    }));
    expect(outside.cases[0]).toMatchObject({ status: "non-gating", smallestMismatchPath: "calculation/resource-values/lmd" });
  });

  it("applies absolute tolerance and the explicit expected-zero fallback without division", () => {
    const absolute = runOptimizerBenchmarkBatch([resourceFixture("JP")], {
      "runner-case": observation("JP", { resources: { lmd: 100.5 } })
    });
    const zeroFixture = resourceFixture("JP", {
      expected: {
        output: { lmd: 0 },
        formulas: ["lmd = 0"],
        tolerance: { type: "relative", value: 0.01, zeroExpectedAbsolute: 0.25 }
      }
    });
    const zero = runOptimizerBenchmarkBatch([zeroFixture], {
      "runner-case": observation("JP", { resources: { lmd: 0.2 } })
    });

    expect(absolute.cases[0].status).toBe("non-gating");
    expect(zero.cases[0].status).toBe("non-gating");
    expect(zero.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "calculation/resource-values/lmd",
      absoluteError: 0.2,
      relativeError: undefined,
      appliedTolerance: { type: "absolute-zero-fallback", value: 0.25 }
    }));
  });

  it("accepts an explicitly declared equivalent composition without weakening resources", () => {
    const fixture = resourceFixture("JP");
    const [, , operatorC, operatorD] = genericOperatorIds("JP");
    (fixture as ResourceOutputBenchmark).expected.equivalentCompositions = [{
      shifts: [{ shiftId: "day", assignments: { "trading-1": [operatorC, operatorD] } }]
    }];
    const result = runOptimizerBenchmarkBatch([fixture], {
      "runner-case": observation("JP", {
        rotation: { cycleHours: 24, shifts: [{ id: "day", durationHours: 24, assignments: { "trading-1": [operatorD, operatorC] } }] },
        resources: { lmd: 99 }
      })
    });

    expect(result.cases[0]).toMatchObject({ status: "non-gating", matchedComposition: "equivalent[0]" });
    expect(result.cases[0].smallestMismatchPath).toBe("calculation/resource-values/lmd");
  });

  it("requires the primary composition to have exact facility and operator sets", () => {
    const [operatorA, operatorB, operatorC] = genericOperatorIds("JP");
    const extraFacility = runOptimizerBenchmarkBatch([resourceFixture("JP")], {
      "runner-case": observation("JP", {
        rotation: {
          cycleHours: 24,
          shifts: [{
            id: "day",
            durationHours: 24,
            assignments: {
              "trading-1": [operatorB, operatorA],
              "trading-label-only": [operatorC]
            }
          }]
        }
      })
    });
    const extraOperator = runOptimizerBenchmarkBatch([resourceFixture("JP")], {
      "runner-case": observation("JP", {
        rotation: {
          cycleHours: 24,
          shifts: [{
            id: "day",
            durationHours: 24,
            assignments: { "trading-1": [operatorB, operatorA, operatorC] }
          }]
        }
      })
    });

    expect(extraFacility.cases[0].matchedComposition).toBeUndefined();
    expect(extraFacility.cases[0].smallestMismatchPath).toBe("composition/search/day/trading-label-only/unexpected");
    expect(extraFacility.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "composition/search/day/trading-label-only/unexpected",
      category: "search",
      severity: "error",
      certainty: "suspected",
      expected: "absent",
      actual: "present"
    }));
    expect(extraOperator.cases[0].matchedComposition).toBeUndefined();
    expect(extraOperator.cases[0].smallestMismatchPath).toBe("composition/search/day/trading-1");
  });

  it("requires equivalent compositions to have exact facility sets", () => {
    const fixture = resourceFixture("JP") as ResourceOutputBenchmark;
    const [operatorA, , operatorC, operatorD] = genericOperatorIds("JP");
    fixture.expected.equivalentCompositions = [{
      shifts: [{ shiftId: "day", assignments: { "trading-1": [operatorC, operatorD] } }]
    }];
    const result = runOptimizerBenchmarkBatch([fixture], {
      "runner-case": observation("JP", {
        rotation: {
          cycleHours: 24,
          shifts: [{
            id: "day",
            durationHours: 24,
            assignments: {
              "trading-1": [operatorD, operatorC],
              "trading-label-only": [operatorA]
            }
          }]
        }
      })
    });

    expect(result.cases[0].matchedComposition).toBeUndefined();
    expect(result.cases[0].smallestMismatchPath).toBe("composition/search/day/trading-1");
    expect(result.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "composition/search/day/trading-label-only/unexpected",
      category: "search",
      severity: "error",
      expected: "absent",
      actual: "present"
    }));
  });

  it("orders mismatches canonically across declaration permutations", () => {
    const [operatorA, operatorB, operatorC, operatorD] = genericOperatorIds("JP");
    const fixture = resourceFixture("JP", {
      rotation: {
        cycleHours: 24,
        shifts: [
          { id: "night", durationHours: 12, assignments: { "trading-z": { operatorIds: [operatorC] }, "trading-a": { operatorIds: [operatorD] } } },
          { id: "day", durationHours: 12, assignments: { "trading-z": { operatorIds: [operatorA] }, "trading-a": { operatorIds: [operatorB] } } }
        ]
      }
    }) as ResourceOutputBenchmark;
    const permutedFixture = structuredClone(fixture);
    permutedFixture.rotation.shifts.reverse();
    for (const shift of permutedFixture.rotation.shifts) {
      shift.assignments = Object.fromEntries(Object.entries(shift.assignments).reverse());
    }
    const firstObservation = observation("JP", {
      rotation: {
        cycleHours: 24,
        shifts: [
          { id: "day", durationHours: 10, assignments: { "unexpected-z": [operatorA], "trading-a": [operatorB], "trading-z": [operatorA] } },
          { id: "night", durationHours: 10, assignments: { "unexpected-a": [operatorC], "trading-a": [operatorD], "trading-z": [operatorC] } }
        ]
      },
      resources: { lmd: 99 },
      interpretedEffects: [
        { id: "z-effect", expected: 2, actual: 1 },
        { id: "a-effect", expected: 2, actual: 1 }
      ],
      provenCauses: [
        { category: "calculation", path: "calculation/resource-values/lmd", evidence: "calculation audit" },
        { category: "interpretation", path: "skill-interpretation/a-effect", evidence: "skill audit" }
      ]
    });
    const permutedObservation = structuredClone(firstObservation);
    permutedObservation.rotation!.shifts.reverse();
    for (const shift of permutedObservation.rotation!.shifts) {
      shift.assignments = Object.fromEntries(Object.entries(shift.assignments).reverse());
    }
    permutedObservation.interpretedEffects!.reverse();
    permutedObservation.provenCauses!.reverse();

    const first = runOptimizerBenchmarkBatch([fixture], { "runner-case": firstObservation });
    const second = runOptimizerBenchmarkBatch([permutedFixture], { "runner-case": permutedObservation });

    expect(first.cases[0].smallestMismatchPath).toBe("rotation/state-model/shifts/day/durationHours");
    expect(second.cases[0].smallestMismatchPath).toBe(first.cases[0].smallestMismatchPath);
    expect(second.cases[0].diagnostics).toEqual(first.cases[0].diagnostics);
    expect(formatOptimizerBenchmarkBatchResult(second)).toBe(formatOptimizerBenchmarkBatchResult(first));
  });

  it("selects failures by the documented cross-category hierarchy", () => {
    const [operatorA, operatorB] = genericOperatorIds("CN");
    const fixture = gatingFixture("cross-category-hierarchy");
    const current = savedReferenceObservation(fixture);
    const firstShiftId = current.rotation!.shifts[0].id;
    current.metadata.region = "CN";
    current.metadata.referenceProvenance = { version: "wrong-reference" };
    current.metadata.runtimeDataProvenance = { operatorAvailabilitySourceCommit: alternativeCommit };
    current.metadata.roster = { mode: "explicit", operatorIds: [operatorA, operatorB] };
    current.rotation!.cycleHours += 1;
    current.rotation!.shifts[0].assignments.unexpected = [operatorA];
    current.resources = {
      ...current.resources,
      goldProduced: expectedResource(fixture, "goldProduced") - 1
    };
    const result = runOptimizerBenchmarkBatch([fixture], { [fixture.id]: current });

    expect(result.cases[0].smallestMismatchPath).toBe("metadata/reference-provenance/version");
    expect(result.cases[0].diagnostics.filter((item) => item.severity === "error").map((item) => item.path)).toEqual([
      "metadata/reference-provenance/version",
      "metadata/runtime-data-provenance/region",
      "metadata/runtime-data-provenance/operatorAvailabilitySourceCommit",
      "metadata/runtime-data-provenance/roster/operatorIds",
      "rotation/state-model/cycleHours",
      `composition/search/${firstShiftId}/unexpected/unexpected`,
      "calculation/resource-values/goldProduced"
    ]);
    expect(formatOptimizerBenchmarkBatchResult(result)).toContain(
      "FAIL cross-category-hierarchy metadata/reference-provenance/version:"
    );
  });

  it("reports wrong metadata, rotation, and composition at stable hierarchical paths", () => {
    const [operatorA, , operatorC] = genericOperatorIds("CN");
    const result = runOptimizerBenchmarkBatch([resourceFixture("JP")], {
      "runner-case": observation("JP", {
        metadata: {
          region: "CN",
          runtimeDataProvenance: { operatorAvailabilitySourceCommit: alternativeCommit },
          roster: { mode: "explicit", operatorIds: [operatorA] }
        },
        rotation: { cycleHours: 12, shifts: [{ id: "night", durationHours: 12, assignments: { "trading-1": [operatorC] } }] }
      })
    });

    expect(result.cases[0].diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "metadata/runtime-data-provenance/region", category: "source-data", certainty: "suspected" }),
      expect.objectContaining({ path: "metadata/runtime-data-provenance/operatorAvailabilitySourceCommit", category: "source-data" }),
      expect.objectContaining({ path: "metadata/runtime-data-provenance/roster/operatorIds", category: "source-data" }),
      expect.objectContaining({ path: "rotation/state-model/cycleHours", category: "state-model" }),
      expect.objectContaining({ path: "rotation/state-model/shifts/day", category: "state-model" })
    ]));
    expect(result.cases[0].smallestMismatchPath).toBe("metadata/runtime-data-provenance/region");
  });

  it("accepts distinct reference and runtime versions and reports reference provenance informationally", () => {
    const result = runOptimizerBenchmarkBatch([resourceFixture("JP")], { "runner-case": observation("JP") });

    expect(result.cases[0].status).toBe("non-gating");
    expect(result.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "metadata/reference-provenance/version",
      severity: "info",
      expected: "reference-plan-v1",
      actual: undefined
    }));
    expect(result.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "metadata/runtime-data-provenance/operatorAvailabilitySourceCommit",
      passed: true,
      expected: operatorAvailabilitySnapshot.regions.JP.source.commit,
      actual: operatorAvailabilitySnapshot.regions.JP.source.commit
    }));
  });

  it("diagnoses a runtime boundary mismatch at the precise source-data path", () => {
    const [operatorA, operatorB] = genericOperatorIds("JP");
    const result = runOptimizerBenchmarkBatch([resourceFixture("JP")], {
      "runner-case": observation("JP", {
        metadata: {
          region: "JP",
          runtimeDataProvenance: { operatorAvailabilitySourceCommit: alternativeCommit },
          roster: { mode: "explicit", operatorIds: [operatorA, operatorB] }
        }
      })
    });

    expect(result.cases[0]).toMatchObject({
      status: "non-gating",
      smallestMismatchPath: "metadata/runtime-data-provenance/operatorAvailabilitySourceCommit"
    });
  });

  it("fails when a fixture requires a runtime boundary but the observation omits it", () => {
    const [operatorA, operatorB] = genericOperatorIds("JP");
    const result = runOptimizerBenchmarkBatch([resourceFixture("JP")], {
      "runner-case": observation("JP", {
        metadata: { region: "JP", roster: { mode: "explicit", operatorIds: [operatorA, operatorB] } }
      })
    });

    expect(result.cases[0]).toMatchObject({
      status: "non-gating",
      smallestMismatchPath: "metadata/runtime-data-provenance/operatorAvailabilitySourceCommit"
    });
    expect(result.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "metadata/runtime-data-provenance/operatorAvailabilitySourceCommit",
      actual: undefined,
      severity: "error"
    }));
  });

  it("never substitutes reference provenance for a missing runtime boundary", () => {
    const [operatorA, operatorB] = genericOperatorIds("JP");
    const result = runOptimizerBenchmarkBatch([resourceFixture("JP")], {
      "runner-case": observation("JP", {
        metadata: {
          region: "JP",
          referenceProvenance: { version: alternativeCommit },
          roster: { mode: "explicit", operatorIds: [operatorA, operatorB] }
        }
      })
    });

    expect(result.cases[0]).toMatchObject({
      status: "non-gating",
      smallestMismatchPath: "metadata/reference-provenance/version"
    });
    expect(result.cases[0].diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "metadata/reference-provenance/version",
        expected: "reference-plan-v1",
        actual: alternativeCommit
      }),
      expect.objectContaining({
        path: "metadata/runtime-data-provenance/operatorAvailabilitySourceCommit",
        actual: undefined
      })
    ]));
  });

  it("reports explicit interpretation checks and only auditor evidence as proven", () => {
    const result = runOptimizerBenchmarkBatch([resourceFixture("JP")], {
      "runner-case": observation("JP", {
        interpretedEffects: [{ id: "glasgow-efficiency", expected: 1.25, actual: 1.15 }],
        provenCauses: [{ category: "interpretation", path: "skill-interpretation/glasgow-efficiency", evidence: "Audited against captured game text." }]
      })
    });

    expect(result.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "skill-interpretation/glasgow-efficiency",
      category: "interpretation",
      certainty: "proven",
      expected: 1.25,
      actual: 1.15,
      absoluteError: 0.1
    }));
    expect(result.cases[0].diagnostics.filter((item) => item.certainty === "proven")).toHaveLength(1);
  });

  it("compares every disputed formula ID deterministically without making it gate", () => {
    const fixture = optimizerBenchmarkFixtures.find((item) =>
      (item as { id?: string }).id === "base-mechanics-2026-07"
    )!;
    const formulas = (fixture as Extract<OptimizerBenchmark, { kind: "formula" }>).formulas;
    const formulaValues = Object.fromEntries(formulas.slice(1).map((formula) => [formula.id, formula.expectedValue]));
    const result = runOptimizerBenchmarkBatch([fixture], {
      "base-mechanics-2026-07": {
        metadata: {
          region: "GLOBAL",
          referenceProvenance: { version: "CN model snapshots 2026-07-31 and 2026-08-02" }
        },
        formulaValues
      }
    });

    expect(result.cases[0]).toMatchObject({
      status: "non-gating",
      smallestMismatchPath: "calculation/formula-values/operator-morale-cap"
    });
  });

  it("reports a deterministic formula-derived mismatch from a valid gating observation", () => {
    const fixture = gatingFixture("gating-formula-mismatch");
    const current = savedReferenceObservation(fixture);
    current.resources = { ...current.resources, goldProduced: expectedResource(fixture, "goldProduced") + 1 };
    const result = runOptimizerBenchmarkBatch([fixture], { [fixture.id]: current });

    expect(fixture.expected.formulas).not.toHaveLength(0);
    expect(result.cases[0]).toMatchObject({
      status: "failed",
      gating: true,
      smallestMismatchPath: "calculation/resource-values/goldProduced"
    });
  });

  it("executes disputed observations diagnostically but excludes them from gating", () => {
    const fixture = resourceFixture("JP", { confidence: "disputed" });
    const result = runOptimizerBenchmarkBatch([fixture], {
      "runner-case": observation("JP", { resources: { lmd: 1 } })
    });

    expect(result.aggregateStatus).toBe("passed");
    expect(result.counts).toEqual({ passed: 0, failed: 0, "not-run": 0, "non-gating": 1, invalid: 0 });
    expect(result.cases[0]).toMatchObject({ status: "non-gating", gating: false });
    expect(result.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "reference/disputed",
      category: "reference",
      severity: "info"
    }));
    expect(result.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "calculation/resource-values/lmd",
      passed: false
    }));
  });

  it("marks an eligible missing observation incomplete and a malformed fixture invalid without crashing", () => {
    const result = runOptimizerBenchmarkBatch([
      gatingFixture("missing-case"),
      { kind: "resource-output", id: "broken-case" }
    ], {});

    expect(result.aggregateStatus).toBe("failed");
    expect(result.counts).toEqual({ passed: 0, failed: 0, "not-run": 1, "non-gating": 0, invalid: 1 });
    expect(result.cases).toEqual([
      expect.objectContaining({ id: "missing-case", status: "not-run", smallestMismatchPath: "observation" }),
      expect.objectContaining({ id: "broken-case", status: "invalid", smallestMismatchPath: "fixture" })
    ]);
  });

  it("reports extra actual resources as informational and does not compare them", () => {
    const result = runOptimizerBenchmarkBatch([resourceFixture("JP")], {
      "runner-case": observation("JP", { resources: { lmd: 100, goldProduced: 4 } })
    });

    expect(result.cases[0].status).toBe("non-gating");
    expect(result.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "calculation/resource-values/goldProduced",
      severity: "info",
      message: expect.stringContaining("extra actual resource")
    }));
  });

  it("preserves machine-readable plan resource missing reasons without substituting zero", () => {
    const result = runOptimizerBenchmarkBatch([resourceFixture("JP")], {
      "runner-case": observation("JP", {
        resources: undefined,
        planResourceMissingReasons: [{
          code: "unsupported-trading-order-effect",
          path: "rotation/day/facilities/trading-1/operators/op/effects/skill/tradingOrderEffects/0/fixedSpecialOrder/pepe",
          message: "Trading-order effect has no faithful quantity mapping",
          operatorId: "op",
          effectId: "skill:tradingOrderEffects[0]:fixedSpecialOrder:pepe",
          effectIndex: 0,
          effectType: "fixedSpecialOrder",
          effectKind: "pepe"
        }]
      })
    });

    expect(result.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      code: "unsupported-trading-order-effect",
      path: "calculation/plan-resources/rotation/day/facilities/trading-1/operators/op/effects/skill/tradingOrderEffects/0/fixedSpecialOrder/pepe",
      category: "calculation",
      severity: "info",
      operatorId: "op",
      effectId: "skill:tradingOrderEffects[0]:fixedSpecialOrder:pepe",
      effectIndex: 0,
      effectType: "fixedSpecialOrder",
      effectKind: "pepe"
    }));
    expect(result.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "calculation/resource-values/lmd",
      actual: undefined
    }));
  });

  it("propagates evaluated sustainable-cycle failures and incomplete reasons at stable paths", () => {
    const evaluated = runOptimizerBenchmarkBatch([resourceFixture("JP")], {
      "runner-case": observation("JP", {
        planSustainability: {
          status: "evaluated",
          sustainable: false,
          failures: [{ category: "resource", code: "gold-prefix-underflow", message: "gold underflow", hour: 12 }]
        }
      })
    });
    const incomplete = runOptimizerBenchmarkBatch([resourceFixture("JP")], {
      "runner-case": observation("JP", {
        planSustainability: {
          status: "incomplete",
          missing: [{
            code: "recovery-provenance-unavailable",
            path: "rotation/day/assignments/a/recoveryProvenance",
            message: "recovery provenance missing",
            operatorId: "a",
            shiftId: "day"
          }]
        }
      })
    });

    expect(evaluated.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      code: "gold-prefix-underflow",
      path: "sustainable-cycle/failures/resource/gold-prefix-underflow/shift/none/operator/none/hour/12",
      category: "calculation",
      severity: "error",
      certainty: "proven"
    }));
    expect(incomplete.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      code: "recovery-provenance-unavailable",
      path: "sustainable-cycle/incomplete/rotation/day/assignments/a/recoveryProvenance",
      category: "state-model",
      severity: "error",
      certainty: "proven",
      operatorId: "a"
    }));
    expect(evaluated.cases[0].status).toBe("non-gating");
    expect(incomplete.cases[0].status).toBe("non-gating");
  });

  it("preserves fixture order, formats deterministic minimal failures, and does not mutate inputs", () => {
    const fixtures = [gatingFixture("z-first"), gatingFixture("a-second")];
    const observations: BenchmarkObservationMap = {
      "z-first": savedReferenceObservation(fixtures[0]),
      "a-second": savedReferenceObservation(fixtures[1])
    };
    observations["z-first"]!.resources = {
      ...observations["z-first"]!.resources,
      goldProduced: expectedResource(fixtures[0], "goldProduced") - 1
    };
    const fixturesBefore = structuredClone(fixtures);
    const observationsBefore = structuredClone(observations);

    const first = runOptimizerBenchmarkBatch(fixtures, observations);
    const second = runOptimizerBenchmarkBatch(fixtures, observations);
    const text = formatOptimizerBenchmarkBatchResult(first);

    expect(first.cases.map((item) => item.id)).toEqual(["z-first", "a-second"]);
    expect(second).toEqual(first);
    expect(text).toBe([
      "optimizer benchmarks: FAILED (passed=1 failed=1 not-run=0 non-gating=0 invalid=0)",
      "FAIL z-first calculation/resource-values/goldProduced: expected 91.183333333333, actual 90.183333333333, absolute error 1 exceeds absolute tolerance 0",
      "PASS a-second"
    ].join("\n"));
    expect(fixtures).toEqual(fixturesBefore);
    expect(observations).toEqual(observationsBefore);
  });

  it("runs every checked-in fixture offline using synthetic saved-reference observations", () => {
    const observations: BenchmarkObservationMap = Object.fromEntries(
      optimizerBenchmarkFixtures.map((raw) => {
        const fixture = raw as OptimizerBenchmark;
        const metadata = {
          region: fixture.region,
          referenceProvenance: { version: fixture.referenceProvenance.version },
          ...(fixture.runtimeDataProvenance ? {
            runtimeDataProvenance: structuredClone(fixture.runtimeDataProvenance)
          } : {}),
          ...(fixture.kind === "resource-output" ? { roster: structuredClone(fixture.roster) } : {})
        };
        if (fixture.kind === "formula") {
          return [fixture.id, {
            metadata,
            formulaValues: Object.fromEntries(fixture.formulas.map((formula) => [formula.id, formula.expectedValue]))
          }];
        }
        const authority = effectiveBenchmarkScheduleAuthority(fixture);
        const fixtureShifts = fixture.schedule?.shifts ?? fixture.rotation.shifts;
        const identityByShiftId = new Map(
          authority.status === "complete"
            ? authority.schedule.shifts.map((shift) => [shift.id, shift] as const)
            : []
        );
        return [fixture.id, {
          metadata,
          rotation: {
            cycleHours: authority.status === "complete"
              ? authority.schedule.cycleHours
              : fixture.rotation.cycleHours,
            shifts: fixtureShifts.map((shift) => ({
              id: shift.id,
              durationHours: identityByShiftId.get(shift.id)?.durationHours ??
                ("durationHours" in shift ? shift.durationHours : shift.endHour - shift.startHour),
              ...(identityByShiftId.has(shift.id) ? {
                startHour: identityByShiftId.get(shift.id)!.startHour,
                endHour: identityByShiftId.get(shift.id)!.endHour,
                activeGroupIds: [...identityByShiftId.get(shift.id)!.activeGroupIds],
                recoveryGroupIds: [...identityByShiftId.get(shift.id)!.recoveryGroupIds]
              } : {}),
              assignments: Object.fromEntries(Object.entries(shift.assignments).flatMap(([facilityId, assignment]) =>
                assignment.operatorIds ? [[facilityId, [...assignment.operatorIds]]] : []
              )),
              remoteSupportOperatorIds: Object.fromEntries(Object.entries(shift.assignments).flatMap(([facilityId, assignment]) =>
                assignment.remoteSupport?.operatorIds ? [[facilityId, [...assignment.remoteSupport.operatorIds]]] : []
              ))
            }))
          },
          resources: { ...fixture.expected.output }
        }];
      })
    );

    const result = runOptimizerBenchmarkBatch(optimizerBenchmarkFixtures, observations);

    expect(result.cases).toHaveLength(optimizerBenchmarkFixtures.length);
    expect(result.counts.invalid).toBe(0);
    expect(result.counts.failed).toBe(0);
    expect(result.aggregateStatus).toBe("passed");
    // This proves offline runner plumbing against saved data, not independent optimizer correctness.
  });
});
