import artifactJson from "../data/phase1-project-assumption-bundle-v1.json";
import artifactJsonV2 from "../data/phase1-project-assumption-bundle-v2.json";

export const PHASE1_ASSUMPTION_IDS = [
  "phase1.high-value-order-probability.v1",
  "phase1.perception-information-factory-efficiency.v1",
  "phase1.signed-equivalent-morale-delta.v1"
] as const;

const PHASE1_DOMAINS = [
  "high-value-order-probability",
  "perception-information-factory-efficiency",
  "signed-equivalent-morale-delta"
] as const;
const PINNED_BUNDLE_ID = "arknights-basement.phase1-project-assumptions";
const PINNED_V1_VERSION = 1;
const PINNED_V1_CONTENT_SHA256 = "c3a66c4638d4e8e269089a441df49de4f90d1bd1a80c5482838755d74db1e2bd";
const PINNED_V2_VERSION = 2;
const PINNED_V2_CONTENT_SHA256 = "5aca766b23d7eabfbb924d460b878d07351c5377ec0007ee12194de7fe1565ba";

export type HighValueLevel = "slight" | "doubleSlight" | "increased";
type Provenance = {
  issue: string; pullRequest: string; commit: string; path: string; symbol: string; status: string;
};
type CommonAssumption = {
  id: string;
  domain: string;
  formulaIdentifier: string;
  units: Record<string, string>;
  inputs: string[];
  scope: Record<string, unknown>;
  provenance: Provenance[];
};

export type HighValueOrderAssumption = CommonAssumption & {
  id: typeof PHASE1_ASSUMPTION_IDS[0];
  domain: typeof PHASE1_DOMAINS[0];
  primary: {
    normalDistribution: [number, number, number];
    orderGold: [number, number, number];
    orderHours: [number, number, number];
    targetDistributions: Record<HighValueLevel, [number, number, number]>;
    warmupHours: Record<HighValueLevel, number>;
    averageProgress: string;
    lmdPerGold: number;
  };
  diagnosticOnlySensitivity: { shiftHours: number[]; authority: "diagnostic-only" };
};

export type PerceptionFactoryAssumption = CommonAssumption & {
  id: typeof PHASE1_ASSUMPTION_IDS[1];
  domain: typeof PHASE1_DOMAINS[1];
  primary: {
    operatorIds: [string, string, string];
    formula: string;
    allUnlockedSkills: {
      aroma: {
        operatorId: string;
        skillIds: [string, string];
        goldEfficiency: number;
        timeCurve: {
          initialEfficiency: number;
          efficiencyPerHour: number;
          maxEfficiency: number;
          startsAfterFirstHour: boolean;
          segmentHours: number;
        };
      };
      waaiFu: {
        operatorId: string;
        skillId: string;
        resultAffectingOtherOperatorScaling: {
          otherEfficiencyPerStep: number;
          efficiencyPerStep: number;
          maxEfficiency: number;
        };
      };
      rosmontis: {
        operatorId: string;
        resourceSkillId: string;
        efficiencySkillId: string;
        thoughtChainPerDormitoryOccupant: number;
        thoughtChainPerPerceptionInfo: number;
        efficiencyPerThoughtChain: number;
        scalingPerThoughtChain: number;
      };
    };
    activeShifts: Record<string, { elapsedWorkHours: number; dormitoryOccupancy: number; perceptionInfo: number }>;
    inactiveShiftIds: string[];
  };
  diagnosticOnlySensitivity: { fixedPerceptionInfoPoints: number[]; authority: "diagnostic-only" };
};

export type SignedMoraleAssumption = CommonAssumption & {
  id: typeof PHASE1_ASSUMPTION_IDS[2];
  domain: typeof PHASE1_DOMAINS[2];
  primary: {
    moraleCap: number;
    baseWorkConsumptionRatePerHour: number;
    ordinaryDormitoryRecoveryRatePerHour: number;
    workFormula: string;
    recoveryFormula: string;
    exchangeFormula: string;
  };
  diagnosticOnlySensitivity: { workConsumptionRatePerHour: number[]; authority: "diagnostic-only" };
};

export type Phase1AssumptionBundle = {
  id: string;
  version: number;
  contentSha256: string;
  allowedAssumptionIds: string[];
  contract: {
    canonicalization: string;
    hashExcludes: string[];
    hiddenCalibrationInputs: unknown[];
    fixtureConfidence: "corroborated";
    primaryAuthority: string;
    mutationPolicy: string;
  };
  assumptions: [HighValueOrderAssumption, PerceptionFactoryAssumption, SignedMoraleAssumption];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${path} must be an object`);
  return value;
}

function exactKeys(value: unknown, allowed: readonly string[], path: string): Record<string, unknown> {
  const object = record(value, path);
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) throw new TypeError(`${path} contains unknown key ${key}`);
  }
  for (const key of allowed) {
    if (!(key in object)) throw new TypeError(`${path} is missing key ${key}`);
  }
  return object;
}

function finite(value: unknown, path: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    throw new RangeError(`${path} must be a finite number >= ${minimum}`);
  }
  return value;
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TypeError(`${path} must be a string array`);
  }
  return value;
}

function exactStringArray(value: unknown, expected: readonly string[], path: string): string[] {
  const values = stringArray(value, path);
  if (values.length !== expected.length || values.some((item, index) => item !== expected[index])) {
    throw new RangeError(`${path} must equal ${expected.join(", ")} in order`);
  }
  return values;
}

function numberArray(value: unknown, path: string, length?: number): number[] {
  if (!Array.isArray(value) || (length !== undefined && value.length !== length)) {
    throw new TypeError(`${path} must be a number array${length === undefined ? "" : ` of length ${length}`}`);
  }
  return value.map((item, index) => finite(item, `${path}[${index}]`, Number.NEGATIVE_INFINITY));
}

function probabilityDistribution(value: unknown, path: string): number[] {
  const distribution = numberArray(value, path, 3);
  if (distribution.some((probability) => probability < 0 || probability > 1) ||
      Math.abs(distribution.reduce((sum, probability) => sum + probability, 0) - 1) > 1e-12) {
    throw new RangeError(`${path} must contain three probabilities that sum to 1`);
  }
  return distribution;
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** Dependency-free SHA-256 for the small, deterministic UTF-8 bundle payload. */
function sha256(input: string): string {
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const bytes = Array.from(new TextEncoder().encode(input));
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((high >>> shift) & 0xff);
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((low >>> shift) & 0xff);
  const words = new Array<number>(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const start = offset + index * 4;
      words[index] = ((bytes[start] << 24) | (bytes[start + 1] << 16) | (bytes[start + 2] << 8) | bytes[start + 3]) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotateRight(words[index - 15], 7) ^ rotateRight(words[index - 15], 18) ^ (words[index - 15] >>> 3);
      const s1 = rotateRight(words[index - 2], 17) ^ rotateRight(words[index - 2], 19) ^ (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choice + constants[index] + words[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0; hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0; hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0; hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0; hash[7] = (hash[7] + h) >>> 0;
  }
  return hash.map((word) => word.toString(16).padStart(8, "0")).join("");
}

export function calculateCanonicalSha256(value: unknown): string {
  return sha256(canonicalize(value));
}

export function calculatePhase1BundleContentSha256(bundle: unknown): string {
  const content = { ...record(bundle, "bundle") };
  delete content.contentSha256;
  return calculateCanonicalSha256(content);
}

function validateProvenance(value: unknown, path: string): void {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${path} must be a non-empty array`);
  value.forEach((item, index) => {
    const entry = exactKeys(item, ["issue", "pullRequest", "commit", "path", "symbol", "status"], `${path}[${index}]`);
    Object.entries(entry).forEach(([key, field]) => {
      if (typeof field !== "string" || field.length === 0) throw new TypeError(`${path}[${index}].${key} must be non-empty`);
    });
  });
}

function validateCommon(value: unknown, index: number): Record<string, unknown> {
  const path = `assumptions[${index}]`;
  const assumption = exactKeys(value, [
    "id", "domain", "formulaIdentifier", "units", "inputs", "scope", "provenance", "primary", "diagnosticOnlySensitivity"
  ], path);
  if (assumption.id !== PHASE1_ASSUMPTION_IDS[index]) throw new RangeError(`${path}.id is not an allowed assumption ID`);
  if (assumption.domain !== PHASE1_DOMAINS[index]) throw new RangeError(`${path}.domain is not allowed`);
  if (typeof assumption.formulaIdentifier !== "string" || !assumption.formulaIdentifier) throw new TypeError(`${path}.formulaIdentifier must be non-empty`);
  const units = record(assumption.units, `${path}.units`);
  if (Object.values(units).some((unit) => typeof unit !== "string" || !unit)) throw new TypeError(`${path}.units must contain strings`);
  stringArray(assumption.inputs, `${path}.inputs`);
  validateProvenance(assumption.provenance, `${path}.provenance`);
  return assumption;
}

function validateHighValue(assumption: Record<string, unknown>): void {
  const scope = exactKeys(assumption.scope, ["effectLevels", "excludes"], "assumptions[0].scope");
  exactStringArray(scope.effectLevels, ["slight", "doubleSlight", "increased"], "assumptions[0].scope.effectLevels");
  const primary = exactKeys(assumption.primary, [
    "normalDistribution", "orderGold", "orderHours", "targetDistributions", "warmupHours", "averageProgress", "lmdPerGold"
  ], "assumptions[0].primary");
  probabilityDistribution(primary.normalDistribution, "assumptions[0].primary.normalDistribution");
  numberArray(primary.orderGold, "assumptions[0].primary.orderGold", 3);
  numberArray(primary.orderHours, "assumptions[0].primary.orderHours", 3);
  const targets = exactKeys(primary.targetDistributions, ["slight", "doubleSlight", "increased"], "assumptions[0].primary.targetDistributions");
  Object.entries(targets).forEach(([key, value]) => probabilityDistribution(value, `assumptions[0].primary.targetDistributions.${key}`));
  const warmups = exactKeys(primary.warmupHours, ["slight", "doubleSlight", "increased"], "assumptions[0].primary.warmupHours");
  Object.entries(warmups).forEach(([key, value]) => finite(value, `assumptions[0].primary.warmupHours.${key}`));
  const sensitivity = exactKeys(assumption.diagnosticOnlySensitivity, ["shiftHours", "authority"], "assumptions[0].diagnosticOnlySensitivity");
  numberArray(sensitivity.shiftHours, "assumptions[0].diagnosticOnlySensitivity.shiftHours");
  if (sensitivity.authority !== "diagnostic-only") throw new RangeError("high-value sensitivity must be diagnostic-only");
}

function validatePerception(assumption: Record<string, unknown>, bundleVersion: number): void {
  const scope = exactKeys(assumption.scope, ["scheduleCycle", "productionGroupId", "inactiveShiftBehavior", "excludes"], "assumptions[1].scope");
  const expectedProductionGroupId = bundleVersion === 1 ? "B" : bundleVersion === 2 ? "C" : undefined;
  if (scope.productionGroupId !== expectedProductionGroupId) {
    throw new RangeError(`perception production group is not pinned for bundle version ${bundleVersion}`);
  }
  if (scope.inactiveShiftBehavior !== "fail-closed") {
    throw new RangeError("perception inactive shift behavior must be fail-closed");
  }
  const primary = exactKeys(assumption.primary, [
    "operatorIds", "formula", "allUnlockedSkills", "activeShifts", "inactiveShiftIds"
  ], "assumptions[1].primary");
  const operatorIds = stringArray(primary.operatorIds, "assumptions[1].primary.operatorIds");
  if (operatorIds.join("|") !== "char_446_aroma|char_243_waaifu|char_391_rosmon") {
    throw new RangeError("perception operator IDs are not pinned");
  }
  if (typeof primary.formula !== "string" || !primary.formula) throw new TypeError("perception formula must be non-empty");
  const skills = exactKeys(primary.allUnlockedSkills, ["aroma", "waaiFu", "rosmontis"], "assumptions[1].primary.allUnlockedSkills");
  const aroma = exactKeys(skills.aroma, ["operatorId", "skillIds", "goldEfficiency", "timeCurve"], "assumptions[1].primary.allUnlockedSkills.aroma");
  if (aroma.operatorId !== operatorIds[0]) throw new RangeError("Aroma operator ID does not match the group");
  const aromaSkillIds = stringArray(aroma.skillIds, "assumptions[1].primary.allUnlockedSkills.aroma.skillIds");
  if (aromaSkillIds.length !== 2) throw new RangeError("Aroma must pin exactly two all-unlocked skills");
  finite(aroma.goldEfficiency, "assumptions[1].primary.allUnlockedSkills.aroma.goldEfficiency");
  const timeCurve = exactKeys(aroma.timeCurve, [
    "initialEfficiency", "efficiencyPerHour", "maxEfficiency", "startsAfterFirstHour", "segmentHours"
  ], "assumptions[1].primary.allUnlockedSkills.aroma.timeCurve");
  finite(timeCurve.initialEfficiency, "aroma.timeCurve.initialEfficiency", Number.NEGATIVE_INFINITY);
  finite(timeCurve.efficiencyPerHour, "aroma.timeCurve.efficiencyPerHour", Number.NEGATIVE_INFINITY);
  finite(timeCurve.maxEfficiency, "aroma.timeCurve.maxEfficiency", Number.NEGATIVE_INFINITY);
  if (typeof timeCurve.startsAfterFirstHour !== "boolean") throw new TypeError("aroma.timeCurve.startsAfterFirstHour must be boolean");
  finite(timeCurve.segmentHours, "aroma.timeCurve.segmentHours", Number.MIN_VALUE);

  const waaiFu = exactKeys(skills.waaiFu, [
    "operatorId", "skillId", "resultAffectingOtherOperatorScaling"
  ], "assumptions[1].primary.allUnlockedSkills.waaiFu");
  if (waaiFu.operatorId !== operatorIds[1] || typeof waaiFu.skillId !== "string" || !waaiFu.skillId) {
    throw new RangeError("Waai Fu skill identity does not match the group");
  }
  const waaiFuScaling = exactKeys(waaiFu.resultAffectingOtherOperatorScaling, [
    "otherEfficiencyPerStep", "efficiencyPerStep", "maxEfficiency"
  ], "assumptions[1].primary.allUnlockedSkills.waaiFu.resultAffectingOtherOperatorScaling");
  Object.entries(waaiFuScaling).forEach(([key, value]) => finite(value, `waaiFu.resultAffectingOtherOperatorScaling.${key}`));

  const rosmontis = exactKeys(skills.rosmontis, [
    "operatorId", "resourceSkillId", "efficiencySkillId", "thoughtChainPerDormitoryOccupant",
    "thoughtChainPerPerceptionInfo", "efficiencyPerThoughtChain", "scalingPerThoughtChain"
  ], "assumptions[1].primary.allUnlockedSkills.rosmontis");
  if (rosmontis.operatorId !== operatorIds[2] || typeof rosmontis.resourceSkillId !== "string" ||
      typeof rosmontis.efficiencySkillId !== "string") {
    throw new RangeError("Rosmontis skill identity does not match the group");
  }
  ["thoughtChainPerDormitoryOccupant", "thoughtChainPerPerceptionInfo", "efficiencyPerThoughtChain"].forEach(
    (key) => finite(rosmontis[key], `rosmontis.${key}`)
  );
  finite(rosmontis.scalingPerThoughtChain, "rosmontis.scalingPerThoughtChain", Number.MIN_VALUE);

  const expectedActiveShiftIds = bundleVersion === 1
    ? ["groups-a-b", "groups-b-c"]
    : bundleVersion === 2
      ? ["groups-b-c", "groups-c-a"]
      : [];
  const activeShifts = exactKeys(primary.activeShifts, expectedActiveShiftIds, "assumptions[1].primary.activeShifts");
  Object.entries(activeShifts).forEach(([shiftId, value]) => {
    const shift = exactKeys(value, ["elapsedWorkHours", "dormitoryOccupancy", "perceptionInfo"], `assumptions[1].primary.activeShifts.${shiftId}`);
    finite(shift.elapsedWorkHours, `${shiftId}.elapsedWorkHours`, Number.MIN_VALUE);
    finite(shift.dormitoryOccupancy, `${shiftId}.dormitoryOccupancy`);
    finite(shift.perceptionInfo, `${shiftId}.perceptionInfo`);
  });
  const inactive = stringArray(primary.inactiveShiftIds, "assumptions[1].primary.inactiveShiftIds");
  const expectedInactiveShiftId = bundleVersion === 1 ? "groups-c-a" : "groups-a-b";
  if (inactive.length !== 1 || inactive[0] !== expectedInactiveShiftId) {
    throw new RangeError("perception inactive shift IDs are not pinned");
  }
  const expectedPerceptionInfo = bundleVersion === 1
    ? { "groups-a-b": 20, "groups-b-c": 10 }
    : { "groups-b-c": 20, "groups-c-a": 10 };
  Object.entries(expectedPerceptionInfo).forEach(([shiftId, perceptionInfo]) => {
    const shift = record(activeShifts[shiftId], `assumptions[1].primary.activeShifts.${shiftId}`);
    if (shift.perceptionInfo !== perceptionInfo) {
      throw new RangeError(`${shiftId}.perceptionInfo is not pinned for bundle version ${bundleVersion}`);
    }
  });
  const sensitivity = exactKeys(assumption.diagnosticOnlySensitivity, ["fixedPerceptionInfoPoints", "authority"], "assumptions[1].diagnosticOnlySensitivity");
  numberArray(sensitivity.fixedPerceptionInfoPoints, "assumptions[1].diagnosticOnlySensitivity.fixedPerceptionInfoPoints");
  if (sensitivity.authority !== "diagnostic-only") throw new RangeError("perception sensitivity must be diagnostic-only");
}

function validateMorale(assumption: Record<string, unknown>): void {
  const scope = exactKeys(assumption.scope, ["modes", "idleDelta", "idleDomainExpansion", "exchangeBoundary", "excludes"], "assumptions[2].scope");
  exactStringArray(scope.exchangeBoundary, [
    "source-morale-equals-modeled-cap", "swap-boundary-values", "optional-identities-distinct"
  ], "assumptions[2].scope.exchangeBoundary");
  const primary = exactKeys(assumption.primary, [
    "moraleCap", "baseWorkConsumptionRatePerHour", "ordinaryDormitoryRecoveryRatePerHour",
    "workFormula", "recoveryFormula", "exchangeFormula"
  ], "assumptions[2].primary");
  finite(primary.moraleCap, "assumptions[2].primary.moraleCap");
  finite(primary.baseWorkConsumptionRatePerHour, "assumptions[2].primary.baseWorkConsumptionRatePerHour");
  finite(primary.ordinaryDormitoryRecoveryRatePerHour, "assumptions[2].primary.ordinaryDormitoryRecoveryRatePerHour");
  const sensitivity = exactKeys(assumption.diagnosticOnlySensitivity, ["workConsumptionRatePerHour", "authority"], "assumptions[2].diagnosticOnlySensitivity");
  numberArray(sensitivity.workConsumptionRatePerHour, "assumptions[2].diagnosticOnlySensitivity.workConsumptionRatePerHour");
  if (sensitivity.authority !== "diagnostic-only") throw new RangeError("morale sensitivity must be diagnostic-only");
}

export function validatePhase1AssumptionBundle(value: unknown): Phase1AssumptionBundle {
  const bundle = exactKeys(value, ["id", "version", "contentSha256", "allowedAssumptionIds", "contract", "assumptions"], "bundle");
  if (typeof bundle.id !== "string" || bundle.id.length === 0) throw new TypeError("bundle.id must be non-empty");
  if (typeof bundle.version !== "number" || !Number.isInteger(bundle.version) || bundle.version < 1) throw new RangeError("bundle.version must be a positive integer");
  const allowedIds = stringArray(bundle.allowedAssumptionIds, "bundle.allowedAssumptionIds");
  if (allowedIds.length !== PHASE1_ASSUMPTION_IDS.length || allowedIds.some((id, index) => id !== PHASE1_ASSUMPTION_IDS[index])) {
    throw new RangeError("bundle.allowedAssumptionIds must equal the three pinned IDs in order");
  }
  const contract = exactKeys(bundle.contract, [
    "canonicalization", "hashExcludes", "hiddenCalibrationInputs", "fixtureConfidence", "primaryAuthority", "mutationPolicy"
  ], "bundle.contract");
  if (contract.canonicalization !== "recursive-object-keys-lexicographic-arrays-preserve-order-json-utf8") throw new RangeError("unsupported canonicalization contract");
  if (!Array.isArray(contract.hashExcludes) || contract.hashExcludes.length !== 1 || contract.hashExcludes[0] !== "contentSha256") throw new RangeError("hashExcludes must contain only contentSha256");
  if (!Array.isArray(contract.hiddenCalibrationInputs) || contract.hiddenCalibrationInputs.length !== 0) throw new RangeError("hidden calibration inputs are forbidden");
  if (contract.fixtureConfidence !== "corroborated") throw new RangeError("fixture confidence must be corroborated");
  if (contract.primaryAuthority !== "primary-only-diagnostic-sensitivity-never-mutates-pass-fail") throw new RangeError("primary authority contract is invalid");
  if (contract.mutationPolicy !== "content-change-requires-new-version-and-fixture-review") throw new RangeError("mutation policy contract is invalid");
  if (!Array.isArray(bundle.assumptions) || bundle.assumptions.length !== 3) throw new RangeError("bundle must contain exactly three assumptions");
  const assumptions = bundle.assumptions.map((item, index) => validateCommon(item, index));
  validateHighValue(assumptions[0]);
  validatePerception(assumptions[1], bundle.version as number);
  validateMorale(assumptions[2]);
  if (typeof bundle.contentSha256 !== "string" || !/^[0-9a-f]{64}$/.test(bundle.contentSha256)) throw new RangeError("bundle.contentSha256 must be 64 lowercase hex");
  const actualHash = calculatePhase1BundleContentSha256(bundle);
  if (bundle.contentSha256 !== actualHash) throw new RangeError(`bundle.contentSha256 mismatch: expected ${actualHash}`);
  return bundle as Phase1AssumptionBundle;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.values(value).forEach((nested) => deepFreeze(nested));
    Object.freeze(value);
  }
  return value;
}

export function loadPhase1AssumptionBundle(value: unknown = artifactJson): Phase1AssumptionBundle {
  const bundle = validatePhase1AssumptionBundle(value);
  if (bundle.id !== PINNED_BUNDLE_ID || bundle.version !== PINNED_V1_VERSION || bundle.contentSha256 !== PINNED_V1_CONTENT_SHA256) {
    throw new RangeError("bundle does not match the checked-in pinned v1 tuple; content changes require a new version and fixture review");
  }
  return deepFreeze(bundle);
}

export function loadPhase1AssumptionBundleV2(value: unknown = artifactJsonV2): Phase1AssumptionBundle {
  const bundle = validatePhase1AssumptionBundle(value);
  if (bundle.id !== PINNED_BUNDLE_ID || bundle.version !== PINNED_V2_VERSION || bundle.contentSha256 !== PINNED_V2_CONTENT_SHA256) {
    throw new RangeError("bundle does not match the checked-in pinned v2 tuple; content changes require a new version and fixture review");
  }
  return deepFreeze(bundle);
}

export function deriveHighValueOrders(
  assumption: HighValueOrderAssumption,
  input: { shiftHours: number; level: HighValueLevel; orderAcquisitionEfficiency: number }
) {
  exactKeys(input, ["shiftHours", "level", "orderAcquisitionEfficiency"], "highValueOrderInput");
  const shiftHours = finite(input.shiftHours, "shiftHours");
  const efficiency = finite(input.orderAcquisitionEfficiency, "orderAcquisitionEfficiency", -1);
  if (!(input.level in assumption.primary.targetDistributions)) throw new RangeError(`unknown high-value order level ${input.level}`);
  const warmup = assumption.primary.warmupHours[input.level];
  const averageProgress = shiftHours === 0 ? 0 : shiftHours >= warmup ? 1 - warmup / (2 * shiftHours) : shiftHours / (2 * warmup);
  const target = assumption.primary.targetDistributions[input.level];
  const distribution = assumption.primary.normalDistribution.map(
    (probability, index) => probability + (target[index] - probability) * averageProgress
  ) as [number, number, number];
  const expectedGoldPerOrder = distribution.reduce((sum, probability, index) => sum + probability * assumption.primary.orderGold[index], 0);
  const expectedOrderHours = distribution.reduce((sum, probability, index) => sum + probability * assumption.primary.orderHours[index], 0);
  const expectedOrders = expectedOrderHours === 0 ? 0 : shiftHours * (1 + efficiency) / expectedOrderHours;
  const goldConsumed = expectedOrders * expectedGoldPerOrder;
  return {
    averageProgress, distribution, expectedGoldPerOrder, expectedOrderHours, expectedOrders, goldConsumed,
    lmd: goldConsumed * assumption.primary.lmdPerGold
  };
}

function averagePinnedHourlyTimeCurve(
  curve: PerceptionFactoryAssumption["primary"]["allUnlockedSkills"]["aroma"]["timeCurve"],
  elapsedWorkHours: number
) {
  let weightedEfficiency = 0;
  let elapsed = 0;
  let segmentIndex = 0;
  while (elapsed < elapsedWorkHours) {
    const width = Math.min(curve.segmentHours, elapsedWorkHours - elapsed);
    const incrementCount = curve.startsAfterFirstHour ? segmentIndex : segmentIndex + 1;
    const segmentEfficiency = Math.min(
      curve.initialEfficiency + curve.efficiencyPerHour * incrementCount,
      curve.maxEfficiency
    );
    weightedEfficiency += segmentEfficiency * width;
    elapsed += width;
    segmentIndex += 1;
  }
  return weightedEfficiency / elapsedWorkHours;
}

export function derivePerceptionFactoryEfficiency(assumption: PerceptionFactoryAssumption, shiftId: string) {
  if (typeof shiftId !== "string" || !shiftId) throw new TypeError("shiftId must be non-empty");
  if (assumption.primary.inactiveShiftIds.includes(shiftId)) throw new RangeError(`Perception Information production group is not active in ${shiftId}`);
  const shift = assumption.primary.activeShifts[shiftId];
  if (!shift) throw new RangeError(`unknown shift ${shiftId}`);
  const { aroma, waaiFu, rosmontis } = assumption.primary.allUnlockedSkills;
  const thoughtChain =
    shift.dormitoryOccupancy * rosmontis.thoughtChainPerDormitoryOccupant +
    shift.perceptionInfo * rosmontis.thoughtChainPerPerceptionInfo;
  const aromaTimeCurve = averagePinnedHourlyTimeCurve(aroma.timeCurve, shift.elapsedWorkHours);
  const aromaEfficiency = aroma.goldEfficiency + aromaTimeCurve;
  const rosmontisEfficiency =
    Math.floor(thoughtChain / rosmontis.scalingPerThoughtChain) * rosmontis.efficiencyPerThoughtChain;
  const otherResultAffectingEfficiency = aromaEfficiency + rosmontisEfficiency;
  const waaiFuScaling = waaiFu.resultAffectingOtherOperatorScaling;
  const waaiFuSteps = Math.floor(otherResultAffectingEfficiency / waaiFuScaling.otherEfficiencyPerStep);
  const waaiFuEfficiency = Math.min(
    waaiFuSteps * waaiFuScaling.efficiencyPerStep,
    waaiFuScaling.maxEfficiency
  );
  const groupEfficiency = aromaEfficiency + waaiFuEfficiency + rosmontisEfficiency;
  return {
    shiftId,
    operatorIds: [...assumption.primary.operatorIds],
    elapsedWorkHours: shift.elapsedWorkHours,
    dormitoryOccupancy: shift.dormitoryOccupancy,
    perceptionInfo: shift.perceptionInfo,
    thoughtChain,
    componentEfficiencies: {
      aromaGold: aroma.goldEfficiency,
      aromaTimeCurve,
      aroma: aromaEfficiency,
      waaiFu: waaiFuEfficiency,
      rosmontis: rosmontisEfficiency
    },
    groupEfficiency
  };
}

type WorkMoraleInput = { mode: "work"; startMorale: number; durationHours: number; consumptionRatePerHour?: number };
type RecoveryMoraleInput = {
  mode: "ordinary-recovery"; startMorale: number; durationHours: number; recoveryRatePerHour?: number;
  conditionalModifiers?: Array<{ moraleAtMost: number; additionalRatePerHour: number }>;
};
type ExchangeMoraleInput = {
  mode: "exchange-support"; sourceMoraleBefore: number; targetMoraleBefore: number;
  sourceOperatorId?: string; targetOperatorId?: string;
};

export function deriveSignedMoraleDelta(
  assumption: SignedMoraleAssumption,
  input: WorkMoraleInput | RecoveryMoraleInput | ExchangeMoraleInput
) {
  if (!isRecord(input)) throw new TypeError("morale input must be an object");
  const cap = assumption.primary.moraleCap;
  if (input.mode === "work") {
    exactKeys(input, ["mode", "startMorale", "durationHours", ...(input.consumptionRatePerHour === undefined ? [] : ["consumptionRatePerHour"])], "workMoraleInput");
    const start = finite(input.startMorale, "startMorale");
    if (start > cap) throw new RangeError(`startMorale must not exceed ${cap}`);
    const duration = finite(input.durationHours, "durationHours");
    const rate = finite(input.consumptionRatePerHour ?? assumption.primary.baseWorkConsumptionRatePerHour, "consumptionRatePerHour");
    const endMorale = Math.max(0, start - rate * duration);
    return { mode: input.mode, startMorale: start, endMorale, signedDelta: endMorale - start };
  }
  if (input.mode === "ordinary-recovery") {
    exactKeys(input, [
      "mode", "startMorale", "durationHours",
      ...(input.recoveryRatePerHour === undefined ? [] : ["recoveryRatePerHour"]),
      ...(input.conditionalModifiers === undefined ? [] : ["conditionalModifiers"])
    ], "recoveryMoraleInput");
    const start = finite(input.startMorale, "startMorale");
    if (start > cap) throw new RangeError(`startMorale must not exceed ${cap}`);
    let remaining = finite(input.durationHours, "durationHours");
    const baseRate = finite(input.recoveryRatePerHour ?? assumption.primary.ordinaryDormitoryRecoveryRatePerHour, "recoveryRatePerHour");
    const modifiers = input.conditionalModifiers ?? [];
    modifiers.forEach((modifier, index) => {
      exactKeys(modifier, ["moraleAtMost", "additionalRatePerHour"], `conditionalModifiers[${index}]`);
      finite(modifier.moraleAtMost, `conditionalModifiers[${index}].moraleAtMost`);
      finite(modifier.additionalRatePerHour, `conditionalModifiers[${index}].additionalRatePerHour`);
    });
    let morale = start;
    while (remaining > 1e-12 && morale < cap - 1e-12) {
      const active = modifiers.filter((modifier) => morale < modifier.moraleAtMost - 1e-12);
      const rate = baseRate + active.reduce((sum, modifier) => sum + modifier.additionalRatePerHour, 0);
      if (rate <= 0) break;
      const nextThreshold = active.map((modifier) => modifier.moraleAtMost).filter((threshold) => threshold > morale + 1e-12).sort((a, b) => a - b)[0];
      const boundary = Math.min(cap, nextThreshold ?? cap);
      const duration = Math.min(remaining, (boundary - morale) / rate);
      morale = Math.min(cap, morale + rate * duration);
      remaining -= duration;
    }
    return { mode: input.mode, startMorale: start, endMorale: morale, signedDelta: morale - start };
  }
  if (input.mode === "exchange-support") {
    exactKeys(input, [
      "mode", "sourceMoraleBefore", "targetMoraleBefore",
      ...(input.sourceOperatorId === undefined ? [] : ["sourceOperatorId"]),
      ...(input.targetOperatorId === undefined ? [] : ["targetOperatorId"])
    ], "exchangeMoraleInput");
    const source = finite(input.sourceMoraleBefore, "sourceMoraleBefore");
    const target = finite(input.targetMoraleBefore, "targetMoraleBefore");
    if (source > cap || target > cap) throw new RangeError(`exchange morale must not exceed ${cap}`);
    if (source !== cap) throw new RangeError("exchange source must be at full morale");
    if ((input.sourceOperatorId === undefined) !== (input.targetOperatorId === undefined)) {
      throw new TypeError("exchange operator identities must be supplied together");
    }
    if (input.sourceOperatorId !== undefined && input.targetOperatorId !== undefined) {
      if (!input.sourceOperatorId || !input.targetOperatorId) throw new TypeError("exchange operator identities must be non-empty");
      if (input.sourceOperatorId === input.targetOperatorId) throw new RangeError("exchange source and target must be distinct");
    }
    return {
      mode: input.mode,
      sourceEndMorale: target,
      targetEndMorale: source,
      sourceSignedDelta: target - source,
      targetSignedDelta: source - target,
      totalSignedDelta: 0
    };
  }
  throw new RangeError(`unknown morale mode ${String((input as { mode?: unknown }).mode)}`);
}
