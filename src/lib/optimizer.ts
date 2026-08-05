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
import { normalizeSchedule, scheduleEpsilonHours } from "./schedule";
import { resolveSupportResourceScenario } from "./supportResourceScenario";
import { modeledFacilityLevel } from "./facilityLevel";
import { activeBaseSkills } from "./activeBaseSkills";
import { splitCyclicHalfOpenInterval } from "./cyclicInterval";
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
  SupportResourceScenarioEvaluation,
  WindowFacilityEfficiencyEvaluation
} from "../types";

type AssignmentEvaluationContext = {
  assignments: Assignment[];
  facilities: FacilitySlot[];
  roster?: AppState["roster"];
  shiftHours?: number;
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

export function averageEffectEfficiency(effect: BaseSkillEffect, shiftHours: number) {
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
  return averageBoundedArithmeticSegments(
    durationHours,
    1,
    firstSegmentValue,
    efficiencyPerHour,
    maxEfficiency,
    "upper"
  );
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

export function generateAssignmentPlan(
  state: AppState,
  options: GenerateAssignmentPlanOptions = {}
): AssignmentPlan {
  return generateAssignmentPlanInternal(state, options, true);
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
  const supportSelectionContext = allowSupportFallback && options.supportResourceScenario
    ? buildSupportSelectionContext(
        state,
        resolveSupportResourceScenario(
          scenarioState,
          options.supportResourceScenario,
          scheduleSkeleton
        ),
        scheduleSkeleton
      )
    : undefined;
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
  const fixedDormitoryOccupancy = scenario.fixedContext?.dormitoryOccupancy.status === "resolved"
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
      const operator = operators.find((candidate) => candidate.id === operatorId);
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

function evaluateWindowFacilityEfficiencies(
  state: AppState,
  facilityPlans: readonly FacilityPlan[],
  rotation: readonly AssignmentPlan["rotation"][number][],
  scenario: SupportResourceScenarioEvaluation
): WindowFacilityEfficiencyEvaluation[] {
  const fixedDormitoryOccupancy = scenario.fixedContext?.dormitoryOccupancy.status === "resolved"
    ? scenario.fixedContext.dormitoryOccupancy.context.amount
    : undefined;
  const reservedOperatorIds = new Set(
    scenario.sources
      .filter((evidence) => evidence.status === "resolved")
      .map((evidence) => evidence.source.operatorId)
  );
  const reservedFacilitySlots = maximumConcurrentAppStateSourceReservations(
    scenario,
    [...rotation],
    state.schedule.cycleHours
  );

  return rotation.flatMap((window) => {
    const windowSources = scenario.sources.filter(
      (evidence) => evidence.status === "resolved" && evidence.source.scheduleWindowId === window.shiftId
    );
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
      reservedOperatorIds,
      reservedFacilitySlots
    );
    const context: AssignmentEvaluationContext = {
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
        const reevaluatedAssignments = reevaluateFacilityTeam(
          selectedAssignments,
          plan.facility,
          state,
          context
        );
        const facilityBonus =
          calculateGlobalBonus(state, plan.facility, context) +
          calculateRemoteFacilityEfficiencyBonus(plan.facility, context);
        return {
          scheduleWindowId: window.shiftId,
          facilityId: plan.facility.id,
          additiveEfficiency: effectiveFacilityEfficiency(reevaluatedAssignments, facilityBonus),
          provenance: "optimizer-normal-team-reevaluation-with-resolved-support-context" as const,
          fixedResourceAmounts: Object.freeze({ ...fixedResourceAmounts }),
          ...(fixedDormitoryOccupancy === undefined ? {} : { fixedDormitoryOccupancy })
        };
      });
  });
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
      const teamOptions = buildFacilityTeamOptions(
        candidates,
        availableOrdinaryFacilitySlots(facility, selectionContext)
      )
        .map((assignments) => reevaluateFacilityTeam(assignments, facility, state, context))
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
  };
  let searchStates: SearchState[] = [{ usedOperatorIds: new Set(), plans: [], selectionScore: 0 }];
  for (const candidateSet of facilityCandidates) {
    const nextStates: SearchState[] = [];
    for (const searchState of searchStates) {
      for (const assignments of candidateSet.teamOptions) {
        const operatorIds = assignments.map((assignment) => assignment.operatorId);
        if (operatorIds.some((operatorId) => searchState.usedOperatorIds.has(operatorId))) {
          continue;
        }
        const expectedEfficiency = effectiveFacilityEfficiency(assignments, candidateSet.facilityBonus);
        nextStates.push({
          usedOperatorIds: new Set([...searchState.usedOperatorIds, ...operatorIds]),
          selectionScore:
            searchState.selectionScore +
            facilityTeamSelectionScore(
              assignments,
              candidateSet.facility,
              state.preference,
              candidateSet.facilityBonus
            ),
          plans: [
            ...searchState.plans,
            {
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
            }
          ]
        });
      }
    }
    searchStates = nextStates
      .sort((a, b) => b.selectionScore - a.selectionScore || assignmentStateSignature(a).localeCompare(assignmentStateSignature(b)))
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

function buildFacilityTeamOptions(candidates: Assignment[], slotCount: number) {
  const options: Assignment[][] = [];
  const optionSignatures = new Set<string>();
  const visitedExclusions = new Set<string>();
  const exclusionQueue: string[][] = [[]];
  while (exclusionQueue.length && options.length < 16 && visitedExclusions.size < 64) {
    const exclusions = exclusionQueue.shift()!;
    const exclusionKey = [...exclusions].sort().join("|");
    if (visitedExclusions.has(exclusionKey)) {
      continue;
    }
    visitedExclusions.add(exclusionKey);
    const excludedOperatorIds = new Set(exclusions);
    const assignments = selectAssignmentsForFacility(
      candidates.filter((candidate) => !excludedOperatorIds.has(candidate.operatorId)),
      slotCount
    );
    const signature = assignments.map((assignment) => `${assignment.operatorId}:${assignment.skillId}`).sort().join("|");
    if (!optionSignatures.has(signature)) {
      optionSignatures.add(signature);
      options.push(assignments);
    }
    for (const assignment of assignments.filter((candidate) => assignmentConsumesFacilitySlot(candidate))) {
      exclusionQueue.push([...exclusions, assignment.operatorId]);
    }
  }
  if (!optionSignatures.has("")) {
    options.push([]);
  }
  return options.sort(
    (a, b) =>
      b.reduce((sum, assignment) => sum + assignment.score, 0) -
        a.reduce((sum, assignment) => sum + assignment.score, 0) ||
      a.map((assignment) => assignment.operatorId).sort().join("|").localeCompare(b.map((assignment) => assignment.operatorId).sort().join("|"))
  );
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
      assignment.skillId === "baseline" ||
      assignment.skillId === "skillless-prerequisite" ||
      assignment.skillId === "base-skillless-prerequisite"
    ) {
      return assignment;
    }
    const operator = operators.find((candidate) => candidate.id === assignment.operatorId);
    const rosterEntry = state.roster[assignment.operatorId];
    if (!operator || !rosterEntry) {
      return assignment;
    }
    const reevaluated = bestSkillForFacility(
      operator,
      rosterEntry,
      facility,
      state.preference,
      0,
      state.language,
      tentativeContext
    );
    return reevaluated.find((candidate) => candidate.skillId === assignment.skillId) ?? reevaluated[0] ?? assignment;
  });
}

function assignmentStateSignature(state: { plans: FacilityPlan[] }) {
  return state.plans
    .flatMap((plan) => plan.assignments.map((assignment) => `${plan.facility.id}:${assignment.operatorId}:${assignment.skillId}`))
    .sort()
    .join("|");
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
      const modeledEfficiency = averageEffectEfficiency(effect, context?.shiftHours ?? 12);
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
  moraleExchangeSourceOperatorId?: string
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
  const targetOperator = operators.find((candidate) => candidate.id === assignment.operatorId);
  const activeImmunities = workingAssignments.flatMap((sourceAssignment) => {
    const sourceFacility = context.facilities.find((candidate) => candidate.id === sourceAssignment.facilityId);
    const sourceOperator = operators.find((candidate) => candidate.id === sourceAssignment.operatorId);
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
    const sourceOperator = operators.find((candidate) => candidate.id === sourceAssignment.operatorId);
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
  const moraleSpent = Math.min(consumptionPerHour * shiftHours, moraleCapacity);
  const dormitoryRecoveryPerHour = bestDormitoryRecoveryPerHour(
    assignment.operatorId,
    state,
    recoveryWorkingContext,
    moraleCapacity - moraleSpent
  );
  const recoveryProvenance = bestDormitoryRecoveryProvenance(
    assignment.operatorId,
    state,
    recoveryWorkingContext,
    moraleExchangeSourceOperatorId
  );
  const moraleAdjustedEfficiency =
    assignment.efficiency +
    (assignment.moraleEfficiencyCurves ?? []).reduce(
      (sum, curve) =>
        sum +
        averageMoraleCurveEfficiency(curve, shiftHours, consumptionPerHour) -
        curve.baselineEfficiency,
      0
    );
  return {
    ...assignment,
    efficiency: moraleAdjustedEfficiency,
    moraleConsumptionPerHour: consumptionPerHour,
    dormitoryRecoveryPerHour,
    recoveryProvenance,
    shiftUptime: consumptionPerHour === 0 ? 1 : Math.min(moraleCapacity / consumptionPerHour / shiftHours, 1),
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
  exchangeSourceOperatorId?: string
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
  const baseProfile = calculateDormitoryRecovery(targetOperatorId, state, workingContext, moraleCapacity);
  const sourcesByKey = new Map(baseProfile.sources.map((source) => [`${source.operatorId}:${source.allocation}`, source]));
  const conditionalModifiers = sortedThresholds
    .flatMap((moraleAtMost) => {
      const atThreshold = calculateDormitoryRecovery(targetOperatorId, state, workingContext, moraleAtMost);
      const aboveThreshold = calculateDormitoryRecovery(targetOperatorId, state, workingContext, moraleAtMost + 1e-9);
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
      const profile = calculateDormitoryRecovery(targetOperatorId, state, workingContext, moraleAtMost);
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
  targetMorale: number
): DormitoryRecoveryCalculation {
  const workingOperatorIds = new Set(workingContext.assignments.map((assignment) => assignment.operatorId));
  const dormitory =
    state.facilities.find((facility) => facility.type === "dormitory") ??
    ({ id: "dormitory-recovery", type: "dormitory", name: "Dormitory", slotCount: 5, product: "morale" } satisfies FacilitySlot);
  const targetOperator = operators.find((operator) => operator.id === targetOperatorId);
  const targetRosterEntry = targetOperator ? state.roster[targetOperatorId] : undefined;
  if (!targetOperator || !targetRosterEntry) return { ratePerHour: maxDormitoryRecoveryPerHour, components: [], sources: [] };

  const selfCandidates: RecoveryComponent[] = [];
  const roomCandidates: RecoveryComponent[] = [];
  const singleCandidates: RecoveryComponent[] = [];
  for (const operator of operators) {
    const rosterEntry = state.roster[operator.id];
    if (!rosterEntry?.owned || (workingOperatorIds.has(operator.id) && operator.id !== targetOperatorId)) continue;
    const requiredIds = activeBaseSkills(operator, rosterEntry.elite, rosterEntry.level)
      .flatMap((skill) => skill.effects)
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
    const sourceOperator = operators.find((operator) => operator.id === sourceAssignment.operatorId);
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
  targetMorale = 0
) {
  return calculateDormitoryRecovery(targetOperatorId, state, workingContext, targetMorale).ratePerHour;
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
  const elite = clampEliteForOperator(operator, rosterEntry.elite);
  const seen = new Set<string>();
  return activeBaseSkills(operator, elite, rosterEntry.level).flatMap((skill) =>
    skill.effects.flatMap((effect) => {
      if (effect.facility !== facility.type || !effectConditionsSatisfied(effect, operator, facility, context)) {
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
    .filter(({ effect }) => effectMatchesFacility(effect, facility) && effectConditionsSatisfied(effect, operator, facility, context))
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
    const operator = operators.find((candidate) => candidate.id === assignment.operatorId);
    return sum + (operator ? countForOperator(operator) : 0);
  }, 0);
  return assignedCount + (includeSelf ? countForOperator(candidateOperator) : 0);
}

function activeSkillFamilyConversions(facility: FacilitySlot, context: AssignmentEvaluationContext) {
  return context.assignments
    .filter((assignment) => assignment.facilityId === facility.id)
    .flatMap((assignment) => {
      const operator = operators.find((candidate) => candidate.id === assignment.operatorId);
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
    const operator = operators.find((candidate) => candidate.id === assignment.operatorId);
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
  const operator = operators.find((candidate) => candidate.id === operatorId);
  return Boolean(operator?.affiliations?.some((affiliation) => affiliations.includes(affiliation)));
}

function operatorIsSkillless(operatorId: string) {
  return operators.find((candidate) => candidate.id === operatorId)?.skills.length === 0;
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
    const operator = operators.find((candidate) => candidate.id === assignment.operatorId);
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
          (facilitySum, facility) =>
            facilitySum + remoteFacilityEfficiencyBonusAmount(bonus, facility, context) * productWeight(facility.product, preference) * facilityWeight(facility),
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
