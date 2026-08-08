import type {
  Assignment,
  FacilityPlan,
  FacilitySlot,
  RotationWindow,
  ScheduleState,
  SupportResourceScenarioEvaluation,
  WindowFacilityEfficiencyEvaluation
} from "../types";
import { simulateFacilityProduction } from "./facilityProduction";
import {
  aggregateResourceLedgers,
  createResourceLedger,
  scaleResourceLedger,
  type ResourceLedger
} from "./resourceLedger";
import { simulateTradingPostDrones24h } from "./tradingPostDrones";
import type {
  PlanDroneResourceResult,
  PlanFacilityResourceResult,
  PlanResourceAssumptions,
  PlanResourceEvaluation,
  PlanResourceMissingReason,
  PlanResourceEvidence,
  PlanWindowResourceResult
} from "./planResourceTypes";

export type {
  PlanDroneResourceResult,
  PlanFacilityResourceResult,
  PlanResourceAssumptions,
  PlanResourceEvaluation,
  PlanResourceMissingCode,
  PlanResourceMissingReason,
  PlanResourceTradingEffectType,
  PlanWindowResourceResult
} from "./planResourceTypes";

export interface PlanResourceEvaluationInput {
  schedule: ScheduleState;
  facilityPlans: readonly FacilityPlan[];
  rotation: readonly RotationWindow[];
  supportResourceScenario?: SupportResourceScenarioEvaluation;
  windowFacilityEfficiencyEvaluations?: readonly Readonly<WindowFacilityEfficiencyEvaluation>[];
}

const assumptions = Object.freeze<PlanResourceAssumptions>({
  facilityProductionCalculator: "simulateFacilityProduction",
  droneCalculator: "simulateTradingPostDrones24h",
  facilityLevel: 3,
  storage: "unbounded-no-plan-state",
  teamEfficiencyProvenance: "optimizer-evaluated-facility-efficiency-for-selected-schedule-group",
  initialDrones: 0,
  droneAllocationPolicy: "all-completed-to-highest-marginal-normal-order-gain-facility-id-tiebreak",
  allocationTimingAssumption: "slot-batch-consumption",
  capOverflowAccounting: "before-slot-allocation",
  scheduleFeasibility: "evaluated-at-slot-boundaries",
  normalization: "cycle-ledger-scaled-linearly-to-24-hours"
});

function missingReason(reason: PlanResourceMissingReason): Readonly<PlanResourceMissingReason> {
  return Object.freeze({ ...reason });
}

function evaluatedEfficiency(
  input: PlanResourceEvaluationInput,
  plan: FacilityPlan,
  groupIndex: number,
  scheduleWindowId: string
): { value: number | undefined; evidence?: WindowFacilityEfficiencyEvaluation } {
  const windowEvaluation = input.windowFacilityEfficiencyEvaluations?.find(
    (evaluation) => evaluation.scheduleWindowId === scheduleWindowId && evaluation.facilityId === plan.facility.id
  );
  return windowEvaluation
    ? { value: windowEvaluation.additiveEfficiency, evidence: windowEvaluation }
    : { value: groupIndex === 0 ? plan.expectedEfficiency : plan.alternativeExpectedEfficiency };
}

function assignmentsForFacility(window: RotationWindow, facilityId: string): Assignment[] {
  return window.assignments.filter((assignment) => assignment.facilityId === facilityId);
}

function sameAssignmentTeam(left: readonly Assignment[], right: readonly Assignment[]): boolean {
  const signature = (assignments: readonly Assignment[]) => assignments
    .map((assignment) => `${assignment.operatorId}:${assignment.skillId}`)
    .sort();
  const leftSignature = signature(left);
  const rightSignature = signature(right);
  return leftSignature.length === rightSignature.length &&
    leftSignature.every((value, index) => value === rightSignature[index]);
}

function supportedProductionFacility(
  facility: FacilitySlot
): facility is FacilitySlot & { type: "factory" | "trading" } {
  return facility.type === "factory" || facility.type === "trading";
}

function freezeWindow(result: PlanWindowResourceResult): Readonly<PlanWindowResourceResult> {
  return Object.freeze({
    ...result,
    activeGroupIds: Object.freeze([...result.activeGroupIds]),
    facilities: Object.freeze(result.facilities.map((facility) => Object.freeze({
      ...facility,
      operatorIds: Object.freeze([...facility.operatorIds]),
      ...(facility.efficiencyEvaluation
        ? {
            efficiencyEvaluation: Object.freeze({
              ...facility.efficiencyEvaluation,
              fixedResourceAmounts: Object.freeze({ ...facility.efficiencyEvaluation.fixedResourceAmounts })
            })
          }
        : {})
    })))
  });
}

function supportEvidence(scenario: SupportResourceScenarioEvaluation | undefined): Readonly<PlanResourceEvidence> | undefined {
  if (!scenario?.complete) return undefined;
  const fixedSources = scenario.sources
    .filter((source) => source.status === "resolved")
    .map(({ source }) => Object.freeze({
      sourceId: source.id,
      scheduleWindowId: source.scheduleWindowId,
      operatorId: source.operatorId,
      facilityId: source.facility.id,
      facilityType: source.facility.type,
      facilityLevel: source.facility.level,
      facilitySlot: source.facility.slot,
      facilityCapacity: source.facility.capacity,
      resourceKey: source.resourceKey,
      amount: source.amount,
      provenance: Object.freeze({ ...source.provenance }),
      assumptions: Object.freeze([...source.assumptions]),
      simplifications: Object.freeze([...source.simplifications])
    }))
    .sort((left, right) => left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0);
  const dormitoryOccupancy = scenario.fixedContext?.dormitoryOccupancy;
  const fixedContexts = dormitoryOccupancy?.status === "resolved"
    ? [Object.freeze({
        contextKey: "dormitoryOccupancy" as const,
        amount: dormitoryOccupancy.context.amount,
        provenance: Object.freeze({ ...dormitoryOccupancy.context.provenance }),
        assumptions: Object.freeze([...dormitoryOccupancy.context.assumptions]),
        simplifications: Object.freeze([...dormitoryOccupancy.context.simplifications])
      })]
    : [];
  return Object.freeze({
    fixedSources: Object.freeze(fixedSources),
    fixedContexts: Object.freeze(fixedContexts)
  });
}

function calculatorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function evaluateInternal(input: PlanResourceEvaluationInput): PlanResourceEvaluation {
  const missing: Array<Readonly<PlanResourceMissingReason>> = [];
  const windowResults: Array<Readonly<PlanWindowResourceResult>> = [];
  const naturalLedgers: ResourceLedger[] = [];
  const groupIndex = new Map(input.schedule.groups.map((group, index) => [group.id, index]));
  const windowByShiftId = new Map(input.rotation.map((window) => [window.shiftId, window]));
  const directPlans = input.facilityPlans.filter((plan) => supportedProductionFacility(plan.facility));
  const powerPlans = input.facilityPlans.filter((plan) => plan.facility.type === "power");
  const efficiencyHoursByFacility = new Map<string, number>();
  const powerEfficiencyHoursBySlot = new Map<string, number>();
  const evidence = supportEvidence(input.supportResourceScenario);

  for (const source of input.supportResourceScenario?.sources ?? []) {
    if (source.status === "resolved") continue;
    for (const diagnostic of source.diagnostics) {
      missing.push(missingReason({
        code: "support-resource-unresolved",
        path: `support-resource-scenario/sources/${source.source.id}`,
        message: diagnostic.message,
        sourceId: source.source.id,
        scheduleWindowId: source.source.scheduleWindowId,
        diagnosticCode: diagnostic.code
      }));
    }
  }
  const fixedDormitoryOccupancy = input.supportResourceScenario?.fixedContext?.dormitoryOccupancy;
  if (fixedDormitoryOccupancy?.status === "unresolved") {
    for (const diagnostic of fixedDormitoryOccupancy.diagnostics) {
      missing.push(missingReason({
        code: "support-fixed-context-unresolved",
        path: "support-resource-scenario/fixed-context/dormitory-occupancy",
        message: diagnostic.message,
        contextKey: "dormitoryOccupancy",
        diagnosticCode: diagnostic.code
      }));
    }
  }

  for (const shift of input.schedule.shifts) {
    const window = windowByShiftId.get(shift.id);
    if (!window) {
      missing.push(missingReason({
        code: "rotation-window-missing",
        path: `rotation/${shift.id}`,
        message: `Rotation window ${shift.id} is missing`
      }));
      continue;
    }

    for (const incompleteGroupId of window.incompleteGroupIds) {
      missing.push(missingReason({
        code: "schedule-group-unpopulated",
        path: `rotation/${shift.id}/groups/${incompleteGroupId}`,
        message: `Schedule group ${incompleteGroupId} is not populated for shift ${shift.id}`
      }));
    }

    const facilities: PlanFacilityResourceResult[] = [];
    if (window.incompleteGroupIds.length > 0) {
      windowResults.push(freezeWindow({
        shiftId: shift.id,
        startHour: shift.startHour,
        endHour: shift.endHour,
        durationHours: shift.endHour - shift.startHour,
        activeGroupIds: shift.activeGroupIds,
        facilities
      }));
      continue;
    }
    const hasExplicitWindowEvaluation = [...directPlans, ...powerPlans].every((plan) =>
      input.windowFacilityEfficiencyEvaluations?.some(
        (evaluation) => evaluation.scheduleWindowId === shift.id && evaluation.facilityId === plan.facility.id
      )
    );
    if (shift.activeGroupIds.length !== 1 && !hasExplicitWindowEvaluation) {
      missing.push(missingReason({
        code: "schedule-active-groups-unresolved",
        path: `rotation/${shift.id}/active-groups`,
        message: `Shift ${shift.id} has ${shift.activeGroupIds.length} active groups whose teams cannot be separated`
      }));
      windowResults.push(freezeWindow({
        shiftId: shift.id,
        startHour: shift.startHour,
        endHour: shift.endHour,
        durationHours: shift.endHour - shift.startHour,
        activeGroupIds: shift.activeGroupIds,
        facilities
      }));
      continue;
    }

    const activeGroupId = shift.activeGroupIds[0];
    const selectedGroupIndex = groupIndex.get(activeGroupId);
    if (!hasExplicitWindowEvaluation && (selectedGroupIndex === undefined || selectedGroupIndex > 1)) {
      missing.push(missingReason({
        code: "schedule-group-unpopulated",
        path: `rotation/${shift.id}/groups/${activeGroupId}`,
        message: `Schedule group ${activeGroupId} has no selected facility team`
      }));
      windowResults.push(freezeWindow({
        shiftId: shift.id,
        startHour: shift.startHour,
        endHour: shift.endHour,
        durationHours: shift.endHour - shift.startHour,
        activeGroupIds: shift.activeGroupIds,
        facilities
      }));
      continue;
    }

    const durationHours = shift.endHour - shift.startHour;
    for (const plan of [...directPlans, ...powerPlans].sort((left, right) => left.facility.id.localeCompare(right.facility.id))) {
      const selectedAssignments = assignmentsForFacility(window, plan.facility.id);
      const plannedAssignments = hasExplicitWindowEvaluation
        ? selectedAssignments
        : (selectedGroupIndex === 0 ? plan.assignments : plan.alternatives)
          .filter((assignment) => assignment.facilityId === plan.facility.id);
      const efficiencyResult = evaluatedEfficiency(input, plan, selectedGroupIndex ?? 0, shift.id);
      const efficiency = efficiencyResult.value;
      const path = `rotation/${shift.id}/facilities/${plan.facility.id}`;
      if (!sameAssignmentTeam(selectedAssignments, plannedAssignments)) {
        missing.push(missingReason({
          code: "facility-team-missing",
          path,
          message: `Facility ${plan.facility.id} rotation assignments do not match selected group ${activeGroupId}`
        }));
        continue;
      }
      if (typeof efficiency !== "number" || !Number.isFinite(efficiency)) {
        missing.push(missingReason({
          code: "invalid-evaluated-efficiency",
          path: `${path}/efficiency`,
          message: `Facility ${plan.facility.id} has no finite evaluated efficiency for group ${activeGroupId}`
        }));
        continue;
      }

      efficiencyHoursByFacility.set(
        plan.facility.id,
        (efficiencyHoursByFacility.get(plan.facility.id) ?? 0) + efficiency * durationHours
      );
      if (plan.facility.type === "power") {
        for (const slot of [0, 1] as const) {
          const overlapHours = Math.max(
            0,
            Math.min(shift.endHour, (slot + 1) * 12) - Math.max(shift.startHour, slot * 12)
          );
          if (overlapHours === 0) continue;
          const key = `${plan.facility.id}:${slot}`;
          powerEfficiencyHoursBySlot.set(
            key,
            (powerEfficiencyHoursBySlot.get(key) ?? 0) + efficiency * overlapHours
          );
        }
        continue;
      }

      if (plan.facility.type === "factory" && plan.facility.product !== "gold" && plan.facility.product !== "battleRecord") {
        missing.push(missingReason({
          code: "unsupported-factory-product",
          path: `${path}/product`,
          message: `Factory product ${plan.facility.product} is not supported by simulateFacilityProduction`
        }));
        continue;
      }

      if (plan.facility.type === "trading") {
        const unsupported = selectedAssignments.flatMap((assignment) =>
          (assignment.tradingOrderEffects ?? []).map((effect, effectIndex) => ({
            assignment,
            effect,
            effectIndex
          }))
        );
        if (unsupported.length > 0) {
          for (const { assignment, effect, effectIndex } of unsupported) {
            const effectKind = "kind" in effect ? effect.kind : undefined;
            const evidenceId = `${assignment.skillId}:tradingOrderEffects[${effectIndex}]:${effect.type}${effectKind ? `:${effectKind}` : ""}`;
            const evidencePath = `tradingOrderEffects/${effectIndex}/${effect.type}${effectKind ? `/${effectKind}` : ""}`;
            missing.push(missingReason({
              code: "unsupported-trading-order-effect",
              path: `${path}/operators/${assignment.operatorId}/effects/${assignment.skillId}/${evidencePath}`,
              message: `Trading-order effect ${evidenceId} on ${assignment.operatorId} has no faithful quantity mapping`,
              operatorId: assignment.operatorId,
              effectId: evidenceId,
              effectIndex,
              effectType: effect.type,
              ...(effectKind ? { effectKind } : {})
            }));
          }
          continue;
        }
      }

      try {
        if (plan.facility.type === "trading") {
          const teamEffects = efficiency === 0 ? [] : [{
            id: `plan-${shift.id}-${plan.facility.id}`,
            source: "operator" as const,
            additiveEfficiency: efficiency,
            target: "normalOrder" as const
          }];
          const production = simulateFacilityProduction({
            durationHours,
            facility: { kind: "tradingPost", level: 3, orderType: "normalLmd" },
            teamEffects
          });
          naturalLedgers.push(production.ledger);
          facilities.push({
            facilityId: plan.facility.id,
            facilityType: "trading",
            product: "lmd",
            operatorIds: selectedAssignments.map((assignment) => assignment.operatorId),
            additiveEfficiency: efficiency,
            ...(efficiencyResult.evidence
              ? {
                  efficiencyEvaluation: {
                    provenance: efficiencyResult.evidence.provenance,
                    fixedResourceAmounts: efficiencyResult.evidence.fixedResourceAmounts,
                    ...(efficiencyResult.evidence.fixedDormitoryOccupancy === undefined
                      ? {}
                      : { fixedDormitoryOccupancy: efficiencyResult.evidence.fixedDormitoryOccupancy })
                  }
                }
              : {}),
            ledger: production.ledger
          });
        } else if (plan.facility.type === "factory" &&
          (plan.facility.product === "gold" || plan.facility.product === "battleRecord")) {
          const product = plan.facility.product;
          const teamEffects = efficiency === 0 ? [] : [{
            id: `plan-${shift.id}-${plan.facility.id}`,
            source: "operator" as const,
            additiveEfficiency: efficiency,
            target: product
          }];
          const production = simulateFacilityProduction({
            durationHours,
            facility: { kind: "factory", level: 3, product },
            teamEffects
          });
          naturalLedgers.push(production.ledger);
          facilities.push({
            facilityId: plan.facility.id,
            facilityType: "factory",
            product,
            operatorIds: selectedAssignments.map((assignment) => assignment.operatorId),
            additiveEfficiency: efficiency,
            ...(efficiencyResult.evidence
              ? {
                  efficiencyEvaluation: {
                    provenance: efficiencyResult.evidence.provenance,
                    fixedResourceAmounts: efficiencyResult.evidence.fixedResourceAmounts,
                    ...(efficiencyResult.evidence.fixedDormitoryOccupancy === undefined
                      ? {}
                      : { fixedDormitoryOccupancy: efficiencyResult.evidence.fixedDormitoryOccupancy })
                  }
                }
              : {}),
            ledger: production.ledger
          });
        }
      } catch (error) {
        missing.push(missingReason({
          code: "calculator-error",
          path,
          message: calculatorMessage(error)
        }));
      }
    }

    windowResults.push(freezeWindow({
      shiftId: shift.id,
      startHour: shift.startHour,
      endHour: shift.endHour,
      durationHours,
      activeGroupIds: shift.activeGroupIds,
      facilities
    }));
  }

  if (missing.length > 0) {
    return Object.freeze({
      status: "incomplete",
      assumptions,
      windows: Object.freeze(windowResults),
      missing: Object.freeze(missing),
      ...(evidence ? { evidence } : {})
    });
  }

  try {
    const averageEfficiency = (facilityId: string) =>
      (efficiencyHoursByFacility.get(facilityId) ?? 0) / input.schedule.cycleHours;
    const powerPlantSkillIncrements = powerPlans
      .flatMap((plan) => ([0, 1] as const).map((slot) => ({
        slot,
        sourceFacilityId: plan.facility.id,
        id: `plan-${plan.facility.id}`,
        recoveryRateIncrement: (powerEfficiencyHoursBySlot.get(`${plan.facility.id}:${slot}`) ?? 0) / 12
      })))
      .sort((left, right) => left.slot - right.slot || left.id.localeCompare(right.id));
    const generation = simulateTradingPostDrones24h({
      initialDrones: 0,
      powerPlantSkillIncrements,
      allocations: []
    }).generation;
    const target = directPlans
      .filter((plan) => plan.facility.type === "trading")
      .map((plan) => ({ facilityId: plan.facility.id, efficiency: averageEfficiency(plan.facility.id) }))
      .sort((left, right) => right.efficiency - left.efficiency || left.facilityId.localeCompare(right.facilityId))[0];
    const droneSimulation = simulateTradingPostDrones24h({
      initialDrones: 0,
      powerPlantSkillIncrements,
      allocations: target ? generation.slots.map(({ slot, generated }) => ({
        slot,
        targetFacilityId: target.facilityId,
        drones: generated,
        orderAcquisitionEfficiency: target.efficiency
      })) : []
    });
    const dronePer24Ledger = createResourceLedger({
      drone: droneSimulation.ledger.drone,
      dronesGenerated: droneSimulation.ledger.dronesGenerated,
      dronesUsed: droneSimulation.ledger.dronesUsed
    });
    const naturalCycleLedger = aggregateResourceLedgers(naturalLedgers);
    const droneCycleLedger = scaleResourceLedger(dronePer24Ledger, input.schedule.cycleHours / 24);
    const cycleLedger = aggregateResourceLedgers([naturalCycleLedger, droneCycleLedger]);
    const per24Ledger = scaleResourceLedger(cycleLedger, 24 / input.schedule.cycleHours);
    const drone = Object.freeze<PlanDroneResourceResult>({
      ...(target ? { targetFacilityId: target.facilityId } : {}),
      dronesAllocated: droneSimulation.ledger.dronesUsed,
      per24Ledger: dronePer24Ledger,
      semantics: droneSimulation.semantics
    });

    return Object.freeze({
      status: "complete",
      assumptions,
      windows: Object.freeze(windowResults),
      missing: Object.freeze([]),
      ...(evidence ? { evidence } : {}),
      drone,
      cycleLedger,
      per24Ledger
    });
  } catch (error) {
    return Object.freeze({
      status: "incomplete",
      assumptions,
      windows: Object.freeze(windowResults),
      missing: Object.freeze([missingReason({
        code: "calculator-error",
        path: "drone-evaluation",
        message: calculatorMessage(error)
      })]),
      ...(evidence ? { evidence } : {})
    });
  }
}

export function evaluatePlanResources(input: PlanResourceEvaluationInput): PlanResourceEvaluation {
  try {
    return evaluateInternal(input);
  } catch (error) {
    return Object.freeze({
      status: "incomplete",
      assumptions,
      windows: Object.freeze([]),
      missing: Object.freeze([missingReason({
        code: "calculator-error",
        path: "plan-resource-evaluation",
        message: calculatorMessage(error)
      })])
    });
  }
}
