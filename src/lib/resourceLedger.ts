export interface ResourceContribution {
  goldProduced: number;
  goldConsumed: number;
  battleRecordExp: number;
  lmd: number;
}

export type ResourceContributionInput = Partial<ResourceContribution>;

export interface ResourceLedgerInput {
  natural?: ResourceContributionInput;
  drone?: ResourceContributionInput;
  /** Whole drone recovery completed during the period, before inventory-cap overflow. */
  dronesGenerated?: number;
  dronesUsed?: number;
}

export interface ResourceLedger extends ResourceContribution {
  goldNetChange: number;
  natural: Readonly<ResourceContribution>;
  drone: Readonly<ResourceContribution>;
  /** Whole drone recovery completed during the period, before inventory-cap overflow. */
  dronesGenerated: number;
  dronesUsed: number;
}

const contributionFields = ["goldProduced", "goldConsumed", "battleRecordExp", "lmd"] as const;

function validateFlow(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${path} must be a finite non-negative number`);
  }
  return value;
}

function validateSignedFinite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RangeError(`${path} must be a finite number`);
  }
  return value;
}

function isNonArrayObject(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireOwn(input: Record<PropertyKey, unknown>, field: string, path: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(input, field)) {
    throw new RangeError(`${path}.${field} is required`);
  }
  return input[field];
}

function normalizeContribution(input: ResourceContributionInput | undefined, path: string): ResourceContribution {
  if (input !== undefined && !isNonArrayObject(input)) {
    throw new RangeError(`${path} must be a non-null, non-array object`);
  }
  return Object.fromEntries(
    contributionFields.map((field) => [field, validateFlow(input?.[field] ?? 0, `${path}.${field}`)])
  ) as unknown as ResourceContribution;
}

function validateCompleteContribution(input: unknown, path: string): ResourceContribution {
  if (!isNonArrayObject(input)) {
    throw new RangeError(`${path} must be a non-null, non-array object`);
  }
  return Object.fromEntries(
    contributionFields.map((field) => [field, validateFlow(requireOwn(input, field, path), `${path}.${field}`)])
  ) as unknown as ResourceContribution;
}

export function createResourceLedger(input: ResourceLedgerInput = {}): ResourceLedger {
  const natural = Object.freeze(normalizeContribution(input.natural, "natural"));
  const drone = Object.freeze(normalizeContribution(input.drone, "drone"));
  const dronesGenerated = validateFlow(input.dronesGenerated ?? 0, "dronesGenerated");
  const dronesUsed = validateFlow(input.dronesUsed ?? 0, "dronesUsed");
  const goldProduced = natural.goldProduced + drone.goldProduced;
  const goldConsumed = natural.goldConsumed + drone.goldConsumed;
  const battleRecordExp = natural.battleRecordExp + drone.battleRecordExp;
  const lmd = natural.lmd + drone.lmd;

  for (const [field, value] of Object.entries({ goldProduced, goldConsumed, battleRecordExp, lmd })) {
    validateFlow(value, field);
  }

  return Object.freeze({
    natural,
    drone,
    goldProduced,
    goldConsumed,
    goldNetChange: goldProduced - goldConsumed,
    battleRecordExp,
    lmd,
    dronesGenerated,
    dronesUsed
  });
}

export function validateResourceLedger(input: unknown, path = "resourceLedger"): ResourceLedger {
  if (!isNonArrayObject(input)) {
    throw new RangeError(`${path} must be a non-null, non-array object`);
  }

  const natural = validateCompleteContribution(requireOwn(input, "natural", path), `${path}.natural`);
  const drone = validateCompleteContribution(requireOwn(input, "drone", path), `${path}.drone`);
  const dronesGenerated = validateFlow(requireOwn(input, "dronesGenerated", path), `${path}.dronesGenerated`);
  const dronesUsed = validateFlow(requireOwn(input, "dronesUsed", path), `${path}.dronesUsed`);
  const canonical = createResourceLedger({ natural, drone, dronesGenerated, dronesUsed });

  const aggregateFields = ["goldProduced", "goldConsumed", "battleRecordExp", "lmd"] as const;
  for (const field of aggregateFields) {
    const value = validateFlow(requireOwn(input, field, path), `${path}.${field}`);
    if (value !== canonical[field]) {
      throw new RangeError(`${path}.${field} is inconsistent with its immutable contributions`);
    }
  }

  const goldNetChange = validateSignedFinite(requireOwn(input, "goldNetChange", path), `${path}.goldNetChange`);
  if (goldNetChange !== canonical.goldNetChange) {
    throw new RangeError(`${path}.goldNetChange is inconsistent with its immutable contributions`);
  }

  return canonical;
}

export function aggregateResourceLedgers(ledgers: readonly ResourceLedger[]): ResourceLedger {
  const total: {
    natural: ResourceContribution;
    drone: ResourceContribution;
    dronesGenerated: number;
    dronesUsed: number;
  } = {
    natural: { goldProduced: 0, goldConsumed: 0, battleRecordExp: 0, lmd: 0 },
    drone: { goldProduced: 0, goldConsumed: 0, battleRecordExp: 0, lmd: 0 },
    dronesGenerated: 0,
    dronesUsed: 0
  };

  for (const [index, ledger] of ledgers.entries()) {
    const validated = validateResourceLedger(ledger, `ledgers[${index}]`);
    for (const field of contributionFields) {
      total.natural[field] += validated.natural[field];
      total.drone[field] += validated.drone[field];
    }
    total.dronesGenerated += validated.dronesGenerated;
    total.dronesUsed += validated.dronesUsed;
  }

  return createResourceLedger(total);
}

export function scaleResourceLedger(ledger: ResourceLedger, factor: number): ResourceLedger {
  const validatedFactor = validateFlow(factor, "factor");
  const validated = validateResourceLedger(ledger, "ledger");

  return createResourceLedger({
    natural: Object.fromEntries(
      contributionFields.map((field) => [field, validated.natural[field] * validatedFactor])
    ),
    drone: Object.fromEntries(
      contributionFields.map((field) => [field, validated.drone[field] * validatedFactor])
    ),
    dronesGenerated: validated.dronesGenerated * validatedFactor,
    dronesUsed: validated.dronesUsed * validatedFactor
  });
}
