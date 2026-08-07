import baseMechanics from "../data/optimizer-benchmarks/base-mechanics-2026-07.json";
import {
  createMaxLevel243BenchmarkContext,
  validateBenchmarkBaseContext,
  type BenchmarkBaseContext
} from "./benchmarkBaseContext";
import {
  simulateFacilityProduction,
  type ProductionEfficiencyEffect
} from "./facilityProduction";
import {
  aggregateResourceLedgers,
  createResourceLedger,
  type ResourceContribution,
  type ResourceLedger
} from "./resourceLedger";

export interface PowerPlantDroneSkillIncrement {
  /** Fixed 12-hour slot in which this power-plant assignment is active. */
  slot: 0 | 1;
  /** Power facility whose occupied slot witnesses this contribution. */
  sourceFacilityId: string;
  id: string;
  /** Fractional increase applied to the verified base drone recovery rate. */
  recoveryRateIncrement: number;
}

export interface FixedDroneSpecialOrderProfile {
  id: string;
  behavior: "exclusive" | "additive";
  gold: number;
  lmd: number;
  baseMinutes: number;
  affectedByEfficiency: boolean;
}

export interface TradingPostDroneAllocation {
  /** Fixed 12-hour slot: 0 is [0, 12), 1 is [12, 24). */
  slot: 0 | 1;
  targetFacilityId: string;
  drones: number;
  orderAcquisitionEfficiency?: number;
  /** At most one explicit profile is accepted so replacement and addition cannot be ambiguous. */
  specialOrders?: readonly FixedDroneSpecialOrderProfile[];
}

export interface TradingPostDroneSimulationInput {
  initialDrones: number;
  powerPlantSkillIncrements: readonly PowerPlantDroneSkillIncrement[];
  allocations: readonly TradingPostDroneAllocation[];
  baseContext?: BenchmarkBaseContext;
}

export interface TradingPostDroneTargetSlotResult {
  slot: 0 | 1;
  drones: number;
  orderAcquisitionEfficiency: number;
  shortenedMinutes: number;
  equivalentExtraProductiveTimeMinutes: number;
  specialOrder?: Readonly<FixedDroneSpecialOrderProfile>;
  naturalOrders: number;
  droneOrders: Readonly<{ normal: number; special: number }>;
  ledger: ResourceLedger;
}

export interface TradingPostDroneTargetResult {
  targetFacilityId: string;
  drones: number;
  shortenedMinutes: number;
  equivalentExtraProductiveTimeMinutes: number;
  naturalOrders: number;
  droneOrders: Readonly<{ normal: number; special: number }>;
  slots: readonly Readonly<TradingPostDroneTargetSlotResult>[];
  ledger: ResourceLedger;
}

export interface TradingPostDroneSimulationResult {
  durationHours: 24;
  semantics: Readonly<{
    allocationTimingAssumption: "slot-batch-consumption";
    capOverflowAccounting: "before-slot-allocation";
    scheduleFeasibility: "evaluated-at-slot-boundaries";
  }>;
  generation: Readonly<{
    baseRatePerHour: number;
    baseGeneratedPerSlot: number;
    baseGenerated: number;
    skillIncrements: ReadonlyArray<Readonly<PowerPlantDroneSkillIncrement & { generatedDrones: number }>>;
    skillGenerated: number;
    continuousGenerated: number;
    slots: readonly Readonly<{
      slot: 0 | 1;
      baseGenerated: number;
      skillGenerated: number;
      generated: number;
    }>[];
  }>;
  inventory: Readonly<{
    cap: number;
    initial: number;
    generated: number;
    used: number;
    remaining: number;
    overflow: number;
    timeline: readonly Readonly<{
      slot: 0 | 1;
      startHour: 0 | 12;
      endHour: 12 | 24;
      opening: number;
      generated: number;
      overflow: number;
      available: number;
      used: number;
      ending: number;
    }>[];
  }>;
  targets: readonly Readonly<TradingPostDroneTargetResult>[];
  ledger: ResourceLedger;
}

function documentedMechanic(id: string): number {
  const value = baseMechanics.formulas.find((formula) => formula.id === id)?.expectedValue;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`base-mechanics-2026-07 is missing the finite ${id} constant`);
  }
  return value;
}

const durationHours = 24 as const;
const baseDroneRecoveryPerHour = documentedMechanic("base-drone-recovery");
const droneTimeReductionMinutes = documentedMechanic("drone-time-reduction");

function finiteNonNegative(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${path} must be a finite non-negative number`);
  }
  return value;
}

function nonEmptyId(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RangeError(`${path} must be a non-empty string`);
  }
  return value;
}

function validateSpecialOrder(
  profiles: readonly FixedDroneSpecialOrderProfile[] | undefined,
  path: string
): FixedDroneSpecialOrderProfile | undefined {
  if (profiles === undefined) return undefined;
  if (!Array.isArray(profiles)) throw new RangeError(`${path} must be an array`);
  if (profiles.length > 1) throw new RangeError(`${path} must contain at most one explicit profile`);
  const profile = profiles[0];
  if (!profile) return undefined;

  nonEmptyId(profile.id, `${path}[0].id`);
  if (profile.behavior !== "exclusive" && profile.behavior !== "additive") {
    throw new RangeError(`${path}[0].behavior must be exclusive or additive`);
  }
  finiteNonNegative(profile.gold, `${path}[0].gold`);
  finiteNonNegative(profile.lmd, `${path}[0].lmd`);
  const baseMinutes = finiteNonNegative(profile.baseMinutes, `${path}[0].baseMinutes`);
  if (baseMinutes === 0) throw new RangeError(`${path}[0].baseMinutes must be positive`);
  if (typeof profile.affectedByEfficiency !== "boolean") {
    throw new RangeError(`${path}[0].affectedByEfficiency must be boolean`);
  }
  return profile;
}

function orderEfficiencyEffect(efficiency: number, facilityId: string): readonly ProductionEfficiencyEffect[] {
  return efficiency === 0
    ? []
    : [{
        id: `drone-natural-${facilityId}`,
        source: "operator",
        additiveEfficiency: efficiency,
        target: "normalOrder"
      }];
}

function emptyContribution(): ResourceContribution {
  return {
    goldProduced: 0,
    goldConsumed: 0,
    battleRecordExp: 0,
    lmd: 0
  };
}

function addContributions(left: ResourceContribution, right: ResourceContribution): ResourceContribution {
  return {
    goldProduced: left.goldProduced + right.goldProduced,
    goldConsumed: left.goldConsumed + right.goldConsumed,
    battleRecordExp: left.battleRecordExp + right.battleRecordExp,
    lmd: left.lmd + right.lmd
  };
}

function simulateNormalDroneContribution(
  shortenedMinutes: number,
  efficiency: number,
  facilityId: string
): { orders: number; contribution: ResourceContribution } {
  if (shortenedMinutes === 0) return { orders: 0, contribution: emptyContribution() };
  const result = simulateFacilityProduction({
    durationHours: shortenedMinutes / 60,
    facility: { kind: "tradingPost", level: 3, orderType: "normalLmd" },
    teamEffects: orderEfficiencyEffect(efficiency, facilityId)
  });
  return { orders: result.production.producedUnits, contribution: { ...result.ledger.natural } };
}

function freezeTarget(target: TradingPostDroneTargetResult): Readonly<TradingPostDroneTargetResult> {
  return Object.freeze({
    ...target,
    droneOrders: Object.freeze({ ...target.droneOrders }),
    slots: Object.freeze(target.slots.map((slot) => Object.freeze({
      ...slot,
      ...(slot.specialOrder ? { specialOrder: Object.freeze({ ...slot.specialOrder }) } : {}),
      droneOrders: Object.freeze({ ...slot.droneOrders })
    })))
  });
}

export function simulateTradingPostDrones24h(
  input: TradingPostDroneSimulationInput
): TradingPostDroneSimulationResult {
  const initialDrones = finiteNonNegative(input.initialDrones, "initialDrones");
  if (!Array.isArray(input.powerPlantSkillIncrements)) {
    throw new RangeError("powerPlantSkillIncrements must be an array");
  }
  if (!Array.isArray(input.allocations)) throw new RangeError("allocations must be an array");

  const effectiveContext = input.baseContext === undefined
    ? createMaxLevel243BenchmarkContext()
    : input.baseContext;
  const contextValidation = validateBenchmarkBaseContext(effectiveContext);
  if (!contextValidation.ok) {
    throw new RangeError(`baseContext is invalid: ${contextValidation.errors.join("; ")}`);
  }
  const validatedContext = contextValidation.value;
  const inventoryCap = validatedContext.droneCap;
  if (initialDrones > inventoryCap) {
    throw new RangeError(`initialDrones must not exceed the verified drone cap ${inventoryCap}`);
  }

  const baseGeneratedPerSlot = baseDroneRecoveryPerHour * 12;
  const baseGenerated = baseGeneratedPerSlot * 2;
  const facilityById = new Map(validatedContext.facilities.map((facility) => [facility.id, facility]));
  const incrementIdsBySlot = [new Set<string>(), new Set<string>()];
  const sourceOccupancyBySlot = [new Map<string, number>(), new Map<string, number>()];
  const skillIncrements = input.powerPlantSkillIncrements.map((increment, index) => {
    const path = `powerPlantSkillIncrements[${index}]`;
    if (increment.slot !== 0 && increment.slot !== 1) {
      throw new RangeError(`${path}.slot must be 0 or 1`);
    }
    const sourceFacilityId = nonEmptyId(increment.sourceFacilityId, `${path}.sourceFacilityId`);
    const sourceFacility = facilityById.get(sourceFacilityId);
    if (!sourceFacility) throw new RangeError(`unknown source facility ID: ${sourceFacilityId}`);
    if (sourceFacility.type !== "power") {
      throw new RangeError(`${sourceFacilityId} is not a power facility`);
    }
    const sourceOccupancy = (sourceOccupancyBySlot[increment.slot].get(sourceFacilityId) ?? 0) + 1;
    if (sourceOccupancy > sourceFacility.slotCount) {
      throw new RangeError(`source facility ${sourceFacilityId} is reused beyond its ${sourceFacility.slotCount} slot capacity in slot ${increment.slot}`);
    }
    sourceOccupancyBySlot[increment.slot].set(sourceFacilityId, sourceOccupancy);
    const id = nonEmptyId(increment.id, `powerPlantSkillIncrements[${index}].id`);
    if (incrementIdsBySlot[increment.slot].has(id)) {
      throw new RangeError(`duplicate power-plant increment ID in slot ${increment.slot}: ${id}`);
    }
    incrementIdsBySlot[increment.slot].add(id);
    const recoveryRateIncrement = finiteNonNegative(
      increment.recoveryRateIncrement,
      `powerPlantSkillIncrements[${index}].recoveryRateIncrement`
    );
    return Object.freeze({
      slot: increment.slot,
      sourceFacilityId,
      id,
      recoveryRateIncrement,
      generatedDrones: baseGeneratedPerSlot * recoveryRateIncrement
    });
  });
  const skillGenerated = finiteNonNegative(
    skillIncrements.reduce((total, increment) => total + increment.generatedDrones, 0),
    "skillGenerated"
  );
  const generationSlots = ([0, 1] as const).map((slot) => {
    const slotSkillGenerated = finiteNonNegative(
      skillIncrements
        .filter((increment) => increment.slot === slot)
        .reduce((total, increment) => total + increment.generatedDrones, 0),
      `skillGenerated for slot ${slot}`
    );
    return Object.freeze({
      slot,
      baseGenerated: baseGeneratedPerSlot,
      skillGenerated: slotSkillGenerated,
      generated: finiteNonNegative(baseGeneratedPerSlot + slotSkillGenerated, `generated for slot ${slot}`)
    });
  });
  const continuousGenerated = finiteNonNegative(
    generationSlots.reduce((total, slot) => total + slot.generated, 0),
    "continuousGenerated"
  );

  const targetIdsBySlot = [new Set<string>(), new Set<string>()];

  const validatedAllocations = input.allocations.map((item, index) => {
    const path = `allocations[${index}]`;
    if (item.slot !== 0 && item.slot !== 1) {
      throw new RangeError(`${path}.slot must be 0 or 1`);
    }
    const targetFacilityId = nonEmptyId(item.targetFacilityId, `${path}.targetFacilityId`);
    if (targetIdsBySlot[item.slot].has(targetFacilityId)) {
      throw new RangeError(`duplicate allocation target ID in slot ${item.slot}: ${targetFacilityId}`);
    }
    targetIdsBySlot[item.slot].add(targetFacilityId);

    const facility = facilityById.get(targetFacilityId);
    if (!facility) throw new RangeError(`unknown facility ID: ${targetFacilityId}`);
    if (facility && facility.type !== "trading") {
      throw new RangeError(`${targetFacilityId} is not a trading facility`);
    }

    const drones = finiteNonNegative(item.drones, `${path}.drones`);
    const orderAcquisitionEfficiency = finiteNonNegative(
      item.orderAcquisitionEfficiency ?? 0,
      `${path}.orderAcquisitionEfficiency`
    );
    const specialOrder = validateSpecialOrder(item.specialOrders, `${path}.specialOrders`);
    return { slot: item.slot, targetFacilityId, drones, orderAcquisitionEfficiency, specialOrder };
  });

  const timeline: Array<{
    slot: 0 | 1;
    startHour: 0 | 12;
    endHour: 12 | 24;
    opening: number;
    generated: number;
    overflow: number;
    available: number;
    used: number;
    ending: number;
  }> = [];
  let currentInventory = initialDrones;
  let overflow = 0;
  for (const slot of [0, 1] as const) {
    const opening = currentInventory;
    const generated = generationSlots[slot].generated;
    const uncapped = opening + generated;
    const available = Math.min(inventoryCap, uncapped);
    const slotOverflow = uncapped - available;
    const slotUsed = validatedAllocations
      .filter((allocation) => allocation.slot === slot)
      .reduce((total, allocation) => total + allocation.drones, 0);
    if (slotUsed > available + Number.EPSILON * Math.max(1, slotUsed, available) * 8) {
      throw new RangeError(`slot ${slot} drones used ${slotUsed} must not exceed available ${available}`);
    }
    currentInventory = Math.max(0, available - slotUsed);
    overflow += slotOverflow;
    timeline.push({
      slot,
      startHour: slot === 0 ? 0 : 12,
      endHour: slot === 0 ? 12 : 24,
      opening,
      generated,
      overflow: slotOverflow,
      available,
      used: slotUsed,
      ending: currentInventory
    });
  }
  const used = validatedAllocations.reduce((total, allocation) => total + allocation.drones, 0);

  const allocationGroups = new Map<string, typeof validatedAllocations>();
  for (const item of validatedAllocations) {
    const group = allocationGroups.get(item.targetFacilityId) ?? [];
    group.push(item);
    allocationGroups.set(item.targetFacilityId, group);
  }
  const targets = [...allocationGroups.values()].map((items) => {
    const orderedItems = [...items].sort((left, right) => left.slot - right.slot);
    const slots: TradingPostDroneTargetSlotResult[] = orderedItems.map((item) => {
      const natural = simulateFacilityProduction({
        durationHours: 12,
        facility: { kind: "tradingPost", level: 3, orderType: "normalLmd" },
        teamEffects: orderEfficiencyEffect(item.orderAcquisitionEfficiency, item.targetFacilityId)
      });
      const shortenedMinutes = item.drones * droneTimeReductionMinutes;
      const normalProductiveMinutes = shortenedMinutes * (1 + item.orderAcquisitionEfficiency);
      const normalDrone = simulateNormalDroneContribution(
        shortenedMinutes,
        item.orderAcquisitionEfficiency,
        item.targetFacilityId
      );
      let equivalentExtraProductiveTimeMinutes = normalProductiveMinutes;
      let normalOrders = normalDrone.orders;
      let specialOrders = 0;
      let droneContribution = normalDrone.contribution;

      if (item.specialOrder) {
        const specialProductiveMinutes = shortenedMinutes * (
          item.specialOrder.affectedByEfficiency ? 1 + item.orderAcquisitionEfficiency : 1
        );
        specialOrders = specialProductiveMinutes / item.specialOrder.baseMinutes;
        const specialContribution: ResourceContribution = {
          goldProduced: 0,
          goldConsumed: specialOrders * item.specialOrder.gold,
          battleRecordExp: 0,
          lmd: specialOrders * item.specialOrder.lmd
        };
        if (item.specialOrder.behavior === "exclusive") {
          equivalentExtraProductiveTimeMinutes = specialProductiveMinutes;
          normalOrders = 0;
          droneContribution = specialContribution;
        } else {
          droneContribution = addContributions(droneContribution, specialContribution);
        }
      }

      return {
        slot: item.slot,
        drones: item.drones,
        orderAcquisitionEfficiency: item.orderAcquisitionEfficiency,
        shortenedMinutes,
        equivalentExtraProductiveTimeMinutes,
        ...(item.specialOrder ? { specialOrder: item.specialOrder } : {}),
        naturalOrders: natural.production.producedUnits,
        droneOrders: { normal: normalOrders, special: specialOrders },
        ledger: createResourceLedger({
          natural: natural.ledger.natural,
          drone: droneContribution
        })
      };
    });
    const slotLedger = aggregateResourceLedgers(slots.map((slot) => slot.ledger));

    return freezeTarget({
      targetFacilityId: orderedItems[0].targetFacilityId,
      drones: slots.reduce((total, slot) => total + slot.drones, 0),
      shortenedMinutes: slots.reduce((total, slot) => total + slot.shortenedMinutes, 0),
      equivalentExtraProductiveTimeMinutes: slots.reduce(
        (total, slot) => total + slot.equivalentExtraProductiveTimeMinutes,
        0
      ),
      naturalOrders: slots.reduce((total, slot) => total + slot.naturalOrders, 0),
      droneOrders: {
        normal: slots.reduce((total, slot) => total + slot.droneOrders.normal, 0),
        special: slots.reduce((total, slot) => total + slot.droneOrders.special, 0)
      },
      slots,
      ledger: createResourceLedger({
        natural: slotLedger.natural,
        drone: slotLedger.drone
      })
    });
  });

  const targetLedger = aggregateResourceLedgers(targets.map((target) => target.ledger));
  const ledger = createResourceLedger({
    natural: targetLedger.natural,
    drone: targetLedger.drone,
    dronesGenerated: continuousGenerated,
    dronesUsed: used
  });
  const frozenTargets = Object.freeze(targets);

  return Object.freeze({
    durationHours,
    semantics: Object.freeze({
      allocationTimingAssumption: "slot-batch-consumption",
      capOverflowAccounting: "before-slot-allocation",
      scheduleFeasibility: "evaluated-at-slot-boundaries"
    }),
    generation: Object.freeze({
      baseRatePerHour: baseDroneRecoveryPerHour,
      baseGeneratedPerSlot,
      baseGenerated,
      skillIncrements: Object.freeze(skillIncrements),
      skillGenerated,
      continuousGenerated,
      slots: Object.freeze(generationSlots)
    }),
    inventory: Object.freeze({
      cap: inventoryCap,
      initial: initialDrones,
      generated: continuousGenerated,
      used,
      remaining: currentInventory,
      overflow,
      timeline: Object.freeze(timeline.map((entry) => Object.freeze(entry)))
    }),
    targets: frozenTargets,
    ledger
  });
}
