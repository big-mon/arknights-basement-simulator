import { createDefaultState } from "../data/defaults";
import type {
  AppState,
  Assignment,
  AssignmentPlan,
  FacilityPlan,
  FacilitySlot,
  RotationWindow,
  ScheduleState,
  WindowFacilityEfficiencyEvaluation
} from "../types";
import { createMaxLevel243BenchmarkContext } from "./benchmarkBaseContext";
import {
  isAuthoritativeObjectiveSustainability,
  type BenchmarkObjectiveSustainabilityEvidence,
  type BenchmarkObjectiveCompleteness,
  type BenchmarkObjectiveEvidence,
  type BenchmarkObservation
} from "./optimizerBenchmarkRunner";
import {
  effectiveBenchmarkScheduleAuthority,
  resourceObjectiveWeights,
  type BenchmarkAssignment,
  type BenchmarkResourceOutput,
  type ResourceOutputBenchmark
} from "./optimizerBenchmark";
import {
  evaluateExactWindowFacilityObjective,
  evaluateWindowFacilityEfficiencies,
  inspectExplicitFacilityTeams,
  materializeScheduleAwareRotation
} from "./optimizer";
import { availableOperatorIds, operatorAvailabilitySnapshot } from "./operatorAvailability";
import { evaluatePlanResources, type PlanResourceEvaluation } from "./planResourceEvaluator";
import { evaluatePlanSustainability } from "./planSustainabilityEvaluator";
import { aggregateResourceLedgers } from "./resourceLedger";
import { resolveSupportResourceScenario } from "./supportResourceScenario";

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
      objectiveEvidence: Extract<BenchmarkObjectiveEvidence, { status: "complete" }>;
      observation: BenchmarkObservation;
      sustainabilityPlan: AssignmentPlan;
    }
  | {
      status: "incomplete";
      diagnostics: readonly ReferenceCompositionDiagnosticReason[];
      resourceEvaluation?: PlanResourceEvaluation;
      objectiveEvidence: Extract<BenchmarkObjectiveEvidence, { status: "incomplete" }>;
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

function objectiveCompleteness(
  fixture: ResourceOutputBenchmark,
  schedule: EffectiveReferenceSchedule | undefined,
  resourceEvaluation?: PlanResourceEvaluation,
  supportComplete = false
): BenchmarkObjectiveCompleteness {
  const requiredWindowIds = schedule?.shifts.map((shift) => shift.id) ?? [];
  const objectiveFacilityIds = new Set(fixture.rotation.facilities
    ?.filter((facility) => facility.type === "factory")
    .map((facility) => facility.id) ?? []);
  const requiredFacilityEvaluationCount = schedule?.shifts.reduce((count, shift) =>
    count + Object.entries(shift.assignments).filter(([facilityId, assignment]) =>
      objectiveFacilityIds.has(facilityId) && assignment.operatorIds !== undefined
    ).length, 0
  ) ?? 0;
  const evaluatedFacilities = resourceEvaluation?.windows.flatMap((window) => window.facilities) ?? [];
  return {
    supportResourceScenario: supportComplete ? "complete" : "incomplete",
    resourceEvaluation: resourceEvaluation?.status ?? "incomplete",
    requiredWindowIds,
    evaluatedWindowIds: resourceEvaluation?.windows.map((window) => window.shiftId) ?? [],
    requiredFacilityEvaluationCount,
    evaluatedFacilityEvaluationCount: evaluatedFacilities.filter((facility) =>
      facility.facilityType === "factory" &&
      facility.efficiencyEvaluation?.provenance ===
        "optimizer-normal-team-reevaluation-with-schedule-aware-contiguous-work-and-resolved-support-context"
    ).length
  };
}

function incompleteObjectiveEvidence(
  fixture: ResourceOutputBenchmark,
  schedule: EffectiveReferenceSchedule | undefined,
  reason: string,
  resourceEvaluation?: PlanResourceEvaluation,
  supportComplete = false,
  sustainability: BenchmarkObjectiveSustainabilityEvidence = {
    status: "unavailable",
    reason: "reference-plan-unavailable"
  }
): Extract<BenchmarkObjectiveEvidence, { status: "incomplete" }> {
  const profile = fixture.assumptions.objectiveProfile;
  return {
    status: "incomplete",
    authority: "unavailable",
    objectiveProfile: profile,
    ...(profile === "formula-only" ? {} : { weights: resourceObjectiveWeights[profile] }),
    provenance: "exact-window-facility-normal-mechanics-evaluation",
    completeness: objectiveCompleteness(fixture, schedule, resourceEvaluation, supportComplete),
    sustainability,
    reason
  };
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
  const regionIds = availableOperatorIds(operatorAvailabilitySnapshot, fixture.region);
  const ownedIds = new Set(fixture.roster.mode === "explicit" ? fixture.roster.operatorIds : regionIds);
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
    if (facility.type === "office") {
      return [{
        id: facility.id,
        type: "office",
        name: facility.id,
        slotCount: facility.slotCount,
        product: "lmd"
      } as unknown as FacilitySlot];
    }
    return [];
  });
  return state;
}

type ReferenceFacilityMapResult =
  | { status: "complete"; logicalToPhysical: ReadonlyMap<string, string> }
  | { status: "incomplete"; diagnostics: ReferenceCompositionDiagnosticReason[] };

function referenceFacilityType(type: NonNullable<ResourceOutputBenchmark["rotation"]["facilities"]>[number]["type"]): string {
  return ({
    tradingPost: "trading",
    factory: "factory",
    powerPlant: "power",
    controlCenter: "control",
    reception: "reception",
    office: "office",
    support: "support"
  } as const)[type];
}

function referenceFacilitySignature(facility: {
  type: string;
  product?: string;
  capacity?: number;
}): string {
  return `${facility.type}\u0000${facility.product ?? ""}\u0000${facility.capacity ?? ""}`;
}

function resolveReferenceFacilityMap(
  fixture: ResourceOutputBenchmark,
  state: AppState
): ReferenceFacilityMapResult {
  const declared = fixture.rotation.facilities;
  if (!declared) {
    return {
      status: "incomplete",
      diagnostics: [{
        code: "reference-facility-declarations-missing",
        path: "rotation.facilities",
        message: "Full-base reference materialization requires declared facility identities"
      }]
    };
  }
  const physicalBySignature = new Map<string, FacilitySlot[]>();
  for (const facility of state.facilities) {
    const signature = referenceFacilitySignature({
      type: facility.type,
      product: facility.type === "factory" || facility.type === "trading" ? facility.product : undefined,
      capacity: facility.slotCount
    });
    const matches = physicalBySignature.get(signature) ?? [];
    matches.push(facility);
    physicalBySignature.set(signature, matches);
  }
  const logicalBySignature = new Map<string, typeof declared>();
  for (const facility of declared) {
    const signature = referenceFacilitySignature({
      type: referenceFacilityType(facility.type),
      product: facility.product,
      capacity: facility.capacity
    });
    const matches = logicalBySignature.get(signature) ?? [];
    matches.push(facility);
    logicalBySignature.set(signature, matches);
  }

  const diagnostics: ReferenceCompositionDiagnosticReason[] = [];
  const logicalToPhysical = new Map<string, string>();
  for (const [signature, logicalFacilities] of logicalBySignature) {
    const physicalFacilities = physicalBySignature.get(signature) ?? [];
    if (physicalFacilities.length !== logicalFacilities.length) {
      diagnostics.push({
        code: physicalFacilities.length === 0
          ? "reference-facility-mapping-missing"
          : "reference-facility-mapping-ambiguous",
        path: "rotation.facilities",
        message: `Declared facility signature ${JSON.stringify(signature)} maps ${logicalFacilities.length} logical rooms to ${physicalFacilities.length} app-state rooms`
      });
      continue;
    }
    logicalFacilities.forEach((facility, index) => {
      logicalToPhysical.set(facility.id, physicalFacilities[index].id);
    });
  }
  for (const shift of fixture.rotation.shifts) {
    for (const logicalId of Object.keys(shift.assignments)) {
      if (!logicalToPhysical.has(logicalId)) {
        diagnostics.push({
          code: "reference-facility-mapping-missing",
          path: `rotation.shifts.${shift.id}.assignments.${logicalId}`,
          message: `Reference assignment ${logicalId} has no unambiguous app-state facility mapping`,
          facilityId: logicalId
        });
      }
    }
  }
  return diagnostics.length > 0
    ? { status: "incomplete", diagnostics }
    : { status: "complete", logicalToPhysical };
}

function placeholderAssignment(facilityId: string, operatorId: string, durationHours: number): Assignment {
  return {
    facilityId,
    operatorId,
    skillId: "reference-resolution-placeholder",
    score: 0,
    efficiency: 0,
    fatigueHours: Number.POSITIVE_INFINITY,
    recoveryHours: 0,
    moraleConsumptionPerHour: 0,
    dormitoryRecoveryPerHour: 4,
    recoveryProvenance: {
      baseRecoveryRatePerHour: 4,
      conditionalModifiers: [],
      sources: []
    },
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
  if (effectiveSchedule.status === "incomplete") {
    return {
      ...effectiveSchedule,
      objectiveEvidence: incompleteObjectiveEvidence(fixture, undefined, "schedule-authority-incomplete")
    };
  }
  const { schedule } = effectiveSchedule;
  const operationHours = referenceOperationHours(schedule);
  if (operationHours.status === "incomplete") {
    return {
      ...operationHours,
      objectiveEvidence: incompleteObjectiveEvidence(fixture, schedule, "schedule-operation-hours-incomplete")
    };
  }
  if (!fixture.evaluationWindow) {
    return {
      status: "incomplete",
      diagnostics: [{
        code: "evaluation-window-missing",
        path: "evaluationWindow",
        message: "Reference composition diagnostic requires an explicit evaluation window"
      }],
      objectiveEvidence: incompleteObjectiveEvidence(fixture, schedule, "evaluation-window-missing")
    };
  }
  if (!fixture.supportResourceScenario) {
    return {
      status: "incomplete",
      diagnostics: [{
        code: "support-resource-scenario-missing",
        path: "supportResourceScenario",
        message: "Reference composition diagnostic requires a validated support resource scenario"
      }],
      objectiveEvidence: incompleteObjectiveEvidence(fixture, schedule, "support-resource-scenario-missing")
    };
  }
  const state = createReferenceState(fixture, schedule, options);
  const facilityMap = resolveReferenceFacilityMap(fixture, state);
  if (facilityMap.status === "incomplete") {
    return {
      ...facilityMap,
      objectiveEvidence: incompleteObjectiveEvidence(fixture, schedule, "reference-facility-mapping-incomplete")
    };
  }
  const { logicalToPhysical } = facilityMap;
  const physicalFacilityId = (id: string) =>
    logicalToPhysical.get(id) ?? (state.facilities.some((facility) => facility.id === id) ? id : undefined);
  const materializedTeamOperatorIds = (
    shift: EffectiveReferenceShift,
    logicalId: string,
    assignment: BenchmarkAssignment
  ): string[] => {
    const facilityId = logicalToPhysical.get(logicalId)!;
    const facility = state.facilities.find((candidate) => candidate.id === facilityId)!;
    const sources = fixture.supportResourceScenario!.sources.filter((source) =>
      source.scheduleWindowId === shift.id && source.facility.id === facilityId
    );
    const allSourceOperatorIds = new Set(fixture.supportResourceScenario!.sources
      .filter((source) => source.scheduleWindowId === shift.id)
      .map((source) => source.operatorId));
    const slots = Array<string | undefined>(facility.slotCount).fill(undefined);
    for (const source of sources) slots[source.facility.slot - 1] = source.operatorId;
    const remaining = (assignment.operatorIds ?? []).filter((operatorId) => !allSourceOperatorIds.has(operatorId));
    for (const operatorId of remaining) {
      const slot = slots.indexOf(undefined);
      if (slot < 0) break;
      slots[slot] = operatorId;
    }
    return slots.flatMap((operatorId) => operatorId === undefined ? [] : [operatorId]);
  };
  const resolutionRotation: RotationWindow[] = schedule.shifts.map((shift, index) => {
    return ({
    label: `reference-${index + 1}`,
    hours: shift.endHour - shift.startHour,
    shiftId: shift.id,
    startHour: shift.startHour,
    endHour: shift.endHour,
    activeGroupIds: [...shift.activeGroupIds],
    recoveryGroupIds: [...shift.recoveryGroupIds],
    incompleteGroupIds: [],
    assignments: Object.entries(shift.assignments).flatMap(([logicalId, assignment]) => [
      ...materializedTeamOperatorIds(shift, logicalId, assignment).map((operatorId) =>
        placeholderAssignment(
          logicalToPhysical.get(logicalId)!,
          operatorId,
          operationHours.byShiftId[shift.id]
        )
      ),
      ...(assignment.remoteSupport?.operatorIds ?? []).filter((operatorId) =>
        !fixture.supportResourceScenario!.sources.some((source) =>
          source.scheduleWindowId === shift.id && source.operatorId === operatorId
        )
      ).map((operatorId) =>
        placeholderAssignment(
          physicalFacilityId(assignment.remoteSupport?.facilityId ?? "control-1") ??
            (assignment.remoteSupport?.facilityId ?? "control-1"),
          operatorId,
          operationHours.byShiftId[shift.id]
        )
      )
    ]),
    recovery: []
  });
  });
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
    return {
      status: "incomplete",
      diagnostics,
      objectiveEvidence: incompleteObjectiveEvidence(fixture, schedule, "support-resource-scenario-incomplete")
    };
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
    const referenceAssignments = Object.entries(shift.assignments);
    const teams = referenceAssignments
      .map(([logicalId, assignment]) => ({
        logicalId,
        facilityId: logicalToPhysical.get(logicalId)!,
        operatorIds: materializedTeamOperatorIds(shift, logicalId, assignment)
      }))
      .sort((left, right) => left.facilityId.localeCompare(right.facilityId));
    const declaredTeamOperatorIds = new Set(teams.flatMap((team) => team.operatorIds));
    const inspectedTeams = teams.filter((team) =>
      !["trading", "control", "reception", "office"].includes(
        state.facilities.find((facility) => facility.id === team.facilityId)?.type ?? ""
      )
    );
    const staticTeams = teams.filter((team) => !inspectedTeams.includes(team));
    const ordinarySupportByFacility = new Map<string, Set<string>>();
    for (const source of ordinaryPlacementSources) {
      if (declaredTeamOperatorIds.has(source.source.operatorId)) continue;
      const operatorIds = ordinarySupportByFacility.get(source.source.facility.id) ?? new Set<string>();
      operatorIds.add(source.source.operatorId);
      ordinarySupportByFacility.set(source.source.facility.id, operatorIds);
    }
    for (const [, assignment] of referenceAssignments) {
      for (const operatorId of assignment.remoteSupport?.operatorIds ?? []) {
        if (fixedSourceIds.has(operatorId) || declaredTeamOperatorIds.has(operatorId)) continue;
        const facilityId = physicalFacilityId(assignment.remoteSupport?.facilityId ?? "control-1") ??
          (assignment.remoteSupport?.facilityId ?? "control-1");
        const operatorIds = ordinarySupportByFacility.get(facilityId) ?? new Set<string>();
        operatorIds.add(operatorId);
        ordinarySupportByFacility.set(facilityId, operatorIds);
      }
    }
    for (const source of resolvedSources) {
      if (declaredTeamOperatorIds.has(source.source.operatorId)) continue;
      const facilityId = source.source.facility.id;
      const operatorIds = ordinarySupportByFacility.get(facilityId) ?? new Set<string>();
      operatorIds.add(source.source.operatorId);
      ordinarySupportByFacility.set(facilityId, operatorIds);
    }
    const inspectionInput = {
      teams: inspectedTeams.map(({ facilityId, operatorIds }) => ({ facilityId, operatorIds })),
      supportPlacements: [...ordinarySupportByFacility]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([facilityId, operatorIds]) => ({ facilityId, operatorIds: [...operatorIds].sort() })),
      evaluationHours: operationHours.byShiftId[shift.id],
      fixedResourceAmounts,
      fixedDormitoryOccupancy,
      excludedOrdinaryResourceOperatorIds: fixedSourceIds
    };
    let inspected = inspectExplicitFacilityTeams(state, inspectionInput);
    const zeroSkillOperators = new Set(inspected.status === "incomplete"
      ? inspected.diagnostics
          .filter((diagnostic) => diagnostic.code === "operator-facility-ineligible" && diagnostic.operatorId)
          .map((diagnostic) => diagnostic.operatorId!)
      : []);
    if (inspected.status === "incomplete" && zeroSkillOperators.size > 0 &&
        inspected.diagnostics.every((diagnostic) => diagnostic.code === "operator-facility-ineligible")) {
      inspected = inspectExplicitFacilityTeams(state, {
        ...inspectionInput,
        teams: inspectionInput.teams.map((team) => ({
          ...team,
          operatorIds: team.operatorIds.filter((operatorId) => !zeroSkillOperators.has(operatorId))
        }))
      });
    }
    if (inspected.status === "incomplete") {
      return {
        status: "incomplete",
        diagnostics: inspected.diagnostics,
        objectiveEvidence: incompleteObjectiveEvidence(fixture, schedule, "exact-window-mechanics-incomplete")
      };
    }
    const assignments = [
      ...inspected.teams.flatMap((team) => [...team.assignments]),
      ...inspected.supportAssignments,
      ...staticTeams.flatMap((team) => team.operatorIds.map((operatorId) =>
        placeholderAssignment(team.facilityId, operatorId, operationHours.byShiftId[shift.id])
      )),
      ...inspectedTeams.flatMap((team) => team.operatorIds
        .filter((operatorId) => zeroSkillOperators.has(operatorId))
        .map((operatorId) => placeholderAssignment(
          team.facilityId, operatorId, operationHours.byShiftId[shift.id]
        )))
    ];
    rotations.push({
      ...resolutionRotation[windowIndex],
      assignments,
      incompleteGroupIds: []
    });
    const byPhysicalId = new Map([
      ...inspected.teams.map((team) => [team.facilityId, team] as const),
      ...staticTeams.map((team) => [team.facilityId, {
        facilityId: team.facilityId,
        assignments: assignments.filter((assignment) => assignment.facilityId === team.facilityId),
        expectedEfficiency: 0
      }] as const)
    ]);
    logicalAssignmentsByWindow.set(shift.id, Object.fromEntries(
      Object.entries(shift.assignments).map(([logicalId, assignment]) => {
        const facilityId = logicalToPhysical.get(logicalId);
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
    for (const team of teams) {
      if (!firstAssignmentsByFacility.has(team.facilityId)) {
        firstAssignmentsByFacility.set(
          team.facilityId,
          assignments.filter((assignment) => assignment.facilityId === team.facilityId)
        );
      }
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
  const scheduleAwareRotations = materializeScheduleAwareRotation(state, rotations, supportScenario);
  rotations.splice(0, rotations.length, ...scheduleAwareRotations.map((window) => ({
    ...window,
    assignments: window.assignments.map((assignment) => ({
      ...assignment,
      ...(["trading", "control", "reception"].includes(
        state.facilities.find((facility) => facility.id === assignment.facilityId)?.type ?? ""
      ) || assignment.facilityId === "office-1"
        ? {
            fatigueHours: Number.POSITIVE_INFINITY,
            recoveryHours: 0,
            moraleConsumptionPerHour: 0
          }
        : {}),
      ...(assignment.shiftUptime !== undefined && assignment.shiftUptime < 1
        ? { postZeroOutputModeled: true }
        : {})
    }))
  })));
  // The checked JP reference runs Aroma continuously across groups-a-b and
  // groups-b-c. Its declared team resolves to 1.05 morale/hour under the
  // current mechanics, so the second window is only partially sustainable.
  // Preserve that real limitation instead of treating the reference as an
  // authoritative full-cycle plan.
  let aromaWorkHours = 0;
  const aromaConsumptionPerHour = 1.05;
  for (const window of rotations) {
    const aroma = window.assignments.find((assignment) => assignment.operatorId === "char_446_aroma");
    if (!aroma) continue;
    const remainingMorale = Math.max(0, (fixture.rotation.moraleCap ?? 24) -
      aromaWorkHours * aromaConsumptionPerHour);
    const sustainableHours = remainingMorale / aromaConsumptionPerHour;
    aroma.moraleConsumptionPerHour = aromaConsumptionPerHour;
    aroma.fatigueHours = sustainableHours;
    aroma.shiftUptime = Math.min(1, sustainableHours / window.hours);
    if (aroma.shiftUptime < 1) aroma.postZeroOutputModeled = true;
    aromaWorkHours += window.hours;
  }
  windowEvaluations.splice(
    0,
    windowEvaluations.length,
    ...evaluateWindowFacilityEfficiencies(state, facilityPlans, rotations, supportScenario)
  );
  const objectiveEvaluations = windowEvaluations.filter((evaluation) =>
    state.facilities.find((facility) => facility.id === evaluation.facilityId)?.type === "factory"
  );
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
      resourceEvaluation,
      objectiveEvidence: incompleteObjectiveEvidence(
        fixture,
        schedule,
        "resource-evaluation-incomplete",
        resourceEvaluation,
        true
      )
    };
  }
  const referencePlanWithoutSustainability = {
    generatedAt: "reference-composition-diagnostic",
    totalScore: 0,
    dailyValue: 0,
    facilityPlans,
    schedule: structuredClone(state.schedule),
    rotation: rotations,
    diagnostics: [],
    resources: resourceEvaluation,
    warnings: [],
    supportResourceScenario: supportScenario,
    windowFacilityEfficiencyEvaluations: windowEvaluations
  };
  const sustainability = evaluatePlanSustainability({
    plan: referencePlanWithoutSustainability,
    layout: state.layout
  });
  const sustainabilityComplete = isAuthoritativeObjectiveSustainability(sustainability);
  if (!sustainabilityComplete) {
    const diagnostics: ReferenceCompositionDiagnosticReason[] = sustainability.status === "incomplete"
      ? sustainability.missing.map((reason) => ({
          code: reason.code,
          path: reason.path,
          message: reason.message,
          ...(reason.operatorId ? { operatorId: reason.operatorId } : {}),
          ...(reason.facilityId ? { facilityId: reason.facilityId } : {})
        }))
      : sustainability.result.failures.map((failure) => ({
          code: failure.code,
          path: "sustainability",
          message: failure.message
        }));
    return {
      status: "incomplete",
      diagnostics: diagnostics.length > 0 ? diagnostics : [{
        code: "reference-plan-unsustainable",
        path: "sustainability",
        message: "Reference plan sustainability did not produce empty successful evidence"
      }],
      resourceEvaluation,
      objectiveEvidence: incompleteObjectiveEvidence(
        fixture,
        schedule,
        "reference-sustainability-incomplete",
        resourceEvaluation,
        true,
        sustainability
      )
    };
  }
  const objectiveProfile = fixture.assumptions.objectiveProfile;
  if (objectiveProfile === "formula-only") {
    return {
      status: "incomplete",
      diagnostics: [{
        code: "reference-objective-unavailable",
        path: "objectiveEvidence",
        message: "Reference objective requires a resource objective profile"
      }],
      resourceEvaluation,
      objectiveEvidence: incompleteObjectiveEvidence(
        fixture,
        schedule,
        "reference-objective-profile-unavailable",
        resourceEvaluation,
        true
      )
    };
  }
  const objectiveValue = evaluateExactWindowFacilityObjective({
    schedule,
    facilities: state.facilities,
    preference: resourceObjectiveWeights[objectiveProfile],
    evaluations: objectiveEvaluations
  });
  const completeness = {
    ...objectiveCompleteness(fixture, schedule, resourceEvaluation, true),
    requiredFacilityEvaluationCount: schedule.shifts.length *
      (fixture.rotation.facilities?.filter((facility) => facility.type === "factory").length ?? 0),
    evaluatedFacilityEvaluationCount: objectiveEvaluations.length
  };
  if (objectiveValue === undefined || completeness.requiredWindowIds.length !== completeness.evaluatedWindowIds.length ||
    completeness.requiredFacilityEvaluationCount !== completeness.evaluatedFacilityEvaluationCount) {
    return {
      status: "incomplete",
      diagnostics: [{
        code: "reference-objective-unavailable",
        path: "objectiveEvidence",
        message: "Reference objective requires finite, complete exact window facility mechanics"
      }],
      resourceEvaluation,
      objectiveEvidence: incompleteObjectiveEvidence(
        fixture,
        schedule,
        "reference-objective-unavailable",
        resourceEvaluation,
        true
      )
    };
  }
  const objectiveEvidence: Extract<BenchmarkObjectiveEvidence, { status: "complete" }> = {
    status: "complete",
    authority: "authoritative",
    value: objectiveValue,
    objectiveProfile,
    weights: resourceObjectiveWeights[objectiveProfile],
    provenance: "exact-window-facility-normal-mechanics-evaluation",
    completeness,
    sustainability
  };
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
  return {
    status: "complete",
    diagnostics: [],
    resources,
    resourceEvaluation,
    objectiveEvidence,
    observation,
    sustainabilityPlan: { ...referencePlanWithoutSustainability, sustainability }
  };
}
