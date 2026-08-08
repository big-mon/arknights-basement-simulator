import { createDefaultState } from "../data/defaults";
import type {
  AppState,
  Assignment,
  FacilityPlan,
  FacilitySlot,
  RotationWindow,
  ScheduleState,
  WindowFacilityEfficiencyEvaluation
} from "../types";
import { createMaxLevel243BenchmarkContext } from "./benchmarkBaseContext";
import type { BenchmarkObservation } from "./optimizerBenchmarkRunner";
import {
  effectiveBenchmarkScheduleAuthority,
  type BenchmarkAssignment,
  type BenchmarkResourceOutput,
  type ResourceOutputBenchmark
} from "./optimizerBenchmark";
import { inspectExplicitFacilityTeams } from "./optimizer";
import { availableOperatorIds, operatorAvailabilitySnapshot } from "./operatorAvailability";
import { evaluatePlanResources, type PlanResourceEvaluation } from "./planResourceEvaluator";
import { aggregateResourceLedgers } from "./resourceLedger";
import { resolveSupportResourceScenario } from "./supportResourceScenario";

const logicalFacilityIds: Readonly<Record<string, string>> = Object.freeze({
  "factory-gold-1": "factory-1",
  "factory-gold-2": "factory-2",
  "factory-battle-record-1": "factory-3",
  "factory-battle-record-2": "factory-4"
});

export interface ReferenceCompositionDiagnosticOption {
  unownedOperatorIds?: readonly string[];
}

export interface ReferenceCompositionDiagnosticReason {
  code: string;
  path: string;
  message: string;
  operatorId?: string;
  facilityId?: string;
}

export type ReferenceCompositionDiagnosticResult =
  | {
      status: "complete";
      diagnostics: readonly [];
      resources: BenchmarkResourceOutput;
      resourceEvaluation: PlanResourceEvaluation;
      observation: BenchmarkObservation;
    }
  | {
      status: "incomplete";
      diagnostics: readonly ReferenceCompositionDiagnosticReason[];
      resourceEvaluation?: PlanResourceEvaluation;
    };

type EffectiveReferenceShift = ScheduleState["shifts"][number] & {
  durationHours: number;
  assignments: Record<string, BenchmarkAssignment>;
};

type EffectiveReferenceSchedule = Omit<ScheduleState, "shifts"> & {
  shifts: EffectiveReferenceShift[];
};

type EffectiveReferenceScheduleResult =
  | { status: "complete"; schedule: EffectiveReferenceSchedule }
  | { status: "incomplete"; diagnostics: ReferenceCompositionDiagnosticReason[] };

type ReferenceOperationHoursResult =
  | { status: "complete"; byShiftId: Readonly<Record<string, number>> }
  | { status: "incomplete"; diagnostics: ReferenceCompositionDiagnosticReason[] };

function effectiveReferenceSchedule(fixture: ResourceOutputBenchmark): EffectiveReferenceScheduleResult {
  const authority = effectiveBenchmarkScheduleAuthority(fixture);
  if (authority.status === "incomplete") {
    return {
      status: "incomplete",
      diagnostics: authority.errors.map((message) => ({
        code: "schedule-authority-incomplete",
        path: "rotation",
        message
      }))
    };
  }

  const fixtureShifts = fixture.rotation.shifts;
  const assignmentsByShiftId = new Map<string, Array<Record<string, BenchmarkAssignment>>>();
  for (const shift of fixtureShifts) {
    const matches = assignmentsByShiftId.get(shift.id) ?? [];
    matches.push(shift.assignments);
    assignmentsByShiftId.set(shift.id, matches);
  }
  const diagnostics: ReferenceCompositionDiagnosticReason[] = [];
  const shifts = authority.schedule.shifts.flatMap((identity) => {
    const matches = assignmentsByShiftId.get(identity.id) ?? [];
    if (matches.length !== 1) {
      diagnostics.push({
        code: "schedule-assignment-authority-incomplete",
        path: `schedule.shifts.${identity.id}`,
        message: `Effective schedule shift ${identity.id} must map to exactly one assignment witness`
      });
      return [];
    }
    return [{
      id: identity.id,
      durationHours: identity.durationHours,
      startHour: identity.startHour,
      endHour: identity.endHour,
      activeGroupIds: [...identity.activeGroupIds],
      recoveryGroupIds: [...identity.recoveryGroupIds],
      assignments: matches[0]
    }];
  });
  if (diagnostics.length > 0) return { status: "incomplete", diagnostics };

  return {
    status: "complete",
    schedule: {
      cycleHours: authority.schedule.cycleHours,
      groups: authority.schedule.groups.map((group) => ({ ...group })),
      shifts
    }
  };
}

function referenceOperationHours(schedule: EffectiveReferenceSchedule): ReferenceOperationHoursResult {
  const durationByGroupId = new Map(schedule.groups.map((group) => [group.id, 0]));
  for (const shift of schedule.shifts) {
    for (const groupId of shift.activeGroupIds) {
      const duration = durationByGroupId.get(groupId);
      if (duration !== undefined) durationByGroupId.set(groupId, duration + shift.durationHours);
    }
  }

  const diagnostics: ReferenceCompositionDiagnosticReason[] = [];
  const byShiftId: Record<string, number> = {};
  for (const shift of schedule.shifts) {
    const durations = shift.activeGroupIds.flatMap((groupId) => {
      const duration = durationByGroupId.get(groupId);
      if (duration === undefined) {
        diagnostics.push({
          code: "schedule-group-operation-incomplete",
          path: `schedule.shifts.${shift.id}.activeGroupIds`,
          message: `Active group ${groupId} is missing from effective schedule groups`
        });
        return [];
      }
      return [duration];
    });
    const uniqueDurations = new Set(durations);
    if (durations.length === 0 || uniqueDurations.size !== 1) {
      diagnostics.push({
        code: "schedule-group-operation-incomplete",
        path: `schedule.shifts.${shift.id}.activeGroupIds`,
        message: `Active groups in ${shift.id} must resolve to one complete operation duration`
      });
      continue;
    }
    byShiftId[shift.id] = durations[0];
  }
  return diagnostics.length > 0
    ? { status: "incomplete", diagnostics }
    : { status: "complete", byShiftId };
}

function createReferenceState(
  fixture: ResourceOutputBenchmark,
  schedule: EffectiveReferenceSchedule,
  options: ReferenceCompositionDiagnosticOption
): AppState {
  const state = createDefaultState();
  state.region = fixture.region;
  state.layout = "243";
  state.schedule = structuredClone(schedule);
  const ownedIds = new Set(availableOperatorIds(operatorAvailabilitySnapshot, fixture.region));
  for (const operatorId of options.unownedOperatorIds ?? []) ownedIds.delete(operatorId);
  for (const [operatorId, entry] of Object.entries(state.roster)) entry.owned = ownedIds.has(operatorId);
  state.facilities = createMaxLevel243BenchmarkContext().facilities.flatMap((facility): FacilitySlot[] => {
    if (facility.type === "factory") {
      return [{ id: facility.id, type: "factory", name: facility.id, slotCount: facility.slotCount, product: facility.product }];
    }
    if (facility.type === "trading") {
      return [{ id: facility.id, type: "trading", name: facility.id, slotCount: facility.slotCount, product: "lmd" }];
    }
    if (facility.type === "power") {
      return [{ id: facility.id, type: "power", name: facility.id, slotCount: facility.slotCount, product: "power" }];
    }
    if (facility.type === "control") {
      return [{ id: facility.id, type: "control", name: facility.id, slotCount: facility.slotCount, product: "lmd" }];
    }
    if (facility.type === "dormitory") {
      return [{ id: facility.id, type: "dormitory", name: facility.id, slotCount: facility.slotCount, product: "morale" }];
    }
    if (facility.type === "reception") {
      return [{ id: facility.id, type: "reception", name: facility.id, slotCount: facility.slotCount, product: "lmd" }];
    }
    return [];
  });
  return state;
}

function placeholderAssignment(facilityId: string, operatorId: string, durationHours: number): Assignment {
  return {
    facilityId,
    operatorId,
    skillId: "reference-resolution-placeholder",
    score: 0,
    efficiency: 0,
    fatigueHours: durationHours,
    recoveryHours: 0,
    reason: "Reference composition reservation check"
  };
}

function resourceOutput(
  evaluation: PlanResourceEvaluation,
  evaluationShiftIds: ReadonlySet<string>
): BenchmarkResourceOutput {
  const ledger = aggregateResourceLedgers([
    ...evaluation.windows
      .filter((window) => evaluationShiftIds.has(window.shiftId))
      .flatMap((window) => window.facilities.map((facility) => facility.ledger)),
    ...(evaluation.drone ? [evaluation.drone.per24Ledger] : [])
  ]);
  return {
    goldProduced: ledger.goldProduced,
    goldConsumed: ledger.goldConsumed,
    goldNetChange: ledger.goldNetChange,
    battleRecordExp: ledger.battleRecordExp,
    lmd: ledger.lmd,
    dronesGenerated: ledger.dronesGenerated,
    dronesUsed: ledger.dronesUsed,
    droneLmd: ledger.drone.lmd,
    droneGoldConsumed: ledger.drone.goldConsumed
  };
}

export function evaluateReferenceCompositionDiagnostic(
  fixture: ResourceOutputBenchmark,
  options: ReferenceCompositionDiagnosticOption = {}
): ReferenceCompositionDiagnosticResult {
  const effectiveSchedule = effectiveReferenceSchedule(fixture);
  if (effectiveSchedule.status === "incomplete") return effectiveSchedule;
  const { schedule } = effectiveSchedule;
  const operationHours = referenceOperationHours(schedule);
  if (operationHours.status === "incomplete") return operationHours;
  if (!fixture.evaluationWindow) {
    return {
      status: "incomplete",
      diagnostics: [{
        code: "evaluation-window-missing",
        path: "evaluationWindow",
        message: "Reference composition diagnostic requires an explicit evaluation window"
      }]
    };
  }
  if (!fixture.supportResourceScenario) {
    return {
      status: "incomplete",
      diagnostics: [{
        code: "support-resource-scenario-missing",
        path: "supportResourceScenario",
        message: "Reference composition diagnostic requires a validated support resource scenario"
      }]
    };
  }
  const state = createReferenceState(fixture, schedule, options);
  const resolutionRotation: RotationWindow[] = schedule.shifts.map((shift, index) => ({
    label: `reference-${index + 1}`,
    hours: shift.endHour - shift.startHour,
    shiftId: shift.id,
    startHour: shift.startHour,
    endHour: shift.endHour,
    activeGroupIds: [...shift.activeGroupIds],
    recoveryGroupIds: [...shift.recoveryGroupIds],
    incompleteGroupIds: [],
    assignments: Object.entries(shift.assignments)
      .filter(([logicalId]) => logicalFacilityIds[logicalId] !== undefined)
      .flatMap(([logicalId, assignment]) => [
      ...(assignment.operatorIds ?? []).map((operatorId) =>
        placeholderAssignment(
          logicalFacilityIds[logicalId] ?? logicalId,
          operatorId,
          operationHours.byShiftId[shift.id]
        )
      ),
      ...(assignment.remoteSupport?.operatorIds ?? []).map((operatorId) =>
        placeholderAssignment(
          assignment.remoteSupport?.facilityId ?? "control-1",
          operatorId,
          operationHours.byShiftId[shift.id]
        )
      )
    ]),
    recovery: []
  }));
  const supportScenario = resolveSupportResourceScenario(
    state,
    fixture.supportResourceScenario,
    resolutionRotation
  );
  if (!supportScenario.complete) {
    const diagnostics = supportScenario.sources.flatMap(({ source, diagnostics: sourceDiagnostics }) =>
      sourceDiagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        path: `supportResourceScenario.sources.${source.id}`,
        message: diagnostic.message,
        operatorId: source.operatorId,
        facilityId: source.facility.id
      }))
    );
    return { status: "incomplete", diagnostics };
  }

  const fixedDormitoryOccupancy = supportScenario.fixedContext?.dormitoryOccupancy.status === "resolved"
    ? supportScenario.fixedContext.dormitoryOccupancy.context.amount
    : undefined;
  const rotations: RotationWindow[] = [];
  const windowEvaluations: WindowFacilityEfficiencyEvaluation[] = [];
  const firstAssignmentsByFacility = new Map<string, Assignment[]>();
  const logicalAssignmentsByWindow = new Map<string, Record<string, string[]>>();

  for (const [windowIndex, shift] of schedule.shifts.entries()) {
    const resolvedSources = supportScenario.sources.filter(
      (source) => source.status === "resolved" && source.source.scheduleWindowId === shift.id
    );
    const ordinaryPlacementSources = resolvedSources.filter(
      (source) => source.source.resourceKey === "ordinarySupportPlacement"
    );
    const fixedSources = resolvedSources.filter(
      (source) => source.source.resourceKey !== "ordinarySupportPlacement"
    );
    const fixedSourceIds = new Set(fixedSources.map((source) => source.source.operatorId));
    const fixedResourceAmounts = fixedSources.reduce<Record<string, number>>((amounts, source) => {
      amounts[source.source.resourceKey] = (amounts[source.source.resourceKey] ?? 0) + source.source.amount;
      return amounts;
    }, {});
    const referenceAssignments = Object.entries(shift.assignments)
      .filter(([logicalId]) => logicalFacilityIds[logicalId] !== undefined);
    const teams = referenceAssignments
      .map(([logicalId, assignment]) => ({
        logicalId,
        facilityId: logicalFacilityIds[logicalId] ?? logicalId,
        operatorIds: assignment.operatorIds ?? []
      }))
      .sort((left, right) => left.facilityId.localeCompare(right.facilityId));
    const ordinarySupportByFacility = new Map<string, Set<string>>();
    for (const source of ordinaryPlacementSources) {
      const operatorIds = ordinarySupportByFacility.get(source.source.facility.id) ?? new Set<string>();
      operatorIds.add(source.source.operatorId);
      ordinarySupportByFacility.set(source.source.facility.id, operatorIds);
    }
    for (const [, assignment] of referenceAssignments) {
      for (const operatorId of assignment.remoteSupport?.operatorIds ?? []) {
        if (fixedSourceIds.has(operatorId)) continue;
        const facilityId = assignment.remoteSupport?.facilityId ?? "control-1";
        const operatorIds = ordinarySupportByFacility.get(facilityId) ?? new Set<string>();
        operatorIds.add(operatorId);
        ordinarySupportByFacility.set(facilityId, operatorIds);
      }
    }
    const inspected = inspectExplicitFacilityTeams(state, {
      teams: teams.map(({ facilityId, operatorIds }) => ({ facilityId, operatorIds })),
      supportPlacements: [...ordinarySupportByFacility]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([facilityId, operatorIds]) => ({ facilityId, operatorIds: [...operatorIds].sort() })),
      evaluationHours: operationHours.byShiftId[shift.id],
      fixedResourceAmounts,
      fixedDormitoryOccupancy,
      excludedOrdinaryResourceOperatorIds: fixedSourceIds
    });
    if (inspected.status === "incomplete") {
      return { status: "incomplete", diagnostics: inspected.diagnostics };
    }
    const assignments = inspected.teams.flatMap((team) => [...team.assignments]);
    rotations.push({
      ...resolutionRotation[windowIndex],
      assignments,
      incompleteGroupIds: []
    });
    const byPhysicalId = new Map(inspected.teams.map((team) => [team.facilityId, team]));
    logicalAssignmentsByWindow.set(shift.id, Object.fromEntries(
      Object.entries(shift.assignments).map(([logicalId, assignment]) => {
        const facilityId = logicalFacilityIds[logicalId];
        return [
          logicalId,
          facilityId === undefined
            ? [...(assignment.operatorIds ?? [])].sort()
            : [...(byPhysicalId.get(facilityId)?.assignments ?? [])]
                .map((resolved) => resolved.operatorId)
                .sort()
        ];
      })
    ));
    for (const team of inspected.teams) {
      if (!firstAssignmentsByFacility.has(team.facilityId)) {
        firstAssignmentsByFacility.set(team.facilityId, [...team.assignments]);
      }
      windowEvaluations.push({
        scheduleWindowId: shift.id,
        facilityId: team.facilityId,
        additiveEfficiency: team.expectedEfficiency,
        provenance: "optimizer-normal-team-reevaluation-with-resolved-support-context",
        fixedResourceAmounts: Object.freeze({ ...fixedResourceAmounts }),
        ...(fixedDormitoryOccupancy === undefined ? {} : { fixedDormitoryOccupancy })
      });
    }
  }

  const facilityPlans: FacilityPlan[] = [...firstAssignmentsByFacility].sort(([left], [right]) =>
    left.localeCompare(right)
  ).map(([facilityId, assignments]) => {
    const facility = state.facilities.find((candidate) => candidate.id === facilityId)!;
    return {
      facility,
      assignments,
      expectedEfficiency: 0,
      alternativeExpectedEfficiency: 0,
      score: 0,
      alternatives: []
    };
  });
  const resourceEvaluation = evaluatePlanResources({
    schedule,
    facilityPlans,
    rotation: rotations,
    supportResourceScenario: supportScenario,
    windowFacilityEfficiencyEvaluations: windowEvaluations
  });
  if (resourceEvaluation.status !== "complete") {
    return {
      status: "incomplete",
      diagnostics: resourceEvaluation.missing.map((reason) => ({
        code: reason.code,
        path: reason.path,
        message: reason.message,
        ...(reason.operatorId ? { operatorId: reason.operatorId } : {})
      })),
      resourceEvaluation
    };
  }
  const resources = resourceOutput(resourceEvaluation, new Set(fixture.evaluationWindow.shiftIds));
  const source = operatorAvailabilitySnapshot.regions[fixture.region].source;
  const observation: BenchmarkObservation = {
    metadata: {
      region: fixture.region,
      runtimeDataProvenance: { operatorAvailabilitySourceCommit: source.commit },
      roster: structuredClone(fixture.roster)
    },
    rotation: {
      cycleHours: schedule.cycleHours,
      shifts: schedule.shifts.map((shift) => ({
        id: shift.id,
        durationHours: shift.durationHours,
        startHour: shift.startHour,
        endHour: shift.endHour,
        activeGroupIds: [...shift.activeGroupIds],
        recoveryGroupIds: [...shift.recoveryGroupIds],
        assignments: logicalAssignmentsByWindow.get(shift.id) ?? {},
        remoteSupportOperatorIds: Object.fromEntries(Object.entries(shift.assignments).flatMap(([facilityId, assignment]) =>
          assignment.remoteSupport?.operatorIds ? [[facilityId, [...assignment.remoteSupport.operatorIds].sort()]] : []
        ))
      }))
    },
    resources
  };
  return { status: "complete", diagnostics: [], resources, resourceEvaluation, observation };
}
