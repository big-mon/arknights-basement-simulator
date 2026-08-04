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

function normalizeContribution(input: ResourceContributionInput | undefined, path: string): ResourceContribution {
  return Object.fromEntries(
    contributionFields.map((field) => [field, validateFlow(input?.[field] ?? 0, `${path}.${field}`)])
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
    const natural = normalizeContribution(ledger.natural, `ledgers[${index}].natural`);
    const drone = normalizeContribution(ledger.drone, `ledgers[${index}].drone`);
    for (const field of contributionFields) {
      total.natural[field] += natural[field];
      total.drone[field] += drone[field];
    }
    total.dronesGenerated += validateFlow(ledger.dronesGenerated, `ledgers[${index}].dronesGenerated`);
    total.dronesUsed += validateFlow(ledger.dronesUsed, `ledgers[${index}].dronesUsed`);
  }

  return createResourceLedger(total);
}
