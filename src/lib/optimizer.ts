import { operators } from "../data/defaults";
import { clampEliteForOperator } from "./elite";
import { localizeText } from "./localization";
import {
  createRegionallyAvailableState,
  isOperatorAvailable,
  operatorAvailabilitySnapshot
} from "./operatorAvailability";
import { evaluatePlanResources } from "./planResourceEvaluator";
import { evaluatePlanSustainability } from "./planSustainabilityEvaluator";
import { simulateFacilityProduction } from "./facilityProduction";
import { normalizeSchedule, scheduleEpsilonHours } from "./schedule";
import { resolveSupportResourceScenario } from "./supportResourceScenario";
import { modeledFacilityLevel } from "./facilityLevel";
import { activeBaseSkills } from "./activeBaseSkills";
import { cyclicHalfOpenIntervalsOverlap, splitCyclicHalfOpenInterval } from "./cyclicInterval";
import { searchBestConflictFreeOptions } from "./compositionSearch";
export { activeBaseSkills } from "./activeBaseSkills";
import type {
  AppState,
  Assignment,
  AssignmentPlan,
  BaseSkill,
  BaseSkillFamily,
  BaseSkillCondition,
  BaseSkillEffect,
  FacilityPlan,
  FacilitySlot,
  GenerateAssignmentPlanOptions,
  Operator,
  OptimizationPreference,
  ProductType,
  RosterEntry,
  ScheduledSupportPlacement,
  ScheduledSupportValidationIssue,
  SupportResourceScenarioEvaluation,
  WindowFacilityEfficiencyEvaluation
} from "../types";

type AssignmentEvaluationContext = {
  assignments: Assignment[];
  facilities: FacilitySlot[];
  roster?: AppState["roster"];
  shiftHours?: number;
  workElapsedHours?: number;
  moraleSpentBefore?: number;
  workElapsedHoursByOperator?: ReadonlyMap<string, number>;
  fixedResourceAmounts?: Readonly<Record<string, number>>;
  fixedDormitoryOccupancy?: number;
  excludedOrdinaryResourceOperatorIds?: ReadonlySet<string>;
  reservedOperatorIds?: ReadonlySet<string>;
  reservedFacilitySlots?: ReadonlyMap<string, number>;
};

export type ExplicitFacilityTeamDiagnosticCode =
  | "evaluation-hours-invalid"
  | "facility-not-found"
  | "facility-capacity-exceeded"
  | "facility-declared-more-than-once"
  | "operator-not-found"
  | "operator-unowned"
  | "operator-region-unavailable"
  | "operator-facility-ineligible"
  | "operator-assignment-conflict";

export interface ExplicitFacilityTeamDiagnostic {
  code: ExplicitFacilityTeamDiagnosticCode;
  path: string;
  message: string;
  facilityId?: string;
  operatorId?: string;
}

export interface ExplicitFacilityTeamInspectionInput {
  teams: readonly { facilityId: string; operatorIds: readonly string[] }[];
  supportPlacements?: readonly { facilityId: string; operatorIds: readonly string[] }[];
  evaluationHours: number;
  fixedResourceAmounts?: Readonly<Record<string, number>>;
  fixedDormitoryOccupancy?: number;
  excludedOrdinaryResourceOperatorIds?: ReadonlySet<string>;
}

export type ExplicitFacilityTeamInspectionResult =
  | {
      status: "complete";
      diagnostics: readonly ExplicitFacilityTeamDiagnostic[];
      teams: readonly {
        facilityId: string;
        assignments: readonly Assignment[];
        expectedEfficiency: number;
      }[];
      supportAssignments: readonly Assignment[];
    }
  | {
      status: "incomplete";
      diagnostics: readonly ExplicitFacilityTeamDiagnostic[];
      teams: readonly [];
      supportAssignments: readonly [];
    };

type GlobalBonusBucket = {
  stackKey?: string;
  value: number;
};

type FacilityAffiliationCondition = Extract<BaseSkillCondition, { type: "facilityAffiliation" }>;

type ComplexBaseSkillHandlerInput = {
  operator: Operator;
  skill: BaseSkill;
  effect: BaseSkillEffect;
  elite: number;
  facility: FacilitySlot;
  context?: AssignmentEvaluationContext;
};

type ComplexBaseSkillHandler = {
  scalingMultiplier?: (input: ComplexBaseSkillHandlerInput) => number;
  remoteFacilityStatBonuses?: (
    input: ComplexBaseSkillHandlerInput
  ) => NonNullable<Assignment["remoteFacilityStatBonuses"]>;
  remoteFacilityEfficiencyBonuses?: (
    input: ComplexBaseSkillHandlerInput
  ) => NonNullable<Assignment["remoteFacilityEfficiencyBonuses"]>;
};

const complexBaseSkillHandlers: Record<string, Record<string, ComplexBaseSkillHandler>> = {
  char_4110_delphn: {
    "control_tra_limit&spd[010]": controlFacilityAffiliationRemoteEfficiencyHandler()
  },
  char_1034_jesca2: {
    "control_bd_spd[000]": controlFacilityAffiliationRemoteEfficiencyHandler()
  },
  char_1045_svash2: {
    "control_tra_limit&spd3[000]": controlFacilityGroupAffiliationRemoteEfficiencyHandler()
  },
  char_4208_wintim: {
    "manu_prod_spd&manu[100]": suppressingSelfOnlySameFacilityScalingHandler()
  },
  char_206_gnosis: {
    "control_tra_limit&spd[000]": controlFacilityAffiliationRemoteStatAndEfficiencyHandler()
  },
  char_420_flamtl: {
    "control_mp_psk[000]": controlFacilityAffiliationRemoteEfficiencyHandler()
  }
};

export function registeredComplexBaseSkillHandlerKeys(capability?: keyof ComplexBaseSkillHandler) {
  return Object.entries(complexBaseSkillHandlers).flatMap(([operatorId, handlers]) =>
    Object.entries(handlers)
      .filter(([, handler]) => !capability || Boolean(handler[capability]))
      .map(([skillId]) => `${operatorId}:${skillId}`)
  );
}

const moraleCapacity = 24;
const baseMoraleConsumptionPerHour = 1;
const controlCenterReductionPerOperator = 0.05;
const sharedRoomReductionPerAdditionalOperator = 0.05;
const maxDormitoryRecoveryPerHour = 4;
const baselineAssignmentReasons: Record<AppState["language"], string> = {
  ja: "適用可能な基地スキルなし（基準効率）",
  zh: "无可用基建技能（基础效率）",
  en: "No applicable base skill (baseline efficiency)"
};

const tradingPostBaseOrderLimit = 10;
const normalGoldOrderHours = [
  { hours: 2.4, probability: 0.3 },
  { hours: 3.5, probability: 0.5 },
  { hours: 4.6, probability: 0.2 }
] as const;
const averageNormalGoldOrderHours = normalGoldOrderHours.reduce(
  (sum, order) => sum + order.hours * order.probability,
  0
);

function optimizerShiftHours(state: AppState) {
  const firstShift = state.schedule.shifts[0];
  return firstShift ? firstShift.endHour - firstShift.startHour : 12;
}

function finiteNumber(value: number, name: string) {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be finite`);
  }
  return value;
}

function positiveFiniteNumber(value: number, name: string) {
  const finite = finiteNumber(value, name);
  if (finite <= 0) {
    throw new RangeError(`${name} must be positive`);
  }
  return finite;
}

function finiteCalculation(value: number, name: string) {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} produced a non-finite result`);
  }
  return value;
}

function averageArithmeticSegments(
  durationHours: number,
  segmentWidthHours: number,
  initialValue: number,
  increment: number
) {
  if (segmentWidthHours === 0) {
    if (increment === 0) return initialValue;
    throw new RangeError("piecewise segment count produced a non-finite result");
  }
  const segmentCount = finiteCalculation(
    durationHours / segmentWidthHours,
    "piecewise segment count"
  );
  const fullSegments = Math.floor(segmentCount);
  const fullDuration = finiteCalculation(fullSegments * segmentWidthHours, "full segment duration");
  const finalDuration = Math.max(0, durationHours - fullDuration);
  let average = 0;
  if (fullSegments > 0) {
    const averageIndex = (fullSegments - 1) / 2;
    const fullAverage = finiteCalculation(
      initialValue + finiteCalculation(increment * averageIndex, "arithmetic sequence increment"),
      "arithmetic sequence value"
    );
    average = finiteCalculation(
      (fullDuration / durationHours) * fullAverage,
      "full segment weighted average"
    );
  }
  if (finalDuration > 0) {
    const finalValue = finiteCalculation(
      initialValue + finiteCalculation(increment * fullSegments, "final segment increment"),
      "final segment value"
    );
    average = finiteCalculation(
      average + (finalDuration / durationHours) * finalValue,
      "piecewise weighted average"
    );
  }
  return average;
}

function averageBoundedArithmeticSegments(
  durationHours: number,
  segmentWidthHours: number,
  initialValue: number,
  increment: number,
  bound: number,
  boundKind: "upper" | "lower"
) {
  const clamp = boundKind === "upper" ? Math.min : Math.max;
  if (increment === 0) return clamp(initialValue, bound);
  if (segmentWidthHours === 0) {
    const movesTowardBound = boundKind === "upper" ? increment > 0 : increment < 0;
    if (movesTowardBound) return bound;
    throw new RangeError("piecewise segment count produced a non-finite result");
  }

  const initiallyBounded = boundKind === "upper" ? initialValue >= bound : initialValue <= bound;
  const movesTowardBound = boundKind === "upper" ? increment > 0 : increment < 0;
  if (initiallyBounded === movesTowardBound) {
    return initiallyBounded ? bound : averageArithmeticSegments(
      durationHours,
      segmentWidthHours,
      initialValue,
      increment
    );
  }

  const distance = finiteCalculation(Math.abs(bound - initialValue), "piecewise bound distance");
  const transitionIndex = Math.ceil(finiteCalculation(
    distance / Math.abs(increment),
    "piecewise bound index"
  ));
  const transitionHours = finiteCalculation(
    transitionIndex * segmentWidthHours,
    "piecewise bound duration"
  );
  if (transitionHours >= durationHours) {
    return initiallyBounded ? bound : averageArithmeticSegments(
      durationHours,
      segmentWidthHours,
      initialValue,
      increment
    );
  }

  const transitionFraction = transitionHours / durationHours;
  if (!initiallyBounded) {
    const arithmeticAverage = averageArithmeticSegments(
      transitionHours,
      segmentWidthHours,
      initialValue,
      increment
    );
    return finiteCalculation(
      transitionFraction * arithmeticAverage + (1 - transitionFraction) * bound,
      "bounded arithmetic weighted average"
    );
  }

  const transitionedValue = finiteCalculation(
    initialValue + finiteCalculation(increment * transitionIndex, "bound transition increment"),
    "bound transition value"
  );
  const arithmeticAverage = averageArithmeticSegments(
    durationHours - transitionHours,
    segmentWidthHours,
    transitionedValue,
    increment
  );
  return finiteCalculation(
    transitionFraction * bound + (1 - transitionFraction) * arithmeticAverage,
    "bounded arithmetic weighted average"
  );
}

function intervalAverage(
  prefixAverage: (durationHours: number) => number,
  durationHours: number,
  elapsedHours: number
) {
  const duration = positiveFiniteNumber(durationHours, "durationHours");
  const elapsed = finiteNumber(elapsedHours, "elapsedHours");
  if (elapsed < 0) throw new RangeError("elapsedHours must be non-negative");
  if (elapsed === 0) return prefixAverage(duration);
  return finiteCalculation(
    (prefixAverage(elapsed + duration) * (elapsed + duration) - prefixAverage(elapsed) * elapsed) / duration,
    "interval average"
  );
}

export function averageEffectEfficiency(effect: BaseSkillEffect, shiftHours: number, elapsedHours = 0) {
  const durationHours = positiveFiniteNumber(shiftHours, "shiftHours");
  if (effect.moraleCurve) {
    return averageMoraleCurveEfficiency(effect.moraleCurve, durationHours, 1);
  }
  if (!effect.timeCurve) {
    return effect.efficiency;
  }
  const { initialEfficiency, efficiencyPerHour, maxEfficiency, startsAfterFirstHour } = effect.timeCurve;
  finiteNumber(initialEfficiency, "timeCurve.initialEfficiency");
  finiteNumber(efficiencyPerHour, "timeCurve.efficiencyPerHour");
  finiteNumber(maxEfficiency, "timeCurve.maxEfficiency");
  const firstSegmentValue = finiteCalculation(
    initialEfficiency + (startsAfterFirstHour ? 0 : efficiencyPerHour),
    "timeCurve first segment"
  );
  return intervalAverage((prefixHours) => averageBoundedArithmeticSegments(
    prefixHours, 1, firstSegmentValue, efficiencyPerHour, maxEfficiency, "upper"
  ), durationHours, elapsedHours);
}

export function averageMoraleCurveEfficiency(
  curve: NonNullable<BaseSkillEffect["moraleCurve"]>,
  shiftHours: number,
  moraleConsumptionPerHour: number
) {
  const durationHours = positiveFiniteNumber(shiftHours, "shiftHours");
  const consumptionRate = finiteNumber(moraleConsumptionPerHour, "moraleConsumptionPerHour");
  if (consumptionRate < 0) {
    throw new RangeError("moraleConsumptionPerHour must be non-negative");
  }
  finiteNumber(curve.initialEfficiency, "moraleCurve.initialEfficiency");
  finiteNumber(curve.efficiencyPerStep, "moraleCurve.efficiencyPerStep");
  positiveFiniteNumber(curve.moralePerStep, "moraleCurve.moralePerStep");
  finiteNumber(curve.minEfficiency, "moraleCurve.minEfficiency");
  if (consumptionRate === 0) {
    return Math.max(curve.initialEfficiency, curve.minEfficiency);
  }
  const thresholdHours = finiteCalculation(
    curve.moralePerStep / consumptionRate,
    "moraleCurve threshold duration"
  );
  return averageBoundedArithmeticSegments(
    durationHours,
    thresholdHours,
    curve.initialEfficiency,
    curve.efficiencyPerStep,
    curve.minEfficiency,
    "lower"
  );
}

function averageMoraleCurveSegmentEfficiency(
  curve: NonNullable<BaseSkillEffect["moraleCurve"]>,
  shiftHours: number,
  moraleConsumptionPerHour: number,
  moraleSpentBefore: number
) {
  const spentBefore = finiteNumber(moraleSpentBefore, "moraleSpentBefore");
  if (spentBefore < 0) throw new RangeError("moraleSpentBefore must be non-negative");
  if (moraleConsumptionPerHour === 0) {
    const step = Math.floor(spentBefore / positiveFiniteNumber(curve.moralePerStep, "moraleCurve.moralePerStep"));
    return Math.max(curve.initialEfficiency + curve.efficiencyPerStep * step, curve.minEfficiency);
  }
  return intervalAverage(
    (spent) => averageMoraleCurveEfficiency(curve, spent, 1),
    shiftHours * moraleConsumptionPerHour,
    spentBefore
  );
}

export function generateAssignmentPlan(
  state: AppState,
  options: GenerateAssignmentPlanOptions = {}
): AssignmentPlan {
  return generateAssignmentPlanInternal(state, options, true);
}

export interface ScheduleAwareWorkSegment {
  operatorId: string;
  scheduleWindowId: string;
  blockId: string;
  sequenceIndex: number;
  elapsedWorkHours: number;
}

/** Derives deterministic cyclic work blocks; a non-working or temporal gap starts a new block. */
export function deriveScheduleAwareWorkSegments(
  schedule: AppState["schedule"],
  rotation: readonly Pick<AssignmentPlan["rotation"][number], "shiftId" | "startHour" | "endHour" | "assignments">[]
): readonly ScheduleAwareWorkSegment[] {
  const ordered = [...rotation].sort((left, right) =>
    left.startHour - right.startHour || left.endHour - right.endHour || compareCodePoints(left.shiftId, right.shiftId)
  );
  const operatorIds = [...new Set(ordered.flatMap((window) =>
    window.assignments.map((assignment) => assignment.operatorId)
  ))].sort(compareCodePoints);
  const segments: ScheduleAwareWorkSegment[] = [];
  const isAdjacent = (previousIndex: number, currentIndex: number) => {
    const previous = ordered[previousIndex];
    const current = ordered[currentIndex];
    return previousIndex < currentIndex
      ? Math.abs(previous.endHour - current.startHour) <= scheduleEpsilonHours
      : Math.abs(previous.endHour - schedule.cycleHours) <= scheduleEpsilonHours &&
          Math.abs(current.startHour) <= scheduleEpsilonHours;
  };
  for (const operatorId of operatorIds) {
    const active = new Set(ordered.flatMap((window, index) =>
      window.assignments.some((assignment) => assignment.operatorId === operatorId) ? [index] : []
    ));
    const starts = [...active].filter((index) => {
      const previous = (index + ordered.length - 1) % ordered.length;
      return !active.has(previous) || !isAdjacent(previous, index);
    }).sort((left, right) => left - right);
    const deterministicStarts = starts.length > 0 ? starts : [[...active].sort((left, right) => left - right)[0]];
    for (const [blockIndex, start] of deterministicStarts.entries()) {
      let elapsedWorkHours = 0;
      let sequenceIndex = 0;
      let index = start;
      while (active.has(index)) {
        const window = ordered[index];
        segments.push({
          operatorId,
          scheduleWindowId: window.shiftId,
          blockId: `${operatorId}:${blockIndex}`,
          sequenceIndex,
          elapsedWorkHours
        });
        elapsedWorkHours += window.endHour - window.startHour;
        sequenceIndex += 1;
        const next = (index + 1) % ordered.length;
        if (next === start || !active.has(next) || !isAdjacent(index, next) || starts.includes(next)) break;
        index = next;
      }
    }
  }
  return segments.sort((left, right) =>
    compareCodePoints(left.operatorId, right.operatorId) ||
    compareCodePoints(left.blockId, right.blockId) || left.sequenceIndex - right.sequenceIndex
  );
}

function generateAssignmentPlanInternal(
  state: AppState,
  options: GenerateAssignmentPlanOptions,
  allowSupportFallback: boolean
): AssignmentPlan {
  state = { ...state, schedule: normalizeSchedule(state.schedule) };
  const scenarioState = state;
  state = createRegionallyAvailableState(state, operatorAvailabilitySnapshot, state.region);
  const enabledFacilities = state.facilities.filter((facility) => facility.type !== "dormitory");
  const scheduleSkeleton = buildRotationWindows([], [], state.schedule).windows;
  const initialSupportResourceScenario = options.supportResourceScenario
    ? resolveSupportResourceScenario(scenarioState, options.supportResourceScenario, scheduleSkeleton)
    : undefined;
  const supportSelectionContext = allowSupportFallback && initialSupportResourceScenario
    ? buildSupportSelectionContext(state, initialSupportResourceScenario, scheduleSkeleton)
    : undefined;
  if (isCanonicalThreeGroupSchedule(state.schedule)) {
    return generateCanonicalThreeGroupPlan(
      state,
      scenarioState,
      options,
      allowSupportFallback,
      initialSupportResourceScenario,
      supportSelectionContext
    );
  }
  let facilityPlans = buildFacilityPlans(state, enabledFacilities, [], new Set(), supportSelectionContext);

  for (let index = 0; index < 3; index += 1) {
    const nextFacilityPlans = buildFacilityPlans(
      state,
      enabledFacilities,
      facilityPlans.flatMap((plan) => plan.assignments),
      new Set(),
      supportSelectionContext
    );
    if (assignmentSignature(nextFacilityPlans) === assignmentSignature(facilityPlans)) {
      facilityPlans = nextFacilityPlans;
      break;
    }
    facilityPlans = nextFacilityPlans;
  }

  facilityPlans = attachRotationAlternativesWithContext(state, facilityPlans, supportSelectionContext);
  facilityPlans = applyMoraleDurations(state, facilityPlans);

  const activeAssignments = facilityPlans.flatMap((plan) => plan.assignments);
  const alternativeAssignments = facilityPlans.flatMap((plan) => plan.alternatives);
  const totalScore = facilityPlans.reduce((sum, plan) => sum + plan.score, 0);
  let dailyValue = facilityPlans.reduce(
    (sum, plan) => sum + plan.expectedEfficiency * productWeight(plan.facility.product, state.preference) * 24,
    0
  );

  const rotationResult = buildRotationWindows(activeAssignments, alternativeAssignments, state.schedule);
  const warnings = [
    ...buildWarnings(state, enabledFacilities, facilityPlans),
    ...rotationResult.diagnostics.map((diagnostic) => diagnostic.message)
  ];

  const supportResourceScenario = options.supportResourceScenario
    ? resolveSupportResourceScenario(scenarioState, options.supportResourceScenario, rotationResult.windows)
    : undefined;
  if (allowSupportFallback && supportSelectionContext && supportResourceScenario && !supportResourceScenario.complete) {
    return generateAssignmentPlanInternal(scenarioState, options, false);
  }
  const windowFacilityEfficiencyEvaluations = supportResourceScenario?.complete
    ? evaluateWindowFacilityEfficiencies(state, facilityPlans, rotationResult.windows, supportResourceScenario)
    : undefined;
  if (windowFacilityEfficiencyEvaluations) {
    dailyValue = windowFacilityEfficiencyEvaluations.reduce((sum, evaluation) => {
      const facility = facilityPlans.find((plan) => plan.facility.id === evaluation.facilityId)?.facility;
      const window = rotationResult.windows.find((candidate) => candidate.shiftId === evaluation.scheduleWindowId);
      return facility && window
        ? sum + evaluation.additiveEfficiency * productWeight(facility.product, state.preference) *
          (window.endHour - window.startHour) * 24 / state.schedule.cycleHours
        : sum;
    }, 0);
  }
  const plan = {
    generatedAt: new Date().toISOString(),
    totalScore,
    dailyValue,
    facilityPlans,
    schedule: structuredClone(state.schedule),
    rotation: rotationResult.windows,
    diagnostics: rotationResult.diagnostics,
    warnings,
    ...(supportResourceScenario ? { supportResourceScenario } : {}),
    ...(windowFacilityEfficiencyEvaluations ? { windowFacilityEfficiencyEvaluations } : {})
  };
  const resources = evaluatePlanResources(plan);
  const planWithResources = { ...plan, resources };
  return {
    ...planWithResources,
    sustainability: evaluatePlanSustainability({ plan: planWithResources, layout: state.layout })
  };
}

function isCanonicalThreeGroupSchedule(schedule: AppState["schedule"]) {
  const groupIds = schedule.groups.map(({ id }) => id);
  const declared = new Set(groupIds);
  const activeGroupCount = schedule.shifts[0]?.activeGroupIds.length ?? 0;
  return groupIds.length === 3 && declared.size === 3 && schedule.shifts.length > 0 &&
    activeGroupCount > 0 &&
    groupIds.every((groupId) => schedule.shifts.some((shift) => shift.activeGroupIds.includes(groupId))) &&
    schedule.shifts.every((shift) =>
      shift.activeGroupIds.length === activeGroupCount &&
      shift.activeGroupIds.every((groupId) => declared.has(groupId))
    );
}

type ScheduledProductionCategory = {
  stableId: string;
  facilities: FacilitySlot[];
  logicalFacilities: FacilitySlot[];
};

type ScheduledProductionSelection = {
  groupId: string;
  dimensionId: string;
  categoryId: string;
  logicalIndex: number;
  facility: FacilitySlot;
  assignments: Assignment[];
};

function scheduleWindowFixedContext(
  scenario: SupportResourceScenarioEvaluation | undefined,
  shiftId: string
) {
  const sources = scenario?.sources
    .filter((evidence) => evidence.status === "resolved" && evidence.source.scheduleWindowId === shiftId)
    .sort((left, right) => compareCodePoints(left.source.id, right.source.id)) ?? [];
  return {
    fixedResourceAmounts: Object.freeze(sources.reduce<Record<string, number>>((amounts, evidence) => {
      amounts[evidence.source.resourceKey] = (amounts[evidence.source.resourceKey] ?? 0) + evidence.source.amount;
      return amounts;
    }, {})),
    excludedOrdinaryResourceOperatorIds: new Set(sources.map((evidence) => evidence.source.operatorId))
  };
}

function scheduledGroupsOverlap(
  state: AppState,
  leftGroupId: string,
  rightGroupId: string
) {
  const leftWindows = state.schedule.shifts.filter((shift) => shift.activeGroupIds.includes(leftGroupId));
  const rightWindows = state.schedule.shifts.filter((shift) => shift.activeGroupIds.includes(rightGroupId));
  return leftWindows.some((left) => rightWindows.some((right) =>
    cyclicHalfOpenIntervalsOverlap(left, right, state.schedule.cycleHours)
  ));
}

function scheduledConflictKeys(
  state: AppState,
  groupIds: readonly string[],
  groupId: string,
  kind: "operator" | "global-stack",
  value: string
) {
  return groupIds
    .filter((otherGroupId) => scheduledGroupsOverlap(state, groupId, otherGroupId))
    .map((otherGroupId) => {
      const pair = [groupId, otherGroupId].sort(compareCodePoints);
      return `${kind}:${value}:${pair[0]}:${pair[1]}`;
    });
}

function buildScheduledProductionCategories(state: AppState) {
  const productionFacilities = state.facilities.filter((facility) =>
    facility.type === "factory" || facility.type === "trading"
  );
  const maximumActiveGroups = Math.max(...state.schedule.shifts.map((shift) => shift.activeGroupIds.length));
  const byCategory = new Map<string, FacilitySlot[]>();
  for (const facility of productionFacilities) {
    const stableId = `${facility.type}:${facility.product}`;
    const facilities = byCategory.get(stableId) ?? [];
    facilities.push(facility);
    byCategory.set(stableId, facilities);
  }
  const categories: ScheduledProductionCategory[] = [];
  const unrepresentableCategoryIds: string[] = [];
  for (const [stableId, unsortedFacilities] of [...byCategory.entries()]
    .sort(([left], [right]) => compareCodePoints(left, right))) {
    const facilities = [...unsortedFacilities].sort((left, right) => compareCodePoints(left.id, right.id));
    if (maximumActiveGroups <= 0 || facilities.length % maximumActiveGroups !== 0) {
      unrepresentableCategoryIds.push(stableId);
      continue;
    }
    const logicalFacilities = Array.from(
      { length: facilities.length / maximumActiveGroups },
      (_, logicalIndex) => ({ ...facilities[logicalIndex], id: `schedule:${stableId}:${logicalIndex}` })
    );
    categories.push({ stableId, facilities, logicalFacilities });
  }
  return { categories, unrepresentableCategoryIds, maximumActiveGroups };
}

function buildCanonicalScheduledProduction(
  state: AppState,
  staticPlans: readonly FacilityPlan[],
  scenario: SupportResourceScenarioEvaluation | undefined,
  selectionContext: AssignmentEvaluationContext | undefined,
  supportPlacements: readonly ScheduledSupportPlacement[] = [],
  supportAssignments: readonly Assignment[] = []
) {
  const staticAssignments = staticPlans.flatMap((plan) => plan.assignments);
  const groupIds = state.schedule.groups.map(({ id }) => id).sort(compareCodePoints);
  const { categories, unrepresentableCategoryIds, maximumActiveGroups } =
    buildScheduledProductionCategories(state);
  const logicalFacilities = categories.flatMap((category) => category.logicalFacilities);
  const contextFacilities = [...state.facilities, ...logicalFacilities];
  const reservedOperatorIds = selectionContext?.reservedOperatorIds ?? new Set<string>();
  const dormitoryAssignments = implicitDormitoryResourceAssignments(
    state,
    [...staticAssignments],
    reservedOperatorIds,
    selectionContext?.reservedFacilitySlots
  );
  const unavailableOperatorIds = new Set([
    ...staticAssignments.map((assignment) => assignment.operatorId),
    ...supportAssignments.map((assignment) => assignment.operatorId),
    ...dormitoryAssignments.map((assignment) => assignment.operatorId),
    ...reservedOperatorIds
  ]);
  const staticGlobalStackKeys = new Set(staticAssignments.flatMap(assignmentGlobalStackKeys));
  const optionSets = categories.flatMap((category) => category.logicalFacilities.map((facility, logicalIndex) => {
    const baseContext: AssignmentEvaluationContext = {
      ...selectionContext,
      assignments: [...staticAssignments, ...dormitoryAssignments],
      facilities: contextFacilities,
      roster: state.roster,
      shiftHours: optimizerShiftHours(state)
    };
    const candidates = findCandidates(facility, state, 0, baseContext)
      .filter((candidate) => !unavailableOperatorIds.has(candidate.operatorId))
      .sort(compareFacilityCandidates);
    const generation = buildFacilityTeamOptionSet(
      candidates,
      availableOrdinaryFacilitySlots(facility, selectionContext)
    );
    return { category, facility, logicalIndex, candidates, generation };
  }));
  const moraleConsumptionCache = new Map<string, number>();
  const dimensions = groupIds.flatMap((groupId) => optionSets.map((optionSet) => {
    const dimensionId = `${groupId}:${optionSet.facility.id}`;
    const activeWindows = state.schedule.shifts.filter((shift) => shift.activeGroupIds.includes(groupId));
    const groupSegments = deriveScheduleAwareWorkSegments(
      state.schedule,
      state.schedule.shifts.map((shift) => ({
        shiftId: shift.id,
        startHour: shift.startHour,
        endHour: shift.endHour,
        assignments: shift.activeGroupIds.includes(groupId) ? [{
          facilityId: optionSet.facility.id,
          operatorId: "schedule-progress",
          skillId: "schedule-progress",
          score: 0,
          efficiency: 0,
          fatigueHours: moraleCapacity,
          recoveryHours: 0,
          reason: "Schedule progress marker"
        }] : []
      }))
    );
    const progressByWindow = new Map(groupSegments.map((segment) => [segment.scheduleWindowId, segment]));
    return {
      stableId: dimensionId,
      required: true,
      options: optionSet.generation.options.flatMap((rawAssignments) => {
        const slotCount = availableOrdinaryFacilitySlots(optionSet.facility, selectionContext);
        const fillsDimension = facilitySlotOccupancy(rawAssignments) === slotCount && slotCount > 0;
        if (!fillsDimension || !facilityTeamHasValidStructure(rawAssignments, slotCount)) return [];
        if (rawAssignments.flatMap(assignmentGlobalStackKeys).some((key) => staticGlobalStackKeys.has(key))) return [];
        let aggregateScore = 0;
        let naturalGoldNetChange = 0;
        const moraleSpentByOperator = new Map<string, number>();
        for (const window of [...activeWindows].sort((left, right) =>
          (progressByWindow.get(left.id)?.sequenceIndex ?? 0) -
            (progressByWindow.get(right.id)?.sequenceIndex ?? 0) ||
          compareCodePoints(left.id, right.id)
        )) {
          const fixed = scheduleWindowFixedContext(scenario, window.id);
          const scheduledSupport = supportAssignments.filter((assignment) =>
            supportPlacements.some((placement) => placement.kind === "ordinary" &&
              placement.operatorId === assignment.operatorId &&
              placement.facilityId === assignment.facilityId &&
              placement.scheduleWindowIds.includes(window.id))
          );
          const context: AssignmentEvaluationContext = {
            ...selectionContext,
            ...fixed,
            assignments: [...staticAssignments, ...scheduledSupport, ...dormitoryAssignments, ...rawAssignments],
            facilities: contextFacilities,
            roster: state.roster,
            shiftHours: window.endHour - window.startHour,
            workElapsedHoursByOperator: new Map(rawAssignments.map((assignment) => [
              assignment.operatorId,
              progressByWindow.get(window.id)?.elapsedWorkHours ?? 0
            ]))
          };
          const reevaluatedAssignments = reevaluateFacilityTeam(rawAssignments, optionSet.facility, state, context);
          if (!facilityTeamEligibleForScheduleComparison(rawAssignments, reevaluatedAssignments, slotCount)) return [];
          const assignments = reevaluatedAssignments.map((assignment) => {
            if (!assignment.moraleEfficiencyCurves?.length) return assignment;
            const cacheKey = `${optionSet.facility.id}\u0000${facilityTeamStableSignature(rawAssignments)}` +
              `\u0000${window.id}\u0000${assignment.operatorId}`;
            let consumptionPerHour = moraleConsumptionCache.get(cacheKey);
            if (consumptionPerHour === undefined) {
              consumptionPerHour = applyMoraleDurationToAssignment(
                assignment,
                state,
                { ...context, moraleSpentBefore: 0 },
                context,
                false,
                undefined,
                undefined,
                true
              ).moraleConsumptionPerHour ?? 0;
              moraleConsumptionCache.set(cacheKey, consumptionPerHour);
            }
            const moraleSpentBefore = moraleSpentByOperator.get(assignment.operatorId) ?? 0;
            return {
              ...assignment,
              efficiency: assignment.efficiency + assignment.moraleEfficiencyCurves.reduce(
                (sum, curve) => sum + averageMoraleCurveSegmentEfficiency(
                  curve,
                  window.endHour - window.startHour,
                  consumptionPerHour!,
                  moraleSpentBefore
                ) - curve.baselineEfficiency,
                0
              ),
              moraleConsumptionPerHour: consumptionPerHour
            };
          });
          for (const assignment of assignments) {
            moraleSpentByOperator.set(
              assignment.operatorId,
              Math.min(
                moraleCapacity,
                (moraleSpentByOperator.get(assignment.operatorId) ?? 0) +
                  (assignment.moraleConsumptionPerHour ?? 0) * (window.endHour - window.startHour)
              )
            );
          }
          const facilityBonus = calculateGlobalBonus(state, optionSet.facility, context) +
            calculateRemoteFacilityEfficiencyBonus(optionSet.facility, context);
          aggregateScore += facilityTeamSelectionScore(
            assignments,
            optionSet.facility,
            state.preference,
            facilityBonus
          ) * (window.endHour - window.startHour);
          if (optionSet.facility.type === "factory" && optionSet.facility.product === "gold") {
            naturalGoldNetChange += simulateFacilityProduction({
              durationHours: window.endHour - window.startHour,
              facility: { kind: "factory", level: 3, product: "gold" },
              teamEffects: [{
                id: `canonical-${dimensionId}-${window.id}`,
                source: "operator",
                additiveEfficiency: effectiveFacilityEfficiency(assignments, facilityBonus),
                target: "gold"
              }]
            }).ledger.goldNetChange;
          } else if (optionSet.facility.type === "trading") {
            naturalGoldNetChange += simulateFacilityProduction({
              durationHours: window.endHour - window.startHour,
              facility: { kind: "tradingPost", level: 3, orderType: "normalLmd" },
              teamEffects: [{
                id: `canonical-${dimensionId}-${window.id}`,
                source: "operator",
                additiveEfficiency: effectiveFacilityEfficiency(assignments, facilityBonus),
                target: "normalOrder"
              }]
            }).ledger.goldNetChange;
          }
        }
        const operatorConflictKeys = rawAssignments.flatMap((assignment) =>
          scheduledConflictKeys(state, groupIds, groupId, "operator", assignment.operatorId)
        );
        const stackConflictKeys = rawAssignments.flatMap((assignment) => assignmentGlobalStackKeys(assignment)
          .flatMap((stackKey) => scheduledConflictKeys(state, groupIds, groupId, "global-stack", stackKey)));
        const retentionKeys = teamRetentionKeys(rawAssignments);
        const maximumMoraleSpent = Math.max(0, ...moraleSpentByOperator.values());
        return [{
          stableId: facilityTeamStableSignature(rawAssignments),
          score: aggregateScore,
          feasibilityRank: naturalGoldNetChange - maximumMoraleSpent * 1_000,
          conflictKeys: [...operatorConflictKeys, ...stackConflictKeys],
          retentionKeys,
          fillsDimension: true,
          value: {
            groupId,
            dimensionId,
            categoryId: optionSet.category.stableId,
            logicalIndex: optionSet.logicalIndex,
            facility: optionSet.facility,
            assignments: rawAssignments
          } satisfies ScheduledProductionSelection
        }];
      })
    };
  }));
  const dimensionIds = dimensions.map(({ stableId }) => stableId).sort(compareCodePoints);
  const forcedIncompleteDimensionIds = unrepresentableCategoryIds.flatMap((categoryId) =>
    groupIds.map((groupId) => `${groupId}:unrepresentable:${categoryId}`)
  ).sort(compareCodePoints);
  const feasibilityBySelection = new Map<string, boolean>();
  const requiredPlacements = [...supportPlacements, ...requiredScenarioSupportPlacements(state, scenario)]
    .filter((placement, index, placements) => placements.findIndex((candidate) =>
      candidate.kind === placement.kind && candidate.operatorId === placement.operatorId &&
      candidate.facilityId === placement.facilityId &&
      candidate.scheduleWindowIds.join("\u0000") === placement.scheduleWindowIds.join("\u0000") &&
      candidate.recoveryWindowIds.join("\u0000") === placement.recoveryWindowIds.join("\u0000")
    ) === index);
  const requiresClosedResourceSearch = scenario?.complete === true &&
    state.facilities.some((facility) => facility.type === "factory" && facility.product === "gold") &&
    state.facilities.some((facility) => facility.type === "trading");
  const searchResult = forcedIncompleteDimensionIds.length > 0
    ? undefined
    : !requiresClosedResourceSearch
      ? searchBestConflictFreeOptions(dimensions)
      : searchBestConflictFreeOptions(dimensions, {
        completeSelectionEvaluationBudget: supportAssignments.length === 0 ? 32 : 12,
        isCompleteSelectionFeasible: (options) => {
          const signature = options.map((option) => `${option.value.dimensionId}:${option.stableId}`).join("|");
          const cached = feasibilityBySelection.get(signature);
          if (cached !== undefined) return cached;
          const feasible = canonicalSelectionIsSustainable(
            state,
            staticPlans,
            {
              categories,
              groupIds,
              maximumActiveGroups,
              selections: options.map((option) => option.value),
              complete: true,
              diagnostics: []
            },
            scenario,
            selectionContext,
            requiredPlacements,
            supportAssignments
          );
          feasibilityBySelection.set(signature, feasible);
          return feasible;
        }
      });
  const complete = Boolean(searchResult && searchResult.diagnostic.completion === "complete");
  const selections = complete
    ? searchResult!.options.map((option) => option.value)
    : [];
  const incompleteDimensionIds = complete
    ? []
    : forcedIncompleteDimensionIds.length > 0 ? forcedIncompleteDimensionIds : dimensionIds;
  const generationDiagnostics = optionSets.map(({ generation }) => generation.diagnostic);
  const candidateGenerationLimited = generationDiagnostics.some((diagnostic) =>
    diagnostic.optimality === "not-certified"
  );
  const provenInfeasible = forcedIncompleteDimensionIds.length > 0 || Boolean(
    searchResult?.diagnostic.completion === "infeasible" && !candidateGenerationLimited
  );
  const completion = complete ? "complete" as const : provenInfeasible ? "infeasible" as const : "unknown" as const;
  const searchLimitation = searchResult?.diagnostic.limitation;
  const notCertified = completion === "unknown" || candidateGenerationLimited ||
    searchResult?.diagnostic.optimality === "not-certified";
  const limitation = searchLimitation === "feasibility-budget-limited" ||
    searchLimitation === "optimization-budget-limited"
    ? searchLimitation
    : candidateGenerationLimited
      ? "candidate-generation-limited" as const
      : searchLimitation;
  const diagnostics: AssignmentPlan["diagnostics"] = [
    ...(provenInfeasible ? [{
      code: "composition-search-infeasible" as const,
      incompleteDimensionIds,
      message: `Composition search could not fill ${incompleteDimensionIds.length} required dimensions`
    }] : []),
    ...(notCertified ? [{
      code: "composition-search-not-certified" as const,
      limitation: limitation!,
      visitedStates: searchResult?.diagnostic.visitedStates ?? 0,
      discardedStates: searchResult?.diagnostic.discardedStates ?? 0,
      feasibilityVisitedStates: searchResult?.diagnostic.feasibilityVisitedStates ?? 0,
      feasibilityWorkBudget: searchResult?.diagnostic.feasibilityWorkBudget ?? 0,
      feasibilityBudgetExhausted: searchResult?.diagnostic.feasibilityBudgetExhausted ?? false,
      optimizationVisitedStates: searchResult?.diagnostic.optimizationVisitedStates ?? 0,
      optimizationWorkBudget: searchResult?.diagnostic.optimizationWorkBudget ?? 0,
      optimizationBudgetExhausted: searchResult?.diagnostic.optimizationBudgetExhausted ?? false,
      candidateGenerationInputCount: generationDiagnostics.reduce((sum, item) => sum + item.inputCandidateCount, 0),
      candidateGenerationConstructedCount: generationDiagnostics.reduce((sum, item) => sum + item.constructedOptionCount, 0),
      candidateGenerationRetainedCount: generationDiagnostics.reduce((sum, item) => sum + item.retainedOptionCount, 0),
      message: "Composition search returned a bounded useful plan; global optimality is not certified"
    }] : []),
    {
      code: "schedule-group-search-profile" as const,
      completion,
      dimensionIds,
      groupIds,
      optionCounts: Object.freeze(Object.fromEntries(dimensions.map((dimension) => [
        dimension.stableId,
        dimension.options.length
      ]))),
      visitedStates: searchResult?.diagnostic.visitedStates ?? 0,
      discardedStates: searchResult?.diagnostic.discardedStates ?? 0,
      feasibilityVisitedStates: searchResult?.diagnostic.feasibilityVisitedStates ?? 0,
      feasibilityWorkBudget: searchResult?.diagnostic.feasibilityWorkBudget ?? 0,
      feasibilityBudgetExhausted: searchResult?.diagnostic.feasibilityBudgetExhausted ?? false,
      optimizationVisitedStates: searchResult?.diagnostic.optimizationVisitedStates ?? 0,
      optimizationWorkBudget: searchResult?.diagnostic.optimizationWorkBudget ?? 0,
      optimizationBudgetExhausted: searchResult?.diagnostic.optimizationBudgetExhausted ?? false,
      incompleteDimensionIds,
      message: `Schedule production search ${completion === "complete" ? "completed" : completion === "infeasible" ? "was infeasible" : "was not certified complete"} across ${dimensionIds.length} dimensions`
    }
  ];
  return {
    categories,
    groupIds,
    maximumActiveGroups,
    selections,
    complete,
    diagnostics
  };
}

function remapAssignmentFacility(assignment: Assignment, facilityId: string): Assignment {
  return assignment.facilityId === "base" ? assignment : { ...assignment, facilityId };
}

function fixedSupportPlacements(
  scenario: SupportResourceScenarioEvaluation | undefined
): ScheduledSupportPlacement[] {
  return scenario?.sources
    .filter((evidence) =>
      evidence.status === "resolved" && evidence.source.resourceKey !== "ordinarySupportPlacement"
    )
    .map((evidence) => ({
      kind: "fixed" as const,
      operatorId: evidence.source.operatorId,
      facilityId: evidence.source.facility.id,
      scheduleWindowIds: [evidence.source.scheduleWindowId],
      recoveryWindowIds: []
    }))
    .sort((left, right) =>
      compareCodePoints(left.scheduleWindowIds[0], right.scheduleWindowIds[0]) ||
      compareCodePoints(left.facilityId, right.facilityId) ||
      compareCodePoints(left.operatorId, right.operatorId)
    ) ?? [];
}

function scenarioOrdinarySupportPlacements(
  state: AppState,
  scenario: SupportResourceScenarioEvaluation | undefined
): ScheduledSupportPlacement[] {
  const windowsBySupport = new Map<string, Set<string>>();
  for (const evidence of scenario?.sources ?? []) {
    if (evidence.status !== "resolved" || evidence.source.resourceKey !== "ordinarySupportPlacement") continue;
    const key = `${evidence.source.facility.id}\u0000${evidence.source.operatorId}`;
    const windowIds = windowsBySupport.get(key) ?? new Set<string>();
    windowIds.add(evidence.source.scheduleWindowId);
    windowsBySupport.set(key, windowIds);
  }
  return [...windowsBySupport].map(([key, windowIds]) => {
    const [facilityId, operatorId] = key.split("\u0000");
    const scheduleWindowIds = state.schedule.shifts
      .filter((shift) => windowIds.has(shift.id))
      .map((shift) => shift.id);
    const groupId = state.schedule.groups.map((group) => group.id).find((candidateGroupId) => {
      const groupWindowIds = state.schedule.shifts
        .filter((shift) => shift.activeGroupIds.includes(candidateGroupId))
        .map((shift) => shift.id);
      return groupWindowIds.length === scheduleWindowIds.length &&
        groupWindowIds.every((windowId) => windowIds.has(windowId));
    });
    return {
      kind: "ordinary" as const,
      operatorId,
      facilityId,
      ...(groupId ? { groupId } : {}),
      scheduleWindowIds,
      recoveryWindowIds: state.schedule.shifts
        .filter((shift) => !windowIds.has(shift.id) && (!groupId || shift.recoveryGroupIds.includes(groupId)))
        .map((shift) => shift.id)
    };
  }).sort((left, right) =>
    compareCodePoints(left.facilityId, right.facilityId) || compareCodePoints(left.operatorId, right.operatorId)
  );
}

function requiredScenarioSupportPlacements(
  state: AppState,
  scenario: SupportResourceScenarioEvaluation | undefined
): ScheduledSupportPlacement[] {
  return [...scenarioOrdinarySupportPlacements(state, scenario), ...fixedSupportPlacements(scenario)];
}

function ordinarySupportPlacements(
  state: AppState,
  removalProofs: readonly {
    supportOperatorId: string;
    supportFacilityId: string;
    scheduleWindowId: string;
  }[]
): ScheduledSupportPlacement[] {
  const windowsBySupport = new Map<string, Set<string>>();
  for (const proof of removalProofs) {
    const key = `${proof.supportFacilityId}\u0000${proof.supportOperatorId}`;
    const windowIds = windowsBySupport.get(key) ?? new Set<string>();
    windowIds.add(proof.scheduleWindowId);
    windowsBySupport.set(key, windowIds);
  }
  return [...windowsBySupport.entries()].map(([key, provenWindowIds]) => {
    const [facilityId, operatorId] = key.split("\u0000");
    const scheduleWindowIds = state.schedule.shifts
      .filter((shift) => provenWindowIds.has(shift.id))
      .map((shift) => shift.id);
    const groupId = state.schedule.groups
      .map((group) => group.id)
      .sort(compareCodePoints)
      .find((candidateGroupId) => {
        const groupWindowIds = state.schedule.shifts
          .filter((shift) => shift.activeGroupIds.includes(candidateGroupId))
          .map((shift) => shift.id);
        return groupWindowIds.length === scheduleWindowIds.length &&
          groupWindowIds.every((windowId) => provenWindowIds.has(windowId));
      });
    const recoveryWindowIds = state.schedule.shifts
      .filter((shift) => !provenWindowIds.has(shift.id) &&
        (!groupId || shift.recoveryGroupIds.includes(groupId)))
      .map((shift) => shift.id);
    return {
      kind: "ordinary" as const,
      operatorId,
      facilityId,
      ...(groupId ? { groupId } : {}),
      scheduleWindowIds,
      recoveryWindowIds
    };
  }).sort((left, right) =>
    compareCodePoints(left.facilityId, right.facilityId) ||
    compareCodePoints(left.operatorId, right.operatorId)
  );
}

function fixedSupportAssignment(
  state: AppState,
  placement: ScheduledSupportPlacement,
  scenario: SupportResourceScenarioEvaluation | undefined,
  shiftHours: number
): Assignment {
  const source = scenario?.sources.find((evidence) =>
    evidence.status === "resolved" &&
    evidence.source.operatorId === placement.operatorId &&
    evidence.source.facility.id === placement.facilityId &&
    evidence.source.scheduleWindowId === placement.scheduleWindowIds[0]
  )?.source;
  const facility = state.facilities.find((candidate) => candidate.id === placement.facilityId) ??
    (source ? {
      id: source.facility.id,
      type: source.facility.type,
      name: source.facility.id,
      slotCount: source.facility.capacity
    } as FacilitySlot : undefined);
  const candidate = facility
    ? findCandidates(facility, state, 0, {
        assignments: [], facilities: canonicalWindowFacilities(state, scenario), roster: state.roster, shiftHours
      }).find((assignment) => assignment.operatorId === placement.operatorId)
    : undefined;
  return candidate ?? {
    facilityId: source?.facility.id ?? placement.facilityId,
    operatorId: placement.operatorId,
    skillId: "scheduled-fixed-support",
    score: 0,
    efficiency: 0,
    fatigueHours: moraleCapacity,
    recoveryHours: shiftHours / maxDormitoryRecoveryPerHour,
    reason: "Scheduled fixed support source"
  };
}

function canonicalWindowFacilities(
  state: AppState,
  scenario: SupportResourceScenarioEvaluation | undefined
): FacilitySlot[] {
  const facilities = [...state.facilities];
  const knownIds = new Set(facilities.map((facility) => facility.id));
  for (const evidence of scenario?.sources ?? []) {
    if (evidence.status !== "resolved" || knownIds.has(evidence.source.facility.id)) continue;
    facilities.push({
      id: evidence.source.facility.id,
      type: evidence.source.facility.type,
      name: evidence.source.facility.id,
      slotCount: evidence.source.facility.capacity
    } as FacilitySlot);
    knownIds.add(evidence.source.facility.id);
  }
  return facilities;
}

function buildCanonicalRotation(
  state: AppState,
  staticPlans: readonly FacilityPlan[],
  composition: ReturnType<typeof buildCanonicalScheduledProduction>,
  scenario: SupportResourceScenarioEvaluation | undefined,
  selectionContext: AssignmentEvaluationContext | undefined,
  supportPlacements: readonly ScheduledSupportPlacement[] = requiredScenarioSupportPlacements(state, scenario),
  ordinarySupportAssignments: readonly Assignment[] = [],
  materializeMorale = false
) {
  const windowFacilities = canonicalWindowFacilities(state, scenario);
  const ordinaryPlacements = supportPlacements.filter((placement) => placement.kind === "ordinary");
  const ordinaryPlacementAssignments = ordinaryPlacements.map((placement) =>
    ordinarySupportAssignments.find((assignment) =>
      assignment.operatorId === placement.operatorId && assignment.facilityId === placement.facilityId
    ) ?? fixedSupportAssignment(state, placement, scenario, optimizerShiftHours(state))
  );
  const staticAssignments = [
    ...staticPlans.flatMap((plan) => plan.assignments),
    ...ordinaryPlacementAssignments
  ];
  const ordinaryPlacementByAssignment = new Map(ordinaryPlacements.map((placement) => [
    `${placement.facilityId}\u0000${placement.operatorId}`,
    placement
  ]));
  const fixedPlacements = supportPlacements.filter((placement) => placement.kind === "fixed");
  const selectionByDimension = new Map(composition.selections.map((selection) => [selection.dimensionId, selection]));
  const selectedByPhysicalFacility = new Map<string, Assignment[]>();
  const rawWindows = state.schedule.shifts.map((shift, index) => {
    const activeGroupIds = [...shift.activeGroupIds].sort(compareCodePoints);
    const productionAssignments: Assignment[] = [];
    const incompleteGroupIds = new Set<string>();
    if (!composition.complete || activeGroupIds.length !== composition.maximumActiveGroups) {
      activeGroupIds.forEach((groupId) => incompleteGroupIds.add(groupId));
    } else {
      for (const category of composition.categories) {
        for (const [logicalIndex, logicalFacility] of category.logicalFacilities.entries()) {
          for (const [activeIndex, groupId] of activeGroupIds.entries()) {
            const selection = selectionByDimension.get(`${groupId}:${logicalFacility.id}`);
            const physicalFacility = category.facilities[logicalIndex * composition.maximumActiveGroups + activeIndex];
            if (!selection || !physicalFacility) {
              incompleteGroupIds.add(groupId);
              continue;
            }
            productionAssignments.push(...selection.assignments.map((assignment) =>
              remapAssignmentFacility(assignment, physicalFacility.id)
            ));
          }
        }
      }
    }
    let scheduledStaticAssignments = staticAssignments.filter((assignment) => {
      const placement = ordinaryPlacementByAssignment.get(`${assignment.facilityId}\u0000${assignment.operatorId}`);
      return !placement || placement.scheduleWindowIds.includes(shift.id);
    });
    const fixedAssignments = fixedPlacements
      .filter((placement) => placement.scheduleWindowIds.includes(shift.id))
      .map((placement) => fixedSupportAssignment(
        state, placement, scenario, shift.endHour - shift.startHour
      ));
    for (const facility of state.facilities) {
      const fixedOccupancy = fixedAssignments.filter((assignment) =>
        assignment.facilityId === facility.id && assignmentConsumesFacilitySlot(assignment)
      ).length;
      if (fixedOccupancy === 0) continue;
      const atFacility = scheduledStaticAssignments.filter((assignment) => assignment.facilityId === facility.id);
      const protectedSupport = atFacility.filter((assignment) =>
        ordinaryPlacementByAssignment.has(`${assignment.facilityId}\u0000${assignment.operatorId}`)
      );
      const protectedIds = new Set(protectedSupport.map((assignment) => assignment.operatorId));
      const retainedOrdinary = atFacility
        .filter((assignment) => !protectedIds.has(assignment.operatorId) && assignmentConsumesFacilitySlot(assignment))
        .sort(compareFacilityCandidates)
        .slice(0, Math.max(0, facility.slotCount - fixedOccupancy - facilitySlotOccupancy(protectedSupport)));
      const retainedIds = new Set([...protectedIds, ...retainedOrdinary.map((assignment) => assignment.operatorId)]);
      scheduledStaticAssignments = scheduledStaticAssignments.filter((assignment) =>
        assignment.facilityId !== facility.id || !assignmentConsumesFacilitySlot(assignment) ||
        retainedIds.has(assignment.operatorId)
      );
    }
    const preliminaryAssignments = [...scheduledStaticAssignments, ...fixedAssignments, ...productionAssignments];
    const fixed = scheduleWindowFixedContext(scenario, shift.id);
    const dormitoryAssignments = implicitDormitoryResourceAssignments(
      state,
      preliminaryAssignments,
      selectionContext?.reservedOperatorIds,
      selectionContext?.reservedFacilitySlots
    );
    const context: AssignmentEvaluationContext = {
      ...selectionContext,
      ...fixed,
      assignments: [...preliminaryAssignments, ...dormitoryAssignments],
      facilities: windowFacilities,
      roster: state.roster,
      shiftHours: shift.endHour - shift.startHour
    };
    const reevaluatedProduction = state.facilities
      .filter((facility) => facility.type === "factory" || facility.type === "trading")
      .sort((left, right) => compareCodePoints(left.id, right.id))
      .flatMap((facility) => reevaluateFacilityTeam(
        productionAssignments.filter((assignment) => assignment.facilityId === facility.id),
        facility,
        state,
        context
      ));
    const reevaluatedAssignments = [
      ...scheduledStaticAssignments,
      ...fixedAssignments,
      ...reevaluatedProduction
    ];
    const assignments = reevaluatedAssignments;
    const materializedProduction = assignments.filter((assignment) =>
      state.facilities.some((facility) =>
        facility.id === assignment.facilityId &&
        (facility.type === "factory" || facility.type === "trading")
      )
    );
    const operatorIds = assignments.map((assignment) => assignment.operatorId);
    const productionComplete = state.facilities
      .filter((facility) => facility.type === "factory" || facility.type === "trading")
      .every((facility) => {
        const rawFacilityAssignments = productionAssignments.filter((assignment) => assignment.facilityId === facility.id);
        const reevaluatedFacilityAssignments = materializedProduction.filter((assignment) => assignment.facilityId === facility.id);
        return facilityTeamEligibleForScheduleComparison(
          rawFacilityAssignments,
          reevaluatedFacilityAssignments,
          availableOrdinaryFacilitySlots(facility, selectionContext)
        );
      });
    if (new Set(operatorIds).size !== operatorIds.length || !productionComplete) {
      activeGroupIds.forEach((groupId) => incompleteGroupIds.add(groupId));
    }
    if (incompleteGroupIds.size === 0) {
      for (const facility of state.facilities.filter((candidate) =>
        candidate.type === "factory" || candidate.type === "trading"
      )) {
        if (!selectedByPhysicalFacility.has(facility.id)) {
          selectedByPhysicalFacility.set(
            facility.id,
            materializedProduction.filter((assignment) => assignment.facilityId === facility.id)
          );
        }
      }
    }
    return {
      label: `${index + 1}回目ローテーション`,
      hours: shift.endHour - shift.startHour,
      shiftId: shift.id,
      startHour: shift.startHour,
      endHour: shift.endHour,
      activeGroupIds: [...shift.activeGroupIds],
      recoveryGroupIds: [...shift.recoveryGroupIds],
      incompleteGroupIds: [...incompleteGroupIds].sort(compareCodePoints),
      assignments: incompleteGroupIds.size === 0 ? assignments : [],
      recovery: [
        ...shift.recoveryGroupIds.flatMap((groupId) => composition.selections
          .filter((selection) => selection.groupId === groupId)
          .flatMap((selection) => selection.assignments)),
        ...ordinaryPlacements
          .filter((placement) => placement.recoveryWindowIds.includes(shift.id))
          .flatMap((placement) => staticAssignments.filter((assignment) =>
            assignment.facilityId === placement.facilityId && assignment.operatorId === placement.operatorId
          ))
      ]
    };
  });
  if (!materializeMorale) return { windows: rawWindows, selectedByPhysicalFacility };

  const materializationWindows = rawWindows.map((window) => ({
    ...window,
    assignments: [...window.assignments]
  }));
  const scheduledOperatorIds = new Set(rawWindows.flatMap((window) =>
    window.assignments.map((assignment) => assignment.operatorId)
  ));
  for (const plan of staticPlans) {
    const activeIds = new Set(plan.assignments.map((assignment) => assignment.operatorId));
    const activeInEveryWindow = activeIds.size > 0 && materializationWindows.every((window) =>
      [...activeIds].every((operatorId) => window.assignments.some((assignment) =>
        assignment.facilityId === plan.facility.id && assignment.operatorId === operatorId
      ))
    );
    const alternativeAssignments = plan.alternatives.length > 0
      ? plan.alternatives
      : selectAssignmentsForFacility(
          findCandidates(plan.facility, state, 0, {
            ...selectionContext,
            assignments: materializationWindows[0]?.assignments ?? [],
            facilities: windowFacilities,
            roster: state.roster,
            shiftHours: materializationWindows[0]?.hours ?? optimizerShiftHours(state)
          }).filter((assignment) => !scheduledOperatorIds.has(assignment.operatorId)),
          facilitySlotOccupancy(plan.assignments)
        );
    const alternativeIds = new Set(alternativeAssignments.map((assignment) => assignment.operatorId));
    if (!activeInEveryWindow || alternativeIds.size === 0 ||
        [...alternativeIds].some((operatorId) => scheduledOperatorIds.has(operatorId))) continue;
    const recoveryWindow = materializationWindows.find((window) => {
      const retainedOperatorIds = new Set(window.assignments
        .filter((assignment) => assignment.facilityId !== plan.facility.id || !activeIds.has(assignment.operatorId))
        .map((assignment) => assignment.operatorId));
      return [...alternativeIds].every((operatorId) => !retainedOperatorIds.has(operatorId));
    });
    if (!recoveryWindow) continue;
    recoveryWindow.assignments = [
      ...recoveryWindow.assignments.filter((assignment) =>
        assignment.facilityId !== plan.facility.id || !activeIds.has(assignment.operatorId)
      ),
      ...alternativeAssignments
    ];
  }

  const windows = materializeScheduleAwareRotation(
    state,
    materializationWindows,
    scenario,
    selectionContext
  );
  selectedByPhysicalFacility.clear();
  for (const window of windows.filter((candidate) => candidate.incompleteGroupIds.length === 0)) {
    for (const facility of state.facilities.filter((candidate) =>
      candidate.type === "factory" || candidate.type === "trading"
    )) {
      if (!selectedByPhysicalFacility.has(facility.id)) {
        selectedByPhysicalFacility.set(
          facility.id,
          window.assignments.filter((assignment) => assignment.facilityId === facility.id)
        );
      }
    }
  }
  return { windows, selectedByPhysicalFacility };
}

function validateScheduledSupportMaterialization(
  state: AppState,
  windows: readonly AssignmentPlan["rotation"][number][],
  placements: readonly ScheduledSupportPlacement[],
  scenario: SupportResourceScenarioEvaluation | undefined
) {
  const issues: ScheduledSupportValidationIssue[] = [];
  const addIssue = (issue: ScheduledSupportValidationIssue) => {
    if (!issues.some((existing) =>
      existing.code === issue.code && existing.operatorId === issue.operatorId &&
      existing.facilityId === issue.facilityId &&
      existing.scheduleWindowIds.join("\u0000") === issue.scheduleWindowIds.join("\u0000")
    )) issues.push(issue);
  };
  const facilityCapacity = (facilityId: string) =>
    state.facilities.find((facility) => facility.id === facilityId)?.slotCount ??
    scenario?.sources.find((evidence) =>
      evidence.status === "resolved" && evidence.source.facility.id === facilityId
    )?.source.facility.capacity;

  for (const placement of placements) {
    for (const window of windows) {
      const works = window.assignments.filter((assignment) =>
        assignment.operatorId === placement.operatorId && assignment.facilityId === placement.facilityId
      ).length;
      const shouldWork = placement.scheduleWindowIds.includes(window.shiftId);
      const recovers = window.recovery.some((assignment) => assignment.operatorId === placement.operatorId);
      const shouldRecover = placement.recoveryWindowIds.includes(window.shiftId);
      if ((shouldWork && works !== 1) || (!shouldWork && works !== 0) ||
          (shouldRecover && !recovers) || (!shouldRecover && placement.kind === "ordinary" && recovers)) {
        addIssue({
          code: "support-placement-not-materialized",
          operatorId: placement.operatorId,
          facilityId: placement.facilityId,
          scheduleWindowIds: [window.shiftId],
          message: `Scheduled support ${placement.operatorId} was not materialized exactly in ${window.shiftId}`
        });
      }
    }
  }

  for (const window of windows) {
    const workingByOperator = new Map<string, Assignment[]>();
    for (const assignment of window.assignments) {
      const assignments = workingByOperator.get(assignment.operatorId) ?? [];
      assignments.push(assignment);
      workingByOperator.set(assignment.operatorId, assignments);
    }
    for (const [operatorId, assignments] of workingByOperator) {
      if (assignments.length > 1) addIssue({
        code: "support-operator-duplicated",
        operatorId,
        scheduleWindowIds: [window.shiftId],
        message: `Operator ${operatorId} has ${assignments.length} assignments in ${window.shiftId}`
      });
      if (window.recovery.some((assignment) => assignment.operatorId === operatorId)) addIssue({
        code: "support-work-recovery-overlap",
        operatorId,
        scheduleWindowIds: [window.shiftId],
        message: `Operator ${operatorId} works and recovers in ${window.shiftId}`
      });
    }
    for (const facilityId of new Set(window.assignments.map((assignment) => assignment.facilityId))) {
      const capacity = facilityCapacity(facilityId);
      if (capacity === undefined) continue;
      const occupancy = window.assignments.filter((assignment) =>
        assignment.facilityId === facilityId && assignmentConsumesFacilitySlot(assignment)
      ).length;
      if (occupancy > capacity) addIssue({
        code: "support-facility-capacity-exceeded",
        facilityId,
        scheduleWindowIds: [window.shiftId],
        message: `Facility ${facilityId} has occupancy ${occupancy} above capacity ${capacity} in ${window.shiftId}`
      });
    }
  }

  for (let leftIndex = 0; leftIndex < windows.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < windows.length; rightIndex += 1) {
      const left = windows[leftIndex];
      const right = windows[rightIndex];
      if (!cyclicHalfOpenIntervalsOverlap(left, right, state.schedule.cycleHours)) continue;
      const leftOperators = new Set(left.assignments.map((assignment) => assignment.operatorId));
      for (const operatorId of new Set(right.assignments.map((assignment) => assignment.operatorId))) {
        if (leftOperators.has(operatorId)) addIssue({
          code: "support-work-overlap",
          operatorId,
          scheduleWindowIds: [left.shiftId, right.shiftId].sort(compareCodePoints),
          message: `Operator ${operatorId} works in overlapping windows ${left.shiftId} and ${right.shiftId}`
        });
      }
      for (const [work, recovery] of [[left, right], [right, left]] as const) {
        const recoveryIds = new Set(recovery.recovery.map((assignment) => assignment.operatorId));
        for (const operatorId of new Set(work.assignments.map((assignment) => assignment.operatorId))) {
          if (recoveryIds.has(operatorId)) addIssue({
            code: "support-work-recovery-overlap",
            operatorId,
            scheduleWindowIds: [work.shiftId, recovery.shiftId].sort(compareCodePoints),
            message: `Operator ${operatorId} works and recovers in overlapping cyclic windows`
          });
        }
      }
      for (const facilityId of new Set([...left.assignments, ...right.assignments]
        .map((assignment) => assignment.facilityId))) {
        const capacity = facilityCapacity(facilityId);
        if (capacity === undefined) continue;
        const occupants = [...left.assignments, ...right.assignments].filter((assignment) =>
          assignment.facilityId === facilityId && assignmentConsumesFacilitySlot(assignment)
        );
        if (occupants.length > capacity) addIssue({
          code: "support-facility-capacity-exceeded",
          facilityId,
          scheduleWindowIds: [left.shiftId, right.shiftId].sort(compareCodePoints),
          message: `Facility ${facilityId} exceeds capacity ${capacity} across overlapping cyclic windows`
        });
      }
    }
  }
  issues.sort((left, right) =>
    compareCodePoints(left.code, right.code) ||
    compareCodePoints(left.facilityId ?? "", right.facilityId ?? "") ||
    compareCodePoints(left.operatorId ?? "", right.operatorId ?? "") ||
    compareCodePoints(left.scheduleWindowIds.join("|"), right.scheduleWindowIds.join("|"))
  );
  return {
    issues,
    supportCapacityValidated: !issues.some((issue) =>
      issue.code === "support-facility-capacity-exceeded" || issue.code === "support-placement-not-materialized"
    ),
    supportRecoveryValidated: !issues.some((issue) =>
      issue.code !== "support-facility-capacity-exceeded"
    )
  };
}

type CanonicalComposition = ReturnType<typeof buildCanonicalScheduledProduction>;

type CanonicalSelectionMechanicalEvidence = {
  rotationComplete: boolean;
  supportCapacityValidated: boolean;
  supportRecoveryValidated: boolean;
  supportIssueCount: number;
  resourceStatus: "complete" | "incomplete";
  resourceClosureSatisfied?: boolean;
  sustainabilityStatus: "evaluated" | "incomplete" | "not-evaluated";
  sustainable?: boolean;
};

function evaluateCanonicalSelectionMechanically(
  state: AppState,
  staticPlans: readonly FacilityPlan[],
  composition: CanonicalComposition,
  scenario: SupportResourceScenarioEvaluation | undefined,
  selectionContext: AssignmentEvaluationContext | undefined,
  supportPlacements: readonly ScheduledSupportPlacement[],
  supportAssignments: readonly Assignment[]
): CanonicalSelectionMechanicalEvidence {
  const rotationResult = buildCanonicalRotation(
    state,
    staticPlans,
    composition,
    scenario,
    selectionContext,
    supportPlacements,
    supportAssignments,
    true
  );
  return evaluateCanonicalRotationMechanically(
    state,
    staticPlans,
    rotationResult.windows,
    scenario,
    selectionContext,
    supportPlacements
  );
}

function evaluateCanonicalRotationMechanically(
  state: AppState,
  staticPlans: readonly FacilityPlan[],
  windows: readonly AssignmentPlan["rotation"][number][],
  scenario: SupportResourceScenarioEvaluation | undefined,
  selectionContext: AssignmentEvaluationContext | undefined,
  supportPlacements: readonly ScheduledSupportPlacement[]
): CanonicalSelectionMechanicalEvidence {
  const rotationComplete = windows.every((window) => window.incompleteGroupIds.length === 0);
  const supportValidation = validateScheduledSupportMaterialization(
    state,
    windows,
    supportPlacements,
    scenario
  );
  const physicalEvidence = {
    rotationComplete,
    supportCapacityValidated: supportValidation.supportCapacityValidated,
    supportRecoveryValidated: supportValidation.supportRecoveryValidated,
    supportIssueCount: supportValidation.issues.length
  };
  if (!rotationComplete || !supportValidation.supportCapacityValidated ||
      !supportValidation.supportRecoveryValidated || supportValidation.issues.length > 0) {
    return {
      ...physicalEvidence,
      resourceStatus: "incomplete",
      sustainabilityStatus: "incomplete"
    };
  }

  const productionFacilities = state.facilities
    .filter((facility) => facility.type === "factory" || facility.type === "trading")
    .sort((left, right) => compareCodePoints(left.id, right.id));
  const productionPlans = productionFacilities.map((facility) => {
      const assignments = windows.find((window) => window.assignments.some((assignment) =>
        assignment.facilityId === facility.id
      ))?.assignments.filter((assignment) => assignment.facilityId === facility.id) ?? [];
      return {
        facility,
        assignments,
        expectedEfficiency: effectiveFacilityEfficiency(assignments, 0),
        score: effectiveFacilityScore(assignments, facility, state.preference, 0),
        alternatives: []
      };
    });
  const facilityPlans = [...staticPlans, ...productionPlans];
  const windowFacilityEfficiencyEvaluations = evaluateScheduleAwareWindowFacilityEfficiencies(
    state,
    facilityPlans,
    windows,
    scenario,
    selectionContext
  );
  const plan = {
    generatedAt: "canonical-search-mechanical-evaluation",
    totalScore: 0,
    dailyValue: 0,
    facilityPlans,
    schedule: structuredClone(state.schedule),
    rotation: [...windows],
    diagnostics: [],
    warnings: [],
    supportResourceScenario: scenario,
    windowFacilityEfficiencyEvaluations
  };
  const resources = evaluatePlanResources(plan);
  if (resources.status !== "complete" || !resources.cycleLedger) {
    return {
      ...physicalEvidence,
      resourceStatus: "incomplete",
      sustainabilityStatus: "incomplete"
    };
  }
  const resourceClosureSatisfied = resources.cycleLedger.goldNetChange >= -1e-9 &&
    Math.abs(resources.cycleLedger.dronesGenerated - resources.cycleLedger.dronesUsed) <= 1e-9;
  if (!resourceClosureSatisfied) {
    return {
      ...physicalEvidence,
      resourceStatus: "complete",
      resourceClosureSatisfied,
      sustainabilityStatus: "not-evaluated"
    };
  }
  const sustainability = evaluatePlanSustainability({
    plan: { ...plan, resources },
    layout: state.layout
  });
  return {
    ...physicalEvidence,
    resourceStatus: "complete",
    resourceClosureSatisfied,
    sustainabilityStatus: sustainability.status,
    ...(sustainability.status === "evaluated"
      ? { sustainable: sustainability.result.sustainable && sustainability.result.failures.length === 0 }
      : {})
  };
}

function canonicalSelectionIsSustainable(
  state: AppState,
  staticPlans: readonly FacilityPlan[],
  composition: CanonicalComposition,
  scenario: SupportResourceScenarioEvaluation | undefined,
  selectionContext: AssignmentEvaluationContext | undefined,
  supportPlacements: readonly ScheduledSupportPlacement[],
  supportAssignments: readonly Assignment[]
): boolean {
  return canonicalMechanicalEvidenceIsSustainable(evaluateCanonicalSelectionMechanically(
    state,
    staticPlans,
    composition,
    scenario,
    selectionContext,
    supportPlacements,
    supportAssignments
  ));
}

function canonicalMechanicalEvidenceIsSustainable(evidence: CanonicalSelectionMechanicalEvidence) {
  return evidence.rotationComplete && evidence.supportCapacityValidated &&
    evidence.supportRecoveryValidated && evidence.supportIssueCount === 0 &&
    evidence.resourceStatus === "complete" && evidence.resourceClosureSatisfied === true &&
    evidence.sustainabilityStatus === "evaluated" && evidence.sustainable === true;
}

type JointSupportStart = {
  signature: string;
  requirementSignature: string;
  potentialScore: number;
  staticPlans: FacilityPlan[];
  supportPlacements: ScheduledSupportPlacement[];
  supportAssignments: Assignment[];
  dependencyTargetSignature: string;
};

type JointSupportEvaluation = JointSupportStart & {
  composition: CanonicalComposition;
  aggregateScore: number;
  removalProofs?: ReturnType<typeof jointSupportRemovalProofs>;
};

const jointSupportRoundLimit = 1;
const jointSupportWorkLimit = 32;
const jointSupportSeedLimit = 16;

function staticPlanSignature(plans: readonly FacilityPlan[]) {
  return [...plans].sort((left, right) => compareCodePoints(left.facility.id, right.facility.id))
    .flatMap((plan) => [...plan.assignments]
      .sort((left, right) => compareCodePoints(assignmentStableSignature(left), assignmentStableSignature(right)))
      .map((assignment) => `${plan.facility.id}:${assignmentStableSignature(assignment)}`))
    .join("|");
}

function jointCompositionSignature(composition: CanonicalComposition) {
  return [...composition.selections]
    .sort((left, right) => compareCodePoints(left.dimensionId, right.dimensionId))
    .map((selection) => `${selection.dimensionId}:${facilityTeamStableSignature(selection.assignments)}`)
    .join("|");
}

function supportRequirementSignatures(assignment: Assignment) {
  const efficiency = (assignment.remoteFacilityEfficiencyBonuses ?? []).map((bonus) =>
    `efficiency:${bonus.facility}:${bonus.product ?? "*"}:${bonus.min ?? 1}:` +
    `${[...(bonus.affiliations ?? [])].sort(compareCodePoints).join(",")}:` +
    `${[...(bonus.groupAffiliations ?? [])].sort(compareCodePoints).join(",")}:` +
    `${[...(bonus.operatorIds ?? [])].sort(compareCodePoints).join(",")}`
  );
  const stats = (assignment.remoteFacilityStatBonuses ?? []).map((bonus) =>
    `stat:${bonus.facility}:${bonus.key}:${bonus.min ?? 1}:` +
    `${[...(bonus.affiliations ?? [])].sort(compareCodePoints).join(",")}:` +
    `${[...(bonus.operatorIds ?? [])].sort(compareCodePoints).join(",")}`
  );
  const counts = (assignment.remoteFacilityCountBonuses ?? []).map((bonus) =>
    `count:${bonus.facility}:${bonus.amount}`
  );
  return [...new Set([...efficiency, ...stats, ...counts])].sort(compareCodePoints);
}

// This deliberately estimates only seed retention. A seed cannot win unless the
// normal optimizer reevaluation below observes a physical, conflict-free support
// placement and a strictly better aggregate result.
function supportSeedRetentionPotential(state: AppState, assignment: Assignment) {
  const productionFacilities = state.facilities.filter((facility) =>
    facility.type === "factory" || facility.type === "trading"
  );
  return (assignment.remoteFacilityEfficiencyBonuses ?? []).reduce((sum, bonus) => {
    const targets = operators.filter((operator) => {
      if (!state.roster[operator.id]?.owned) return false;
      return !bonus.affiliations?.length && !bonus.groupAffiliations?.length && !bonus.operatorIds?.length ||
        bonus.operatorIds?.includes(operator.id) ||
        (operator.affiliations ?? []).some((affiliation) =>
          bonus.affiliations?.includes(affiliation) || bonus.groupAffiliations?.includes(affiliation)
        );
    }).length;
    if (targets < (bonus.min ?? 1)) return sum;
    return sum + productionFacilities
      .filter((facility) => facility.type === bonus.facility && (!bonus.product || facility.product === bonus.product))
      .reduce((facilitySum, facility) => facilitySum +
        Math.max(bonus.amount, 0) * Math.min(targets, facility.slotCount) *
        productWeight(facility.product, state.preference) * facilityWeight(facility), 0);
  }, 0) + (assignment.remoteFacilityStatBonuses?.length ?? 0) +
    (assignment.remoteFacilityCountBonuses?.length ?? 0);
}

function plansForForcedStaticSupport(
  state: AppState,
  baselinePlans: readonly FacilityPlan[],
  supportFacility: FacilitySlot,
  supportCandidate: Assignment,
  candidates: readonly Assignment[],
  selectionContext: AssignmentEvaluationContext | undefined
) {
  const reservedOperatorIds = selectionContext?.reservedOperatorIds ?? new Set<string>();
  const availableSlots = availableOrdinaryFacilitySlots(supportFacility, selectionContext);
  if (availableSlots <= 0 || reservedOperatorIds.has(supportCandidate.operatorId)) return undefined;
  const usedOutsideFacility = new Set(baselinePlans
    .filter((plan) => plan.facility.id !== supportFacility.id)
    .flatMap((plan) => plan.assignments.map((assignment) => assignment.operatorId)));
  const forcedAssignments = selectAssignmentsForFacility([
    supportCandidate,
    ...baselinePlans.find((plan) => plan.facility.id === supportFacility.id)?.assignments ?? [],
    ...candidates
  ].filter((assignment) =>
    !reservedOperatorIds.has(assignment.operatorId) && !usedOutsideFacility.has(assignment.operatorId)
  ), availableSlots);
  if (!forcedAssignments.some((assignment) => assignment.operatorId === supportCandidate.operatorId) ||
      facilitySlotOccupancy(forcedAssignments) > availableSlots) return undefined;
  const operatorIds = baselinePlans
    .filter((plan) => plan.facility.id !== supportFacility.id)
    .flatMap((plan) => plan.assignments.map((assignment) => assignment.operatorId))
    .concat(forcedAssignments.map((assignment) => assignment.operatorId));
  if (new Set(operatorIds).size !== operatorIds.length) return undefined;
  const plans = baselinePlans.map((plan) => plan.facility.id === supportFacility.id
    ? { ...plan, assignments: forcedAssignments }
    : { ...plan, assignments: [...plan.assignments] });
  const assignments = plans.flatMap((plan) => plan.assignments);
  const context: AssignmentEvaluationContext = {
    ...selectionContext,
    assignments,
    facilities: state.facilities,
    roster: state.roster,
    shiftHours: optimizerShiftHours(state)
  };
  return plans.map((plan) => {
    const globalBonus = calculateGlobalBonus(state, plan.facility, context) +
      calculateRemoteFacilityEfficiencyBonus(plan.facility, context);
    return {
      ...plan,
      expectedEfficiency: effectiveFacilityEfficiency(plan.assignments, globalBonus),
      score: facilityTeamSelectionScore(plan.assignments, plan.facility, state.preference, globalBonus)
    };
  });
}

function jointSupportStarts(
  state: AppState,
  staticFacilities: readonly FacilitySlot[],
  baselinePlans: readonly FacilityPlan[],
  selectionContext: AssignmentEvaluationContext | undefined,
  scenario: SupportResourceScenarioEvaluation | undefined
) {
  const requiredPlacements = requiredScenarioSupportPlacements(state, scenario);
  const baselinePlansWithinFixedCapacity = baselinePlans.map((plan) => {
    const maximumFixedOccupancy = Math.max(0, ...state.schedule.shifts.map((shift) =>
      requiredPlacements.filter((placement) =>
        placement.facilityId === plan.facility.id && placement.scheduleWindowIds.includes(shift.id)
      ).length
    ));
    const availableSlots = Math.max(0, plan.facility.slotCount - maximumFixedOccupancy);
    let occupiedSlots = 0;
    return {
      ...plan,
      assignments: plan.assignments.filter((assignment) => {
        if (!assignmentConsumesFacilitySlot(assignment)) return true;
        occupiedSlots += 1;
        return occupiedSlots <= availableSlots;
      })
    };
  });
  const baselineAssignments = baselinePlansWithinFixedCapacity.flatMap((plan) => plan.assignments);
  const dormitoryAssignments = implicitDormitoryResourceAssignments(
    state,
    baselineAssignments,
    selectionContext?.reservedOperatorIds,
    selectionContext?.reservedFacilitySlots
  );
  const context: AssignmentEvaluationContext = {
    ...selectionContext,
    assignments: [...baselineAssignments, ...dormitoryAssignments],
    facilities: state.facilities,
    roster: state.roster,
    shiftHours: optimizerShiftHours(state)
  };
  const representatives = new Map<string, {
    facility: FacilitySlot;
    assignment: Assignment;
    requirementSignature: string;
    potentialScore: number;
    dependencyTargetSignature: string;
  }>();
  let rawDependencyStarts = 0;
  for (const facility of [...staticFacilities].sort((left, right) => compareCodePoints(left.id, right.id))) {
    const candidates = findCandidates(facility, state, 0, context).sort(compareFacilityCandidates);
    for (const candidate of candidates) {
      const requirementSignatures = supportRequirementSignatures(candidate);
      if (!requirementSignatures.length) continue;
      if (availableOrdinaryFacilitySlots(facility, selectionContext) <= 0 ||
          selectionContext?.reservedOperatorIds?.has(candidate.operatorId)) continue;
      rawDependencyStarts += 1;
      const requirementSignature = requirementSignatures.join("&");
      const potentialScore = supportSeedRetentionPotential(state, candidate);
      const dependencyTargets = new Set<string>([
        ...(candidate.remoteFacilityEfficiencyBonuses ?? []).map((bonus) => bonus.facility),
        ...(candidate.remoteFacilityStatBonuses ?? []).map((bonus) => bonus.facility)
      ]);
      if (candidate.remoteFacilityCountBonuses?.length) {
        for (const productionFacility of state.facilities.filter((target) =>
          target.type === "factory" || target.type === "trading"
        )) {
          const without = findCandidates(productionFacility, state, 0, {
            ...context, assignments: context.assignments.filter((item) => item.operatorId !== candidate.operatorId)
          });
          const withSupport = findCandidates(productionFacility, state, 0, {
            ...context, assignments: [...context.assignments.filter((item) => item.operatorId !== candidate.operatorId), candidate]
          });
          if (withSupport.some((assignment) => {
            const baseline = without.find((item) => item.operatorId === assignment.operatorId);
            return baseline && (Math.abs(assignment.score - baseline.score) > 1e-12 ||
              Math.abs(assignment.efficiency - baseline.efficiency) > 1e-12);
          })) dependencyTargets.add(productionFacility.type);
        }
      }
      const dependencyTargetSignature = [...dependencyTargets].sort(compareCodePoints).join(",");
      const existing = representatives.get(requirementSignature);
      if (!existing || potentialScore > existing.potentialScore ||
          (potentialScore === existing.potentialScore &&
            compareCodePoints(assignmentStableSignature(candidate), assignmentStableSignature(existing.assignment)) < 0)) {
        representatives.set(requirementSignature, {
          facility, assignment: candidate, requirementSignature, potentialScore, dependencyTargetSignature
        });
      }
    }
  }
  const retained = [...representatives.values()]
    .sort((left, right) => right.potentialScore - left.potentialScore ||
      compareCodePoints(left.requirementSignature, right.requirementSignature) ||
      compareCodePoints(assignmentStableSignature(left.assignment), assignmentStableSignature(right.assignment)));
  const dependencyIds = new Set(retained.map((item) => item.assignment.operatorId));
  const dependencyFacilityIds = new Set(retained.map((item) => item.facility.id));
  const staticPlans = baselinePlansWithinFixedCapacity.map((plan) => ({
    ...plan,
    assignments: plan.assignments.filter((assignment) =>
      !dependencyIds.has(assignment.operatorId) &&
      (!dependencyFacilityIds.has(plan.facility.id) || !assignmentConsumesFacilitySlot(assignment))
    )
  }));
  const groupIds = state.schedule.groups.map((group) => group.id).sort(compareCodePoints);
  const placementFor = (item: typeof retained[number], groupId: string): ScheduledSupportPlacement => ({
    kind: "ordinary",
    operatorId: item.assignment.operatorId,
    facilityId: item.facility.id,
    groupId,
    scheduleWindowIds: state.schedule.shifts.filter((shift) => shift.activeGroupIds.includes(groupId)).map((shift) => shift.id),
    recoveryWindowIds: state.schedule.shifts.filter((shift) => shift.recoveryGroupIds.includes(groupId)).map((shift) => shift.id)
  });
  const feasible = (placements: readonly ScheduledSupportPlacement[]) => state.schedule.shifts.every((shift) =>
    state.facilities.every((facility) => {
      const ordinary = placements.filter((placement) => placement.facilityId === facility.id &&
        placement.scheduleWindowIds.includes(shift.id)).length;
      const fixed = requiredPlacements.filter((placement) =>
        placement.facilityId === facility.id && placement.scheduleWindowIds.includes(shift.id)
      ).length;
      const baseline = staticPlans.find((plan) => plan.facility.id === facility.id)?.assignments
        .filter(assignmentConsumesFacilitySlot).length ?? 0;
      return ordinary + fixed + baseline <= facility.slotCount;
    })
  );
  const candidates: JointSupportStart[] = [];
  const seen = new Set<string>();
  const addSeed = (items: readonly typeof retained[number][], assignedGroups: readonly string[]) => {
    const placements = items.map((item, index) => placementFor(item, assignedGroups[index]));
    if (!feasible(placements)) return false;
    const signature = placements.map((placement) =>
      `${placement.facilityId}:${placement.operatorId}:${placement.groupId}`
    ).sort(compareCodePoints).join("|") || "baseline";
    if (seen.has(signature)) return false;
    seen.add(signature);
    candidates.push({
      signature,
      requirementSignature: items.map((item) => item.requirementSignature).sort(compareCodePoints).join("&") || "baseline",
      potentialScore: items.reduce((sum, item) => sum + item.potentialScore, 0),
      staticPlans: (items.length === 0 ? baselinePlansWithinFixedCapacity : staticPlans)
        .map((plan) => ({ ...plan, assignments: [...plan.assignments] })),
      supportPlacements: placements,
      supportAssignments: items.map((item) => item.assignment),
      dependencyTargetSignature: [...new Set(items.map((item) => item.dependencyTargetSignature))]
        .sort(compareCodePoints).join("&")
    });
    return true;
  };
  addSeed([], []);
  // Every modeled requirement gets a deterministic individual representative
  // before any combined-space bound is applied.
  for (const item of retained) {
    for (const groupId of groupIds) if (addSeed([item], [groupId])) break;
  }
  // Canonical distinct-group covers model simultaneously selected production
  // dimensions without enumerating the full roster Cartesian product.
  for (let size = 2; size <= Math.min(3, retained.length, groupIds.length); size += 1) {
    const choose = (start: number, chosen: typeof retained) => {
      if (chosen.length === size) {
        const permute = (remaining: string[], assigned: string[]) => {
          if (assigned.length === size) return addSeed(chosen, assigned);
          for (const groupId of remaining) permute(
            remaining.filter((candidate) => candidate !== groupId), [...assigned, groupId]
          );
        };
        permute(groupIds, []);
        return;
      }
      for (let index = start; index <= retained.length - (size - chosen.length); index += 1) {
        choose(index + 1, [...chosen, retained[index]]);
      }
    };
    choose(0, []);
  }
  const mandatorySignatures = new Set(candidates.filter((seed) =>
    seed.supportAssignments.length <= 1
  ).map((seed) => seed.signature));
  const sortedCombined = candidates.filter((seed) => seed.supportAssignments.length > 1)
    .sort((left, right) => right.supportAssignments.length - left.supportAssignments.length ||
      Number(right.dependencyTargetSignature.indexOf("&") < 0) -
        Number(left.dependencyTargetSignature.indexOf("&") < 0) ||
      compareCodePoints(
        left.supportPlacements.map((placement) => placement.groupId ?? "").join("|"),
        right.supportPlacements.map((placement) => placement.groupId ?? "").join("|")
      ) || right.potentialScore - left.potentialScore || compareCodePoints(left.signature, right.signature));
  const mandatory = candidates.filter((seed) => mandatorySignatures.has(seed.signature))
    .sort((left, right) => compareCodePoints(left.signature, right.signature));
  const seedLimit = Math.max(jointSupportSeedLimit, mandatory.length);
  const starts = [...mandatory, ...sortedCombined.slice(0, Math.max(0, seedLimit - mandatory.length))];
  return {
    starts,
    requirementSignatures: [...representatives.keys()].sort(compareCodePoints),
    retainedRequirementSignatures: retained.map((item) => item.requirementSignature).sort(compareCodePoints),
    discardedOptions: Math.max(0, rawDependencyStarts - retained.length),
    seedLimit,
    discardedSeeds: Math.max(0, candidates.length - starts.length)
  };
}

function canonicalAggregateScore(
  state: AppState,
  staticPlans: readonly FacilityPlan[],
  composition: CanonicalComposition,
  scenario: SupportResourceScenarioEvaluation | undefined,
  selectionContext: AssignmentEvaluationContext | undefined,
  supportPlacements: readonly ScheduledSupportPlacement[] = [],
  supportAssignments: readonly Assignment[] = []
) {
  if (!composition.complete) return Number.NEGATIVE_INFINITY;
  const rotation = buildCanonicalRotation(
    state, staticPlans, composition, scenario, selectionContext,
    [...supportPlacements, ...requiredScenarioSupportPlacements(state, scenario)], supportAssignments
  );
  if (rotation.windows.some((window) => window.incompleteGroupIds.length > 0)) return Number.NEGATIVE_INFINITY;
  const productionFacilities = state.facilities
    .filter((facility) => facility.type === "factory" || facility.type === "trading")
    .sort((left, right) => compareCodePoints(left.id, right.id));
  const scheduleAwareRotation = materializeScheduleAwareRotation(
    state,
    rotation.windows,
    scenario,
    selectionContext
  );
  const facilityPlans = productionFacilities.map((facility) => ({
    facility,
    assignments: scheduleAwareRotation.find((window) =>
      window.assignments.some((assignment) => assignment.facilityId === facility.id)
    )?.assignments.filter((assignment) => assignment.facilityId === facility.id) ?? [],
    expectedEfficiency: 0,
    score: 0,
    alternatives: []
  }));
  const evaluations = evaluateScheduleAwareWindowFacilityEfficiencies(
    state,
    facilityPlans,
    scheduleAwareRotation,
    scenario,
    selectionContext
  );
  return evaluateExactWindowFacilityObjective({
    schedule: state.schedule,
    facilities: productionFacilities,
    preference: state.preference,
    evaluations
  }) ?? Number.NEGATIVE_INFINITY;
}

function jointSupportRemovalProofs(
  state: AppState,
  staticPlans: readonly FacilityPlan[],
  composition: CanonicalComposition,
  scenario: SupportResourceScenarioEvaluation | undefined,
  selectionContext: AssignmentEvaluationContext | undefined,
  supportPlacements: readonly ScheduledSupportPlacement[] = [],
  supportAssignments: readonly Assignment[] = []
) {
  type RemovalNecessity =
    | {
        kind: "production-objective-worsened";
        withSupportObjective: number;
        withoutSupportObjective: number;
      }
    | {
        kind: "resource-or-sustainability-failure";
        withSupport: CanonicalSelectionMechanicalEvidence;
        withoutSupport: CanonicalSelectionMechanicalEvidence;
      }
    | {
        kind: "support-physical-failure";
        withSupport: CanonicalSelectionMechanicalEvidence;
        withoutSupport: CanonicalSelectionMechanicalEvidence;
      };
  type RemovalProof = Extract<AssignmentPlan["diagnostics"][number], {
    code: "joint-support-search-not-certified";
  }>["removalProofs"][number] & { necessity: RemovalNecessity };

  const requiredPlacements = requiredScenarioSupportPlacements(state, scenario);
  const selectedPlacements = [...supportPlacements, ...requiredPlacements];
  const rotation = buildCanonicalRotation(
    state, staticPlans, composition, scenario, selectionContext, selectedPlacements, supportAssignments, true
  );
  const withSupportValidation = validateScheduledSupportMaterialization(
    state, rotation.windows, selectedPlacements, scenario
  );
  if (rotation.windows.some((window) => window.incompleteGroupIds.length > 0) ||
      !withSupportValidation.supportCapacityValidated || !withSupportValidation.supportRecoveryValidated ||
      withSupportValidation.issues.length > 0) return [] as RemovalProof[];

  const staticAssignments = [...staticPlans.flatMap((plan) => plan.assignments), ...supportAssignments];
  const proofs: RemovalProof[] = [];
  let withSupportMechanicalEvidence: CanonicalSelectionMechanicalEvidence | undefined;
  const authoritativeRawRotation = rawRotationFromCloneSafeProvenance(rotation.windows) ??
    rotationWithoutMaterializationMetadata(rotation.windows);
  for (const support of staticAssignments.sort((left, right) =>
    compareCodePoints(left.facilityId, right.facilityId) || compareCodePoints(left.operatorId, right.operatorId)
  )) {
    if (!supportRequirementSignatures(support).length) continue;
    const withoutStaticPlans = staticPlans.map((plan) => ({
      ...plan,
      assignments: plan.assignments.filter((assignment) =>
        assignment.operatorId !== support.operatorId || assignment.facilityId !== support.facilityId
      )
    }));
    const withoutSupportAssignments = supportAssignments.filter((assignment) =>
      assignment.operatorId !== support.operatorId || assignment.facilityId !== support.facilityId
    );
    const withoutSupportPlacements = selectedPlacements.filter((placement) =>
      placement.operatorId !== support.operatorId || placement.facilityId !== support.facilityId
    );
    const supportWindowIds = new Set(supportPlacements
      .filter((placement) => placement.operatorId === support.operatorId &&
        placement.facilityId === support.facilityId)
      .flatMap((placement) => placement.scheduleWindowIds));
    const proofWindows = rotation.windows.filter((window) =>
      supportWindowIds.size > 0
        ? supportWindowIds.has(window.shiftId)
        : window.assignments.some((assignment) =>
            assignment.operatorId === support.operatorId && assignment.facilityId === support.facilityId
          )
    );
    const efficiencyComparisons: Omit<RemovalProof, "necessity">[] = [];
    for (const window of proofWindows) {
      const fixed = scheduleWindowFixedContext(scenario, window.shiftId);
      const assignmentsWithoutSupport = window.assignments.filter((assignment) =>
        !(assignment.facilityId === support.facilityId && assignment.operatorId === support.operatorId)
      );
      for (const facility of state.facilities.filter((candidate) =>
        candidate.type === "factory" || candidate.type === "trading"
      ).sort((left, right) => compareCodePoints(left.id, right.id))) {
        const raw = window.assignments.filter((assignment) => assignment.facilityId === facility.id);
        if (!raw.length) continue;
        const withContext: AssignmentEvaluationContext = {
          ...selectionContext,
          ...fixed,
          assignments: window.assignments,
          facilities: state.facilities,
          roster: state.roster,
          shiftHours: window.hours
        };
        const withoutContext: AssignmentEvaluationContext = {
          ...withContext,
          assignments: assignmentsWithoutSupport
        };
        const withAssignments = reevaluateFacilityTeam(raw, facility, state, withContext);
        const withoutAssignments = reevaluateFacilityTeam(raw, facility, state, withoutContext);
        const withBonus = calculateGlobalBonus(state, facility, withContext) +
          calculateRemoteFacilityEfficiencyBonus(facility, withContext);
        const withoutBonus = calculateGlobalBonus(state, facility, withoutContext) +
          calculateRemoteFacilityEfficiencyBonus(facility, withoutContext);
        const withSupportEfficiency = effectiveFacilityEfficiency(withAssignments, withBonus);
        const withoutSupportEfficiency = effectiveFacilityEfficiency(withoutAssignments, withoutBonus);
        if (Math.abs(withSupportEfficiency - withoutSupportEfficiency) <= 1e-12) continue;
        efficiencyComparisons.push({
          supportOperatorId: support.operatorId,
          supportFacilityId: support.facilityId,
          productionFacilityId: facility.id,
          productionOperatorIds: raw.map((assignment) => assignment.operatorId).sort(compareCodePoints),
          scheduleWindowId: window.shiftId,
          windowHours: window.hours,
          withSupportEfficiency,
          withoutSupportEfficiency
        });
      }
    }
    if (efficiencyComparisons.length === 0) continue;

    let necessity: RemovalNecessity | undefined;
    if (efficiencyComparisons.some((comparison) =>
      comparison.withSupportEfficiency > comparison.withoutSupportEfficiency + 1e-12
    )) {
      const withSupportObjective = canonicalAggregateScore(
        state, staticPlans, composition, scenario, selectionContext, supportPlacements, supportAssignments
      );
      const withoutSupportObjective = canonicalAggregateScore(
        state,
        withoutStaticPlans,
        composition,
        scenario,
        selectionContext,
        supportPlacements.filter((placement) =>
          placement.operatorId !== support.operatorId || placement.facilityId !== support.facilityId
        ),
        withoutSupportAssignments
      );
      if (Number.isFinite(withSupportObjective) && Number.isFinite(withoutSupportObjective) &&
          withoutSupportObjective < withSupportObjective - 1e-12) {
        necessity = {
          kind: "production-objective-worsened",
          withSupportObjective,
          withoutSupportObjective
        };
      }
    } else {
      const withSupport = withSupportMechanicalEvidence ?? evaluateCanonicalRotationMechanically(
        state, staticPlans, rotation.windows, scenario, selectionContext, selectedPlacements
      );
      withSupportMechanicalEvidence = withSupport;
      const rawWithoutSupport = authoritativeRawRotation.map((window) => ({
          ...window,
          assignments: window.assignments.filter((assignment) =>
            assignment.operatorId !== support.operatorId || assignment.facilityId !== support.facilityId
          ),
          recovery: window.recovery.filter((assignment) => assignment.operatorId !== support.operatorId)
        }));
      const withoutSupportRotation = materializeScheduleAwareRotation(
        state,
        rawWithoutSupport,
        scenario,
        selectionContext
      );
      const withoutSupport = evaluateCanonicalRotationMechanically(
        state,
        withoutStaticPlans,
        withoutSupportRotation,
        scenario,
        selectionContext,
        withoutSupportPlacements
      );
      const withSupportComplete = canonicalMechanicalEvidenceIsSustainable(withSupport);
      const withoutPhysicalComplete = withoutSupport.rotationComplete &&
        withoutSupport.supportCapacityValidated && withoutSupport.supportRecoveryValidated &&
        withoutSupport.supportIssueCount === 0;
      if (withSupportComplete && !withoutPhysicalComplete) {
        necessity = { kind: "support-physical-failure", withSupport, withoutSupport };
      } else if (withSupportComplete && withoutSupport.resourceStatus === "complete" &&
          (withoutSupport.resourceClosureSatisfied === false ||
            (withoutSupport.sustainabilityStatus === "evaluated" && withoutSupport.sustainable === false))) {
        necessity = { kind: "resource-or-sustainability-failure", withSupport, withoutSupport };
      }
    }
    // An incomplete counterfactual is not evidence that the removed support is
    // necessary for the claimed dimension. Keep each proof path fail-closed.
    if (!necessity) continue;
    proofs.push(...efficiencyComparisons.map((comparison) => ({ ...comparison, necessity })));
  }
  return proofs.sort((left, right) =>
    compareCodePoints(left.supportOperatorId, right.supportOperatorId) ||
    compareCodePoints(left.scheduleWindowId, right.scheduleWindowId) ||
    compareCodePoints(left.productionFacilityId, right.productionFacilityId)
  );
}

function canonicalizeDependencySupportFacilities(staticPlans: readonly FacilityPlan[]) {
  const plans = staticPlans.map((plan) => ({ ...plan, assignments: [...plan.assignments] }));
  for (const facilityType of new Set(plans.map((plan) => plan.facility.type))) {
    const typedPlans = plans
      .filter((plan) => plan.facility.type === facilityType)
      .sort((left, right) => compareCodePoints(left.facility.id, right.facility.id));
    const dependencies = typedPlans.flatMap((plan) => plan.assignments
      .filter((assignment) => supportRequirementSignatures(assignment).length > 0)
      .map((assignment) => ({ plan, assignment })))
      .sort((left, right) => compareCodePoints(left.assignment.operatorId, right.assignment.operatorId));
    for (const [dependencyIndex, { plan: sourcePlan, assignment }] of dependencies.entries()) {
      const targetPlan = typedPlans[dependencyIndex];
      if (!targetPlan || targetPlan.facility.id === sourcePlan.facility.id) continue;
      const sourceIndex = sourcePlan.assignments.findIndex((candidate) =>
        candidate.operatorId === assignment.operatorId
      );
      const targetIndex = targetPlan.assignments.findIndex(assignmentConsumesFacilitySlot);
      if (sourceIndex < 0) continue;
      const targetAssignment = targetIndex >= 0 ? targetPlan.assignments[targetIndex] : undefined;
      sourcePlan.assignments.splice(sourceIndex, 1,
        ...(targetAssignment ? [{ ...targetAssignment, facilityId: sourcePlan.facility.id }] : []));
      if (targetIndex >= 0) {
        targetPlan.assignments.splice(targetIndex, 1, { ...assignment, facilityId: targetPlan.facility.id });
      } else {
        targetPlan.assignments.push({ ...assignment, facilityId: targetPlan.facility.id });
      }
    }
  }
  return plans;
}

function generateCanonicalThreeGroupPlan(
  state: AppState,
  scenarioState: AppState,
  options: GenerateAssignmentPlanOptions,
  allowSupportFallback: boolean,
  initialScenario: SupportResourceScenarioEvaluation | undefined,
  selectionContext: AssignmentEvaluationContext | undefined
): AssignmentPlan {
  // Fixed facility slots are reservations only in their declared windows. The
  // source operators remain excluded from ordinary selection in this slice;
  // the canonical schedule validates and materializes the physical slots.
  const scheduleSelectionContext = selectionContext ? {
    ...selectionContext,
    excludedOrdinaryResourceOperatorIds: selectionContext.excludedOrdinaryResourceOperatorIds,
    reservedOperatorIds: selectionContext.reservedOperatorIds,
    // Fixed sources reserve physical capacity only in their declared windows.
    // The canonical rotation below materializes those windows and validates
    // capacity, allowing a different ordinary supporter to use the slot when
    // the fixed source is absent.
    reservedFacilitySlots: new Map<string, number>()
  } : undefined;
  const staticFacilities = state.facilities.filter((facility) =>
    facility.type !== "dormitory" && facility.type !== "factory" && facility.type !== "trading"
  );
  const stabilizeStaticPlans = (
    contextAssignments: readonly Assignment[],
    excludedOperatorIds: ReadonlySet<string>
  ) => {
    let plans = buildFacilityPlans(
      state,
      staticFacilities,
      [...contextAssignments],
      excludedOperatorIds,
      scheduleSelectionContext
    );
    for (let index = 0; index < 3; index += 1) {
      const next = buildFacilityPlans(
        state,
        staticFacilities,
        [...contextAssignments, ...plans.flatMap((plan) => plan.assignments)],
        excludedOperatorIds,
        scheduleSelectionContext
      );
      if (assignmentSignature(next) === assignmentSignature(plans)) return next;
      plans = next;
    }
    return plans;
  };
  let staticPlans: FacilityPlan[] = applyMoraleDurations(state, stabilizeStaticPlans([], new Set()));
  const scenarioForSelection = selectionContext ? initialScenario : undefined;
  const supportStarts = jointSupportStarts(
    state, staticFacilities, staticPlans, scheduleSelectionContext, initialScenario
  );
  const initialComposition = buildCanonicalScheduledProduction(
    state,
    supportStarts.starts[0].staticPlans,
    scenarioForSelection,
    scheduleSelectionContext
  );
  const initialAggregateScore = canonicalAggregateScore(
    state, supportStarts.starts[0].staticPlans, initialComposition, scenarioForSelection, scheduleSelectionContext
  );
  const evaluations: JointSupportEvaluation[] = [];
  let jointWork = 0;
  let removalRejected = 0;
  let bestStaticOnlyAggregateScore = initialAggregateScore;
  for (const start of supportStarts.starts) {
    if (jointWork >= jointSupportWorkLimit) break;
    const composition = start.requirementSignature === "baseline"
      ? initialComposition
      : buildCanonicalScheduledProduction(
          state,
          start.staticPlans,
          scenarioForSelection,
          scheduleSelectionContext,
          start.supportPlacements,
          start.supportAssignments
        );
    const aggregateScore = start.requirementSignature === "baseline"
      ? initialAggregateScore
      : canonicalAggregateScore(
          state, start.staticPlans, composition, scenarioForSelection, scheduleSelectionContext,
          start.supportPlacements, start.supportAssignments
        );
    jointWork += 1;
    let candidateRemovalProofs: ReturnType<typeof jointSupportRemovalProofs> | undefined;
    let staticOnlyAggregateScore: number | undefined;
    if (start.supportAssignments.length === 1 && jointWork < jointSupportWorkLimit) {
      staticOnlyAggregateScore = canonicalAggregateScore(
        state, start.staticPlans, initialComposition, scenarioForSelection, scheduleSelectionContext,
        start.supportPlacements, start.supportAssignments
      );
      jointWork += 1;
    }
    if (start.requirementSignature !== "baseline" && Number.isFinite(aggregateScore)) {
      candidateRemovalProofs = jointSupportRemovalProofs(
        state, start.staticPlans, composition, scenarioForSelection, scheduleSelectionContext,
        start.supportPlacements, start.supportAssignments
      );
      const provenSupportIds = new Set(candidateRemovalProofs.map((proof) => proof.supportOperatorId));
      if (start.supportAssignments.some((assignment) => !provenSupportIds.has(assignment.operatorId))) {
        removalRejected += 1;
        continue;
      }
      if (staticOnlyAggregateScore !== undefined) {
        const staticOnlyProvenSupportIds = new Set(jointSupportRemovalProofs(
          state, start.staticPlans, initialComposition, scenarioForSelection, scheduleSelectionContext,
          start.supportPlacements, start.supportAssignments
        ).map((proof) => proof.supportOperatorId));
        if (start.supportAssignments.every((assignment) => staticOnlyProvenSupportIds.has(assignment.operatorId))) {
          bestStaticOnlyAggregateScore = Math.max(bestStaticOnlyAggregateScore, staticOnlyAggregateScore);
        }
      }
    }
    evaluations.push({ ...start, composition, aggregateScore, ...(candidateRemovalProofs
      ? { removalProofs: candidateRemovalProofs }
      : {}) });
  }
  evaluations.sort((left, right) => Number(right.composition.complete) - Number(left.composition.complete) ||
    Number(Number.isFinite(right.aggregateScore)) - Number(Number.isFinite(left.aggregateScore)) ||
    right.aggregateScore - left.aggregateScore ||
    compareCodePoints(
      `${left.signature}|${jointCompositionSignature(left.composition)}`,
      `${right.signature}|${jointCompositionSignature(right.composition)}`
    ));
  const winningEvaluation = evaluations[0] ?? {
    ...supportStarts.starts[0],
    composition: initialComposition,
    aggregateScore: initialAggregateScore
  };
  staticPlans = winningEvaluation.staticPlans;
  let composition = winningEvaluation.composition;
  const removalProofs = winningEvaluation.removalProofs ?? jointSupportRemovalProofs(
      state, staticPlans, composition, scenarioForSelection, scheduleSelectionContext,
      winningEvaluation.supportPlacements, winningEvaluation.supportAssignments
    );
  const supportPlacements = [
    ...winningEvaluation.supportPlacements.filter((placement) => removalProofs.some((proof) =>
      proof.supportOperatorId === placement.operatorId && proof.supportFacilityId === placement.facilityId
    )),
    ...requiredScenarioSupportPlacements(state, initialScenario)
  ];
  const materializedRotationResult = buildCanonicalRotation(
    state,
    staticPlans,
    composition,
    initialScenario,
    scheduleSelectionContext,
    supportPlacements,
    winningEvaluation.supportAssignments,
    true
  );
  const supportValidation = validateScheduledSupportMaterialization(
    state, materializedRotationResult.windows, supportPlacements, initialScenario
  );
  const supportScheduleComplete = supportValidation.supportCapacityValidated &&
    supportValidation.supportRecoveryValidated && supportValidation.issues.length === 0;
  const coordinateBaselineAggregateScore = Math.max(initialAggregateScore, bestStaticOnlyAggregateScore);
  const jointSupportDiagnostic: AssignmentPlan["diagnostics"][number] | undefined =
    supportStarts.starts.length > 1 ? {
      code: "joint-support-search-not-certified",
      message: "Bounded joint static-support and production search selected an authoritative reevaluated plan",
      provenance: "bounded-joint-static-support-production-removal-proven",
      initialAggregateScore: coordinateBaselineAggregateScore,
      bestProductionOnlyAggregateScore: initialAggregateScore,
      bestStaticOnlyAggregateScore,
      aggregateScore: winningEvaluation.aggregateScore,
      initialSupportOperatorIds: supportStarts.starts[0].staticPlans
        .flatMap((plan) => plan.assignments.map((assignment) => assignment.operatorId)).sort(compareCodePoints),
      selectedSupportOperatorIds: staticPlans
        .flatMap((plan) => plan.assignments.map((assignment) => assignment.operatorId))
        .concat(winningEvaluation.supportAssignments.map((assignment) => assignment.operatorId)).sort(compareCodePoints),
      requirementSignatures: supportStarts.requirementSignatures,
      rounds: jointSupportRoundLimit,
      roundLimit: jointSupportRoundLimit,
      work: jointWork,
      workLimit: jointSupportWorkLimit,
      discardedOptions: supportStarts.discardedOptions + removalRejected +
        Math.max(0, supportStarts.starts.length - evaluations.length - removalRejected),
      seedCount: supportStarts.starts.length,
      seedLimit: supportStarts.seedLimit,
      discardedSeeds: supportStarts.discardedSeeds,
      retainedRequirementSignatures: supportStarts.retainedRequirementSignatures,
      startsEvaluated: evaluations.length + removalRejected,
      removalProofs
    } : undefined;
  const scheduledSupportProfile: AssignmentPlan["diagnostics"][number] = {
    code: "scheduled-support-profile",
    message: supportScheduleComplete
      ? "Bounded scheduled support materialization passed physical capacity and recovery validation"
      : "Bounded scheduled support materialization failed physical capacity or recovery validation",
    completion: supportScheduleComplete ? "complete" : "incomplete",
    provenance: "bounded-scheduled-support-materialization-not-certified",
    supportPlacements,
    supportCapacityValidated: supportValidation.supportCapacityValidated,
    supportRecoveryValidated: supportValidation.supportRecoveryValidated,
    issues: supportValidation.issues
  };
  const supportValidationDiagnostic: AssignmentPlan["diagnostics"][number] | undefined =
    supportScheduleComplete ? undefined : {
      code: "scheduled-support-materialization-not-certified",
      message: "Scheduled support materialization failed physical capacity or recovery validation",
      completion: "incomplete",
      supportPlacements,
      supportCapacityValidated: supportValidation.supportCapacityValidated,
      supportRecoveryValidated: supportValidation.supportRecoveryValidated,
      issues: supportValidation.issues
    };
  const rotationResult = supportScheduleComplete ? materializedRotationResult : {
    windows: materializedRotationResult.windows.map((window) => ({
      ...window,
      incompleteGroupIds: [...new Set([...window.incompleteGroupIds, ...window.activeGroupIds])]
        .sort(compareCodePoints),
      assignments: [],
      recovery: []
    })),
    selectedByPhysicalFacility: new Map<string, Assignment[]>()
  };
  const productionPlans = state.facilities
    .filter((facility) => facility.type === "factory" || facility.type === "trading")
    .sort((left, right) => compareCodePoints(left.id, right.id))
    .map((facility) => {
      const assignments = rotationResult.selectedByPhysicalFacility.get(facility.id) ?? [];
      return {
        facility,
        assignments,
        expectedEfficiency: effectiveFacilityEfficiency(assignments, 0),
        score: effectiveFacilityScore(assignments, facility, state.preference, 0),
        alternatives: []
      };
    });
  const firstWindow = rotationResult.windows.find((window) => window.incompleteGroupIds.length === 0);
  const materializedStaticPlans = staticPlans.map((plan) => {
    const assignments = firstWindow?.assignments.filter((assignment) =>
      assignment.facilityId === plan.facility.id
    ) ?? plan.assignments;
    return { ...plan, assignments };
  });
  const planByFacilityId = new Map([...materializedStaticPlans, ...productionPlans]
    .map((plan) => [plan.facility.id, plan]));
  const facilityPlans = state.facilities
    .filter((facility) => facility.type !== "dormitory")
    .map((facility) => planByFacilityId.get(facility.id) ?? {
      facility, assignments: [], expectedEfficiency: 0, score: 0, alternatives: []
    });
  const supportResourceScenario = options.supportResourceScenario
    ? resolveSupportResourceScenario(scenarioState, options.supportResourceScenario, rotationResult.windows)
    : undefined;
  if (allowSupportFallback && selectionContext && supportResourceScenario && !supportResourceScenario.complete) {
    return generateAssignmentPlanInternal(scenarioState, options, false);
  }
  const windowFacilityEfficiencyEvaluations = supportResourceScenario?.complete && composition.complete &&
      rotationResult.windows.every((window) => window.incompleteGroupIds.length === 0)
    ? evaluateWindowFacilityEfficiencies(state, facilityPlans, rotationResult.windows, supportResourceScenario)
    : undefined;
  const totalScore = winningEvaluation.aggregateScore;
  let dailyValue = rotationResult.windows.reduce((sum, window) => sum + window.assignments.reduce(
    (windowSum, assignment) => {
      const facility = state.facilities.find((candidate) => candidate.id === assignment.facilityId);
      return facility && (facility.type === "factory" || facility.type === "trading")
        ? windowSum + assignment.efficiency * productWeight(facility.product, state.preference) *
          window.hours * 24 / state.schedule.cycleHours
        : windowSum;
    }, 0), 0);
  if (windowFacilityEfficiencyEvaluations) {
    dailyValue = windowFacilityEfficiencyEvaluations.reduce((sum, evaluation) => {
      const facility = state.facilities.find((candidate) => candidate.id === evaluation.facilityId);
      const window = rotationResult.windows.find((candidate) => candidate.shiftId === evaluation.scheduleWindowId);
      return facility && window && (facility.type === "factory" || facility.type === "trading")
        ? sum + evaluation.additiveEfficiency * productWeight(facility.product, state.preference) *
          window.hours * 24 / state.schedule.cycleHours
        : sum;
    }, 0);
  }
  const rotationDiagnostics: AssignmentPlan["diagnostics"] = rotationResult.windows.flatMap((window) =>
    window.incompleteGroupIds.map((groupId) => ({
      code: "schedule-group-unpopulated" as const,
      groupId,
      shiftId: window.shiftId,
      message: `Schedule group ${groupId} is not populated for shift ${window.shiftId}`
    }))
  );
  const diagnostics = [
    ...composition.diagnostics.map((diagnostic) =>
      !supportScheduleComplete && diagnostic.code === "schedule-group-search-profile"
        ? {
            ...diagnostic,
            completion: "unknown" as const,
            incompleteDimensionIds: diagnostic.dimensionIds,
            message: "Schedule production search is not certified because scheduled support materialization is incomplete"
          }
        : diagnostic
    ),
    ...(jointSupportDiagnostic ? [jointSupportDiagnostic] : []),
    scheduledSupportProfile,
    ...(supportValidationDiagnostic ? [supportValidationDiagnostic] : []),
    ...rotationDiagnostics
  ];
  const warnings = [
    ...buildWarnings(state, state.facilities.filter((facility) => facility.type !== "dormitory"), facilityPlans),
    ...rotationDiagnostics.map((diagnostic) => diagnostic.message)
  ];
  const plan = {
    generatedAt: new Date().toISOString(),
    totalScore,
    dailyValue,
    facilityPlans,
    schedule: structuredClone(state.schedule),
    rotation: rotationResult.windows,
    diagnostics,
    warnings,
    ...(supportResourceScenario ? { supportResourceScenario } : {}),
    ...(windowFacilityEfficiencyEvaluations ? { windowFacilityEfficiencyEvaluations } : {})
  };
  const resources = evaluatePlanResources(plan);
  const planWithResources = { ...plan, resources };
  return {
    ...planWithResources,
    sustainability: evaluatePlanSustainability({ plan: planWithResources, layout: state.layout })
  };
}

function buildSupportSelectionContext(
  state: AppState,
  scenario: SupportResourceScenarioEvaluation,
  scheduleSkeleton: AssignmentPlan["rotation"]
): AssignmentEvaluationContext | undefined {
  if (!scenario.complete || !Number.isFinite(state.schedule.cycleHours) || state.schedule.cycleHours <= 0) {
    return undefined;
  }
  const windowHours = new Map(
    scheduleSkeleton.map((window) => [window.shiftId, window.endHour - window.startHour])
  );
  const weightedEntries = scenario.sources.reduce<Map<string, number>>((amounts, evidence) => {
    if (evidence.status !== "resolved") return amounts;
    const duration = windowHours.get(evidence.source.scheduleWindowId);
    if (duration === undefined || !Number.isFinite(duration)) return amounts;
    const weightedAmount = evidence.source.amount * duration / state.schedule.cycleHours;
    if (!Number.isFinite(weightedAmount)) return amounts;
    amounts.set(
      evidence.source.resourceKey,
      (amounts.get(evidence.source.resourceKey) ?? 0) + weightedAmount
    );
    return amounts;
  }, new Map());
  const fixedResourceAmounts = Object.freeze(Object.fromEntries(
    [...weightedEntries.entries()].sort(([left], [right]) => left.localeCompare(right))
  ));
  const fixedDormitoryOccupancy = scenario?.fixedContext?.dormitoryOccupancy.status === "resolved"
    ? scenario.fixedContext.dormitoryOccupancy.context.amount
    : undefined;
  const excludedOrdinaryResourceOperatorIds = new Set(
    scenario.sources
      .filter((evidence) => evidence.status === "resolved")
      .map((evidence) => evidence.source.operatorId)
      .sort()
  );
  const reservedFacilitySlots = maximumConcurrentAppStateSourceReservations(
    scenario,
    scheduleSkeleton,
    state.schedule.cycleHours
  );
  return {
    assignments: [],
    facilities: state.facilities,
    roster: state.roster,
    shiftHours: optimizerShiftHours(state),
    fixedResourceAmounts,
    fixedDormitoryOccupancy,
    excludedOrdinaryResourceOperatorIds,
    reservedOperatorIds: excludedOrdinaryResourceOperatorIds,
    reservedFacilitySlots
  };
}

function maximumConcurrentAppStateSourceReservations(
  scenario: SupportResourceScenarioEvaluation,
  scheduleWindows: AssignmentPlan["rotation"],
  cycleHours: number
): ReadonlyMap<string, number> {
  const windowsById = new Map(scheduleWindows.map((window) => [window.shiftId, window]));
  const sourcesByFacility = new Map<string, Array<{ operatorId: string; startHour: number; endHour: number }>>();
  for (const evidence of scenario.sources) {
    if (evidence.status !== "resolved" || evidence.source.facility.backing !== "app-state") continue;
    const window = windowsById.get(evidence.source.scheduleWindowId);
    if (!window) continue;
    const entries = sourcesByFacility.get(evidence.source.facility.id) ?? [];
    entries.push(...splitCyclicHalfOpenInterval(window, cycleHours).map((segment) => ({
      operatorId: evidence.source.operatorId,
      ...segment
    })));
    sourcesByFacility.set(evidence.source.facility.id, entries);
  }
  return new Map(
    [...sourcesByFacility.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([facilityId, entries]) => {
        const boundaries = [...new Set(entries.flatMap((entry) => [entry.startHour, entry.endHour]))]
          .sort((left, right) => left - right);
        let maximum = 0;
        for (let index = 0; index < boundaries.length - 1; index += 1) {
          const midpoint = (boundaries[index] + boundaries[index + 1]) / 2;
          maximum = Math.max(maximum, new Set(
            entries
              .filter((entry) => entry.startHour <= midpoint && midpoint < entry.endHour)
              .map((entry) => entry.operatorId)
          ).size);
        }
        return [facilityId, maximum] as const;
      })
  );
}

export function inspectExplicitFacilityTeams(
  state: AppState,
  input: ExplicitFacilityTeamInspectionInput
): ExplicitFacilityTeamInspectionResult {
  const diagnostics: ExplicitFacilityTeamDiagnostic[] = [];
  const teamFacilities = new Set<string>();
  const operatorPaths = new Map<string, string>();
  const allDeclarations = [
    ...input.teams.map((team, index) => ({ ...team, path: `teams[${index}]`, kind: "team" as const })),
    ...(input.supportPlacements ?? []).map((placement, index) => ({
      ...placement,
      path: `supportPlacements[${index}]`,
      kind: "support" as const
    }))
  ];

  if (!Number.isFinite(input.evaluationHours) || input.evaluationHours <= 0) {
    diagnostics.push({
      code: "evaluation-hours-invalid",
      path: "evaluationHours",
      message: "Evaluation hours must be finite and positive"
    });
  }

  for (const declaration of allDeclarations) {
    const facility = state.facilities.find((candidate) => candidate.id === declaration.facilityId);
    if (!facility) {
      diagnostics.push({
        code: "facility-not-found",
        path: `${declaration.path}.facilityId`,
        facilityId: declaration.facilityId,
        message: `Facility ${declaration.facilityId} does not exist`
      });
    } else if (declaration.operatorIds.length > facility.slotCount) {
      diagnostics.push({
        code: "facility-capacity-exceeded",
        path: `${declaration.path}.operatorIds`,
        facilityId: declaration.facilityId,
        message: `Facility ${declaration.facilityId} capacity ${facility.slotCount} is exceeded`
      });
    }
    if (declaration.kind === "team") {
      if (teamFacilities.has(declaration.facilityId)) {
        diagnostics.push({
          code: "facility-declared-more-than-once",
          path: `${declaration.path}.facilityId`,
          facilityId: declaration.facilityId,
          message: `Facility ${declaration.facilityId} is declared more than once`
        });
      }
      teamFacilities.add(declaration.facilityId);
    }
    for (const [operatorIndex, operatorId] of declaration.operatorIds.entries()) {
      const path = `${declaration.path}.operatorIds[${operatorIndex}]`;
      const previousPath = operatorPaths.get(operatorId);
      if (previousPath) {
        diagnostics.push({
          code: "operator-assignment-conflict",
          path,
          facilityId: declaration.facilityId,
          operatorId,
          message: `Operator ${operatorId} is already assigned at ${previousPath}`
        });
      } else {
        operatorPaths.set(operatorId, path);
      }
      const operator = operatorById.get(operatorId);
      if (!operator) {
        diagnostics.push({
          code: "operator-not-found",
          path,
          facilityId: declaration.facilityId,
          operatorId,
          message: `Operator ${operatorId} does not exist in the catalog`
        });
      } else if (!state.roster[operatorId]?.owned) {
        diagnostics.push({
          code: "operator-unowned",
          path,
          facilityId: declaration.facilityId,
          operatorId,
          message: `Operator ${operatorId} is not owned`
        });
      } else if (!isOperatorAvailable(operatorAvailabilitySnapshot, state.region, operatorId)) {
        diagnostics.push({
          code: "operator-region-unavailable",
          path,
          facilityId: declaration.facilityId,
          operatorId,
          message: `Operator ${operatorId} is unavailable in region ${state.region}`
        });
      }
    }
  }

  const orderedDiagnostics = () => diagnostics.sort(
    (left, right) => left.path.localeCompare(right.path) || left.code.localeCompare(right.code)
  );
  if (diagnostics.length > 0) {
    return { status: "incomplete", diagnostics: orderedDiagnostics(), teams: [], supportAssignments: [] };
  }

  const placeholders = allDeclarations.flatMap((declaration) => declaration.operatorIds.map((operatorId) => ({
    facilityId: declaration.facilityId,
    operatorId,
    skillId: "baseline",
    score: 0,
    efficiency: 0,
    fatigueHours: moraleCapacity,
    recoveryHours: input.evaluationHours / maxDormitoryRecoveryPerHour,
    reason: "Explicit inspection context placeholder"
  } satisfies Assignment)));
  const baseContext: AssignmentEvaluationContext = {
    assignments: placeholders,
    facilities: state.facilities,
    roster: state.roster,
    shiftHours: input.evaluationHours,
    fixedResourceAmounts: input.fixedResourceAmounts,
    fixedDormitoryOccupancy: input.fixedDormitoryOccupancy,
    excludedOrdinaryResourceOperatorIds: input.excludedOrdinaryResourceOperatorIds
  };
  const resolveAssignments = (
    facilityId: string,
    operatorIds: readonly string[],
    path: string,
    context: AssignmentEvaluationContext
  ) => {
    const facility = state.facilities.find((candidate) => candidate.id === facilityId)!;
    const candidates = findCandidates(facility, state, 0, context);
    return operatorIds.flatMap((operatorId, operatorIndex) => {
      const assignment = candidates.find((candidate) => candidate.operatorId === operatorId);
      if (assignment) return [assignment];
      diagnostics.push({
        code: "operator-facility-ineligible",
        path: `${path}.operatorIds[${operatorIndex}]`,
        facilityId,
        operatorId,
        message: `Operator ${operatorId} has no ordinary eligible candidate for ${facilityId}`
      });
      return [];
    });
  };

  const rawTeams = input.teams.map((team, index) => ({
    facility: state.facilities.find((candidate) => candidate.id === team.facilityId)!,
    assignments: resolveAssignments(team.facilityId, team.operatorIds, `teams[${index}]`, baseContext)
  }));
  if (diagnostics.length > 0) {
    return { status: "incomplete", diagnostics: orderedDiagnostics(), teams: [], supportAssignments: [] };
  }
  const rawTeamAssignments = rawTeams.flatMap((team) => team.assignments);
  const supportContext = { ...baseContext, assignments: [...rawTeamAssignments, ...placeholders] };
  const rawSupportGroups = (input.supportPlacements ?? []).map((placement, index) => ({
    facility: state.facilities.find((candidate) => candidate.id === placement.facilityId)!,
    assignments: resolveAssignments(
      placement.facilityId,
      placement.operatorIds,
      `supportPlacements[${index}]`,
      supportContext
    )
  }));
  if (diagnostics.length > 0) {
    return { status: "incomplete", diagnostics: orderedDiagnostics(), teams: [], supportAssignments: [] };
  }
  const allRawSupport = rawSupportGroups.flatMap((group) => group.assignments);
  const combinedContext = { ...baseContext, assignments: [...allRawSupport, ...rawTeamAssignments] };
  const supportAssignments = rawSupportGroups.flatMap(({ facility, assignments }) =>
    reevaluateFacilityTeam(assignments, facility, state, combinedContext)
  ).sort((left, right) =>
    left.facilityId.localeCompare(right.facilityId) || left.operatorId.localeCompare(right.operatorId)
  );
  const finalContext = { ...baseContext, assignments: [...supportAssignments, ...rawTeamAssignments] };
  const teams = rawTeams.map(({ facility, assignments }) => {
    const reevaluated = reevaluateFacilityTeam(assignments, facility, state, finalContext);
    const facilityBonus = calculateGlobalBonus(state, facility, finalContext) +
      calculateRemoteFacilityEfficiencyBonus(facility, finalContext);
    return {
      facilityId: facility.id,
      assignments: reevaluated,
      expectedEfficiency: effectiveFacilityEfficiency(reevaluated, facilityBonus)
    };
  });
  return { status: "complete", diagnostics: [], teams, supportAssignments };
}

type ScheduleAwareRotationMetadata = {
  contextFingerprint: string;
  ambientContextFingerprint: string;
  rawRotation: AssignmentPlan["rotation"];
  materializedFingerprint: string;
};

const scheduleAwareRotationMetadata = new WeakMap<object, ScheduleAwareRotationMetadata>();

function canonicalFingerprintValue(value: unknown, ancestors = new Set<object>()): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "boolean:true" : "boolean:false";
  if (typeof value === "string") return `string:${JSON.stringify(value)}`;
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "number:NaN";
    if (value === Number.POSITIVE_INFINITY) return "number:+Infinity";
    if (value === Number.NEGATIVE_INFINITY) return "number:-Infinity";
    if (Object.is(value, -0)) return "number:-0";
    return `number:${value}`;
  }
  if (typeof value === "bigint") return `bigint:${value}`;
  if (typeof value !== "object") throw new TypeError(`Unsupported fingerprint value: ${typeof value}`);
  if (ancestors.has(value)) throw new TypeError("Cannot fingerprint cyclic schedule-aware context");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `array:[${value.map((item) => canonicalFingerprintValue(item, ancestors)).join(",")}]`;
    }
    if (value instanceof Map) {
      const entries = [...value.entries()].map(([key, item]) =>
        `${canonicalFingerprintValue(key, ancestors)}=>${canonicalFingerprintValue(item, ancestors)}`
      ).sort(compareCodePoints);
      return `map:{${entries.join(",")}}`;
    }
    if (value instanceof Set) {
      const entries = [...value].map((item) => canonicalFingerprintValue(item, ancestors)).sort(compareCodePoints);
      return `set:{${entries.join(",")}}`;
    }
    if (value instanceof Date) return `date:${value.toISOString()}`;
    const record = value as Record<string, unknown>;
    return `object:{${Object.keys(record).sort(compareCodePoints).map((key) =>
      `${JSON.stringify(key)}:${canonicalFingerprintValue(record[key], ancestors)}`
    ).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function deterministicFingerprint(value: unknown) {
  const canonical = canonicalFingerprintValue(value);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < canonical.length; index += 1) {
    const code = canonical.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${canonical.length.toString(36)}:${(first >>> 0).toString(36)}:${(second >>> 0).toString(36)}`;
}

function rotationWithoutMaterializationMetadata(
  rotation: readonly AssignmentPlan["rotation"][number][]
): AssignmentPlan["rotation"] {
  return rotation.map(({ scheduleAwareMaterialization: _metadata, ...window }) => structuredClone(window));
}

function rotationContentFingerprint(rotation: readonly AssignmentPlan["rotation"][number][]) {
  return deterministicFingerprint(rotation.map(({ scheduleAwareMaterialization: _metadata, ...window }) => window));
}

function rawRotationFromCloneSafeProvenance(
  rotation: readonly AssignmentPlan["rotation"][number][]
): AssignmentPlan["rotation"] | undefined {
  const provenance = rotation.map((window) => window.scheduleAwareMaterialization);
  if (provenance.every((entry) => entry === undefined)) return undefined;
  if (provenance.some((entry) => entry === undefined)) {
    throw new Error("Incomplete schedule-aware materialization provenance");
  }
  return provenance.map((entry) => {
    if (entry!.version !== 1 || deterministicFingerprint(entry!.sourceWindow) !== entry!.sourceFingerprint) {
      throw new Error("Invalid schedule-aware materialization provenance");
    }
    return structuredClone(entry!.sourceWindow);
  });
}

function isScheduleAwareRotation(
  state: AppState,
  rotation: readonly AssignmentPlan["rotation"][number][],
  scenario: SupportResourceScenarioEvaluation | undefined
) {
  const ambientContextFingerprint = deterministicFingerprint({ state, scenario });
  const trustedMetadata = scheduleAwareRotationMetadata.get(rotation);
  if (trustedMetadata) {
    return trustedMetadata.ambientContextFingerprint === ambientContextFingerprint &&
      trustedMetadata.materializedFingerprint === rotationContentFingerprint(rotation);
  }
  return rotation.length > 0 && rotation.every((window) => {
    const provenance = window.scheduleAwareMaterialization;
    if (!provenance || provenance.version !== 1 ||
        provenance.ambientContextFingerprint !== ambientContextFingerprint ||
        deterministicFingerprint(provenance.sourceWindow) !== provenance.sourceFingerprint) {
      return false;
    }
    const { scheduleAwareMaterialization: _metadata, ...materializedWindow } = window;
    return deterministicFingerprint(materializedWindow) === provenance.materializedWindowFingerprint;
  });
}

function markScheduleAwareRotation(
  rotation: AssignmentPlan["rotation"],
  rawRotation: AssignmentPlan["rotation"],
  contextFingerprint: string,
  ambientContextFingerprint: string
) {
  for (let index = 0; index < rotation.length; index += 1) {
    const sourceWindow = structuredClone(rawRotation[index]);
    const materializedWindowFingerprint = deterministicFingerprint(rotation[index]);
    rotation[index].scheduleAwareMaterialization = {
      version: 1,
      contextFingerprint,
      ambientContextFingerprint,
      sourceFingerprint: deterministicFingerprint(sourceWindow),
      materializedWindowFingerprint,
      sourceWindow
    };
  }
  scheduleAwareRotationMetadata.set(rotation, {
    contextFingerprint,
    ambientContextFingerprint,
    rawRotation: structuredClone(rawRotation),
    materializedFingerprint: rotationContentFingerprint(rotation)
  });
  return rotation;
}

export function materializeScheduleAwareRotation(
  state: AppState,
  rotation: readonly AssignmentPlan["rotation"][number][],
  scenario: SupportResourceScenarioEvaluation | undefined,
  selectionContext?: AssignmentEvaluationContext
): AssignmentPlan["rotation"] {
  const contextFingerprint = deterministicFingerprint({ state, scenario, selectionContext });
  const ambientContextFingerprint = deterministicFingerprint({ state, scenario });
  const trustedMetadata = scheduleAwareRotationMetadata.get(rotation);
  if (trustedMetadata?.contextFingerprint === contextFingerprint &&
      trustedMetadata.materializedFingerprint === rotationContentFingerprint(rotation)) {
    return rotation as AssignmentPlan["rotation"];
  }
  const rawRotation = trustedMetadata
    ? structuredClone(trustedMetadata.rawRotation)
    : rawRotationFromCloneSafeProvenance(rotation) ?? rotationWithoutMaterializationMetadata(rotation);
  const windows = rawRotation.map((window) => ({ ...window, assignments: [...window.assignments] }));
  const segments = deriveScheduleAwareWorkSegments(state.schedule, windows);
  const segmentByIdentity = new Map(segments.map((segment) => [
    `${segment.scheduleWindowId}\u0000${segment.operatorId}`,
    segment
  ]));
  const reservedOperatorIds = new Set(scenario?.sources
    .filter((evidence) => evidence.status === "resolved")
    .map((evidence) => evidence.source.operatorId) ?? []);
  const reservedFacilitySlots = scenario
    ? maximumConcurrentAppStateSourceReservations(scenario, windows, state.schedule.cycleHours)
    : selectionContext?.reservedFacilitySlots;
  const windowFacilities = canonicalWindowFacilities(state, scenario);
  const contexts = new Map(windows.map((window) => {
    const dormitoryAssignments = implicitDormitoryResourceAssignments(
      state,
      window.assignments,
      selectionContext?.reservedOperatorIds ?? reservedOperatorIds,
      reservedFacilitySlots
    );
    const elapsedByOperator = new Map(window.assignments.map((assignment) => [
      assignment.operatorId,
      segmentByIdentity.get(`${window.shiftId}\u0000${assignment.operatorId}`)?.elapsedWorkHours ?? 0
    ]));
    return [window.shiftId, {
      ...selectionContext,
      ...scheduleWindowFixedContext(scenario, window.shiftId),
      assignments: [...window.assignments, ...dormitoryAssignments],
      facilities: windowFacilities,
      roster: state.roster,
      shiftHours: window.hours,
      workElapsedHoursByOperator: elapsedByOperator
    } satisfies AssignmentEvaluationContext] as const;
  }));

  for (const window of windows) {
    const context = contexts.get(window.shiftId)!;
    window.assignments = [...new Set(window.assignments.map((assignment) => assignment.facilityId))]
      .sort(compareCodePoints)
      .flatMap((facilityId) => {
        const assignments = window.assignments.filter((assignment) => assignment.facilityId === facilityId);
        const facility = windowFacilities.find((candidate) => candidate.id === facilityId);
        return facility ? reevaluateFacilityTeam(assignments, facility, state, context) : assignments;
      });
    context.assignments = [
      ...window.assignments,
      ...context.assignments.filter((assignment) =>
        !window.assignments.some((working) => working.operatorId === assignment.operatorId)
      )
    ];
  }

  const externalRecoveryOperatorIds = new Set(Object.entries(state.roster)
    .filter(([, entry]) => entry.owned)
    .map(([operatorId]) => operatorId));
  const assignmentByIdentity = new Map(windows.flatMap((window) => window.assignments.map((assignment) => [
    `${window.shiftId}\u0000${assignment.operatorId}`,
    assignment
  ] as const)));
  const segmentsByBlock = new Map<string, ScheduleAwareWorkSegment[]>();
  for (const segment of segments) {
    const block = segmentsByBlock.get(segment.blockId) ?? [];
    block.push(segment);
    segmentsByBlock.set(segment.blockId, block);
  }
  for (const blockSegments of segmentsByBlock.values()) {
    let moraleSpentBefore = 0;
    for (const segment of [...blockSegments].sort((left, right) => left.sequenceIndex - right.sequenceIndex)) {
      const window = windows.find((candidate) => candidate.shiftId === segment.scheduleWindowId)!;
      const assignment = assignmentByIdentity.get(`${window.shiftId}\u0000${segment.operatorId}`);
      if (!assignment) continue;
      const recoveryWindow = windows.find((candidate) =>
        !candidate.assignments.some((item) => item.operatorId === segment.operatorId)
      );
      const workingContext = contexts.get(window.shiftId)!;
      const applied = applyMoraleDurationToAssignment(
        assignment,
        state,
        { ...workingContext, moraleSpentBefore },
        recoveryWindow ? contexts.get(recoveryWindow.shiftId)! : workingContext,
        false,
        undefined,
        externalRecoveryOperatorIds
      );
      assignmentByIdentity.set(`${window.shiftId}\u0000${segment.operatorId}`, applied);
      moraleSpentBefore = Math.min(
        moraleCapacity,
        moraleSpentBefore + (applied.moraleConsumptionPerHour ?? 0) * window.hours
      );
    }
  }
  return markScheduleAwareRotation(windows.map((window) => ({
    ...window,
    assignments: window.assignments.map((assignment) =>
      assignmentByIdentity.get(`${window.shiftId}\u0000${assignment.operatorId}`) ?? assignment
    )
  })), rawRotation, contextFingerprint, ambientContextFingerprint);
}

function evaluateScheduleAwareWindowFacilityEfficiencies(
  state: AppState,
  facilityPlans: readonly FacilityPlan[],
  scheduleAwareRotation: readonly AssignmentPlan["rotation"][number][],
  scenario: SupportResourceScenarioEvaluation | undefined,
  selectionContext?: AssignmentEvaluationContext
): WindowFacilityEfficiencyEvaluation[] {
  const fixedDormitoryOccupancy = scenario?.fixedContext?.dormitoryOccupancy.status === "resolved"
    ? scenario.fixedContext.dormitoryOccupancy.context.amount
    : undefined;
  const reservedOperatorIds = new Set(
    scenario?.sources
      .filter((evidence) => evidence.status === "resolved")
      .map((evidence) => evidence.source.operatorId) ?? []
  );
  const reservedFacilitySlots = scenario
    ? maximumConcurrentAppStateSourceReservations(
        scenario,
        [...scheduleAwareRotation],
        state.schedule.cycleHours
      )
    : selectionContext?.reservedFacilitySlots;

  return scheduleAwareRotation.flatMap((window) => {
    const windowSources = scenario?.sources.filter(
      (evidence) => evidence.status === "resolved" && evidence.source.scheduleWindowId === window.shiftId
    ) ?? [];
    const fixedResourceAmounts = windowSources.reduce<Record<string, number>>((amounts, evidence) => {
      amounts[evidence.source.resourceKey] =
        (amounts[evidence.source.resourceKey] ?? 0) + evidence.source.amount;
      return amounts;
    }, {});
    const excludedOrdinaryResourceOperatorIds = new Set(
      windowSources.map((evidence) => evidence.source.operatorId)
    );
    const implicitDormitoryAssignments = implicitDormitoryResourceAssignments(
      state,
      window.assignments,
      selectionContext?.reservedOperatorIds ?? reservedOperatorIds,
      reservedFacilitySlots
    );
    const context: AssignmentEvaluationContext = {
      ...selectionContext,
      assignments: [...window.assignments, ...implicitDormitoryAssignments],
      facilities: state.facilities,
      roster: state.roster,
      shiftHours: window.endHour - window.startHour,
      fixedResourceAmounts,
      fixedDormitoryOccupancy,
      excludedOrdinaryResourceOperatorIds
    };

    return [...facilityPlans]
      .sort((left, right) => left.facility.id.localeCompare(right.facility.id))
      .map((plan) => {
        const selectedAssignments = window.assignments.filter(
          (assignment) => assignment.facilityId === plan.facility.id
        );
        const facilityBonus =
          calculateGlobalBonus(state, plan.facility, context) +
          calculateRemoteFacilityEfficiencyBonus(plan.facility, context);
        return {
          scheduleWindowId: window.shiftId,
          facilityId: plan.facility.id,
          additiveEfficiency: effectiveFacilityEfficiency(selectedAssignments, facilityBonus),
          provenance: "optimizer-normal-team-reevaluation-with-schedule-aware-contiguous-work-and-resolved-support-context" as const,
          fixedResourceAmounts: Object.freeze({ ...fixedResourceAmounts }),
          ...(fixedDormitoryOccupancy === undefined ? {} : { fixedDormitoryOccupancy })
        };
      });
  });
}

export function evaluateWindowFacilityEfficiencies(
  state: AppState,
  facilityPlans: readonly FacilityPlan[],
  rotation: readonly AssignmentPlan["rotation"][number][],
  scenario: SupportResourceScenarioEvaluation
): WindowFacilityEfficiencyEvaluation[] {
  const scheduleAwareRotation = isScheduleAwareRotation(state, rotation, scenario)
    ? rotation
    : materializeScheduleAwareRotation(state, rotation, scenario);
  return evaluateScheduleAwareWindowFacilityEfficiencies(
    state,
    facilityPlans,
    scheduleAwareRotation,
    scenario
  );
}

function buildFacilityPlans(
  state: AppState,
  enabledFacilities: FacilitySlot[],
  contextAssignments: Assignment[],
  excludedOperatorIds: ReadonlySet<string> = new Set(),
  selectionContext?: AssignmentEvaluationContext
): FacilityPlan[] {
  const reservedOperatorIds = selectionContext?.reservedOperatorIds ?? new Set<string>();
  const dormitoryResourceAssignments = implicitDormitoryResourceAssignments(
    state,
    contextAssignments,
    reservedOperatorIds,
    selectionContext?.reservedFacilitySlots
  );
  const unavailableOperatorIds = new Set([
    ...excludedOperatorIds,
    ...reservedOperatorIds,
    ...dormitoryResourceAssignments.map((assignment) => assignment.operatorId)
  ]);
  const context: AssignmentEvaluationContext = {
    ...selectionContext,
    assignments: [...contextAssignments, ...dormitoryResourceAssignments],
    facilities: state.facilities,
    roster: state.roster,
    shiftHours: optimizerShiftHours(state)
  };
  const facilityCandidates = [...enabledFacilities]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((facility) => {
    const globalBonus = calculateGlobalBonus(state, facility, context);
    const remoteEfficiencyBonus = calculateRemoteFacilityEfficiencyBonus(facility, context);
    const facilityBonus = globalBonus + remoteEfficiencyBonus;
      const candidates = findCandidates(facility, state, 0, context)
        .filter((candidate) => !unavailableOperatorIds.has(candidate.operatorId))
        .sort((a, b) => b.score - a.score);
      const teamOptions = buildFacilityTeamOptionSet(
        candidates,
        availableOrdinaryFacilitySlots(facility, selectionContext)
      ).options
        .map((assignments) => reevaluateFacilityTeam(assignments, facility, state, context))
        .filter((assignments) => facilityTeamMatchesSelectionSemantics(
          assignments,
          availableOrdinaryFacilitySlots(facility, selectionContext)
        ))
        .sort(
          (a, b) =>
            facilityTeamSelectionScore(b, facility, state.preference, facilityBonus) -
              facilityTeamSelectionScore(a, facility, state.preference, facilityBonus) ||
            a.map((assignment) => assignment.operatorId).sort().join("|").localeCompare(
              b.map((assignment) => assignment.operatorId).sort().join("|")
            )
        );
      return {
        facility,
        facilityBonus,
        candidates,
        teamOptions
      };
    });
  type SearchState = {
    usedOperatorIds: Set<string>;
    plans: FacilityPlan[];
    selectionScore: number;
    stableSignatureParts: string[];
    stableSignature: string;
  };
  let searchStates: SearchState[] = [{
    usedOperatorIds: new Set(),
    plans: [],
    selectionScore: 0,
    stableSignatureParts: [],
    stableSignature: ""
  }];
  for (const candidateSet of facilityCandidates) {
    const preparedOptions = candidateSet.teamOptions.map((assignments) => {
      const operatorIds = assignments.map((assignment) => assignment.operatorId);
      const expectedEfficiency = effectiveFacilityEfficiency(assignments, candidateSet.facilityBonus);
      const selectionScore = facilityTeamSelectionScore(
        assignments,
        candidateSet.facility,
        state.preference,
        candidateSet.facilityBonus
      );
      const stableSignatureParts = assignments.map((assignment) =>
        `${candidateSet.facility.id}:${assignment.operatorId}:${assignment.skillId}`
      ).sort(compareCodePoints);
      return {
        assignments,
        operatorIds,
        selectionScore,
        stableSignatureParts,
        plan: {
          facility: candidateSet.facility,
          assignments,
          expectedEfficiency,
          score: effectiveFacilityScore(
            assignments,
            candidateSet.facility,
            state.preference,
            candidateSet.facilityBonus
          ),
          alternatives: []
        } satisfies FacilityPlan
      };
    });
    const nextStates: SearchState[] = [];
    for (const searchState of searchStates) {
      for (const option of preparedOptions) {
        if (option.operatorIds.some((operatorId) => searchState.usedOperatorIds.has(operatorId))) {
          continue;
        }
        const stableSignatureParts = [
          ...searchState.stableSignatureParts,
          ...option.stableSignatureParts
        ];
        nextStates.push({
          usedOperatorIds: new Set([...searchState.usedOperatorIds, ...option.operatorIds]),
          stableSignatureParts,
          stableSignature: stableSignatureParts.join("|"),
          selectionScore: searchState.selectionScore + option.selectionScore,
          plans: [...searchState.plans, option.plan]
        });
      }
    }
    searchStates = nextStates
      .sort((a, b) =>
        b.selectionScore - a.selectionScore || compareCodePoints(a.stableSignature, b.stableSignature)
      )
      .slice(0, 128);
  }
  const bestPlans = searchStates[0]?.plans ?? [];
  const plansByFacilityId = new Map(bestPlans.map((plan) => [plan.facility.id, plan]));
  const plans = enabledFacilities.map((facility) =>
    plansByFacilityId.get(facility.id) ?? {
      facility,
      assignments: [],
      expectedEfficiency: 0,
      score: 0,
      alternatives: []
    }
  );
  return fillVacantFacilitySlots(
    state,
    plans,
    context,
    unavailableOperatorIds,
    new Map(facilityCandidates.map(({ facility, candidates }) => [facility.id, candidates]))
  );
}

function implicitDormitoryResourceAssignments(
  state: AppState,
  contextAssignments: Assignment[],
  reservedOperatorIds: ReadonlySet<string> = new Set(),
  reservedFacilitySlots: ReadonlyMap<string, number> = new Map()
) {
  const dormitories = state.facilities.filter((facility) => facility.type === "dormitory");
  if (!dormitories.length) {
    return [];
  }

  const assignedOperatorIds = new Set(contextAssignments.map((assignment) => assignment.operatorId));
  const producers = operators
    .flatMap((operator) => {
      const rosterEntry = state.roster[operator.id];
      if (!rosterEntry?.owned || assignedOperatorIds.has(operator.id) || reservedOperatorIds.has(operator.id)) {
        return [];
      }

      const activeSkills = activeBaseSkills(operator, rosterEntry.elite, rosterEntry.level);
      const resourceSkill = activeSkills.find((skill) =>
        skill.effects.some(
          (effect) => effect.facility === "dormitory" && Boolean(effect.resourceEffects?.length)
        )
      );
      const hasWorkingFacilitySkill = activeSkills.some((skill) =>
        skill.effects.some(
          (effect) => effect.facility !== "dormitory" && !effect.ignoredForOptimization
        )
      );
      return resourceSkill && !hasWorkingFacilitySkill ? [{ operator, resourceSkill }] : [];
    })
    .sort((a, b) => a.operator.id.localeCompare(b.operator.id));

  const assignments: Assignment[] = [];
  let producerIndex = 0;
  for (const dormitory of dormitories) {
    const occupiedSlots = contextAssignments.filter(
      (assignment) => assignment.facilityId === dormitory.id && !assignment.doesNotConsumeFacilitySlot
    ).length;
    const availableSlots = Math.max(
      dormitory.slotCount - (reservedFacilitySlots.get(dormitory.id) ?? 0) - occupiedSlots,
      0
    );
    for (let slot = 0; slot < availableSlots && producerIndex < producers.length; slot += 1) {
      const producer = producers[producerIndex++];
      assignments.push({
        facilityId: dormitory.id,
        operatorId: producer.operator.id,
        skillId: producer.resourceSkill.id,
        score: 0,
        efficiency: 0,
        fatigueHours: moraleCapacity,
        recoveryHours: 0,
        reason: "Dormitory resource producer"
      });
    }
  }
  return assignments;
}

function fillVacantFacilitySlots(
  state: AppState,
  facilityPlans: FacilityPlan[],
  context: AssignmentEvaluationContext,
  excludedOperatorIds: ReadonlySet<string>,
  candidatesByFacilityId: ReadonlyMap<string, Assignment[]>
) {
  const usedOperatorIds = new Set([
    ...excludedOperatorIds,
    ...facilityPlans.flatMap((plan) => plan.assignments.map((assignment) => assignment.operatorId))
  ]);

  const filledPlansByFacilityId = new Map(
    [...facilityPlans]
      .sort((a, b) => a.facility.id.localeCompare(b.facility.id))
      .map((plan) => {
        const assignments = [...plan.assignments];
        const availableSlots = availableOrdinaryFacilitySlots(plan.facility, context);
        if (facilitySlotOccupancy(assignments) >= availableSlots) {
          return [plan.facility.id, plan] as const;
        }
        const globalStackKeys = new Set(assignments.flatMap((assignment) => assignmentGlobalStackKeys(assignment)));

        const skillAssignmentByOperatorId = new Map(
          (candidatesByFacilityId.get(plan.facility.id) ?? [])
            .filter(
              (assignment) =>
                !assignment.skilllessPrerequisiteOperatorIds?.length &&
                !assignment.baseSkilllessPrerequisiteOperatorIds?.length
            )
            .map((assignment) => [assignment.operatorId, assignment])
        );

        const fillerOperators = [...operators].sort(
          (a, b) =>
            fillerSkillScore(skillAssignmentByOperatorId.get(b.id)) - fillerSkillScore(skillAssignmentByOperatorId.get(a.id)) ||
            a.id.localeCompare(b.id)
        );

        for (const operator of fillerOperators) {
          if (facilitySlotOccupancy(assignments) >= availableSlots) {
            break;
          }
          if (!state.roster[operator.id]?.owned || usedOperatorIds.has(operator.id)) {
            continue;
          }

          const skillAssignment = skillAssignmentByOperatorId.get(operator.id);
          const assignment =
            skillAssignment &&
            !skillAssignment.suppressesOtherFactoryEfficiency &&
            !assignmentGlobalStackKeys(skillAssignment).some((stackKey) => globalStackKeys.has(stackKey))
              ? skillAssignment
              : baselineAssignment(operator, plan.facility, state.language, context.shiftHours);
          assignments.push(assignment);
          assignmentGlobalStackKeys(assignment).forEach((stackKey) => globalStackKeys.add(stackKey));
          usedOperatorIds.add(operator.id);
        }

        return [plan.facility.id, { ...plan, assignments }] as const;
      })
  );

  return facilityPlans.map((plan) => filledPlansByFacilityId.get(plan.facility.id) ?? plan);
}

function availableOrdinaryFacilitySlots(
  facility: FacilitySlot,
  context?: Pick<AssignmentEvaluationContext, "reservedFacilitySlots">
) {
  return Math.max(facility.slotCount - (context?.reservedFacilitySlots?.get(facility.id) ?? 0), 0);
}

function fillerSkillScore(assignment: Assignment | undefined) {
  return assignment?.suppressesOtherFactoryEfficiency ? 0 : assignment?.score ?? 0;
}

const facilityTeamOptionLimit = 320;
const facilityTeamConstructionLimit = 4096;
const facilityTeamPartnerLimit = 4;
const facilityTeamCacheLimit = 32;

export interface FacilityTeamOptionGenerationDiagnostic {
  optimality: "certified" | "not-certified";
  limitation?: "candidate-generation-limited";
  inputCandidateCount: number;
  constructedOptionCount: number;
  retainedOptionCount: number;
  cacheHit: boolean;
}

export interface FacilityTeamOptionGenerationResult {
  options: Assignment[][];
  diagnostic: FacilityTeamOptionGenerationDiagnostic;
}

type CachedFacilityTeamOptions = Omit<FacilityTeamOptionGenerationResult, "diagnostic"> & {
  diagnostic: Omit<FacilityTeamOptionGenerationDiagnostic, "cacheHit">;
};

const facilityTeamOptionCache = new Map<string, CachedFacilityTeamOptions>();
const operatorById = new Map(operators.map((operator) => [operator.id, operator]));

function compareCodePoints(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableValueSignature(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValueSignature).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareCodePoints(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableValueSignature(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function assignmentStableSignature(assignment: Assignment) {
  return `${assignment.operatorId}:${assignment.skillId}`;
}

function facilityTeamStableSignature(assignments: readonly Assignment[]) {
  return assignments.map(assignmentStableSignature).sort(compareCodePoints).join("|");
}

function compareFacilityCandidates(left: Assignment, right: Assignment) {
  return right.score - left.score ||
    compareCodePoints(assignmentStableSignature(left), assignmentStableSignature(right)) ||
    compareCodePoints(stableValueSignature(left), stableValueSignature(right));
}

function compareFacilityTeams(left: readonly Assignment[], right: readonly Assignment[]) {
  return right.reduce((sum, assignment) => sum + assignment.score, 0) -
      left.reduce((sum, assignment) => sum + assignment.score, 0) ||
    compareCodePoints(facilityTeamStableSignature(left), facilityTeamStableSignature(right));
}

function facilityTeamMatchesSelectionSemantics(assignments: Assignment[], slotCount: number) {
  if (!assignments.some((assignment) => assignment.suppressesOtherFactoryEfficiency)) {
    return true;
  }
  const candidates = assignments.filter((assignment) =>
    assignment.skillId !== "skillless-prerequisite" &&
    assignment.skillId !== "base-skillless-prerequisite"
  );
  const selected = selectAssignmentsForFacility(candidates.sort(compareFacilityCandidates), slotCount);
  return facilityTeamStableSignature(selected) === facilityTeamStableSignature(assignments);
}

function facilityTeamHasValidStructure(assignments: readonly Assignment[], slotCount: number) {
  if (slotCount <= 0 || facilitySlotOccupancy([...assignments]) !== slotCount) return false;
  const operatorIds = assignments.map((assignment) => assignment.operatorId);
  if (new Set(operatorIds).size !== operatorIds.length) return false;
  const operatorIdSet = new Set(operatorIds);
  if (assignments.some((assignment) =>
    [...(assignment.skilllessPrerequisiteOperatorIds ?? []), ...(assignment.baseSkilllessPrerequisiteOperatorIds ?? [])]
      .some((operatorId) => !operatorIdSet.has(operatorId))
  )) return false;
  if (assignments.some((assignment) =>
    assignment.skilllessPrerequisiteFor !== undefined && !operatorIdSet.has(assignment.skilllessPrerequisiteFor) ||
    assignment.baseSkilllessPrerequisiteFor !== undefined && !operatorIdSet.has(assignment.baseSkilllessPrerequisiteFor)
  )) return false;
  const stackKeys = assignments.flatMap(assignmentGlobalStackKeys);
  return new Set(stackKeys).size === stackKeys.length;
}

export function facilityTeamEligibleForScheduleComparison(
  rawAssignments: readonly Assignment[],
  reevaluatedAssignments: readonly Assignment[],
  slotCount: number
) {
  if (!facilityTeamHasValidStructure(rawAssignments, slotCount) ||
      !facilityTeamHasValidStructure(reevaluatedAssignments, slotCount) ||
      facilityTeamStableSignature(rawAssignments) !== facilityTeamStableSignature(reevaluatedAssignments)) {
    return false;
  }
  const suppressingAssignments = reevaluatedAssignments.filter((assignment) =>
    assignment.suppressesOtherFactoryEfficiency
  );
  if (suppressingAssignments.length <= 1) return true;
  return reevaluatedAssignments.some((assignment) =>
    !assignment.suppressesOtherFactoryEfficiency &&
    Number.isFinite(assignment.factoryEfficiencySuppressionExemptEfficiency) &&
    (assignment.factoryEfficiencySuppressionExemptEfficiency ?? 0) > 0
  );
}

function assignmentRetentionKeys(assignment: Assignment) {
  const keys: string[] = [];
  const identity = assignmentStableSignature(assignment);
  if (assignment.contextSensitive) keys.push(`context:${identity}`);
  if (assignment.suppressesOtherFactoryEfficiency) keys.push(`suppression:${identity}`);
  if (assignment.skilllessPrerequisiteOperatorIds?.length) {
    keys.push(`facility-dependency:${[...assignment.skilllessPrerequisiteOperatorIds].sort(compareCodePoints).join(",")}`);
  }
  if (assignment.baseSkilllessPrerequisiteOperatorIds?.length) {
    keys.push(`base-dependency:${[...assignment.baseSkilllessPrerequisiteOperatorIds].sort(compareCodePoints).join(",")}`);
  }
  for (const key of [...assignmentGlobalStackKeys(assignment)].sort(compareCodePoints)) {
    keys.push(`global-stack:${key}`);
  }
  for (const key of [...(assignment.scalesWithFacilityStat ?? [])].sort(compareCodePoints)) {
    keys.push(`facility-stat-consumer:${key}`);
  }
  for (const scaling of assignment.facilityStatScalings ?? []) {
    keys.push(`facility-stat-scaling:${stableValueSignature(scaling)}`);
  }
  if ((assignment.storageLimit ?? 0) > 0) keys.push("facility-stat-provider:storageLimit");
  if ((assignment.orderLimit ?? 0) > 0) keys.push("facility-stat-provider:orderLimit");
  for (const affiliation of operatorById.get(assignment.operatorId)?.affiliations ?? []) {
    keys.push(`affiliation:${affiliation}`);
  }
  return [...new Set(keys)].sort(compareCodePoints);
}

function teamRetentionKeys(team: readonly Assignment[]) {
  const keys = team.flatMap(assignmentRetentionKeys);
  const workers = team.filter(assignmentConsumesFacilitySlot);
  if (workers.length > 1) {
    const commonAffiliations = (operatorById.get(workers[0].operatorId)?.affiliations ?? []).filter(
      (affiliation) => workers.every((assignment) =>
        operatorById.get(assignment.operatorId)?.affiliations?.includes(affiliation)
      )
    );
    keys.push(...commonAffiliations.map((affiliation) => `affiliation-team:${affiliation}`));
  }
  if (workers.filter((assignment) => assignment.suppressesOtherFactoryEfficiency).length > 1) {
    keys.push("suppression-team");
  }
  const contextIdentities = workers
    .filter((assignment) => assignment.contextSensitive)
    .map((assignment) => assignment.skillId)
    .sort(compareCodePoints);
  if (contextIdentities.length > 1) {
    keys.push(`context-mechanic-team:${contextIdentities.join(",")}`);
  }
  for (const statKey of ["storageLimit", "orderLimit"] as const) {
    if (workers.some((assignment) => assignment.scalesWithFacilityStat?.includes(statKey)) &&
        workers.filter((assignment) => (assignment[statKey] ?? 0) > 0).length >= 2) {
      keys.push(`facility-stat-team:${statKey}:${workers.reduce(
        (sum, assignment) => sum + (assignment[statKey] ?? 0),
        0
      )}`);
    }
  }
  return [...new Set(keys)].sort(compareCodePoints);
}

function cacheFacilityTeamOptions(key: string, value: CachedFacilityTeamOptions) {
  const snapshot = structuredClone(value);
  if (facilityTeamOptionCache.size >= facilityTeamCacheLimit) {
    const oldest = facilityTeamOptionCache.keys().next().value;
    if (oldest !== undefined) facilityTeamOptionCache.delete(oldest);
  }
  facilityTeamOptionCache.set(key, snapshot);
  return snapshot;
}

function mutableFacilityTeamOptionResult(
  snapshot: CachedFacilityTeamOptions,
  cacheHit: boolean
): FacilityTeamOptionGenerationResult {
  const mutableSnapshot = structuredClone(snapshot);
  return {
    options: mutableSnapshot.options,
    diagnostic: { ...mutableSnapshot.diagnostic, cacheHit }
  };
}

export function buildFacilityTeamOptionSet(
  candidates: Assignment[],
  slotCount: number
): FacilityTeamOptionGenerationResult {
  const options: Assignment[][] = [];
  const optionSignatures = new Set<string>();
  const canonicalCandidates = [...candidates]
    .sort(compareFacilityCandidates)
    .filter((candidate, index, all) =>
      index === 0 || assignmentStableSignature(candidate) !== assignmentStableSignature(all[index - 1])
    );
  const eligibleCandidates = canonicalCandidates.filter((candidate) =>
    candidate.score > 0 ||
    candidate.contextSensitive ||
    candidate.suppressesOtherFactoryEfficiency ||
    Boolean(candidate.skilllessPrerequisiteOperatorIds?.length) ||
    Boolean(candidate.baseSkilllessPrerequisiteOperatorIds?.length) ||
    Boolean(candidate.facilityStatScalings?.length) ||
    (candidate.storageLimit ?? 0) > 0 ||
    (candidate.orderLimit ?? 0) > 0
  );
  const cacheKey = `${slotCount}\u0001${eligibleCandidates.map(stableValueSignature).join("\u0000")}`;
  const cached = facilityTeamOptionCache.get(cacheKey);
  if (cached) {
    return mutableFacilityTeamOptionResult(cached, true);
  }
  let constructionAttempts = 0;
  const addOption = (assignments: Assignment[]) => {
    constructionAttempts += 1;
    if (constructionAttempts > facilityTeamConstructionLimit) return;
    const signature = facilityTeamStableSignature(assignments);
    if (!optionSignatures.has(signature)) {
      optionSignatures.add(signature);
      options.push(assignments);
    }
  };
  const addDirectOption = (assignments: Assignment[]) => {
    if (facilitySlotOccupancy(assignments) > slotCount ||
        new Set(assignments.map(({ operatorId }) => operatorId)).size !== assignments.length ||
        assignments.some((assignment) =>
          assignment.skilllessPrerequisiteOperatorIds?.length ||
          assignment.baseSkilllessPrerequisiteOperatorIds?.length
        )) return;
    const stackKeys = assignments.flatMap(assignmentGlobalStackKeys);
    if (new Set(stackKeys).size !== stackKeys.length) return;
    addOption(assignments);
  };

  // The empty/minimum-conflict fallback is always present even if later families
  // consume the construction budget.
  addOption([]);

  // Canonical suffixes and exclusions expose deep teams at bounded O(roster) calls.
  for (let start = 0; start < eligibleCandidates.length; start += 1) {
    const candidatesFromStart = eligibleCandidates.slice(start);
    const selected = selectAssignmentsForFacility(candidatesFromStart, slotCount);
    addOption(selected);
    const selectedWorkers = selected.filter(assignmentConsumesFacilitySlot);
    for (const worker of selectedWorkers) {
      addOption(selectAssignmentsForFacility(
        candidatesFromStart.filter((candidate) => candidate.operatorId !== worker.operatorId),
        slotCount
      ));
    }
    for (let left = 0; left < selectedWorkers.length; left += 1) {
      for (let right = left + 1; right < selectedWorkers.length; right += 1) {
        const excluded = new Set([selectedWorkers[left].operatorId, selectedWorkers[right].operatorId]);
        addOption(selectAssignmentsForFacility(
          candidatesFromStart.filter((candidate) => !excluded.has(candidate.operatorId)),
          slotCount
        ));
      }
    }
  }

  const candidatesByAffiliation = new Map<string, Assignment[]>();
  for (const candidate of eligibleCandidates) {
    for (const affiliation of operatorById.get(candidate.operatorId)?.affiliations ?? []) {
      const affiliated = candidatesByAffiliation.get(affiliation) ?? [];
      affiliated.push(candidate);
      candidatesByAffiliation.set(affiliation, affiliated);
    }
  }
  for (const affiliated of [...candidatesByAffiliation.entries()]
    .sort(([left], [right]) => compareCodePoints(left, right))
    .map(([, assignments]) => assignments)) {
    if (affiliated.length < slotCount) continue;
    for (let start = 0; start < affiliated.length; start += 1) {
      addOption(selectAssignmentsForFacility(affiliated.slice(start), slotCount));
    }
  }

  // Force every mechanic/dependency/context candidate with a bounded set of
  // canonical partners instead of enumerating roster Cartesian triples.
  const mechanicCandidates = eligibleCandidates.filter((candidate) =>
    assignmentRetentionKeys(candidate).some((key) => !key.startsWith("affiliation:"))
  );
  const topPartners = eligibleCandidates.slice(0, facilityTeamPartnerLimit);
  for (const anchor of mechanicCandidates) {
    const withoutAnchor = eligibleCandidates.filter((candidate) => candidate.operatorId !== anchor.operatorId);
    addOption(selectAssignmentsForFacility([anchor, ...withoutAnchor], slotCount));
    for (const partner of topPartners) {
      if (partner.operatorId === anchor.operatorId) continue;
      addOption(selectAssignmentsForFacility([
        anchor,
        partner,
        ...withoutAnchor.filter((candidate) => candidate.operatorId !== partner.operatorId)
      ], slotCount));
      if (constructionAttempts >= facilityTeamConstructionLimit) break;
    }
    if (constructionAttempts >= facilityTeamConstructionLimit) break;
  }

  // A zero-score context dependency can be valuable with another context
  // mechanic even though ordinary score ranking cannot surface the pair.
  // Force only those bounded pairs, then fill remaining slots normally.
  const contextCandidates = eligibleCandidates.filter((candidate) => candidate.contextSensitive);
  for (let left = 0; left < contextCandidates.length; left += 1) {
    for (let right = left + 1; right < contextCandidates.length; right += 1) {
      const anchors = [contextCandidates[left], contextCandidates[right]];
      if (anchors.every((candidate) => candidate.score > 0)) continue;
      const anchorIds = new Set(anchors.map((candidate) => candidate.operatorId));
      addOption(selectAssignmentsForFacility([
        ...anchors,
        ...eligibleCandidates.filter((candidate) => !anchorIds.has(candidate.operatorId))
      ], slotCount));
      if (constructionAttempts >= facilityTeamConstructionLimit) break;
    }
    if (constructionAttempts >= facilityTeamConstructionLimit) break;
  }

  const suppressing = eligibleCandidates.filter((candidate) => candidate.suppressesOtherFactoryEfficiency);
  const suppressionPartners = eligibleCandidates
    .filter((candidate) => candidate.factoryEfficiencySuppressionExemptEfficiency !== undefined)
    .slice(0, facilityTeamPartnerLimit);
  for (let left = 0; left < suppressing.length; left += 1) {
    for (let right = left + 1; right < Math.min(suppressing.length, left + 1 + facilityTeamPartnerLimit); right += 1) {
      for (const partner of suppressionPartners) {
        addDirectOption([suppressing[left], suppressing[right], partner]);
        if (constructionAttempts >= facilityTeamConstructionLimit) break;
      }
      if (constructionAttempts >= facilityTeamConstructionLimit) break;
    }
    if (constructionAttempts >= facilityTeamConstructionLimit) break;
  }

  for (const statKey of ["storageLimit", "orderLimit"] as const) {
    const consumers = eligibleCandidates.filter((candidate) => candidate.scalesWithFacilityStat?.includes(statKey));
    const providersByAmount = new Map<number, Assignment[]>();
    for (const provider of eligibleCandidates.filter((candidate) => (candidate[statKey] ?? 0) > 0)) {
      const amount = provider[statKey] ?? 0;
      const representatives = [...(providersByAmount.get(amount) ?? []), provider]
        .sort(compareFacilityCandidates)
        .slice(0, 2);
      providersByAmount.set(amount, representatives);
    }
    // Two representatives per distinct amount preserve same-amount pairs while
    // avoiding Cartesian triples across every stat provider in the roster.
    const providers = [...providersByAmount.entries()]
      .sort(([left], [right]) => left - right)
      .flatMap(([, representatives]) => representatives);
    for (const consumer of consumers) {
      for (let left = 0; left < providers.length; left += 1) {
        for (let right = left + 1; right < providers.length; right += 1) {
          addDirectOption([consumer, providers[left], providers[right]]);
          if (constructionAttempts >= facilityTeamConstructionLimit) break;
        }
        if (constructionAttempts >= facilityTeamConstructionLimit) break;
      }
      if (constructionAttempts >= facilityTeamConstructionLimit) break;
    }
    if (constructionAttempts >= facilityTeamConstructionLimit) break;
  }

  const constructedOptionCount = options.length;
  const sortedOptions = options.sort(compareFacilityTeams);
  const retainedBySignature = new Map<string, Assignment[]>();
  const retain = (team: Assignment[] | undefined) => {
    if (team) retainedBySignature.set(facilityTeamStableSignature(team), team);
  };
  retain(sortedOptions.find((team) => team.length === 0));
  const seenRetentionKeys = new Set<string>();
  for (const team of sortedOptions) {
    for (const key of teamRetentionKeys(team)) {
      if (seenRetentionKeys.has(key)) continue;
      seenRetentionKeys.add(key);
      retain(team);
    }
  }
  for (const team of sortedOptions) {
    if (retainedBySignature.size >= facilityTeamOptionLimit) break;
    retain(team);
  }
  const retainedOptions = [...retainedBySignature.values()].sort(compareFacilityTeams).slice(0, facilityTeamOptionLimit);
  const heuristicOmission = slotCount > 1 && eligibleCandidates.length > slotCount;
  const limited = heuristicOmission || constructionAttempts > facilityTeamConstructionLimit ||
    constructedOptionCount > retainedOptions.length;
  const diagnostic: Omit<FacilityTeamOptionGenerationDiagnostic, "cacheHit"> = {
    optimality: limited ? "not-certified" : "certified",
    ...(limited ? { limitation: "candidate-generation-limited" as const } : {}),
    inputCandidateCount: candidates.length,
    constructedOptionCount,
    retainedOptionCount: retainedOptions.length
  };
  const result = { options: retainedOptions, diagnostic };
  const snapshot = cacheFacilityTeamOptions(cacheKey, result);
  return mutableFacilityTeamOptionResult(snapshot, false);
}

function reevaluateFacilityTeam(
  assignments: Assignment[],
  facility: FacilitySlot,
  state: AppState,
  context: AssignmentEvaluationContext
) {
  if (!assignments.length) {
    return assignments;
  }

  const tentativeContext: AssignmentEvaluationContext = {
    ...context,
    assignments: [
      ...context.assignments.filter((assignment) => assignment.facilityId !== facility.id),
      ...assignments
    ]
  };

  return assignments.map((assignment) => {
    if (
      !assignment.contextSensitive ||
      assignment.skillId === "baseline" ||
      assignment.skillId === "skillless-prerequisite" ||
      assignment.skillId === "base-skillless-prerequisite"
    ) {
      return assignment;
    }
    const operator = operatorById.get(assignment.operatorId);
    const rosterEntry = state.roster[assignment.operatorId];
    if (!operator || !rosterEntry) {
      return assignment;
    }
    const operatorContext: AssignmentEvaluationContext = {
      ...tentativeContext,
      workElapsedHours: tentativeContext.workElapsedHoursByOperator?.get(assignment.operatorId) ??
        tentativeContext.workElapsedHours
    };
    const reevaluated = bestSkillForFacility(
      operator,
      rosterEntry,
      facility,
      state.preference,
      0,
      state.language,
      operatorContext
    );
    const selected = reevaluated.find((candidate) => candidate.skillId === assignment.skillId) ?? reevaluated[0] ?? assignment;
    return {
      ...selected,
      ...(assignment.skilllessPrerequisiteOperatorIds?.length
        ? { skilllessPrerequisiteOperatorIds: assignment.skilllessPrerequisiteOperatorIds }
        : {}),
      ...(assignment.baseSkilllessPrerequisiteOperatorIds?.length
        ? { baseSkilllessPrerequisiteOperatorIds: assignment.baseSkilllessPrerequisiteOperatorIds }
        : {})
    };
  });
}

export function attachRotationAlternatives(state: AppState, facilityPlans: FacilityPlan[]): FacilityPlan[] {
  return attachRotationAlternativesWithContext(state, facilityPlans);
}

function attachRotationAlternativesWithContext(
  state: AppState,
  facilityPlans: FacilityPlan[],
  selectionContext?: AssignmentEvaluationContext
): FacilityPlan[] {
  const firstRotationOperatorIds = new Set(facilityPlans.flatMap((plan) => plan.assignments.map((assignment) => assignment.operatorId)));
  let plansWithAlternatives = buildAlternativeFacilityPlans(
    state,
    facilityPlans,
    firstRotationOperatorIds,
    [],
    selectionContext
  );

  for (let index = 0; index < 3; index += 1) {
    const previousSignature = alternativeAssignmentSignature(plansWithAlternatives);
    const contextAssignments = plansWithAlternatives.flatMap((plan) => plan.alternatives);
    const nextPlans = buildAlternativeFacilityPlans(
      state,
      facilityPlans,
      firstRotationOperatorIds,
      contextAssignments,
      selectionContext
    );
    plansWithAlternatives = nextPlans;
    if (alternativeAssignmentSignature(nextPlans) === previousSignature) {
      break;
    }
  }

  const alternativeContext: AssignmentEvaluationContext = {
    ...selectionContext,
    assignments: plansWithAlternatives.flatMap((plan) => plan.alternatives),
    facilities: state.facilities,
    roster: state.roster,
    shiftHours: optimizerShiftHours(state)
  };

  return plansWithAlternatives.map((plan) => {
    const globalBonus = calculateGlobalBonus(state, plan.facility, alternativeContext);
    const remoteEfficiencyBonus = calculateRemoteFacilityEfficiencyBonus(plan.facility, alternativeContext);
    return {
      ...plan,
      alternativeExpectedEfficiency: effectiveFacilityEfficiency(plan.alternatives, globalBonus + remoteEfficiencyBonus)
    };
  });
}

function buildAlternativeFacilityPlans(
  state: AppState,
  facilityPlans: FacilityPlan[],
  firstRotationOperatorIds: Set<string>,
  contextAssignments: Assignment[],
  selectionContext?: AssignmentEvaluationContext
) {
  const alternativePlans = buildFacilityPlans(
    state,
    facilityPlans.map((plan) => plan.facility),
    contextAssignments,
    firstRotationOperatorIds,
    selectionContext
  );
  const alternativesByFacilityId = new Map(
    alternativePlans.map((plan) => [plan.facility.id, plan.assignments])
  );
  return facilityPlans.map((plan) => ({
    ...plan,
    alternatives: alternativesByFacilityId.get(plan.facility.id) ?? []
  }));
}

function assignmentSignature(facilityPlans: FacilityPlan[]) {
  return facilityPlans
    .flatMap((plan) => plan.assignments.map((assignment) => `${assignment.facilityId}:${assignment.operatorId}:${assignment.skillId}`))
    .join("|");
}

function alternativeAssignmentSignature(facilityPlans: FacilityPlan[]) {
  return facilityPlans
    .flatMap((plan) => plan.alternatives.map((assignment) => `${assignment.facilityId}:${assignment.operatorId}:${assignment.skillId}`))
    .join("|");
}

function selectAssignmentsForFacility(candidates: Assignment[], slotCount: number) {
  const nonSuppressingAssignments = selectNonSuppressingAssignments(candidates, slotCount);
  const suppressingAssignment = candidates.find((assignment) => assignment.suppressesOtherFactoryEfficiency);
  if (!suppressingAssignment) {
    return nonSuppressingAssignments;
  }

  const nonSuppressingScore = nonSuppressingAssignments.reduce((sum, assignment) => sum + assignment.score, 0);
  return suppressingAssignment.score > nonSuppressingScore ? [suppressingAssignment] : nonSuppressingAssignments;
}

function selectNonSuppressingAssignments(candidates: Assignment[], slotCount: number) {
  const assignments: Assignment[] = [];
  const globalStackKeys = new Set<string>();

  for (const candidate of candidates) {
    if (candidate.suppressesOtherFactoryEfficiency) {
      continue;
    }
    if (assignments.some((assignment) => assignment.operatorId === candidate.operatorId)) {
      continue;
    }
    if (assignmentGlobalStackKeys(candidate).some((stackKey) => globalStackKeys.has(stackKey))) {
      continue;
    }
    if (candidate.score < 0 && limitSynergyScore(candidate, assignments) + candidate.score <= 0) {
      continue;
    }
    const prerequisiteAssignments = skilllessPrerequisiteAssignments(candidate, assignments);
    const basePrerequisiteAssignments = baseSkilllessPrerequisiteAssignments(candidate, assignments);
    if (facilitySlotOccupancy(assignments) + 1 + prerequisiteAssignments.length > slotCount) {
      continue;
    }

    assignments.push(candidate);
    assignments.push(...prerequisiteAssignments);
    assignments.push(...basePrerequisiteAssignments);
    assignmentGlobalStackKeys(candidate).forEach((stackKey) => globalStackKeys.add(stackKey));
    if (facilitySlotOccupancy(assignments) >= slotCount) {
      break;
    }
  }

  for (const candidate of candidates) {
    if (candidate.suppressesOtherFactoryEfficiency || assignments.includes(candidate)) {
      continue;
    }
    if (assignments.some((assignment) => assignment.operatorId === candidate.operatorId)) {
      continue;
    }
    if (assignmentGlobalStackKeys(candidate).some((stackKey) => globalStackKeys.has(stackKey))) {
      continue;
    }
    const prerequisiteAssignments = skilllessPrerequisiteAssignments(candidate, assignments);
    if (prerequisiteAssignments.length > 0) {
      continue;
    }
    const basePrerequisiteAssignments = baseSkilllessPrerequisiteAssignments(candidate, assignments);

    const replacement = bestLimitPartnerReplacement(candidate, assignments, slotCount);
    if (!replacement) {
      continue;
    }

    if (replacement.replaceIndex === undefined) {
      assignments.push(candidate);
    } else {
      const replacedAssignment = assignments[replacement.replaceIndex];
      assignmentGlobalStackKeys(replacedAssignment).forEach((stackKey) => globalStackKeys.delete(stackKey));
      assignments[replacement.replaceIndex] = candidate;
    }
    assignments.push(...basePrerequisiteAssignments);
    assignmentGlobalStackKeys(candidate).forEach((stackKey) => globalStackKeys.add(stackKey));
  }

  return assignments;
}

function assignmentGlobalStackKeys(assignment: Assignment | undefined) {
  if (!assignment) {
    return [];
  }
  return assignment.globalStackKeys ?? (assignment.globalStackKey ? [assignment.globalStackKey] : []);
}

function facilitySlotOccupancy(assignments: Assignment[]) {
  return assignments.filter((assignment) => assignmentConsumesFacilitySlot(assignment)).length;
}

function assignmentConsumesFacilitySlot(assignment: Assignment) {
  return !assignment.doesNotConsumeFacilitySlot;
}

function skilllessPrerequisiteAssignments(candidate: Assignment, selectedAssignments: Assignment[]) {
  return (candidate.skilllessPrerequisiteOperatorIds ?? [])
    .filter((operatorId) => !selectedAssignments.some((assignment) => assignment.operatorId === operatorId))
    .map((operatorId) => ({
      facilityId: candidate.facilityId,
      operatorId,
      skillId: "skillless-prerequisite",
      score: 0,
      efficiency: 0,
      fatigueHours: candidate.fatigueHours,
      recoveryHours: candidate.recoveryHours,
      skilllessPrerequisiteFor: candidate.operatorId,
      reason: "Skillless prerequisite"
    }));
}

function baseSkilllessPrerequisiteAssignments(candidate: Assignment, selectedAssignments: Assignment[]) {
  return (candidate.baseSkilllessPrerequisiteOperatorIds ?? [])
    .filter((operatorId) => !selectedAssignments.some((assignment) => assignment.operatorId === operatorId))
    .map((operatorId) => ({
      facilityId: "base",
      operatorId,
      skillId: "base-skillless-prerequisite",
      score: 0,
      efficiency: 0,
      fatigueHours: candidate.fatigueHours,
      recoveryHours: candidate.recoveryHours,
      baseSkilllessPrerequisiteFor: candidate.operatorId,
      doesNotConsumeFacilitySlot: true,
      reason: "Base-wide skillless prerequisite"
    }));
}

function hasPositiveLimitSynergy(candidate: Assignment, selectedAssignments: Assignment[]) {
  return selectedAssignments.some(
    (assignment) =>
      ((candidate.storageLimit ?? 0) > 0 && assignment.scalesWithFacilityStat?.includes("storageLimit")) ||
      ((candidate.orderLimit ?? 0) > 0 && assignment.scalesWithFacilityStat?.includes("orderLimit"))
  );
}

function bestLimitPartnerReplacement(
  candidate: Assignment,
  selectedAssignments: Assignment[],
  slotCount: number
): { gain: number; replaceIndex?: number } | undefined {
  if (!hasPositiveLimitSynergy(candidate, selectedAssignments)) {
    return undefined;
  }

  if (facilitySlotOccupancy(selectedAssignments) < slotCount) {
    const addedScore = limitSynergyScore(candidate, selectedAssignments) + candidate.score;
    return addedScore > 0 ? { gain: addedScore } : undefined;
  }

  return selectedAssignments
    .map((removedAssignment, replaceIndex) => {
      const remainingAssignments = selectedAssignments.filter((_, index) => index !== replaceIndex);
      return {
        consumesFacilitySlot: assignmentConsumesFacilitySlot(removedAssignment),
        locked: assignmentIsSkilllessPrerequisiteLocked(removedAssignment, selectedAssignments),
        replaceIndex,
        gain: limitSynergyScore(candidate, remainingAssignments) + candidate.score - removedAssignment.score
      };
    })
    .filter((replacement) => replacement.consumesFacilitySlot && !replacement.locked && replacement.gain > 0)
    .sort((a, b) => b.gain - a.gain)[0];
}

function assignmentIsSkilllessPrerequisiteLocked(assignment: Assignment, selectedAssignments: Assignment[]) {
  return Boolean(
    assignment.skilllessPrerequisiteFor ||
      assignment.baseSkilllessPrerequisiteFor ||
      selectedAssignments.some(
        (selectedAssignment) =>
          selectedAssignment.skilllessPrerequisiteFor === assignment.operatorId ||
          selectedAssignment.baseSkilllessPrerequisiteFor === assignment.operatorId
      )
  );
}

function limitSynergyScore(limitPartner: Assignment, selectedAssignments: Assignment[]) {
  return selectedAssignments.reduce((sum, assignment) => {
    return (
      sum +
      (assignment.facilityStatScalings ?? []).reduce((innerSum, scaling) => {
        const addedLimit = scaling.key === "storageLimit" ? limitPartner.storageLimit ?? 0 : limitPartner.orderLimit ?? 0;
        if (addedLimit <= 0) {
          return innerSum;
        }
        return innerSum + statScalingDelta(scaling, addedLimit) * scaling.efficiencyPerStep * scaling.scorePerEfficiency;
      }, 0)
    );
  }, 0);
}

function statScalingDelta(scaling: NonNullable<Assignment["facilityStatScalings"]>[number], addedLimit: number) {
  const before = statScalingStepCount(scaling.current, scaling);
  const after = statScalingStepCount(scaling.current + addedLimit, scaling);
  return Math.max(after - before, 0);
}

function statScalingStepCount(value: number, scaling: NonNullable<Assignment["facilityStatScalings"]>[number]) {
  const scaled = scaling.per ? Math.floor(value / scaling.per) : value;
  return scaling.max ? Math.min(scaled, scaling.max) : scaled;
}

function buildRotationWindows(activeAssignments: Assignment[], alternativeAssignments: Assignment[], schedule: AppState["schedule"]) {
  const populatedGroups = new Map<string, Assignment[]>();
  const canonicalGroupIds: string[] = [];
  const seenGroupIds = new Set<string>();
  const appendUnseenGroupIds = (groupIds: string[]) => {
    for (const groupId of [...groupIds].sort()) {
      if (seenGroupIds.has(groupId)) continue;
      seenGroupIds.add(groupId);
      canonicalGroupIds.push(groupId);
    }
  };
  for (const shift of schedule.shifts) appendUnseenGroupIds(shift.activeGroupIds);
  appendUnseenGroupIds(schedule.groups.map((group) => group.id));
  const [firstGroupId, secondGroupId] = canonicalGroupIds;
  const firstDuration = schedule.shifts[0]?.endHour - schedule.shifts[0]?.startHour;
  const canUseWholeBaseGroups = schedule.shifts.every((shift) =>
    shift.activeGroupIds.length === 1 && Math.abs((shift.endHour - shift.startHour) - firstDuration) <= scheduleEpsilonHours
  );
  if (canUseWholeBaseGroups && firstGroupId) populatedGroups.set(firstGroupId, activeAssignments.filter((assignment) => assignment.fatigueHours > 0));
  if (canUseWholeBaseGroups && secondGroupId) populatedGroups.set(secondGroupId, alternativeAssignments.filter((assignment) => assignment.fatigueHours > 0));

  const diagnostics: AssignmentPlan["diagnostics"] = [];
  const windows = schedule.shifts.map((shift, index) => {
    const incompleteGroupIds = shift.activeGroupIds.filter((groupId) => !populatedGroups.has(groupId));
    for (const groupId of incompleteGroupIds) {
      diagnostics.push({
        code: "schedule-group-unpopulated",
        groupId,
        shiftId: shift.id,
        message: `Schedule group ${groupId} is not populated for shift ${shift.id}`
      });
    }
    return {
      label: `${index + 1}回目ローテーション`,
      hours: shift.endHour - shift.startHour,
      shiftId: shift.id,
      startHour: shift.startHour,
      endHour: shift.endHour,
      activeGroupIds: [...shift.activeGroupIds],
      recoveryGroupIds: [...shift.recoveryGroupIds],
      incompleteGroupIds,
      assignments: shift.activeGroupIds.flatMap((groupId) => populatedGroups.get(groupId) ?? []),
      recovery: shift.recoveryGroupIds.flatMap((groupId) => populatedGroups.get(groupId) ?? [])
    };
  });
  return { windows, diagnostics };
}

export function findCandidates(
  facility: FacilitySlot,
  state: AppState,
  globalBonus = 0,
  context?: AssignmentEvaluationContext
): Assignment[] {
  const evaluationContext = {
    assignments: context?.assignments ?? [],
    facilities: context?.facilities ?? state.facilities,
    roster: context?.roster ?? state.roster,
    shiftHours: context?.shiftHours ?? optimizerShiftHours(state),
    workElapsedHours: context?.workElapsedHours,
    moraleSpentBefore: context?.moraleSpentBefore,
    fixedResourceAmounts: context?.fixedResourceAmounts,
    fixedDormitoryOccupancy: context?.fixedDormitoryOccupancy,
    excludedOrdinaryResourceOperatorIds: context?.excludedOrdinaryResourceOperatorIds
  };

  return operators
    .flatMap((operator) => {
      const rosterEntry = state.roster[operator.id];
      if (!rosterEntry?.owned || !isOperatorAvailable(operatorAvailabilitySnapshot, state.region, operator.id)) {
        return [];
      }

      return bestSkillForFacility(operator, rosterEntry, facility, state.preference, globalBonus, state.language, evaluationContext);
    })
    .sort((a, b) => b.score - a.score);
}

function baselineAssignment(
  operator: Operator,
  facility: FacilitySlot,
  language: AppState["language"],
  shiftHours = 12
): Assignment {
  return {
    facilityId: facility.id,
    operatorId: operator.id,
    skillId: "baseline",
    score: 0,
    efficiency: 0,
    fatigueHours: moraleCapacity,
    recoveryHours: shiftHours / maxDormitoryRecoveryPerHour,
    reason: baselineAssignmentReasons[language]
  };
}

function bestSkillForFacility(
  operator: Operator,
  rosterEntry: RosterEntry,
  facility: FacilitySlot,
  preference: OptimizationPreference,
  globalBonus: number,
  language: AppState["language"],
  context?: AssignmentEvaluationContext
): Assignment[] {
  const assignmentVariants: Array<{ assignment: Assignment; slot: number }> = [];
  const elite = clampEliteForOperator(operator, rosterEntry.elite);
  const remoteFacilityStatBonuses = activeRemoteFacilityStatBonuses(operator, elite, facility, context);
  const remoteFacilityEfficiencyBonuses = activeRemoteFacilityEfficiencyBonuses(operator, elite, facility, context);
  const remoteFacilityCountBonuses = activeRemoteFacilityCountBonuses(operator, elite, facility, context);
  const commonRemoteScore =
    remoteFacilityStatScore(remoteFacilityStatBonuses, operator.id, preference, context) +
    remoteFacilityEfficiencyScore(remoteFacilityEfficiencyBonuses, preference, context) +
    remoteFacilityCountScore(remoteFacilityCountBonuses, operator.id, preference, context);

  for (const skill of activeBaseSkills(operator, elite, rosterEntry.level)) {
    for (const effect of skill.effects) {
      if (effect.ignoredForOptimization) {
        continue;
      }

      if (!effectMatchesFacility(effect, facility) || !effectConditionsSatisfied(effect, operator, facility, context)) {
        continue;
      }
      if (!effectActivationPossibleDuringShift(effect, context)) {
        continue;
      }

      const productMultiplier = productWeight(facility.product, preference);
      const complexHandler = getComplexBaseSkillHandler(operator, skill);
      const handlerInput = { operator, skill, effect, elite, facility, context };
      const scalingMultiplier =
        complexHandler?.scalingMultiplier?.(handlerInput) ??
        (effect.orderState
          ? averageOrderStateCount(effect, operator, facility, context)
          : effectScalingMultiplier(effect, operator, elite, facility, context));
      const conditionalBonus = effectConditionalBonus(effect, operator, facility, context);
      const modeledEfficiency = averageEffectEfficiency(
        effect,
        context?.shiftHours ?? 12,
        context?.workElapsedHours ?? 0
      );
      const globalEffectEfficiency = (effect.baseEfficiency ?? 0) + modeledEfficiency * scalingMultiplier;
      const rawEfficiency = (effect.baseEfficiency ?? 0) + modeledEfficiency * scalingMultiplier + conditionalBonus;
      const externalGlobalEffect = isExternalGlobalEffect(effect, facility);
      const remoteFacilityEfficiencyEffect =
        facility.type === "control" && remoteFacilityEfficiencyBonusesForEffect(operator, skill, effect, elite, facility, context).length > 0;
      const remoteFacilityStatEffect =
        facility.type === "control" && remoteFacilityStatBonusesForEffect(operator, skill, effect, elite, facility, context).length > 0;
      const remoteFacilityCountEffect = facility.type === "control" && Boolean(effect.facilityCountBonuses?.length);
      const effectiveEfficiency = externalGlobalEffect || remoteFacilityEfficiencyEffect || remoteFacilityStatEffect || remoteFacilityCountEffect ? 0 : rawEfficiency;
      const globalEffectScoreMultiplier = externalGlobalEffect ? globalEffectTargetScoreMultiplier(effect, preference, context) : 0;
      if (externalGlobalEffect && globalEffectScoreMultiplier === 0) {
        continue;
      }
      const storageLimit = activeFacilityLimit(operator, elite, facility, context, "storageLimit");
      const orderLimit = effect.orderState?.reduceOrderLimitPerOtherEfficiency
        ? jayeOrderLimitModifier(effect, operator, facility, context)
        : activeFacilityLimit(operator, elite, facility, context, "orderLimit");
      const statScalingKeys = statScalingKeysForEffect(effect);
      const facilityStatScalings = facilityStatScalingsForEffect(effect, operator, elite, facility, preference, context);
      const mandatorySkilllessPrerequisiteOperatorIds = skilllessPrerequisiteOperatorIdsForConditions(effect.conditions ?? [], facility, context);
      const mandatoryBaseSkilllessPrerequisiteOperatorIds = baseSkilllessPrerequisiteOperatorIdsForConditions(effect.conditions ?? [], context);
      const optionalSkilllessConditionalBonuses = skilllessConditionalBonusesForEffect(effect, operator, facility, context);
      const pushAssignment = (
        extraConditionalBonus: number,
        extraSkilllessPrerequisiteOperatorIds: string[],
        extraBaseSkilllessPrerequisiteOperatorIds: string[]
      ) => {
        const variantRawEfficiency = rawEfficiency + extraConditionalBonus;
        const variantEffectiveEfficiency =
          externalGlobalEffect || remoteFacilityEfficiencyEffect || remoteFacilityStatEffect || remoteFacilityCountEffect ? 0 : variantRawEfficiency;
        const scoredEfficiency =
          facility.type === "trading"
            ? tradingOrderAdjustedEfficiency(variantEffectiveEfficiency, effect.tradingOrderEffects ?? [])
            : variantEffectiveEfficiency;
        const skilllessPrerequisiteOperatorIds = Array.from(
          new Set([...mandatorySkilllessPrerequisiteOperatorIds, ...extraSkilllessPrerequisiteOperatorIds])
        );
        const baseSkilllessPrerequisiteOperatorIds = Array.from(
          new Set([...mandatoryBaseSkilllessPrerequisiteOperatorIds, ...extraBaseSkilllessPrerequisiteOperatorIds])
        );
        assignmentVariants.push({
          slot: skill.slot,
          assignment: {
          facilityId: facility.id,
          operatorId: operator.id,
          skillId: skill.id,
          score:
            externalGlobalEffect
              ? globalEffectEfficiency * globalEffectScoreMultiplier
              : scoredEfficiency * productMultiplier * facilityWeight(facility),
          efficiency: variantEffectiveEfficiency,
          ...(
            effect.scaling || effect.resourceEffects?.length || effect.conditionalBonuses?.length ||
              effect.timeCurve || effect.moraleCurve ||
            effect.conditions?.length || effect.facilityCountBonuses?.length
              ? { contextSensitive: true }
              : {}
          ),
          storageLimit,
          orderLimit,
          ...(effect.tradingOrderEffects?.length ? { tradingOrderEffects: effect.tradingOrderEffects } : {}),
          ...(effect.suppressesOtherFactoryEfficiency ? { suppressesOtherFactoryEfficiency: true } : {}),
          ...(effect.factoryEfficiencySuppressionExempt
            ? { factoryEfficiencySuppressionExemptEfficiency: variantEffectiveEfficiency }
            : {}),
          ...(effect.globalEffect?.stackKey ? { globalStackKey: globalEffectStackIdentity(effect) } : {}),
          ...(skilllessPrerequisiteOperatorIds.length ? { skilllessPrerequisiteOperatorIds } : {}),
          ...(baseSkilllessPrerequisiteOperatorIds.length ? { baseSkilllessPrerequisiteOperatorIds } : {}),
          ...(statScalingKeys.length ? { scalesWithFacilityStat: statScalingKeys } : {}),
          ...(facilityStatScalings.length ? { facilityStatScalings } : {}),
          ...(effect.moraleCurve
            ? {
                moraleEfficiencyCurves: [
                  {
                    baselineEfficiency: modeledEfficiency,
                    ...effect.moraleCurve
                  }
                ]
              }
            : {}),
          fatigueHours: moraleCapacity,
          recoveryHours: (context?.shiftHours ?? 12) / maxDormitoryRecoveryPerHour,
          reason: `${localizeText(skill.name, language)}: ${localizeText(effect.description, language)}${orderStateCalculationNote(effect, language)}${tradingOrderCalculationNote(effect, language)}`
          }
        });
      };
      pushAssignment(0, [], []);
      if (optionalSkilllessConditionalBonuses.length) {
        pushAssignment(
          optionalSkilllessConditionalBonuses.reduce((sum, bonus) => sum + bonus.efficiency, 0),
          optionalSkilllessConditionalBonuses.flatMap((bonus) => bonus.operatorIds),
          optionalSkilllessConditionalBonuses.flatMap((bonus) => bonus.baseOperatorIds)
        );
      }
    }
  }

  const aggregate = (allowPrerequisites: boolean) => {
    const bestBySlot = new Map<number, Assignment>();
    for (const variant of assignmentVariants) {
      if (
        !allowPrerequisites &&
        (variant.assignment.skilllessPrerequisiteOperatorIds?.length || variant.assignment.baseSkilllessPrerequisiteOperatorIds?.length)
      ) {
        continue;
      }
      const selected = bestBySlot.get(variant.slot);
      if (!selected || variant.assignment.score > selected.score) {
        bestBySlot.set(variant.slot, variant.assignment);
      }
    }
    return aggregateOperatorAssignments(
      [...bestBySlot.values()],
      commonRemoteScore,
      remoteFacilityStatBonuses,
      remoteFacilityEfficiencyBonuses,
      remoteFacilityCountBonuses,
      productWeight(facility.product, preference) * facilityWeight(facility)
    );
  };
  const bestAssignment = aggregate(true);
  const bestAssignmentWithoutPrerequisites = aggregate(false);
  if (
    (bestAssignment?.skilllessPrerequisiteOperatorIds?.length || bestAssignment?.baseSkilllessPrerequisiteOperatorIds?.length) &&
    bestAssignmentWithoutPrerequisites &&
    bestAssignmentWithoutPrerequisites.skillId !== bestAssignment.skillId
  ) {
    return [bestAssignment, bestAssignmentWithoutPrerequisites];
  }
  return bestAssignment ? [bestAssignment] : [];
}

function applyMoraleDurations(state: AppState, facilityPlans: FacilityPlan[]) {
  const activeSourceAssignments = facilityPlans.flatMap((plan) => plan.assignments);
  const alternativeSourceAssignments = facilityPlans.flatMap((plan) => plan.alternatives);
  const createContext = (assignments: Assignment[]): AssignmentEvaluationContext => ({
    assignments,
    facilities: state.facilities,
    roster: state.roster,
    shiftHours: optimizerShiftHours(state)
  });
  const activeContext = createContext(activeSourceAssignments);
  const alternativeContext = createContext(alternativeSourceAssignments);
  const activeMoraleExchange = selectMoraleExchangeTarget(state, activeSourceAssignments, alternativeContext);
  const alternativeMoraleExchange = selectMoraleExchangeTarget(state, alternativeSourceAssignments, activeContext);
  const activeAssignments = activeSourceAssignments.map((assignment) =>
    applyMoraleDurationToAssignment(
      assignment,
      state,
      activeContext,
      alternativeContext,
      assignment.operatorId === activeMoraleExchange?.targetOperatorId,
      activeMoraleExchange?.sourceOperatorId
    )
  );
  const alternativeAssignments = alternativeSourceAssignments.map((assignment) =>
    applyMoraleDurationToAssignment(
      assignment,
      state,
      alternativeContext,
      activeContext,
      assignment.operatorId === alternativeMoraleExchange?.targetOperatorId,
      alternativeMoraleExchange?.sourceOperatorId
    )
  );
  const activeByIdentity = new Map(activeAssignments.map((assignment) => [assignmentIdentity(assignment), assignment]));
  const alternativeByIdentity = new Map(alternativeAssignments.map((assignment) => [assignmentIdentity(assignment), assignment]));
  const durationPlans = facilityPlans.map((plan) => ({
    ...plan,
    assignments: plan.assignments.map((assignment) => activeByIdentity.get(assignmentIdentity(assignment)) ?? assignment),
    alternatives: plan.alternatives.map((assignment) => alternativeByIdentity.get(assignmentIdentity(assignment)) ?? assignment)
  }));
  const finalActiveContext = createContext(durationPlans.flatMap((plan) => plan.assignments));
  const finalAlternativeContext = createContext(durationPlans.flatMap((plan) => plan.alternatives));

  return durationPlans.map((plan) => {
    const activeBonus =
      calculateGlobalBonus(state, plan.facility, finalActiveContext) +
      calculateRemoteFacilityEfficiencyBonus(plan.facility, finalActiveContext);
    const alternativeBonus =
      calculateGlobalBonus(state, plan.facility, finalAlternativeContext) +
      calculateRemoteFacilityEfficiencyBonus(plan.facility, finalAlternativeContext);
    return {
      ...plan,
      expectedEfficiency: effectiveFacilityEfficiency(plan.assignments, activeBonus),
      score: effectiveFacilityScore(plan.assignments, plan.facility, state.preference, activeBonus),
      alternativeExpectedEfficiency: effectiveFacilityEfficiency(plan.alternatives, alternativeBonus)
    };
  });
}

function assignmentIdentity(assignment: Assignment) {
  return `${assignment.facilityId}:${assignment.operatorId}:${assignment.skillId}`;
}

function selectMoraleExchangeTarget(
  state: AppState,
  recoveringAssignments: Assignment[],
  workingContext: AssignmentEvaluationContext
) {
  const workingOperatorIds = new Set(workingContext.assignments.map((assignment) => assignment.operatorId));
  const recoveringOperatorIds = new Set(recoveringAssignments.map((assignment) => assignment.operatorId));
  const exchangeSource = operators
    .filter((operator) => {
    const rosterEntry = state.roster[operator.id];
    return (
      rosterEntry?.owned &&
      !workingOperatorIds.has(operator.id) &&
      !recoveringOperatorIds.has(operator.id) &&
      operator.skills.some((skill) => skill.effects.some((effect) => Boolean(effect.moraleExchange))) &&
      activeBaseSkills(operator, rosterEntry.elite, rosterEntry.level).some((skill) =>
        skill.effects.some((effect) => effect.facility === "dormitory" && effect.moraleExchange?.target === "previous")
      )
    );
    })
    .sort((left, right) => left.id.localeCompare(right.id))[0];
  if (!exchangeSource) {
    return undefined;
  }
  const targetOperatorId = recoveringAssignments
    .filter((assignment) => !assignment.doesNotConsumeFacilitySlot && !workingOperatorIds.has(assignment.operatorId))
    .sort((a, b) => b.score - a.score || a.operatorId.localeCompare(b.operatorId))[0]?.operatorId;
  return targetOperatorId ? { targetOperatorId, sourceOperatorId: exchangeSource.id } : undefined;
}

function applyMoraleDurationToAssignment(
  assignment: Assignment,
  state: AppState,
  context: AssignmentEvaluationContext,
  recoveryWorkingContext: AssignmentEvaluationContext,
  moraleExchangeApplied = false,
  moraleExchangeSourceOperatorId?: string,
  excludedRecoveryOperatorIds?: ReadonlySet<string>,
  skipRecoveryEvaluation = false
) {
  const facility = context.facilities.find((candidate) => candidate.id === assignment.facilityId);
  if (!facility || assignment.doesNotConsumeFacilitySlot) {
    return assignment;
  }
  const workingAssignments = context.assignments.filter((candidate) =>
    context.facilities.some((candidateFacility) => candidateFacility.id === candidate.facilityId)
  );
  const controlCount = workingAssignments.filter((candidate) => {
    return context.facilities.find((candidateFacility) => candidateFacility.id === candidate.facilityId)?.type === "control";
  }).length;
  const roomCount = workingAssignments.filter((candidate) => candidate.facilityId === facility.id).length;
  const targetOperator = operatorById.get(assignment.operatorId);
  const activeImmunities = workingAssignments.flatMap((sourceAssignment) => {
    const sourceFacility = context.facilities.find((candidate) => candidate.id === sourceAssignment.facilityId);
    const sourceOperator = operatorById.get(sourceAssignment.operatorId);
    const rosterEntry = sourceOperator ? state.roster[sourceOperator.id] : undefined;
    if (!sourceFacility || !sourceOperator || !rosterEntry || sourceFacility.id !== facility.id) {
      return [];
    }
    return activeMoraleEffects(sourceOperator, rosterEntry, sourceFacility, context)
      .filter((entry) => entry.moraleEffect.type === "immunity")
      .map((entry) => ({ sourceOperatorId: sourceOperator.id, moraleEffect: entry.moraleEffect }));
  });
  const ignoresExternalConsumptionEffects = activeImmunities.some(
    ({ sourceOperatorId, moraleEffect }) =>
      sourceOperatorId === assignment.operatorId && moraleEffect.mode === "externalConsumptionEffects"
  );
  const losesSelfConsumptionReduction = activeImmunities.some(
    ({ moraleEffect }) =>
      moraleEffect.mode === "selfConsumptionReduction" &&
      moraleEffect.affiliations?.some((affiliation) => targetOperator?.affiliations?.includes(affiliation))
  );
  let consumptionPerHour =
    baseMoraleConsumptionPerHour -
    controlCount * controlCenterReductionPerOperator -
    (facility.type === "control" ? 0 : Math.max(roomCount - 1, 0) * sharedRoomReductionPerAdditionalOperator);

  for (const sourceAssignment of workingAssignments) {
    const sourceFacility = context.facilities.find((candidate) => candidate.id === sourceAssignment.facilityId);
    const sourceOperator = operatorById.get(sourceAssignment.operatorId);
    const rosterEntry = sourceOperator ? state.roster[sourceOperator.id] : undefined;
    if (!sourceFacility || !sourceOperator || !rosterEntry) {
      continue;
    }
    const sameRoom = sourceFacility.id === facility.id;
    const sourceIsTarget = sourceOperator.id === assignment.operatorId;
    for (const entry of activeMoraleEffects(sourceOperator, rosterEntry, sourceFacility, context)) {
      if (entry.moraleEffect.type === "immunity") {
        continue;
      }
      const applies =
        (entry.moraleEffect.target === "self" && sourceIsTarget) ||
        (entry.moraleEffect.target === "room" && sameRoom) ||
        (entry.moraleEffect.target === "other" && sameRoom && !sourceIsTarget) ||
        (entry.moraleEffect.target === "conditionOperators" &&
          sameRoom &&
          entry.effect.conditions?.some(
            (condition) => "operatorIds" in condition && condition.operatorIds.includes(assignment.operatorId)
          )) ||
        (entry.moraleEffect.target === "otherFacilities" && sourceFacility.type === "control" && facility.type !== "control");
      if (!applies) {
        continue;
      }
      const multiplier = effectScalingMultiplier(
        entry.effect,
        sourceOperator,
        clampEliteForOperator(sourceOperator, rosterEntry.elite),
        sourceFacility,
        context
      );
      const amount = entry.moraleEffect.amount * multiplier;
      if (
        entry.moraleEffect.type === "consumption" &&
        ((ignoresExternalConsumptionEffects && !sourceIsTarget) ||
          (losesSelfConsumptionReduction && sourceIsTarget && amount < 0))
      ) {
        continue;
      }
      consumptionPerHour += entry.moraleEffect.type === "consumption" ? amount : -amount;
    }
  }

  consumptionPerHour = Math.max(consumptionPerHour, 0);
  const shiftHours = context.shiftHours ?? 12;
  const moraleSpentBefore = Math.min(context.moraleSpentBefore ?? 0, moraleCapacity);
  const moraleSpent = Math.min(moraleSpentBefore + consumptionPerHour * shiftHours, moraleCapacity);
  const moraleAdjustedEfficiency =
    assignment.efficiency +
    (assignment.moraleEfficiencyCurves ?? []).reduce(
      (sum, curve) =>
        sum +
        averageMoraleCurveSegmentEfficiency(curve, shiftHours, consumptionPerHour, moraleSpentBefore) -
        curve.baselineEfficiency,
      0
    );
  if (skipRecoveryEvaluation) {
    return {
      ...assignment,
      efficiency: moraleAdjustedEfficiency,
      moraleConsumptionPerHour: consumptionPerHour
    };
  }
  const dormitoryRecoveryPerHour = bestDormitoryRecoveryPerHour(
    assignment.operatorId,
    state,
    recoveryWorkingContext,
    moraleCapacity - moraleSpent,
    excludedRecoveryOperatorIds
  );
  const recoveryProvenance = bestDormitoryRecoveryProvenance(
    assignment.operatorId,
    state,
    recoveryWorkingContext,
    moraleExchangeSourceOperatorId,
    excludedRecoveryOperatorIds
  );
  return {
    ...assignment,
    efficiency: moraleAdjustedEfficiency,
    moraleConsumptionPerHour: consumptionPerHour,
    dormitoryRecoveryPerHour,
    recoveryProvenance,
    shiftUptime: consumptionPerHour === 0
      ? 1
      : Math.min(Math.max(0, moraleCapacity - moraleSpentBefore) / consumptionPerHour / shiftHours, 1),
    fatigueHours: consumptionPerHour === 0 ? Number.POSITIVE_INFINITY : moraleCapacity / consumptionPerHour,
    recoveryHours: moraleExchangeApplied ? 0 : moraleSpent / dormitoryRecoveryPerHour,
    ...(moraleExchangeApplied ? {
      moraleExchangeApplied: true,
      moraleExchangeSourceOperatorId
    } : {})
  };
}

export function bestDormitoryRecoveryProvenance(
  targetOperatorId: string,
  state: AppState,
  workingContext: AssignmentEvaluationContext,
  exchangeSourceOperatorId?: string,
  excludedRecoveryOperatorIds?: ReadonlySet<string>
): NonNullable<Assignment["recoveryProvenance"]> {
  const thresholds = new Set<number>();
  for (const operator of operators) {
    const rosterEntry = state.roster[operator.id];
    if (!rosterEntry?.owned) continue;
    for (const skill of activeBaseSkills(operator, rosterEntry.elite, rosterEntry.level)) {
      for (const effect of skill.effects) {
        for (const moraleEffect of effect.moraleEffects ?? []) {
          if (moraleEffect.type !== "recovery") continue;
          if (moraleEffect.targetMoraleAtMost !== undefined) thresholds.add(moraleEffect.targetMoraleAtMost);
        }
      }
    }
  }
  const sortedThresholds = [...thresholds]
    .filter((threshold) => threshold > 0 && threshold < moraleCapacity)
    .sort((left, right) => left - right);
  const baseProfile = calculateDormitoryRecovery(
    targetOperatorId, state, workingContext, moraleCapacity, excludedRecoveryOperatorIds
  );
  const thresholdProfiles = sortedThresholds.map((moraleAtMost) => calculateDormitoryRecovery(
    targetOperatorId, state, workingContext, moraleAtMost, excludedRecoveryOperatorIds
  ));
  const sourcesByKey = new Map(baseProfile.sources.map((source) => [`${source.operatorId}:${source.allocation}`, source]));
  const conditionalModifiers = sortedThresholds
    .flatMap((moraleAtMost, index) => {
      const atThreshold = thresholdProfiles[index];
      const aboveMorale = moraleAtMost + 1e-9;
      const nextThresholdIndex = sortedThresholds.findIndex((threshold) => threshold >= aboveMorale);
      // Recovery changes only at targetMoraleAtMost boundaries; reuse that interval's profile.
      const aboveThreshold = nextThresholdIndex >= 0
        ? thresholdProfiles[nextThresholdIndex]
        : aboveMorale <= moraleCapacity ? baseProfile : calculateDormitoryRecovery(
          targetOperatorId, state, workingContext, aboveMorale, excludedRecoveryOperatorIds
        );
      const additionalRatePerHour = atThreshold.ratePerHour - aboveThreshold.ratePerHour;
      if (additionalRatePerHour <= 1e-12) return [];
      const aboveAmounts = new Map(aboveThreshold.components.map((component) => [component.key, component.amount]));
      const modifierSourceIds = atThreshold.components
        .filter((component) => component.amount - (aboveAmounts.get(component.key) ?? 0) > 1e-12)
        .map((component) => component.operatorId)
        .filter((operatorId, index, all) => all.indexOf(operatorId) === index)
        .sort();
      return [{ moraleAtMost, additionalRatePerHour, sourceOperatorIds: Object.freeze(modifierSourceIds) }];
    });
  const phases = [
    {
      moraleAbove: sortedThresholds.at(-1) ?? 0,
      moraleAtMost: moraleCapacity,
      recoveryRatePerHour: baseProfile.ratePerHour,
      sources: Object.freeze([...baseProfile.sources])
    },
    ...sortedThresholds.map((moraleAtMost, index) => {
      const profile = thresholdProfiles[index];
      return {
        moraleAbove: sortedThresholds[index - 1] ?? 0,
        moraleAtMost,
        recoveryRatePerHour: profile.ratePerHour,
        sources: Object.freeze([...profile.sources])
      };
    }).reverse()
  ];
  if (exchangeSourceOperatorId) sourcesByKey.set(`${exchangeSourceOperatorId}:exchange`, Object.freeze({
    operatorId: exchangeSourceOperatorId,
    role: "recovery-source" as const,
    allocation: "exchange" as const,
    occupiesDormitorySlot: true,
    ownedAtEvaluation: Boolean(state.roster[exchangeSourceOperatorId]?.owned)
  }));
  const sources = [...sourcesByKey.values()].sort((left, right) =>
    left.operatorId.localeCompare(right.operatorId) || left.allocation.localeCompare(right.allocation)
  );
  return Object.freeze({
    baseRecoveryRatePerHour: baseProfile.ratePerHour,
    conditionalModifiers: Object.freeze(conditionalModifiers.map((modifier) => Object.freeze(modifier))),
    sources: Object.freeze(sources),
    phases: Object.freeze(phases.map((phase) => Object.freeze(phase)))
  });
}

type RecoveryAllocation = NonNullable<Assignment["recoveryProvenance"]>["sources"][number]["allocation"];
type RecoverySource = NonNullable<Assignment["recoveryProvenance"]>["sources"][number];

interface RecoveryComponent {
  key: string;
  operatorId: string;
  amount: number;
  allocation: RecoveryAllocation;
  requiredHelperIds: string[];
}

interface DormitoryRecoveryCalculation {
  ratePerHour: number;
  components: RecoveryComponent[];
  sources: RecoverySource[];
}

function chooseStrongestRecovery(components: RecoveryComponent[]): RecoveryComponent | undefined {
  return components
    .filter((component) => component.amount > 1e-12)
    .sort((left, right) => right.amount - left.amount || left.operatorId.localeCompare(right.operatorId) || left.key.localeCompare(right.key))[0];
}

function calculateDormitoryRecovery(
  targetOperatorId: string,
  state: AppState,
  workingContext: AssignmentEvaluationContext,
  targetMorale: number,
  excludedRecoveryOperatorIds?: ReadonlySet<string>
): DormitoryRecoveryCalculation {
  const workingOperatorIds = new Set(workingContext.assignments.map((assignment) => assignment.operatorId));
  const dormitory =
    state.facilities.find((facility) => facility.type === "dormitory") ??
    ({ id: "dormitory-recovery", type: "dormitory", name: "Dormitory", slotCount: 5, product: "morale" } satisfies FacilitySlot);
  const targetOperator = operatorById.get(targetOperatorId);
  const targetRosterEntry = targetOperator ? state.roster[targetOperatorId] : undefined;
  if (!targetOperator || !targetRosterEntry) return { ratePerHour: maxDormitoryRecoveryPerHour, components: [], sources: [] };

  const selfCandidates: RecoveryComponent[] = [];
  const roomCandidates: RecoveryComponent[] = [];
  const singleCandidates: RecoveryComponent[] = [];
  for (const operator of operators) {
    const rosterEntry = state.roster[operator.id];
    if (!rosterEntry?.owned ||
        (excludedRecoveryOperatorIds?.has(operator.id) && operator.id !== targetOperatorId) ||
        (workingOperatorIds.has(operator.id) && operator.id !== targetOperatorId)) continue;
    const activeEffects = activeBaseSkills(operator, rosterEntry.elite, rosterEntry.level)
      .flatMap((skill) => skill.effects);
    if (!activeEffects.some((effect) => effect.facility === dormitory.type &&
        effect.moraleEffects?.some((moraleEffect) => moraleEffect.type === "recovery"))) continue;
    const requiredIds = activeEffects
      .flatMap((effect) => effect.moraleEffects ?? [])
      .flatMap((moraleEffect) => moraleEffect.requiresDormitoryOperatorIds ?? [])
      .filter((operatorId, index, all) => all.indexOf(operatorId) === index)
      .sort();
    const requiredAssignments = requiredIds.flatMap((operatorId) => {
      if (!state.roster[operatorId]?.owned || workingOperatorIds.has(operatorId) || operatorId === operator.id || operatorId === targetOperatorId) return [];
      return [{
        facilityId: dormitory.id,
        operatorId,
        skillId: "dormitory-required",
        score: 0,
        efficiency: 0,
        fatigueHours: 0,
        recoveryHours: 0,
        reason: "Dormitory required operator"
      } satisfies Assignment];
    });
    const dormContext: AssignmentEvaluationContext = {
      ...workingContext,
      assignments: [
        ...workingContext.assignments,
        {
          facilityId: dormitory.id, operatorId: operator.id, skillId: "dormitory-manager", score: 0,
          efficiency: 0, fatigueHours: 0, recoveryHours: 0, reason: "Dormitory manager"
        },
        ...(operator.id === targetOperatorId ? [] : [{
          facilityId: dormitory.id, operatorId: targetOperatorId, skillId: "dormitory-target", score: 0,
          efficiency: 0, fatigueHours: 0, recoveryHours: 0, reason: "Dormitory target"
        } satisfies Assignment]),
        ...requiredAssignments
      ],
      facilities: state.facilities.some((facility) => facility.id === dormitory.id) ? state.facilities : [...state.facilities, dormitory]
    };
    const matches = activeMoraleEffects(operator, rosterEntry, dormitory, dormContext).flatMap((entry, index) => {
      const amount = entry.moraleEffect.amount * effectScalingMultiplier(
        entry.effect, operator, clampEliteForOperator(operator, rosterEntry.elite), dormitory, dormContext
      );
      if (entry.moraleEffect.type !== "recovery" ||
          !recoveryEffectMatchesTarget(entry.moraleEffect, targetOperator, targetMorale, dormitory.id, dormContext)) return [];
      return [{ entry, amount, index }];
    });
    const helpersFor = (entries: typeof matches) => entries
      .flatMap(({ entry }) => entry.moraleEffect.requiresDormitoryOperatorIds ?? [])
      .filter((operatorId) => requiredAssignments.some((assignment) => assignment.operatorId === operatorId))
      .filter((operatorId, index, all) => all.indexOf(operatorId) === index)
      .sort();
    const selfEntries = matches.filter(({ entry }) => operator.id === targetOperatorId && entry.moraleEffect.target === "self");
    const self = selfEntries.sort((left, right) => right.amount - left.amount || left.index - right.index)[0];
    if (self && self.amount > 1e-12) selfCandidates.push({
      key: `self:${operator.id}`, operatorId: operator.id, amount: self.amount,
      allocation: "self-no-slot", requiredHelperIds: helpersFor([self])
    });
    const roomEntries = matches.filter(({ entry }) => entry.moraleEffect.target === "room");
    const roomBase = roomEntries.filter(({ entry }) => !entry.moraleEffect.stacksWithBase)
      .sort((left, right) => right.amount - left.amount || left.index - right.index)[0];
    const roomBonuses = roomEntries.filter(({ entry }) => entry.moraleEffect.stacksWithBase);
    const roomAmount = (roomBase?.amount ?? 0) + roomBonuses.reduce((sum, item) => sum + item.amount, 0);
    if (roomAmount > 1e-12) roomCandidates.push({
      key: `room:${operator.id}`, operatorId: operator.id, amount: roomAmount,
      allocation: "room-shareable", requiredHelperIds: helpersFor([...(roomBase ? [roomBase] : []), ...roomBonuses])
    });
    const singleEntries = matches.filter(({ entry }) =>
      operator.id !== targetOperatorId && (entry.moraleEffect.target === "other" || entry.moraleEffect.target === "singleOther")
    );
    const singleBase = singleEntries.filter(({ entry }) => !entry.moraleEffect.stacksWithBase)
      .sort((left, right) => right.amount - left.amount || left.index - right.index)[0];
    const singleBonuses = singleEntries.filter(({ entry }) => entry.moraleEffect.stacksWithBase);
    const singleAmount = (singleBase?.amount ?? 0) + singleBonuses.reduce((sum, item) => sum + item.amount, 0);
    if (singleAmount > 1e-12) singleCandidates.push({
      key: `single:${operator.id}`, operatorId: operator.id, amount: singleAmount,
      allocation: "single-other-exclusive", requiredHelperIds: helpersFor([...(singleBase ? [singleBase] : []), ...singleBonuses])
    });
  }

  const selected = [chooseStrongestRecovery(selfCandidates), chooseStrongestRecovery(roomCandidates), chooseStrongestRecovery(singleCandidates)]
    .filter((component): component is RecoveryComponent => Boolean(component));
  const crossCandidates: RecoveryComponent[] = [];
  for (const sourceAssignment of workingContext.assignments) {
    const sourceFacility = state.facilities.find((facility) => facility.id === sourceAssignment.facilityId);
    const sourceOperator = operatorById.get(sourceAssignment.operatorId);
    const rosterEntry = sourceOperator ? state.roster[sourceOperator.id] : undefined;
    if (!sourceFacility || !sourceOperator || !rosterEntry) continue;
    for (const entry of activeMoraleEffects(sourceOperator, rosterEntry, sourceFacility, workingContext)) {
      if (entry.moraleEffect.type === "recovery" && entry.moraleEffect.target === "dormitories") crossCandidates.push({
        key: `cross:${sourceOperator.id}`, operatorId: sourceOperator.id, amount: entry.moraleEffect.amount,
        allocation: "cross-dormitory-working", requiredHelperIds: []
      });
    }
  }
  const cross = chooseStrongestRecovery(crossCandidates);
  if (cross) selected.push(cross);

  const sourcesByKey = new Map<string, RecoverySource>();
  for (const component of selected) {
    const occupiesDormitorySlot = component.allocation !== "self-no-slot" && component.allocation !== "cross-dormitory-working" &&
      component.operatorId !== targetOperatorId && !workingOperatorIds.has(component.operatorId);
    sourcesByKey.set(`${component.operatorId}:${component.allocation}`, Object.freeze({
      operatorId: component.operatorId,
      role: "recovery-source" as const,
      allocation: component.allocation,
      occupiesDormitorySlot,
      ownedAtEvaluation: Boolean(state.roster[component.operatorId]?.owned)
    }));
    for (const helperId of component.requiredHelperIds) sourcesByKey.set(`${helperId}:required-helper`, Object.freeze({
      operatorId: helperId,
      role: "required-helper" as const,
      allocation: "required-helper" as const,
      occupiesDormitorySlot: true,
      ownedAtEvaluation: Boolean(state.roster[helperId]?.owned)
    }));
  }
  return {
    ratePerHour: maxDormitoryRecoveryPerHour + selected.reduce((sum, component) => sum + component.amount, 0),
    components: selected,
    sources: [...sourcesByKey.values()].sort((left, right) =>
      left.operatorId.localeCompare(right.operatorId) || left.allocation.localeCompare(right.allocation)
    )
  };
}

export function bestDormitoryRecoveryPerHour(
  targetOperatorId: string,
  state: AppState,
  workingContext: AssignmentEvaluationContext,
  targetMorale = 0,
  excludedRecoveryOperatorIds?: ReadonlySet<string>
) {
  return calculateDormitoryRecovery(
    targetOperatorId, state, workingContext, targetMorale, excludedRecoveryOperatorIds
  ).ratePerHour;
}

function recoveryEffectMatchesTarget(
  moraleEffect: NonNullable<BaseSkillEffect["moraleEffects"]>[number],
  targetOperator: Operator | undefined,
  targetMorale: number,
  dormitoryId: string,
  context: AssignmentEvaluationContext
) {
  if (moraleEffect.targetOperatorIds?.length && (!targetOperator || !moraleEffect.targetOperatorIds.includes(targetOperator.id))) {
    return false;
  }
  if (
    moraleEffect.targetAffiliations?.length &&
    !targetOperator?.affiliations?.some((affiliation) => moraleEffect.targetAffiliations?.includes(affiliation))
  ) {
    return false;
  }
  if (moraleEffect.targetMoraleAtMost !== undefined && targetMorale > moraleEffect.targetMoraleAtMost) {
    return false;
  }
  if (
    moraleEffect.requiresDormitoryOperatorIds?.some(
      (operatorId) =>
        !context.assignments.some(
          (assignment) => assignment.facilityId === dormitoryId && assignment.operatorId === operatorId
        )
    )
  ) {
    return false;
  }
  return true;
}

function activeMoraleEffects(
  operator: Operator,
  rosterEntry: RosterEntry,
  facility: FacilitySlot,
  context: AssignmentEvaluationContext
) {
  if (!operator.skills.some((skill) => skill.effects.some((effect) =>
    effect.facility === facility.type && effect.moraleEffects?.length
  ))) return [];
  const elite = clampEliteForOperator(operator, rosterEntry.elite);
  const seen = new Set<string>();
  return activeBaseSkills(operator, elite, rosterEntry.level).flatMap((skill) =>
    skill.effects.flatMap((effect) => {
      if (!effect.moraleEffects?.length || effect.facility !== facility.type ||
          !effectConditionsSatisfied(effect, operator, facility, context)) {
        return [];
      }
      return (effect.moraleEffects ?? []).flatMap((moraleEffect) => {
        const key = `${skill.id}:${moraleEffect.type}:${moraleEffect.target}:${moraleEffect.amount}`;
        if (seen.has(key)) {
          return [];
        }
        seen.add(key);
        return [{ effect, moraleEffect }];
      });
    })
  );
}

function aggregateOperatorAssignments(
  assignments: Assignment[],
  commonRemoteScore: number,
  remoteFacilityStatBonuses: NonNullable<Assignment["remoteFacilityStatBonuses"]>,
  remoteFacilityEfficiencyBonuses: NonNullable<Assignment["remoteFacilityEfficiencyBonuses"]>,
  remoteFacilityCountBonuses: NonNullable<Assignment["remoteFacilityCountBonuses"]>,
  localScoreMultiplier: number
): Assignment | undefined {
  if (!assignments.length) {
    return undefined;
  }
  const first = assignments[0];
  const globalStackKeys = Array.from(new Set(assignments.flatMap((assignment) => assignmentGlobalStackKeys(assignment))));
  const skilllessPrerequisiteOperatorIds = Array.from(
    new Set(assignments.flatMap((assignment) => assignment.skilllessPrerequisiteOperatorIds ?? []))
  );
  const baseSkilllessPrerequisiteOperatorIds = Array.from(
    new Set(assignments.flatMap((assignment) => assignment.baseSkilllessPrerequisiteOperatorIds ?? []))
  );
  const scalesWithFacilityStat = Array.from(
    new Set(assignments.flatMap((assignment) => assignment.scalesWithFacilityStat ?? []))
  );
  const aggregateEfficiency = assignments.reduce((sum, assignment) => sum + assignment.efficiency, 0);
  const tradingOrderEffects = assignments.flatMap((assignment) => assignment.tradingOrderEffects ?? []);
  const isolatedTradingScore = assignments.reduce(
    (sum, assignment) =>
      sum + tradingOrderAdjustedEfficiency(assignment.efficiency, assignment.tradingOrderEffects ?? []) * localScoreMultiplier,
    0
  );
  const aggregateTradingScore = tradingOrderAdjustedEfficiency(aggregateEfficiency, tradingOrderEffects) * localScoreMultiplier;

  return {
    ...first,
    skillId: assignments.map((assignment) => assignment.skillId).join("+"),
    score:
      assignments.reduce((sum, assignment) => sum + assignment.score, commonRemoteScore) +
      aggregateTradingScore -
      isolatedTradingScore,
    efficiency: aggregateEfficiency,
    contextSensitive: assignments.some((assignment) => assignment.contextSensitive) || undefined,
    storageLimit: aggregateFacilityLimit(assignments, "storageLimit"),
    orderLimit: aggregateFacilityLimit(assignments, "orderLimit"),
    tradingOrderEffects,
    suppressesOtherFactoryEfficiency: assignments.some((assignment) => assignment.suppressesOtherFactoryEfficiency) || undefined,
    factoryEfficiencySuppressionExemptEfficiency:
      assignments.reduce(
        (sum, assignment) => sum + (assignment.factoryEfficiencySuppressionExemptEfficiency ?? 0),
        0
      ) || undefined,
    globalStackKey: globalStackKeys[0],
    globalStackKeys: globalStackKeys.length ? globalStackKeys : undefined,
    skilllessPrerequisiteOperatorIds: skilllessPrerequisiteOperatorIds.length ? skilllessPrerequisiteOperatorIds : undefined,
    baseSkilllessPrerequisiteOperatorIds: baseSkilllessPrerequisiteOperatorIds.length ? baseSkilllessPrerequisiteOperatorIds : undefined,
    scalesWithFacilityStat: scalesWithFacilityStat.length ? scalesWithFacilityStat : undefined,
    facilityStatScalings: assignments.flatMap((assignment) => assignment.facilityStatScalings ?? []),
    moraleEfficiencyCurves: assignments.flatMap((assignment) => assignment.moraleEfficiencyCurves ?? []),
    remoteFacilityStatBonuses: remoteFacilityStatBonuses.length ? remoteFacilityStatBonuses : undefined,
    remoteFacilityEfficiencyBonuses: remoteFacilityEfficiencyBonuses.length ? remoteFacilityEfficiencyBonuses : undefined,
    remoteFacilityCountBonuses: remoteFacilityCountBonuses.length ? remoteFacilityCountBonuses : undefined,
    reason: assignments.map((assignment) => assignment.reason).join(" / ")
  };
}

function activeFacilityLimit(
  operator: Operator,
  elite: number,
  facility: FacilitySlot,
  context: AssignmentEvaluationContext | undefined,
  key: "storageLimit" | "orderLimit"
): number | undefined {
  const activeLimits = activeBaseSkills(operator, elite, context?.roster?.[operator.id]?.level ?? 1)
    .flatMap((skill) => skill.effects)
    .filter((effect) => !effect.ignoredForOptimization)
    .filter(
      (effect) =>
        effectMatchesFacility(effect, facility) &&
        effectConditionsSatisfied(effect, operator, facility, context) &&
        effectActivationPossibleDuringShift(effect, context)
    )
    .map((effect) => {
      const value = effect[key];
      return value !== undefined && effect.scaling?.type === "skillFamily"
        ? value * effectScalingMultiplier(effect, operator, elite, facility, context)
        : value;
    })
    .filter((value): value is number => typeof value === "number");

  if (!activeLimits.length) {
    return undefined;
  }

  return netActiveFacilityLimit(activeLimits);
}

function netActiveFacilityLimit(activeLimits: number[]) {
  const positiveLimit = activeLimits
    .filter((value) => value > 0)
    .reduce((selected, value) => Math.max(selected, value), 0);
  const negativeLimit = activeLimits
    .filter((value) => value < 0)
    .reduce((selected, value) => Math.min(selected, value), 0);
  return positiveLimit + negativeLimit;
}

function aggregateFacilityLimit(assignments: Assignment[], key: "storageLimit" | "orderLimit") {
  const limits = assignments.map((assignment) => assignment[key]).filter((value): value is number => value !== undefined);
  return limits.length ? netActiveFacilityLimit(limits) : undefined;
}

function effectActivationPossibleDuringShift(
  effect: BaseSkillEffect,
  context: AssignmentEvaluationContext | undefined
) {
  if (!effect.activation) {
    return true;
  }
  if (effect.activation.type === "moraleSpent") {
    return (context?.shiftHours ?? 12) > effect.activation.threshold;
  }
  return true;
}

function activeRemoteFacilityStatBonuses(
  operator: Operator,
  elite: number,
  facility: FacilitySlot,
  context: AssignmentEvaluationContext | undefined
) {
  const bonuses = activeBaseSkills(operator, elite, context?.roster?.[operator.id]?.level ?? 1)
    .flatMap((skill) => skill.effects.map((effect) => ({ skill, effect })))
    .filter(({ effect }) => !effect.ignoredForOptimization)
    .filter(({ effect }) => effectMatchesFacility(effect, facility) && effectConditionsSatisfied(effect, operator, facility, context))
    .flatMap(({ skill, effect }) => remoteFacilityStatBonusesForEffect(operator, skill, effect, elite, facility, context));

  return strongestRemoteFacilityStatBonuses(bonuses);
}

function strongestRemoteFacilityStatBonuses(
  bonuses: NonNullable<Assignment["remoteFacilityStatBonuses"]>
): NonNullable<Assignment["remoteFacilityStatBonuses"]> {
  const selectedBonuses = new Map<string, NonNullable<Assignment["remoteFacilityStatBonuses"]>[number]>();
  for (const bonus of bonuses) {
    const key = remoteFacilityStatBonusIdentity(bonus);
    const selected = selectedBonuses.get(key);
    if (!selected || Math.abs(bonus.amount) > Math.abs(selected.amount)) {
      selectedBonuses.set(key, bonus);
    }
  }
  return [...selectedBonuses.values()];
}

function remoteFacilityStatBonusIdentity(bonus: NonNullable<Assignment["remoteFacilityStatBonuses"]>[number]) {
  return [
    bonus.key,
    bonus.facility,
    bonus.min ?? "",
    [...(bonus.affiliations ?? [])].sort().join(","),
    [...(bonus.operatorIds ?? [])].sort().join(",")
  ].join("|");
}

function activeRemoteFacilityEfficiencyBonuses(
  operator: Operator,
  elite: number,
  facility: FacilitySlot,
  context: AssignmentEvaluationContext | undefined
) {
  return activeBaseSkills(operator, elite, context?.roster?.[operator.id]?.level ?? 1)
    .flatMap((skill) => skill.effects.map((effect) => ({ skill, effect })))
    .filter(({ effect }) => !effect.ignoredForOptimization)
    .filter(({ effect }) => effectMatchesFacility(effect, facility))
    .filter(({ effect }) => effectConditionsSatisfied(effect, operator, facility, context) ||
      (effect.conditions ?? []).every((condition) =>
        conditionsSatisfied([condition], operator, facility, context) ||
        (condition.type === "facilityAffiliation" && condition.facility !== facility.type)
      ))
    .flatMap(({ skill, effect }) => remoteFacilityEfficiencyBonusesForEffect(operator, skill, effect, elite, facility, context));
}

function activeRemoteFacilityCountBonuses(
  operator: Operator,
  elite: number,
  facility: FacilitySlot,
  context: AssignmentEvaluationContext | undefined
) {
  return activeBaseSkills(operator, elite, context?.roster?.[operator.id]?.level ?? 1)
    .flatMap((skill) => skill.effects)
    .filter((effect) => !effect.ignoredForOptimization)
    .filter((effect) => effectMatchesFacility(effect, facility) && effectConditionsSatisfied(effect, operator, facility, context))
    .flatMap((effect) => effect.facilityCountBonuses ?? []);
}

export function effectiveFacilityEfficiency(assignments: Assignment[], globalBonus = 0) {
  const suppressingAssignments = assignments.filter((assignment) => assignment.suppressesOtherFactoryEfficiency);
  const countedAssignments = suppressingAssignments.length
    ? assignments.filter(
        (assignment) =>
          assignment.suppressesOtherFactoryEfficiency ||
          (assignment.factoryEfficiencySuppressionExemptEfficiency ?? 0) > 0
      )
    : assignments;
  const baseEfficiency = countedAssignments.reduce((sum, assignment) => {
    const teamScalingAdjustment = (assignment.facilityStatScalings ?? []).reduce((scalingSum, scaling) => {
      const otherLimit = countedAssignments
        .filter((other) => other !== assignment)
        .reduce(
          (limitSum, other) =>
            limitSum +
            Math.max(scaling.key === "storageLimit" ? other.storageLimit ?? 0 : other.orderLimit ?? 0, 0) *
              (other.shiftUptime ?? 1),
          0
        );
      const desiredSteps = statScalingStepCount(scaling.base + otherLimit, scaling);
      const currentSteps = statScalingStepCount(scaling.current, scaling);
      return scalingSum + (desiredSteps - currentSteps) * scaling.efficiencyPerStep;
    }, 0);
    const retainedEfficiency = suppressingAssignments.length
      ? assignment.suppressesOtherFactoryEfficiency
        ? assignment.efficiency + teamScalingAdjustment
        : assignment.factoryEfficiencySuppressionExemptEfficiency ?? 0
      : assignment.efficiency + teamScalingAdjustment;
    return sum + retainedEfficiency * (assignment.shiftUptime ?? 1);
  }, globalBonus);
  return tradingOrderAdjustedEfficiency(
    baseEfficiency,
    countedAssignments.flatMap((assignment) => assignment.tradingOrderEffects ?? [])
  );
}

function effectiveFacilityScore(assignments: Assignment[], facility: FacilitySlot, preference: OptimizationPreference, globalBonus = 0) {
  return effectiveFacilityEfficiency(assignments, globalBonus) * productWeight(facility.product, preference) * facilityWeight(facility);
}

const normalGoldOrderDistribution = [
  { gold: 2, hours: 2.4, probability: 0.3 },
  { gold: 3, hours: 3.5, probability: 0.5 },
  { gold: 4, hours: 4.6, probability: 0.2 }
] as const;

const highValueOrderDistributions = {
  slight: [0.15, 0.3, 0.55],
  doubleSlight: [0.13, 0.22, 0.65],
  increased: [0.05, 0.1, 0.85]
} as const;

export function tradingOrderAdjustedEfficiency(
  orderAcquisitionEfficiency: number,
  effects: NonNullable<BaseSkillEffect["tradingOrderEffects"]>,
  shiftHours = 12
) {
  if (!effects.length) {
    return orderAcquisitionEfficiency;
  }

  const specialOrder = effects.find((effect) => effect.type === "fixedSpecialOrder");
  if (specialOrder?.type === "fixedSpecialOrder") {
    const baselineLmdPerHour = expectedLmdPerHour(normalGoldOrderDistribution);
    const specialLmdPerHour = specialOrder.lmd / specialOrder.hours;
    const speedMultiplier = specialOrder.affectedByEfficiency ? 1 + orderAcquisitionEfficiency : 1;
    return (specialLmdPerHour * speedMultiplier) / baselineLmdPerHour - 1;
  }

  const probabilityEffects = effects.filter((effect) => effect.type === "highValueOrderProbability");
  const distribution = averageHighValueOrderDistribution(probabilityEffects, shiftHours);

  const hasDefaultedOrderRule = effects.some((effect) => effect.type === "defaultedOrderRule");
  const defaultedOrderExtraGold = effects
    .filter((effect) => effect.type === "defaultedOrderExtraGold")
    .reduce((maximum, effect) => Math.max(maximum, effect.amount), 0);
  const highValueOrderExtraLmd = effects
    .filter((effect) => effect.type === "highValueOrderExtraLmd")
    .reduce((maximum, effect) => Math.max(maximum, effect.amount), 0);
  const sourceDistribution = distribution ?? normalGoldOrderDistribution.map((order) => order.probability);
  const expectedGoldEquivalent = normalGoldOrderDistribution.reduce((sum, order, index) => {
    const breachBonus = hasDefaultedOrderRule && order.gold < 4 ? defaultedOrderExtraGold : 0;
    const highValueBonus = order.gold === 4 ? highValueOrderExtraLmd / 500 : 0;
    return sum + (order.gold + breachBonus + highValueBonus) * sourceDistribution[index];
  }, 0);
  const expectedHours = normalGoldOrderDistribution.reduce(
    (sum, order, index) => sum + order.hours * sourceDistribution[index],
    0
  );
  const baselineGoldPerHour =
    normalGoldOrderDistribution.reduce((sum, order) => sum + order.gold * order.probability, 0) /
    normalGoldOrderDistribution.reduce((sum, order) => sum + order.hours * order.probability, 0);
  const orderValueMultiplier = distribution
    ? expectedGoldEquivalent / expectedHours / baselineGoldPerHour
    : expectedGoldEquivalent /
      normalGoldOrderDistribution.reduce((sum, order) => sum + order.gold * order.probability, 0);
  return (1 + orderAcquisitionEfficiency) * orderValueMultiplier - 1;
}

function expectedLmdPerHour(distribution: ReadonlyArray<{ gold: number; hours: number; probability: number }>) {
  const lmd = distribution.reduce((sum, order) => sum + order.gold * 500 * order.probability, 0);
  const hours = distribution.reduce((sum, order) => sum + order.hours * order.probability, 0);
  return lmd / hours;
}

function averageHighValueOrderDistribution(
  effects: Array<Extract<NonNullable<BaseSkillEffect["tradingOrderEffects"]>[number], { type: "highValueOrderProbability" }>>,
  shiftHours: number
) {
  if (!effects.length) {
    return undefined;
  }
  const increased = effects.find((effect) => effect.level === "increased");
  const slightCount = effects.filter((effect) => effect.level === "slight").length;
  const selectedTarget = increased
    ? highValueOrderDistributions.increased
    : slightCount >= 2
      ? highValueOrderDistributions.doubleSlight
      : highValueOrderDistributions.slight;
  const warmupHours = increased?.warmupHours ?? Math.max(...effects.map((effect) => effect.warmupHours));
  const normalizedShift = Math.max(shiftHours, 0);
  const averageProgress =
    normalizedShift === 0
      ? 0
      : normalizedShift >= warmupHours
        ? 1 - warmupHours / (2 * normalizedShift)
        : normalizedShift / (2 * warmupHours);
  return normalGoldOrderDistribution.map(
    (order, index) => order.probability + (selectedTarget[index] - order.probability) * averageProgress
  );
}

function facilityTeamSelectionScore(
  assignments: Assignment[],
  facility: FacilitySlot,
  preference: OptimizationPreference,
  globalBonus = 0
) {
  if (facility.type === "factory" || facility.type === "trading" || facility.type === "power") {
    return effectiveFacilityScore(assignments, facility, preference, globalBonus);
  }
  return assignments.reduce((sum, assignment) => sum + assignment.score, 0);
}

function effectScalingMultiplier(
  effect: BaseSkillEffect,
  operator: Operator,
  elite: number,
  facility: FacilitySlot,
  context?: AssignmentEvaluationContext
): number {
  if (!effect.scaling) {
    return 1;
  }

  if (effect.scaling.type === "fixed") {
    return effect.scaling.count ?? 0;
  }

  if (effect.scaling.type === "facilityLevel") {
    const level = modeledFacilityLevel(effect.scaling.facility ?? facility.type);
    return effect.scaling.max ? Math.min(level, effect.scaling.max) : level;
  }

  if (effect.scaling.type === "facilityCount") {
    return facilityCount(effect, context);
  }

  if (effect.scaling.type === "facilityProductCount") {
    return facilityProductCount(effect, context);
  }

  if (effect.scaling?.type === "facilityGroupAffiliation") {
    return facilityGroupAffiliationCount(effect, operator, facility, context);
  }

  if (effect.scaling.type === "resource") {
    const resource = effect.scaling.resource ? resourceAmount(effect.scaling.resource, context, operator, facility) : 0;
    const count = effect.scaling.per ? Math.floor(resource / effect.scaling.per) : resource;
    return effect.scaling.max ? Math.min(count, effect.scaling.max) : count;
  }

  if (effect.scaling.type === "skillFamily") {
    return skillFamilyCount(effect.scaling.family, operator, facility, context, Boolean(effect.scaling.includeSelf));
  }

  if (effect.scaling.type === "facilityStorageLimit") {
    const count = facilityAssignmentStat(effect, operator, elite, facility, context, "storageLimit");
    return effect.scaling.max ? Math.min(count, effect.scaling.max) : count;
  }

  if (effect.scaling.type === "facilityOrderLimit") {
    const count = facilityAssignmentStat(effect, operator, elite, facility, context, "orderLimit");
    const scaled = effect.scaling.per ? Math.floor(count / effect.scaling.per) : count;
    return effect.scaling.max ? Math.min(scaled, effect.scaling.max) : scaled;
  }

  const assignedMatches =
    context?.assignments.filter((assignment) => {
      if (assignment.operatorId === operator.id || !effect.scaling) {
        return false;
      }
      const assignedFacility = context.facilities.find((candidate) => candidate.id === assignment.facilityId);
      const matchesFacility = scalingMatchesFacility(effect.scaling, facility, assignment, assignedFacility);
      return matchesFacility && operatorMatchesScalingAffiliation(assignment.operatorId, effect.scaling);
    }).length ?? 0;
  const selfMatches =
    effect.scaling.includeSelf &&
    scalingCanIncludeSelf(effect.scaling, facility) &&
    operatorMatchesSelfScalingAffiliation(operator, effect.scaling)
      ? 1
      : 0;
  const count = assignedMatches + selfMatches;

  return effect.scaling.max ? Math.min(count, effect.scaling.max) : count;
}

function skillFamilyCount(
  family: BaseSkillFamily | undefined,
  candidateOperator: Operator,
  facility: FacilitySlot,
  context: AssignmentEvaluationContext | undefined,
  includeSelf: boolean
) {
  if (!family || !context) {
    return 0;
  }
  const conversions = activeSkillFamilyConversions(facility, context);
  const countForOperator = (operator: Operator) =>
    activeBaseSkills(
      operator,
      context.roster?.[operator.id]?.elite ?? 0,
      context.roster?.[operator.id]?.level ?? 1
    ).filter((skill) => skillMatchesFamily(skill, family, conversions)).length;
  const assignedCount = context.assignments.reduce((sum, assignment) => {
    if (assignment.operatorId === candidateOperator.id || assignment.facilityId !== facility.id) {
      return sum;
    }
    const operator = operatorById.get(assignment.operatorId);
    return sum + (operator ? countForOperator(operator) : 0);
  }, 0);
  return assignedCount + (includeSelf ? countForOperator(candidateOperator) : 0);
}

function activeSkillFamilyConversions(facility: FacilitySlot, context: AssignmentEvaluationContext) {
  return context.assignments
    .filter((assignment) => assignment.facilityId === facility.id)
    .flatMap((assignment) => {
      const operator = operatorById.get(assignment.operatorId);
      if (!operator) {
        return [];
      }
      return activeBaseSkills(
        operator,
        context.roster?.[operator.id]?.elite ?? 0,
        context.roster?.[operator.id]?.level ?? 1
      ).flatMap((skill) => skill.effects.flatMap((effect) => effect.skillFamilyConversions ?? []));
    });
}

function skillMatchesFamily(
  skill: BaseSkill,
  family: BaseSkillFamily,
  conversions: NonNullable<BaseSkillEffect["skillFamilyConversions"]>
) {
  const families = baseSkillFamilies(skill);
  return (
    families.includes(family) ||
    conversions.some(
      (conversion) => conversion.to === family && conversion.from.some((source) => families.includes(source))
    )
  );
}

function baseSkillFamilies(skill: BaseSkill): BaseSkillFamily[] {
  if (skill.families?.length) {
    return skill.families;
  }
  const names = Object.values(skill.name).join(" ");
  if (/Rhine Tech|ラインテク|莱茵科技/i.test(names)) {
    return ["rhineTech"];
  }
  if (/Pinus Sylvestris|レッドパイン|红松骑士团/i.test(names)) {
    return ["pinusSylvestris"];
  }
  if (/Standardization|標準化|标准化/i.test(names)) {
    return ["standardization"];
  }
  return [];
}

function averageOrderStateCount(
  effect: BaseSkillEffect,
  operator: Operator,
  facility: FacilitySlot,
  context?: AssignmentEvaluationContext
) {
  if (!effect.orderState) {
    return 1;
  }
  const { finalLimit, otherEfficiency } = tradingOrderStateInputs(effect, operator, facility, context);
  const elite = context?.roster?.[operator.id]?.elite ?? 0;
  const activeOrderModes = new Set(
    activeBaseSkills(operator, elite, context?.roster?.[operator.id]?.level ?? 1)
      .flatMap((skill) => skill.effects)
      .map((activeEffect) => activeEffect.orderState?.mode)
      .filter((mode): mode is NonNullable<BaseSkillEffect["orderState"]>["mode"] => Boolean(mode))
  );
  const complementaryOrderStatesActive =
    activeOrderModes.has("averageEmptySlots") && activeOrderModes.has("averageStoredOrders");
  let ownEfficiency = 0;
  let averageStored = 0;
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const ordersPerHour = (1 + otherEfficiency + ownEfficiency) / averageNormalGoldOrderHours;
    averageStored = averageStoredOrders(finalLimit, ordersPerHour, effect.orderState.collectionIntervalHours);
    const count = effect.orderState.mode === "averageEmptySlots" ? finalLimit - averageStored : averageStored;
    ownEfficiency = complementaryOrderStatesActive ? effect.efficiency * finalLimit : effect.efficiency * count;
  }
  return effect.orderState.mode === "averageEmptySlots" ? finalLimit - averageStored : averageStored;
}

function tradingOrderStateInputs(
  effect: BaseSkillEffect,
  operator: Operator,
  facility: FacilitySlot,
  context?: AssignmentEvaluationContext
) {
  const elite = context?.roster?.[operator.id]?.elite ?? 0;
  const activeReductionState = activeBaseSkills(operator, elite, context?.roster?.[operator.id]?.level ?? 1)
    .flatMap((skill) => skill.effects)
    .map((activeEffect) => activeEffect.orderState)
    .find((orderState) => orderState?.reduceOrderLimitPerOtherEfficiency);
  const sameFacilityAssignments =
    context?.assignments.filter(
      (assignment) => assignment.facilityId === facility.id && assignment.operatorId !== operator.id
    ) ?? [];
  const remoteEfficiency = context ? calculateRemoteFacilityEfficiencyBonus(facility, context) : 0;
  const otherEfficiency = Math.max(
    sameFacilityAssignments.reduce((sum, assignment) => sum + assignment.efficiency * (assignment.shiftUptime ?? 1), 0) +
      remoteEfficiency,
    0
  );
  const localLimitIncrease = sameFacilityAssignments.reduce(
    (sum, assignment) => sum + Math.max(assignment.orderLimit ?? 0, 0),
    0
  );
  const remoteLimitIncrease =
    context?.assignments.reduce(
      (sum, assignment) =>
        sum +
        (assignment.remoteFacilityStatBonuses ?? []).reduce(
          (bonusSum, bonus) => bonusSum + remoteFacilityStatBonusAmount(bonus, "orderLimit", facility, context),
          0
        ),
      0
    ) ?? 0;
  const reductionState = effect.orderState?.reduceOrderLimitPerOtherEfficiency ? effect.orderState : activeReductionState;
  const reductionStep = reductionState?.reduceOrderLimitPerOtherEfficiency;
  const limitReduction = reductionStep ? Math.floor((otherEfficiency + 1e-9) / reductionStep) : 0;
  const minimumLimit = reductionState?.minimumOrderLimit ?? 1;
  const limitBeforeReduction = tradingPostBaseOrderLimit + localLimitIncrease + remoteLimitIncrease;
  return {
    finalLimit: Math.max(limitBeforeReduction - limitReduction, minimumLimit),
    limitReduction: Math.min(limitReduction, Math.max(limitBeforeReduction - minimumLimit, 0)),
    otherEfficiency
  };
}

function averageStoredOrders(orderLimit: number, ordersPerHour: number, collectionIntervalHours: number) {
  const generatedOrders = Math.max(ordersPerHour, 0) * Math.max(collectionIntervalHours, 0);
  if (generatedOrders <= orderLimit) {
    return generatedOrders / 2;
  }
  return orderLimit - (orderLimit * orderLimit) / (2 * generatedOrders);
}

function jayeOrderLimitModifier(
  effect: BaseSkillEffect,
  operator: Operator,
  facility: FacilitySlot,
  context?: AssignmentEvaluationContext
) {
  const reduction = tradingOrderStateInputs(effect, operator, facility, context).limitReduction;
  return reduction > 0 ? -reduction : undefined;
}

function orderStateCalculationNote(effect: BaseSkillEffect, language: AppState["language"]) {
  if (!effect.orderState) {
    return "";
  }
  const hours = effect.orderState.collectionIntervalHours;
  if (language === "ja") {
    return `（12時間シフト中、${hours}時間ごとに注文を回収し、通常純金注文の平均所要時間で連続近似）`;
  }
  if (language === "zh") {
    return ` (12-hour shift; orders collected every ${hours} hours; continuous approximation using normal gold-order duration)`;
  }
  return ` (12-hour shift; orders collected every ${hours} hours; continuous approximation using average normal gold-order duration)`;
}

function tradingOrderCalculationNote(effect: BaseSkillEffect, language: AppState["language"]) {
  const probabilityEffects = effect.tradingOrderEffects?.filter(
    (orderEffect) => orderEffect.type === "highValueOrderProbability"
  );
  if (probabilityEffects?.length) {
    if (language === "ja") {
      return "（12時間勤務。微増は3時間、増加は5時間まで線形に収束すると仮定して平均し、増加を優先）";
    }
    if (language === "zh") {
      return "（12小时轮班；假设小幅提升在3小时、提升在5小时内线性收敛并取平均，提升优先）";
    }
    return " (12-hour shift; averaged assuming linear convergence over 3h for slight and 5h for increased, with increased taking precedence)";
  }
  const specialOrder = effect.tradingOrderEffects?.find((orderEffect) => orderEffect.type === "fixedSpecialOrder");
  if (specialOrder?.type === "fixedSpecialOrder") {
    if (language === "ja") {
      return specialOrder.affectedByEfficiency
        ? "（固定特別オーダー。施設の受注効率を適用）"
        : "（固定特別オーダー。施設の受注効率は適用しない）";
    }
    if (language === "zh") {
      return specialOrder.affectedByEfficiency ? "（固定特殊订单，受订单效率影响）" : "（固定特殊订单，不受订单效率影响）";
    }
    return specialOrder.affectedByEfficiency
      ? " (fixed special order; order acquisition efficiency applies)"
      : " (fixed special order; unaffected by order acquisition efficiency)";
  }
  return "";
}

function facilityAssignmentStat(
  effect: BaseSkillEffect,
  operator: Operator,
  elite: number,
  facility: FacilitySlot,
  context: AssignmentEvaluationContext | undefined,
  key: "storageLimit" | "orderLimit"
): number {
  const assignedTotal = assignedFacilityStat(effect, operator, facility, context, key);
  const remoteTotal =
    context?.assignments.reduce((sum, assignment) => {
      return (
        sum +
        (assignment.remoteFacilityStatBonuses ?? []).reduce(
          (innerSum, bonus) => innerSum + remoteFacilityStatBonusAmount(bonus, key, facility, context),
          0
        )
      );
    }, 0) ?? 0;
  const selfTotal = effect.scaling?.includeSelf ? Math.max(activeFacilityLimit(operator, elite, facility, context, key) ?? 0, 0) : 0;
  return assignedTotal + remoteTotal + selfTotal;
}

function assignedFacilityStat(
  effect: BaseSkillEffect,
  operator: Operator,
  facility: FacilitySlot,
  context: AssignmentEvaluationContext | undefined,
  key: "storageLimit" | "orderLimit"
) {
  return (
    context?.assignments
      .filter((assignment) => {
        if (!effect.scaling || assignment.operatorId === operator.id) {
          return false;
        }
        const assignedFacility = context.facilities.find((candidate) => candidate.id === assignment.facilityId);
        return scalingMatchesFacility(effect.scaling, facility, assignment, assignedFacility);
      })
      .reduce((sum, assignment) => sum + Math.max(assignment[key] ?? 0, 0), 0) ?? 0
  );
}

function remoteFacilityStatBonusAmount(
  bonus: NonNullable<Assignment["remoteFacilityStatBonuses"]>[number],
  key: "storageLimit" | "orderLimit",
  facility: FacilitySlot,
  context: AssignmentEvaluationContext
) {
  if (bonus.key !== key || bonus.facility !== facility.type) {
    return 0;
  }
  if (!bonus.affiliations?.length && !bonus.operatorIds?.length) {
    return Math.max(bonus.amount, 0);
  }

  const matchingAssignments = context.assignments.filter(
    (assignment) =>
      assignment.facilityId === facility.id &&
      ((bonus.affiliations?.length && operatorHasAnyAffiliation(assignment.operatorId, bonus.affiliations)) ||
        (bonus.operatorIds?.length && bonus.operatorIds.includes(assignment.operatorId)))
  );
  return matchingAssignments.length >= (bonus.min ?? 1) ? matchingAssignments.length * Math.max(bonus.amount, 0) : 0;
}

export function calculateRemoteFacilityEfficiencyBonus(facility: FacilitySlot, context: AssignmentEvaluationContext): number {
  return context.assignments.reduce((sum, assignment) => {
    return (
      sum +
      (assignment.remoteFacilityEfficiencyBonuses ?? []).reduce(
        (innerSum, bonus) => innerSum + remoteFacilityEfficiencyBonusAmount(bonus, facility, context) * (assignment.shiftUptime ?? 1),
        0
      )
    );
  }, 0);
}

function remoteFacilityEfficiencyBonusAmount(
  bonus: NonNullable<Assignment["remoteFacilityEfficiencyBonuses"]>[number],
  facility: FacilitySlot,
  context: AssignmentEvaluationContext
) {
  if (bonus.facility !== facility.type || (bonus.product && bonus.product !== facility.product)) {
    return 0;
  }
  if (bonus.groupAffiliations?.length) {
    const matchingAssignments = context.assignments.filter(
      (assignment) => assignment.facilityId === facility.id && operatorHasAnyAffiliation(assignment.operatorId, bonus.groupAffiliations ?? [])
    );
    return matchingAssignments.length >= (bonus.min ?? 1) ? bonus.amount : 0;
  }
  if (!bonus.affiliations?.length && !bonus.operatorIds?.length) {
    return bonus.amount;
  }

  const matchingAssignments = context.assignments.filter(
    (assignment) =>
      assignment.facilityId === facility.id &&
      ((bonus.affiliations?.length && operatorHasAnyAffiliation(assignment.operatorId, bonus.affiliations)) ||
        (bonus.operatorIds?.length && bonus.operatorIds.includes(assignment.operatorId)))
  );
  return matchingAssignments.length >= (bonus.min ?? 1) ? matchingAssignments.length * bonus.amount : 0;
}

function facilityCount(effect: BaseSkillEffect, context?: AssignmentEvaluationContext) {
  if (!effect.scaling || !context) {
    return 0;
  }

  const physicalCount = context.facilities.filter((facility) => !effect.scaling?.facility || facility.type === effect.scaling.facility).length;
  const virtualCount = context.assignments.reduce(
    (sum, assignment) =>
      sum +
      (assignment.remoteFacilityCountBonuses ?? [])
        .filter((bonus) => !effect.scaling?.facility || bonus.facility === effect.scaling.facility)
        .reduce((bonusSum, bonus) => bonusSum + bonus.amount, 0),
    0
  );
  const count = physicalCount + virtualCount;
  return effect.scaling.max ? Math.min(count, effect.scaling.max) : count;
}

function facilityProductCount(effect: BaseSkillEffect, context?: AssignmentEvaluationContext) {
  if (!effect.scaling || !context) {
    return 0;
  }

  const count = context.facilities.filter(
    (facility) =>
      (!effect.scaling?.facility || facility.type === effect.scaling.facility) &&
      (!effect.scaling?.product || facility.product === effect.scaling.product)
  ).length;
  return effect.scaling.max ? Math.min(count, effect.scaling.max) : count;
}

function facilityGroupAffiliationCount(
  effect: BaseSkillEffect,
  operator: Operator,
  facility: FacilitySlot,
  context?: AssignmentEvaluationContext
) {
  if (!effect.scaling || !context) {
    return 0;
  }

  const facilityCounts = new Map<string, number>();
  for (const assignment of context.assignments) {
    if (assignment.operatorId === operator.id) {
      continue;
    }
    const assignedFacility = context.facilities.find((candidate) => candidate.id === assignment.facilityId);
    if (!assignedFacility || (effect.scaling.facility && assignedFacility.type !== effect.scaling.facility)) {
      continue;
    }
    if (operatorMatchesScalingAffiliation(assignment.operatorId, effect.scaling)) {
      facilityCounts.set(assignment.facilityId, (facilityCounts.get(assignment.facilityId) ?? 0) + 1);
    }
  }

  if (
    effect.scaling.includeSelf &&
    scalingCanIncludeSelf(effect.scaling, facility) &&
    operatorMatchesSelfScalingAffiliation(operator, effect.scaling)
  ) {
    facilityCounts.set(facility.id, (facilityCounts.get(facility.id) ?? 0) + 1);
  }

  const min = effect.scaling.min ?? 1;
  const count = [...facilityCounts.values()].filter((affiliationCount) => affiliationCount >= min).length;
  return effect.scaling.max ? Math.min(count, effect.scaling.max) : count;
}

function operatorMatchesScalingAffiliation(operatorId: string, scaling: NonNullable<BaseSkillEffect["scaling"]>) {
  if (!scaling.affiliations?.length) {
    return true;
  }
  return operatorHasAnyAffiliation(operatorId, scaling.affiliations);
}

function operatorMatchesSelfScalingAffiliation(operator: Operator, scaling: NonNullable<BaseSkillEffect["scaling"]>) {
  if (!scaling.affiliations?.length) {
    return true;
  }
  return Boolean(operator.affiliations?.some((affiliation) => scaling.affiliations?.includes(affiliation)));
}

function scalingMatchesFacility(
  scaling: NonNullable<BaseSkillEffect["scaling"]>,
  candidateFacility: FacilitySlot,
  assignment: Assignment,
  assignedFacility?: FacilitySlot
) {
  if (scaling.scope === "sameFacility") {
    return assignment.facilityId === candidateFacility.id;
  }
  if (scaling.facility) {
    return assignedFacility?.type === scaling.facility;
  }
  return true;
}

function scalingCanIncludeSelf(scaling: NonNullable<BaseSkillEffect["scaling"]>, facility: FacilitySlot) {
  if (scaling.scope === "sameFacility") {
    return true;
  }
  return !scaling.facility || scaling.facility === facility.type;
}

function effectConditionalBonus(
  effect: BaseSkillEffect,
  operator: Operator,
  facility: FacilitySlot,
  context?: AssignmentEvaluationContext
) {
  return (
    effect.conditionalBonuses?.reduce((sum, bonus) => {
      if (
        conditionsSatisfied(bonus.conditions, operator, facility, context, {
          allowOwnedSkilllessPrerequisites: false,
          allowBaseSkilllessPrerequisiteAssignments: false
        })
      ) {
        return sum + bonus.efficiency;
      }
      return sum;
    }, 0) ?? 0
  );
}

function resourceAmount(
  resource: string,
  context?: AssignmentEvaluationContext,
  candidateOperator?: Operator,
  candidateFacility?: FacilitySlot
): number {
  if (!context) {
    return 0;
  }

  const baseResource =
    (context.fixedResourceAmounts?.[resource] ?? 0) +
    (resource === "goldProductionLine"
      ? context.facilities.filter((facility) => facility.type === "factory" && facility.product === "gold").length
      : 0);

  const assignedResource = context.assignments.reduce((sum, assignment) => {
    if (candidateOperator && assignment.operatorId === candidateOperator.id) {
      return sum;
    }
    if (context.excludedOrdinaryResourceOperatorIds?.has(assignment.operatorId)) {
      return sum;
    }
    const operator = operatorById.get(assignment.operatorId);
    const facility = context.facilities.find((candidate) => candidate.id === assignment.facilityId);
    if (!operator || !facility) {
      return sum;
    }

    return sum + resourceAmountFromOperator(resource, operator, facility, context, candidateFacility);
  }, 0);

  const candidateResource =
    candidateOperator &&
    candidateFacility &&
    !context.excludedOrdinaryResourceOperatorIds?.has(candidateOperator.id)
      ? resourceAmountFromOperator(resource, candidateOperator, candidateFacility, context, candidateFacility)
      : 0;

  return baseResource + assignedResource + candidateResource;
}

function resourceAmountFromOperator(
  resource: string,
  operator: Operator,
  facility: FacilitySlot,
  context: AssignmentEvaluationContext,
  targetFacility?: FacilitySlot
): number {
  const effects = activeBaseSkills(
    operator,
    context.roster?.[operator.id]?.elite ?? 0,
    context.roster?.[operator.id]?.level ?? 1
  )
    .flatMap((skill) => skill.effects)
    .filter(
      (effect) =>
        effect.facility === facility.type &&
        effect.resourceEffects?.some((resourceEffect) => resourceEffect.resource === resource)
    )
    .filter((effect) => effectConditionsSatisfied(effect, operator, facility, context));

  return effects.reduce(
    (effectSum, effect) =>
      effectSum +
      (effect.resourceEffects ?? [])
        .filter((resourceEffect) => resourceEffect.resource === resource)
        .filter(
          (resourceEffect) =>
            resourceEffect.scaling?.scope !== "sameFacility" ||
            resourceEffect.scaling.type === "dormitoryOccupancy" ||
            !targetFacility ||
            facility.id === targetFacility.id
        )
        .reduce(
          (resourceSum, resourceEffect) => resourceSum + resourceEffect.amount * resourceEffectMultiplier(resourceEffect, operator, facility, context),
          0
        ),
    0
  );
}

function resourceEffectMultiplier(
  resourceEffect: NonNullable<BaseSkillEffect["resourceEffects"]>[number],
  operator: Operator,
  facility: FacilitySlot,
  context: AssignmentEvaluationContext
): number {
  if (!resourceEffect.scaling) {
    return 1;
  }
  if (resourceEffect.scaling.type === "fixed") {
    return resourceEffect.scaling.count ?? 0;
  }
  if (resourceEffect.scaling.type === "facilityCount") {
    const count = context.facilities.filter(
      (facility) => !resourceEffect.scaling?.facility || facility.type === resourceEffect.scaling.facility
    ).length;
    return resourceEffect.scaling.max ? Math.min(count, resourceEffect.scaling.max) : count;
  }
  if (resourceEffect.scaling.type === "facilityLevel") {
    const level = modeledFacilityLevel(resourceEffect.scaling.facility ?? facility.type);
    return resourceEffect.scaling.max ? Math.min(level, resourceEffect.scaling.max) : level;
  }
  if (resourceEffect.scaling.type === "facilityProductCount") {
    const count = context.facilities.filter(
      (facility) =>
        (!resourceEffect.scaling?.facility || facility.type === resourceEffect.scaling.facility) &&
        (!resourceEffect.scaling?.product || facility.product === resourceEffect.scaling.product)
    ).length;
    const scaled = resourceEffect.scaling.per ? Math.floor(count / resourceEffect.scaling.per) : count;
    return resourceEffect.scaling.max ? Math.min(scaled, resourceEffect.scaling.max) : scaled;
  }
  if (resourceEffect.scaling.type === "dormitoryOccupancy") {
    const count = context.fixedDormitoryOccupancy ?? context.assignments.filter((assignment) => {
      const assignedFacility = context.facilities.find((candidate) => candidate.id === assignment.facilityId);
      return (
        assignedFacility?.type === "dormitory" &&
        !assignment.doesNotConsumeFacilitySlot &&
        (resourceEffect.scaling?.scope !== "sameFacility" || assignment.facilityId === facility.id)
      );
    }).length;
    return resourceEffect.scaling.max ? Math.min(count, resourceEffect.scaling.max) : count;
  }
  if (resourceEffect.scaling.type === "resource") {
    const count = resourceAmount(resourceEffect.scaling.resource ?? "", context, operator, facility);
    const scaled = resourceEffect.scaling.per ? Math.floor(count / resourceEffect.scaling.per) : count;
    return resourceEffect.scaling.max ? Math.min(scaled, resourceEffect.scaling.max) : scaled;
  }
  if (resourceEffect.scaling.type === "affiliation") {
    const assignedMatches = context.assignments.filter((assignment) => {
      if (assignment.operatorId === operator.id) {
        return false;
      }
      const assignedFacility = context.facilities.find((candidate) => candidate.id === assignment.facilityId);
      return scalingMatchesFacility(resourceEffect.scaling!, facility, assignment, assignedFacility) &&
        operatorMatchesScalingAffiliation(assignment.operatorId, resourceEffect.scaling!);
    }).length;
    const selfMatches =
      resourceEffect.scaling.includeSelf &&
      scalingCanIncludeSelf(resourceEffect.scaling, facility) &&
      operatorMatchesSelfScalingAffiliation(operator, resourceEffect.scaling)
        ? 1
        : 0;
    const count = assignedMatches + selfMatches;
    return resourceEffect.scaling.max ? Math.min(count, resourceEffect.scaling.max) : count;
  }
  return 1;
}

function effectMatchesFacility(effect: BaseSkillEffect, facility: FacilitySlot): boolean {
  if (effect.facility !== facility.type) {
    return false;
  }

  return !effect.product || effect.product === facility.product || facility.type === "control";
}

function effectConditionsSatisfied(
  effect: BaseSkillEffect,
  operator: Operator,
  facility: FacilitySlot,
  context?: AssignmentEvaluationContext
): boolean {
  return conditionsSatisfied(effect.conditions ?? [], operator, facility, context);
}

export function conditionsSatisfied(
  conditions: BaseSkillEffect["conditions"],
  operator: Operator,
  facility: FacilitySlot,
  context?: AssignmentEvaluationContext,
  options: { allowOwnedSkilllessPrerequisites?: boolean; allowBaseSkilllessPrerequisiteAssignments?: boolean } = {}
): boolean {
  if (!conditions?.length) {
    return true;
  }
  if (!context) {
    return false;
  }
  const allowOwnedSkilllessPrerequisites = options.allowOwnedSkilllessPrerequisites ?? true;
  const allowBaseSkilllessPrerequisiteAssignments = options.allowBaseSkilllessPrerequisiteAssignments ?? true;

  return conditions.every((condition) => {
    if (condition.type === "sameFacilityOperator") {
      const assigned = context.assignments.some(
        (assignment) => assignment.facilityId === facility.id && condition.operatorIds.includes(assignment.operatorId)
      );
      return assigned || (allowOwnedSkilllessPrerequisites && hasOwnedSkilllessPrerequisite(condition.operatorIds, context));
    }

    if (condition.type === "facilityOperator" || condition.type === "assignedOperator") {
      const assigned = context.assignments.some((assignment) => {
        const assignedFacility = context.facilities.find((candidate) => candidate.id === assignment.facilityId);
        if (
          condition.type === "assignedOperator" &&
          !condition.facility &&
          assignment.baseSkilllessPrerequisiteFor &&
          !allowBaseSkilllessPrerequisiteAssignments
        ) {
          return false;
        }
        const matchesFacility = condition.type === "assignedOperator" && !condition.facility ? true : assignedFacility?.type === condition.facility;
        return matchesFacility && condition.operatorIds.includes(assignment.operatorId);
      });
      if (condition.type === "assignedOperator" && condition.facility) {
        return assigned;
      }
      if (condition.type === "assignedOperator") {
        return assigned;
      }
      const ownedPrerequisite = allowOwnedSkilllessPrerequisites && hasOwnedSkilllessPrerequisite(condition.operatorIds, context);
      return assigned || (condition.facility === facility.type ? ownedPrerequisite : false);
    }

    if (condition.type === "facilityCount") {
      const count = context.facilities.filter((candidate) => candidate.type === condition.facility).length;
      return count >= (condition.min ?? 0) && (condition.max === undefined || count <= condition.max);
    }

    if (condition.type === "sameFacilityAffiliation") {
      return (
        context.assignments.filter(
          (assignment) =>
            assignment.facilityId === facility.id &&
            assignment.operatorId !== operator.id &&
            operatorHasAnyAffiliation(assignment.operatorId, condition.affiliations)
        ).length >= (condition.min ?? 1)
      );
    }

    const count = context.assignments.filter((assignment) => {
        if (assignment.operatorId === operator.id) {
          return false;
        }
        const assignedFacility = context.facilities.find((candidate) => candidate.id === assignment.facilityId);
        const matchesFacility = condition.facility ? assignedFacility?.type === condition.facility : true;
        return matchesFacility && operatorHasAnyAffiliation(assignment.operatorId, condition.affiliations);
      }).length;
    const min = condition.min ?? (condition.max === undefined ? 1 : 0);
    return count >= min && (condition.max === undefined || count <= condition.max);
  });
}

function operatorHasAnyAffiliation(operatorId: string, affiliations: string[]) {
  const operator = operatorById.get(operatorId);
  return Boolean(operator?.affiliations?.some((affiliation) => affiliations.includes(affiliation)));
}

function operatorIsSkillless(operatorId: string) {
  return operatorById.get(operatorId)?.skills.length === 0;
}

function hasOwnedSkilllessPrerequisite(operatorIds: string[], context: AssignmentEvaluationContext) {
  return operatorIds.some((operatorId) => context.roster?.[operatorId]?.owned && operatorIsSkillless(operatorId));
}

function skilllessPrerequisiteOperatorIdsForConditions(
  conditions: NonNullable<BaseSkillEffect["conditions"]>,
  facility: FacilitySlot,
  context?: AssignmentEvaluationContext
) {
  if (!context) {
    return [];
  }
  const operatorIds = conditions.flatMap((condition) => {
    if (
      condition.type === "sameFacilityOperator" ||
      (condition.type === "facilityOperator" && condition.facility === facility.type)
    ) {
      const operatorId = condition.operatorIds.find((candidateId) => context.roster?.[candidateId]?.owned && operatorIsSkillless(candidateId));
      return operatorId ? [operatorId] : [];
    }
    return [];
  });
  return Array.from(new Set(operatorIds));
}

function baseSkilllessPrerequisiteOperatorIdsForConditions(
  conditions: NonNullable<BaseSkillEffect["conditions"]>,
  context?: AssignmentEvaluationContext
) {
  if (!context) {
    return [];
  }
  const operatorIds = conditions.flatMap((condition) => {
    if (condition.type === "assignedOperator" && !condition.facility) {
      const operatorId = condition.operatorIds.find((candidateId) => context.roster?.[candidateId]?.owned && operatorIsSkillless(candidateId));
      return operatorId ? [operatorId] : [];
    }
    return [];
  });
  return Array.from(new Set(operatorIds));
}

function skilllessConditionalBonusesForEffect(
  effect: BaseSkillEffect,
  operator: Operator,
  facility: FacilitySlot,
  context?: AssignmentEvaluationContext
) {
  if (!context) {
    return [];
  }

  return (effect.conditionalBonuses ?? [])
    .map((bonus) => {
      const operatorIds = bonus.conditions.flatMap((condition) => {
        if (
          condition.type === "sameFacilityOperator" ||
          (condition.type === "facilityOperator" && condition.facility === facility.type)
        ) {
          const operatorId = condition.operatorIds.find((candidateId) => context.roster?.[candidateId]?.owned && operatorIsSkillless(candidateId));
          return operatorId ? [operatorId] : [];
        }
        return [];
      });
      const baseOperatorIds = bonus.conditions.flatMap((condition) => {
        if (condition.type === "assignedOperator" && !condition.facility) {
          const operatorId = condition.operatorIds.find((candidateId) => context.roster?.[candidateId]?.owned && operatorIsSkillless(candidateId));
          return operatorId ? [operatorId] : [];
        }
        return [];
      });
      const remainingConditions = bonus.conditions.filter(
        (condition) =>
          !(
            (condition.type === "sameFacilityOperator" || (condition.type === "facilityOperator" && condition.facility === facility.type)) &&
            condition.operatorIds.some((candidateId) => context.roster?.[candidateId]?.owned && operatorIsSkillless(candidateId))
          ) &&
          !(
            condition.type === "assignedOperator" &&
            !condition.facility &&
            condition.operatorIds.some((candidateId) => context.roster?.[candidateId]?.owned && operatorIsSkillless(candidateId))
          )
      );
      return {
        efficiency: bonus.efficiency,
        operatorIds: Array.from(new Set(operatorIds)),
        baseOperatorIds: Array.from(new Set(baseOperatorIds)),
        alreadySatisfied: conditionsSatisfied(bonus.conditions, operator, facility, context, {
          allowOwnedSkilllessPrerequisites: false,
          allowBaseSkilllessPrerequisiteAssignments: false
        }),
        otherConditionsSatisfied: conditionsSatisfied(remainingConditions, operator, facility, context, { allowOwnedSkilllessPrerequisites: false })
      };
    })
    .filter((bonus) => (bonus.operatorIds.length > 0 || bonus.baseOperatorIds.length > 0) && !bonus.alreadySatisfied && bonus.otherConditionsSatisfied);
}

function calculateGlobalBonus(state: AppState, facility: FacilitySlot, context: AssignmentEvaluationContext): number {
  const buckets: GlobalBonusBucket[] = [];

  for (const assignment of context.assignments) {
    const operator = operatorById.get(assignment.operatorId);
    const assignedFacility = context.facilities.find((candidate) => candidate.id === assignment.facilityId);
    const rosterEntry = operator ? state.roster[operator.id] : undefined;
    if (!operator || !assignedFacility || assignedFacility.type !== "control" || !rosterEntry?.owned) {
      continue;
    }

    const elite = clampEliteForOperator(operator, rosterEntry.elite);
    const activeEffects = activeBaseSkills(operator, elite, rosterEntry.level)
      .flatMap((skill) => skill.effects)
      .filter((effect) => effect.globalEffect && globalEffectMatchesFacility(effect, facility))
      .filter((effect) => effectConditionsSatisfied(effect, operator, assignedFacility, context));

    for (const effect of activeEffects) {
      const scalingMultiplier = effectScalingMultiplier(effect, operator, elite, assignedFacility, context);
      buckets.push({
        stackKey: effect.globalEffect?.stackKey,
        value:
          ((effect.baseEfficiency ?? 0) + averageEffectEfficiency(effect, context.shiftHours ?? 12) * scalingMultiplier) *
          (assignment.shiftUptime ?? 1)
      });
    }
  }

  const stackBuckets = new Map<string, number>();
  let unstacked = 0;
  for (const bucket of buckets) {
    if (bucket.stackKey) {
      stackBuckets.set(bucket.stackKey, Math.max(stackBuckets.get(bucket.stackKey) ?? 0, bucket.value));
    } else {
      unstacked += bucket.value;
    }
  }
  return unstacked + [...stackBuckets.values()].reduce((sum, value) => sum + value, 0);
}

function globalEffectMatchesFacility(effect: BaseSkillEffect, facility: FacilitySlot) {
  return (
    effect.globalEffect?.facility === facility.type &&
    (!effect.globalEffect.product || effect.globalEffect.product === facility.product)
  );
}

function isExternalGlobalEffect(effect: BaseSkillEffect, facility: FacilitySlot) {
  return Boolean(effect.globalEffect && effect.globalEffect.facility !== facility.type);
}

function globalEffectStackIdentity(effect: BaseSkillEffect) {
  return `${effect.globalEffect?.facility}:${effect.globalEffect?.product ?? "*"}:${effect.globalEffect?.stackKey}`;
}

function statScalingKeysForEffect(effect: BaseSkillEffect): NonNullable<Assignment["scalesWithFacilityStat"]> {
  if (effect.scaling?.type === "facilityStorageLimit") {
    return ["storageLimit"];
  }
  if (effect.scaling?.type === "facilityOrderLimit") {
    return ["orderLimit"];
  }
  return [];
}

function facilityStatScalingsForEffect(
  effect: BaseSkillEffect,
  operator: Operator,
  elite: number,
  facility: FacilitySlot,
  preference: OptimizationPreference,
  context?: AssignmentEvaluationContext
): NonNullable<Assignment["facilityStatScalings"]> {
  if (effect.scaling?.type === "facilityStorageLimit") {
    const current = facilityAssignmentStat(effect, operator, elite, facility, context, "storageLimit");
    return [
      {
        key: "storageLimit",
        base: current - assignedFacilityStat(effect, operator, facility, context, "storageLimit"),
        current,
        efficiencyPerStep: effect.efficiency,
        scorePerEfficiency: productWeight(facility.product, preference) * facilityWeight(facility),
        max: effect.scaling.max
      }
    ];
  }
  if (effect.scaling?.type === "facilityOrderLimit") {
    const current = facilityAssignmentStat(effect, operator, elite, facility, context, "orderLimit");
    return [
      {
        key: "orderLimit",
        base: current - assignedFacilityStat(effect, operator, facility, context, "orderLimit"),
        current,
        efficiencyPerStep: effect.efficiency,
        scorePerEfficiency: productWeight(facility.product, preference) * facilityWeight(facility),
        per: effect.scaling.per,
        max: effect.scaling.max
      }
    ];
  }
  return [];
}

function getComplexBaseSkillHandler(operator: Operator, skill: BaseSkill) {
  return complexBaseSkillHandlers[operator.id]?.[skill.id];
}

function controlFacilityAffiliationRemoteEfficiencyHandler(): ComplexBaseSkillHandler {
  return {
    remoteFacilityEfficiencyBonuses: ({ effect }) => controlFacilityAffiliationRemoteEfficiencyBonuses(effect)
  };
}

function controlFacilityGroupAffiliationRemoteEfficiencyHandler(): ComplexBaseSkillHandler {
  return {
    remoteFacilityEfficiencyBonuses: ({ effect }) => controlFacilityGroupAffiliationRemoteEfficiencyBonuses(effect)
  };
}

function controlFacilityAffiliationRemoteStatAndEfficiencyHandler(): ComplexBaseSkillHandler {
  return {
    remoteFacilityStatBonuses: ({ effect }) => genericRemoteFacilityStatBonusesForEffect(effect),
    remoteFacilityEfficiencyBonuses: ({ effect }) => controlFacilityAffiliationRemoteEfficiencyBonuses(effect)
  };
}

function suppressingSelfOnlySameFacilityScalingHandler(): ComplexBaseSkillHandler {
  return {
    scalingMultiplier: ({ operator, effect, facility }) => {
      if (!effect.scaling?.includeSelf || !scalingCanIncludeSelf(effect.scaling, facility)) {
        return 0;
      }
      const count = operatorMatchesSelfScalingAffiliation(operator, effect.scaling) ? 1 : 0;
      return effect.scaling.max ? Math.min(count, effect.scaling.max) : count;
    }
  };
}

function remoteFacilityStatBonusesForEffect(
  operator: Operator,
  skill: BaseSkill,
  effect: BaseSkillEffect,
  elite: number,
  facility: FacilitySlot,
  context: AssignmentEvaluationContext | undefined
): NonNullable<Assignment["remoteFacilityStatBonuses"]> {
  const handler = getComplexBaseSkillHandler(operator, skill);
  return handler?.remoteFacilityStatBonuses?.({ operator, skill, effect, elite, facility, context }) ?? genericRemoteFacilityStatBonusesForEffect(effect);
}

function genericRemoteFacilityStatBonusesForEffect(effect: BaseSkillEffect): NonNullable<Assignment["remoteFacilityStatBonuses"]> {
  const bonuses: NonNullable<Assignment["remoteFacilityStatBonuses"]> = [];
  for (const condition of effect.conditions ?? []) {
    if (effect.storageLimit) {
      const bonus = remoteFacilityStatBonusForCondition(condition, "storageLimit", effect.storageLimit);
      if (bonus) {
        bonuses.push(bonus);
      }
    }
    if (effect.orderLimit) {
      const bonus = remoteFacilityStatBonusForCondition(condition, "orderLimit", effect.orderLimit);
      if (bonus) {
        bonuses.push(bonus);
      }
    }
  }
  return bonuses;
}

function remoteFacilityEfficiencyBonusesForEffect(
  operator: Operator,
  skill: BaseSkill,
  effect: BaseSkillEffect,
  elite: number,
  facility: FacilitySlot,
  context: AssignmentEvaluationContext | undefined
): NonNullable<Assignment["remoteFacilityEfficiencyBonuses"]> {
  const handler = getComplexBaseSkillHandler(operator, skill);
  return handler?.remoteFacilityEfficiencyBonuses?.({ operator, skill, effect, elite, facility, context }) ?? genericRemoteFacilityEfficiencyBonusesForEffect(effect);
}

function genericRemoteFacilityEfficiencyBonusesForEffect(effect: BaseSkillEffect): NonNullable<Assignment["remoteFacilityEfficiencyBonuses"]> {
  if (effect.facility !== "control" || effect.globalEffect) {
    return [];
  }

  if (effect.scaling?.type === "facilityGroupAffiliation") {
    return controlFacilityGroupAffiliationRemoteEfficiencyBonuses(effect);
  }

  if (effect.scaling && effect.scaling.type !== "affiliation") {
    return [];
  }

  return controlFacilityAffiliationRemoteEfficiencyBonuses(effect);
}

function controlFacilityGroupAffiliationRemoteEfficiencyBonuses(
  effect: BaseSkillEffect
): NonNullable<Assignment["remoteFacilityEfficiencyBonuses"]> {
  if (effect.facility !== "control" || effect.globalEffect || effect.scaling?.type !== "facilityGroupAffiliation") {
    return [];
  }
  if (!effect.scaling.facility || effect.scaling.facility === effect.facility) {
    return [];
  }
  return [
    {
      facility: effect.scaling.facility,
      amount: effect.efficiency,
      ...(effect.product && effect.product !== "morale" ? { product: effect.product } : {}),
      groupAffiliations: effect.scaling.affiliations,
      min: effect.scaling.min
    }
  ];
}

function controlFacilityAffiliationRemoteEfficiencyBonuses(
  effect: BaseSkillEffect
): NonNullable<Assignment["remoteFacilityEfficiencyBonuses"]> {
  if (effect.facility !== "control" || effect.globalEffect) {
    return [];
  }
  if (effect.scaling && effect.scaling.type !== "affiliation") {
    return [];
  }

  const matchingCondition = (effect.conditions ?? [])
    .filter((condition): condition is FacilityAffiliationCondition => condition.type === "facilityAffiliation")
    .find(
      (condition) =>
        condition.facility &&
        condition.facility !== effect.facility &&
        (!effect.scaling?.facility || condition.facility === effect.scaling.facility) &&
        condition.affiliations.some((affiliation) => !effect.scaling?.affiliations?.length || effect.scaling.affiliations.includes(affiliation))
    );
  const targetFacility = effect.scaling?.facility ?? matchingCondition?.facility;
  const targetAffiliations = effect.scaling?.affiliations ?? matchingCondition?.affiliations;
  if (!targetFacility || targetFacility === effect.facility || !targetAffiliations?.length) {
    return [];
  }

  return [
    {
      facility: targetFacility,
      amount: effect.efficiency,
      ...(effect.product && effect.product !== "morale" ? { product: effect.product } : {}),
      affiliations: targetAffiliations,
      ...(matchingCondition && "min" in matchingCondition ? { min: matchingCondition.min } : {})
    }
  ];
}

function remoteFacilityStatScore(
  bonuses: NonNullable<Assignment["remoteFacilityStatBonuses"]>,
  sourceOperatorId: string,
  preference: OptimizationPreference,
  context?: AssignmentEvaluationContext
) {
  if (!context) {
    return 0;
  }

  return bonuses.reduce((sum, bonus) => {
    const beneficiaryScore = operators.reduce((operatorSum, operator) => {
      if (operator.id === sourceOperatorId) {
        return operatorSum;
      }
      const rosterEntry = context.roster?.[operator.id];
      if (!rosterEntry?.owned) {
        return operatorSum;
      }
      const elite = clampEliteForOperator(operator, rosterEntry.elite);
      const bestAssignmentScore = context.facilities
        .filter((facility) => facility.type !== "dormitory" && facility.type === bonus.facility)
        .reduce((facilityBest, facility) => {
          const addedLimit = remoteFacilityStatBonusAmount(bonus, bonus.key, facility, context);
          if (addedLimit <= 0) {
            return facilityBest;
          }
          const bestEffectScore = activeBaseSkills(operator, elite, rosterEntry.level)
            .flatMap((skill) => skill.effects)
            .filter((effect) => !effect.ignoredForOptimization)
            .filter((effect) => effectMatchesFacility(effect, facility))
            .flatMap((effect) => facilityStatScalingsForEffect(effect, operator, elite, facility, preference, context))
            .filter((scaling) => scaling.key === bonus.key)
            .reduce(
              (best, scaling) =>
                Math.max(best, statScalingDelta(scaling, addedLimit) * scaling.efficiencyPerStep * scaling.scorePerEfficiency),
              0
            );
          return Math.max(facilityBest, bestEffectScore);
        }, 0);
      return operatorSum + bestAssignmentScore;
    }, 0);
    return sum + beneficiaryScore;
  }, 0);
}

function remoteFacilityEfficiencyScore(
  bonuses: NonNullable<Assignment["remoteFacilityEfficiencyBonuses"]>,
  preference: OptimizationPreference,
  context?: AssignmentEvaluationContext
) {
  if (!context) {
    return 0;
  }
  return bonuses.reduce((sum, bonus) => {
    return (
      sum +
      context.facilities
        .filter((facility) => facility.type !== "dormitory" && facility.type === bonus.facility && (!bonus.product || facility.product === bonus.product))
        .reduce(
          (facilitySum, facility) => {
            const activeAmount = remoteFacilityEfficiencyBonusAmount(bonus, facility, context);
            return facilitySum + activeAmount * productWeight(facility.product, preference) * facilityWeight(facility);
          },
          0
        )
    );
  }, 0);
}

function remoteFacilityCountScore(
  bonuses: NonNullable<Assignment["remoteFacilityCountBonuses"]>,
  sourceOperatorId: string,
  preference: OptimizationPreference,
  context?: AssignmentEvaluationContext
) {
  if (!context) {
    return 0;
  }

  return bonuses.reduce((sum, bonus) => {
    const beneficiaryScore = operators.reduce((operatorSum, operator) => {
      if (operator.id === sourceOperatorId) {
        return operatorSum;
      }
      const rosterEntry = context.roster?.[operator.id];
      if (!rosterEntry?.owned) {
        return operatorSum;
      }
      const elite = clampEliteForOperator(operator, rosterEntry.elite);
      const bestAssignmentScore = context.facilities
        .filter((facility) => facility.type !== "dormitory")
        .reduce((facilityBest, facility) => {
          const bestEffectScore = activeBaseSkills(operator, elite, rosterEntry.level)
            .flatMap((skill) => skill.effects)
            .filter((effect) => !effect.ignoredForOptimization)
            .filter((effect) => effectMatchesFacility(effect, facility))
            .filter((effect) => effect.scaling?.type === "facilityCount" && effect.scaling.facility === bonus.facility)
            .reduce(
              (best, effect) =>
                Math.max(best, bonus.amount * effect.efficiency * productWeight(facility.product, preference) * facilityWeight(facility)),
              0
            );
          return Math.max(facilityBest, bestEffectScore);
        }, 0);
      return operatorSum + bestAssignmentScore;
    }, 0);
    return sum + beneficiaryScore;
  }, 0);
}

function remoteFacilityStatBonusForCondition(
  condition: NonNullable<BaseSkillEffect["conditions"]>[number],
  key: "storageLimit" | "orderLimit",
  amount: number
): NonNullable<Assignment["remoteFacilityStatBonuses"]>[number] | undefined {
  if (condition.type === "facilityAffiliation" && condition.facility) {
    return {
      key,
      facility: condition.facility,
      amount,
      affiliations: condition.affiliations,
      min: condition.min
    };
  }
  if (condition.type === "facilityOperator") {
    return {
      key,
      facility: condition.facility,
      amount,
      operatorIds: condition.operatorIds
    };
  }
  return undefined;
}

function globalEffectTargetScoreMultiplier(
  effect: BaseSkillEffect,
  preference: OptimizationPreference,
  context?: AssignmentEvaluationContext
) {
  if (!effect.globalEffect || !context) {
    return 0;
  }

  return context.facilities
    .filter((facility) => facility.type !== "dormitory" && globalEffectMatchesFacility(effect, facility))
    .reduce((sum, facility) => sum + productWeight(facility.product, preference) * facilityWeight(facility), 0);
}

function productWeight(product: ProductType, preference: OptimizationPreference): number {
  if (product === "gold") {
    return preference.gold;
  }
  if (product === "battleRecord") {
    return preference.battleRecord;
  }
  if (product === "originium") {
    return 0.05;
  }
  if (product === "lmd") {
    return preference.lmd;
  }
  if (product === "power") {
    return (preference.gold + preference.battleRecord + preference.lmd) / 3;
  }
  return 0.2;
}

export function evaluateExactWindowFacilityObjective(input: {
  schedule: AppState["schedule"];
  facilities: readonly FacilitySlot[];
  preference: OptimizationPreference;
  evaluations: readonly WindowFacilityEfficiencyEvaluation[];
}): number | undefined {
  if (!Number.isFinite(input.schedule.cycleHours) || input.schedule.cycleHours <= 0) return undefined;
  const profileScale = Math.max(
    input.preference.gold,
    input.preference.battleRecord,
    input.preference.lmd
  );
  if (!Number.isFinite(profileScale) || profileScale <= 0) return undefined;
  let value = 0;
  for (const evaluation of input.evaluations) {
    const facility = input.facilities.find((candidate) => candidate.id === evaluation.facilityId);
    const window = input.schedule.shifts.find((candidate) => candidate.id === evaluation.scheduleWindowId);
    if (!facility || !window || !Number.isFinite(evaluation.additiveEfficiency) ||
      evaluation.provenance !== "optimizer-normal-team-reevaluation-with-schedule-aware-contiguous-work-and-resolved-support-context") {
      return undefined;
    }
    const durationHours = window.endHour - window.startHour;
    if (!Number.isFinite(durationHours) || durationHours <= 0) return undefined;
    const weight = productWeight(facility.product, input.preference);
    if (!Number.isFinite(weight) || weight < 0) return undefined;
    value += (1 + evaluation.additiveEfficiency) * weight / profileScale *
      durationHours / input.schedule.cycleHours;
  }
  return Number.isFinite(value) ? value : undefined;
}

function facilityWeight(facility: FacilitySlot): number {
  return facilityTypeWeight(facility.type);
}

function facilityTypeWeight(facilityType: FacilitySlot["type"]): number {
  if (facilityType === "factory" || facilityType === "trading") {
    return 100;
  }
  if (facilityType === "power") {
    return 65;
  }
  if (facilityType === "control") {
    return 55;
  }
  return 35;
}

function buildWarnings(_state: AppState, _enabledFacilities: FacilitySlot[], facilityPlans: FacilityPlan[]): string[] {
  const warnings: string[] = [];
  const hasVacancy = facilityPlans.some(
    (plan) =>
      facilitySlotOccupancy(plan.assignments) < plan.facility.slotCount ||
      facilitySlotOccupancy(plan.alternatives) < plan.facility.slotCount
  );

  if (hasVacancy) {
    warnings.push("一部施設でスロット数に対して候補オペレーターが不足しています。所有設定か昇進段階を見直してください。");
  }

  return warnings;
}
