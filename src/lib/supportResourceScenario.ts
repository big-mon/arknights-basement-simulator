import type {
  AppState,
  AssignmentPlan,
  SupportResourceDiagnostic,
  SupportResourceScenarioEvaluation,
  SupportResourceScenarioInput,
  SupportResourceSource,
  SupportFacilityType
} from "../types";
import { operators } from "../data/defaults";
import { isOperatorAvailable, operatorAvailabilitySnapshot } from "./operatorAvailability";
import { modeledFacilityLevel } from "./facilityLevel";
import { activeBaseSkills } from "./activeBaseSkills";
import { cyclicHalfOpenIntervalsOverlap } from "./cyclicInterval";

const supportedSupportFacilityTypes = new Set([
  "factory",
  "trading",
  "power",
  "control",
  "dormitory",
  "reception",
  "office"
]);

const supportFacilityPhysicalBounds: Readonly<
  Record<SupportFacilityType, Readonly<{ maxLevel: number; maxCapacity: number }>>
> = Object.freeze({
  factory: Object.freeze({ maxLevel: 3, maxCapacity: 3 }),
  trading: Object.freeze({ maxLevel: 3, maxCapacity: 3 }),
  power: Object.freeze({ maxLevel: 3, maxCapacity: 1 }),
  control: Object.freeze({ maxLevel: 5, maxCapacity: 5 }),
  dormitory: Object.freeze({ maxLevel: 5, maxCapacity: 5 }),
  reception: Object.freeze({ maxLevel: 3, maxCapacity: 2 }),
  office: Object.freeze({ maxLevel: 3, maxCapacity: 1 })
});

export function resolveSupportResourceScenario(
  state: AppState,
  scenario: SupportResourceScenarioInput,
  rotation: AssignmentPlan["rotation"]
): SupportResourceScenarioEvaluation {
  const fixedDormitoryOccupancy = scenario.fixedContext?.dormitoryOccupancy;
  const fixedContextDiagnostics = fixedDormitoryOccupancy &&
    (!Number.isFinite(fixedDormitoryOccupancy.amount) ||
      !Number.isInteger(fixedDormitoryOccupancy.amount) ||
      fixedDormitoryOccupancy.amount < 0)
    ? [{
        code: "fixed-context-amount-invalid" as const,
        contextKey: "dormitoryOccupancy" as const,
        message: `Fixed dormitory occupancy ${fixedDormitoryOccupancy.amount} must be a finite non-negative integer`
      }]
    : [];
  const orderedSources = [...scenario.sources].sort(compareSupportResourceSources);
  const diagnostics: SupportResourceDiagnostic[] = [];
  const conflictDiagnostics = new Map<number, SupportResourceDiagnostic[]>();
  const addConflictDiagnostic = (sourceIndex: number, diagnostic: SupportResourceDiagnostic) => {
    const sourceDiagnostics = conflictDiagnostics.get(sourceIndex) ?? [];
    sourceDiagnostics.push(diagnostic);
    conflictDiagnostics.set(sourceIndex, sourceDiagnostics);
  };
  for (let leftIndex = 0; leftIndex < orderedSources.length; leftIndex += 1) {
    const left = orderedSources[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < orderedSources.length; rightIndex += 1) {
      const right = orderedSources[rightIndex];
      if (left.id === right.id) {
        for (const [sourceIndex, source] of [
          [leftIndex, left],
          [rightIndex, right]
        ] as const) {
          addConflictDiagnostic(sourceIndex, {
            code: "source-id-duplicate",
            sourceId: source.id,
            scheduleWindowId: source.scheduleWindowId,
            conflictingSourceId: source.id,
            message: `Support source ID ${source.id} is duplicated`
          });
        }
      }
      const leftWindow = rotation.find((window) => window.shiftId === left.scheduleWindowId);
      const rightWindow = rotation.find((window) => window.shiftId === right.scheduleWindowId);
      if (!leftWindow || !rightWindow) continue;
      const windowsOverlap = cyclicHalfOpenIntervalsOverlap(
        leftWindow,
        rightWindow,
        state.schedule.cycleHours
      );
      if (
        windowsOverlap &&
        left.facility.id === right.facility.id &&
        left.facility.slot === right.facility.slot
      ) {
        for (const [sourceIndex, source, conflictingSource] of [
          [leftIndex, left, right],
          [rightIndex, right, left]
        ] as const) {
          addConflictDiagnostic(sourceIndex, {
            code: "source-facility-slot-conflict",
            sourceId: source.id,
            scheduleWindowId: source.scheduleWindowId,
            conflictingSourceId: conflictingSource.id,
            conflictingFacilityId: source.facility.id,
            message: `Support source facility slot conflicts with source ${conflictingSource.id}`
          });
        }
      }
      if (windowsOverlap && left.operatorId === right.operatorId) {
        for (const [sourceIndex, source, conflictingSource] of [
          [leftIndex, left, right],
          [rightIndex, right, left]
        ] as const) {
          addConflictDiagnostic(sourceIndex, {
            code: "source-operator-reservation-conflict",
            sourceId: source.id,
            scheduleWindowId: source.scheduleWindowId,
            conflictingSourceId: conflictingSource.id,
            message: `Support source operator ${source.operatorId} is also reserved by source ${conflictingSource.id}`
          });
        }
      }
    }
  }
  const initiallyResolvedSources = orderedSources.map((source, sourceIndex) => {
    const sourceDiagnostics: SupportResourceDiagnostic[] = [...(conflictDiagnostics.get(sourceIndex) ?? [])];
    const operator = operators.find((candidate) => candidate.id === source.operatorId);
    const operatorExists = operator !== undefined;
    const rosterEntry = state.roster[source.operatorId];
    const facility = state.facilities.find((candidate) => candidate.id === source.facility.id);
    const fixedFacility = source.facility.backing === "fixed-normalized-theoretical";
    const fixedFacilityTypeValid = !fixedFacility || supportedSupportFacilityTypes.has(source.facility.type);
    const fixedFacilityBounds = fixedFacilityTypeValid
      ? supportFacilityPhysicalBounds[source.facility.type]
      : undefined;
    const fixedFacilityCapacityValid =
      !fixedFacility || (Number.isInteger(source.facility.capacity) && source.facility.capacity > 0);
    const sourceWindow = rotation.find((window) => window.shiftId === source.scheduleWindowId);
    if (!rotation.some((window) => window.shiftId === source.scheduleWindowId)) {
      sourceDiagnostics.push({
        code: "schedule-window-not-found",
        sourceId: source.id,
        scheduleWindowId: source.scheduleWindowId,
        message: `Support source schedule window ${source.scheduleWindowId} does not exist`
      });
    }
    if (source.region !== state.region) {
      sourceDiagnostics.push({
        code: "source-region-mismatch",
        sourceId: source.id,
        scheduleWindowId: source.scheduleWindowId,
        message: `Support source region ${source.region} does not match AppState region ${state.region}`
      });
    }
    if (!Number.isFinite(source.amount) || source.amount < 0) {
      sourceDiagnostics.push({
        code: "source-amount-invalid",
        sourceId: source.id,
        scheduleWindowId: source.scheduleWindowId,
        message: `Support source amount ${source.amount} must be finite and non-negative`
      });
    }
    if (fixedFacility && (!Number.isInteger(source.facility.level) || source.facility.level <= 0)) {
      sourceDiagnostics.push({
        code: "source-fixed-facility-invalid",
        sourceId: source.id,
        scheduleWindowId: source.scheduleWindowId,
        message: `Fixed support facility level ${source.facility.level} must be a positive integer`
      });
    }
    if (
      fixedFacility &&
      fixedFacilityBounds &&
      Number.isInteger(source.facility.level) &&
      source.facility.level > fixedFacilityBounds.maxLevel
    ) {
      sourceDiagnostics.push({
        code: "source-fixed-facility-invalid",
        sourceId: source.id,
        scheduleWindowId: source.scheduleWindowId,
        message: `Fixed support facility level ${source.facility.level} exceeds the ${source.facility.type} maximum ${fixedFacilityBounds.maxLevel}`
      });
    }
    if (!fixedFacilityCapacityValid) {
      sourceDiagnostics.push({
        code: "source-fixed-facility-invalid",
        sourceId: source.id,
        scheduleWindowId: source.scheduleWindowId,
        message: `Fixed support facility capacity ${source.facility.capacity} must be a positive integer`
      });
    }
    if (
      fixedFacility &&
      fixedFacilityBounds &&
      fixedFacilityCapacityValid &&
      source.facility.capacity > fixedFacilityBounds.maxCapacity
    ) {
      sourceDiagnostics.push({
        code: "source-fixed-facility-invalid",
        sourceId: source.id,
        scheduleWindowId: source.scheduleWindowId,
        message: `Fixed support facility capacity ${source.facility.capacity} exceeds the ${source.facility.type} maximum ${fixedFacilityBounds.maxCapacity}`
      });
    }
    if (!fixedFacilityTypeValid) {
      sourceDiagnostics.push({
        code: "source-fixed-facility-invalid",
        sourceId: source.id,
        scheduleWindowId: source.scheduleWindowId,
        message: `Fixed support facility type ${source.facility.type} is not supported`
      });
    }
    if (!fixedFacility && !facility) {
      sourceDiagnostics.push({
        code: "source-facility-not-found",
        sourceId: source.id,
        scheduleWindowId: source.scheduleWindowId,
        message: `Support source facility ${source.facility.id} does not exist in AppState`
      });
    } else if (
      !fixedFacility &&
      facility &&
      (source.facility.type !== facility.type ||
        source.facility.level !== modeledFacilityLevel(facility.type) ||
        source.facility.capacity !== facility.slotCount)
    ) {
      sourceDiagnostics.push({
        code: "source-facility-mismatch",
        sourceId: source.id,
        scheduleWindowId: source.scheduleWindowId,
        message: `Support source facility metadata does not match AppState facility ${facility.id}`
      });
    }
    if (!operatorExists) {
      sourceDiagnostics.push({
        code: "source-operator-not-found",
        sourceId: source.id,
        scheduleWindowId: source.scheduleWindowId,
        message: `Support source operator ${source.operatorId} does not exist in the catalog`
      });
    } else if (!isOperatorAvailable(operatorAvailabilitySnapshot, state.region, source.operatorId)) {
      sourceDiagnostics.push({
        code: "source-operator-region-unavailable",
        sourceId: source.id,
        scheduleWindowId: source.scheduleWindowId,
        message: `Support source operator ${source.operatorId} is unavailable in region ${state.region}`
      });
    }
    if (operatorExists && !state.roster[source.operatorId]?.owned) {
      sourceDiagnostics.push({
        code: "source-operator-unowned",
        sourceId: source.id,
        scheduleWindowId: source.scheduleWindowId,
        message: `Support source operator ${source.operatorId} is not owned`
      });
    }
    if (
      operator &&
      rosterEntry?.owned &&
      fixedFacilityTypeValid &&
      source.region === state.region &&
      isOperatorAvailable(operatorAvailabilitySnapshot, state.region, source.operatorId) &&
      (fixedFacility || (facility && source.facility.type === facility.type)) &&
      !activeBaseSkills(operator, rosterEntry.elite, rosterEntry.level).some((skill) =>
        skill.effects.some((effect) => effect.facility === source.facility.type)
      )
    ) {
      sourceDiagnostics.push({
        code: "source-operator-facility-ineligible",
        sourceId: source.id,
        scheduleWindowId: source.scheduleWindowId,
        message: `Support source operator ${source.operatorId} has no unlocked base skill for ${source.facility.type}`
      });
    }
    if (
      fixedFacilityCapacityValid &&
      (!Number.isInteger(source.facility.slot) ||
        source.facility.slot < 1 ||
        source.facility.slot > source.facility.capacity ||
        (facility !== undefined && source.facility.slot > facility.slotCount))
    ) {
      sourceDiagnostics.push({
        code: "source-facility-slot-out-of-range",
        sourceId: source.id,
        scheduleWindowId: source.scheduleWindowId,
        message: `Support source facility slot ${source.facility.slot} is outside capacity ${source.facility.capacity}`
      });
    }
    const conflictingAssignment = sourceWindow?.assignments.find(
      (assignment) => assignment.operatorId === source.operatorId
    );
    if (conflictingAssignment && conflictingAssignment.facilityId !== source.facility.id) {
      sourceDiagnostics.push({
        code: "source-operator-conflict",
        sourceId: source.id,
        scheduleWindowId: source.scheduleWindowId,
        conflictingFacilityId: conflictingAssignment.facilityId,
        message: `Support source operator ${source.operatorId} is already assigned in window ${source.scheduleWindowId}`
      });
    }
    sourceDiagnostics.sort(compareSupportResourceDiagnostics);
    diagnostics.push(...sourceDiagnostics);
    if (sourceDiagnostics.length > 0) {
      return {
        source: structuredClone(source),
        status: "unresolved" as const,
        diagnostics: sourceDiagnostics
      };
    }
    return {
      source: structuredClone(source),
      status: "resolved" as const,
      reservation: {
        scheduleWindowId: source.scheduleWindowId,
        operatorId: source.operatorId,
        facilityId: source.facility.id,
        facilityType: source.facility.type,
        facilityLevel: source.facility.level,
        slot: source.facility.slot,
        capacity: source.facility.capacity
      },
      diagnostics: sourceDiagnostics
    };
  });
  const appStateFacilityGroups = new Map<string, number[]>();
  for (const [sourceIndex, evidence] of initiallyResolvedSources.entries()) {
    if (evidence.status !== "resolved" || evidence.source.facility.backing !== "app-state") continue;
    const key = JSON.stringify([evidence.source.scheduleWindowId, evidence.source.facility.id]);
    const indices = appStateFacilityGroups.get(key) ?? [];
    indices.push(sourceIndex);
    appStateFacilityGroups.set(key, indices);
  }
  const capacityDiagnostics = new Map<number, SupportResourceDiagnostic>();
  for (const sourceIndices of appStateFacilityGroups.values()) {
    const representative = initiallyResolvedSources[sourceIndices[0]];
    const facility = state.facilities.find((candidate) => candidate.id === representative.source.facility.id);
    const sourceWindow = rotation.find((window) => window.shiftId === representative.source.scheduleWindowId);
    if (!facility || !sourceWindow) continue;
    const assignedOperatorIds = new Set(
      sourceWindow.assignments
        .filter((assignment) => assignment.facilityId === facility.id)
        .map((assignment) => assignment.operatorId)
    );
    const additionalSourceOperatorIds = new Set(
      sourceIndices
        .map((sourceIndex) => initiallyResolvedSources[sourceIndex].source.operatorId)
        .filter((operatorId) => !assignedOperatorIds.has(operatorId))
    );
    const occupiedCapacity = assignedOperatorIds.size + additionalSourceOperatorIds.size;
    if (occupiedCapacity <= facility.slotCount) continue;
    for (const sourceIndex of sourceIndices) {
      const source = initiallyResolvedSources[sourceIndex].source;
      capacityDiagnostics.set(sourceIndex, {
        code: "source-facility-capacity-conflict",
        sourceId: source.id,
        scheduleWindowId: source.scheduleWindowId,
        conflictingFacilityId: facility.id,
        message: `Support source facility ${facility.id} requires ${occupiedCapacity} unique operators but has capacity ${facility.slotCount}`
      });
    }
  }
  const sources = initiallyResolvedSources.map((evidence, sourceIndex) => {
    const capacityDiagnostic = capacityDiagnostics.get(sourceIndex);
    if (!capacityDiagnostic) return evidence;
    diagnostics.push(capacityDiagnostic);
    return {
      source: evidence.source,
      status: "unresolved" as const,
      diagnostics: [...evidence.diagnostics, capacityDiagnostic].sort(compareSupportResourceDiagnostics)
    };
  });
  return {
    complete: diagnostics.length === 0 && fixedContextDiagnostics.length === 0,
    sources,
    diagnostics: diagnostics.sort(compareSupportResourceDiagnostics),
    ...(fixedDormitoryOccupancy
      ? {
          fixedContext: {
            dormitoryOccupancy: {
              context: structuredClone(fixedDormitoryOccupancy),
              status: fixedContextDiagnostics.length === 0 ? "resolved" as const : "unresolved" as const,
              diagnostics: fixedContextDiagnostics
            }
          }
        }
      : {})
  };
}

function compareSupportResourceSources(left: SupportResourceSource, right: SupportResourceSource): number {
  return compareSemanticKeys(supportResourceSourceKey(left), supportResourceSourceKey(right));
}

function supportResourceSourceKey(source: SupportResourceSource): string {
  return JSON.stringify({
    id: source.id,
    scheduleWindowId: source.scheduleWindowId,
    operatorId: source.operatorId,
    region: source.region,
    facility: {
      id: source.facility.id,
      type: source.facility.type,
      level: source.facility.level,
      slot: source.facility.slot,
      capacity: source.facility.capacity
    },
    resourceKey: source.resourceKey,
    amount: Number.isNaN(source.amount) ? "NaN" : String(source.amount),
    provenance: {
      source: source.provenance.source,
      detail: source.provenance.detail
    },
    assumptions: source.assumptions,
    simplifications: source.simplifications
  });
}

function compareSupportResourceDiagnostics(
  left: SupportResourceDiagnostic,
  right: SupportResourceDiagnostic
): number {
  return compareSemanticKeys(
    JSON.stringify([
      left.sourceId,
      left.scheduleWindowId,
      left.code,
      left.conflictingSourceId ?? "",
      left.conflictingFacilityId ?? "",
      left.message
    ]),
    JSON.stringify([
      right.sourceId,
      right.scheduleWindowId,
      right.code,
      right.conflictingSourceId ?? "",
      right.conflictingFacilityId ?? "",
      right.message
    ])
  );
}

function compareSemanticKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
