import type { Assignment, AssignmentPlan, BaseLayout, RotationWindow } from "../types";
import { createMaxLevel243BenchmarkContext } from "./benchmarkBaseContext";
import {
  aggregateResourceLedgers,
  createResourceLedger,
  scaleResourceLedger,
  type ResourceLedger
} from "./resourceLedger";
import {
  evaluateSustainableCycle,
  type CycleRecoveryPlacement,
  type CycleFacilityResourceContribution,
  type CycleShift,
  type SustainableCycleInput
} from "./sustainableCycleEvaluator";
import type {
  PlanSustainabilityAssumptions,
  PlanSustainabilityEvaluation,
  PlanSustainabilityMissingReason
} from "./planSustainabilityTypes";

export type {
  EvaluatedPlanSustainability,
  IncompletePlanSustainability,
  PlanSustainabilityAssumptions,
  PlanSustainabilityConvergence,
  PlanSustainabilityEvaluation,
  PlanSustainabilityMissingCode,
  PlanSustainabilityMissingReason
} from "./planSustainabilityTypes";

type PlanInput = Omit<AssignmentPlan, "sustainability"> & Partial<Pick<AssignmentPlan, "sustainability">>;

export interface PlanSustainabilityEvaluationInput {
  plan: PlanInput;
  layout: BaseLayout;
}

const fixedPointTolerance = 1e-9;
const fixedPointIterationLimit = 256;
const resourceAggregateEpsilon = 1e-9;
const moraleCap = 24;

const assumptions = Object.freeze<PlanSustainabilityAssumptions>({
  startingGold: 0,
  moraleCap,
  baseContext: "max-level-243-verified-4x5-dormitories",
  droneDistributionPolicy: "duration-proportional-from-strict-slot-batch-plan-ledger",
  recoveryPackingPolicy: "deterministic-interval-aware-first-fit-4x5",
  exchangeEventBoundary: "recovery-placement-start",
  fixedPointMethod: "successive-cycle-final-morale",
  fixedPointTolerance,
  fixedPointIterationLimit,
  resourceAggregateEpsilon
});

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function incomplete(missing: PlanSustainabilityMissingReason[]): PlanSustainabilityEvaluation {
  return Object.freeze({
    status: "incomplete",
    assumptions,
    missing: Object.freeze(missing.map((reason) => Object.freeze({ ...reason })))
  });
}

function idsFromPath(path: string): Pick<PlanSustainabilityMissingReason, "shiftId" | "groupId"> {
  const parts = path.split("/");
  const rotationIndex = parts.indexOf("rotation");
  const groupsIndex = parts.indexOf("groups");
  return {
    ...(rotationIndex >= 0 && parts[rotationIndex + 1] ? { shiftId: parts[rotationIndex + 1] } : {}),
    ...(groupsIndex >= 0 && parts[groupsIndex + 1] ? { groupId: parts[groupsIndex + 1] } : {})
  };
}

function compareLedger(left: ResourceLedger, right: ResourceLedger): boolean {
  const fields = ["goldProduced", "goldConsumed", "goldNetChange", "battleRecordExp", "lmd", "dronesGenerated", "dronesUsed"] as const;
  const contributionFields = ["goldProduced", "goldConsumed", "battleRecordExp", "lmd"] as const;
  return fields.every((field) => Math.abs(left[field] - right[field]) <= resourceAggregateEpsilon) &&
    contributionFields.every((field) =>
      Math.abs(left.natural[field] - right.natural[field]) <= resourceAggregateEpsilon &&
      Math.abs(left.drone[field] - right.drone[field]) <= resourceAggregateEpsilon
    );
}

function actualWorkers(window: RotationWindow): Assignment[] {
  return window.assignments
    .filter((assignment) => !assignment.doesNotConsumeFacilitySlot)
    .map((assignment) => ({ ...assignment }))
    .sort((left, right) =>
      left.facilityId.localeCompare(right.facilityId) || left.operatorId.localeCompare(right.operatorId) || left.skillId.localeCompare(right.skillId)
    );
}

interface WorkOccurrence {
  assignment: Assignment;
  shiftIndex: number;
  startHour: number;
  endHour: number;
  groupIds: readonly string[];
}

interface RecoveryEvent {
  operatorId: string;
  startHour: number;
  endHour: number;
  groupKey: string;
  assignment: Assignment;
  helperIds: string[];
  exclusiveHelperIds: string[];
  exchangeSourceId?: string;
  applyExchangeAtStart?: boolean;
}

function rateAt(assignment: Assignment, morale: number): number {
  const provenance = assignment.recoveryProvenance!;
  return provenance.baseRecoveryRatePerHour + provenance.conditionalModifiers
    .filter((modifier) => morale < modifier.moraleAtMost - 1e-12)
    .reduce((total, modifier) => total + modifier.additionalRatePerHour, 0);
}

function requiredRecoveryHours(assignment: Assignment, workHours: number): number {
  if (assignment.moraleExchangeApplied) return 0;
  const consumption = assignment.moraleConsumptionPerHour!;
  let morale = Math.max(0, moraleCap - consumption * workHours);
  let hours = 0;
  while (morale < moraleCap - 1e-12) {
    const thresholds = assignment.recoveryProvenance!.conditionalModifiers
      .map((modifier) => modifier.moraleAtMost)
      .filter((threshold) => threshold > morale + 1e-12)
      .sort((left, right) => left - right);
    const boundary = Math.min(moraleCap, thresholds[0] ?? moraleCap);
    const rate = rateAt(assignment, morale);
    if (!(rate > 0) || !Number.isFinite(rate)) return Number.POSITIVE_INFINITY;
    hours += (boundary - morale) / rate;
    morale = boundary;
  }
  return hours;
}

function cyclicIdleSegments(occurrences: readonly WorkOccurrence[], index: number, cycleHours: number): Array<[number, number]> {
  const current = occurrences[index];
  const next = occurrences[(index + 1) % occurrences.length];
  if (index < occurrences.length - 1) return current.endHour < next.startHour ? [[current.endHour, next.startHour]] : [];
  const result: Array<[number, number]> = [];
  if (current.endHour < cycleHours) result.push([current.endHour, cycleHours]);
  if (next.startHour > 0) result.push([0, next.startHour]);
  return result;
}

function buildRecoveryEvents(works: readonly WorkOccurrence[], cycleHours: number): RecoveryEvent[] {
  const byOperator = new Map<string, WorkOccurrence[]>();
  for (const occurrence of works) {
    const operatorWorks = byOperator.get(occurrence.assignment.operatorId) ?? [];
    operatorWorks.push(occurrence);
    byOperator.set(occurrence.assignment.operatorId, operatorWorks);
  }
  const events: RecoveryEvent[] = [];
  for (const [operatorId, operatorWorks] of [...byOperator].sort(([left], [right]) => left.localeCompare(right))) {
    operatorWorks.sort((left, right) => left.startHour - right.startHour || left.shiftIndex - right.shiftIndex);
    operatorWorks.forEach((work, index) => {
      const idle = cyclicIdleSegments(operatorWorks, index, cycleHours);
      let remaining = work.assignment.moraleExchangeApplied
        ? idle.reduce((total, [start, end]) => total + end - start, 0)
        : requiredRecoveryHours(work.assignment, work.endHour - work.startHour);
      const exchangeSourceId = work.assignment.moraleExchangeApplied
        ? work.assignment.moraleExchangeSourceOperatorId
        : undefined;
      let exchangePending = Boolean(exchangeSourceId);
      for (const [start, end] of idle) {
        if (remaining <= 1e-12) break;
        const duration = Math.min(end - start, remaining);
        if (duration <= 1e-12) continue;
        const helperIds = work.assignment.recoveryProvenance!.sources
          .filter((source) => source.occupiesDormitorySlot && source.operatorId !== operatorId)
          .map((source) => source.operatorId);
        const exclusiveHelperIds = work.assignment.recoveryProvenance!.sources
          .filter((source) => source.occupiesDormitorySlot && source.allocation === "single-other-exclusive")
          .map((source) => source.operatorId);
        if (exchangeSourceId && exchangeSourceId !== operatorId) helperIds.push(exchangeSourceId);
        events.push({
          operatorId,
          startHour: start,
          endHour: start + duration,
          groupKey: work.groupIds.join("+"),
          assignment: work.assignment,
          helperIds: [...new Set(helperIds)].sort(),
          exclusiveHelperIds: [...new Set(exclusiveHelperIds)].sort(),
          ...(exchangeSourceId ? { exchangeSourceId } : {}),
          ...(exchangePending ? { applyExchangeAtStart: true } : {})
        });
        exchangePending = false;
        remaining -= duration;
      }
    });
  }
  return events.sort((left, right) =>
    left.startHour - right.startHour || left.groupKey.localeCompare(right.groupKey) || left.operatorId.localeCompare(right.operatorId)
  );
}

function intervalsOverlap(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): boolean {
  return Math.max(leftStart, rightStart) < Math.min(leftEnd, rightEnd) - 1e-12;
}

function mergeHelperPlacement(
  placements: CycleRecoveryPlacement[],
  dormitoryId: string,
  operatorId: string,
  startHour: number,
  endHour: number
) {
  const mergeIndexes = placements.flatMap((placement, index) =>
    placement.dormitoryId === dormitoryId && placement.operatorId === operatorId &&
    Math.max(placement.startHour, startHour) <= Math.min(placement.endHour, endHour) + 1e-12 ? [index] : []
  );
  if (mergeIndexes.length === 0) {
    placements.push({ dormitoryId, operatorId, startHour, endHour, recoveryRatePerHour: 4 });
    return;
  }
  const mergedStart = Math.min(startHour, ...mergeIndexes.map((index) => placements[index].startHour));
  const mergedEnd = Math.max(endHour, ...mergeIndexes.map((index) => placements[index].endHour));
  const existingTarget = mergeIndexes.map((index) => placements[index]).find((placement) => placement.conditionalModifiers !== undefined);
  for (const index of mergeIndexes.sort((left, right) => right - left)) placements.splice(index, 1);
  placements.push(existingTarget
    ? { ...existingTarget, startHour: mergedStart, endHour: mergedEnd }
    : { dormitoryId, operatorId, startHour: mergedStart, endHour: mergedEnd, recoveryRatePerHour: 4 });
}

function placementsAreFeasible(placements: readonly CycleRecoveryPlacement[]): boolean {
  for (let leftIndex = 0; leftIndex < placements.length; leftIndex += 1) {
    const left = placements[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < placements.length; rightIndex += 1) {
      const right = placements[rightIndex];
      if (left.operatorId === right.operatorId && left.dormitoryId !== right.dormitoryId &&
          intervalsOverlap(left.startHour, left.endHour, right.startHour, right.endHour)) return false;
    }
  }
  for (const dormitoryId of ["dormitory-1", "dormitory-2", "dormitory-3", "dormitory-4"]) {
    const dormPlacements = placements.filter((placement) => placement.dormitoryId === dormitoryId);
    const boundaries = [...new Set(dormPlacements.flatMap((placement) => [placement.startHour, placement.endHour]))].sort((a, b) => a - b);
    for (let index = 0; index < boundaries.length - 1; index += 1) {
      const midpoint = (boundaries[index] + boundaries[index + 1]) / 2;
      const occupants = new Set(dormPlacements
        .filter((placement) => placement.startHour < midpoint && placement.endHour > midpoint)
        .map((placement) => placement.operatorId));
      if (occupants.size > 5) return false;
    }
  }
  return true;
}

type RecoveryPackingResult =
  | { status: "packed"; placements: CycleRecoveryPlacement[] }
  | { status: "incomplete"; missing: PlanSustainabilityMissingReason };

function packRecovery(events: readonly RecoveryEvent[]): RecoveryPackingResult {
  let placements: CycleRecoveryPlacement[] = [];
  const exclusiveUses = new Map<string, Array<{ startHour: number; endHour: number; operatorId: string }>>();
  for (const event of events) {
    let selected: { placements: CycleRecoveryPlacement[]; dormitoryId: string } | undefined;
    for (const dormitoryId of ["dormitory-1", "dormitory-2", "dormitory-3", "dormitory-4"]) {
      if (event.exclusiveHelperIds.some((helperId) =>
        (exclusiveUses.get(helperId) ?? []).some((use) =>
          use.operatorId !== event.operatorId && intervalsOverlap(use.startHour, use.endHour, event.startHour, event.endHour)
        )
      )) continue;
      const candidate = placements.map((placement) => ({ ...placement }));
      const targetPlacement: CycleRecoveryPlacement = {
        dormitoryId,
        operatorId: event.operatorId,
        startHour: event.startHour,
        endHour: event.endHour,
        recoveryRatePerHour: event.assignment.recoveryProvenance!.baseRecoveryRatePerHour,
        conditionalModifiers: event.assignment.recoveryProvenance!.conditionalModifiers.map((modifier) => ({
          moraleAtMost: modifier.moraleAtMost,
          additionalRatePerHour: modifier.additionalRatePerHour
        })),
        ...(event.applyExchangeAtStart && event.exchangeSourceId
          ? { moraleExchange: { atHour: event.startHour, sourceOperatorId: event.exchangeSourceId } }
          : {})
      };
      const targetMergeIndexes = candidate.flatMap((placement, index) =>
        placement.dormitoryId === dormitoryId && placement.operatorId === event.operatorId &&
        Math.max(placement.startHour, targetPlacement.startHour) <= Math.min(placement.endHour, targetPlacement.endHour) + 1e-12 ? [index] : []
      );
      if (targetMergeIndexes.length > 0) {
        targetPlacement.startHour = Math.min(targetPlacement.startHour, ...targetMergeIndexes.map((index) => candidate[index].startHour));
        targetPlacement.endHour = Math.max(targetPlacement.endHour, ...targetMergeIndexes.map((index) => candidate[index].endHour));
        for (const index of targetMergeIndexes.sort((left, right) => right - left)) candidate.splice(index, 1);
      }
      candidate.push(targetPlacement);
      for (const helperId of event.helperIds) mergeHelperPlacement(candidate, dormitoryId, helperId, event.startHour, event.endHour);
      if (placementsAreFeasible(candidate)) {
        selected = { placements: candidate, dormitoryId };
        break;
      }
    }
    if (!selected) {
      const sourceOperatorId = event.exclusiveHelperIds[0] ?? event.helperIds[0];
      return {
        status: "incomplete",
        missing: {
          code: "recovery-allocation-unavailable",
          path: `recovery/${event.startHour}-${event.endHour}/${event.operatorId}`,
          message: `No interval-feasible dormitory allocation preserves recovery provenance for ${event.operatorId}`,
          operatorId: event.operatorId,
          ...(sourceOperatorId ? { sourceOperatorId } : {})
        }
      };
    }
    placements = selected.placements;
    for (const helperId of event.exclusiveHelperIds) {
      const uses = exclusiveUses.get(helperId) ?? [];
      uses.push({ startHour: event.startHour, endHour: event.endHour, operatorId: event.operatorId });
      exclusiveUses.set(helperId, uses);
    }
  }
  placements.sort((left, right) =>
    left.startHour - right.startHour || left.dormitoryId.localeCompare(right.dormitoryId) || left.operatorId.localeCompare(right.operatorId)
  );
  return { status: "packed", placements };
}

function evaluateInternal({ plan, layout }: PlanSustainabilityEvaluationInput): PlanSustainabilityEvaluation {
  const missing: PlanSustainabilityMissingReason[] = [];
  if (layout !== "243") {
    missing.push({ code: "unsupported-layout", path: "layout", message: `Layout ${layout} is not the verified max-level 243 context` });
    return incomplete(missing);
  }
  const baseContext = createMaxLevel243BenchmarkContext();
  const canonicalFacilities = new Map(baseContext.facilities.map((facility) => [facility.id, facility]));
  for (const facilityPlan of plan.facilityPlans) {
    const canonical = canonicalFacilities.get(facilityPlan.facility.id);
    if (!canonical || canonical.type !== facilityPlan.facility.type || canonical.slotCount !== facilityPlan.facility.slotCount ||
        (canonical.type === "factory" && canonical.product !== facilityPlan.facility.product)) {
      missing.push({
        code: "unsupported-base-context",
        path: `facilityPlans/${facilityPlan.facility.id}/facility`,
        message: `Facility ${facilityPlan.facility.id} does not match the verified max-level 243 context`,
        facilityId: facilityPlan.facility.id
      });
    }
  }
  if (missing.length > 0) return incomplete(missing);
  if (plan.resources.status !== "complete" || !plan.resources.cycleLedger || !plan.resources.drone) {
    for (const reason of plan.resources.missing) {
      missing.push({
        code: "plan-resources-incomplete",
        path: `resources/${reason.path}`,
        message: reason.message,
        ...idsFromPath(reason.path),
        ...(reason.operatorId ? { operatorId: reason.operatorId } : {})
      });
    }
    if (missing.length === 0) missing.push({ code: "plan-resources-incomplete", path: "resources", message: "Plan resources are incomplete" });
    return incomplete(missing);
  }
  if (plan.resources.assumptions.allocationTimingAssumption !== "slot-batch-consumption" ||
      plan.resources.drone.semantics.allocationTimingAssumption !== "slot-batch-consumption") {
    return incomplete([{
      code: "drone-resource-timing-unrepresentable",
      path: "resources/drone/semantics/allocationTimingAssumption",
      message: "Drone timing is not backed by the accepted slot-batch plan resource ledger"
    }]);
  }

  const windowsById = new Map(plan.rotation.map((window) => [window.shiftId, window]));
  const resourceWindowsById = new Map(plan.resources.windows.map((window) => [window.shiftId, window]));
  if (windowsById.size !== plan.rotation.length || plan.rotation.length !== plan.schedule.shifts.length) {
    missing.push({ code: "rotation-window-mismatch", path: "rotation", message: "Rotation windows must map one-to-one to canonical schedule shifts" });
  }
  if (resourceWindowsById.size !== plan.resources.windows.length || plan.resources.windows.length !== plan.schedule.shifts.length) {
    missing.push({ code: "rotation-window-mismatch", path: "resources/windows", message: "Resource windows must map one-to-one to canonical schedule shifts" });
  }
  const cycleShifts: CycleShift[] = [];
  const works: WorkOccurrence[] = [];
  for (const [shiftIndex, shift] of plan.schedule.shifts.entries()) {
    const window = windowsById.get(shift.id);
    if (!window) {
      missing.push({ code: "rotation-window-missing", path: `rotation/${shift.id}`, message: `Rotation window ${shift.id} is missing`, shiftId: shift.id });
      continue;
    }
    if (window.startHour !== shift.startHour || window.endHour !== shift.endHour ||
        window.activeGroupIds.length !== shift.activeGroupIds.length ||
        window.activeGroupIds.some((id, index) => id !== shift.activeGroupIds[index])) {
      missing.push({ code: "rotation-window-mismatch", path: `rotation/${shift.id}`, message: `Rotation window ${shift.id} does not match the canonical schedule`, shiftId: shift.id });
      continue;
    }
    for (const groupId of window.incompleteGroupIds) missing.push({
      code: "rotation-window-incomplete",
      path: `rotation/${shift.id}/groups/${groupId}`,
      message: `Rotation window ${shift.id} has unpopulated group ${groupId}`,
      shiftId: shift.id,
      groupId
    });
    const resourceWindow = resourceWindowsById.get(shift.id);
    if (!resourceWindow) {
      missing.push({ code: "rotation-window-missing", path: `resources/windows/${shift.id}`, message: `Resource window ${shift.id} is missing`, shiftId: shift.id });
      continue;
    }
    const workers = actualWorkers(window);
    for (const worker of workers) {
      if (!canonicalFacilities.has(worker.facilityId)) {
        missing.push({
          code: "unsupported-base-context",
          path: `rotation/${shift.id}/assignments/${worker.operatorId}/facilityId`,
          message: `Facility ${worker.facilityId} is not in the verified max-level 243 context`,
          operatorId: worker.operatorId,
          facilityId: worker.facilityId,
          shiftId: shift.id
        });
      }
      if (typeof worker.moraleConsumptionPerHour !== "number" || !Number.isFinite(worker.moraleConsumptionPerHour)) {
        missing.push({
          code: "morale-consumption-unavailable",
          path: `rotation/${shift.id}/assignments/${worker.operatorId}/moraleConsumptionPerHour`,
          message: `Morale consumption provenance is unavailable for ${worker.operatorId}`,
          operatorId: worker.operatorId,
          facilityId: worker.facilityId,
          shiftId: shift.id
        });
      }
      if (!worker.recoveryProvenance) {
        missing.push({
          code: "recovery-provenance-unavailable",
          path: `rotation/${shift.id}/assignments/${worker.operatorId}/recoveryProvenance`,
          message: `Recovery provenance is unavailable for ${worker.operatorId}`,
          operatorId: worker.operatorId,
          facilityId: worker.facilityId,
          shiftId: shift.id
        });
      }
      if (worker.moraleExchangeApplied && !worker.moraleExchangeSourceOperatorId) {
        missing.push({
          code: "morale-exchange-source-unavailable",
          path: `rotation/${shift.id}/assignments/${worker.operatorId}/moraleExchangeSourceOperatorId`,
          message: `Full-morale exchange source provenance is unavailable for ${worker.operatorId}`,
          operatorId: worker.operatorId,
          facilityId: worker.facilityId,
          shiftId: shift.id
        });
      }
      if (worker.moraleExchangeSourceOperatorId &&
          !worker.recoveryProvenance?.sources.some((source) => source.operatorId === worker.moraleExchangeSourceOperatorId && source.ownedAtEvaluation)) {
        missing.push({
          code: "morale-exchange-source-not-owned",
          path: `rotation/${shift.id}/assignments/${worker.operatorId}/recoveryProvenance/sources/${worker.moraleExchangeSourceOperatorId}`,
          message: `Exchange source ${worker.moraleExchangeSourceOperatorId} is not explicitly owned in recovery provenance`,
          operatorId: worker.operatorId,
          sourceOperatorId: worker.moraleExchangeSourceOperatorId,
          shiftId: shift.id
        });
      }
    }
    const droneShare = scaleResourceLedger(plan.resources.drone.per24Ledger, (shift.endHour - shift.startHour) / 24);
    const contributionByFacility = new Map<string, CycleFacilityResourceContribution>();
    for (const facility of resourceWindow.facilities) {
      contributionByFacility.set(facility.facilityId, {
        id: `${shift.id}:${facility.facilityId}:natural`,
        facilityId: facility.facilityId,
        kind: facility.facilityType === "trading"
          ? "trading-post"
          : facility.product === "gold" ? "factory-gold" : "factory-battle-record",
        ledger: facility.ledger
      });
    }
    if (droneShare.dronesUsed !== 0 || Object.values(droneShare.drone).some((value) => value !== 0)) {
      const targetFacilityId = plan.resources.drone.targetFacilityId;
      const target = targetFacilityId ? contributionByFacility.get(targetFacilityId) : undefined;
      if (!target || target.kind !== "trading-post") {
        missing.push({
          code: "drone-resource-timing-unrepresentable",
          path: `resources/windows/${shift.id}/drone-target`,
          message: `Drone target ${targetFacilityId ?? "missing"} has no facility-owned trading contribution in shift ${shift.id}`,
          shiftId: shift.id,
          ...(targetFacilityId ? { facilityId: targetFacilityId } : {})
        });
      } else {
        target.ledger = aggregateResourceLedgers([
          target.ledger,
          createResourceLedger({ drone: droneShare.drone, dronesUsed: droneShare.dronesUsed })
        ]);
      }
    }
    if (droneShare.dronesGenerated !== 0) {
      const powerFacilityId = workers.find((worker) => canonicalFacilities.get(worker.facilityId)?.type === "power")?.facilityId ??
        [...canonicalFacilities.values()].filter((facility) => facility.type === "power").sort((left, right) => left.id.localeCompare(right.id))[0]?.id;
      if (!powerFacilityId) {
        missing.push({
          code: "drone-resource-timing-unrepresentable",
          path: `rotation/${shift.id}/power-source`,
          message: `Shift ${shift.id} has generated drones without a selected power-facility assignment`,
          shiftId: shift.id
        });
      } else {
        contributionByFacility.set(powerFacilityId, {
          id: `${shift.id}:${powerFacilityId}:drone-generation`,
          facilityId: powerFacilityId,
          kind: "power-drone",
          ledger: createResourceLedger({ dronesGenerated: droneShare.dronesGenerated })
        });
      }
    }
    const cycleAssignments = workers.map((worker) => ({
      facilityId: worker.facilityId,
      operatorId: worker.operatorId,
      moraleConsumptionPerHour: worker.moraleConsumptionPerHour
    }));
    for (const facilityId of contributionByFacility.keys()) {
      if (!cycleAssignments.some((assignment) => assignment.facilityId === facilityId)) {
        cycleAssignments.push({
          facilityId,
          operatorId: `resource-witness:${shift.id}:${facilityId}`,
          moraleConsumptionPerHour: 0
        });
      }
    }
    cycleShifts.push({
      id: shift.id,
      startHour: shift.startHour,
      endHour: shift.endHour,
      groupIds: [...shift.activeGroupIds],
      assignments: cycleAssignments,
      resourceContributions: [...contributionByFacility.values()].sort((left, right) => left.id.localeCompare(right.id))
    });
    workers.forEach((worker) => works.push({
      assignment: worker,
      shiftIndex,
      startHour: shift.startHour,
      endHour: shift.endHour,
      groupIds: shift.activeGroupIds
    }));
  }
  if (missing.length > 0) return incomplete(missing);
  const aggregate = aggregateResourceLedgers(cycleShifts.flatMap((shift) =>
    shift.resourceContributions.map((contribution) => contribution.ledger)
  ));
  if (!compareLedger(aggregate, plan.resources.cycleLedger)) return incomplete([{
    code: "resource-ledger-aggregate-mismatch",
    path: "resources/cycleLedger",
    message: "Per-shift natural ledgers and proportional drone shares do not aggregate to plan.resources.cycleLedger"
  }]);

  const recoveryEvents = buildRecoveryEvents(works, plan.schedule.cycleHours);
  for (const event of recoveryEvents) {
    const overlappingSource = event.helperIds.find((helperId) => works.some((work) =>
      work.assignment.operatorId === helperId && intervalsOverlap(event.startHour, event.endHour, work.startHour, work.endHour)
    ));
    if (overlappingSource) return incomplete([{
      code: "recovery-allocation-unavailable",
      path: `recovery/${event.startHour}-${event.endHour}/${event.operatorId}/sources/${overlappingSource}`,
      message: `Recovery source ${overlappingSource} is assigned to work while ${event.operatorId} depends on it`,
      operatorId: event.operatorId,
      sourceOperatorId: overlappingSource
    }]);
  }
  const packedRecovery = packRecovery(recoveryEvents);
  if (packedRecovery.status === "incomplete") return incomplete([packedRecovery.missing]);
  const recoveryPlacements = packedRecovery.placements;
  const operatorIds = [...new Set([
    ...cycleShifts.flatMap((shift) => shift.assignments.map((assignment) => assignment.operatorId)),
    ...recoveryPlacements.flatMap((placement) => [placement.operatorId, ...(placement.moraleExchange ? [placement.moraleExchange.sourceOperatorId] : [])])
  ])].sort();
  let candidate = Object.fromEntries(operatorIds.map((operatorId) => [operatorId, moraleCap]));
  let maximumDelta = Number.POSITIVE_INFINITY;
  let iterations = 0;
  const inputBase = {
    schedule: structuredClone(plan.schedule),
    shifts: cycleShifts,
    recoveryPlacements,
    startingGold: 0,
    startingDrones: plan.resources.assumptions.initialDrones,
    baseContext,
    moraleCap,
    cycleClosureTolerance: fixedPointTolerance
  };
  for (iterations = 1; iterations <= fixedPointIterationLimit; iterations += 1) {
    const result = evaluateSustainableCycle({ ...inputBase, initialMorale: candidate });
    const next = Object.fromEntries(result.operators.map((operator) => [operator.operatorId, operator.finalMorale]));
    maximumDelta = operatorIds.reduce((largest, operatorId) => Math.max(largest, Math.abs(next[operatorId] - candidate[operatorId])), 0);
    candidate = next;
    if (maximumDelta <= fixedPointTolerance) break;
  }
  if (maximumDelta > fixedPointTolerance || iterations > fixedPointIterationLimit) return incomplete([{
    code: "morale-fixed-point-not-converged",
    path: "morale/fixed-point",
    message: `Morale fixed point did not converge within ${fixedPointIterationLimit} iterations`
  }]);

  const authoritativeInput: SustainableCycleInput = { ...inputBase, initialMorale: candidate };
  const result = evaluateSustainableCycle(authoritativeInput);
  return deepFreeze({
    status: "evaluated",
    assumptions,
    convergence: {
      iterations,
      tolerance: fixedPointTolerance,
      maximumDelta,
      initialMorale: { ...candidate }
    },
    input: structuredClone(authoritativeInput),
    result,
    missing: [] as const
  });
}

export function evaluatePlanSustainability(input: PlanSustainabilityEvaluationInput): PlanSustainabilityEvaluation {
  try {
    return evaluateInternal(input);
  } catch (error) {
    return incomplete([{
      code: "sustainable-cycle-evaluator-error",
      path: "sustainable-cycle-evaluator",
      message: error instanceof Error ? error.message : String(error)
    }]);
  }
}
