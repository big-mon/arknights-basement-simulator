import operatorsData from "../data/operators.json";
import { operatorAvailabilitySnapshot } from "./operatorAvailability";
import { calculateCanonicalSha256 } from "./phase1AssumptionBundle";

const PASS_FAIL_AUTHORITY_SHA256_BY_ID: Readonly<Record<string, string>> = {
  "jp-wikiru-backup38-12h-v2": "a9f1f69b2bceff6896cc2bdcfaa61b88d648548fb21729a9a3ec19afae96f8b5"
};

function validatePassFailAuthorityPin(benchmark: Record<string, unknown>, errors: string[]): void {
  const authoritySha256 = typeof benchmark.id === "string"
    ? PASS_FAIL_AUTHORITY_SHA256_BY_ID[benchmark.id]
    : undefined;
  if (authoritySha256 !== undefined) {
    try {
      if (calculateCanonicalSha256(benchmark) !== authoritySha256) {
        errors.push(`${benchmark.id} must match its canonical authority SHA-256`);
      }
    } catch {
      errors.push(`${benchmark.id} must match its canonical authority SHA-256`);
    }
  }
}
export type BenchmarkRegion = "JP" | "CN" | "GLOBAL";
export type BenchmarkConfidence = "confirmed" | "corroborated" | "disputed";

export interface BenchmarkSource {
  url: string;
  immutableUrl?: string;
  contentSha256?: string;
  title: string;
  accessedAt: string;
  language: "ja" | "en" | "zh";
  role: "primary-text" | "formula" | "composition" | "throughput";
  notes?: string;
}

interface BenchmarkBase {
  contractVersion?: "phase1-pass-fail-v1";
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
  drones: "trading" | "trading-post-1" | "factory" | "excluded" | "not-applicable";
  facilityProducts: Array<"gold" | "battleRecord" | "lmd">;
  objectiveProfile: "lmd" | "battleRecord" | "balanced" | "formula-only";
  initialMorale?: number;
  initialDrones?: number;
  initialGold?: number;
  assumptionBundle?: {
    id: string;
    version: number;
    contentSha256: string;
    allowedAssumptionIds: Phase1AllowedAssumptionId[];
  };
  notes: string[];
}

export const PHASE1_ALLOWED_ASSUMPTION_IDS = [
  "phase1.high-value-order-probability.v1",
  "phase1.perception-information-factory-efficiency.v1",
  "phase1.signed-equivalent-morale-delta.v1"
] as const;

export type Phase1AllowedAssumptionId = (typeof PHASE1_ALLOWED_ASSUMPTION_IDS)[number];

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
  | "dronesGenerated"
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

export interface BenchmarkRemoteSupport {
  operatorIds?: string[];
  unresolved?: Array<{ sourceName: string; reason: string }>;
  notes: string[];
}

export interface BenchmarkAssignment {
  label?: string;
  operatorIds?: string[];
  remoteSupport?: BenchmarkRemoteSupport;
  sourceOnlyOperatorIds?: string[];
}

export interface BenchmarkCompositionEvidence {
  status: "comparable" | "disputed";
  sourceOnlyOperators: Array<{ sourceName: string; operatorId: string; reason: string }>;
  conflicts: Array<{
    path: string;
    sourceValue: string;
    benchmarkValue: string;
    notes: string;
  }>;
  disputedAssignments: Array<{
    shiftId: string;
    facilityIds: string[];
    sourceOperators: Array<{ sourceName: string; operatorId: string }>;
    reason: string;
  }>;
}

export type BenchmarkTolerance =
  | { type: "absolute"; value: number }
  | { type: "relative"; value: number; zeroExpectedAbsolute?: number };

export interface ResourceOutputBenchmark extends BenchmarkBase {
  kind: "resource-output";
  scope: "full-base" | "facility-group" | "facility-team";
  region: "JP" | "CN";
  runtimeDataProvenance: {
    operatorAvailabilitySourceCommit: string;
  };
  roster:
    | { mode: "all-unlocked" }
    | { mode: "explicit"; operatorIds: string[] };
  evaluationWindow?: {
    start:
      | { mode: "absolute"; timestamp: string; sourceIndex: number }
      | { mode: "source-relative"; sourceIndex: number; shiftId: string };
    durationHours: 24;
    shiftHours: 8 | 12;
    workSlotCount: 2 | 3;
    workerGroupCount: number;
    shiftIds: string[];
  };
  rotation: {
    cycleHours: number;
    moraleCap?: 24;
    fullCycleOperatorIds?: string[];
    facilities?: Array<{
      id: string;
      type: "tradingPost" | "factory" | "powerPlant" | "controlCenter" | "reception" | "office" | "support";
      product?: "lmd" | "gold" | "battleRecord";
      role?: string;
      level: number;
      capacity: number;
    }>;
    supportDependencies?: string[];
    supportContexts?: Array<{
      id: string;
      type: "dormitory" | "operator-support";
      activity: "recovery" | "exchange-support";
      level?: number;
      capacity: number;
    }>;
    workerGroupCount?: number;
    returnsToInitialState?: boolean;
    compositionSourceIndex?: number;
    fullCycleSourceIndex?: number;
    goldInventory?: {
      initial: number;
      final: number;
      boundaryPolicy: "return-to-initial" | "carryover";
    };
    droneInventory?: {
      initial: number;
      final: number;
      boundaryPolicy: "return-to-initial" | "carryover";
    };
    shifts: Array<{
      id: string;
      durationHours: number;
      workerGroupIds?: string[];
      factoryProducts?: { gold: number; battleRecord: number };
      assignments: Record<string, BenchmarkAssignment>;
      operatorStates?: Array<{
        operatorId: string;
        activity: "work" | "recovery" | "idle" | "exchange-support";
        durationHours: number;
        moraleStart: number;
        moraleDelta: number;
        moraleEnd: number;
      }>;
      resources?: BenchmarkResourceOutput & {
        droneDestination: "trading-post-1";
        goldInventoryStart: number;
        goldInventoryEnd: number;
        droneInventoryStart: number;
        droneInventoryEnd: number;
      };
      referenceOutputPer24Hours?: BenchmarkResourceOutput;
    }>;
  };
  expected: {
    outputBasis?: "concrete-24-hour-window" | "full-cycle-average-normalized-to-24-hours";
    output: BenchmarkResourceOutput;
    formulas: string[];
    tolerance: BenchmarkTolerance;
    equivalentCompositions?: BenchmarkEquivalentComposition[];
  };
  compositionEvidence?: BenchmarkCompositionEvidence;
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
  "dronesGenerated",
  "dronesUsed",
  "droneLmd",
  "droneGoldConsumed"
]);
const catalogOperatorIds = new Set(operatorsData.map((operator) => operator.id));
const availableOperatorIdsByRegion = {
  JP: new Set(operatorAvailabilitySnapshot.regions.JP.operatorIds),
  CN: new Set(operatorAvailabilitySnapshot.regions.CN.operatorIds)
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  path: string,
  errors: string[]
): void {
  Object.keys(value).forEach((key) => {
    if (!allowedKeys.has(key)) errors.push(`${path}.${key} is not allowed in the strict contract`);
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function isRfc3339TimestampWithOffset(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  ) {
    return false;
  }
  return !Number.isNaN(Date.parse(value));
}

function isImmutableCommitOrBlobUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      /\/(?:commit|commits|blob)\/[0-9a-fA-F]{40}(?:\/|$)/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function hasValidSourcePin(value: unknown): boolean {
  return isRecord(value) && (
    (typeof value.contentSha256 === "string" && /^[0-9a-fA-F]{64}$/.test(value.contentSha256)) ||
    isImmutableCommitOrBlobUrl(value.immutableUrl)
  );
}

function validateBase(benchmark: Record<string, unknown>, errors: string[]): void {
  if (benchmark.contractVersion !== undefined && benchmark.contractVersion !== "phase1-pass-fail-v1") {
    errors.push("contractVersion must be phase1-pass-fail-v1 when present");
  }
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
    } else if (
      typeof benchmark.runtimeDataProvenance.operatorAvailabilitySourceCommit !== "string" ||
      !/^[0-9a-fA-F]{40}$/.test(benchmark.runtimeDataProvenance.operatorAvailabilitySourceCommit)
    ) {
      errors.push("runtimeDataProvenance.operatorAvailabilitySourceCommit must be exactly 40 hexadecimal characters");
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
      if (source.immutableUrl !== undefined && !isImmutableCommitOrBlobUrl(source.immutableUrl)) {
        errors.push(`sources[${index}].immutableUrl must be an immutable HTTP(S) commit/blob URL`);
      }
      if (
        source.contentSha256 !== undefined &&
        (typeof source.contentSha256 !== "string" || !/^[0-9a-fA-F]{64}$/.test(source.contentSha256))
      ) {
        errors.push(`sources[${index}].contentSha256 must be exactly 64 hexadecimal characters`);
      }
      if (!isNonEmptyString(source.title)) errors.push(`sources[${index}].title must be non-empty`);
      if (!isIsoDate(source.accessedAt)) errors.push(`sources[${index}].accessedAt must be an ISO calendar date`);
      if (!sourceLanguages.has(source.language as string)) errors.push(`sources[${index}].language is invalid`);
      if (!sourceRoles.has(source.role as string)) errors.push(`sources[${index}].role is invalid`);
      if (source.notes !== undefined && !isNonEmptyString(source.notes)) errors.push(`sources[${index}].notes must be non-empty`);
    });
  }
}

function validatePinnedSourceIndex(
  value: unknown,
  path: string,
  sources: unknown,
  errors: string[],
  requiredRole?: BenchmarkSource["role"]
): void {
  if (!Number.isInteger(value) || !Array.isArray(sources) || !isRecord(sources[value as number])) {
    errors.push(`${path} must identify a pinned source`);
    return;
  }

  const sourceIndex = value as number;
  const source = sources[sourceIndex];
  if (!hasValidSourcePin(source)) {
    const error =
      `sources[${sourceIndex}].contentSha256 is required when immutableUrl is not an immutable commit/blob URL`;
    if (!errors.includes(error)) errors.push(error);
  }
  if (requiredRole !== undefined && source.role !== requiredRole) {
    errors.push(`${path} must identify a ${requiredRole} source`);
  }
}

function validateStrictFacilities(
  rotation: Record<string, unknown>,
  errors: string[]
): Map<string, number> {
  const capacities = new Map<string, number>();
  if (!Array.isArray(rotation.facilities)) {
    errors.push("rotation.facilities must declare the active 243 facilities");
    return capacities;
  }
  const facilities = rotation.facilities;
  const supportDependencies = Array.isArray(rotation.supportDependencies) &&
      rotation.supportDependencies.every(isNonEmptyString)
    ? rotation.supportDependencies as string[]
    : undefined;
  if (!supportDependencies) {
    errors.push("rotation.supportDependencies must be an array of facility IDs");
  }
  const supportDependencyIds = new Set(supportDependencies ?? []);
  if (supportDependencies && supportDependencyIds.size !== supportDependencies.length) {
    errors.push("rotation.supportDependencies must not contain duplicate facility IDs");
  }

  const firstIndexById = new Map<string, number>();
  const counts = new Map<string, number>();
  let goldFactories = 0;
  let battleRecordFactories = 0;
  facilities.forEach((facility, index) => {
    const path = `rotation.facilities[${index}]`;
    if (!isRecord(facility) || !isNonEmptyString(facility.id) || !isNonEmptyString(facility.type)) {
      errors.push(`${path} must declare a typed facility identity`);
      return;
    }
    rejectUnknownKeys(facility, new Set(["id", "type", "product", "level", "capacity"]), path, errors);
    const firstIndex = firstIndexById.get(facility.id);
    if (firstIndex !== undefined) {
      errors.push(`${path}.id duplicates rotation.facilities[${firstIndex}].id`);
    } else {
      firstIndexById.set(facility.id, index);
    }
    if (!Number.isInteger(facility.level) || (facility.level as number) <= 0) {
      errors.push(`${path}.level must be a positive integer`);
    }
    if (!Number.isInteger(facility.capacity) || (facility.capacity as number) <= 0) {
      errors.push(`${path}.capacity must be a positive integer`);
    } else if (!capacities.has(facility.id)) {
      capacities.set(facility.id, facility.capacity as number);
    }

    const expected = {
      tradingPost: { level: 3, capacity: 3 },
      factory: { level: 3, capacity: 3 },
      powerPlant: { level: 3, capacity: 1 },
      controlCenter: { level: 5, capacity: 5 },
      reception: { level: 3, capacity: 2 },
      office: { level: 3, capacity: 1 }
    }[facility.type as string];
    if (expected) {
      counts.set(facility.type, (counts.get(facility.type) ?? 0) + 1);
      if (facility.level !== expected.level) {
        errors.push(`${path}.level must be exactly ${expected.level} for ${facility.type}`);
      }
      if (facility.capacity !== expected.capacity) {
        errors.push(`${path}.capacity must be exactly ${expected.capacity} for ${facility.type}`);
      }
      if (facility.type === "tradingPost" && facility.product !== "lmd") {
        errors.push(`${path}.product must be lmd for tradingPost`);
      }
      if (facility.type === "factory") {
        if (facility.product === "gold") goldFactories += 1;
        else if (facility.product === "battleRecord") battleRecordFactories += 1;
        else errors.push(`${path}.product must be gold or battleRecord for factory`);
      }
      if (supportDependencyIds.has(facility.id)) {
        errors.push(`${path} is a required 243 room and must not be declared as a support dependency`);
      }
    } else {
      errors.push(`${path}.type is not a supported facility type`);
    }
  });

  const requiredCounts: Array<[string, number, string]> = [
    ["tradingPost", 2, "trading posts"],
    ["factory", 4, "factories"],
    ["powerPlant", 3, "power plants"],
    ["controlCenter", 1, "control center"],
    ["reception", 1, "reception room"],
    ["office", 1, "office"]
  ];
  requiredCounts.forEach(([type, count, label]) => {
    if ((counts.get(type) ?? 0) !== count) {
      errors.push(`rotation.facilities must declare exactly ${count} ${label}`);
    }
  });
  for (const tradingPostId of ["trading-post-1", "trading-post-2"]) {
    const index = firstIndexById.get(tradingPostId);
    if (index === undefined || !isRecord(facilities[index]) || facilities[index].type !== "tradingPost") {
      errors.push(`rotation.facilities must declare ${tradingPostId} as a tradingPost`);
    }
  }
  const allowedCounts = new Map(requiredCounts.map(([type, count]) => [type, count]));
  const seenCounts = new Map<string, number>();
  facilities.forEach((facility, index) => {
    if (!isRecord(facility) || !isNonEmptyString(facility.type)) return;
    const seen = (seenCounts.get(facility.type) ?? 0) + 1;
    seenCounts.set(facility.type, seen);
    const allowed = allowedCounts.get(facility.type);
    if (allowed !== undefined && seen > allowed) {
      errors.push(`rotation.facilities[${index}] must be an explicitly declared support dependency`);
    }
  });
  if (goldFactories !== 2 || battleRecordFactories !== 2) {
    facilities.forEach((facility, index) => {
      if (isRecord(facility) && facility.type === "factory") {
        errors.push(`rotation.facilities[${index}].product must preserve exactly 2 gold and 2 battleRecord factories`);
      }
    });
  }
  supportDependencyIds.forEach((id) => {
    const index = firstIndexById.get(id);
    if (index === undefined) {
      errors.push(`rotation.supportDependencies must identify declared support facility ${id}`);
    } else {
      const facility = facilities[index];
      if (!isRecord(facility) || facility.type !== "support") {
        errors.push(`rotation.supportDependencies must identify typed support facility ${id}`);
      }
    }
  });
  if (supportDependencyIds.size !== 0) {
    errors.push("rotation.supportDependencies must be empty; use rotation.supportContexts for non-work capacity");
  }
  return capacities;
}

function validateStrictAssumptionBundle(benchmark: Record<string, unknown>, errors: string[]): void {
  if (!isRecord(benchmark.assumptions)) return;
  const assumptions = benchmark.assumptions;
  if (assumptions.drones !== "trading-post-1") {
    errors.push("assumptions.drones must be trading-post-1 for a pass/fail candidate");
  }
  if (!Array.isArray(assumptions.facilityProducts) ||
      assumptions.facilityProducts.length !== 2 ||
      new Set(assumptions.facilityProducts).size !== 2 ||
      !assumptions.facilityProducts.includes("gold") ||
      !assumptions.facilityProducts.includes("battleRecord")) {
    errors.push("assumptions.facilityProducts must contain exactly gold and battleRecord");
  }

  const bundle = assumptions.assumptionBundle;
  if (!isRecord(bundle)) {
    errors.push("assumptions.assumptionBundle must be an object for a pass/fail candidate");
    return;
  }
  if (!isNonEmptyString(bundle.id)) {
    errors.push("assumptions.assumptionBundle.id must be a non-empty stable ID");
  }
  if (!Number.isInteger(bundle.version) || (bundle.version as number) <= 0) {
    errors.push("assumptions.assumptionBundle.version must be a positive integer");
  }
  if (typeof bundle.contentSha256 !== "string" || !/^[0-9a-f]{64}$/.test(bundle.contentSha256)) {
    errors.push("assumptions.assumptionBundle.contentSha256 must be exactly 64 lowercase hexadecimal characters");
  }
  const allowedIds = bundle.allowedAssumptionIds;
  if (!Array.isArray(allowedIds)) {
    errors.push("assumptions.assumptionBundle.allowedAssumptionIds must contain exactly the Phase 1 assumption domains");
  } else {
    const firstIndexById = new Map<string, number>();
    allowedIds.forEach((id, index) => {
      if (!isNonEmptyString(id)) {
        errors.push(`assumptions.assumptionBundle.allowedAssumptionIds[${index}] must be a non-empty stable ID`);
        return;
      }
      const firstIndex = firstIndexById.get(id);
      if (firstIndex !== undefined) {
        errors.push(
          `assumptions.assumptionBundle.allowedAssumptionIds[${index}] duplicates ` +
          `assumptions.assumptionBundle.allowedAssumptionIds[${firstIndex}]`
        );
      } else {
        firstIndexById.set(id, index);
      }
      if (!(PHASE1_ALLOWED_ASSUMPTION_IDS as readonly string[]).includes(id)) {
        errors.push(`assumptions.assumptionBundle.allowedAssumptionIds[${index}] is not an allowed Phase 1 assumption domain`);
      }
    });
    PHASE1_ALLOWED_ASSUMPTION_IDS.forEach((id) => {
      if (!firstIndexById.has(id)) {
        errors.push(`assumptions.assumptionBundle.allowedAssumptionIds must include ${id}`);
      }
    });
    if (allowedIds.length !== PHASE1_ALLOWED_ASSUMPTION_IDS.length) {
      errors.push("assumptions.assumptionBundle.allowedAssumptionIds must contain exactly 3 assumption domains");
    }
  }
  if (benchmark.confidence === "confirmed") {
    errors.push("confidence must not be confirmed when assumptions.assumptionBundle is used");
  }
}

function validateStrictSupportContexts(rotation: Record<string, unknown>, errors: string[]): Map<string, number> {
  const capacities = new Map<string, number>();
  if (!Array.isArray(rotation.supportContexts)) {
    errors.push("rotation.supportContexts must declare recovery and exchange-support capacity");
    return capacities;
  }
  const firstIndexById = new Map<string, number>();
  rotation.supportContexts.forEach((context, index) => {
    const path = `rotation.supportContexts[${index}]`;
    if (!isRecord(context) || !isNonEmptyString(context.id)) {
      errors.push(`${path}.id must be a non-empty support context ID`);
      return;
    }
    rejectUnknownKeys(context, new Set(["id", "type", "activity", "level", "capacity"]), path, errors);
    const firstIndex = firstIndexById.get(context.id);
    if (firstIndex !== undefined) {
      errors.push(`${path}.id duplicates rotation.supportContexts[${firstIndex}].id`);
    } else {
      firstIndexById.set(context.id, index);
    }
    if (context.activity !== "recovery" && context.activity !== "exchange-support") {
      errors.push(`${path}.activity must be recovery or exchange-support`);
      return;
    }
    if (context.activity === "recovery" &&
        (context.type !== "dormitory" || context.level !== 5 || context.capacity !== 5)) {
      errors.push(`${path} recovery context must be a level-5 dormitory with capacity 5`);
    }
    if (context.activity === "exchange-support") {
      if (context.type !== "operator-support") {
        errors.push(`${path}.type must be operator-support for exchange-support`);
      }
      if (context.capacity !== 1) {
        errors.push(`${path}.capacity must be exactly 1 for exchange-support`);
      }
    }
    if (!Number.isInteger(context.capacity) || (context.capacity as number) < 0) {
      errors.push(`${path}.capacity must be a non-negative integer`);
      return;
    }
    const declaredCapacity = context.capacity as number;
    const authoritativeCapacity = context.activity === "exchange-support"
      ? Math.min(declaredCapacity, 1)
      : declaredCapacity;
    capacities.set(
      context.activity,
      Math.min((capacities.get(context.activity) ?? 0) + authoritativeCapacity,
        context.activity === "exchange-support" ? 1 : Number.POSITIVE_INFINITY)
    );
  });
  for (const activity of ["recovery", "exchange-support"] as const) {
    if (!capacities.has(activity)) {
      errors.push(`rotation.supportContexts must declare ${activity} capacity`);
    }
  }
  const recoveryContexts = rotation.supportContexts.filter(
    (context) => isRecord(context) && context.activity === "recovery"
  );
  if (recoveryContexts.length !== 4) {
    errors.push("rotation.supportContexts must declare exactly 4 recovery dormitories");
  }
  const exchangeSupportContexts = rotation.supportContexts.filter(
    (context) => isRecord(context) && context.activity === "exchange-support"
  );
  if (exchangeSupportContexts.length !== 1) {
    errors.push("rotation.supportContexts must declare exactly 1 operator-support exchange-support context");
  }
  return capacities;
}

function validateStrictPassFailContract(benchmark: Record<string, unknown>, errors: string[]): void {
  if (benchmark.scope !== "full-base") {
    errors.push("scope must be full-base for a pass/fail candidate");
  }

  validateStrictAssumptionBundle(benchmark, errors);

  const evaluationWindow = benchmark.evaluationWindow;
  if (!isRecord(evaluationWindow)) {
    errors.push("evaluationWindow must be an object for a pass/fail candidate");
    return;
  }
  const evaluationStart = evaluationWindow.start;
  if (!isRecord(evaluationStart) || !["absolute", "source-relative"].includes(evaluationStart.mode as string)) {
    errors.push("evaluationWindow.start must be an absolute or source-relative boundary");
  } else {
    if (evaluationStart.mode === "absolute" && !isRfc3339TimestampWithOffset(evaluationStart.timestamp)) {
      errors.push("evaluationWindow.start.timestamp must be an RFC 3339 timestamp with an explicit offset");
    }
    if (evaluationStart.mode === "source-relative" && !isNonEmptyString(evaluationStart.shiftId)) {
      errors.push("evaluationWindow.start.shiftId must identify a rotation shift");
    }
    validatePinnedSourceIndex(
      evaluationStart.sourceIndex,
      "evaluationWindow.start.sourceIndex",
      benchmark.sources,
      errors
    );
  }
  if (evaluationWindow.durationHours !== 24) {
    errors.push("evaluationWindow.durationHours must be exactly 24");
  }

  const validWorkSlotModel =
    (evaluationWindow.shiftHours === 12 && evaluationWindow.workSlotCount === 2) ||
    (evaluationWindow.shiftHours === 8 && evaluationWindow.workSlotCount === 3);
  if (!validWorkSlotModel) {
    errors.push("evaluationWindow.shiftHours must be 12 for 2 work slots or 8 for 3 work slots");
  }
  if (!Array.isArray(evaluationWindow.shiftIds) || !evaluationWindow.shiftIds.every(isNonEmptyString)) {
    errors.push("evaluationWindow.shiftIds must contain work-slot IDs");
  } else if (evaluationWindow.workSlotCount !== evaluationWindow.shiftIds.length) {
    errors.push("evaluationWindow.workSlotCount must equal evaluationWindow.shiftIds.length");
  }
  if (!Number.isInteger(evaluationWindow.workerGroupCount) || (evaluationWindow.workerGroupCount as number) <= 0) {
    errors.push("evaluationWindow.workerGroupCount must be a positive integer");
  }
  if (!isRecord(benchmark.rotation) || !Array.isArray(benchmark.rotation.shifts)) return;
  const rotation = benchmark.rotation;
  validatePinnedSourceIndex(
    rotation.compositionSourceIndex,
    "rotation.compositionSourceIndex",
    benchmark.sources,
    errors,
    "composition"
  );
  validatePinnedSourceIndex(
    rotation.fullCycleSourceIndex,
    "rotation.fullCycleSourceIndex",
    benchmark.sources,
    errors,
    "composition"
  );

  const facilityCapacities = validateStrictFacilities(rotation, errors);
  const supportCapacities = validateStrictSupportContexts(rotation, errors);
  if (isRecord(evaluationStart) && evaluationStart.mode === "source-relative" &&
      evaluationStart.sourceIndex !== rotation.fullCycleSourceIndex) {
    errors.push("evaluationWindow.start.sourceIndex must equal rotation.fullCycleSourceIndex for a source-relative boundary");
  }
  if (rotation.moraleCap !== 24) {
    errors.push("rotation.moraleCap must be exactly 24");
  }
  const explicitRosterIds = isRecord(benchmark.roster) && benchmark.roster.mode === "explicit" &&
      Array.isArray(benchmark.roster.operatorIds)
    ? new Set((benchmark.roster.operatorIds as unknown[]).filter(isNonEmptyString))
    : undefined;
  if (!explicitRosterIds) {
    errors.push("roster must use explicit operatorIds for a pass/fail candidate");
  }
  const cycleOperatorIds = new Set<string>();
  if (!Array.isArray(rotation.fullCycleOperatorIds) || rotation.fullCycleOperatorIds.length === 0 ||
      !rotation.fullCycleOperatorIds.every(isNonEmptyString)) {
    errors.push("rotation.fullCycleOperatorIds must declare the full-cycle operator roster");
  } else {
    const firstIndexByOperatorId = new Map<string, number>();
    rotation.fullCycleOperatorIds.forEach((operatorId, index) => {
      const firstIndex = firstIndexByOperatorId.get(operatorId);
      if (firstIndex !== undefined) {
        errors.push(`rotation.fullCycleOperatorIds[${index}] duplicates rotation.fullCycleOperatorIds[${firstIndex}]`);
      } else {
        firstIndexByOperatorId.set(operatorId, index);
      }
      cycleOperatorIds.add(operatorId);
      validateOperatorReference(
        operatorId,
        `rotation.fullCycleOperatorIds[${index}]`,
        benchmark.region,
        explicitRosterIds,
        errors
      );
    });
    explicitRosterIds?.forEach((operatorId) => {
      if (!cycleOperatorIds.has(operatorId)) {
        errors.push(`roster.operatorIds contains extra operator ID ${operatorId} outside rotation.fullCycleOperatorIds`);
      }
    });
  }

  const shifts = rotation.shifts as unknown[];
  const shiftIndexById = new Map<string, number>();
  const fullCycleWorkerGroupIds = new Set<string>();
  shifts.forEach((shift, index) => {
    if (!isRecord(shift)) return;
    rejectUnknownKeys(
      shift,
      new Set(["id", "durationHours", "workerGroupIds", "factoryProducts", "assignments", "operatorStates", "resources"]),
      `rotation.shifts[${index}]`,
      errors
    );
    if (isNonEmptyString(shift.id)) shiftIndexById.set(shift.id, index);
    if (shift.durationHours !== evaluationWindow.shiftHours) {
      errors.push(`rotation.shifts[${index}].durationHours must equal evaluationWindow.shiftHours`);
    }
    if (
      !Array.isArray(shift.workerGroupIds) ||
      shift.workerGroupIds.length === 0 ||
      !shift.workerGroupIds.every(isNonEmptyString)
    ) {
      errors.push(`rotation.shifts[${index}].workerGroupIds must contain worker-group IDs`);
    } else {
      const seenInShift = new Set<string>();
      shift.workerGroupIds.forEach((workerGroupId, groupIndex) => {
        if (seenInShift.has(workerGroupId)) {
          errors.push(`rotation.shifts[${index}].workerGroupIds[${groupIndex}] must be unique within the shift`);
        }
        seenInShift.add(workerGroupId);
        fullCycleWorkerGroupIds.add(workerGroupId);
      });
    }
    if (!isRecord(shift.factoryProducts) || shift.factoryProducts.gold !== 2) {
      errors.push(`rotation.shifts[${index}].factoryProducts.gold must be exactly 2`);
    }
    if (!isRecord(shift.factoryProducts) || shift.factoryProducts.battleRecord !== 2) {
      errors.push(`rotation.shifts[${index}].factoryProducts.battleRecord must be exactly 2`);
    }
    if (isRecord(shift.assignments)) {
      const assignments = shift.assignments;
      const assignmentFacilityIds = new Set(Object.keys(assignments));
      facilityCapacities.forEach((capacity, facilityId) => {
        const assignment = assignments[facilityId];
        if (!isRecord(assignment)) {
          errors.push(`rotation.shifts[${index}].assignments.${facilityId} must cover declared active facility`);
          return;
        }
        if (!Array.isArray(assignment.operatorIds) || assignment.operatorIds.length !== capacity) {
          errors.push(
            `rotation.shifts[${index}].assignments.${facilityId}.operatorIds must contain exactly ${capacity} operators`
          );
        }
      });
      for (const [facilityId, assignment] of Object.entries(assignments)) {
        if (!facilityCapacities.has(facilityId)) {
          errors.push(`rotation.shifts[${index}].assignments.${facilityId} must identify a declared active facility`);
        }
        if (!isRecord(assignment)) continue;
        if (
          !Array.isArray(assignment.operatorIds) ||
          assignment.operatorIds.length === 0 ||
          !assignment.operatorIds.every(isNonEmptyString)
        ) {
          errors.push(
            `rotation.shifts[${index}].assignments.${facilityId}.operatorIds ` +
            "must contain concrete operator IDs for a pass/fail candidate"
          );
          continue;
        }
        assignment.operatorIds.forEach((operatorId, operatorIndex) => {
          if (!cycleOperatorIds.has(operatorId)) {
            errors.push(
              `rotation.shifts[${index}].assignments.${facilityId}.operatorIds[${operatorIndex}] ` +
              "must identify a full-cycle roster operator"
            );
          }
        });
      }
      if (assignmentFacilityIds.size !== facilityCapacities.size) {
        errors.push(`rotation.shifts[${index}].assignments must cover exactly the declared active facilities`);
      }
    }
  });

  if (rotation.workerGroupCount !== fullCycleWorkerGroupIds.size) {
    errors.push(
      `rotation.workerGroupCount must equal ${fullCycleWorkerGroupIds.size} distinct worker groups in rotation.shifts`
    );
  }

  let evaluatedShiftIndexes: number[] = [];
  if (Array.isArray(evaluationWindow.shiftIds)) {
    const evaluatedShifts: Record<string, unknown>[] = [];
    const evaluatedWorkerGroupIds = new Set<string>();
    let selectedDurationHours = 0;
    let previousShiftIndex: number | undefined;
    evaluationWindow.shiftIds.forEach((shiftId, evaluationIndex) => {
      const shiftIndex = shiftIndexById.get(shiftId as string);
      if (shiftIndex === undefined) {
        errors.push(`evaluationWindow.shiftIds[${evaluationIndex}] must identify a rotation shift`);
        return;
      }
      if (
        previousShiftIndex !== undefined &&
        shiftIndex !== (previousShiftIndex + 1) % shifts.length
      ) {
        errors.push(
          `evaluationWindow.shiftIds[${evaluationIndex}] must identify the next consecutive rotation shift`
        );
      }
      previousShiftIndex = shiftIndex;
      evaluatedShiftIndexes.push(shiftIndex);
      const shift = shifts[shiftIndex];
      if (!isRecord(shift)) return;
      evaluatedShifts.push(shift);
      if (typeof shift.durationHours === "number" && Number.isFinite(shift.durationHours)) {
        selectedDurationHours += shift.durationHours;
      }
      if (Array.isArray(shift.workerGroupIds)) {
        shift.workerGroupIds.filter(isNonEmptyString).forEach((id) => evaluatedWorkerGroupIds.add(id));
      }
    });
    if (evaluatedShifts.length !== evaluationWindow.shiftIds.length || selectedDurationHours !== 24) {
      errors.push("evaluationWindow.shiftIds must select full work slots totaling exactly 24 hours");
    }
    if (evaluationWindow.workerGroupCount !== evaluatedWorkerGroupIds.size) {
      errors.push(
        `evaluationWindow.workerGroupCount must equal ${evaluatedWorkerGroupIds.size} distinct worker groups in the evaluated shifts`
      );
    }
  }

  if (isRecord(evaluationStart) && evaluationStart.mode === "source-relative") {
    const anchorIndex = shiftIndexById.get(evaluationStart.shiftId as string);
    if (anchorIndex === undefined) {
      errors.push("evaluationWindow.start.shiftId must identify a rotation shift");
    } else if (
      !Array.isArray(evaluationWindow.shiftIds) ||
      evaluationWindow.shiftIds[0] !== evaluationStart.shiftId
    ) {
      errors.push("evaluationWindow.start.shiftId must equal evaluationWindow.shiftIds[0]");
    }
  }

  const nearlyEqual = (left: number, right: number): boolean => Math.abs(left - right) <= 1e-9;
  const isFiniteNonNegative = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0;
  const firstMoraleByOperator = new Map<string, number>();
  const previousMoraleByOperator = new Map<string, number>();
  const resourceFields = [
    "goldProduced",
    "goldConsumed",
    "battleRecordExp",
    "lmd",
    "dronesGenerated",
    "dronesUsed",
    "droneLmd",
    "droneGoldConsumed"
  ] as const;
  const evaluatedResourceSums = Object.fromEntries(resourceFields.map((field) => [field, 0])) as
    Record<(typeof resourceFields)[number], number>;

  if (!isRecord(rotation.goldInventory) || !isFiniteNonNegative(rotation.goldInventory.initial) ||
      !isFiniteNonNegative(rotation.goldInventory.final) ||
      !["return-to-initial", "carryover"].includes(rotation.goldInventory.boundaryPolicy as string)) {
    errors.push(
      "rotation.goldInventory must declare finite non-negative initial/final values and an explicit boundaryPolicy"
    );
  }
  let previousGold = isRecord(rotation.goldInventory) && isFiniteNonNegative(rotation.goldInventory.initial)
    ? rotation.goldInventory.initial
    : undefined;
  if (!isRecord(rotation.droneInventory) || !isFiniteNonNegative(rotation.droneInventory.initial) ||
      !isFiniteNonNegative(rotation.droneInventory.final) ||
      !["return-to-initial", "carryover"].includes(rotation.droneInventory.boundaryPolicy as string)) {
    errors.push(
      "rotation.droneInventory must declare finite non-negative initial/final values and an explicit boundaryPolicy"
    );
  }
  let previousDrones = isRecord(rotation.droneInventory) && isFiniteNonNegative(rotation.droneInventory.initial)
    ? rotation.droneInventory.initial
    : undefined;

  shifts.forEach((shift, shiftIndex) => {
    if (!isRecord(shift)) return;
    const shiftPath = `rotation.shifts[${shiftIndex}]`;
    const assignedOperatorIds = new Set<string>();
    if (isRecord(shift.assignments)) {
      Object.values(shift.assignments).forEach((assignment) => {
        if (isRecord(assignment) && Array.isArray(assignment.operatorIds)) {
          assignment.operatorIds.filter(isNonEmptyString).forEach((operatorId) => assignedOperatorIds.add(operatorId));
        }
      });
    }

    if (!Array.isArray(shift.operatorStates)) {
      errors.push(`${shiftPath}.operatorStates must cover every cycle operator`);
    } else {
      const seenStateOperators = new Set<string>();
      const supportUse = new Map<string, number>();
      let exchangeMoraleDelta = 0;
      shift.operatorStates.forEach((state, stateIndex) => {
        const statePath = `${shiftPath}.operatorStates[${stateIndex}]`;
        if (!isRecord(state) || !isNonEmptyString(state.operatorId)) {
          errors.push(`${statePath} must be a typed activity state tied to an operator ID`);
          return;
        }
        rejectUnknownKeys(
          state,
          new Set(["operatorId", "activity", "durationHours", "moraleStart", "moraleDelta", "moraleEnd"]),
          statePath,
          errors
        );
        const operatorId = state.operatorId;
        if (seenStateOperators.has(operatorId)) {
          errors.push(`${statePath}.operatorId overlaps another work/recovery state for ${operatorId}`);
        }
        seenStateOperators.add(operatorId);
        if (!cycleOperatorIds.has(operatorId)) {
          errors.push(`${statePath}.operatorId must identify a full-cycle roster operator`);
        }
        validateOperatorReference(operatorId, `${statePath}.operatorId`, benchmark.region, explicitRosterIds, errors);
        const assigned = assignedOperatorIds.has(operatorId);
        if (assigned && state.activity !== "work") {
          errors.push(`${statePath}.activity must be work for assignment membership`);
        } else if (!assigned && state.activity === "work") {
          errors.push(`${statePath}.activity must not be work without assignment membership`);
        } else if (!assigned && !["recovery", "idle", "exchange-support"].includes(state.activity as string)) {
          errors.push(`${statePath}.activity must be recovery, idle, or exchange-support without assignment membership`);
        }
        if (state.activity === "recovery" || state.activity === "exchange-support") {
          supportUse.set(state.activity, (supportUse.get(state.activity) ?? 0) + 1);
        }
        if (state.durationHours !== shift.durationHours) {
          errors.push(`${statePath}.durationHours must equal ${shiftPath}.durationHours`);
        }
        if (!isFiniteNonNegative(state.moraleStart) || state.moraleStart > 24) {
          errors.push(`${statePath}.moraleStart must be between 0 and rotation.moraleCap`);
        }
        if (!isFiniteNonNegative(state.moraleEnd) || state.moraleEnd > 24) {
          errors.push(`${statePath}.moraleEnd must be between 0 and rotation.moraleCap`);
        }
        if (typeof state.moraleDelta !== "number" || !Number.isFinite(state.moraleDelta)) {
          errors.push(`${statePath}.moraleDelta must be a finite signed number`);
        } else {
          if (state.activity === "work" && state.moraleDelta > 0) {
            errors.push(`${statePath}.moraleDelta must be non-positive for work`);
          } else if (state.activity === "recovery" && state.moraleDelta < 0) {
            errors.push(`${statePath}.moraleDelta must be non-negative for recovery`);
          } else if (state.activity === "idle" && state.moraleDelta !== 0) {
            errors.push(`${statePath}.moraleDelta must be zero for idle`);
          }
          if (state.activity === "exchange-support") exchangeMoraleDelta += state.moraleDelta;
          if (typeof state.moraleStart === "number" && Number.isFinite(state.moraleStart) &&
              typeof state.moraleEnd === "number" && Number.isFinite(state.moraleEnd) &&
              !nearlyEqual(state.moraleEnd, state.moraleStart + state.moraleDelta)) {
            errors.push(`${statePath}.moraleEnd must equal moraleStart plus moraleDelta`);
          }
        }
        if (state.moraleCostPerHour !== undefined || state.moraleRecoveryPerHour !== undefined) {
          errors.push(`${statePath} must not declare per-hour morale fields in the strict contract`);
        }
        const previousMorale = previousMoraleByOperator.get(operatorId);
        if (previousMorale !== undefined && typeof state.moraleStart === "number" &&
            !nearlyEqual(state.moraleStart, previousMorale)) {
          errors.push(`${statePath}.moraleStart must equal the preceding shift moraleEnd`);
        }
        if (!firstMoraleByOperator.has(operatorId) && typeof state.moraleStart === "number") {
          firstMoraleByOperator.set(operatorId, state.moraleStart);
        }
        if (typeof state.moraleEnd === "number") previousMoraleByOperator.set(operatorId, state.moraleEnd);
      });
      cycleOperatorIds.forEach((operatorId) => {
        if (!seenStateOperators.has(operatorId)) {
          errors.push(`${shiftPath}.operatorStates must include ${operatorId}`);
        }
      });
      const recoveryUsed = supportUse.get("recovery") ?? 0;
      const recoveryCapacity = supportCapacities.get("recovery");
      if (recoveryCapacity !== undefined && recoveryUsed > recoveryCapacity) {
        errors.push(`${shiftPath}.operatorStates recovery occupancy ${recoveryUsed} exceeds rotation.supportContexts capacity ${recoveryCapacity}`);
      }
      const exchangeActorCount = supportUse.get("exchange-support") ?? 0;
      if (exchangeActorCount > 0) {
        if (exchangeActorCount % 2 !== 0) {
          errors.push(`${shiftPath}.operatorStates exchange-support actor count ${exchangeActorCount} must be even`);
        }
        const exchangePairOccupancy = exchangeActorCount / 2;
        const exchangeCapacity = supportCapacities.get("exchange-support");
        if (exchangeCapacity !== undefined && exchangePairOccupancy > exchangeCapacity) {
          errors.push(`${shiftPath}.operatorStates exchange-support pair occupancy ${exchangePairOccupancy} exceeds rotation.supportContexts capacity ${exchangeCapacity}`);
        }
        if (!nearlyEqual(exchangeMoraleDelta, 0)) {
          errors.push(`${shiftPath}.operatorStates exchange-support aggregate moraleDelta must equal 0`);
        }
      }
    }

    if (!isRecord(shift.resources)) {
      errors.push(`${shiftPath}.resources must contain concrete per-shift resource contributions`);
      return;
    }
    const resources = shift.resources;
    rejectUnknownKeys(
      resources,
      new Set([
        ...resourceFields,
        "droneDestination",
        "goldInventoryStart",
        "goldInventoryEnd",
        "droneInventoryStart",
        "droneInventoryEnd"
      ]),
      `${shiftPath}.resources`,
      errors
    );
    resourceFields.forEach((field) => {
      if (!isFiniteNonNegative(resources[field])) {
        errors.push(`${shiftPath}.resources.${field} must be a finite non-negative number`);
      } else if (evaluatedShiftIndexes.includes(shiftIndex)) {
        evaluatedResourceSums[field] += resources[field] as number;
      }
    });
    if (typeof shift.resources.goldInventoryEnd === "number" &&
        Number.isFinite(shift.resources.goldInventoryEnd) && shift.resources.goldInventoryEnd < 0) {
      errors.push(`${shiftPath}.resources.goldInventoryEnd must not be negative`);
    }
    if (!isFiniteNonNegative(shift.resources.goldInventoryStart) ||
        !isFiniteNonNegative(shift.resources.goldInventoryEnd)) {
      errors.push(`${shiftPath}.resources gold inventory values must be finite and non-negative`);
    } else {
      if (previousGold !== undefined && !nearlyEqual(shift.resources.goldInventoryStart, previousGold)) {
        errors.push(`${shiftPath}.resources.goldInventoryStart must equal the preceding gold inventory`);
      }
      if (isFiniteNonNegative(shift.resources.goldProduced) && isFiniteNonNegative(shift.resources.goldConsumed) &&
          !nearlyEqual(
            shift.resources.goldInventoryEnd,
            shift.resources.goldInventoryStart + shift.resources.goldProduced - shift.resources.goldConsumed
          )) {
        errors.push(`${shiftPath}.resources.goldInventoryEnd must equal start plus produced minus consumed`);
      }
      previousGold = shift.resources.goldInventoryEnd;
    }
    if (evaluatedShiftIndexes.includes(shiftIndex) && isFiniteNonNegative(shift.resources.dronesUsed) &&
        shift.resources.dronesUsed > 0 && shift.resources.droneDestination !== "trading-post-1") {
      errors.push(
        `${shiftPath}.resources.droneDestination must be trading-post-1 when dronesUsed is positive in the evaluation window`
      );
    }
    if (typeof shift.resources.droneInventoryEnd === "number" &&
        Number.isFinite(shift.resources.droneInventoryEnd) && shift.resources.droneInventoryEnd < 0) {
      errors.push(`${shiftPath}.resources.droneInventoryEnd must not be negative`);
    }
    if (!isFiniteNonNegative(shift.resources.droneInventoryStart) ||
        !isFiniteNonNegative(shift.resources.droneInventoryEnd)) {
      errors.push(`${shiftPath}.resources drone inventory values must be finite and non-negative`);
    } else {
      if (previousDrones !== undefined && !nearlyEqual(shift.resources.droneInventoryStart, previousDrones)) {
        errors.push(`${shiftPath}.resources.droneInventoryStart must equal the preceding drone inventory`);
      }
      if (isFiniteNonNegative(shift.resources.dronesGenerated) && isFiniteNonNegative(shift.resources.dronesUsed) &&
          !nearlyEqual(
            shift.resources.droneInventoryEnd,
            shift.resources.droneInventoryStart + shift.resources.dronesGenerated - shift.resources.dronesUsed
          )) {
        errors.push(`${shiftPath}.resources.droneInventoryEnd must equal start plus generated minus used`);
      }
      previousDrones = shift.resources.droneInventoryEnd;
    }
  });

  cycleOperatorIds.forEach((operatorId) => {
    const initialMorale = firstMoraleByOperator.get(operatorId);
    const finalMorale = previousMoraleByOperator.get(operatorId);
    if (initialMorale === undefined || finalMorale === undefined || !nearlyEqual(initialMorale, finalMorale)) {
      errors.push(`rotation.operatorStates.${operatorId} must return to its initial morale at cycle end`);
    }
  });
  if (isRecord(rotation.goldInventory) && isFiniteNonNegative(rotation.goldInventory.final) &&
      previousGold !== undefined && !nearlyEqual(rotation.goldInventory.final, previousGold)) {
    errors.push("rotation.goldInventory.final must equal the final shift gold inventory");
  }
  if (isRecord(rotation.goldInventory) && rotation.goldInventory.boundaryPolicy === "return-to-initial" &&
      isFiniteNonNegative(rotation.goldInventory.initial) && isFiniteNonNegative(rotation.goldInventory.final) &&
      !nearlyEqual(rotation.goldInventory.initial, rotation.goldInventory.final)) {
    errors.push("rotation.goldInventory.final must return to initial under return-to-initial boundaryPolicy");
  }
  if (isRecord(rotation.droneInventory) && isFiniteNonNegative(rotation.droneInventory.final) &&
      previousDrones !== undefined && !nearlyEqual(rotation.droneInventory.final, previousDrones)) {
    errors.push("rotation.droneInventory.final must equal the final shift drone inventory");
  }
  if (isRecord(rotation.droneInventory) && rotation.droneInventory.boundaryPolicy === "return-to-initial" &&
      isFiniteNonNegative(rotation.droneInventory.initial) && isFiniteNonNegative(rotation.droneInventory.final) &&
      !nearlyEqual(rotation.droneInventory.initial, rotation.droneInventory.final)) {
    errors.push("rotation.droneInventory.final must return to initial under return-to-initial boundaryPolicy");
  }

  if (isRecord(benchmark.expected) && isRecord(benchmark.expected.output)) {
    const expectedOutput = benchmark.expected.output;
    const expectedSums: Record<string, number> = { ...evaluatedResourceSums };
    expectedSums.goldNetChange = evaluatedResourceSums.goldProduced - evaluatedResourceSums.goldConsumed;
    [...resourceFields, "goldNetChange"].forEach((field) => {
      if (typeof expectedOutput[field] !== "number" ||
          !nearlyEqual(expectedOutput[field] as number, expectedSums[field])) {
        errors.push(`expected.output.${field} must equal the sum of evaluationWindow.shiftIds resources`);
      }
    });
  }

  if (!isRecord(benchmark.expected) || benchmark.expected.outputBasis !== "concrete-24-hour-window") {
    errors.push("expected.outputBasis must be concrete-24-hour-window for a pass/fail candidate");
  }
}

function validateAssumptions(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("assumptions must be an object");
    return;
  }
  if (value.layout !== "243") errors.push("assumptions.layout must be 243");
  if (!["trading", "trading-post-1", "factory", "excluded", "not-applicable"].includes(value.drones as string)) {
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
    } else if (name === "goldNetChange") {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        errors.push(`${path}.${name} must be a finite number`);
      }
    } else if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      errors.push(`${path}.${name} must be a finite non-negative number`);
    }
  }
}

function facilitySlotCount(facilityId: string): number | undefined {
  if (facilityId.startsWith("trading-")) return 3;
  if (facilityId.startsWith("factory-")) return 3;
  if (facilityId.startsWith("power-")) return 1;
  if (facilityId.startsWith("control-")) return 5;
  if (facilityId.startsWith("dormitory-")) return 5;
  if (facilityId.startsWith("reception-")) return 2;
  if (facilityId.startsWith("office-")) return 1;
  if (facilityId.startsWith("workshop-")) return 1;
  if (facilityId.startsWith("training-")) return 2;
  return undefined;
}

function validateStringArray(value: unknown, path: string, errors: string[]): value is string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isNonEmptyString)) {
    errors.push(`${path} must contain non-empty strings`);
    return false;
  }
  if (new Set(value).size !== value.length) errors.push(`${path} must not contain duplicates`);
  return true;
}

function validateCompositionEvidence(value: unknown, shiftIds: Set<string>, errors: string[]): Set<string> {
  const declaredSourceOnlyIds = new Set<string>();
  if (value === undefined) return declaredSourceOnlyIds;
  if (!isRecord(value)) {
    errors.push("compositionEvidence must be an object when present");
    return declaredSourceOnlyIds;
  }
  if (!["comparable", "disputed"].includes(value.status as string)) {
    errors.push("compositionEvidence.status must be comparable or disputed");
  }
  if (!Array.isArray(value.sourceOnlyOperators)) {
    errors.push("compositionEvidence.sourceOnlyOperators must be an array");
  } else {
    value.sourceOnlyOperators.forEach((item, index) => {
      const path = `compositionEvidence.sourceOnlyOperators[${index}]`;
      if (!isRecord(item) || !isNonEmptyString(item.sourceName) || !isNonEmptyString(item.operatorId) || !isNonEmptyString(item.reason)) {
        errors.push(`${path} is malformed`);
        return;
      }
      if (declaredSourceOnlyIds.has(item.operatorId)) errors.push(`${path}.operatorId must be unique`);
      declaredSourceOnlyIds.add(item.operatorId);
    });
  }
  if (!Array.isArray(value.conflicts)) {
    errors.push("compositionEvidence.conflicts must be an array");
  } else {
    value.conflicts.forEach((item, index) => {
      if (!isRecord(item) || !isNonEmptyString(item.path) || !isNonEmptyString(item.sourceValue) ||
        !isNonEmptyString(item.benchmarkValue) || !isNonEmptyString(item.notes)) {
        errors.push(`compositionEvidence.conflicts[${index}] is malformed`);
      }
    });
  }
  if (!Array.isArray(value.disputedAssignments)) {
    errors.push("compositionEvidence.disputedAssignments must be an array");
  } else {
    value.disputedAssignments.forEach((item, index) => {
      const path = `compositionEvidence.disputedAssignments[${index}]`;
      if (!isRecord(item) || !isNonEmptyString(item.shiftId) || !shiftIds.has(item.shiftId) ||
        !Array.isArray(item.facilityIds) || item.facilityIds.length === 0 || !item.facilityIds.every(isNonEmptyString) ||
        !Array.isArray(item.sourceOperators) || item.sourceOperators.length === 0 ||
        !item.sourceOperators.every((operator) => isRecord(operator) && isNonEmptyString(operator.sourceName) && isNonEmptyString(operator.operatorId)) ||
        !isNonEmptyString(item.reason)) {
        errors.push(`${path} is malformed`);
      }
    });
  }
  return declaredSourceOnlyIds;
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

function validateOperatorReference(
  operatorId: string,
  path: string,
  region: unknown,
  explicitRosterIds: ReadonlySet<string> | undefined,
  errors: string[]
): void {
  const regionalAvailability = region === "JP" || region === "CN"
    ? availableOperatorIdsByRegion[region]
    : undefined;
  if (!catalogOperatorIds.has(operatorId) && !regionalAvailability?.has(operatorId)) {
    errors.push(`${path} contains unknown operator ID ${operatorId}`);
    return;
  }
  if (regionalAvailability && !regionalAvailability.has(operatorId)) {
    errors.push(`${path} contains operator ID ${operatorId} unavailable in ${region}`);
  }
  if (explicitRosterIds && !explicitRosterIds.has(operatorId)) {
    errors.push(`${path} contains operator ID ${operatorId} outside the explicit roster`);
  }
}

function validateResourceBenchmark(benchmark: Record<string, unknown>, errors: string[]): void {
  if (benchmark.region !== "JP" && benchmark.region !== "CN") errors.push("resource-output region must be JP or CN");
  if (!["full-base", "facility-group", "facility-team"].includes(benchmark.scope as string)) {
    errors.push("scope is invalid");
  }

  if (benchmark.region === "JP" || benchmark.region === "CN") {
    const expectedCommit = operatorAvailabilitySnapshot.regions[benchmark.region].source.commit;
    if (!isRecord(benchmark.runtimeDataProvenance)) {
      errors.push(
        "runtimeDataProvenance.operatorAvailabilitySourceCommit is required for resource-output benchmark " +
        `and must equal ${benchmark.region} operator availability boundary ${expectedCommit}`
      );
    } else if (benchmark.runtimeDataProvenance.operatorAvailabilitySourceCommit !== expectedCommit) {
      errors.push(
        "runtimeDataProvenance.operatorAvailabilitySourceCommit must equal " +
        `${benchmark.region} operator availability boundary ${expectedCommit}`
      );
    }
  }

  let explicitRosterIds: Set<string> | undefined;
  if (!isRecord(benchmark.roster) || !["all-unlocked", "explicit"].includes(benchmark.roster.mode as string)) {
    errors.push("roster mode is invalid");
  } else if (
    benchmark.roster.mode === "explicit" &&
    (!Array.isArray(benchmark.roster.operatorIds) ||
      benchmark.roster.operatorIds.length === 0 ||
      !benchmark.roster.operatorIds.every(isNonEmptyString))
  ) {
    errors.push("explicit roster must contain operatorIds");
  } else if (benchmark.roster.mode === "explicit") {
    explicitRosterIds = new Set<string>();
    const firstIndexByOperatorId = new Map<string, number>();
    (benchmark.roster.operatorIds as string[]).forEach((operatorId, index) => {
      const firstIndex = firstIndexByOperatorId.get(operatorId);
      if (firstIndex !== undefined) {
        errors.push(`roster.operatorIds[${index}] duplicates roster.operatorIds[${firstIndex}]`);
      } else {
        firstIndexByOperatorId.set(operatorId, index);
      }
      explicitRosterIds?.add(operatorId);
      validateOperatorReference(operatorId, `roster.operatorIds[${index}]`, benchmark.region, undefined, errors);
    });
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
          const hasSourceOnlyIds = Array.isArray(assignment.sourceOnlyOperatorIds) && assignment.sourceOnlyOperatorIds.length > 0 && assignment.sourceOnlyOperatorIds.every(isNonEmptyString);
          if (!hasLabel && !hasIds && !hasSourceOnlyIds) errors.push(`rotation.shifts[${index}].assignments.${facilityId} needs a label, operatorIds, or sourceOnlyOperatorIds`);
          if (assignment.operatorIds !== undefined && !hasIds) {
            errors.push(`rotation.shifts[${index}].assignments.${facilityId}.operatorIds is malformed`);
          } else if (hasIds) {
            const slots = facilitySlotCount(facilityId);
            if (slots !== undefined && (assignment.operatorIds as string[]).length > slots) {
              errors.push(`rotation.shifts[${index}].assignments.${facilityId}.operatorIds exceeds ${facilityId} slot count ${slots}`);
            }
            for (const [operatorIndex, operatorId] of (assignment.operatorIds as string[]).entries()) {
              if (assignedOperatorIds.has(operatorId)) errors.push(`rotation.shifts[${index}] assigns ${operatorId} more than once`);
              assignedOperatorIds.add(operatorId);
              validateOperatorReference(
                operatorId,
                `rotation.shifts[${index}].assignments.${facilityId}.operatorIds[${operatorIndex}]`,
                benchmark.region,
                explicitRosterIds,
                errors
              );
            }
          }
          if (assignment.sourceOnlyOperatorIds !== undefined && !hasSourceOnlyIds) {
            errors.push(`rotation.shifts[${index}].assignments.${facilityId}.sourceOnlyOperatorIds is malformed`);
          }
          if (assignment.remoteSupport !== undefined) {
            const supportPath = `rotation.shifts[${index}].assignments.${facilityId}.remoteSupport`;
            if (!isRecord(assignment.remoteSupport)) {
              errors.push(`${supportPath} must be an object`);
            } else {
              if (assignment.remoteSupport.operatorIds !== undefined) {
                validateStringArray(assignment.remoteSupport.operatorIds, `${supportPath}.operatorIds`, errors);
              }
              if (assignment.remoteSupport.unresolved !== undefined &&
                (!Array.isArray(assignment.remoteSupport.unresolved) || assignment.remoteSupport.unresolved.length === 0 ||
                  !assignment.remoteSupport.unresolved.every((item) => isRecord(item) && isNonEmptyString(item.sourceName) && isNonEmptyString(item.reason)))) {
                errors.push(`${supportPath}.unresolved is malformed`);
              }
              if (!Array.isArray(assignment.remoteSupport.notes) || assignment.remoteSupport.notes.length === 0 ||
                !assignment.remoteSupport.notes.every(isNonEmptyString)) {
                errors.push(`${supportPath}.notes must contain at least one non-empty string`);
              }
              if (assignment.remoteSupport.operatorIds === undefined && assignment.remoteSupport.unresolved === undefined) {
                errors.push(`${supportPath} must identify an operator or unresolved source name`);
              }
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

    const declaredSourceOnlyIds = validateCompositionEvidence(benchmark.compositionEvidence, shiftIds, errors);
    for (const [shiftIndex, shift] of benchmark.rotation.shifts.entries()) {
      if (!isRecord(shift) || !isRecord(shift.assignments)) continue;
      for (const [facilityId, assignment] of Object.entries(shift.assignments)) {
        if (!isRecord(assignment)) continue;
        const remoteIds = isRecord(assignment.remoteSupport) && Array.isArray(assignment.remoteSupport.operatorIds)
          ? assignment.remoteSupport.operatorIds : [];
        for (const [operatorIndex, operatorId] of remoteIds.entries()) {
          validateOperatorReference(
            operatorId,
            `rotation.shifts[${shiftIndex}].assignments.${facilityId}.remoteSupport.operatorIds[${operatorIndex}]`,
            benchmark.region,
            explicitRosterIds,
            errors
          );
        }
        for (const operatorId of Array.isArray(assignment.sourceOnlyOperatorIds) ? assignment.sourceOnlyOperatorIds : []) {
          if (!declaredSourceOnlyIds.has(operatorId)) {
            errors.push(`${operatorId} must be declared in compositionEvidence.sourceOnlyOperators`);
          }
          if (catalogOperatorIds.has(operatorId)) errors.push(`${operatorId} is runtime-catalogued and cannot be source-only`);
          if (Array.isArray(assignment.operatorIds) && assignment.operatorIds.includes(operatorId)) {
            errors.push(`${operatorId} cannot be both a comparable occupant and source-only`);
          }
        }
      }
    }
    for (const operatorId of declaredSourceOnlyIds) {
      if (catalogOperatorIds.has(operatorId)) errors.push(`${operatorId} is runtime-catalogued and cannot be source-only`);
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

  validateEquivalentCompositions(
    benchmark.expected.equivalentCompositions,
    benchmark.rotation,
    benchmark.region,
    explicitRosterIds,
    errors
  );
}

function validateEquivalentCompositions(
  value: unknown,
  rotation: unknown,
  region: unknown,
  explicitRosterIds: ReadonlySet<string> | undefined,
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
        for (const [operatorIndex, operatorId] of operatorIds.entries()) {
          if (assignedOperatorIds.has(operatorId)) {
            errors.push(`${shiftPath} assigns ${operatorId} more than once`);
          }
          assignedOperatorIds.add(operatorId);
          validateOperatorReference(
            operatorId,
            `${shiftPath}.assignments.${facilityId}[${operatorIndex}]`,
            region,
            explicitRosterIds,
            errors
          );
        }
      }
    });
  });
}

export function validateOptimizerBenchmark(input: unknown): BenchmarkValidationResult {
  if (!isRecord(input)) return { ok: false, errors: ["benchmark must be an object"] };

  const errors: string[] = [];
  validateBase(input, errors);
  validatePassFailAuthorityPin(input, errors);
  if (input.kind === "formula") validateFormulaBenchmark(input, errors);
  else if (input.kind === "resource-output") {
    validateResourceBenchmark(input, errors);
    if (input.contractVersion === "phase1-pass-fail-v1") {
      validateStrictPassFailContract(input, errors);
    }
  }
  else errors.push("kind must be formula or resource-output");

  return errors.length === 0
    ? { ok: true, value: input as unknown as OptimizerBenchmark }
    : { ok: false, errors };
}

export function hasResolvedExecutableCompositionAuthority(benchmark: ResourceOutputBenchmark): boolean {
  const evidence = benchmark.compositionEvidence;
  if (evidence !== undefined && (
    evidence.status !== "comparable" ||
    evidence.sourceOnlyOperators.length > 0 ||
    evidence.conflicts.length > 0 ||
    evidence.disputedAssignments.length > 0
  )) {
    return false;
  }

  return benchmark.rotation.shifts.every((shift) =>
    Object.values(shift.assignments).every((assignment) =>
      (assignment.sourceOnlyOperatorIds?.length ?? 0) === 0 &&
      (assignment.remoteSupport?.unresolved?.length ?? 0) === 0
    )
  );
}

export function isPassFailEligible(benchmark: unknown): boolean {
  const validation = validateOptimizerBenchmark(benchmark);
  if (!validation.ok) return false;

  const validatedBenchmark = validation.value;
  if (
    validatedBenchmark.kind !== "resource-output" ||
    validatedBenchmark.contractVersion !== "phase1-pass-fail-v1" ||
    validatedBenchmark.confidence === "disputed"
  ) {
    return false;
  }

  return hasResolvedExecutableCompositionAuthority(validatedBenchmark);
}
