import { createDefaultState } from "../data/defaults";
import { optimizerBenchmarkFixtures } from "../data/optimizer-benchmarks";
import { createMaxLevel243BenchmarkContext } from "./benchmarkBaseContext";
import { simulateFacilityProduction } from "./facilityProduction";
import {
  availableOperatorIds,
  operatorAvailabilitySnapshot,
  type OperatorAvailabilityRegion
} from "./operatorAvailability";
import { evaluateExactWindowFacilityObjective, generateAssignmentPlan } from "./optimizer";
import {
  isAuthoritativeObjectiveSustainability,
  runOptimizerBenchmarkBatch,
  type BenchmarkObjectiveEvidence,
  type BenchmarkObservation,
  type BenchmarkObservationMap,
  type OptimizerBenchmarkBatchResult
} from "./optimizerBenchmarkRunner";
import { evaluateSustainableCycle, type SustainableCycleInput } from "./sustainableCycleEvaluator";
import { simulateTradingPostDrones24h } from "./tradingPostDrones";
import {
  effectiveBenchmarkScheduleAuthority,
  resourceObjectiveWeights,
  validateOptimizerBenchmark,
  type BenchmarkResourceOutput,
  type ResourceOutputBenchmark
} from "./optimizerBenchmark";
import { createResourceLedger } from "./resourceLedger";
import type { Assignment, AppState, GenerateAssignmentPlanOptions, ScheduleState } from "../types";
import { evaluateReferenceCompositionDiagnostic } from "./optimizerReferenceDiagnostic";

const acceptedWikiruFixtureId = "jp-wikiru-backup38-12h-v2";

function emptyCycle(overrides: Partial<SustainableCycleInput> = {}): SustainableCycleInput {
  const schedule = createDefaultState().schedule;
  return {
    schedule,
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

function observeDefaultMoraleCap(): number {
  let largestAccepted = 0;
  for (let morale = 1; morale <= 100; morale += 1) {
    try {
      evaluateSustainableCycle(emptyCycle({ initialMorale: { probe: morale } }));
      largestAccepted = morale;
    } catch (error) {
      if (error instanceof RangeError && /morale cap/.test(error.message)) break;
      throw error;
    }
  }
  return largestAccepted;
}

function createMechanicsObservation(): BenchmarkObservation {
  const moraleCap = observeDefaultMoraleCap();
  const work = emptyCycle({ initialMorale: { worker: moraleCap } });
  work.shifts[0].assignments.push({ facilityId: "factory-1", operatorId: "worker" });
  const workResult = evaluateSustainableCycle(work);
  const recoveryResult = evaluateSustainableCycle(emptyCycle({
    initialMorale: { resting: 0 },
    recoveryPlacements: [{
      dormitoryId: "dormitory-1",
      operatorId: "resting",
      startHour: 0,
      endHour: 12
    }]
  }));
  const gold = simulateFacilityProduction({
    durationHours: 1,
    facility: { kind: "factory", level: 3, product: "gold" }
  });
  const records = simulateFacilityProduction({
    durationHours: 1,
    facility: { kind: "factory", level: 3, product: "battleRecord" }
  });
  const orders = simulateFacilityProduction({
    durationHours: 1,
    facility: { kind: "tradingPost", level: 3, orderType: "normalLmd" }
  });
  const drones = simulateTradingPostDrones24h({
    initialDrones: 0,
    powerPlantSkillIncrements: [],
    allocations: [
      { slot: 0, targetFacilityId: "trading-1", drones: 1 },
      { slot: 1, targetFacilityId: "trading-1", drones: 0 }
    ],
    baseContext: createMaxLevel243BenchmarkContext()
  });
  const probability = (goldAmount: number) =>
    orders.orderDistribution.outcomes.find((outcome) => outcome.gold === goldAmount)?.probability ?? Number.NaN;

  return {
    metadata: {
      region: "GLOBAL"
    },
    formulaValues: {
      "operator-morale-cap": moraleCap,
      "base-morale-consumption": (moraleCap - workResult.operators[0].finalMorale) / 12,
      "max-dormitory-recovery": recoveryResult.operators[0].timeline[0].ratePerHour,
      "drone-cap": drones.inventory.cap,
      "base-drone-recovery": drones.generation.baseRatePerHour,
      "drone-time-reduction": drones.targets[0].shortenedMinutes,
      "battle-record-time": records.base.minutesPerUnit,
      "battle-record-exp": "expPerUnit" in records.base ? records.base.expPerUnit : Number.NaN,
      "gold-time": gold.base.minutesPerUnit,
      "order-two-probability": probability(2),
      "order-three-probability": probability(3),
      "order-four-probability": probability(4),
      "expected-order-gold": orders.orderDistribution.expectedGoldPerOrder,
      "expected-order-lmd": orders.orderDistribution.expectedLmdPerOrder,
      "expected-order-time": orders.base.minutesPerOrder
    }
  };
}

function assignmentsByFacility(assignments: readonly Assignment[]): Record<string, string[]> {
  const grouped: Record<string, string[]> = {};
  for (const assignment of assignments) {
    (grouped[assignment.facilityId] ??= []).push(assignment.operatorId);
  }
  return Object.fromEntries(
    Object.entries(grouped).map(([facilityId, operatorIds]) => [facilityId, [...operatorIds].sort()])
  );
}

function createOwnedRegionalState(
  region: OperatorAvailabilityRegion,
  explicitOperatorIds?: readonly string[]
): AppState {
  const state = createDefaultState();
  state.region = region;
  const regionAvailableIds = availableOperatorIds(operatorAvailabilitySnapshot, state.region);
  const requestedIds = new Set(explicitOperatorIds ?? regionAvailableIds);
  for (const entry of Object.values(state.roster)) entry.owned = false;
  for (const operatorId of regionAvailableIds) {
    if (!requestedIds.has(operatorId)) continue;
    const entry = state.roster[operatorId];
    if (entry) {
      entry.owned = true;
    } else {
      // Availability can lead the lightweight operator catalog. Keeping the ID in
      // AppState makes ownership metadata exact; the optimizer still ignores IDs
      // that have no operator record when it consumes this same state.
      state.roster[operatorId] = {
        owned: true,
        elite: 0,
        level: 1,
        potential: 1,
        moduleEnabled: false
      };
    }
  }
  return state;
}

export function createIssue27OptimizerObservation(
  region: OperatorAvailabilityRegion,
  explicitOperatorIds?: readonly string[]
): BenchmarkObservation {
  return createIssue27OptimizerObservationForSchedule(region, explicitOperatorIds);
}

function createIssue27OptimizerObservationForSchedule(
  region: OperatorAvailabilityRegion,
  explicitOperatorIds?: readonly string[],
  schedule?: ScheduleState
): BenchmarkObservation {
  return createOptimizerObservation(region, explicitOperatorIds, schedule);
}

export function createResourceOutputBenchmarkExecutionInput(
  fixture: ResourceOutputBenchmark
): { state: AppState; options: GenerateAssignmentPlanOptions } {
  const explicitOperatorIds = fixture.roster.mode === "explicit" ? fixture.roster.operatorIds : undefined;
  const state = createOwnedRegionalState(fixture.region, explicitOperatorIds);
  const objectiveProfile = fixture.assumptions.objectiveProfile;
  if (objectiveProfile === "formula-only") {
    throw new Error("resource-output benchmark objectiveProfile cannot be formula-only");
  }
  const schedule = benchmarkScheduleFromValidatedFixture(fixture);
  if (!schedule) {
    throw new Error(`${fixture.id} must provide a complete effective benchmark schedule authority`);
  }
  state.preference = { ...resourceObjectiveWeights[objectiveProfile] };
  state.schedule = schedule;
  return {
    state,
    options: fixture.supportResourceScenario === undefined
      ? {}
      : { supportResourceScenario: fixture.supportResourceScenario }
  };
}

function createOptimizerObservation(
  region: OperatorAvailabilityRegion,
  explicitOperatorIds?: readonly string[],
  schedule?: ScheduleState
): BenchmarkObservation {
  const state = createOwnedRegionalState(region, explicitOperatorIds);
  if (schedule) state.schedule = structuredClone(schedule);
  const regionSnapshot = operatorAvailabilitySnapshot.regions[state.region];
  const actualOwnedOperatorIds = regionSnapshot.operatorIds.filter((operatorId) => state.roster[operatorId]?.owned);
  const roster: NonNullable<BenchmarkObservation["metadata"]["roster"]> =
    actualOwnedOperatorIds.length === regionSnapshot.operatorIds.length
      ? { mode: "all-unlocked" }
      : { mode: "explicit", operatorIds: actualOwnedOperatorIds };
  const plan = generateAssignmentPlan(state);
  const observation: BenchmarkObservation = {
    metadata: {
      region: state.region,
      runtimeDataProvenance: { operatorAvailabilitySourceCommit: regionSnapshot.source.commit },
      roster
    },
    rotation: {
      cycleHours: plan.schedule.cycleHours,
      shifts: plan.rotation.map((window) => ({
        id: window.shiftId,
        durationHours: window.hours,
        startHour: window.startHour,
        endHour: window.endHour,
        activeGroupIds: [...window.activeGroupIds],
        recoveryGroupIds: [...window.recoveryGroupIds],
        assignments: assignmentsByFacility(window.assignments)
      }))
    },
    ...(plan.resources.status === "complete" && plan.resources.per24Ledger
      ? { resources: benchmarkResources(plan.resources.per24Ledger) }
      : { planResourceMissingReasons: plan.resources.missing }),
    planSustainability: plan.sustainability.status === "evaluated"
      ? {
          status: "evaluated",
          sustainable: plan.sustainability.result.sustainable,
          failures: plan.sustainability.result.failures
        }
      : { status: "incomplete", missing: plan.sustainability.missing }
  };
  return observation;
}

export function observeResourceOutputBenchmark(fixture: ResourceOutputBenchmark): BenchmarkObservation {
  const { state, options } = createResourceOutputBenchmarkExecutionInput(fixture);
  const plan = generateAssignmentPlan(state, options);
  const source = operatorAvailabilitySnapshot.regions[fixture.region].source;
  const facilityIds = benchmarkFacilityIds(state);
  const requiredWindowIds = state.schedule.shifts.map((shift) => shift.id);
  const productionFacilities = state.facilities.filter((facility) =>
    facility.type === "factory" || facility.type === "trading"
  );
  const searchProfile = plan.diagnostics.find((diagnostic) => diagnostic.code === "schedule-group-search-profile");
  const scheduledSupportProfile = plan.diagnostics.find((diagnostic) => diagnostic.code === "scheduled-support-profile");
  const requestedScenario = options.supportResourceScenario;
  const scenario = plan.supportResourceScenario;
  const observation = createPlanObservation(state, fixture.roster, source.commit, plan, facilityIds);
  const referenceDiagnostic = evaluateReferenceCompositionDiagnostic(fixture);
  return {
    ...observation,
    objectiveEvidence: {
      candidate: evaluateCandidateObjectiveEvidence(fixture, state, plan),
      reference: referenceDiagnostic.objectiveEvidence
    },
    planEvidence: {
      search: {
        completion: searchProfile?.completion ?? "unknown",
        proofStatus: benchmarkSearchProofStatus(searchProfile?.completion, plan.diagnostics),
        diagnostics: structuredClone(plan.diagnostics)
      },
      production: {
        requiredWindowIds,
        completedWindowIds: plan.rotation.filter((window) =>
          window.incompleteGroupIds.length === 0 && productionFacilities.every((facility) =>
            window.assignments.filter((assignment) => assignment.facilityId === facility.id).length === facility.slotCount
          )
        ).map((window) => window.shiftId),
        requiredFacilitySlots: state.schedule.shifts.flatMap((shift) => productionFacilities.map((facility) => ({
          shiftId: shift.id,
          facilityId: facilityIds.get(facility.id) ?? facility.id,
          slotCount: facility.slotCount
        }))),
        actualFacilityOperators: plan.rotation.flatMap((window) => productionFacilities.map((facility) => ({
          shiftId: window.shiftId,
          facilityId: facilityIds.get(facility.id) ?? facility.id,
          operatorIds: window.assignments
            .filter((assignment) => assignment.facilityId === facility.id)
            .map((assignment) => assignment.operatorId)
        })))
      },
      simultaneousOperatorConflicts: plan.rotation.flatMap((window) => {
        const counts = new Map<string, number>();
        for (const assignment of window.assignments) {
          counts.set(assignment.operatorId, (counts.get(assignment.operatorId) ?? 0) + 1);
        }
        return [...counts].filter(([, count]) => count > 1).map(([operatorId]) => ({
          shiftId: window.shiftId,
          operatorId
        }));
      }),
      ...(requestedScenario ? {
        supportResourceScenario: {
          requested: true,
          complete: scenario?.complete === true,
          requestedSourceIds: requestedScenario.sources.map((item) => item.id),
          resolvedSourceIds: scenario?.sources
            .filter((item) => item.status === "resolved")
            .map((item) => item.source.id) ?? [],
          fixedSourceEvidenceSourceIds: plan.resources.evidence?.fixedSources.map((item) => item.sourceId) ?? [],
          fixedContextRequested: requestedScenario.fixedContext !== undefined,
          fixedContextResolved: requestedScenario.fixedContext === undefined ||
            scenario?.fixedContext?.dormitoryOccupancy.status === "resolved"
        }
      } : {}),
      scheduledSupport: scheduledSupportProfile
        ? {
            completion: scheduledSupportProfile.completion,
            provenance: scheduledSupportProfile.provenance,
            supportPlacements: structuredClone(scheduledSupportProfile.supportPlacements),
            supportCapacityValidated: scheduledSupportProfile.supportCapacityValidated,
            supportRecoveryValidated: scheduledSupportProfile.supportRecoveryValidated,
            issues: structuredClone(scheduledSupportProfile.issues)
          }
        : {
            completion: "incomplete",
            provenance: "bounded-scheduled-support-materialization-not-certified",
            supportPlacements: [],
            supportCapacityValidated: false,
            supportRecoveryValidated: false,
            issues: [{
              code: "support-placement-not-materialized",
              scheduleWindowIds: [],
              message: "scheduled-support-profile diagnostic is unavailable"
            }]
          },
      resourceEvaluation: {
        status: plan.resources.status,
        requiredWindowIds,
        evaluatedWindowIds: plan.resources.windows.map((window) => window.shiftId),
        missingCount: plan.resources.missing.length
      }
    }
  };
}

function benchmarkSearchProofStatus(
  completion: "complete" | "infeasible" | "unknown" | undefined,
  diagnostics: readonly { code: string }[]
): "certified" | "not-certified" {
  if (completion !== "complete") return "not-certified";
  return diagnostics.some((diagnostic) => diagnostic.code.endsWith("-not-certified"))
    ? "not-certified"
    : "certified";
}

export function evaluateCandidateObjectiveEvidence(
  fixture: ResourceOutputBenchmark,
  state: AppState,
  plan: ReturnType<typeof generateAssignmentPlan>
): BenchmarkObjectiveEvidence {
  const objectiveProfile = fixture.assumptions.objectiveProfile;
  const requiredWindowIds = state.schedule.shifts.map((shift) => shift.id);
  const productionFacilityIds = new Set(state.facilities
    .filter((facility) => facility.type === "factory" || facility.type === "trading")
    .map((facility) => facility.id));
  const evaluations = (plan.windowFacilityEfficiencyEvaluations ?? []).filter((evaluation) =>
    requiredWindowIds.includes(evaluation.scheduleWindowId) && productionFacilityIds.has(evaluation.facilityId)
  );
  const authoritativeEvaluations = evaluations.filter((evaluation) =>
    evaluation.provenance === "optimizer-normal-team-reevaluation-with-schedule-aware-contiguous-work-and-resolved-support-context" &&
    Number.isFinite(evaluation.additiveEfficiency)
  );
  const evaluationPairCounts = new Map<string, number>();
  for (const evaluation of authoritativeEvaluations) {
    const key = `${evaluation.scheduleWindowId}\u0000${evaluation.facilityId}`;
    evaluationPairCounts.set(key, (evaluationPairCounts.get(key) ?? 0) + 1);
  }
  const expectedEvaluationPairs = requiredWindowIds.flatMap((windowId) =>
    [...productionFacilityIds].map((facilityId) => `${windowId}\u0000${facilityId}`)
  );
  const evaluatedWindowIds = [...new Set(authoritativeEvaluations.map((evaluation) => evaluation.scheduleWindowId))];
  const requiredFacilityEvaluationCount = requiredWindowIds.length * productionFacilityIds.size;
  const completeness = {
    supportResourceScenario: (fixture.supportResourceScenario === undefined || plan.supportResourceScenario?.complete === true)
      ? "complete" as const
      : "incomplete" as const,
    resourceEvaluation: plan.resources.status,
    requiredWindowIds,
    evaluatedWindowIds,
    requiredFacilityEvaluationCount,
    evaluatedFacilityEvaluationCount: authoritativeEvaluations.length
  };
  const weights = objectiveProfile === "formula-only" ? undefined : resourceObjectiveWeights[objectiveProfile];
  const value = weights === undefined ? undefined : evaluateExactWindowFacilityObjective({
    schedule: state.schedule,
    facilities: state.facilities,
    preference: weights,
    evaluations: authoritativeEvaluations
  });
  const complete = value !== undefined && Number.isFinite(value) &&
    completeness.supportResourceScenario === "complete" &&
    completeness.resourceEvaluation === "complete" &&
    isAuthoritativeObjectiveSustainability(plan.sustainability) &&
    requiredWindowIds.length === evaluatedWindowIds.length &&
    requiredWindowIds.every((windowId) => evaluatedWindowIds.includes(windowId)) &&
    requiredFacilityEvaluationCount > 0 &&
    requiredFacilityEvaluationCount === authoritativeEvaluations.length &&
    expectedEvaluationPairs.every((key) => evaluationPairCounts.get(key) === 1);
  if (!complete || weights === undefined || value === undefined || objectiveProfile === "formula-only") {
    return {
      status: "incomplete",
      authority: "unavailable",
      objectiveProfile,
      ...(weights ? { weights } : {}),
      provenance: "exact-window-facility-normal-mechanics-evaluation",
      completeness,
      sustainability: plan.sustainability,
      reason: "candidate-objective-requires-complete-exact-window-facility-mechanics"
    };
  }
  return {
    status: "complete",
    authority: "authoritative",
    value,
    objectiveProfile,
    weights,
    provenance: "exact-window-facility-normal-mechanics-evaluation",
    completeness,
    sustainability: plan.sustainability
  };
}

function benchmarkFacilityIds(state: AppState): Map<string, string> {
  const ids = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const facility of state.facilities) {
    if (facility.type !== "factory") {
      ids.set(facility.id, facility.id);
      continue;
    }
    const product = facility.product === "battleRecord" ? "battle-record" : facility.product;
    const index = (counts.get(product) ?? 0) + 1;
    counts.set(product, index);
    ids.set(facility.id, `factory-${product}-${index}`);
  }
  return ids;
}

function createPlanObservation(
  state: AppState,
  roster: BenchmarkObservation["metadata"]["roster"],
  sourceCommit: string,
  plan: ReturnType<typeof generateAssignmentPlan>,
  facilityIds: ReadonlyMap<string, string> = new Map()
): BenchmarkObservation {
  return {
    metadata: {
      region: state.region,
      runtimeDataProvenance: { operatorAvailabilitySourceCommit: sourceCommit },
      roster
    },
    rotation: {
      cycleHours: plan.schedule.cycleHours,
      shifts: plan.rotation.map((window) => ({
        id: window.shiftId,
        durationHours: window.hours,
        assignments: Object.fromEntries(Object.entries(assignmentsByFacility(window.assignments)).map(
          ([facilityId, operatorIds]) => [facilityIds.get(facilityId) ?? facilityId, operatorIds]
        ))
      }))
    },
    ...(plan.resources.status === "complete" && plan.resources.per24Ledger
      ? { resources: benchmarkResources(plan.resources.per24Ledger) }
      : { planResourceMissingReasons: plan.resources.missing }),
    planSustainability: plan.sustainability.status === "evaluated"
      ? {
          status: "evaluated",
          sustainable: plan.sustainability.result.sustainable,
          failures: plan.sustainability.result.failures
        }
      : { status: "incomplete", missing: plan.sustainability.missing }
  };
}

function benchmarkResources(
  ledger: NonNullable<ReturnType<typeof generateAssignmentPlan>["resources"]["per24Ledger"]>
): BenchmarkResourceOutput {
  return {
    goldProduced: ledger.goldProduced,
    goldConsumed: ledger.goldConsumed,
    goldNetChange: ledger.goldNetChange,
    battleRecordExp: ledger.battleRecordExp,
    lmd: ledger.lmd,
    dronesUsed: ledger.dronesUsed,
    droneLmd: ledger.drone.lmd,
    droneGoldConsumed: ledger.drone.goldConsumed
  };
}

export function createIssue27CurrentObservations(
  fixtures: readonly unknown[] = optimizerBenchmarkFixtures
): BenchmarkObservationMap {
  const glasgowIds = ["char_4110_delphn", "char_154_morgan", "char_112_siege"] as const;
  const phase1Candidate = fixtures.find((fixture) =>
    (fixture as { id?: string }).id === acceptedWikiruFixtureId
  );
  const phase1Validation = validateOptimizerBenchmark(phase1Candidate);
  if (!phase1Validation.ok) {
    throw new Error("jp-wikiru-backup38-12h-v2 must retain its explicit regional roster");
  }
  const phase1Fixture = phase1Validation.value;
  if (
    phase1Fixture.id !== acceptedWikiruFixtureId ||
    phase1Fixture.kind !== "resource-output" ||
    phase1Fixture.roster.mode !== "explicit"
  ) {
    throw new Error("jp-wikiru-backup38-12h-v2 must retain its explicit regional roster");
  }
  const phase1OperatorIds = phase1Fixture.roster.operatorIds;
  const phase1Schedule = benchmarkScheduleFromValidatedFixture(phase1Fixture);
  if (!phase1Schedule) {
    throw new Error(`${acceptedWikiruFixtureId} must retain its complete canonical rotation witness`);
  }
  return {
    "base-mechanics-2026-07": createMechanicsObservation(),
    "jp-243-factory-3group-2025-11": observeBenchmark(fixtures, "jp-243-factory-3group-2025-11"),
    "jp-glasgow-trading-125": createIssue27OptimizerObservationForSchedule("JP", glasgowIds, benchmarkSchedule(fixtures, "jp-glasgow-trading-125")),
    "cn-243-3shift-2026-06": observeDiagnosticOnlyBenchmark(fixtures, "cn-243-3shift-2026-06"),
    "jp-wikiru-backup38-12h-v2": createIssue27OptimizerObservationForSchedule(
      phase1Fixture.region,
      phase1OperatorIds,
      phase1Schedule
    )
  };
}

function benchmarkScheduleFromValidatedFixture(fixture: ResourceOutputBenchmark): ScheduleState | undefined {
  const authority = effectiveBenchmarkScheduleAuthority(fixture);
  if (authority.status === "incomplete") return undefined;
  return {
    cycleHours: authority.schedule.cycleHours,
    groups: authority.schedule.groups.map((group) => ({ ...group })),
    shifts: authority.schedule.shifts.map(
      ({ id, startHour, endHour, activeGroupIds, recoveryGroupIds }) => ({
        id,
        startHour,
        endHour,
        activeGroupIds: [...activeGroupIds],
        recoveryGroupIds: [...recoveryGroupIds]
      })
    )
  };
}

function observeDiagnosticOnlyBenchmark(fixtures: readonly unknown[], id: string): BenchmarkObservation {
  const fixture = validatedResourceOutputBenchmark(fixtures, id);
  const { state } = createResourceOutputBenchmarkExecutionInput(fixture);
  const source = operatorAvailabilitySnapshot.regions[fixture.region].source;
  return {
    metadata: {
      region: state.region,
      runtimeDataProvenance: { operatorAvailabilitySourceCommit: source.commit },
      roster: fixture.roster
    },
    rotation: {
      cycleHours: state.schedule.cycleHours,
      shifts: state.schedule.shifts.map((shift) => ({
        id: shift.id,
        durationHours: shift.endHour - shift.startHour,
        assignments: {}
      }))
    },
    planResourceMissingReasons: state.schedule.shifts.map((shift) => ({
      code: "schedule-group-unpopulated" as const,
      path: `schedule/${shift.id}`,
      scheduleWindowId: shift.id,
      message: "diagnostic-only secondary observation does not execute global composition search"
    }))
  };
}

function observeBenchmark(fixtures: readonly unknown[], id: string): BenchmarkObservation {
  return observeResourceOutputBenchmark(validatedResourceOutputBenchmark(fixtures, id));
}

function validatedResourceOutputBenchmark(fixtures: readonly unknown[], id: string): ResourceOutputBenchmark {
  const fixture = fixtures
    .map(validateOptimizerBenchmark)
    .flatMap((result) => result.ok ? [result.value] : [])
    .find((item) => item.kind === "resource-output" && item.id === id);
  if (!fixture || fixture.kind !== "resource-output") throw new Error(`missing benchmark schedule ${id}`);
  return fixture;
}

function benchmarkSchedule(fixtures: readonly unknown[], id: string): ScheduleState {
  const fixture = fixtures
    .map(validateOptimizerBenchmark)
    .flatMap((result) => result.ok ? [result.value] : [])
    .find((item) => item.kind === "resource-output" && item.id === id);
  if (!fixture || fixture.kind !== "resource-output") {
    throw new Error(`missing benchmark schedule ${id}`);
  }
  const schedule = benchmarkScheduleFromValidatedFixture(fixture);
  if (!schedule) throw new Error(`missing benchmark schedule ${id}`);
  return schedule;
}

export function runIssue27CurrentImplementationAudit(): OptimizerBenchmarkBatchResult {
  return runOptimizerBenchmarkBatch(optimizerBenchmarkFixtures, createIssue27CurrentObservations());
}
