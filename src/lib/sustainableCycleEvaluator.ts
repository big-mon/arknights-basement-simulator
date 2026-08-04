import baseMechanics from "../data/optimizer-benchmarks/base-mechanics-2026-07.json";
import {
  createMaxLevel243BenchmarkContext,
  validateBenchmarkBaseContext,
  type BenchmarkBaseContext
} from "./benchmarkBaseContext";
import {
  aggregateResourceLedgers,
  validateResourceLedger,
  type ResourceLedger
} from "./resourceLedger";
import { normalizeSchedule, scheduleEpsilonHours } from "./schedule";
import type { ScheduleState } from "../types";

export interface CycleFacilityAssignment {
  facilityId: string;
  operatorId: string;
  moraleConsumptionPerHour?: number;
}

export type CycleFacilityResourceContributionKind =
  | "factory-gold"
  | "factory-battle-record"
  | "trading-post"
  | "power-drone";

export interface CycleFacilityResourceContribution {
  id: string;
  facilityId: string;
  kind: CycleFacilityResourceContributionKind;
  ledger: ResourceLedger;
}

export interface CycleShift {
  id: string;
  startHour: number;
  endHour: number;
  groupIds: string[];
  assignments: CycleFacilityAssignment[];
  resourceContributions: CycleFacilityResourceContribution[];
}

export interface ConditionalRecoveryModifier {
  moraleAtMost: number;
  additionalRatePerHour: number;
}

export interface MoraleExchangeEvent {
  atHour: number;
  sourceOperatorId: string;
}

export interface CycleRecoveryPlacement {
  dormitoryId: string;
  operatorId: string;
  startHour: number;
  endHour: number;
  recoveryRatePerHour?: number;
  conditionalModifiers?: ConditionalRecoveryModifier[];
  moraleExchange?: MoraleExchangeEvent;
}

export interface SustainableCycleInput {
  schedule: ScheduleState;
  shifts: CycleShift[];
  startingDrones: number;
  initialMorale: Record<string, number>;
  recoveryPlacements: CycleRecoveryPlacement[];
  startingGold: number;
  baseContext?: BenchmarkBaseContext;
  moraleCap?: number;
  /** Used only for final morale/drone cycle closure; defaults to 1e-9 and must not exceed 1e-6. */
  cycleClosureTolerance?: number;
}

export type CycleFailureCategory = "overlap" | "morale" | "dormitory" | "resource" | "cycle-closure";

export interface CycleFailure {
  category: CycleFailureCategory;
  code: string;
  message: string;
  operatorId?: string;
  facilityId?: string;
  dormitoryId?: string;
  shiftId?: string;
  hour?: number;
  overlappingFacilityId?: string;
  overlappingShiftId?: string;
  overlapStartHour?: number;
  overlapEndHour?: number;
}

export type MoraleTimelineMode = "idle" | "work" | "recovery";

export interface MoraleTimelineSegment {
  startHour: number;
  endHour: number;
  mode: MoraleTimelineMode;
  startMorale: number;
  endMorale: number;
  ratePerHour: number;
  facilityId?: string;
  dormitoryId?: string;
}

export interface AppliedMoraleExchange {
  hour: number;
  sourceOperatorId: string;
  targetOperatorId: string;
  dormitoryId: string;
  sourceMoraleBefore: number;
  targetMoraleBefore: number;
}

export interface OperatorCycleResult {
  operatorId: string;
  initialMorale: number;
  finalMorale: number;
  scheduledWorkHours: number;
  productiveHours: number;
  uptime: number;
  timeline: readonly Readonly<MoraleTimelineSegment>[];
}

export interface GoldTimelinePoint {
  hour: number;
  gold: number;
}

export interface DroneTimelinePoint {
  hour: number;
  shiftId: string;
  opening: number;
  generated: number;
  overflow: number;
  available: number;
  used: number;
  ending: number;
}

export interface SustainableCycleResult {
  sustainable: boolean;
  failures: readonly Readonly<CycleFailure>[];
  operators: readonly Readonly<OperatorCycleResult>[];
  exchanges: readonly Readonly<AppliedMoraleExchange>[];
  aggregateLedger: ResourceLedger;
  gold: Readonly<{
    starting: number;
    produced: number;
    consumed: number;
    netChange: number;
    ending: number;
    timeline: readonly Readonly<GoldTimelinePoint>[];
  }>;
  drones: Readonly<{
    cap: number;
    starting: number;
    generated: number;
    used: number;
    overflow: number;
    ending: number;
    timeline: readonly Readonly<DroneTimelinePoint>[];
  }>;
}

function documentedMechanic(id: string): number {
  const value = baseMechanics.formulas.find((formula) => formula.id === id)?.expectedValue;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`base-mechanics-2026-07 is missing the finite ${id} constant`);
  }
  return value;
}

const verifiedMoraleCap = documentedMechanic("operator-morale-cap");
const verifiedConsumptionRate = documentedMechanic("base-morale-consumption");
const verifiedDormitoryRecoveryRate = documentedMechanic("max-dormitory-recovery");
const calculationEpsilon = 1e-12;
const exchangeFullMoraleEpsilon = 1e-9;
const defaultCycleClosureTolerance = 1e-9;
const maximumCycleClosureTolerance = 1e-6;

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

function isNonArrayObject(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireOwn(input: Record<PropertyKey, unknown>, field: string, path: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(input, field)) {
    throw new RangeError(`${path}.${field} is required`);
  }
  return input[field];
}

const resourceContributionKinds = [
  "factory-gold",
  "factory-battle-record",
  "trading-post",
  "power-drone"
] as const satisfies readonly CycleFacilityResourceContributionKind[];

function validateContributionKind(value: unknown, path: string): CycleFacilityResourceContributionKind {
  if (!resourceContributionKinds.includes(value as CycleFacilityResourceContributionKind)) {
    throw new RangeError(`${path} must be one of ${resourceContributionKinds.join(", ")}`);
  }
  return value as CycleFacilityResourceContributionKind;
}

function requireExactZero(value: number, path: string, kind: CycleFacilityResourceContributionKind): void {
  if (value !== 0) throw new RangeError(`${path} must be exactly zero for ${kind}`);
}

function validateAllowedContributionFields(
  ledger: ResourceLedger,
  kind: CycleFacilityResourceContributionKind,
  path: string
): void {
  const primitiveFields = [
    ["natural.goldProduced", ledger.natural.goldProduced],
    ["natural.goldConsumed", ledger.natural.goldConsumed],
    ["natural.battleRecordExp", ledger.natural.battleRecordExp],
    ["natural.lmd", ledger.natural.lmd],
    ["drone.goldProduced", ledger.drone.goldProduced],
    ["drone.goldConsumed", ledger.drone.goldConsumed],
    ["drone.battleRecordExp", ledger.drone.battleRecordExp],
    ["drone.lmd", ledger.drone.lmd],
    ["dronesGenerated", ledger.dronesGenerated],
    ["dronesUsed", ledger.dronesUsed]
  ] as const;
  const allowed = new Set<string>(kind === "factory-gold"
    ? ["natural.goldProduced"]
    : kind === "factory-battle-record"
      ? ["natural.battleRecordExp"]
      : kind === "trading-post"
        ? ["natural.goldConsumed", "natural.lmd", "drone.goldConsumed", "drone.lmd", "dronesUsed"]
        : ["dronesGenerated"]);
  for (const [field, value] of primitiveFields) {
    if (!allowed.has(field)) requireExactZero(value, `${path}.${field}`, kind);
  }
}

function intervalsOverlap(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): boolean {
  return Math.max(leftStart, rightStart) < Math.min(leftEnd, rightEnd) - calculationEpsilon;
}

function failure(category: CycleFailureCategory, code: string, message: string, details: Partial<CycleFailure> = {}): CycleFailure {
  return { category, code, message, ...details };
}

interface ValidatedInput {
  schedule: ScheduleState;
  shifts: CycleShift[];
  placements: CycleRecoveryPlacement[];
  initialMorale: Map<string, number>;
  moraleCap: number;
  closureTolerance: number;
  startingGold: number;
  startingDrones: number;
  droneCap: number;
  context: BenchmarkBaseContext;
  ledgers: ResourceLedger[];
}

function validateInput(input: SustainableCycleInput): ValidatedInput {
  if (!input) throw new RangeError("input is required");
  const schedule = normalizeSchedule(input.schedule);
  if (!Array.isArray(input.shifts) || input.shifts.length !== schedule.shifts.length) {
    throw new RangeError(`shifts must contain exactly the ${schedule.shifts.length} schedule shifts`);
  }
  const seenShiftIds = new Set<string>();
  input.shifts.forEach((shift, index) => {
    const shiftPath = `shifts[${index}]`;
    if (Object.prototype.hasOwnProperty.call(shift, "resourceLedger")) {
      throw new RangeError(`${shiftPath}.resourceLedger is unsupported; use resourceContributions`);
    }
    nonEmptyId(shift.id, `shifts[${index}].id`);
    if (seenShiftIds.has(shift.id)) throw new RangeError(`duplicate shift ID: ${shift.id}`);
    seenShiftIds.add(shift.id);
    const expected = schedule.shifts[index];
    if (shift.id !== expected.id) throw new RangeError(`shifts[${index}].id must match schedule shift ${expected.id}`);
    if (Math.abs(shift.startHour - expected.startHour) > scheduleEpsilonHours || Math.abs(shift.endHour - expected.endHour) > scheduleEpsilonHours) {
      throw new RangeError(`shifts[${index}] boundaries must match schedule ${expected.startHour}..${expected.endHour}`);
    }
    if (!Array.isArray(shift.groupIds) || shift.groupIds.length !== expected.activeGroupIds.length ||
        shift.groupIds.some((groupId, groupIndex) => groupId !== expected.activeGroupIds[groupIndex])) {
      throw new RangeError(`shifts[${index}].groupIds must match schedule activeGroupIds`);
    }
    if (!Array.isArray(shift.assignments)) throw new RangeError(`shifts[${index}].assignments must be an array`);
    shift.assignments.forEach((assignment, assignmentIndex) => {
      nonEmptyId(assignment.facilityId, `shifts[${index}].assignments[${assignmentIndex}].facilityId`);
      nonEmptyId(assignment.operatorId, `shifts[${index}].assignments[${assignmentIndex}].operatorId`);
      finiteNonNegative(
        assignment.moraleConsumptionPerHour ?? verifiedConsumptionRate,
        `shifts[${index}].assignments[${assignmentIndex}].moraleConsumptionPerHour`
      );
      if (Object.prototype.hasOwnProperty.call(assignment, "postZeroOutputModeled")) {
        throw new RangeError(`shifts[${index}].assignments[${assignmentIndex}].postZeroOutputModeled is unsupported`);
      }
    });
    if (!Array.isArray(shift.resourceContributions)) {
      throw new RangeError(`${shiftPath}.resourceContributions must be an array`);
    }
  });

  const moraleCap = finiteNonNegative(input.moraleCap ?? verifiedMoraleCap, "moraleCap");
  if (moraleCap === 0) throw new RangeError("moraleCap must be positive");
  const closureTolerance = finiteNonNegative(input.cycleClosureTolerance ?? defaultCycleClosureTolerance, "cycleClosureTolerance");
  if (closureTolerance > maximumCycleClosureTolerance) {
    throw new RangeError(`cycleClosureTolerance must not exceed ${maximumCycleClosureTolerance}`);
  }
  const startingGold = finiteNonNegative(input.startingGold, "startingGold");
  const startingDrones = finiteNonNegative(input.startingDrones, "startingDrones");
  if (typeof input.initialMorale !== "object" || input.initialMorale === null || Array.isArray(input.initialMorale)) {
    throw new RangeError("initialMorale must be an operator morale record");
  }
  const initialMorale = new Map<string, number>();
  for (const [operatorId, value] of Object.entries(input.initialMorale)) {
    nonEmptyId(operatorId, "initialMorale operator ID");
    const morale = finiteNonNegative(value, `initialMorale.${operatorId}`);
    if (morale > moraleCap) throw new RangeError(`initialMorale.${operatorId} must not exceed morale cap ${moraleCap}`);
    initialMorale.set(operatorId, morale);
  }

  if (!Array.isArray(input.recoveryPlacements)) throw new RangeError("recoveryPlacements must be an array");
  input.recoveryPlacements.forEach((placement, index) => {
    const path = `recoveryPlacements[${index}]`;
    nonEmptyId(placement.dormitoryId, `${path}.dormitoryId`);
    nonEmptyId(placement.operatorId, `${path}.operatorId`);
    const start = finiteNonNegative(placement.startHour, `${path}.startHour`);
    const end = finiteNonNegative(placement.endHour, `${path}.endHour`);
    if (start < 0 || end > schedule.cycleHours || start >= end) throw new RangeError(`${path} interval must be within 0..${schedule.cycleHours} with start < end`);
    finiteNonNegative(placement.recoveryRatePerHour ?? verifiedDormitoryRecoveryRate, `${path}.recoveryRatePerHour`);
    if (placement.conditionalModifiers !== undefined && !Array.isArray(placement.conditionalModifiers)) {
      throw new RangeError(`${path}.conditionalModifiers must be an array`);
    }
    (placement.conditionalModifiers ?? []).forEach((modifier, modifierIndex) => {
      const threshold = finiteNonNegative(modifier.moraleAtMost, `${path}.conditionalModifiers[${modifierIndex}].moraleAtMost`);
      if (threshold > moraleCap) throw new RangeError(`${path}.conditionalModifiers[${modifierIndex}].moraleAtMost must not exceed morale cap`);
      finiteNonNegative(modifier.additionalRatePerHour, `${path}.conditionalModifiers[${modifierIndex}].additionalRatePerHour`);
    });
    if (placement.moraleExchange) {
      nonEmptyId(placement.moraleExchange.sourceOperatorId, `${path}.moraleExchange.sourceOperatorId`);
      const atHour = finiteNonNegative(placement.moraleExchange.atHour, `${path}.moraleExchange.atHour`);
      if (atHour < start || atHour >= end) throw new RangeError(`${path}.moraleExchange.atHour must be within its recovery event`);
      if (placement.moraleExchange.sourceOperatorId === placement.operatorId) {
        throw new RangeError(`${path}.moraleExchange source and target must differ`);
      }
    }
  });

  const effectiveContext = input.baseContext === undefined
    ? createMaxLevel243BenchmarkContext()
    : input.baseContext;
  const contextValidation = validateBenchmarkBaseContext(effectiveContext);
  if (!contextValidation.ok) {
    throw new RangeError(`baseContext is invalid: ${contextValidation.errors.join("; ")}`);
  }
  const context = contextValidation.value;
  const droneCap = context.droneCap;
  if (startingDrones > droneCap) {
    throw new RangeError(`startingDrones must not exceed drone cap ${droneCap}`);
  }

  const facilityById = new Map(context.facilities.map((facility) => [facility.id, facility]));
  const ledgers = input.shifts.map((shift, shiftIndex) => {
    const seenContributionIds = new Set<string>();
    const seenFacilityIds = new Set<string>();
    const validatedContributions = shift.resourceContributions.map((contribution, contributionIndex) => {
      const path = `shifts[${shiftIndex}].resourceContributions[${contributionIndex}]`;
      if (!isNonArrayObject(contribution)) {
        throw new RangeError(`${path} must be a non-null, non-array object`);
      }
      const id = nonEmptyId(requireOwn(contribution, "id", path), `${path}.id`);
      if (seenContributionIds.has(id)) throw new RangeError(`${path}.id duplicates contribution ID ${id} in shift ${shift.id}`);
      seenContributionIds.add(id);
      const facilityId = nonEmptyId(requireOwn(contribution, "facilityId", path), `${path}.facilityId`);
      if (seenFacilityIds.has(facilityId)) {
        throw new RangeError(`${path}.facilityId duplicates facility ${facilityId} in shift ${shift.id}`);
      }
      seenFacilityIds.add(facilityId);
      const kind = validateContributionKind(requireOwn(contribution, "kind", path), `${path}.kind`);
      const ledger = validateResourceLedger(requireOwn(contribution, "ledger", path), `${path}.ledger`);
      const facility = facilityById.get(facilityId);
      if (!facility) throw new RangeError(`${path}.facilityId references unknown facility ${facilityId}`);
      if (!shift.assignments.some((assignment) => assignment.facilityId === facilityId)) {
        throw new RangeError(`${path}.facilityId ${facilityId} has no matching assignment in shift ${shift.id}`);
      }
      const kindMatches = kind === "factory-gold"
        ? facility.type === "factory" && facility.product === "gold"
        : kind === "factory-battle-record"
          ? facility.type === "factory" && facility.product === "battleRecord"
          : kind === "trading-post"
            ? facility.type === "trading"
            : facility.type === "power";
      if (!kindMatches) {
        throw new RangeError(`${path}.kind ${kind} is incompatible with facility ${facilityId}`);
      }
      validateAllowedContributionFields(ledger, kind, `${path}.ledger`);
      return { id, ledger };
    });
    return aggregateResourceLedgers(
      validatedContributions.sort((left, right) => compareIds(left.id, right.id)).map(({ ledger }) => ledger)
    );
  });

  const referencedOperators = new Set<string>();
  input.shifts.forEach((shift) => shift.assignments.forEach((assignment) => referencedOperators.add(assignment.operatorId)));
  input.recoveryPlacements.forEach((placement) => {
    referencedOperators.add(placement.operatorId);
    if (placement.moraleExchange) referencedOperators.add(placement.moraleExchange.sourceOperatorId);
  });
  for (const operatorId of referencedOperators) {
    if (!initialMorale.has(operatorId)) throw new RangeError(`initialMorale is missing referenced operator ${operatorId}`);
  }

  return {
    schedule,
    shifts: input.shifts,
    placements: input.recoveryPlacements,
    initialMorale,
    moraleCap,
    closureTolerance,
    startingGold,
    startingDrones,
    droneCap,
    context,
    ledgers
  };
}

function collectStructuralFailures(input: ValidatedInput): CycleFailure[] {
  const failures: CycleFailure[] = [];
  const facilityById = new Map(input.context.facilities.map((item) => [item.id, item]));
  input.shifts.forEach((shift) => {
    const operators = new Set<string>();
    const records = new Set<string>();
    const facilityOccupancy = new Map<string, number>();
    for (const assignment of shift.assignments) {
      const recordKey = `${assignment.facilityId}\u0000${assignment.operatorId}`;
      if (records.has(recordKey)) failures.push(failure("overlap", "duplicate-assignment", `duplicate assignment ${assignment.facilityId}/${assignment.operatorId}`, {
        shiftId: shift.id, facilityId: assignment.facilityId, operatorId: assignment.operatorId
      }));
      records.add(recordKey);
      if (operators.has(assignment.operatorId)) {
        const previous = shift.assignments.find((item) => item !== assignment && item.operatorId === assignment.operatorId)!;
        failures.push(failure("overlap", "duplicate-operator-in-shift", `operator ${assignment.operatorId} is assigned more than once in shift ${shift.id}`, {
          shiftId: shift.id, operatorId: assignment.operatorId
        }));
        failures.push(failure("overlap", "simultaneous-operator-occupancy", `operator ${assignment.operatorId} occupies ${previous.facilityId} and ${assignment.facilityId} during ${shift.startHour}..${shift.endHour}`, {
          shiftId: shift.id,
          facilityId: assignment.facilityId,
          operatorId: assignment.operatorId,
          overlappingShiftId: shift.id,
          overlappingFacilityId: previous.facilityId,
          overlapStartHour: shift.startHour,
          overlapEndHour: shift.endHour
        }));
      }
      operators.add(assignment.operatorId);
      facilityOccupancy.set(assignment.facilityId, (facilityOccupancy.get(assignment.facilityId) ?? 0) + 1);
      if (!facilityById.has(assignment.facilityId)) failures.push(failure("overlap", "unknown-facility", `unknown facility ${assignment.facilityId}`, {
        shiftId: shift.id, facilityId: assignment.facilityId, operatorId: assignment.operatorId
      }));
    }
    for (const [facilityId, count] of facilityOccupancy) {
      const facility = facilityById?.get(facilityId);
      if (facility && count > facility.slotCount) failures.push(failure("overlap", "facility-slot-overflow", `${facilityId} has ${count} assignments for ${facility.slotCount} slots`, {
        shiftId: shift.id, facilityId
      }));
    }
  });

  const dormitories = input.context.facilities.filter((facility) => facility.type === "dormitory");
  const dormById = new Map(dormitories.map((dorm) => [dorm.id, dorm]));
  for (const placement of input.placements) {
    if (!dormById.has(placement.dormitoryId)) failures.push(failure("dormitory", "unknown-dormitory", `unknown dormitory ${placement.dormitoryId}`, {
      dormitoryId: placement.dormitoryId, operatorId: placement.operatorId
    }));
  }
  for (let leftIndex = 0; leftIndex < input.placements.length; leftIndex += 1) {
    const left = input.placements[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < input.placements.length; rightIndex += 1) {
      const right = input.placements[rightIndex];
      if (!intervalsOverlap(left.startHour, left.endHour, right.startHour, right.endHour)) continue;
      if (left.operatorId === right.operatorId) failures.push(failure("dormitory", "overlapping-recovery", `operator ${left.operatorId} has overlapping recovery placements`, {
        operatorId: left.operatorId
      }));
    }
  }
  const occupancyBoundaries = [...new Set([0, input.schedule.cycleHours, ...input.placements.flatMap((item) => [item.startHour, item.endHour])])].sort((a, b) => a - b);
  for (let index = 0; index < occupancyBoundaries.length - 1; index += 1) {
    const start = occupancyBoundaries[index];
    const end = occupancyBoundaries[index + 1];
    if (end - start <= calculationEpsilon) continue;
    const active = input.placements.filter((item) => item.startHour < end && item.endHour > start);
    const byDorm = new Map<string, number>();
    active.forEach((item) => byDorm.set(item.dormitoryId, (byDorm.get(item.dormitoryId) ?? 0) + 1));
    for (const [dormitoryId, count] of byDorm) {
      const capacity = dormById.get(dormitoryId)?.slotCount ?? 0;
      if (count > capacity) failures.push(failure("dormitory", "dormitory-overflow", `${dormitoryId} has ${count} occupants for ${capacity} beds`, {
        dormitoryId, hour: start
      }));
    }
    if (active.length > dormitories.reduce((total, dorm) => total + dorm.slotCount, 0)) {
      failures.push(failure("dormitory", "total-bed-overflow", "recovery placements exceed total available dormitory beds", { hour: start }));
    }
  }

  for (const placement of input.placements) {
    for (const shift of input.shifts) {
      if (shift.assignments.some((assignment) => assignment.operatorId === placement.operatorId) &&
          intervalsOverlap(placement.startHour, placement.endHour, shift.startHour, shift.endHour)) {
        throw new RangeError(`ambiguous overlapping work and recovery events for ${placement.operatorId}`);
      }
    }
  }
  return failures;
}

interface MutableOperatorState {
  morale: number;
  productiveHours: number;
  scheduledWorkHours: number;
  timeline: MoraleTimelineSegment[];
}

function activeAssignment(input: ValidatedInput, operatorId: string, start: number, end: number): { assignment: CycleFacilityAssignment; shift: CycleShift } | undefined {
  for (const shift of input.shifts) {
    if (!intervalsOverlap(start, end, shift.startHour, shift.endHour)) continue;
    const assignment = shift.assignments.find((item) => item.operatorId === operatorId);
    if (assignment) return { assignment, shift };
  }
  return undefined;
}

function activePlacement(input: ValidatedInput, operatorId: string, start: number, end: number): CycleRecoveryPlacement | undefined {
  return input.placements.find((item) => item.operatorId === operatorId && intervalsOverlap(start, end, item.startHour, item.endHour));
}

function pushSegment(state: MutableOperatorState, segment: MoraleTimelineSegment): void {
  state.timeline.push(segment);
}

function recoveryArithmetic(value: number, operatorId: string, placementPath: string, boundary: string): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`recovery arithmetic for operator ${operatorId} at ${placementPath}.${boundary} must be finite`);
  }
  return value;
}

function compareRecoveryModifiers(left: ConditionalRecoveryModifier, right: ConditionalRecoveryModifier): number {
  return left.moraleAtMost - right.moraleAtMost || left.additionalRatePerHour - right.additionalRatePerHour;
}

function sumActiveRecoveryModifiers(
  modifiers: readonly ConditionalRecoveryModifier[],
  operatorId: string,
  placementPath: string
): number {
  let sum = 0;
  let correction = 0;
  for (const modifier of [...modifiers].sort(compareRecoveryModifiers)) {
    const next = recoveryArithmetic(
      sum + modifier.additionalRatePerHour,
      operatorId,
      placementPath,
      "conditionalModifierSum"
    );
    const roundingError = Math.abs(sum) >= Math.abs(modifier.additionalRatePerHour)
      ? (sum - next) + modifier.additionalRatePerHour
      : (modifier.additionalRatePerHour - next) + sum;
    correction = recoveryArithmetic(
      correction + roundingError,
      operatorId,
      placementPath,
      "conditionalModifierSum"
    );
    sum = next;
  }
  return recoveryArithmetic(sum + correction, operatorId, placementPath, "conditionalModifierSum");
}

function simulateInterval(
  input: ValidatedInput,
  operatorId: string,
  state: MutableOperatorState,
  intervalStart: number,
  intervalEnd: number,
  failures: CycleFailure[],
  fatigueKeys: Set<string>
): void {
  let cursor = intervalStart;
  while (cursor < intervalEnd - calculationEpsilon) {
    const work = activeAssignment(input, operatorId, cursor, intervalEnd);
    const recovery = activePlacement(input, operatorId, cursor, intervalEnd);
    if (work && recovery) throw new RangeError(`ambiguous overlapping work and recovery events for ${operatorId}`);
    if (work) {
      const consumption = work.assignment.moraleConsumptionPerHour ?? verifiedConsumptionRate;
      const availableDuration = intervalEnd - cursor;
      if (state.morale <= calculationEpsilon) {
        const key = `${work.shift.id}\u0000${operatorId}`;
        if (cursor < work.shift.endHour - calculationEpsilon && !fatigueKeys.has(key)) {
          fatigueKeys.add(key);
          failures.push(failure("morale", "fatigued-before-shift-end", `operator ${operatorId} has zero morale before shift ${work.shift.id} ends`, {
            operatorId,
            facilityId: work.assignment.facilityId,
            shiftId: work.shift.id,
            hour: cursor
          }));
        }
        pushSegment(state, {
          startHour: cursor,
          endHour: intervalEnd,
          mode: "work",
          startMorale: 0,
          endMorale: 0,
          ratePerHour: 0,
          facilityId: work.assignment.facilityId
        });
        state.morale = 0;
        cursor = intervalEnd;
        continue;
      }
      const timeToZero = consumption === 0 ? Number.POSITIVE_INFINITY : state.morale / consumption;
      const duration = Math.min(availableDuration, timeToZero);
      const endMorale = Math.max(0, state.morale - consumption * duration);
      state.productiveHours += duration;
      pushSegment(state, {
        startHour: cursor,
        endHour: cursor + duration,
        mode: "work",
        startMorale: state.morale,
        endMorale,
        ratePerHour: -consumption,
        facilityId: work.assignment.facilityId
      });
      state.morale = endMorale;
      cursor += duration;
      if (state.morale <= calculationEpsilon && cursor < work.shift.endHour - calculationEpsilon) {
        const key = `${work.shift.id}\u0000${operatorId}`;
        if (!fatigueKeys.has(key)) {
          fatigueKeys.add(key);
          failures.push(failure("morale", "fatigued-before-shift-end", `operator ${operatorId} reaches zero morale before shift ${work.shift.id} ends`, {
            operatorId,
            facilityId: work.assignment.facilityId,
            shiftId: work.shift.id,
            hour: cursor
          }));
        }
      }
      continue;
    }
    if (recovery) {
      const placementPath = `recoveryPlacements[${input.placements.indexOf(recovery)}]`;
      const baseRate = recovery.recoveryRatePerHour ?? verifiedDormitoryRecoveryRate;
      const activeModifiers = (recovery.conditionalModifiers ?? [])
        .filter((modifier) => state.morale < modifier.moraleAtMost)
        .sort(compareRecoveryModifiers);
      const modifierSum = sumActiveRecoveryModifiers(activeModifiers, operatorId, placementPath);
      const rate = recoveryArithmetic(
        baseRate + modifierSum,
        operatorId,
        placementPath,
        "baseRatePlusModifierSum"
      );
      const nextThreshold = activeModifiers[0]?.moraleAtMost;
      const nextMoraleBoundary = Math.min(input.moraleCap, nextThreshold ?? input.moraleCap);
      const moraleDelta = recoveryArithmetic(
        nextMoraleBoundary - state.morale,
        operatorId,
        placementPath,
        "moraleDelta"
      );
      const hasNoUpcomingBoundary = rate === 0 || moraleDelta === 0;
      const timeToBoundary = hasNoUpcomingBoundary
        ? Number.POSITIVE_INFINITY
        : recoveryArithmetic(moraleDelta / rate, operatorId, placementPath, "timeToBoundary");
      if (timeToBoundary === 0 && moraleDelta > 0 && rate > 0) {
        state.morale = nextMoraleBoundary;
        continue;
      }
      const remainingDuration = recoveryArithmetic(
        intervalEnd - cursor,
        operatorId,
        placementPath,
        "remainingDuration"
      );
      const duration = recoveryArithmetic(
        Math.min(remainingDuration, timeToBoundary),
        operatorId,
        placementPath,
        "duration"
      );
      const effectiveRate = moraleDelta === 0 ? 0 : rate;
      const recoveredMorale = recoveryArithmetic(
        effectiveRate * duration,
        operatorId,
        placementPath,
        "rateTimesDuration"
      );
      const calculatedEndMorale = recoveryArithmetic(
        state.morale + recoveredMorale,
        operatorId,
        placementPath,
        "endMorale"
      );
      const endMorale = duration === timeToBoundary
        ? nextMoraleBoundary
        : Math.min(input.moraleCap, calculatedEndMorale);
      recoveryArithmetic(endMorale, operatorId, placementPath, "endMorale");
      const segmentEnd = recoveryArithmetic(cursor + duration, operatorId, placementPath, "segmentEndHour");
      if (segmentEnd <= cursor && moraleDelta > 0 && rate > 0) {
        state.morale = nextMoraleBoundary;
        continue;
      }
      pushSegment(state, {
        startHour: cursor,
        endHour: segmentEnd,
        mode: "recovery",
        startMorale: state.morale,
        endMorale,
        ratePerHour: effectiveRate,
        dormitoryId: recovery.dormitoryId
      });
      state.morale = endMorale;
      cursor = segmentEnd;
      continue;
    }
    pushSegment(state, {
      startHour: cursor,
      endHour: intervalEnd,
      mode: "idle",
      startMorale: state.morale,
      endMorale: state.morale,
      ratePerHour: 0
    });
    cursor = intervalEnd;
  }
}

function processExchange(
  input: ValidatedInput,
  targetPlacement: CycleRecoveryPlacement,
  states: Map<string, MutableOperatorState>,
  usedSources: Set<string>,
  failures: CycleFailure[],
  exchanges: AppliedMoraleExchange[]
): void {
  const event = targetPlacement.moraleExchange;
  if (!event) return;
  const sourceState = states.get(event.sourceOperatorId)!;
  const targetState = states.get(targetPlacement.operatorId)!;
  const eventShiftIndex = input.schedule.shifts.findIndex((shift) =>
    event.atHour >= shift.startHour - scheduleEpsilonHours && event.atHour < shift.endHour - scheduleEpsilonHours
  );
  const eventShift = input.schedule.shifts[eventShiftIndex];
  const sourceUseKey = `${eventShift?.id ?? `${targetPlacement.startHour}:${targetPlacement.endHour}`}\u0000${event.sourceOperatorId}`;
  let valid = true;
  if (Math.abs(sourceState.morale - input.moraleCap) > exchangeFullMoraleEpsilon) {
    failures.push(failure("morale", "exchange-source-not-full", `exchange source ${event.sourceOperatorId} is not at full morale`, {
      operatorId: event.sourceOperatorId, hour: event.atHour
    }));
    valid = false;
  }
  if (usedSources.has(sourceUseKey)) {
    failures.push(failure("morale", "exchange-source-already-used", `exchange source ${event.sourceOperatorId} was already used in this recovery shift`, {
      operatorId: event.sourceOperatorId, hour: event.atHour
    }));
    valid = false;
  }
  const sameDormPlacement = input.placements.find((placement) =>
    placement.operatorId === event.sourceOperatorId &&
    placement.dormitoryId === targetPlacement.dormitoryId &&
    placement.startHour === targetPlacement.startHour &&
    placement.endHour === targetPlacement.endHour &&
    event.atHour >= placement.startHour && event.atHour < placement.endHour
  );
  if (!sameDormPlacement) {
    failures.push(failure("dormitory", "exchange-dorm-mismatch", `exchange source ${event.sourceOperatorId} is not in the same dormitory event`, {
      operatorId: event.sourceOperatorId, dormitoryId: targetPlacement.dormitoryId, hour: event.atHour
    }));
    valid = false;
  }
  const disallowedStart = eventShiftIndex > 0 ? input.schedule.shifts[eventShiftIndex - 1].startHour : 0;
  const sourceWorked = input.shifts.some((shift) =>
    shift.assignments.some((assignment) => assignment.operatorId === event.sourceOperatorId) &&
    intervalsOverlap(disallowedStart, targetPlacement.endHour, shift.startHour, shift.endHour)
  );
  if (sourceWorked) {
    failures.push(failure("morale", "exchange-source-worked", `exchange source ${event.sourceOperatorId} worked in the current or previous recovery interval`, {
      operatorId: event.sourceOperatorId, hour: event.atHour
    }));
    valid = false;
  }
  if (!valid) return;

  exchanges.push({
    hour: event.atHour,
    sourceOperatorId: event.sourceOperatorId,
    targetOperatorId: targetPlacement.operatorId,
    dormitoryId: targetPlacement.dormitoryId,
    sourceMoraleBefore: sourceState.morale,
    targetMoraleBefore: targetState.morale
  });
  [sourceState.morale, targetState.morale] = [targetState.morale, sourceState.morale];
  usedSources.add(sourceUseKey);
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareExchangePlacements(left: CycleRecoveryPlacement, right: CycleRecoveryPlacement): number {
  const leftEvent = left.moraleExchange!;
  const rightEvent = right.moraleExchange!;
  return leftEvent.atHour - rightEvent.atHour ||
    compareIds(left.dormitoryId, right.dormitoryId) ||
    compareIds(leftEvent.sourceOperatorId, rightEvent.sourceOperatorId) ||
    compareIds(left.operatorId, right.operatorId);
}

function prevalidateSameHourExchanges(hour: number, placements: readonly CycleRecoveryPlacement[]): void {
  const useCounts = new Map<string, number>();
  for (const placement of placements) {
    const sourceOperatorId = placement.moraleExchange!.sourceOperatorId;
    useCounts.set(sourceOperatorId, (useCounts.get(sourceOperatorId) ?? 0) + 1);
    useCounts.set(placement.operatorId, (useCounts.get(placement.operatorId) ?? 0) + 1);
  }
  const reusedOperators = [...useCounts]
    .filter(([, count]) => count > 1)
    .map(([operatorId]) => operatorId)
    .sort(compareIds);
  if (reusedOperators.length > 0) {
    throw new RangeError(`same-hour morale exchanges at hour ${hour} reuse operators: ${reusedOperators.join(", ")}`);
  }
}

function freezeResult(result: SustainableCycleResult): SustainableCycleResult {
  const operators = Object.freeze(result.operators.map((operator) => Object.freeze({
    ...operator,
    timeline: Object.freeze(operator.timeline.map((segment) => Object.freeze({ ...segment })))
  })));
  const failures = Object.freeze(result.failures.map((item) => Object.freeze({ ...item })));
  const exchanges = Object.freeze(result.exchanges.map((item) => Object.freeze({ ...item })));
  const timeline = Object.freeze(result.gold.timeline.map((point) => Object.freeze({ ...point })));
  const droneTimeline = Object.freeze(result.drones.timeline.map((point) => Object.freeze({ ...point })));
  return Object.freeze({
    ...result,
    operators,
    failures,
    exchanges,
    gold: Object.freeze({ ...result.gold, timeline }),
    drones: Object.freeze({ ...result.drones, timeline: droneTimeline })
  });
}

export function evaluateSustainableCycle(input: SustainableCycleInput): SustainableCycleResult {
  const validated = validateInput(input);
  const failures = collectStructuralFailures(validated);
  const operatorIds = [...validated.initialMorale.keys()].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const states = new Map<string, MutableOperatorState>();
  for (const operatorId of operatorIds) {
    const scheduledWorkHours = validated.shifts.reduce(
      (total, shift) => total + (shift.assignments.some((assignment) => assignment.operatorId === operatorId) ? shift.endHour - shift.startHour : 0),
      0
    );
    states.set(operatorId, { morale: validated.initialMorale.get(operatorId)!, productiveHours: 0, scheduledWorkHours, timeline: [] });
  }

  const exchangePlacements = validated.placements.filter((placement) => placement.moraleExchange);
  const boundaries = [...new Set([
    0,
    validated.schedule.cycleHours,
    ...validated.shifts.flatMap((shift) => [shift.startHour, shift.endHour]),
    ...validated.placements.flatMap((placement) => [placement.startHour, placement.endHour]),
    ...exchangePlacements.map((placement) => placement.moraleExchange!.atHour)
  ])].sort((left, right) => left - right);
  const usedSources = new Set<string>();
  const fatigueKeys = new Set<string>();
  const exchanges: AppliedMoraleExchange[] = [];
  for (let index = 0; index < boundaries.length; index += 1) {
    const boundary = boundaries[index];
    const boundaryExchanges = exchangePlacements
      .filter((item) => item.moraleExchange!.atHour === boundary)
      .sort(compareExchangePlacements);
    prevalidateSameHourExchanges(boundary, boundaryExchanges);
    for (const placement of boundaryExchanges) {
      processExchange(validated, placement, states, usedSources, failures, exchanges);
    }
    const nextBoundary = boundaries[index + 1];
    if (nextBoundary === undefined) break;
    for (const operatorId of operatorIds) {
      simulateInterval(validated, operatorId, states.get(operatorId)!, boundary, nextBoundary, failures, fatigueKeys);
    }
  }

  const operators: OperatorCycleResult[] = operatorIds.map((operatorId) => {
    const state = states.get(operatorId)!;
    const initial = validated.initialMorale.get(operatorId)!;
    if (Math.abs(state.morale - initial) > validated.closureTolerance) {
      failures.push(failure("cycle-closure", "morale-state-not-closed", `operator ${operatorId} ends at ${state.morale} instead of cycle-start morale ${initial}`, {
        operatorId, hour: validated.schedule.cycleHours
      }));
    }
    return {
      operatorId,
      initialMorale: initial,
      finalMorale: state.morale,
      scheduledWorkHours: state.scheduledWorkHours,
      productiveHours: state.productiveHours,
      uptime: state.scheduledWorkHours === 0 ? 1 : state.productiveHours / state.scheduledWorkHours,
      timeline: state.timeline
    };
  });

  const aggregateLedger = aggregateResourceLedgers(validated.ledgers);
  let currentGold = validated.startingGold;
  const goldTimeline: GoldTimelinePoint[] = [{ hour: 0, gold: currentGold }];
  validated.ledgers.forEach((ledger, index) => {
    const hour = validated.shifts[index].endHour;
    const nextGold = currentGold + ledger.goldNetChange;
    if (!Number.isFinite(nextGold)) {
      throw new RangeError(`gold inventory after shifts[${index}] at hour ${hour} must be finite`);
    }
    currentGold = nextGold;
    goldTimeline.push({ hour, gold: currentGold });
    if (currentGold < -calculationEpsilon) failures.push(failure("resource", "gold-prefix-underflow", `gold inventory is ${currentGold} at hour ${hour}`, { hour }));
  });
  let currentDrones = validated.startingDrones;
  let droneOverflow = 0;
  const droneTimeline: DroneTimelinePoint[] = [];
  validated.ledgers.forEach((ledger, index) => {
    const opening = currentDrones;
    const uncapped = currentDrones + ledger.dronesGenerated;
    const capped = Math.min(validated.droneCap, uncapped);
    const overflow = uncapped - capped;
    droneOverflow += overflow;
    currentDrones = capped - ledger.dronesUsed;
    const hour = validated.shifts[index].endHour;
    droneTimeline.push({
      hour,
      shiftId: validated.shifts[index].id,
      opening,
      generated: ledger.dronesGenerated,
      overflow,
      available: capped,
      used: ledger.dronesUsed,
      ending: currentDrones
    });
    if (currentDrones < -calculationEpsilon) {
      failures.push(failure(
        "resource",
        "drone-prefix-underflow",
        `drone inventory is ${currentDrones} at hour ${hour}`,
        { shiftId: validated.shifts[index].id, hour }
      ));
    }
  });
  if (Math.abs(currentDrones - validated.startingDrones) > validated.closureTolerance) {
    failures.push(failure(
      "cycle-closure",
      "drone-state-not-closed",
      `drone inventory ends at ${currentDrones} instead of cycle-start inventory ${validated.startingDrones}`,
      { hour: validated.schedule.cycleHours }
    ));
  }

  return freezeResult({
    sustainable: failures.length === 0,
    failures,
    operators,
    exchanges,
    aggregateLedger,
    gold: {
      starting: validated.startingGold,
      produced: aggregateLedger.goldProduced,
      consumed: aggregateLedger.goldConsumed,
      netChange: aggregateLedger.goldNetChange,
      ending: currentGold,
      timeline: goldTimeline
    },
    drones: {
      cap: validated.droneCap,
      starting: validated.startingDrones,
      generated: aggregateLedger.dronesGenerated,
      used: aggregateLedger.dronesUsed,
      overflow: droneOverflow,
      ending: currentDrones,
      timeline: droneTimeline
    }
  });
}
