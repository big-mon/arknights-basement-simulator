export type BenchmarkRegion = "JP" | "CN" | "GLOBAL";
export type BenchmarkConfidence = "confirmed" | "corroborated" | "disputed";

export interface BenchmarkSource {
  url: string;
  title: string;
  accessedAt: string;
  language: "ja" | "en" | "zh";
  role: "primary-text" | "formula" | "composition" | "throughput";
  notes?: string;
}

interface BenchmarkBase {
  id: string;
  region: BenchmarkRegion;
  referenceProvenance: {
    version: string;
    observedAt: string;
  };
  runtimeDataProvenance?: {
    operatorAvailabilitySourceCommit: string;
  };
  confidence: BenchmarkConfidence;
  sources: BenchmarkSource[];
  assumptions: BenchmarkAssumptions;
}

export interface BenchmarkAssumptions {
  layout: "243";
  drones: "trading" | "factory" | "excluded" | "not-applicable";
  facilityProducts: Array<"gold" | "battleRecord" | "lmd">;
  objectiveProfile: "lmd" | "battleRecord" | "balanced" | "formula-only";
  initialMorale?: number;
  initialDrones?: number;
  initialGold?: number;
  notes: string[];
}

export interface FormulaBenchmark extends BenchmarkBase {
  kind: "formula";
  formulas: Array<{
    id: string;
    expression: string;
    expectedValue: number;
    unit: string;
  }>;
}

export type BenchmarkResourceName =
  | "goldProduced"
  | "goldConsumed"
  | "goldNetChange"
  | "battleRecordExp"
  | "lmd"
  | "dronesUsed"
  | "droneLmd"
  | "droneGoldConsumed";

export type BenchmarkResourceOutput = Partial<Record<BenchmarkResourceName, number>>;

export interface BenchmarkEquivalentComposition {
  shifts: Array<{
    shiftId: string;
    assignments: Record<string, string[]>;
  }>;
}

export type BenchmarkTolerance =
  | { type: "absolute"; value: number }
  | { type: "relative"; value: number; zeroExpectedAbsolute?: number };

export interface ResourceOutputBenchmark extends BenchmarkBase {
  kind: "resource-output";
  scope: "full-base" | "facility-group" | "facility-team";
  region: "JP" | "CN";
  roster:
    | { mode: "all-unlocked" }
    | { mode: "explicit"; operatorIds: string[] };
  rotation: {
    cycleHours: number;
    shifts: Array<{
      id: string;
      durationHours: number;
      assignments: Record<string, { label?: string; operatorIds?: string[] }>;
      referenceOutputPer24Hours?: BenchmarkResourceOutput;
    }>;
  };
  expected: {
    output: BenchmarkResourceOutput;
    formulas: string[];
    tolerance: BenchmarkTolerance;
    equivalentCompositions?: BenchmarkEquivalentComposition[];
  };
}

export type OptimizerBenchmark = FormulaBenchmark | ResourceOutputBenchmark;

export type BenchmarkValidationResult =
  | { ok: true; value: OptimizerBenchmark }
  | { ok: false; errors: string[] };

const regions = new Set<BenchmarkRegion>(["JP", "CN", "GLOBAL"]);
const confidences = new Set<BenchmarkConfidence>(["confirmed", "corroborated", "disputed"]);
const sourceLanguages = new Set(["ja", "en", "zh"]);
const sourceRoles = new Set(["primary-text", "formula", "composition", "throughput"]);
const resourceNames = new Set<BenchmarkResourceName>([
  "goldProduced",
  "goldConsumed",
  "goldNetChange",
  "battleRecordExp",
  "lmd",
  "dronesUsed",
  "droneLmd",
  "droneGoldConsumed"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function validateBase(benchmark: Record<string, unknown>, errors: string[]): void {
  if (!isNonEmptyString(benchmark.id) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(benchmark.id)) {
    errors.push("id must be a non-empty kebab-case string");
  }
  if (!regions.has(benchmark.region as BenchmarkRegion)) errors.push("region must be JP, CN, or GLOBAL");
  if (!confidences.has(benchmark.confidence as BenchmarkConfidence)) {
    errors.push("confidence must be confirmed, corroborated, or disputed");
  }

  if (benchmark.version !== undefined) {
    errors.push("version is ambiguous; use referenceProvenance and runtimeDataProvenance");
  }
  if (!isRecord(benchmark.referenceProvenance)) {
    errors.push("referenceProvenance must be an object");
  } else {
    if (!isNonEmptyString(benchmark.referenceProvenance.version)) {
      errors.push("referenceProvenance.version must be a non-empty string");
    }
    if (!isIsoDate(benchmark.referenceProvenance.observedAt)) {
      errors.push("referenceProvenance.observedAt must be an ISO calendar date");
    }
  }
  if (benchmark.runtimeDataProvenance !== undefined) {
    if (!isRecord(benchmark.runtimeDataProvenance)) {
      errors.push("runtimeDataProvenance must be an object when present");
    } else if (!isNonEmptyString(benchmark.runtimeDataProvenance.operatorAvailabilitySourceCommit)) {
      errors.push("runtimeDataProvenance.operatorAvailabilitySourceCommit must be a non-empty string");
    }
  }

  validateAssumptions(benchmark.assumptions, errors);

  if (!Array.isArray(benchmark.sources) || benchmark.sources.length === 0) {
    errors.push("sources must contain at least one source");
  } else {
    benchmark.sources.forEach((source, index) => {
      if (!isRecord(source)) {
        errors.push(`sources[${index}] must be an object`);
        return;
      }
      let validUrl = false;
      if (typeof source.url === "string") {
        try {
          validUrl = ["http:", "https:"].includes(new URL(source.url).protocol);
        } catch {
          validUrl = false;
        }
      }
      if (!validUrl) errors.push(`sources[${index}].url must be an HTTP(S) URL`);
      if (!isNonEmptyString(source.title)) errors.push(`sources[${index}].title must be non-empty`);
      if (!isIsoDate(source.accessedAt)) errors.push(`sources[${index}].accessedAt must be an ISO calendar date`);
      if (!sourceLanguages.has(source.language as string)) errors.push(`sources[${index}].language is invalid`);
      if (!sourceRoles.has(source.role as string)) errors.push(`sources[${index}].role is invalid`);
      if (source.notes !== undefined && !isNonEmptyString(source.notes)) errors.push(`sources[${index}].notes must be non-empty`);
    });
  }
}

function validateAssumptions(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("assumptions must be an object");
    return;
  }
  if (value.layout !== "243") errors.push("assumptions.layout must be 243");
  if (!["trading", "factory", "excluded", "not-applicable"].includes(value.drones as string)) {
    errors.push("assumptions.drones is invalid");
  }
  if (
    !Array.isArray(value.facilityProducts) ||
    value.facilityProducts.length === 0 ||
    !value.facilityProducts.every((product) => ["gold", "battleRecord", "lmd"].includes(product as string))
  ) {
    errors.push("assumptions.facilityProducts is invalid");
  }
  if (!["lmd", "battleRecord", "balanced", "formula-only"].includes(value.objectiveProfile as string)) {
    errors.push("assumptions.objectiveProfile is invalid");
  }
  for (const field of ["initialMorale", "initialDrones", "initialGold"] as const) {
    const initialValue = value[field];
    if (initialValue !== undefined && (typeof initialValue !== "number" || !Number.isFinite(initialValue) || initialValue < 0)) {
      errors.push(`assumptions.${field} must be a finite non-negative number when present`);
    }
  }
  if (!Array.isArray(value.notes) || value.notes.length === 0 || !value.notes.every(isNonEmptyString)) {
    errors.push("assumptions.notes must contain at least one non-empty string");
  }
}

function validateResourceOutput(output: unknown, path: string, errors: string[]): void {
  if (!isRecord(output) || Object.keys(output).length === 0) {
    errors.push(`${path} must contain at least one resource value`);
    return;
  }
  for (const [name, value] of Object.entries(output)) {
    if (!resourceNames.has(name as BenchmarkResourceName)) {
      errors.push(`${path}.${name} is not a supported resource`);
    } else if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      errors.push(`${path}.${name} must be a finite non-negative number`);
    }
  }
}

function validateFormulaBenchmark(benchmark: Record<string, unknown>, errors: string[]): void {
  if (!Array.isArray(benchmark.formulas) || benchmark.formulas.length === 0) {
    errors.push("formulas must contain at least one formula");
    return;
  }
  benchmark.formulas.forEach((formula, index) => {
    if (
      !isRecord(formula) ||
      !isNonEmptyString(formula.id) ||
      !isNonEmptyString(formula.expression) ||
      typeof formula.expectedValue !== "number" ||
      !Number.isFinite(formula.expectedValue) ||
      !isNonEmptyString(formula.unit)
    ) {
      errors.push(`formulas[${index}] is malformed`);
    }
  });
}

function validateResourceBenchmark(benchmark: Record<string, unknown>, errors: string[]): void {
  if (benchmark.region !== "JP" && benchmark.region !== "CN") errors.push("resource-output region must be JP or CN");
  if (!["full-base", "facility-group", "facility-team"].includes(benchmark.scope as string)) {
    errors.push("scope is invalid");
  }

  if (!isRecord(benchmark.roster) || !["all-unlocked", "explicit"].includes(benchmark.roster.mode as string)) {
    errors.push("roster mode is invalid");
  } else if (
    benchmark.roster.mode === "explicit" &&
    (!Array.isArray(benchmark.roster.operatorIds) ||
      benchmark.roster.operatorIds.length === 0 ||
      !benchmark.roster.operatorIds.every(isNonEmptyString))
  ) {
    errors.push("explicit roster must contain operatorIds");
  } else if (benchmark.roster.mode === "all-unlocked" && benchmark.roster.operatorIds !== undefined) {
    errors.push("all-unlocked roster must not contain operatorIds");
  }

  if (!isRecord(benchmark.rotation) || !Array.isArray(benchmark.rotation.shifts) || benchmark.rotation.shifts.length === 0) {
    errors.push("rotation must contain shifts");
  } else {
    const cycleHours = benchmark.rotation.cycleHours;
    if (typeof cycleHours !== "number" || !Number.isFinite(cycleHours) || cycleHours <= 0) {
      errors.push("rotation.cycleHours must be a finite positive number");
    }
    let durationTotal = 0;
    const shiftIds = new Set<string>();
    benchmark.rotation.shifts.forEach((shift, index) => {
      if (!isRecord(shift) || !isNonEmptyString(shift.id)) {
        errors.push(`rotation.shifts[${index}] is malformed`);
        return;
      }
      if (shiftIds.has(shift.id)) errors.push(`rotation.shifts[${index}].id must be unique`);
      shiftIds.add(shift.id);
      if (typeof shift.durationHours !== "number" || !Number.isFinite(shift.durationHours) || shift.durationHours <= 0) {
        errors.push(`rotation.shifts[${index}].durationHours must be a finite positive number`);
      } else {
        durationTotal += shift.durationHours;
      }
      if (!isRecord(shift.assignments) || Object.keys(shift.assignments).length === 0) {
        errors.push(`rotation.shifts[${index}].assignments must not be empty`);
      } else {
        const assignedOperatorIds = new Set<string>();
        for (const [facilityId, assignment] of Object.entries(shift.assignments)) {
          if (!isNonEmptyString(facilityId) || !isRecord(assignment)) {
            errors.push(`rotation.shifts[${index}].assignments is malformed`);
            continue;
          }
          const hasLabel = isNonEmptyString(assignment.label);
          const hasIds = Array.isArray(assignment.operatorIds) && assignment.operatorIds.length > 0 && assignment.operatorIds.every(isNonEmptyString);
          if (!hasLabel && !hasIds) errors.push(`rotation.shifts[${index}].assignments.${facilityId} needs a label or operatorIds`);
          if (assignment.operatorIds !== undefined && !hasIds) {
            errors.push(`rotation.shifts[${index}].assignments.${facilityId}.operatorIds is malformed`);
          } else if (hasIds) {
            for (const operatorId of assignment.operatorIds as string[]) {
              if (assignedOperatorIds.has(operatorId)) errors.push(`rotation.shifts[${index}] assigns ${operatorId} more than once`);
              assignedOperatorIds.add(operatorId);
            }
          }
        }
      }
      if (shift.referenceOutputPer24Hours !== undefined) {
        validateResourceOutput(shift.referenceOutputPer24Hours, `rotation.shifts[${index}].referenceOutputPer24Hours`, errors);
      }
    });
    if (typeof cycleHours === "number" && Number.isFinite(cycleHours) && Math.abs(durationTotal - cycleHours) > 1e-9) {
      errors.push("rotation shift durations must sum to cycleHours");
    }
  }

  if (!isRecord(benchmark.expected)) {
    errors.push("expected must be an object");
    return;
  }
  validateResourceOutput(benchmark.expected.output, "expected.output", errors);
  if (!Array.isArray(benchmark.expected.formulas) || benchmark.expected.formulas.length === 0 || !benchmark.expected.formulas.every(isNonEmptyString)) {
    errors.push("expected.formulas must contain at least one formula");
  }
  const tolerance = benchmark.expected.tolerance;
  if (
    !isRecord(tolerance) ||
    !["absolute", "relative"].includes(tolerance.type as string) ||
    typeof tolerance.value !== "number" ||
    !Number.isFinite(tolerance.value) ||
    tolerance.value < 0
  ) {
    errors.push("expected.tolerance is malformed");
  } else if (tolerance.type === "relative") {
    if (
      tolerance.zeroExpectedAbsolute !== undefined &&
      (typeof tolerance.zeroExpectedAbsolute !== "number" ||
        !Number.isFinite(tolerance.zeroExpectedAbsolute) ||
        tolerance.zeroExpectedAbsolute < 0)
    ) {
      errors.push("expected.tolerance.zeroExpectedAbsolute must be a finite non-negative number for relative tolerance");
    }
    const hasZeroOutput = isRecord(benchmark.expected.output) &&
      Object.values(benchmark.expected.output).some((value) => value === 0);
    if (hasZeroOutput && tolerance.zeroExpectedAbsolute === undefined) {
      errors.push("expected.tolerance.zeroExpectedAbsolute is required when an expected resource is zero");
    }
  }

  validateEquivalentCompositions(benchmark.expected.equivalentCompositions, benchmark.rotation, errors);
}

function validateEquivalentCompositions(
  value: unknown,
  rotation: unknown,
  errors: string[]
): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length === 0) {
    errors.push("expected.equivalentCompositions must contain at least one composition when present");
    return;
  }

  const shifts = isRecord(rotation) && Array.isArray(rotation.shifts) ? rotation.shifts : [];
  const facilitiesByShift = new Map<string, Set<string>>();
  for (const shift of shifts) {
    if (isRecord(shift) && isNonEmptyString(shift.id) && isRecord(shift.assignments)) {
      facilitiesByShift.set(shift.id, new Set(Object.keys(shift.assignments)));
    }
  }

  value.forEach((composition, compositionIndex) => {
    const basePath = `expected.equivalentCompositions[${compositionIndex}]`;
    if (!isRecord(composition) || !Array.isArray(composition.shifts) || composition.shifts.length === 0) {
      errors.push(`${basePath}.shifts must contain at least one shift`);
      return;
    }
    const seenShiftIds = new Set<string>();
    composition.shifts.forEach((shift, shiftIndex) => {
      const shiftPath = `${basePath}.shifts[${shiftIndex}]`;
      if (!isRecord(shift) || !isNonEmptyString(shift.shiftId)) {
        errors.push(`${shiftPath}.shiftId must identify a benchmark shift`);
        return;
      }
      if (!facilitiesByShift.has(shift.shiftId)) {
        errors.push(`${shiftPath}.shiftId must identify a benchmark shift`);
      }
      if (seenShiftIds.has(shift.shiftId)) errors.push(`${shiftPath}.shiftId must be unique`);
      seenShiftIds.add(shift.shiftId);

      if (!isRecord(shift.assignments) || Object.keys(shift.assignments).length === 0) {
        errors.push(`${shiftPath}.assignments must not be empty`);
        return;
      }
      const assignedOperatorIds = new Set<string>();
      for (const [facilityId, operatorIds] of Object.entries(shift.assignments)) {
        if (!facilitiesByShift.get(shift.shiftId)?.has(facilityId)) {
          errors.push(`${shiftPath}.assignments.${facilityId} must identify a facility in the benchmark shift`);
        }
        if (!Array.isArray(operatorIds) || operatorIds.length === 0 || !operatorIds.every(isNonEmptyString)) {
          errors.push(`${shiftPath}.assignments.${facilityId} must contain operatorIds`);
          continue;
        }
        for (const operatorId of operatorIds) {
          if (assignedOperatorIds.has(operatorId)) {
            errors.push(`${shiftPath} assigns ${operatorId} more than once`);
          }
          assignedOperatorIds.add(operatorId);
        }
      }
    });
  });
}

export function validateOptimizerBenchmark(input: unknown): BenchmarkValidationResult {
  if (!isRecord(input)) return { ok: false, errors: ["benchmark must be an object"] };

  const errors: string[] = [];
  validateBase(input, errors);
  if (input.kind === "formula") validateFormulaBenchmark(input, errors);
  else if (input.kind === "resource-output") validateResourceBenchmark(input, errors);
  else errors.push("kind must be formula or resource-output");

  return errors.length === 0
    ? { ok: true, value: input as unknown as OptimizerBenchmark }
    : { ok: false, errors };
}

export function isPassFailEligible(benchmark: Pick<OptimizerBenchmark, "confidence">): boolean {
  return benchmark.confidence !== "disputed";
}
