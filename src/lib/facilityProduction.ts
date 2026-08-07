import baseMechanics from "../data/optimizer-benchmarks/base-mechanics-2026-07.json";
import { createResourceLedger, type ResourceLedger } from "./resourceLedger";

export type FactoryProductionProduct = "gold" | "battleRecord";
export type ProductionEffectTarget = "all" | FactoryProductionProduct | "normalOrder";

export interface ProductionEfficiencyEffect {
  id: string;
  source: "operator" | "remote";
  additiveEfficiency: number;
  target: ProductionEffectTarget;
}

export interface ProductionEfficiencyEvent {
  atHour: number;
  label?: string;
  /** Replaces the preceding event's effects from this boundary onward. */
  effects: readonly ProductionEfficiencyEffect[];
}

export interface ProductionStorageInput {
  initialUnits: number;
  capacityUnits: number;
}

export interface ProductionDisplayInput {
  decimalPlaces: number;
}

interface CommonProductionInput {
  durationHours: number;
  teamEffects?: readonly ProductionEfficiencyEffect[];
  remoteEffects?: readonly ProductionEfficiencyEffect[];
  efficiencyEvents?: readonly ProductionEfficiencyEvent[];
  storage?: ProductionStorageInput;
  display?: ProductionDisplayInput;
}

export interface FactoryProductionInput extends CommonProductionInput {
  facility: { kind: "factory"; level: 3; product: FactoryProductionProduct };
}

export interface TradingPostProductionInput extends CommonProductionInput {
  facility: { kind: "tradingPost"; level: 3; orderType: "normalLmd" };
}

export type FacilityProductionInput = FactoryProductionInput | TradingPostProductionInput;

export interface ProductionSegment {
  startHour: number;
  endHour: number;
  eventLabel?: string;
  additiveEfficiency: number;
  efficiencyMultiplier: number;
  potentialUnits: number;
  producedUnits: number;
  blockedTimeHours: number;
}

interface CommonProductionResult {
  durationHours: number;
  efficiency: {
    staticAdditiveEfficiency: number;
    teamAdditiveEfficiency: number;
    remoteAdditiveEfficiency: number;
  };
  production: {
    /** Deterministic continuous expectation; never rounded to whole items/orders. */
    potentialUnits: number;
    producedUnits: number;
  };
  storage: {
    initialUnits: number;
    capacityUnits: number | null;
    remainingCapacityUnits: number | null;
    blockedTimeHours: number;
  };
  display?: {
    decimalPlaces: number;
    producedUnits: number;
  };
  segments: readonly ProductionSegment[];
  ledger: ResourceLedger;
}

export interface FactoryProductionResult extends CommonProductionResult {
  facility: FactoryProductionInput["facility"];
  base:
    | { minutesPerUnit: number; unitsPerHour: number }
    | { minutesPerUnit: number; unitsPerHour: number; expPerUnit: number };
  orderDistribution?: never;
}

export interface TradingPostProductionResult extends CommonProductionResult {
  facility: TradingPostProductionInput["facility"];
  base: { minutesPerOrder: number; ordersPerHour: number };
  orderDistribution: {
    outcomes: ReadonlyArray<{ gold: number; lmd: number; minutes: number; probability: number }>;
    expectedGoldPerOrder: number;
    expectedLmdPerOrder: number;
  };
}

export type FacilityProductionResult = FactoryProductionResult | TradingPostProductionResult;

function documentedMechanic(id: string): number {
  const value = baseMechanics.formulas.find((formula) => formula.id === id)?.expectedValue;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`base-mechanics-2026-07 is missing the finite ${id} constant`);
  }
  return value;
}

const factoryMechanics = Object.freeze({
  gold: Object.freeze({ minutesPerUnit: documentedMechanic("gold-time") }),
  battleRecord: Object.freeze({
    minutesPerUnit: documentedMechanic("battle-record-time"),
    expPerUnit: documentedMechanic("battle-record-exp")
  })
});

const normalOrderOutcomes = Object.freeze([
  Object.freeze({ gold: 2, lmd: 1000, minutes: 144, probability: documentedMechanic("order-two-probability") }),
  Object.freeze({ gold: 3, lmd: 1500, minutes: 210, probability: documentedMechanic("order-three-probability") }),
  Object.freeze({ gold: 4, lmd: 2000, minutes: 276, probability: documentedMechanic("order-four-probability") })
]);

const normalOrderMechanics = Object.freeze({
  minutesPerOrder: documentedMechanic("expected-order-time"),
  expectedGoldPerOrder: documentedMechanic("expected-order-gold"),
  expectedLmdPerOrder: documentedMechanic("expected-order-lmd")
});

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RangeError(`${path} must be a finite number`);
  }
  return value;
}

function nonNegativeNumber(value: unknown, path: string): number {
  const validated = finiteNumber(value, path);
  if (validated < 0) throw new RangeError(`${path} must be non-negative`);
  return validated;
}

function nonArrayObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RangeError(`${path} must be a non-null object`);
  }
  return value as Record<string, unknown>;
}

function optionalArray(value: unknown, path: string): readonly unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new RangeError(`${path} must be an array`);
  return value;
}

function validateEffects(
  effects: unknown,
  path: string,
  activeEffectPaths: Map<string, string>,
  requiredSource?: ProductionEfficiencyEffect["source"]
): void {
  if (!Array.isArray(effects)) throw new RangeError(`${path} must be an array`);
  effects.forEach((effect, index) => {
    const effectPath = `${path}[${index}]`;
    const effectRecord = nonArrayObject(effect, effectPath);
    if (typeof effectRecord.id !== "string" || effectRecord.id.length === 0) {
      throw new RangeError(`${effectPath}.id must be non-empty`);
    }
    if (requiredSource && effectRecord.source !== requiredSource) {
      throw new RangeError(`${effectPath}.source must be "${requiredSource}"`);
    }
    if (effectRecord.source !== "operator" && effectRecord.source !== "remote") {
      throw new RangeError(`${effectPath}.source must be "operator" or "remote"`);
    }
    const existingPath = activeEffectPaths.get(effectRecord.id);
    if (existingPath) {
      throw new RangeError(`duplicate effect ID "${effectRecord.id}" at ${effectPath}; already active at ${existingPath}`);
    }
    activeEffectPaths.set(effectRecord.id, effectPath);
    finiteNumber(effectRecord.additiveEfficiency, `${effectPath}.additiveEfficiency`);
    if (!(["all", "gold", "battleRecord", "normalOrder"] as readonly unknown[]).includes(effectRecord.target)) {
      throw new RangeError(`${effectPath}.target is unsupported`);
    }
  });
}

function effectMatches(effect: ProductionEfficiencyEffect, input: FacilityProductionInput): boolean {
  if (effect.target === "all") return true;
  return input.facility.kind === "factory"
    ? effect.target === input.facility.product
    : effect.target === "normalOrder";
}

function matchingEfficiency(
  effects: readonly ProductionEfficiencyEffect[],
  input: FacilityProductionInput,
  path: string
): number {
  const values = effects
    .filter((effect) => effectMatches(effect, input))
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    .map((effect) => effect.additiveEfficiency);
  return compensatedFiniteSum(values, path);
}

function compensatedFiniteSum(values: readonly number[], path: string): number {
  let sum = 0;
  let correction = 0;
  for (const value of values) {
    const next = finiteNumber(sum + value, path);
    correction = finiteNumber(
      correction + (Math.abs(sum) >= Math.abs(value) ? sum - next + value : value - next + sum),
      path
    );
    sum = next;
  }
  const result = finiteNumber(sum + correction, path);
  return Object.is(result, -0) ? 0 : result;
}

function validateInput(inputValue: unknown): asserts inputValue is FacilityProductionInput {
  const input = nonArrayObject(inputValue, "input");
  const facility = nonArrayObject(input.facility, "facility");
  if (facility.kind !== "factory" && facility.kind !== "tradingPost") {
    throw new RangeError("facility.kind is unsupported");
  }
  if (facility.level !== 3) throw new RangeError("facility.level must be 3");
  if (facility.kind === "factory" && facility.product !== "gold" && facility.product !== "battleRecord") {
    throw new RangeError("facility.product is unsupported");
  }
  if (facility.kind === "tradingPost" && facility.orderType !== "normalLmd") {
    throw new RangeError("facility.orderType is unsupported");
  }

  const durationHours = finiteNumber(input.durationHours, "durationHours");
  if (durationHours <= 0) throw new RangeError("durationHours must be positive");

  const teamEffects = optionalArray(input.teamEffects, "teamEffects");
  const remoteEffects = optionalArray(input.remoteEffects, "remoteEffects");
  const staticEffectPaths = new Map<string, string>();
  validateEffects(teamEffects, "teamEffects", staticEffectPaths, "operator");
  validateEffects(remoteEffects, "remoteEffects", staticEffectPaths, "remote");

  const events = optionalArray(input.efficiencyEvents, "efficiencyEvents");
  let previousBoundary = 0;
  events.forEach((event, index) => {
    const eventPath = `efficiencyEvents[${index}]`;
    const eventRecord = nonArrayObject(event, eventPath);
    const boundary = finiteNumber(eventRecord.atHour, `${eventPath}.atHour`);
    if (boundary <= 0 || boundary >= durationHours) {
      throw new RangeError(`efficiency event boundary ${boundary} must be within (0, durationHours)`);
    }
    if (boundary <= previousBoundary) {
      throw new RangeError("efficiency event boundaries must be strictly sorted");
    }
    previousBoundary = boundary;
    if (eventRecord.label !== undefined && typeof eventRecord.label !== "string") {
      throw new RangeError(`${eventPath}.label must be a string`);
    }
    validateEffects(
      eventRecord.effects,
      `${eventPath}.effects`,
      new Map(staticEffectPaths)
    );
  });

  if (input.storage !== undefined) {
    const storage = nonArrayObject(input.storage, "storage");
    const initial = nonNegativeNumber(storage.initialUnits, "storage.initialUnits");
    const capacity = nonNegativeNumber(storage.capacityUnits, "storage.capacityUnits");
    if (initial > capacity) throw new RangeError("storage.initialUnits must not exceed storage.capacityUnits");
  }

  if (input.display !== undefined) {
    const display = nonArrayObject(input.display, "display");
    const places = finiteNumber(display.decimalPlaces, "display.decimalPlaces");
    if (!Number.isInteger(places) || places < 0 || places > 12) {
      throw new RangeError("display.decimalPlaces must be an integer from 0 through 12");
    }
  }
}

function roundForDisplay(value: number, decimalPlaces: number): number {
  const finiteValue = finiteNumber(value, "display.producedUnits");
  const factor = 10 ** decimalPlaces;
  const requestedResolution = 1 / factor;
  if (finiteValue !== 0 && requestedResolution < Math.abs(finiteValue) * Number.EPSILON) {
    return finiteValue;
  }
  const scaled = (finiteValue + Number.EPSILON) * factor;
  if (!Number.isFinite(scaled)) return finiteValue;
  return finiteNumber(Math.round(scaled) / factor, "display.producedUnits");
}

function freezeSegments(segments: ProductionSegment[]): readonly ProductionSegment[] {
  return Object.freeze(segments.map((segment) => Object.freeze(segment)));
}

export function simulateFacilityProduction(input: FactoryProductionInput): FactoryProductionResult;
export function simulateFacilityProduction(input: TradingPostProductionInput): TradingPostProductionResult;
export function simulateFacilityProduction(input: FacilityProductionInput): FacilityProductionResult;
export function simulateFacilityProduction(input: FacilityProductionInput): FacilityProductionResult {
  validateInput(input);

  const teamEffects = input.teamEffects ?? [];
  const remoteEffects = input.remoteEffects ?? [];
  const teamAdditiveEfficiency = matchingEfficiency(teamEffects, input, "teamAdditiveEfficiency");
  const remoteAdditiveEfficiency = matchingEfficiency(remoteEffects, input, "remoteAdditiveEfficiency");
  const staticEffects = [...teamEffects, ...remoteEffects];
  const staticAdditiveEfficiency = matchingEfficiency(staticEffects, input, "staticAdditiveEfficiency");
  const unitsPerHour = finiteNumber(input.facility.kind === "factory"
    ? 60 / factoryMechanics[input.facility.product].minutesPerUnit
    : 60 / normalOrderMechanics.minutesPerOrder, "baseRate");
  const events = input.efficiencyEvents ?? [];
  const boundaries = [0, ...events.map((event) => event.atHour), input.durationHours];
  let remainingCapacity = input.storage
    ? finiteNumber(input.storage.capacityUnits - input.storage.initialUnits, "remainingCapacity")
    : Number.POSITIVE_INFINITY;
  const segments: ProductionSegment[] = [];

  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const startHour = boundaries[index];
    const endHour = boundaries[index + 1];
    const event = index === 0 ? undefined : events[index - 1];
    const eventEfficiency = matchingEfficiency(
      event?.effects ?? [],
      input,
      `eventAdditiveEfficiency at segment starting ${startHour}`
    );
    finiteNumber(eventEfficiency, `eventAdditiveEfficiency at segment starting ${startHour}`);
    const additiveEfficiency = matchingEfficiency(
      [...staticEffects, ...(event?.effects ?? [])],
      input,
      `additiveEfficiency at segment starting ${startHour}`
    );
    const efficiencyMultiplier = finiteNumber(
      1 + additiveEfficiency,
      `efficiencyMultiplier at segment starting ${startHour}`
    );
    if (efficiencyMultiplier < 0) {
      throw new RangeError(`efficiency multiplier must be non-negative in segment starting at ${startHour}`);
    }

    const segmentHours = finiteNumber(endHour - startHour, `segmentHours at segment starting ${startHour}`);
    const rate = finiteNumber(
      unitsPerHour * efficiencyMultiplier,
      `segmentRate at segment starting ${startHour}`
    );
    const potentialUnits = finiteNumber(
      rate * segmentHours,
      `potentialUnits at segment starting ${startHour}`
    );
    const producedUnits = finiteNumber(
      input.storage ? Math.min(potentialUnits, remainingCapacity) : potentialUnits,
      `producedUnits at segment starting ${startHour}`
    );
    const productiveHours = finiteNumber(
      rate === 0 ? segmentHours : producedUnits / rate,
      `productiveHours at segment starting ${startHour}`
    );
    const blockedTimeHours = finiteNumber(
      rate === 0 ? 0 : segmentHours - productiveHours,
      `blockedTimeHours at segment starting ${startHour}`
    );
    if (input.storage) {
      remainingCapacity = finiteNumber(
        remainingCapacity - producedUnits,
        `remainingCapacity after segment starting ${startHour}`
      );
    }
    segments.push({
      startHour,
      endHour,
      ...(event?.label ? { eventLabel: event.label } : {}),
      additiveEfficiency,
      efficiencyMultiplier,
      potentialUnits,
      producedUnits,
      blockedTimeHours
    });
  }

  const potentialUnits = compensatedFiniteSum(
    segments.map((segment) => segment.potentialUnits),
    "aggregate potentialUnits"
  );
  const producedUnits = compensatedFiniteSum(
    segments.map((segment) => segment.producedUnits),
    "aggregate producedUnits"
  );
  const blockedTimeHours = compensatedFiniteSum(
    segments.map((segment) => segment.blockedTimeHours),
    "aggregate blockedTimeHours"
  );
  const storage = Object.freeze(input.storage
    ? {
        initialUnits: input.storage.initialUnits,
        capacityUnits: input.storage.capacityUnits,
        remainingCapacityUnits: remainingCapacity,
        blockedTimeHours
      }
    : { initialUnits: 0, capacityUnits: null, remainingCapacityUnits: null, blockedTimeHours: 0 });
  const common = {
    durationHours: input.durationHours,
    efficiency: Object.freeze({
      staticAdditiveEfficiency,
      teamAdditiveEfficiency,
      remoteAdditiveEfficiency
    }),
    production: Object.freeze({ potentialUnits, producedUnits }),
    storage,
    ...(input.display
      ? { display: Object.freeze({
          decimalPlaces: input.display.decimalPlaces,
          producedUnits: roundForDisplay(producedUnits, input.display.decimalPlaces)
        }) }
      : {}),
    segments: freezeSegments(segments)
  };

  if (input.facility.kind === "factory") {
    const mechanic = factoryMechanics[input.facility.product];
    const expPerUnit = "expPerUnit" in mechanic ? mechanic.expPerUnit : undefined;
    const ledger = createResourceLedger({
      natural: input.facility.product === "gold"
        ? { goldProduced: producedUnits }
        : { battleRecordExp: finiteNumber(producedUnits * (expPerUnit ?? 0), "ledger.natural.battleRecordExp") }
    });
    return Object.freeze({
      ...common,
      facility: Object.freeze({ ...input.facility }),
      base: Object.freeze({
        minutesPerUnit: mechanic.minutesPerUnit,
        unitsPerHour,
        ...(expPerUnit === undefined ? {} : { expPerUnit })
      }),
      ledger
    });
  }

  const ledger = createResourceLedger({
    natural: {
      goldConsumed: finiteNumber(
        producedUnits * normalOrderMechanics.expectedGoldPerOrder,
        "ledger.natural.goldConsumed"
      ),
      lmd: finiteNumber(producedUnits * normalOrderMechanics.expectedLmdPerOrder, "ledger.natural.lmd")
    }
  });
  return Object.freeze({
    ...common,
    facility: Object.freeze({ ...input.facility }),
    base: Object.freeze({ minutesPerOrder: normalOrderMechanics.minutesPerOrder, ordersPerHour: unitsPerHour }),
    orderDistribution: Object.freeze({
      outcomes: normalOrderOutcomes,
      expectedGoldPerOrder: normalOrderMechanics.expectedGoldPerOrder,
      expectedLmdPerOrder: normalOrderMechanics.expectedLmdPerOrder
    }),
    ledger
  });
}
