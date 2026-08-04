import baseMechanics from "../data/optimizer-benchmarks/base-mechanics-2026-07.json";
import {
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

export interface TradingPostDroneTargetResult {
  targetFacilityId: string;
  drones: number;
  orderAcquisitionEfficiency: number;
  shortenedMinutes: number;
  equivalentExtraProductiveTimeMinutes: number;
  specialOrder?: Readonly<FixedDroneSpecialOrderProfile>;
  droneOrders: Readonly<{ normal: number; special: number }>;
  ledger: ResourceLedger;
}

export interface TradingPostDroneSimulationResult {
  durationHours: 24;
  /**
   * Allocations have no timestamps. The aggregate allocation is therefore treated as if drones
   * are consumed just in time as they recover, and cap overflow is calculated only after that
   * allocation. This is an accounting upper bound, not an exact schedule-feasibility result.
   */
  semantics: Readonly<{
    allocationTimingAssumption: "just-in-time-consumption";
    capOverflowAccounting: "after-aggregate-allocation";
    exactScheduleFeasibility: "not-evaluated";
  }>;
  generation: Readonly<{
    baseRatePerHour: number;
    baseGenerated: number;
    skillIncrements: ReadonlyArray<Readonly<PowerPlantDroneSkillIncrement & { generatedDrones: number }>>;
    skillGenerated: number;
    /** Continuous 24-hour accrual before incomplete-drone progress is separated. */
    continuousGenerated: number;
    /** Whole drones whose recovery completed during the period, before inventory-cap overflow. */
    completedRecovery: number;
    uncompletedDroneProgress: number;
  }>;
  inventory: Readonly<{
    cap: number;
    initial: number;
    /**
     * Initial inventory plus completed recovery under the just-in-time consumption assumption.
     * This is an aggregate allocation upper bound and may exceed the physical inventory cap.
     */
    maximumPotentiallyUsable: number;
    used: number;
    /** Physical end inventory after aggregate allocations and cap overflow. */
    remaining: number;
    /** Completed drones lost because post-allocation end inventory would exceed the cap. */
    overflow: number;
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
const droneCap = documentedMechanic("drone-cap");

function finiteNonNegative(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${path} must be a finite non-negative number`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new RangeError(`${path} must be a finite non-negative integer`);
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
    ...(target.specialOrder ? { specialOrder: Object.freeze({ ...target.specialOrder }) } : {}),
    droneOrders: Object.freeze({ ...target.droneOrders })
  });
}

export function simulateTradingPostDrones24h(
  input: TradingPostDroneSimulationInput
): TradingPostDroneSimulationResult {
  const initialDrones = nonNegativeInteger(input.initialDrones, "initialDrones");
  if (initialDrones > droneCap) {
    throw new RangeError(`initialDrones must not exceed the verified drone cap ${droneCap}`);
  }
  if (!Array.isArray(input.powerPlantSkillIncrements)) {
    throw new RangeError("powerPlantSkillIncrements must be an array");
  }
  if (!Array.isArray(input.allocations)) throw new RangeError("allocations must be an array");

  if (input.baseContext) {
    const validation = validateBenchmarkBaseContext(input.baseContext);
    if (!validation.ok) {
      throw new RangeError(`baseContext is invalid: ${validation.errors.join("; ")}`);
    }
  }

  const baseGenerated = baseDroneRecoveryPerHour * durationHours;
  const skillIncrements = input.powerPlantSkillIncrements.map((increment, index) => {
    const id = nonEmptyId(increment.id, `powerPlantSkillIncrements[${index}].id`);
    const recoveryRateIncrement = finiteNonNegative(
      increment.recoveryRateIncrement,
      `powerPlantSkillIncrements[${index}].recoveryRateIncrement`
    );
    return Object.freeze({
      id,
      recoveryRateIncrement,
      generatedDrones: baseGenerated * recoveryRateIncrement
    });
  });
  const skillGenerated = skillIncrements.reduce((total, increment) => total + increment.generatedDrones, 0);
  const continuousGenerated = baseGenerated + skillGenerated;
  const completedRecovery = Math.floor(continuousGenerated);
  const uncompletedDroneProgress = continuousGenerated - completedRecovery;
  const maximumPotentiallyUsable = initialDrones + completedRecovery;

  const facilityById = input.baseContext
    ? new Map(input.baseContext.facilities.map((facility) => [facility.id, facility]))
    : undefined;
  const targetIds = new Set<string>();
  let used = 0;

  const validatedAllocations = input.allocations.map((item, index) => {
    const path = `allocations[${index}]`;
    const targetFacilityId = nonEmptyId(item.targetFacilityId, `${path}.targetFacilityId`);
    if (targetIds.has(targetFacilityId)) {
      throw new RangeError(`duplicate allocation target ID: ${targetFacilityId}`);
    }
    targetIds.add(targetFacilityId);

    const facility = facilityById?.get(targetFacilityId);
    if (facilityById && !facility) throw new RangeError(`unknown facility ID: ${targetFacilityId}`);
    if (facility && facility.type !== "trading") {
      throw new RangeError(`${targetFacilityId} is not a trading facility`);
    }

    const drones = nonNegativeInteger(item.drones, `${path}.drones`);
    const orderAcquisitionEfficiency = finiteNonNegative(
      item.orderAcquisitionEfficiency ?? 0,
      `${path}.orderAcquisitionEfficiency`
    );
    const specialOrder = validateSpecialOrder(item.specialOrders, `${path}.specialOrders`);
    used += drones;
    return { targetFacilityId, drones, orderAcquisitionEfficiency, specialOrder };
  });

  if (used > maximumPotentiallyUsable) {
    throw new RangeError(
      `drones used ${used} must not exceed available ${maximumPotentiallyUsable} under the just-in-time assumption`
    );
  }

  const targets = validatedAllocations.map((item) => {
    const natural = simulateFacilityProduction({
      durationHours,
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

    return freezeTarget({
      targetFacilityId: item.targetFacilityId,
      drones: item.drones,
      orderAcquisitionEfficiency: item.orderAcquisitionEfficiency,
      shortenedMinutes,
      equivalentExtraProductiveTimeMinutes,
      ...(item.specialOrder ? { specialOrder: item.specialOrder } : {}),
      droneOrders: { normal: normalOrders, special: specialOrders },
      ledger: createResourceLedger({
        natural: natural.ledger.natural,
        drone: droneContribution
      })
    });
  });

  const targetLedger = aggregateResourceLedgers(targets.map((target) => target.ledger));
  const ledger = createResourceLedger({
    natural: targetLedger.natural,
    drone: targetLedger.drone,
    dronesGenerated: completedRecovery,
    dronesUsed: used
  });
  const frozenTargets = Object.freeze(targets);
  const inventoryCap = input.baseContext?.droneCap ?? droneCap;
  const uncappedEndInventory = maximumPotentiallyUsable - used;
  const remaining = Math.min(inventoryCap, uncappedEndInventory);
  const overflow = uncappedEndInventory - remaining;

  return Object.freeze({
    durationHours,
    semantics: Object.freeze({
      allocationTimingAssumption: "just-in-time-consumption",
      capOverflowAccounting: "after-aggregate-allocation",
      exactScheduleFeasibility: "not-evaluated"
    }),
    generation: Object.freeze({
      baseRatePerHour: baseDroneRecoveryPerHour,
      baseGenerated,
      skillIncrements: Object.freeze(skillIncrements),
      skillGenerated,
      continuousGenerated,
      completedRecovery,
      uncompletedDroneProgress
    }),
    inventory: Object.freeze({
      cap: inventoryCap,
      initial: initialDrones,
      maximumPotentiallyUsable,
      used,
      remaining,
      overflow
    }),
    targets: frozenTargets,
    ledger
  });
}
