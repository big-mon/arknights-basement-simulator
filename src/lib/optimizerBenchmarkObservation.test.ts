import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, AssignmentPlanDiagnostic } from "../types";
import type { ResourceOutputBenchmark } from "./optimizerBenchmark";
import type { BenchmarkObjectiveEvidence } from "./optimizerBenchmarkRunner";
import type { PlanSustainabilityEvaluation } from "./planSustainabilityTypes";

const mocks = vi.hoisted(() => ({
  generateAssignmentPlan: vi.fn(),
  evaluateReferenceCompositionDiagnostic: vi.fn()
}));

vi.mock("./optimizer", async () => {
  const actual = await vi.importActual<typeof import("./optimizer")>("./optimizer");
  return { ...actual, generateAssignmentPlan: mocks.generateAssignmentPlan };
});

vi.mock("./optimizerReferenceDiagnostic", () => ({
  evaluateReferenceCompositionDiagnostic: mocks.evaluateReferenceCompositionDiagnostic
}));

import { createResourceLedger } from "./resourceLedger";
import { observeResourceOutputBenchmark } from "./optimizerIssue27Audit";
import { operatorAvailabilitySnapshot } from "./operatorAvailability";

function fixture(): ResourceOutputBenchmark {
  return {
    kind: "resource-output",
    scope: "facility-team",
    id: "adapter-objective-evidence",
    region: "JP",
    referenceProvenance: { version: "reference-v1", observedAt: "2026-08-04" },
    runtimeDataProvenance: {
      operatorAvailabilitySourceCommit: operatorAvailabilitySnapshot.regions.JP.source.commit
    },
    confidence: "corroborated",
    sources: [{
      url: "https://example.com/reference",
      title: "Reference",
      accessedAt: "2026-08-04",
      language: "en",
      role: "throughput"
    }],
    assumptions: {
      layout: "243",
      drones: "excluded",
      facilityProducts: ["lmd"],
      objectiveProfile: "lmd",
      notes: []
    },
    roster: { mode: "all-unlocked" },
    rotation: {
      cycleHours: 24,
      workerGroupCount: 1,
      shifts: [{
        id: "day",
        durationHours: 24,
        workerGroupIds: ["group-day"],
        assignments: { "trading-1": { operatorIds: ["reference-a", "reference-b"] } }
      }]
    },
    schedule: {
      cycleHours: 24,
      groups: [{ id: "group-day" }],
      shifts: [{
        id: "day",
        startHour: 0,
        endHour: 24,
        activeGroupIds: ["group-day"],
        recoveryGroupIds: [],
        assignments: { "trading-1": { operatorIds: ["reference-a", "reference-b"] } }
      }]
    },
    expected: {
      output: { lmd: 100 },
      formulas: ["lmd = 100"],
      tolerance: { type: "relative", value: 0.001, zeroExpectedAbsolute: 0 }
    }
  };
}

function referenceEvidence(): Extract<BenchmarkObjectiveEvidence, { status: "complete" }> {
  return {
    status: "complete",
    authority: "authoritative",
    value: 1.5,
    objectiveProfile: "lmd",
    weights: { gold: 0, battleRecord: 0, lmd: 1 },
    provenance: "exact-window-facility-normal-mechanics-evaluation",
    completeness: {
      supportResourceScenario: "complete",
      resourceEvaluation: "complete",
      requiredWindowIds: ["day"],
      evaluatedWindowIds: ["day"],
      requiredFacilityEvaluationCount: 1,
      evaluatedFacilityEvaluationCount: 1
    },
    sustainability: {
      status: "evaluated",
      assumptions: {},
      convergence: {},
      input: {},
      result: { sustainable: true, failures: [] },
      missing: []
    } as unknown as PlanSustainabilityEvaluation
  };
}

function generatedPlan(state: AppState) {
  const productionFacilities = state.facilities.filter((facility) =>
    facility.type === "factory" || facility.type === "trading"
  );
  const assignments = productionFacilities.flatMap((facility) => Array.from(
    { length: facility.slotCount },
    (_, index) => ({
      facilityId: facility.id,
      operatorId: `candidate-${facility.id}-${index}`,
      skillId: "synthetic",
      score: 0,
      efficiency: 0
    })
  ));
  return {
    generatedAt: "2026-08-06T00:00:00.000Z",
    totalScore: 0,
    dailyValue: 0,
    facilityPlans: [],
    schedule: structuredClone(state.schedule),
    rotation: [{
      shiftId: "day",
      hours: 24,
      activeGroupIds: ["group-day"],
      incompleteGroupIds: [],
      assignments,
      recovery: []
    }],
    diagnostics: [{
      code: "schedule-group-search-profile",
      message: "complete synthetic search",
      completion: "complete",
      dimensionIds: [],
      groupIds: ["group-day"],
      optionCounts: {},
      visitedStates: 1,
      discardedStates: 0,
      feasibilityVisitedStates: 1,
      feasibilityWorkBudget: 1,
      feasibilityBudgetExhausted: false,
      optimizationVisitedStates: 1,
      optimizationWorkBudget: 1,
      optimizationBudgetExhausted: false,
      incompleteDimensionIds: []
    }, {
      code: "scheduled-support-profile",
      message: "complete synthetic support",
      completion: "complete",
      provenance: "bounded-scheduled-support-materialization-not-certified",
      supportPlacements: [{
        kind: "ordinary",
        operatorId: "supporter",
        facilityId: "control-1",
        groupId: "group-day",
        scheduleWindowIds: ["day"],
        recoveryWindowIds: []
      }],
      supportCapacityValidated: true,
      supportRecoveryValidated: true,
      issues: []
    }],
    resources: {
      status: "complete",
      assumptions: {},
      windows: [{ shiftId: "day", facilities: [] }],
      missing: [],
      cycleLedger: createResourceLedger(),
      per24Ledger: createResourceLedger()
    },
    sustainability: {
      status: "evaluated",
      assumptions: {},
      convergence: {},
      input: {},
      result: { sustainable: true, failures: [] },
      missing: []
    } as unknown as PlanSustainabilityEvaluation,
    warnings: [],
    windowFacilityEfficiencyEvaluations: productionFacilities.map((facility) => ({
      scheduleWindowId: "day",
      facilityId: facility.id,
      additiveEfficiency: 0,
      fixedResourceAmounts: {},
      provenance: "optimizer-normal-team-reevaluation-with-schedule-aware-contiguous-work-and-resolved-support-context"
    }))
  };
}

function withDiagnostic(state: AppState, diagnostic: AssignmentPlanDiagnostic) {
  const plan = generatedPlan(state);
  return { ...plan, diagnostics: [...plan.diagnostics, diagnostic] };
}

describe("resource-output benchmark observation objective evidence", () => {
  beforeEach(() => {
    mocks.generateAssignmentPlan.mockImplementation((state: AppState) => generatedPlan(state));
    mocks.evaluateReferenceCompositionDiagnostic.mockReturnValue({
      status: "complete",
      diagnostics: [],
      objectiveEvidence: referenceEvidence()
    });
  });

  it("propagates typed exact candidate/reference evidence and scheduled support diagnostics", () => {
    const observation = observeResourceOutputBenchmark(fixture());

    expect(observation.objectiveEvidence?.candidate).toMatchObject({
      status: "complete",
      authority: "authoritative",
      objectiveProfile: "lmd",
      provenance: "exact-window-facility-normal-mechanics-evaluation",
      sustainability: {
        status: "evaluated",
        result: { sustainable: true, failures: [] }
      }
    });
    expect(observation.objectiveEvidence?.reference).toEqual(referenceEvidence());
    expect(observation.planEvidence?.scheduledSupport).toMatchObject({
      completion: "complete",
      supportPlacements: [{ operatorId: "supporter", scheduleWindowIds: ["day"] }],
      supportCapacityValidated: true,
      supportRecoveryValidated: true,
      issues: []
    });
    expect(observation.planEvidence?.search.proofStatus).toBe("certified");
  });

  it("does not certify an exhaustive composition when bounded joint-support search affected the result", () => {
    mocks.generateAssignmentPlan.mockImplementation((state: AppState) => withDiagnostic(state, {
      code: "joint-support-search-not-certified",
      message: "bounded joint support search",
      provenance: "bounded-joint-static-support-production-removal-proven",
      initialAggregateScore: 1,
      bestProductionOnlyAggregateScore: 1,
      bestStaticOnlyAggregateScore: 1,
      aggregateScore: 2,
      initialSupportOperatorIds: [],
      selectedSupportOperatorIds: ["supporter"],
      requirementSignatures: ["supporter"],
      rounds: 1,
      roundLimit: 1,
      work: 1,
      workLimit: 1,
      discardedOptions: 0,
      seedCount: 1,
      seedLimit: 1,
      discardedSeeds: 0,
      retainedRequirementSignatures: ["supporter"],
      startsEvaluated: 1,
      removalProofs: []
    }));

    expect(observeResourceOutputBenchmark(fixture()).planEvidence?.search).toMatchObject({
      completion: "complete",
      proofStatus: "not-certified"
    });
  });

  it.each<AssignmentPlanDiagnostic>([
    {
      code: "composition-search-not-certified",
      message: "candidate generation was bounded",
      limitation: "candidate-generation-limited",
      visitedStates: 1,
      discardedStates: 0,
      feasibilityVisitedStates: 1,
      feasibilityWorkBudget: 1,
      feasibilityBudgetExhausted: false,
      optimizationVisitedStates: 1,
      optimizationWorkBudget: 1,
      optimizationBudgetExhausted: false,
      candidateGenerationInputCount: 2,
      candidateGenerationConstructedCount: 2,
      candidateGenerationRetainedCount: 1
    },
    {
      code: "scheduled-support-materialization-not-certified",
      message: "scheduled support was not fully materialized",
      completion: "incomplete",
      supportPlacements: [],
      supportCapacityValidated: false,
      supportRecoveryValidated: false,
      issues: []
    }
  ])("aggregates $code into search proof status", (diagnostic) => {
    mocks.generateAssignmentPlan.mockImplementation((state: AppState) => withDiagnostic(state, diagnostic));

    expect(observeResourceOutputBenchmark(fixture()).planEvidence?.search.proofStatus).toBe("not-certified");
  });

  it("reports unavailable candidate authority instead of a partial objective number", () => {
    mocks.generateAssignmentPlan.mockImplementation((state: AppState) => ({
      ...generatedPlan(state),
      windowFacilityEfficiencyEvaluations: []
    }));

    expect(observeResourceOutputBenchmark(fixture()).objectiveEvidence?.candidate).toMatchObject({
      status: "incomplete",
      authority: "unavailable",
      reason: "candidate-objective-requires-complete-exact-window-facility-mechanics"
    });
  });

  it("keeps generated plan and both mechanical objectives independent of expected output", () => {
    const original = fixture();
    const changed = structuredClone(original);
    changed.expected.output.lmd = 987654321;

    expect(observeResourceOutputBenchmark(changed)).toEqual(observeResourceOutputBenchmark(original));
  });
});
