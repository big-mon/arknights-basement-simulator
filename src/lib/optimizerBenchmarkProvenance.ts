import type { BenchmarkRegion, OptimizerBenchmark } from "./optimizerBenchmark";

export type OptimizerBenchmarkProvenanceCategory = "source-data" | "reference";
export type OptimizerBenchmarkProvenanceSeverity = "error" | "info";

export interface OptimizerBenchmarkMetadataObservation {
  region: BenchmarkRegion;
  referenceProvenance?: {
    version: string;
  };
  runtimeDataProvenance?: {
    operatorAvailabilitySourceCommit: string;
  };
  roster?:
    | { mode: "all-unlocked" }
    | { mode: "explicit"; operatorIds: readonly string[] };
}

export interface OptimizerBenchmarkProvenanceDiagnostic {
  category: OptimizerBenchmarkProvenanceCategory;
  path: string;
  severity: OptimizerBenchmarkProvenanceSeverity;
  passed: boolean;
  expected: string | string[];
  actual: string | string[] | undefined;
  smallestMismatchPath?: string;
}

const REFERENCE_VERSION_PATH = "metadata/reference-provenance/version";
const REGION_PATH = "metadata/runtime-data-provenance/region";
const RUNTIME_COMMIT_PATH =
  "metadata/runtime-data-provenance/operatorAvailabilitySourceCommit";
const ROSTER_MODE_PATH = "metadata/runtime-data-provenance/roster/mode";
const ROSTER_IDS_PATH = "metadata/runtime-data-provenance/roster/operatorIds";

function valuesMatch(expected: string | string[], actual: string | string[] | undefined): boolean {
  if (typeof expected === "string") return expected === actual;
  if (!Array.isArray(actual) || expected.length !== actual.length) return false;
  return expected.every((value, index) => value === actual[index]);
}

function sourceDiagnostic(
  path: string,
  expected: string | string[],
  actual: string | string[] | undefined,
  isSmallestMismatch: boolean
): OptimizerBenchmarkProvenanceDiagnostic {
  const passed = valuesMatch(expected, actual);
  return {
    category: "source-data",
    path,
    severity: passed ? "info" : "error",
    passed,
    expected,
    actual,
    ...(!passed && isSmallestMismatch ? { smallestMismatchPath: path } : {})
  };
}

/**
 * Compares independently observed metadata with a validated benchmark fixture.
 * Diagnostics are ordered from the shallowest metadata boundary to the deepest.
 */
export function compareOptimizerBenchmarkProvenance(
  benchmark: OptimizerBenchmark,
  observation: Readonly<OptimizerBenchmarkMetadataObservation>
): OptimizerBenchmarkProvenanceDiagnostic[] {
  const observedReferenceVersion = observation.referenceProvenance?.version;
  const referencePassed = observedReferenceVersion === undefined
    || observedReferenceVersion === benchmark.referenceProvenance.version;
  const diagnostics: OptimizerBenchmarkProvenanceDiagnostic[] = [{
    category: "reference",
    path: REFERENCE_VERSION_PATH,
    severity: referencePassed ? "info" : "error",
    passed: referencePassed,
    expected: benchmark.referenceProvenance.version,
    actual: observedReferenceVersion
  }];

  if (benchmark.kind !== "resource-output") return diagnostics;

  let hasSourceMismatch = false;
  const addSourceDiagnostic = (
    path: string,
    expected: string | string[],
    actual: string | string[] | undefined
  ) => {
    const diagnostic = sourceDiagnostic(path, expected, actual, !hasSourceMismatch);
    diagnostics.push(diagnostic);
    if (!diagnostic.passed) hasSourceMismatch = true;
  };

  addSourceDiagnostic(REGION_PATH, benchmark.region, observation.region);
  addSourceDiagnostic(
    RUNTIME_COMMIT_PATH,
    benchmark.runtimeDataProvenance.operatorAvailabilitySourceCommit,
    observation.runtimeDataProvenance?.operatorAvailabilitySourceCommit
  );
  addSourceDiagnostic(ROSTER_MODE_PATH, benchmark.roster.mode, observation.roster?.mode);

  if (benchmark.roster.mode === "explicit") {
    const expectedOperatorIds = [...benchmark.roster.operatorIds].sort();
    const actualOperatorIds = observation.roster?.mode === "explicit"
      ? [...observation.roster.operatorIds].sort()
      : undefined;
    addSourceDiagnostic(ROSTER_IDS_PATH, expectedOperatorIds, actualOperatorIds);
  }

  return diagnostics;
}
