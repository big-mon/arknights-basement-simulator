import {
  effectiveBenchmarkScheduleAuthority,
  hasResolvedExecutableCompositionAuthority,
  isPassFailEligible,
  resourceObjectiveWeights,
  validateOptimizerBenchmark,
  type BenchmarkEquivalentComposition,
  type BenchmarkRegion,
  type BenchmarkResourceName,
  type BenchmarkResourceOutput,
  type BenchmarkTolerance,
  type OptimizerBenchmark,
  type ResourceObjectiveProfile,
  type ResourceOutputBenchmark
} from "./optimizerBenchmark";
import type { PlanResourceMissingReason } from "./planResourceTypes";
import type { CycleFailure } from "./sustainableCycleEvaluator";
import type { PlanSustainabilityMissingReason } from "./planSustainabilityTypes";
import type { PlanSustainabilityEvaluation } from "./planSustainabilityTypes";
import type {
  AssignmentPlanDiagnostic,
  ScheduledSupportPlacement,
  ScheduledSupportValidationIssue
} from "../types";

export type BenchmarkDiagnosticCategory =
  | "source-data"
  | "state-model"
  | "search"
  | "interpretation"
  | "calculation"
  | "reference";

export interface BenchmarkObjectiveCompleteness {
  supportResourceScenario: "complete" | "incomplete";
  resourceEvaluation: "complete" | "incomplete";
  requiredWindowIds: readonly string[];
  evaluatedWindowIds: readonly string[];
  requiredFacilityEvaluationCount: number;
  evaluatedFacilityEvaluationCount: number;
}

export type BenchmarkObjectiveSustainabilityEvidence =
  | PlanSustainabilityEvaluation
  | { status: "unavailable"; reason: string };

export function isAuthoritativeObjectiveSustainability(
  evidence: BenchmarkObjectiveSustainabilityEvidence | undefined
): boolean {
  return evidence?.status === "evaluated" &&
    evidence.result.sustainable === true && evidence.result.failures.length === 0;
}

export type BenchmarkObjectiveEvidence =
  | {
      status: "complete";
      authority: "authoritative";
      value: number;
      objectiveProfile: ResourceObjectiveProfile;
      weights: Readonly<{ gold: number; battleRecord: number; lmd: number }>;
      provenance: "exact-window-facility-normal-mechanics-evaluation";
      completeness: Readonly<BenchmarkObjectiveCompleteness>;
      sustainability: BenchmarkObjectiveSustainabilityEvidence;
    }
  | {
      status: "incomplete";
      authority: "unavailable";
      objectiveProfile: ResourceOutputBenchmark["assumptions"]["objectiveProfile"];
      weights?: Readonly<{ gold: number; battleRecord: number; lmd: number }>;
      provenance: "exact-window-facility-normal-mechanics-evaluation";
      completeness: Readonly<BenchmarkObjectiveCompleteness>;
      sustainability: BenchmarkObjectiveSustainabilityEvidence;
      reason: string;
    };

export interface BenchmarkObservation {
  metadata: {
    region: BenchmarkRegion;
    referenceProvenance?: {
      version: string;
    };
    runtimeDataProvenance?: {
      operatorAvailabilitySourceCommit: string;
    };
    roster?: ResourceOutputBenchmark["roster"];
  };
  rotation?: {
    cycleHours: number;
    shifts: Array<{
      id: string;
      durationHours: number;
      startHour?: number;
      endHour?: number;
      activeGroupIds?: string[];
      recoveryGroupIds?: string[];
      assignments: Record<string, string[]>;
      remoteSupportOperatorIds?: Record<string, string[]>;
    }>;
  };
  resources?: BenchmarkResourceOutput;
  planResourceMissingReasons?: readonly Readonly<PlanResourceMissingReason>[];
  planSustainability?:
    | { status: "evaluated"; sustainable: boolean; failures: readonly Readonly<CycleFailure>[] }
    | { status: "incomplete"; missing: readonly Readonly<PlanSustainabilityMissingReason>[] };
  formulaValues?: Record<string, number>;
  interpretedEffects?: Array<{ id: string; expected: number; actual: number }>;
  provenCauses?: Array<{
    category: BenchmarkDiagnosticCategory;
    path: string;
    evidence: string;
  }>;
  objectiveEvidence?: {
    candidate: BenchmarkObjectiveEvidence;
    reference: BenchmarkObjectiveEvidence;
  };
  planEvidence?: {
    search: {
      completion: "complete" | "infeasible" | "unknown";
      proofStatus: "certified" | "not-certified";
      diagnostics: readonly Readonly<AssignmentPlanDiagnostic>[];
    };
    production: {
      requiredWindowIds: readonly string[];
      completedWindowIds: readonly string[];
      requiredFacilitySlots: Array<{ shiftId: string; facilityId: string; slotCount: number }>;
      actualFacilityOperators: Array<{ shiftId: string; facilityId: string; operatorIds: string[] }>;
    };
    simultaneousOperatorConflicts: Array<{ shiftId: string; operatorId: string }>;
    supportResourceScenario?: {
      requested: boolean;
      complete: boolean;
      requestedSourceIds: readonly string[];
      resolvedSourceIds: readonly string[];
      fixedSourceEvidenceSourceIds: readonly string[];
      fixedContextRequested: boolean;
      fixedContextResolved: boolean;
    };
    scheduledSupport: {
      completion: "complete" | "incomplete";
      provenance: "bounded-scheduled-support-materialization-not-certified";
      supportPlacements: readonly Readonly<ScheduledSupportPlacement>[];
      supportCapacityValidated: boolean;
      supportRecoveryValidated: boolean;
      issues: readonly Readonly<ScheduledSupportValidationIssue>[];
    };
    resourceEvaluation: {
      status: "complete" | "incomplete";
      requiredWindowIds: readonly string[];
      evaluatedWindowIds: readonly string[];
      missingCount: number;
    };
  };
}

type ComparableBenchmarkShift = {
  id: string;
  durationHours: number;
  startHour?: number;
  endHour?: number;
  activeGroupIds?: string[];
  recoveryGroupIds?: string[];
  assignments: ResourceOutputBenchmark["rotation"]["shifts"][number]["assignments"];
};

function benchmarkCycleAndShifts(fixture: ResourceOutputBenchmark): {
  cycleHours: number;
  shifts: ComparableBenchmarkShift[];
  scheduleAuthorityComplete: boolean;
  scheduleAuthorityErrors: string[];
} {
  const authority = effectiveBenchmarkScheduleAuthority(fixture);
  const fixtureShifts = fixture.schedule?.shifts ?? fixture.rotation.shifts;
  if (authority.status === "complete") {
    const fixtureShiftById = new Map(fixtureShifts.map((shift) => [shift.id, shift] as const));
    return {
      cycleHours: authority.schedule.cycleHours,
      shifts: authority.schedule.shifts.map((identity) => ({
        ...fixtureShiftById.get(identity.id)!,
        ...identity
      })),
      scheduleAuthorityComplete: true,
      scheduleAuthorityErrors: []
    };
  }
  return {
    cycleHours: fixture.rotation.cycleHours,
    shifts: fixture.rotation.shifts,
    scheduleAuthorityComplete: false,
    scheduleAuthorityErrors: authority.errors
  };
}

export type BenchmarkObservationMap = Readonly<Record<string, BenchmarkObservation | undefined>>;
export type BenchmarkCaseStatus = "passed" | "failed" | "not-run" | "non-gating" | "invalid";

export interface BenchmarkDiagnostic {
  code?: string;
  path: string;
  category: BenchmarkDiagnosticCategory;
  severity: "error" | "warning" | "info";
  certainty?: "suspected" | "proven";
  passed?: boolean;
  message: string;
  expected?: unknown;
  actual?: unknown;
  absoluteError?: number;
  relativeError?: number;
  tolerance?: BenchmarkTolerance;
  appliedTolerance?: { type: "absolute" | "relative" | "absolute-zero-fallback"; value: number };
  evidence?: string;
  operatorId?: string;
  effectId?: string;
  effectIndex?: number;
  effectType?: PlanResourceMissingReason["effectType"];
  effectKind?: PlanResourceMissingReason["effectKind"];
  shiftId?: string;
  groupId?: string;
  sourceOperatorId?: string;
  candidateValue?: number;
  referenceValue?: number;
  absoluteAdvantage?: number;
  relativeAdvantage?: number;
  objectiveProfile?: ResourceObjectiveProfile;
  objectiveWeights?: Readonly<{ gold: number; battleRecord: number; lmd: number }>;
  objectiveProvenance?: "exact-window-facility-normal-mechanics-evaluation";
}

export interface OptimizerBenchmarkCaseResult {
  id: string;
  status: BenchmarkCaseStatus;
  gating: boolean;
  diagnostics: BenchmarkDiagnostic[];
  smallestMismatchPath?: string;
  matchedComposition?: "primary" | `equivalent[${number}]` | "output-equivalent";
  acceptanceMode?: "reference" | "output-equivalent" | "objective-superior";
  searchProofStatus?: "certified" | "not-certified";
  objectiveComparison?: {
    candidateValue: number;
    referenceValue: number;
    absoluteAdvantage: number;
    relativeAdvantage: number;
    tolerance: BenchmarkTolerance;
    objectiveProfile: ResourceObjectiveProfile;
    weights: Readonly<{ gold: number; battleRecord: number; lmd: number }>;
    provenance: "exact-window-facility-normal-mechanics-evaluation";
  };
}

export interface OptimizerBenchmarkBatchResult {
  aggregateStatus: "passed" | "failed";
  counts: Record<BenchmarkCaseStatus, number>;
  cases: OptimizerBenchmarkCaseResult[];
}

function numericError(expected: number, actual: number): number {
  return Number(Math.abs(actual - expected).toPrecision(15));
}

function sameStringSet(expected: readonly string[], actual: readonly string[]): boolean {
  return expected.length === actual.length &&
    new Set(expected).size === expected.length &&
    new Set(actual).size === actual.length &&
    expected.every((value) => actual.includes(value));
}

/**
 * Stable mismatch precedence, independent of fixture and observation declaration order:
 * reference provenance; runtime region, availability commit, roster mode, roster IDs;
 * rotation cycle, then shift state; composition comparisons under search authority; skill interpretation;
 * calculation; and finally every other path. Paths are lexical within each tier.
 */
const compositionComparisonPrefixes = [
  "composition/search/",
  "composition/remote-support/"
] as const;

function isCompositionComparisonPath(path: string): boolean {
  return compositionComparisonPrefixes.some((prefix) => path.startsWith(prefix));
}

function stableMismatchPathRank(path: string): number {
  if (path.startsWith("metadata/reference-provenance/")) return 0;
  if (path === "metadata/runtime-data-provenance/region") return 1;
  if (path === "metadata/runtime-data-provenance/operatorAvailabilitySourceCommit") return 2;
  if (path === "metadata/runtime-data-provenance/roster/mode") return 3;
  if (path === "metadata/runtime-data-provenance/roster/operatorIds") return 4;
  if (path === "rotation/state-model/cycleHours") return 5;
  if (path.startsWith("rotation/state-model/")) return 6;
  if (isCompositionComparisonPath(path)) return 7;
  if (path.startsWith("skill-interpretation/")) return 8;
  if (path.startsWith("calculation/")) return 9;
  return 10;
}

function compareStableMismatchPaths(left: BenchmarkDiagnostic, right: BenchmarkDiagnostic): number {
  const rankDifference = stableMismatchPathRank(left.path) - stableMismatchPathRank(right.path);
  if (rankDifference !== 0) return rankDifference;
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  return 0;
}

function smallestMismatch(diagnostics: readonly BenchmarkDiagnostic[]): BenchmarkDiagnostic | undefined {
  return diagnostics
    .filter((diagnostic) => diagnostic.severity === "error")
    .reduce<BenchmarkDiagnostic | undefined>((smallest, diagnostic) =>
      smallest === undefined || compareStableMismatchPaths(diagnostic, smallest) < 0 ? diagnostic : smallest
    , undefined);
}

function describeValue(value: unknown): string {
  if (value === undefined) return "missing";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function addComparison(
  diagnostics: BenchmarkDiagnostic[],
  path: string,
  category: BenchmarkDiagnosticCategory,
  expected: unknown,
  actual: unknown,
  passed: boolean
): void {
  diagnostics.push({
    path,
    category,
    severity: passed ? "info" : "error",
    certainty: passed ? undefined : "suspected",
    passed,
    expected,
    actual,
    message: passed
      ? `expected ${describeValue(expected)}, actual ${describeValue(actual)}`
      : `expected ${describeValue(expected)}, actual ${describeValue(actual)}`
  });
}

function compareMetadata(
  fixture: OptimizerBenchmark,
  observation: BenchmarkObservation,
  diagnostics: BenchmarkDiagnostic[]
): void {
  const observedReferenceVersion = observation.metadata?.referenceProvenance?.version;
  if (observedReferenceVersion === undefined) {
    diagnostics.push({
      path: "metadata/reference-provenance/version",
      category: "reference",
      severity: "info",
      expected: fixture.referenceProvenance.version,
      actual: undefined,
      message: "reference version was not independently observed and is informational"
    });
  } else {
    addComparison(
      diagnostics,
      "metadata/reference-provenance/version",
      "reference",
      fixture.referenceProvenance.version,
      observedReferenceVersion,
      fixture.referenceProvenance.version === observedReferenceVersion
    );
  }
  addComparison(
    diagnostics,
    "metadata/runtime-data-provenance/region",
    "source-data",
    fixture.region,
    observation.metadata?.region,
    fixture.region === observation.metadata?.region
  );
  if (fixture.runtimeDataProvenance !== undefined) {
    addComparison(
      diagnostics,
      "metadata/runtime-data-provenance/operatorAvailabilitySourceCommit",
      "source-data",
      fixture.runtimeDataProvenance.operatorAvailabilitySourceCommit,
      observation.metadata?.runtimeDataProvenance?.operatorAvailabilitySourceCommit,
      fixture.runtimeDataProvenance.operatorAvailabilitySourceCommit ===
        observation.metadata?.runtimeDataProvenance?.operatorAvailabilitySourceCommit
    );
  }
  if (fixture.kind === "resource-output") {
    const expectedRoster = fixture.roster;
    const actualRoster = observation.metadata?.roster;
    addComparison(
      diagnostics,
      "metadata/runtime-data-provenance/roster/mode",
      "source-data",
      expectedRoster.mode,
      actualRoster?.mode,
      expectedRoster.mode === actualRoster?.mode
    );
    if (expectedRoster.mode === "explicit") {
      const actualIds = actualRoster?.mode === "explicit" ? actualRoster.operatorIds : [];
      addComparison(
        diagnostics,
        "metadata/runtime-data-provenance/roster/operatorIds",
        "source-data",
        expectedRoster.operatorIds,
        actualRoster?.mode === "explicit" ? actualRoster.operatorIds : undefined,
        sameStringSet(expectedRoster.operatorIds, actualIds)
      );
    }
  }
}

function compositionCandidates(fixture: ResourceOutputBenchmark): Array<{
  name: "primary" | `equivalent[${number}]`;
  shifts: BenchmarkEquivalentComposition["shifts"];
}> {
  const primary: BenchmarkEquivalentComposition["shifts"] = benchmarkCycleAndShifts(fixture).shifts.map((shift) => ({
    shiftId: shift.id,
    assignments: Object.fromEntries(Object.entries(shift.assignments).flatMap(([facilityId, assignment]) =>
      assignment.operatorIds ? [[facilityId, assignment.operatorIds]] : []
    ))
  }));
  return [
    { name: "primary", shifts: primary },
    ...(fixture.expected.equivalentCompositions ?? []).map((composition, index) => ({
      name: `equivalent[${index}]` as const,
      shifts: composition.shifts
    }))
  ];
}

function identifiedRemoteSupportByShift(
  fixture: ResourceOutputBenchmark
): Map<string, Record<string, readonly string[]>> {
  return new Map(benchmarkCycleAndShifts(fixture).shifts.map((shift) => [
    shift.id,
    Object.fromEntries(Object.entries(shift.assignments).flatMap(([facilityId, assignment]) =>
      assignment.remoteSupport?.operatorIds?.length
        ? [[facilityId, assignment.remoteSupport.operatorIds]]
        : []
    ))
  ]));
}

function candidateMatches(
  candidate: BenchmarkEquivalentComposition["shifts"],
  actualShifts: NonNullable<BenchmarkObservation["rotation"]>["shifts"] | undefined,
  expectedRemoteSupportByShift: ReadonlyMap<string, Record<string, readonly string[]>>
): boolean {
  if (!actualShifts) return false;
  const candidateShiftCounts = new Map<string, number>();
  const actualShiftCounts = new Map<string, number>();
  for (const shift of candidate) {
    candidateShiftCounts.set(shift.shiftId, (candidateShiftCounts.get(shift.shiftId) ?? 0) + 1);
  }
  for (const shift of actualShifts) {
    actualShiftCounts.set(shift.id, (actualShiftCounts.get(shift.id) ?? 0) + 1);
  }
  if (candidateShiftCounts.size !== candidate.length || actualShiftCounts.size !== actualShifts.length) return false;
  if (!sameStringSet([...candidateShiftCounts.keys()], [...actualShiftCounts.keys()])) return false;

  return candidate.every((expectedShift) => {
    const actualShift = actualShifts.find((shift) => shift.id === expectedShift.shiftId)!;
    const expectedFacilityIds = Object.keys(expectedShift.assignments);
    const actualFacilityIds = Object.keys(actualShift.assignments);
    const expectedRemoteSupport = expectedRemoteSupportByShift.get(expectedShift.shiftId) ?? {};
    const actualRemoteSupport = actualShift.remoteSupportOperatorIds ?? {};
    return sameStringSet(expectedFacilityIds, actualFacilityIds) &&
      Object.entries(expectedShift.assignments).every(([facilityId, expectedIds]) => {
        const actualIds = actualShift.assignments[facilityId];
        return Array.isArray(actualIds) && sameStringSet(expectedIds, actualIds);
      }) &&
      sameStringSet(Object.keys(expectedRemoteSupport), Object.keys(actualRemoteSupport)) &&
      Object.entries(expectedRemoteSupport).every(([facilityId, expectedIds]) => {
        const actualIds = actualRemoteSupport[facilityId];
        return Array.isArray(actualIds) && sameStringSet(expectedIds, actualIds);
      });
  });
}

function compareRotationAndComposition(
  fixture: ResourceOutputBenchmark,
  observation: BenchmarkObservation,
  diagnostics: BenchmarkDiagnostic[],
  allowCompositionMatch: boolean
): "primary" | `equivalent[${number}]` | undefined {
  const actualRotation = observation.rotation;
  const actualShifts = actualRotation?.shifts;
  const expectedRotation = benchmarkCycleAndShifts(fixture);
  const expectedRemoteSupportByShift = identifiedRemoteSupportByShift(fixture);
  const expectedShiftIds = new Set(expectedRotation.shifts.map((shift) => shift.id));
  const actualShiftCounts = new Map<string, number>();
  for (const shift of actualShifts ?? []) {
    actualShiftCounts.set(shift.id, (actualShiftCounts.get(shift.id) ?? 0) + 1);
  }
  const actualShiftById = new Map(
    (actualShifts ?? [])
      .filter((shift) => actualShiftCounts.get(shift.id) === 1)
      .map((shift) => [shift.id, shift] as const)
  );
  const observedShiftIdsValid = actualShifts !== undefined &&
    actualShiftCounts.size === expectedShiftIds.size &&
    [...actualShiftCounts].every(([id, count]) => count === 1 && expectedShiftIds.has(id));

  addComparison(
    diagnostics,
    "rotation/state-model/cycleHours",
    "state-model",
    expectedRotation.cycleHours,
    actualRotation?.cycleHours,
    expectedRotation.cycleHours === actualRotation?.cycleHours
  );
  if (!expectedRotation.scheduleAuthorityComplete && isPassFailEligible(fixture)) {
    addComparison(
      diagnostics,
      "rotation/state-model/schedule-authority",
      "state-model",
      "complete",
      expectedRotation.scheduleAuthorityErrors,
      false
    );
  }
  for (const [shiftId, count] of [...actualShiftCounts].sort(([left], [right]) => left.localeCompare(right))) {
    if (count > 1) {
      addComparison(
        diagnostics,
        `rotation/state-model/shifts/${shiftId}/duplicate-id`,
        "state-model",
        "unique",
        `${count} occurrences`,
        false
      );
    }
  }
  for (const shiftId of [...actualShiftCounts.keys()].sort()) {
    if (!expectedShiftIds.has(shiftId)) {
      addComparison(
        diagnostics,
        `rotation/state-model/shifts/${shiftId}/unexpected`,
        "state-model",
        "absent",
        "present",
        false
      );
    }
  }
  for (const expectedShift of expectedRotation.shifts) {
    const actualShift = actualShiftById.get(expectedShift.id);
    const actualShiftCount = actualShiftCounts.get(expectedShift.id) ?? 0;
    if (actualShiftCount <= 1) {
      addComparison(
        diagnostics,
        `rotation/state-model/shifts/${expectedShift.id}`,
        "state-model",
        "present",
        actualShift ? "present" : "missing",
        actualShiftCount === 1
      );
    }
    if (actualShift) {
      addComparison(
        diagnostics,
        `rotation/state-model/shifts/${expectedShift.id}/durationHours`,
        "state-model",
        expectedShift.durationHours,
        actualShift.durationHours,
        expectedShift.durationHours === actualShift.durationHours
      );
      if (expectedShift.startHour !== undefined) {
        addComparison(
          diagnostics,
          `rotation/state-model/shifts/${expectedShift.id}/startHour`,
          "state-model",
          expectedShift.startHour,
          actualShift.startHour,
          expectedShift.startHour === actualShift.startHour
        );
        addComparison(
          diagnostics,
          `rotation/state-model/shifts/${expectedShift.id}/endHour`,
          "state-model",
          expectedShift.endHour,
          actualShift.endHour,
          expectedShift.endHour === actualShift.endHour
        );
        addComparison(
          diagnostics,
          `rotation/state-model/shifts/${expectedShift.id}/activeGroupIds`,
          "state-model",
          expectedShift.activeGroupIds,
          actualShift.activeGroupIds,
          Array.isArray(actualShift.activeGroupIds) && sameStringSet(expectedShift.activeGroupIds ?? [], actualShift.activeGroupIds)
        );
        addComparison(
          diagnostics,
          `rotation/state-model/shifts/${expectedShift.id}/recoveryGroupIds`,
          "state-model",
          expectedShift.recoveryGroupIds,
          actualShift.recoveryGroupIds,
          Array.isArray(actualShift.recoveryGroupIds) && sameStringSet(expectedShift.recoveryGroupIds ?? [], actualShift.recoveryGroupIds)
        );
      }
    }
    for (const [facilityId, assignment] of Object.entries(expectedShift.assignments)) {
      if (!assignment.operatorIds && !assignment.sourceOnlyOperatorIds) {
        diagnostics.push({
          path: `composition/search/${expectedShift.id}/${facilityId}`,
          category: "search",
          severity: "info",
          message: "reference composition is label-only and is not independently identified"
        });
      }
      if (assignment.remoteSupport?.operatorIds?.length) {
        const actualSupportIds = actualShift?.remoteSupportOperatorIds?.[facilityId];
        addComparison(
          diagnostics,
          `composition/remote-support/${expectedShift.id}/${facilityId}`,
          "search",
          assignment.remoteSupport.operatorIds,
          actualSupportIds,
          Array.isArray(actualSupportIds) && sameStringSet(assignment.remoteSupport.operatorIds, actualSupportIds)
        );
      }
      for (const unresolved of assignment.remoteSupport?.unresolved ?? []) {
        diagnostics.push({
          path: `reference/unresolved-support/${expectedShift.id}/${facilityId}/${unresolved.sourceName}`,
          category: "reference",
          severity: "info",
          message: unresolved.reason
        });
      }
      for (const operatorId of assignment.sourceOnlyOperatorIds ?? []) {
        diagnostics.push({
          path: `reference/source-only/${expectedShift.id}/${facilityId}/${operatorId}`,
          category: "reference",
          severity: "info",
          message: "source-only operator is excluded from runnable composition matching"
        });
      }
    }
    const expectedSupportFacilityIds = new Set(Object.keys(expectedRemoteSupportByShift.get(expectedShift.id) ?? {}));
    for (const facilityId of Object.keys(actualShift?.remoteSupportOperatorIds ?? {}).sort()) {
      if (!expectedSupportFacilityIds.has(facilityId)) {
        addComparison(
          diagnostics,
          `composition/remote-support/${expectedShift.id}/${facilityId}/unexpected`,
          "search",
          "absent",
          "present",
          false
        );
      }
    }
  }

  for (const conflict of fixture.compositionEvidence?.conflicts ?? []) {
    diagnostics.push({
      path: `reference/conflict/${conflict.path}`,
      category: "reference",
      severity: "info",
      expected: conflict.sourceValue,
      actual: conflict.benchmarkValue,
      message: conflict.notes
    });
  }
  for (const disputed of fixture.compositionEvidence?.disputedAssignments ?? []) {
    diagnostics.push({
      path: `reference/disputed-assignment/${disputed.shiftId}/${disputed.facilityIds.join("+")}`,
      category: "reference",
      severity: "info",
      message: disputed.reason
    });
  }

  const candidates = compositionCandidates(fixture);
  const scheduleStateMatches = !diagnostics.some((diagnostic) =>
    diagnostic.category === "state-model" && diagnostic.severity === "error"
  );
  const matched = allowCompositionMatch && observedShiftIdsValid && scheduleStateMatches
    ? candidates.find((candidate) => candidateMatches(
      candidate.shifts,
      actualShifts,
      expectedRemoteSupportByShift
    ))
    : undefined;
  if (matched) return matched.name;

  const primary = candidates[0];
  for (const expectedShift of primary.shifts) {
    const actualShift = actualShiftById.get(expectedShift.shiftId);
    for (const [facilityId, expectedIds] of Object.entries(expectedShift.assignments)) {
      const actualIds = actualShift?.assignments[facilityId];
      addComparison(
        diagnostics,
        `composition/search/${expectedShift.shiftId}/${facilityId}`,
        "search",
        expectedIds,
        actualIds,
        Array.isArray(actualIds) && sameStringSet(expectedIds, actualIds)
      );
    }
  }
  const primaryShiftById = new Map(primary.shifts.map((shift) => [shift.shiftId, shift] as const));
  for (const [shiftId, actualShift] of actualShiftById) {
    const expectedFacilityIds = new Set(Object.keys(primaryShiftById.get(shiftId)?.assignments ?? {}));
    for (const facilityId of Object.keys(actualShift.assignments)) {
      if (!expectedFacilityIds.has(facilityId)) {
        addComparison(
          diagnostics,
          `composition/search/${shiftId}/${facilityId}/unexpected`,
          "search",
          "absent",
          "present",
          false
        );
      }
    }
  }
  return undefined;
}

function compareNumber(
  diagnostics: BenchmarkDiagnostic[],
  path: string,
  expected: number,
  actual: number | undefined,
  tolerance?: BenchmarkTolerance
): void {
  if (typeof actual !== "number" || !Number.isFinite(actual)) {
    addComparison(diagnostics, path, "calculation", expected, actual, false);
    return;
  }
  const absoluteError = numericError(expected, actual);
  let relativeError: number | undefined;
  let appliedTolerance: BenchmarkDiagnostic["appliedTolerance"];
  let passed: boolean;
  if (!tolerance) {
    appliedTolerance = { type: "absolute", value: 0 };
    passed = absoluteError === 0;
  } else if (tolerance.type === "absolute") {
    appliedTolerance = tolerance;
    passed = absoluteError <= tolerance.value;
  } else if (expected === 0) {
    appliedTolerance = { type: "absolute-zero-fallback", value: tolerance.zeroExpectedAbsolute! };
    passed = absoluteError <= tolerance.zeroExpectedAbsolute!;
  } else {
    relativeError = numericError(expected, actual) / Math.abs(expected);
    appliedTolerance = { type: "relative", value: tolerance.value };
    passed = relativeError <= tolerance.value;
  }
  const toleranceDescription = appliedTolerance.type === "absolute-zero-fallback"
    ? `absolute zero fallback ${appliedTolerance.value}`
    : `${appliedTolerance.type} tolerance ${appliedTolerance.value}`;
  diagnostics.push({
    path,
    category: "calculation",
    severity: passed ? "info" : "error",
    certainty: passed ? undefined : "suspected",
    passed,
    expected,
    actual,
    absoluteError,
    relativeError,
    ...(tolerance ? { tolerance } : {}),
    appliedTolerance,
    message: passed
      ? `expected ${expected}, actual ${actual}, within ${toleranceDescription}`
      : `expected ${expected}, actual ${actual}, absolute error ${absoluteError} exceeds ${toleranceDescription}`
  });
}

function compareCalculations(
  fixture: OptimizerBenchmark,
  observation: BenchmarkObservation,
  diagnostics: BenchmarkDiagnostic[]
): void {
  if (fixture.kind === "formula") {
    for (const formula of fixture.formulas) {
      compareNumber(
        diagnostics,
        `calculation/formula-values/${formula.id}`,
        formula.expectedValue,
        observation.formulaValues?.[formula.id]
      );
    }
    return;
  }

  for (const reason of observation.planResourceMissingReasons ?? []) {
    diagnostics.push({
      code: reason.code,
      path: `calculation/plan-resources/${reason.path}`,
      category: "calculation",
      severity: "info",
      message: reason.message,
      ...(reason.operatorId ? { operatorId: reason.operatorId } : {}),
      ...(reason.effectId ? { effectId: reason.effectId } : {}),
      ...(reason.effectIndex !== undefined ? { effectIndex: reason.effectIndex } : {}),
      ...(reason.effectType ? { effectType: reason.effectType } : {}),
      ...(reason.effectKind ? { effectKind: reason.effectKind } : {})
    });
  }

  if (fixture.kind === "resource-output" && observation.objectiveEvidence && !observation.planSustainability) {
    diagnostics.push({
      code: "plan-sustainability-evidence-absent",
      path: "sustainable-cycle/evidence",
      category: "state-model",
      severity: "error",
      certainty: "proven",
      message: "Objective-superior acceptance requires plan sustainability evidence"
    });
  } else if (observation.planSustainability?.status === "incomplete") {
    diagnostics.push({
      code: "plan-sustainability-incomplete",
      path: "sustainable-cycle/status",
      category: "state-model",
      severity: "error",
      certainty: "proven",
      message: "Objective-superior acceptance requires evaluated plan sustainability"
    });
    for (const reason of observation.planSustainability.missing) {
      diagnostics.push({
        code: reason.code,
        path: `sustainable-cycle/incomplete/${reason.path}`,
        category: "state-model",
        severity: "error",
        certainty: "proven",
        message: reason.message,
        ...(reason.operatorId ? { operatorId: reason.operatorId } : {}),
        ...(reason.sourceOperatorId ? { sourceOperatorId: reason.sourceOperatorId } : {}),
        ...(reason.facilityId ? { facilityId: reason.facilityId } : {}),
        ...(reason.shiftId ? { shiftId: reason.shiftId } : {}),
        ...(reason.groupId ? { groupId: reason.groupId } : {})
      });
    }
  } else if (observation.planSustainability?.status === "evaluated") {
    if (!observation.planSustainability.sustainable) {
      diagnostics.push({
        code: "plan-sustainability-unsustainable",
        path: "sustainable-cycle/status",
        category: "state-model",
        severity: "error",
        certainty: "proven",
        message: "Objective-superior acceptance requires a sustainable plan"
      });
    }
    for (const failure of observation.planSustainability.failures) {
      const hour = failure.hour === undefined ? "none" : String(failure.hour);
      diagnostics.push({
        code: failure.code,
        path: `sustainable-cycle/failures/${failure.category}/${failure.code}/shift/${failure.shiftId ?? "none"}/operator/${failure.operatorId ?? "none"}/hour/${hour}`,
        category: failure.category === "overlap" || failure.category === "dormitory" ? "state-model" : "calculation",
        severity: "error",
        certainty: "proven",
        message: failure.message,
        ...(failure.operatorId ? { operatorId: failure.operatorId } : {}),
        ...(failure.facilityId ? { facilityId: failure.facilityId } : {}),
        ...(failure.shiftId ? { shiftId: failure.shiftId } : {})
      });
    }
  }

  for (const [resource, expected] of Object.entries(fixture.expected.output) as Array<[BenchmarkResourceName, number]>) {
    compareNumber(
      diagnostics,
      `calculation/resource-values/${resource}`,
      expected,
      observation.resources?.[resource],
      fixture.expected.tolerance
    );
  }
  for (const resource of Object.keys(observation.resources ?? {}) as BenchmarkResourceName[]) {
    if (fixture.expected.output[resource] === undefined) {
      diagnostics.push({
        path: `calculation/resource-values/${resource}`,
        category: "calculation",
        severity: "info",
        message: "extra actual resource is informational and was not compared",
        actual: observation.resources?.[resource]
      });
    }
  }
}

function compareInterpretations(observation: BenchmarkObservation, diagnostics: BenchmarkDiagnostic[]): void {
  for (const effect of observation.interpretedEffects ?? []) {
    compareNumber(diagnostics, `skill-interpretation/${effect.id}`, effect.expected, effect.actual);
    const diagnostic = diagnostics[diagnostics.length - 1];
    diagnostic.category = "interpretation";
  }
}

function applyProvenCauses(observation: BenchmarkObservation, diagnostics: BenchmarkDiagnostic[]): void {
  for (const cause of observation.provenCauses ?? []) {
    const diagnostic = diagnostics.find((item) =>
      item.severity === "error" && item.path === cause.path && item.category === cause.category
    );
    if (diagnostic && cause.evidence.trim()) {
      diagnostic.certainty = "proven";
      diagnostic.evidence = cause.evidence;
    }
  }
}

function comparePlanEvidence(
  fixture: ResourceOutputBenchmark,
  observation: BenchmarkObservation,
  diagnostics: BenchmarkDiagnostic[]
): boolean {
  const evidence = observation.planEvidence;
  if (!evidence) return false;
  const before = diagnostics.length;
  const expectedRotation = benchmarkCycleAndShifts(fixture);
  if (!expectedRotation.scheduleAuthorityComplete) return false;
  addComparison(
    diagnostics,
    "composition/search/completion",
    "search",
    "complete",
    evidence.search.completion,
    evidence.search.completion === "complete"
  );
  diagnostics.push({
    path: "composition/search/proof-status",
    category: "search",
    severity: "info",
    actual: evidence.search.proofStatus,
    message: evidence.search.proofStatus === "certified"
      ? "search proof is certified"
      : "search produced a complete plan but global optimality is not certified"
  });

  const expectedWindowIds = expectedRotation.shifts.map((shift) => shift.id);
  addComparison(
    diagnostics,
    "plan-evidence/production/required-windows",
    "state-model",
    expectedWindowIds,
    evidence.production.requiredWindowIds,
    sameStringSet(expectedWindowIds, evidence.production.requiredWindowIds)
  );
  addComparison(
    diagnostics,
    "plan-evidence/production/windows",
    "state-model",
    evidence.production.requiredWindowIds,
    evidence.production.completedWindowIds,
    sameStringSet(evidence.production.requiredWindowIds, evidence.production.completedWindowIds)
  );
  for (const shift of expectedRotation.shifts) {
    for (const [facilityId, assignment] of Object.entries(shift.assignments)) {
      if (!assignment.operatorIds) continue;
      const declared = evidence.production.requiredFacilitySlots.filter((item) =>
        item.shiftId === shift.id && item.facilityId === facilityId
      );
      addComparison(
        diagnostics,
        `plan-evidence/production/${shift.id}/${facilityId}/required-slots`,
        "state-model",
        assignment.operatorIds.length,
        declared.length === 1 ? declared[0].slotCount : undefined,
        declared.length === 1 && declared[0].slotCount === assignment.operatorIds.length
      );
    }
  }
  for (const required of evidence.production.requiredFacilitySlots) {
    const actual = evidence.production.actualFacilityOperators.filter((item) =>
      item.shiftId === required.shiftId && item.facilityId === required.facilityId
    );
    const operatorIds = actual.length === 1 ? actual[0].operatorIds : undefined;
    addComparison(
      diagnostics,
      `plan-evidence/production/${required.shiftId}/${required.facilityId}/slots`,
      "state-model",
      required.slotCount,
      operatorIds?.length,
      actual.length === 1 && operatorIds?.length === required.slotCount
    );
  }
  addComparison(
    diagnostics,
    "plan-evidence/operator-conflicts",
    "state-model",
    [],
    evidence.simultaneousOperatorConflicts,
    evidence.simultaneousOperatorConflicts.length === 0
  );

  const expectedScenario = fixture.supportResourceScenario;
  if (expectedScenario || evidence.supportResourceScenario?.requested) {
    const actual = evidence.supportResourceScenario;
    const expectedSourceIds = expectedScenario?.sources.map((source) => source.id) ?? actual?.requestedSourceIds ?? [];
    addComparison(diagnostics, "plan-evidence/support/requested", "state-model", true, actual?.requested, actual?.requested === true);
    addComparison(diagnostics, "plan-evidence/support/complete", "state-model", true, actual?.complete, actual?.complete === true);
    addComparison(
      diagnostics,
      "plan-evidence/support/resolved-sources",
      "state-model",
      expectedSourceIds,
      actual?.resolvedSourceIds,
      Array.isArray(actual?.resolvedSourceIds) && sameStringSet(expectedSourceIds, actual.resolvedSourceIds)
    );
    addComparison(
      diagnostics,
      "plan-evidence/support/fixed-source-evidence",
      "calculation",
      expectedSourceIds,
      actual?.fixedSourceEvidenceSourceIds,
      Array.isArray(actual?.fixedSourceEvidenceSourceIds) &&
        sameStringSet(expectedSourceIds, actual.fixedSourceEvidenceSourceIds)
    );
    const expectsFixedContext = expectedScenario?.fixedContext !== undefined || actual?.fixedContextRequested === true;
    addComparison(
      diagnostics,
      "plan-evidence/support/fixed-context",
      "state-model",
      expectsFixedContext,
      actual?.fixedContextResolved,
      !expectsFixedContext || actual?.fixedContextResolved === true
    );
  }

  addComparison(
    diagnostics,
    "plan-evidence/support/scheduled-materialization",
    "state-model",
    "complete",
    evidence.scheduledSupport?.completion,
    evidence.scheduledSupport?.completion === "complete" &&
      evidence.scheduledSupport.provenance === "bounded-scheduled-support-materialization-not-certified"
  );
  addComparison(
    diagnostics,
    "plan-evidence/support/physical-capacity",
    "state-model",
    true,
    evidence.scheduledSupport?.supportCapacityValidated,
    evidence.scheduledSupport?.supportCapacityValidated === true
  );
  addComparison(
    diagnostics,
    "plan-evidence/support/work-recovery",
    "state-model",
    true,
    evidence.scheduledSupport?.supportRecoveryValidated,
    evidence.scheduledSupport?.supportRecoveryValidated === true
  );
  addComparison(
    diagnostics,
    "plan-evidence/support/issues",
    "state-model",
    0,
    evidence.scheduledSupport?.issues.length,
    evidence.scheduledSupport?.issues.length === 0
  );

  addComparison(
    diagnostics,
    "plan-evidence/resources/status",
    "calculation",
    "complete",
    evidence.resourceEvaluation.status,
    evidence.resourceEvaluation.status === "complete"
  );
  addComparison(
    diagnostics,
    "plan-evidence/resources/windows",
    "calculation",
    expectedWindowIds,
    evidence.resourceEvaluation.evaluatedWindowIds,
    sameStringSet(expectedWindowIds, evidence.resourceEvaluation.evaluatedWindowIds) &&
      sameStringSet(expectedWindowIds, evidence.resourceEvaluation.requiredWindowIds)
  );
  addComparison(
    diagnostics,
    "plan-evidence/resources/missing-count",
    "calculation",
    0,
    evidence.resourceEvaluation.missingCount,
    evidence.resourceEvaluation.missingCount === 0
  );
  return diagnostics.slice(before).every((diagnostic) => diagnostic.severity !== "error");
}

function sameObjectiveWeights(
  left: Readonly<{ gold: number; battleRecord: number; lmd: number }>,
  right: Readonly<{ gold: number; battleRecord: number; lmd: number }>
): boolean {
  return left.gold === right.gold && left.battleRecord === right.battleRecord && left.lmd === right.lmd;
}

function exactObjectiveComplete(evidence: BenchmarkObjectiveEvidence): evidence is Extract<BenchmarkObjectiveEvidence, {
  status: "complete";
}> {
  if (evidence.status !== "complete" || evidence.authority !== "authoritative" || !Number.isFinite(evidence.value)) {
    return false;
  }
  const completeness = evidence.completeness;
  const sustainability = evidence.sustainability;
  return completeness.supportResourceScenario === "complete" &&
    completeness.resourceEvaluation === "complete" &&
    sameStringSet(completeness.requiredWindowIds, completeness.evaluatedWindowIds) &&
    completeness.requiredFacilityEvaluationCount > 0 &&
    completeness.requiredFacilityEvaluationCount === completeness.evaluatedFacilityEvaluationCount &&
    isAuthoritativeObjectiveSustainability(sustainability);
}

function compareObjectiveSuperiority(
  fixture: ResourceOutputBenchmark,
  observation: BenchmarkObservation,
  diagnostics: BenchmarkDiagnostic[]
): OptimizerBenchmarkCaseResult["objectiveComparison"] | undefined {
  const candidate = observation.objectiveEvidence?.candidate;
  const reference = observation.objectiveEvidence?.reference;
  const expectedProfile = fixture.assumptions.objectiveProfile;
  const tolerance = fixture.expected.tolerance;
  const expectedRotation = benchmarkCycleAndShifts(fixture);
  const expectedWindowIds = expectedRotation.shifts.map((shift) => shift.id);
  const candidateRequiredFacilityCount = observation.planEvidence?.production.requiredFacilitySlots.length;
  const referenceRequiredFacilityCount = expectedRotation.shifts.reduce((count, shift) =>
    count + Object.values(shift.assignments).filter((assignment) => assignment.operatorIds !== undefined).length,
  0);
  const comparable = expectedRotation.scheduleAuthorityComplete &&
    candidate !== undefined && reference !== undefined &&
    exactObjectiveComplete(candidate) && exactObjectiveComplete(reference) &&
    expectedProfile !== "formula-only" && candidate.objectiveProfile === expectedProfile &&
    reference.objectiveProfile === expectedProfile &&
    candidate.objectiveProfile === reference.objectiveProfile &&
    sameObjectiveWeights(candidate.weights, reference.weights) &&
    sameObjectiveWeights(candidate.weights, resourceObjectiveWeights[expectedProfile]) &&
    candidate.provenance === reference.provenance && reference.value !== 0 &&
    sameStringSet(candidate.completeness.requiredWindowIds, expectedWindowIds) &&
    sameStringSet(reference.completeness.requiredWindowIds, expectedWindowIds) &&
    candidate.completeness.requiredFacilityEvaluationCount === candidateRequiredFacilityCount &&
    reference.completeness.requiredFacilityEvaluationCount === referenceRequiredFacilityCount &&
    tolerance.type === "relative";
  const absoluteAdvantage = comparable ? candidate.value - reference.value : undefined;
  const relativeAdvantage = comparable ? absoluteAdvantage! / Math.abs(reference.value) : undefined;
  const passed = comparable && Number.isFinite(absoluteAdvantage) && Number.isFinite(relativeAdvantage) &&
    relativeAdvantage! > tolerance.value;
  diagnostics.push({
    path: "objective-comparison",
    category: "calculation",
    severity: passed ? "info" : "error",
    certainty: passed ? undefined : "suspected",
    passed,
    expected: reference?.status === "complete" ? reference.value : undefined,
    actual: candidate?.status === "complete" ? candidate.value : undefined,
    tolerance,
    ...(candidate?.status === "complete" ? {
      candidateValue: candidate.value,
      objectiveProfile: candidate.objectiveProfile,
      objectiveWeights: candidate.weights,
      objectiveProvenance: candidate.provenance
    } : {}),
    ...(reference?.status === "complete" ? { referenceValue: reference.value } : {}),
    ...(absoluteAdvantage === undefined ? {} : { absoluteAdvantage }),
    ...(relativeAdvantage === undefined ? {} : { relativeAdvantage }),
    message: passed
      ? "candidate authoritative objective exceeds the mechanically evaluated reference beyond relative tolerance"
      : "objective superiority requires comparable complete authoritative evidence and a strict advantage beyond relative tolerance"
  });
  if (!passed || !comparable) return undefined;
  return {
    candidateValue: candidate.value,
    referenceValue: reference.value,
    absoluteAdvantage: absoluteAdvantage!,
    relativeAdvantage: relativeAdvantage!,
    tolerance,
    objectiveProfile: candidate.objectiveProfile,
    weights: candidate.weights,
    provenance: candidate.provenance
  };
}

function invalidCase(input: unknown, errors: string[]): OptimizerBenchmarkCaseResult {
  const id = typeof input === "object" && input !== null && "id" in input && typeof input.id === "string"
    ? input.id
    : "unknown";
  return {
    id,
    status: "invalid",
    gating: true,
    smallestMismatchPath: "fixture",
    diagnostics: errors.map((message) => ({
      path: "fixture",
      category: "reference",
      severity: "error",
      certainty: "suspected",
      message
    }))
  };
}

export function runOptimizerBenchmarkBatch(
  fixtures: readonly unknown[],
  observations: BenchmarkObservationMap
): OptimizerBenchmarkBatchResult {
  const cases = fixtures.map((input): OptimizerBenchmarkCaseResult => {
    const validation = validateOptimizerBenchmark(input);
    if (!validation.ok) return invalidCase(input, validation.errors);

    const fixture = validation.value;
    const gating = isPassFailEligible(fixture);
    const observation = observations[fixture.id];
    if (!observation) {
      if (!gating) {
        return {
          id: fixture.id,
          status: "non-gating",
          gating: false,
          diagnostics: [{
            path: "reference/disputed",
            category: "reference",
            severity: "info",
            message: "disputed benchmark has no observation and is excluded from gating"
          }]
        };
      }
      return {
        id: fixture.id,
        status: "not-run",
        gating: true,
        smallestMismatchPath: "observation",
        diagnostics: [{
          path: "observation",
          category: "state-model",
          severity: "error",
          certainty: "suspected",
          message: "benchmark observation is missing"
        }]
      };
    }

    const diagnostics: BenchmarkDiagnostic[] = [];
    if (!gating) {
      diagnostics.push({
        path: "reference/disputed",
        category: "reference",
        severity: "info",
        message: "disputed benchmark is diagnostic-only and excluded from gating"
      });
    }
    compareMetadata(fixture, observation, diagnostics);
    const matchedComposition = fixture.kind === "resource-output"
      ? compareRotationAndComposition(
        fixture,
        observation,
        diagnostics,
        hasResolvedExecutableCompositionAuthority(fixture)
      )
      : undefined;
    compareInterpretations(observation, diagnostics);
    compareCalculations(fixture, observation, diagnostics);
    applyProvenCauses(observation, diagnostics);
    const planEvidenceComplete = fixture.kind === "resource-output"
      ? comparePlanEvidence(fixture, observation, diagnostics)
      : false;
    const failures = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    const pureCompositionFailures = failures.filter((diagnostic) =>
      diagnostic.category === "search" && diagnostic.path.startsWith("composition/")
    );
    const outputEquivalent = fixture.kind === "resource-output" && matchedComposition === undefined &&
      planEvidenceComplete && pureCompositionFailures.length > 0 &&
      failures.length === pureCompositionFailures.length;
    if (outputEquivalent) {
      for (const diagnostic of pureCompositionFailures) {
        diagnostic.severity = "info";
        diagnostic.message += "; accepted by strict complete output-equivalent evidence";
      }
    }

    const remainingFailures = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    const comparisonOnlyFailures = remainingFailures.filter((diagnostic) =>
      (diagnostic.category === "search" && diagnostic.path.startsWith("composition/")) ||
      (diagnostic.category === "calculation" && diagnostic.path.startsWith("calculation/resource-values/"))
    );
    const objectiveComparison = fixture.kind === "resource-output" && !outputEquivalent &&
      planEvidenceComplete && comparisonOnlyFailures.length > 0 &&
      comparisonOnlyFailures.length === remainingFailures.length
      ? compareObjectiveSuperiority(fixture, observation, diagnostics)
      : undefined;
    if (objectiveComparison) {
      for (const diagnostic of comparisonOnlyFailures) {
        diagnostic.severity = "warning";
        diagnostic.message += "; retained as a non-gating mismatch after objective-superior acceptance";
      }
    }

    diagnostics.sort(compareStableMismatchPaths);
    const firstFailure = diagnostics.find((diagnostic) => diagnostic.severity === "error");
    const acceptanceMode = !firstFailure && fixture.kind === "resource-output"
      ? objectiveComparison
        ? "objective-superior" as const
        : outputEquivalent
          ? "output-equivalent" as const
          : matchedComposition
            ? "reference" as const
            : undefined
      : undefined;
    return {
      id: fixture.id,
      status: gating ? (firstFailure ? "failed" : "passed") : "non-gating",
      gating,
      diagnostics,
      ...(firstFailure ? { smallestMismatchPath: firstFailure.path } : {}),
      ...(matchedComposition ? { matchedComposition } : outputEquivalent ? { matchedComposition: "output-equivalent" as const } : {}),
      ...(acceptanceMode ? { acceptanceMode } : {}),
      ...(objectiveComparison ? { objectiveComparison } : {}),
      ...(observation.planEvidence ? { searchProofStatus: observation.planEvidence.search.proofStatus } : {})
    };
  });

  const counts: OptimizerBenchmarkBatchResult["counts"] = {
    passed: 0,
    failed: 0,
    "not-run": 0,
    "non-gating": 0,
    invalid: 0
  };
  for (const result of cases) counts[result.status] += 1;
  return {
    aggregateStatus: counts.failed || counts["not-run"] || counts.invalid ? "failed" : "passed",
    counts,
    cases
  };
}

export function formatOptimizerBenchmarkBatchResult(result: OptimizerBenchmarkBatchResult): string {
  const summary = `optimizer benchmarks: ${result.aggregateStatus.toUpperCase()} ` +
    `(passed=${result.counts.passed} failed=${result.counts.failed} not-run=${result.counts["not-run"]} ` +
    `non-gating=${result.counts["non-gating"]} invalid=${result.counts.invalid})`;
  const lines = result.cases.map((item) => {
    if (item.status === "passed") return `PASS ${item.id}`;
    if (item.status === "non-gating") return `NON-GATING ${item.id}`;
    if (item.status === "not-run") return `NOT-RUN ${item.id} observation: benchmark observation is missing`;
    const diagnostic = smallestMismatch(item.diagnostics);
    return `${item.status === "invalid" ? "INVALID" : "FAIL"} ${item.id} ${diagnostic?.path ?? "unknown"}: ${diagnostic?.message ?? "unknown failure"}`;
  });
  return [summary, ...lines].join("\n");
}
