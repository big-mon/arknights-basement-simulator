import {
  isPassFailEligible,
  validateOptimizerBenchmark,
  type BenchmarkEquivalentComposition,
  type BenchmarkRegion,
  type BenchmarkResourceName,
  type BenchmarkResourceOutput,
  type BenchmarkTolerance,
  type OptimizerBenchmark,
  type ResourceOutputBenchmark
} from "./optimizerBenchmark";

export type BenchmarkDiagnosticCategory =
  | "source-data"
  | "state-model"
  | "search"
  | "interpretation"
  | "calculation"
  | "reference";

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
      assignments: Record<string, string[]>;
      remoteSupportOperatorIds?: Record<string, string[]>;
    }>;
  };
  resources?: BenchmarkResourceOutput;
  formulaValues?: Record<string, number>;
  interpretedEffects?: Array<{ id: string; expected: number; actual: number }>;
  provenCauses?: Array<{
    category: BenchmarkDiagnosticCategory;
    path: string;
    evidence: string;
  }>;
}

export type BenchmarkObservationMap = Readonly<Record<string, BenchmarkObservation | undefined>>;
export type BenchmarkCaseStatus = "passed" | "failed" | "not-run" | "non-gating" | "invalid";

export interface BenchmarkDiagnostic {
  path: string;
  category: BenchmarkDiagnosticCategory;
  severity: "error" | "info";
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
}

export interface OptimizerBenchmarkCaseResult {
  id: string;
  status: BenchmarkCaseStatus;
  gating: boolean;
  diagnostics: BenchmarkDiagnostic[];
  smallestMismatchPath?: string;
  matchedComposition?: "primary" | `equivalent[${number}]`;
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
 * rotation cycle, then shift state; composition search; skill interpretation;
 * calculation; and finally every other path. Paths are lexical within each tier.
 */
function stableMismatchPathRank(path: string): number {
  if (path.startsWith("metadata/reference-provenance/")) return 0;
  if (path === "metadata/runtime-data-provenance/region") return 1;
  if (path === "metadata/runtime-data-provenance/operatorAvailabilitySourceCommit") return 2;
  if (path === "metadata/runtime-data-provenance/roster/mode") return 3;
  if (path === "metadata/runtime-data-provenance/roster/operatorIds") return 4;
  if (path === "rotation/state-model/cycleHours") return 5;
  if (path.startsWith("rotation/state-model/shifts/")) return 6;
  if (path.startsWith("composition/search/")) return 7;
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
  const primary: BenchmarkEquivalentComposition["shifts"] = fixture.rotation.shifts.map((shift) => ({
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

function candidateMatches(
  candidate: BenchmarkEquivalentComposition["shifts"],
  actualShifts: NonNullable<BenchmarkObservation["rotation"]>["shifts"] | undefined
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
    return sameStringSet(expectedFacilityIds, actualFacilityIds) &&
      Object.entries(expectedShift.assignments).every(([facilityId, expectedIds]) => {
        const actualIds = actualShift.assignments[facilityId];
        return Array.isArray(actualIds) && sameStringSet(expectedIds, actualIds);
      });
  });
}

function compareRotationAndComposition(
  fixture: ResourceOutputBenchmark,
  observation: BenchmarkObservation,
  diagnostics: BenchmarkDiagnostic[]
): "primary" | `equivalent[${number}]` | undefined {
  const actualRotation = observation.rotation;
  const actualShifts = actualRotation?.shifts;
  const expectedShiftIds = new Set(fixture.rotation.shifts.map((shift) => shift.id));
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
    fixture.rotation.cycleHours,
    actualRotation?.cycleHours,
    fixture.rotation.cycleHours === actualRotation?.cycleHours
  );
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
  for (const expectedShift of fixture.rotation.shifts) {
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
      if (assignment.remoteSupport?.operatorIds) {
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
  const matched = observedShiftIdsValid
    ? candidates.find((candidate) => candidateMatches(candidate.shifts, actualShifts))
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
      ? compareRotationAndComposition(fixture, observation, diagnostics)
      : undefined;
    compareInterpretations(observation, diagnostics);
    compareCalculations(fixture, observation, diagnostics);
    applyProvenCauses(observation, diagnostics);
    diagnostics.sort(compareStableMismatchPaths);

    const firstFailure = smallestMismatch(diagnostics);
    return {
      id: fixture.id,
      status: gating ? (firstFailure ? "failed" : "passed") : "non-gating",
      gating,
      diagnostics,
      ...(firstFailure ? { smallestMismatchPath: firstFailure.path } : {}),
      ...(matchedComposition ? { matchedComposition } : {})
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
