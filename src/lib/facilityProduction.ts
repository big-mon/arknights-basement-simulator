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

function validateEffects(effects: readonly ProductionEfficiencyEffect[], path: string): void {
  effects.forEach((effect, index) => {
    if (!effect.id) throw new RangeError(`${path}[${index}].id must be non-empty`);
    finiteNumber(effect.additiveEfficiency, `${path}[${index}].additiveEfficiency`);
    if (!(["all", "gold", "battleRecord", "normalOrder"] as const).includes(effect.target)) {
      throw new RangeError(`${path}[${index}].target is unsupported`);
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
  input: FacilityProductionInput
): number {
  return effects.reduce(
    (total, effect) => total + (effectMatches(effect, input) ? effect.additiveEfficiency : 0),
    0
  );
}

function validateInput(input: FacilityProductionInput): void {
  const durationHours = finiteNumber(input.durationHours, "durationHours");
  if (durationHours <= 0) throw new RangeError("durationHours must be positive");

  const teamEffects = input.teamEffects ?? [];
  const remoteEffects = input.remoteEffects ?? [];
  validateEffects(teamEffects, "teamEffects");
  validateEffects(remoteEffects, "remoteEffects");

  let previousBoundary = 0;
  (input.efficiencyEvents ?? []).forEach((event, index) => {
    const boundary = finiteNumber(event.atHour, `efficiencyEvents[${index}].atHour`);
    if (boundary <= 0 || boundary >= durationHours) {
      throw new RangeError(`efficiency event boundary ${boundary} must be within (0, durationHours)`);
    }
    if (boundary <= previousBoundary) {
      throw new RangeError("efficiency event boundaries must be strictly sorted");
    }
    previousBoundary = boundary;
    validateEffects(event.effects, `efficiencyEvents[${index}].effects`);
  });

  if (input.storage) {
    const initial = nonNegativeNumber(input.storage.initialUnits, "storage.initialUnits");
    const capacity = nonNegativeNumber(input.storage.capacityUnits, "storage.capacityUnits");
    if (initial > capacity) throw new RangeError("storage.initialUnits must not exceed storage.capacityUnits");
  }

  if (input.display) {
    const places = finiteNumber(input.display.decimalPlaces, "display.decimalPlaces");
    if (!Number.isInteger(places) || places < 0 || places > 12) {
      throw new RangeError("display.decimalPlaces must be an integer from 0 through 12");
    }
  }
}

function roundForDisplay(value: number, decimalPlaces: number): number {
  const factor = 10 ** decimalPlaces;
  return Math.round((value + Number.EPSILON) * factor) / factor;
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
  const teamAdditiveEfficiency = matchingEfficiency(teamEffects, input);
  const remoteAdditiveEfficiency = matchingEfficiency(remoteEffects, input);
  const staticAdditiveEfficiency = teamAdditiveEfficiency + remoteAdditiveEfficiency;
  const unitsPerHour = input.facility.kind === "factory"
    ? 60 / factoryMechanics[input.facility.product].minutesPerUnit
    : 60 / normalOrderMechanics.minutesPerOrder;
  const events = input.efficiencyEvents ?? [];
  const boundaries = [0, ...events.map((event) => event.atHour), input.durationHours];
  let remainingCapacity = input.storage
    ? input.storage.capacityUnits - input.storage.initialUnits
    : Number.POSITIVE_INFINITY;
  const segments: ProductionSegment[] = [];

  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const startHour = boundaries[index];
    const endHour = boundaries[index + 1];
    const event = index === 0 ? undefined : events[index - 1];
    const eventEfficiency = matchingEfficiency(event?.effects ?? [], input);
    const additiveEfficiency = staticAdditiveEfficiency + eventEfficiency;
    const efficiencyMultiplier = 1 + additiveEfficiency;
    if (efficiencyMultiplier < 0) {
      throw new RangeError(`efficiency multiplier must be non-negative in segment starting at ${startHour}`);
    }

    const segmentHours = endHour - startHour;
    const rate = unitsPerHour * efficiencyMultiplier;
    const potentialUnits = rate * segmentHours;
    const producedUnits = Math.min(potentialUnits, remainingCapacity);
    const productiveHours = rate === 0 ? segmentHours : producedUnits / rate;
    const blockedTimeHours = rate === 0 ? 0 : segmentHours - productiveHours;
    remainingCapacity -= producedUnits;
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

  const potentialUnits = segments.reduce((total, segment) => total + segment.potentialUnits, 0);
  const producedUnits = segments.reduce((total, segment) => total + segment.producedUnits, 0);
  const blockedTimeHours = segments.reduce((total, segment) => total + segment.blockedTimeHours, 0);
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
        : { battleRecordExp: producedUnits * (expPerUnit ?? 0) }
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
      goldConsumed: producedUnits * normalOrderMechanics.expectedGoldPerOrder,
      lmd: producedUnits * normalOrderMechanics.expectedLmdPerOrder
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
