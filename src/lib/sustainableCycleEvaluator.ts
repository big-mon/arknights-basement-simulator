import baseMechanics from "../data/optimizer-benchmarks/base-mechanics-2026-07.json";
import {
  validateBenchmarkBaseContext,
  type BenchmarkBaseContext
} from "./benchmarkBaseContext";
import {
  aggregateResourceLedgers,
  createResourceLedger,
  type ResourceLedger
} from "./resourceLedger";

export interface CycleFacilityAssignment {
  facilityId: string;
  operatorId: string;
  moraleConsumptionPerHour?: number;
  /** Declares that the caller's ledger already models production after morale reaches zero. */
  postZeroOutputModeled?: boolean;
}

export interface CycleShift {
  id: string;
  startHour: number;
  endHour: number;
  assignments: CycleFacilityAssignment[];
  resourceLedger: ResourceLedger;
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
  shifts: [CycleShift, CycleShift];
  initialMorale: Record<string, number>;
  recoveryPlacements: CycleRecoveryPlacement[];
  startingGold: number;
  baseContext?: BenchmarkBaseContext;
  moraleCap?: number;
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
const cycleHours = 24;
const shiftHours = 12;
const calculationEpsilon = 1e-12;

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

function intervalsOverlap(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): boolean {
  return Math.max(leftStart, rightStart) < Math.min(leftEnd, rightEnd) - calculationEpsilon;
}

function failure(category: CycleFailureCategory, code: string, message: string, details: Partial<CycleFailure> = {}): CycleFailure {
  return { category, code, message, ...details };
}

function validateLedger(ledger: ResourceLedger, path: string): ResourceLedger {
  if (typeof ledger !== "object" || ledger === null) throw new RangeError(`${path} resourceLedger must be an object`);
  let normalized: ResourceLedger;
  try {
    normalized = createResourceLedger({
      natural: ledger.natural,
      drone: ledger.drone,
      dronesGenerated: ledger.dronesGenerated,
      dronesUsed: ledger.dronesUsed
    });
  } catch (error) {
    throw new RangeError(`${path} resourceLedger is malformed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const fields = ["goldProduced", "goldConsumed", "goldNetChange", "battleRecordExp", "lmd"] as const;
  for (const field of fields) {
    if (typeof ledger[field] !== "number" || !Number.isFinite(ledger[field]) || Math.abs(ledger[field] - normalized[field]) > calculationEpsilon) {
      throw new RangeError(`${path} resourceLedger.${field} is inconsistent with its immutable contributions`);
    }
  }
  return normalized;
}

interface ValidatedInput {
  shifts: [CycleShift, CycleShift];
  placements: CycleRecoveryPlacement[];
  initialMorale: Map<string, number>;
  moraleCap: number;
  closureTolerance: number;
  startingGold: number;
  context?: BenchmarkBaseContext;
  ledgers: [ResourceLedger, ResourceLedger];
}

function validateInput(input: SustainableCycleInput): ValidatedInput {
  if (!input || !Array.isArray(input.shifts) || input.shifts.length !== 2) {
    throw new RangeError("shifts must contain fixed 12-hour shift A and shift B");
  }
  const expectedBoundaries = [[0, 12], [12, 24]] as const;
  const seenShiftIds = new Set<string>();
  const ledgers: ResourceLedger[] = [];
  input.shifts.forEach((shift, index) => {
    nonEmptyId(shift.id, `shifts[${index}].id`);
    if (seenShiftIds.has(shift.id)) throw new RangeError(`duplicate shift ID: ${shift.id}`);
    seenShiftIds.add(shift.id);
    if (shift.startHour !== expectedBoundaries[index][0] || shift.endHour !== expectedBoundaries[index][1]) {
      throw new RangeError(`shifts[${index}] must use fixed boundary ${expectedBoundaries[index][0]}..${expectedBoundaries[index][1]}`);
    }
    if (shift.endHour - shift.startHour !== shiftHours) throw new RangeError(`shifts[${index}] must be 12 hours`);
    if (!Array.isArray(shift.assignments)) throw new RangeError(`shifts[${index}].assignments must be an array`);
    shift.assignments.forEach((assignment, assignmentIndex) => {
      nonEmptyId(assignment.facilityId, `shifts[${index}].assignments[${assignmentIndex}].facilityId`);
      nonEmptyId(assignment.operatorId, `shifts[${index}].assignments[${assignmentIndex}].operatorId`);
      finiteNonNegative(
        assignment.moraleConsumptionPerHour ?? verifiedConsumptionRate,
        `shifts[${index}].assignments[${assignmentIndex}].moraleConsumptionPerHour`
      );
      if (assignment.postZeroOutputModeled !== undefined && typeof assignment.postZeroOutputModeled !== "boolean") {
        throw new RangeError(`shifts[${index}].assignments[${assignmentIndex}].postZeroOutputModeled must be boolean`);
      }
    });
    ledgers.push(validateLedger(shift.resourceLedger, `shifts[${index}]`));
  });

  const moraleCap = finiteNonNegative(input.moraleCap ?? verifiedMoraleCap, "moraleCap");
  if (moraleCap === 0) throw new RangeError("moraleCap must be positive");
  const closureTolerance = finiteNonNegative(input.cycleClosureTolerance ?? 1e-9, "cycleClosureTolerance");
  const startingGold = finiteNonNegative(input.startingGold, "startingGold");
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
    if (start < 0 || end > cycleHours || start >= end) throw new RangeError(`${path} interval must be within 0..24 with start < end`);
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

  let context: BenchmarkBaseContext | undefined;
  if (input.baseContext) {
    const validation = validateBenchmarkBaseContext(input.baseContext);
    if (!validation.ok) throw new RangeError(`baseContext is invalid: ${validation.errors.join("; ")}`);
    context = validation.value;
  }

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
    shifts: input.shifts,
    placements: input.recoveryPlacements,
    initialMorale,
    moraleCap,
    closureTolerance,
    startingGold,
    context,
    ledgers: ledgers as [ResourceLedger, ResourceLedger]
  };
}

function collectStructuralFailures(input: ValidatedInput): CycleFailure[] {
  const failures: CycleFailure[] = [];
  const facilityById = input.context ? new Map(input.context.facilities.map((item) => [item.id, item])) : undefined;
  const workersByShift: Array<Set<string>> = [];

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
      if (operators.has(assignment.operatorId)) failures.push(failure("overlap", "duplicate-operator-in-shift", `operator ${assignment.operatorId} is assigned more than once in shift ${shift.id}`, {
        shiftId: shift.id, operatorId: assignment.operatorId
      }));
      operators.add(assignment.operatorId);
      facilityOccupancy.set(assignment.facilityId, (facilityOccupancy.get(assignment.facilityId) ?? 0) + 1);
      if (facilityById && !facilityById.has(assignment.facilityId)) failures.push(failure("overlap", "unknown-facility", `unknown facility ${assignment.facilityId}`, {
        shiftId: shift.id, facilityId: assignment.facilityId, operatorId: assignment.operatorId
      }));
    }
    for (const [facilityId, count] of facilityOccupancy) {
      const facility = facilityById?.get(facilityId);
      if (facility && count > facility.slotCount) failures.push(failure("overlap", "facility-slot-overflow", `${facilityId} has ${count} assignments for ${facility.slotCount} slots`, {
        shiftId: shift.id, facilityId
      }));
    }
    workersByShift.push(operators);
  });
  for (const operatorId of workersByShift[0]) {
    if (workersByShift[1].has(operatorId)) failures.push(failure("overlap", "cross-group-worker-reuse", `operator ${operatorId} appears in both work groups`, { operatorId }));
  }

  const dormitories = input.context?.facilities.filter((facility) => facility.type === "dormitory") ?? [];
  const dormById = new Map(dormitories.map((dorm) => [dorm.id, dorm]));
  for (const placement of input.placements) {
    if (input.context && !dormById.has(placement.dormitoryId)) failures.push(failure("dormitory", "unknown-dormitory", `unknown dormitory ${placement.dormitoryId}`, {
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
  const occupancyBoundaries = [...new Set([0, cycleHours, ...input.placements.flatMap((item) => [item.startHour, item.endHour])])].sort((a, b) => a - b);
  for (let index = 0; index < occupancyBoundaries.length - 1; index += 1) {
    const start = occupancyBoundaries[index];
    const end = occupancyBoundaries[index + 1];
    if (end - start <= calculationEpsilon) continue;
    const active = input.placements.filter((item) => item.startHour < end && item.endHour > start);
    const byDorm = new Map<string, number>();
    active.forEach((item) => byDorm.set(item.dormitoryId, (byDorm.get(item.dormitoryId) ?? 0) + 1));
    for (const [dormitoryId, count] of byDorm) {
      const capacity = dormById.get(dormitoryId)?.slotCount ?? (input.context ? 0 : 5);
      if (count > capacity) failures.push(failure("dormitory", "dormitory-overflow", `${dormitoryId} has ${count} occupants for ${capacity} beds`, {
        dormitoryId, hour: start
      }));
    }
    if (input.context && active.length > dormitories.reduce((total, dorm) => total + dorm.slotCount, 0)) {
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
      const timeToZero = consumption === 0 ? Number.POSITIVE_INFINITY : state.morale / consumption;
      const duration = Math.min(availableDuration, timeToZero);
      const endMorale = Math.max(0, state.morale - consumption * duration);
      const modeledAfterZero = work.assignment.postZeroOutputModeled === true;
      const segmentDuration = duration > calculationEpsilon ? duration : availableDuration;
      state.productiveHours += modeledAfterZero ? segmentDuration : duration;
      pushSegment(state, {
        startHour: cursor,
        endHour: cursor + segmentDuration,
        mode: "work",
        startMorale: state.morale,
        endMorale: duration > calculationEpsilon ? endMorale : state.morale,
        ratePerHour: duration > calculationEpsilon ? -consumption : 0,
        facilityId: work.assignment.facilityId
      });
      state.morale = endMorale;
      cursor += segmentDuration;
      if (state.morale <= calculationEpsilon && cursor < work.shift.endHour - calculationEpsilon) {
        const key = `${work.shift.id}\u0000${operatorId}`;
        if (!modeledAfterZero && !fatigueKeys.has(key)) {
          fatigueKeys.add(key);
          failures.push(failure("morale", "fatigued-before-shift-end", `operator ${operatorId} reaches zero morale before shift ${work.shift.id} ends`, {
            operatorId, shiftId: work.shift.id, hour: cursor
          }));
        }
      }
      continue;
    }
    if (recovery) {
      const baseRate = recovery.recoveryRatePerHour ?? verifiedDormitoryRecoveryRate;
      const activeModifiers = (recovery.conditionalModifiers ?? []).filter((modifier) => state.morale < modifier.moraleAtMost - calculationEpsilon);
      const rate = baseRate + activeModifiers.reduce((total, modifier) => total + modifier.additionalRatePerHour, 0);
      const nextThreshold = activeModifiers
        .map((modifier) => modifier.moraleAtMost)
        .filter((threshold) => threshold > state.morale + calculationEpsilon)
        .sort((a, b) => a - b)[0];
      const nextMoraleBoundary = Math.min(input.moraleCap, nextThreshold ?? input.moraleCap);
      const timeToBoundary = rate === 0 || state.morale >= input.moraleCap - calculationEpsilon
        ? Number.POSITIVE_INFINITY
        : (nextMoraleBoundary - state.morale) / rate;
      const duration = Math.min(intervalEnd - cursor, Math.max(0, timeToBoundary));
      const actualDuration = duration > calculationEpsilon ? duration : intervalEnd - cursor;
      const effectiveRate = duration > calculationEpsilon ? rate : 0;
      const endMorale = Math.min(input.moraleCap, state.morale + effectiveRate * actualDuration);
      pushSegment(state, {
        startHour: cursor,
        endHour: cursor + actualDuration,
        mode: "recovery",
        startMorale: state.morale,
        endMorale,
        ratePerHour: effectiveRate,
        dormitoryId: recovery.dormitoryId
      });
      state.morale = endMorale;
      cursor += actualDuration;
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
  const useWindow = Math.floor(event.atHour / shiftHours);
  const sourceUseKey = `${useWindow}\u0000${event.sourceOperatorId}`;
  let valid = true;
  if (Math.abs(sourceState.morale - input.moraleCap) > input.closureTolerance) {
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
  const disallowedStart = Math.max(0, targetPlacement.startHour - shiftHours);
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

function freezeResult(result: SustainableCycleResult): SustainableCycleResult {
  const operators = Object.freeze(result.operators.map((operator) => Object.freeze({
    ...operator,
    timeline: Object.freeze(operator.timeline.map((segment) => Object.freeze({ ...segment })))
  })));
  const failures = Object.freeze(result.failures.map((item) => Object.freeze({ ...item })));
  const exchanges = Object.freeze(result.exchanges.map((item) => Object.freeze({ ...item })));
  const timeline = Object.freeze(result.gold.timeline.map((point) => Object.freeze({ ...point })));
  return Object.freeze({ ...result, operators, failures, exchanges, gold: Object.freeze({ ...result.gold, timeline }) });
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
    cycleHours,
    ...validated.shifts.flatMap((shift) => [shift.startHour, shift.endHour]),
    ...validated.placements.flatMap((placement) => [placement.startHour, placement.endHour]),
    ...exchangePlacements.map((placement) => placement.moraleExchange!.atHour)
  ])].sort((left, right) => left - right);
  const usedSources = new Set<string>();
  const fatigueKeys = new Set<string>();
  const exchanges: AppliedMoraleExchange[] = [];
  for (let index = 0; index < boundaries.length; index += 1) {
    const boundary = boundaries[index];
    for (const placement of exchangePlacements.filter((item) => item.moraleExchange!.atHour === boundary)) {
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
        operatorId, hour: cycleHours
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
    currentGold += ledger.goldNetChange;
    const hour = validated.shifts[index].endHour;
    goldTimeline.push({ hour, gold: currentGold });
    if (currentGold < -calculationEpsilon) failures.push(failure("resource", "gold-prefix-underflow", `gold inventory is ${currentGold} at hour ${hour}`, { hour }));
  });
  if (aggregateLedger.goldNetChange < -calculationEpsilon) failures.push(failure("resource", "negative-daily-gold-net", `daily gold net change ${aggregateLedger.goldNetChange} is negative`));

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
    }
  });
}
