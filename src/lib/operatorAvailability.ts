import type { AppRegion, Operator, Roster } from "../types";
import availabilityData from "../data/operator-availability-v1.json";

export type OperatorAvailabilityRegion = AppRegion;

export interface OperatorAvailabilitySource {
  url: string;
  commit: string;
  observedAt: string;
}

export interface OperatorAvailabilitySnapshot {
  schemaVersion: 1;
  regions: Record<
    OperatorAvailabilityRegion,
    {
      source: OperatorAvailabilitySource;
      operatorIds: string[];
    }
  >;
}

export type OperatorAvailabilityValidationResult =
  | { ok: true; value: OperatorAvailabilitySnapshot }
  | { ok: false; errors: string[] };

const supportedRegions = ["JP", "CN"] as const;
const operatorIdPattern = /^char_\d+_[a-z0-9]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    return false;
  }
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.valueOf())) return false;
  const canonicalValue = value.endsWith(".000Z") ? value : value.replace(/Z$/, ".000Z");
  return timestamp.toISOString() === canonicalValue;
}

export function validateOperatorAvailabilitySnapshot(input: unknown): OperatorAvailabilityValidationResult {
  if (!isRecord(input)) return { ok: false, errors: ["availability snapshot must be an object"] };

  const errors: string[] = [];
  if (input.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (!isRecord(input.regions)) {
    return { ok: false, errors: [...errors, "regions must be an object"] };
  }

  const regionNames = Object.keys(input.regions);
  for (const region of regionNames) {
    if (!supportedRegions.includes(region as OperatorAvailabilityRegion)) {
      errors.push(`regions contains unknown region ${region}`);
    }
  }

  for (const region of supportedRegions) {
    const entry = input.regions[region];
    if (!isRecord(entry)) {
      errors.push(`regions.${region} must be an object`);
      continue;
    }

    if (!isRecord(entry.source)) {
      errors.push(`regions.${region}.source must be an object`);
    } else {
      if (!isHttpUrl(entry.source.url)) errors.push(`regions.${region}.source.url must be an HTTP(S) URL`);
      if (!isNonEmptyString(entry.source.commit) || !/^[0-9a-f]{40}$/i.test(entry.source.commit)) {
        errors.push(`regions.${region}.source.commit must be a full Git commit SHA`);
      }
      if (!isIsoTimestamp(entry.source.observedAt)) {
        errors.push(`regions.${region}.source.observedAt must be an ISO UTC timestamp`);
      }
    }

    if (!Array.isArray(entry.operatorIds)) {
      errors.push(`regions.${region}.operatorIds must be an array`);
      continue;
    }

    const seen = new Set<string>();
    let previousOperatorId: string | undefined;
    for (const operatorId of entry.operatorIds) {
      if (!isNonEmptyString(operatorId)) {
        errors.push(`regions.${region}.operatorIds must contain only non-empty strings`);
        continue;
      }
      if (!operatorIdPattern.test(operatorId)) {
        errors.push(`regions.${region}.operatorIds contains malformed operator ID ${operatorId}`);
      }
      if (seen.has(operatorId)) errors.push(`regions.${region}.operatorIds contains duplicate operator ID ${operatorId}`);
      seen.add(operatorId);
      if (previousOperatorId !== undefined && operatorId <= previousOperatorId) {
        errors.push(`regions.${region}.operatorIds must be in strict ascending order`);
      }
      previousOperatorId = operatorId;
    }
  }

  return errors.length === 0
    ? { ok: true, value: input as unknown as OperatorAvailabilitySnapshot }
    : { ok: false, errors };
}

const checkedInSnapshot = validateOperatorAvailabilitySnapshot(availabilityData);

if (!checkedInSnapshot.ok) {
  throw new Error(`Invalid checked-in operator availability snapshot:\n${checkedInSnapshot.errors.join("\n")}`);
}

export const operatorAvailabilitySnapshot = checkedInSnapshot.value;

export function isOperatorAvailable(
  snapshot: OperatorAvailabilitySnapshot,
  region: OperatorAvailabilityRegion,
  operatorId: string
): boolean {
  return snapshot.regions[region].operatorIds.includes(operatorId);
}

export function availableOperatorIds(
  snapshot: OperatorAvailabilitySnapshot,
  region: OperatorAvailabilityRegion
): string[] {
  return [...snapshot.regions[region].operatorIds];
}

export function availableOperators<T extends Pick<Operator, "id">>(
  snapshot: OperatorAvailabilitySnapshot,
  region: OperatorAvailabilityRegion,
  operators: readonly T[]
): T[] {
  const availableIds = new Set(snapshot.regions[region].operatorIds);
  return operators.filter((operator) => availableIds.has(operator.id));
}

export function createRegionallyAvailableRoster(
  roster: Roster,
  snapshot: OperatorAvailabilitySnapshot,
  region: OperatorAvailabilityRegion
): Roster {
  const availableIds = new Set(snapshot.regions[region].operatorIds);
  return Object.fromEntries(
    Object.entries(roster).map(([operatorId, entry]) => [
      operatorId,
      { ...entry, owned: entry.owned && availableIds.has(operatorId) }
    ])
  );
}

export function createRegionallyAvailableState<T extends { roster: Roster }>(
  state: T,
  snapshot: OperatorAvailabilitySnapshot,
  region: OperatorAvailabilityRegion
): T {
  return {
    ...state,
    roster: createRegionallyAvailableRoster(state.roster, snapshot, region)
  };
}

// Backward-compatible names for the Issue #30 benchmark snapshot tests.
export const createRegionalBenchmarkRoster = createRegionallyAvailableRoster;
export const createRegionalBenchmarkStateView = createRegionallyAvailableState;
