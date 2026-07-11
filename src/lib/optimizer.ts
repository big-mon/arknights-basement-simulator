import { operators } from "../data/defaults";
import { clampEliteForOperator } from "./elite";
import { localizeText } from "./localization";
import type {
  AppState,
  Assignment,
  AssignmentPlan,
  BaseSkill,
  BaseSkillCondition,
  BaseSkillEffect,
  FacilityPlan,
  FacilitySlot,
  Operator,
  OptimizationPreference,
  ProductType,
  RosterEntry
} from "../types";

type AssignmentEvaluationContext = {
  assignments: Assignment[];
  facilities: FacilitySlot[];
  roster?: AppState["roster"];
  shiftHours?: number;
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

const maxFacilityLevelByType: Record<FacilitySlot["type"], number> = {
  factory: 3,
  trading: 3,
  power: 3,
  control: 5,
  dormitory: 5,
  reception: 3
};

function rotationShiftHours(rotationCount: AppState["rotationCount"]) {
  return 24 / rotationCount;
}

export function averageEffectEfficiency(effect: BaseSkillEffect, shiftHours: number) {
  if (effect.moraleCurve) {
    return averageMoraleCurveEfficiency(effect.moraleCurve, shiftHours, 1);
  }
  if (!effect.timeCurve) {
    return effect.efficiency;
  }
  const hours = Math.max(1, Math.trunc(shiftHours));
  const { initialEfficiency, efficiencyPerHour, maxEfficiency, startsAfterFirstHour } = effect.timeCurve;
  let total = 0;
  for (let hour = 0; hour < hours; hour += 1) {
    const increments = startsAfterFirstHour ? hour : hour + 1;
    total += Math.min(initialEfficiency + efficiencyPerHour * increments, maxEfficiency);
  }
  return total / hours;
}

function averageMoraleCurveEfficiency(
  curve: NonNullable<BaseSkillEffect["moraleCurve"]>,
  shiftHours: number,
  moraleConsumptionPerHour: number
) {
  const hours = Math.max(1, Math.trunc(shiftHours));
  let total = 0;
  for (let hour = 0; hour < hours; hour += 1) {
    const moraleSpent = hour * moraleConsumptionPerHour;
    const steps = Math.floor(moraleSpent / curve.moralePerStep);
    total += Math.max(curve.initialEfficiency + curve.efficiencyPerStep * steps, curve.minEfficiency);
  }
  return total / hours;
}

export function generateAssignmentPlan(state: AppState): AssignmentPlan {
  const enabledFacilities = state.facilities.filter((facility) => facility.type !== "dormitory");
  let facilityPlans = buildFacilityPlans(state, enabledFacilities, []);

  for (let index = 0; index < 3; index += 1) {
    const nextFacilityPlans = buildFacilityPlans(state, enabledFacilities, facilityPlans.flatMap((plan) => plan.assignments));
    if (assignmentSignature(nextFacilityPlans) === assignmentSignature(facilityPlans)) {
      facilityPlans = nextFacilityPlans;
      break;
    }
    facilityPlans = nextFacilityPlans;
  }

  facilityPlans = attachRotationAlternatives(state, facilityPlans);
  facilityPlans = applyMoraleDurations(state, facilityPlans);

  const activeAssignments = facilityPlans.flatMap((plan) => plan.assignments);
  const alternativeAssignments = facilityPlans.flatMap((plan) => plan.alternatives);
  const totalScore = facilityPlans.reduce((sum, plan) => sum + plan.score, 0);
  const dailyValue = facilityPlans.reduce(
    (sum, plan) => sum + plan.expectedEfficiency * productWeight(plan.facility.product, state.preference) * 24,
    0
  );

  const warnings = buildWarnings(state, enabledFacilities, facilityPlans);

  return {
    generatedAt: new Date().toISOString(),
    totalScore,
    dailyValue,
    facilityPlans,
    rotation: buildRotationWindows(activeAssignments, alternativeAssignments, state.rotationCount),
    warnings
  };
}

function buildFacilityPlans(
  state: AppState,
  enabledFacilities: FacilitySlot[],
  contextAssignments: Assignment[],
  excludedOperatorIds: ReadonlySet<string> = new Set()
): FacilityPlan[] {
  const context: AssignmentEvaluationContext = {
    assignments: contextAssignments,
    facilities: state.facilities,
    roster: state.roster,
    shiftHours: rotationShiftHours(state.rotationCount)
  };
  const facilityCandidates = [...enabledFacilities]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((facility) => {
    const globalBonus = calculateGlobalBonus(state, facility, context);
    const remoteEfficiencyBonus = calculateRemoteFacilityEfficiencyBonus(facility, context);
    const facilityBonus = globalBonus + remoteEfficiencyBonus;
      const candidates = findCandidates(facility, state, 0, context)
        .filter((candidate) => !excludedOperatorIds.has(candidate.operatorId))
        .sort((a, b) => b.score - a.score);
      return {
        facility,
        facilityBonus,
        candidates,
        teamOptions: buildFacilityTeamOptions(candidates, facility.slotCount)
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
        const expectedEfficiency = effectiveFacilityEfficiency(assignments) + candidateSet.facilityBonus;
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
    excludedOperatorIds,
    new Map(facilityCandidates.map(({ facility, candidates }) => [facility.id, candidates]))
  );
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
        if (facilitySlotOccupancy(assignments) >= plan.facility.slotCount) {
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
          if (facilitySlotOccupancy(assignments) >= plan.facility.slotCount) {
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

function assignmentStateSignature(state: { plans: FacilityPlan[] }) {
  return state.plans
    .flatMap((plan) => plan.assignments.map((assignment) => `${plan.facility.id}:${assignment.operatorId}:${assignment.skillId}`))
    .sort()
    .join("|");
}

export function attachRotationAlternatives(state: AppState, facilityPlans: FacilityPlan[]): FacilityPlan[] {
  const firstRotationOperatorIds = new Set(facilityPlans.flatMap((plan) => plan.assignments.map((assignment) => assignment.operatorId)));
  let plansWithAlternatives = buildAlternativeFacilityPlans(state, facilityPlans, firstRotationOperatorIds, []);

  for (let index = 0; index < 3; index += 1) {
    const previousSignature = alternativeAssignmentSignature(plansWithAlternatives);
    const contextAssignments = plansWithAlternatives.flatMap((plan) => plan.alternatives);
    const nextPlans = buildAlternativeFacilityPlans(state, facilityPlans, firstRotationOperatorIds, contextAssignments);
    plansWithAlternatives = nextPlans;
    if (alternativeAssignmentSignature(nextPlans) === previousSignature) {
      break;
    }
  }

  const alternativeContext: AssignmentEvaluationContext = {
    assignments: plansWithAlternatives.flatMap((plan) => plan.alternatives),
    facilities: state.facilities,
    roster: state.roster,
    shiftHours: rotationShiftHours(state.rotationCount)
  };

  return plansWithAlternatives.map((plan) => {
    const globalBonus = calculateGlobalBonus(state, plan.facility, alternativeContext);
    const remoteEfficiencyBonus = calculateRemoteFacilityEfficiencyBonus(plan.facility, alternativeContext);
    return {
      ...plan,
      alternativeExpectedEfficiency: effectiveFacilityEfficiency(plan.alternatives) + globalBonus + remoteEfficiencyBonus
    };
  });
}

function buildAlternativeFacilityPlans(
  state: AppState,
  facilityPlans: FacilityPlan[],
  firstRotationOperatorIds: Set<string>,
  contextAssignments: Assignment[]
) {
  const alternativePlans = buildFacilityPlans(
    state,
    facilityPlans.map((plan) => plan.facility),
    contextAssignments,
    firstRotationOperatorIds
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

function buildRotationWindows(activeAssignments: Assignment[], alternativeAssignments: Assignment[], _rotationCount = 2) {
  return [
    {
      label: "1回目ローテーション",
      hours: 12,
      assignments: activeAssignments.filter((assignment) => assignment.fatigueHours > 0),
      recovery: alternativeAssignments.filter((assignment) => assignment.fatigueHours > 0)
    },
    {
      label: "2回目ローテーション",
      hours: 12,
      assignments: alternativeAssignments.filter((assignment) => assignment.fatigueHours > 0),
      recovery: activeAssignments.filter((assignment) => assignment.fatigueHours > 0)
    }
  ];
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
    shiftHours: context?.shiftHours ?? rotationShiftHours(state.rotationCount)
  };

  return operators
    .flatMap((operator) => {
      const rosterEntry = state.roster[operator.id];
      if (!rosterEntry?.owned) {
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
      const scalingMultiplier = complexHandler?.scalingMultiplier?.(handlerInput) ?? effectScalingMultiplier(effect, operator, elite, facility, context);
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
      const orderLimit = activeFacilityLimit(operator, elite, facility, context, "orderLimit");
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
              : variantEffectiveEfficiency * productMultiplier * facilityWeight(facility),
          efficiency: variantEffectiveEfficiency,
          storageLimit,
          orderLimit,
          ...(effect.suppressesOtherFactoryEfficiency ? { suppressesOtherFactoryEfficiency: true } : {}),
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
          reason: `${localizeText(skill.name, language)}: ${localizeText(effect.description, language)}`
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
      remoteFacilityCountBonuses
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
    shiftHours: rotationShiftHours(state.rotationCount)
  });
  const activeContext = createContext(activeSourceAssignments);
  const alternativeContext = createContext(alternativeSourceAssignments);
  const activeAssignments = activeSourceAssignments.map((assignment) =>
    applyMoraleDurationToAssignment(assignment, state, activeContext, alternativeContext)
  );
  const alternativeAssignments = alternativeSourceAssignments.map((assignment) =>
    applyMoraleDurationToAssignment(assignment, state, alternativeContext, activeContext)
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
      expectedEfficiency: effectiveFacilityEfficiency(plan.assignments) + activeBonus,
      score: effectiveFacilityScore(plan.assignments, plan.facility, state.preference, activeBonus),
      alternativeExpectedEfficiency: effectiveFacilityEfficiency(plan.alternatives) + alternativeBonus
    };
  });
}

function assignmentIdentity(assignment: Assignment) {
  return `${assignment.facilityId}:${assignment.operatorId}:${assignment.skillId}`;
}

function applyMoraleDurationToAssignment(
  assignment: Assignment,
  state: AppState,
  context: AssignmentEvaluationContext,
  recoveryWorkingContext: AssignmentEvaluationContext
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
    recoveryWorkingContext
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
    shiftUptime: consumptionPerHour === 0 ? 1 : Math.min(moraleCapacity / consumptionPerHour / shiftHours, 1),
    fatigueHours: consumptionPerHour === 0 ? Number.POSITIVE_INFINITY : moraleCapacity / consumptionPerHour,
    recoveryHours: moraleSpent / dormitoryRecoveryPerHour
  };
}

function bestDormitoryRecoveryPerHour(
  targetOperatorId: string,
  state: AppState,
  workingContext: AssignmentEvaluationContext
) {
  const workingOperatorIds = new Set(workingContext.assignments.map((assignment) => assignment.operatorId));
  const dormitory =
    state.facilities.find((facility) => facility.type === "dormitory") ??
    ({ id: "dormitory-recovery", type: "dormitory", name: "Dormitory", slotCount: 5, product: "morale" } satisfies FacilitySlot);
  const targetOperator = operators.find((operator) => operator.id === targetOperatorId);
  const targetRosterEntry = targetOperator ? state.roster[targetOperatorId] : undefined;
  let selfRecovery = 0;
  let strongestRoomRecovery = 0;
  let strongestSingleRecovery = 0;

  for (const operator of operators) {
    const rosterEntry = state.roster[operator.id];
    if (!rosterEntry?.owned || (workingOperatorIds.has(operator.id) && operator.id !== targetOperatorId)) {
      continue;
    }
    const dormAssignments: Assignment[] = [
      ...workingContext.assignments,
      {
        facilityId: dormitory.id,
        operatorId: operator.id,
        skillId: "dormitory-manager",
        score: 0,
        efficiency: 0,
        fatigueHours: 0,
        recoveryHours: 0,
        reason: "Dormitory manager"
      },
      ...(operator.id === targetOperatorId
        ? []
        : [
            {
              facilityId: dormitory.id,
              operatorId: targetOperatorId,
              skillId: "dormitory-target",
              score: 0,
              efficiency: 0,
              fatigueHours: 0,
              recoveryHours: 0,
              reason: "Dormitory target"
            } satisfies Assignment
          ])
    ];
    const dormContext: AssignmentEvaluationContext = {
      ...workingContext,
      assignments: dormAssignments,
      facilities: state.facilities.some((facility) => facility.id === dormitory.id)
        ? state.facilities
        : [...state.facilities, dormitory]
    };
    for (const entry of activeMoraleEffects(operator, rosterEntry, dormitory, dormContext)) {
      const multiplier = effectScalingMultiplier(
        entry.effect,
        operator,
        clampEliteForOperator(operator, rosterEntry.elite),
        dormitory,
        dormContext
      );
      const amount = entry.moraleEffect.amount * multiplier;
      if (entry.moraleEffect.type !== "recovery") {
        continue;
      }
      if (operator.id === targetOperatorId && entry.moraleEffect.target === "self") {
        selfRecovery = Math.max(selfRecovery, amount);
      }
      if (entry.moraleEffect.target === "room") {
        strongestRoomRecovery = Math.max(strongestRoomRecovery, amount);
      }
      if (
        operator.id !== targetOperatorId &&
        (entry.moraleEffect.target === "other" || entry.moraleEffect.target === "singleOther")
      ) {
        strongestSingleRecovery = Math.max(strongestSingleRecovery, amount);
      }
    }
  }

  let crossDormitoryRecovery = 0;
  for (const sourceAssignment of workingContext.assignments) {
    const sourceFacility = state.facilities.find((facility) => facility.id === sourceAssignment.facilityId);
    const sourceOperator = operators.find((operator) => operator.id === sourceAssignment.operatorId);
    const rosterEntry = sourceOperator ? state.roster[sourceOperator.id] : undefined;
    if (!sourceFacility || !sourceOperator || !rosterEntry) {
      continue;
    }
    for (const entry of activeMoraleEffects(sourceOperator, rosterEntry, sourceFacility, workingContext)) {
      if (entry.moraleEffect.type === "recovery" && entry.moraleEffect.target === "dormitories") {
        crossDormitoryRecovery = Math.max(crossDormitoryRecovery, entry.moraleEffect.amount);
      }
    }
  }

  if (!targetOperator || !targetRosterEntry) {
    return maxDormitoryRecoveryPerHour;
  }
  return maxDormitoryRecoveryPerHour + selfRecovery + strongestRoomRecovery + strongestSingleRecovery + crossDormitoryRecovery;
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
  remoteFacilityCountBonuses: NonNullable<Assignment["remoteFacilityCountBonuses"]>
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

  return {
    ...first,
    skillId: assignments.map((assignment) => assignment.skillId).join("+"),
    score: assignments.reduce((sum, assignment) => sum + assignment.score, commonRemoteScore),
    efficiency: assignments.reduce((sum, assignment) => sum + assignment.efficiency, 0),
    storageLimit: first.storageLimit,
    orderLimit: first.orderLimit,
    suppressesOtherFactoryEfficiency: assignments.some((assignment) => assignment.suppressesOtherFactoryEfficiency) || undefined,
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

export function activeBaseSkills(operator: Operator, elite: number, level: number): BaseSkill[] {
  const clampedElite = clampEliteForOperator(operator, elite);
  const normalizedLevel = Number.isFinite(level) ? Math.max(1, Math.trunc(level)) : 1;
  const activeBySlot = new Map<number, BaseSkill>();

  for (const skill of operator.skills) {
    const phaseUnlocked = skill.unlockPhase < clampedElite;
    const levelUnlocked = skill.unlockPhase === clampedElite && skill.unlockLevel <= normalizedLevel;
    if (!phaseUnlocked && !levelUnlocked) {
      continue;
    }

    const selected = activeBySlot.get(skill.slot);
    if (
      !selected ||
      skill.unlockPhase > selected.unlockPhase ||
      (skill.unlockPhase === selected.unlockPhase && skill.unlockLevel > selected.unlockLevel)
    ) {
      activeBySlot.set(skill.slot, skill);
    }
  }

  return [...activeBySlot.values()].sort((a, b) => a.slot - b.slot);
}

function activeFacilityLimit(
  operator: Operator,
  elite: number,
  facility: FacilitySlot,
  context: AssignmentEvaluationContext | undefined,
  key: "storageLimit" | "orderLimit"
) {
  const activeLimits = activeBaseSkills(operator, elite, context?.roster?.[operator.id]?.level ?? 1)
    .flatMap((skill) => skill.effects)
    .filter((effect) => !effect.ignoredForOptimization)
    .filter(
      (effect) =>
        effectMatchesFacility(effect, facility) &&
        effectConditionsSatisfied(effect, operator, facility, context) &&
        effectActivationPossibleDuringShift(effect, context)
    )
    .map((effect) => effect[key])
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

function effectiveFacilityEfficiency(assignments: Assignment[]) {
  const suppressingAssignments = assignments.filter((assignment) => assignment.suppressesOtherFactoryEfficiency);
  const countedAssignments = suppressingAssignments.length ? suppressingAssignments : assignments;
  return countedAssignments.reduce((sum, assignment) => {
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
    return sum + (assignment.efficiency + teamScalingAdjustment) * (assignment.shiftUptime ?? 1);
  }, 0);
}

function effectiveFacilityScore(assignments: Assignment[], facility: FacilitySlot, preference: OptimizationPreference, globalBonus = 0) {
  return (effectiveFacilityEfficiency(assignments) + globalBonus) * productWeight(facility.product, preference) * facilityWeight(facility);
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
) {
  if (!effect.scaling) {
    return 1;
  }

  if (effect.scaling.type === "fixed") {
    return effect.scaling.count ?? 0;
  }

  if (effect.scaling.type === "facilityLevel") {
    const level = maxFacilityLevelByType[effect.scaling.facility ?? facility.type];
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

function facilityAssignmentStat(
  effect: BaseSkillEffect,
  operator: Operator,
  elite: number,
  facility: FacilitySlot,
  context: AssignmentEvaluationContext | undefined,
  key: "storageLimit" | "orderLimit"
) {
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

function calculateRemoteFacilityEfficiencyBonus(facility: FacilitySlot, context: AssignmentEvaluationContext): number {
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

function resourceAmount(resource: string, context?: AssignmentEvaluationContext, candidateOperator?: Operator, candidateFacility?: FacilitySlot) {
  if (!context) {
    return 0;
  }

  const assignedResource = context.assignments.reduce((sum, assignment) => {
    if (candidateOperator && assignment.operatorId === candidateOperator.id) {
      return sum;
    }
    const operator = operators.find((candidate) => candidate.id === assignment.operatorId);
    const facility = context.facilities.find((candidate) => candidate.id === assignment.facilityId);
    if (!operator || !facility) {
      return sum;
    }

    return sum + resourceAmountFromOperator(resource, operator, facility, context);
  }, 0);

  const candidateResource =
    candidateOperator && candidateFacility ? resourceAmountFromOperator(resource, candidateOperator, candidateFacility, context) : 0;

  return assignedResource + candidateResource;
}

function resourceAmountFromOperator(resource: string, operator: Operator, facility: FacilitySlot, context: AssignmentEvaluationContext) {
  const effects = activeBaseSkills(
    operator,
    context.roster?.[operator.id]?.elite ?? 0,
    context.roster?.[operator.id]?.level ?? 1
  )
    .flatMap((skill) => skill.effects)
    .filter((effect) => effectMatchesFacility(effect, facility) && effect.resourceEffects?.some((resourceEffect) => resourceEffect.resource === resource))
    .filter((effect) => effectConditionsSatisfied(effect, operator, facility, context));

  return effects.reduce(
    (effectSum, effect) =>
      effectSum +
      (effect.resourceEffects ?? [])
        .filter((resourceEffect) => resourceEffect.resource === resource)
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
) {
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
