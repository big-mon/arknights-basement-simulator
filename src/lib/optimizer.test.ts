import { describe, expect, it } from "vitest";
import { createDefaultState, createFacilitiesForLayout, operators } from "../data/defaults";
import { exportState, importState } from "./storage";
import { findCandidates, generateAssignmentPlan } from "./optimizer";

const factoryEliteLockedOperator = operators.find((operator) =>
  operator.skills.some(
    (skill) =>
      skill.unlockPhase > 0 &&
      skill.effects.some((effect) => effect.facility === "factory" && (!effect.product || effect.product === "gold"))
  )
)!;
const factoryEliteLockedSkill = factoryEliteLockedOperator.skills.find(
  (skill) =>
    skill.unlockPhase > 0 &&
    skill.effects.some((effect) => effect.facility === "factory" && (!effect.product || effect.product === "gold"))
)!;
const defaultOwnedGoldFactoryOperator = operators.find((operator) =>
  operator.rarity <= 4 &&
  operator.skills.some(
    (skill) =>
      skill.unlockPhase === 0 &&
      skill.effects.some((effect) => effect.facility === "factory" && (!effect.product || effect.product === "gold"))
  )
)!;

function ownBaselineRoster(state: ReturnType<typeof createDefaultState>) {
  for (const operator of operators) {
    if (operator.rarity <= 4) {
      state.roster[operator.id].owned = true;
      state.roster[operator.id].elite = operator.rarity <= 3 ? 1 : 0;
    }
  }
}

describe("optimizer", () => {
  it("filters candidates by facility type and unlocked elite phase", () => {
    const state = createDefaultState();
    ownBaselineRoster(state);
    const factory = state.facilities.find((facility) => facility.id === "factory-1")!;
    const candidates = findCandidates(factory, state);

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((candidate) => candidate.facilityId === factory.id)).toBe(true);
    expect(candidates.some((candidate) => candidate.operatorId === factoryEliteLockedOperator.id)).toBe(false);

    state.roster[factoryEliteLockedOperator.id] = {
      ...state.roster[factoryEliteLockedOperator.id],
      owned: true,
      elite: factoryEliteLockedSkill.unlockPhase
    };

    expect(findCandidates(factory, state).some((candidate) => candidate.operatorId === factoryEliteLockedOperator.id)).toBe(true);
  });

  it("changes score priority when material weights change", () => {
    const state = createDefaultState();
    ownBaselineRoster(state);
    const baselinePlan = generateAssignmentPlan(state);
    const baselineGoldScore = baselinePlan.facilityPlans.find((plan) => plan.facility.id === "factory-1")!.score;

    state.preference = { gold: 1, battleRecord: 0.05, lmd: 0.05 };
    const goldFocusedPlan = generateAssignmentPlan(state);
    const goldFocusedScore = goldFocusedPlan.facilityPlans.find((plan) => plan.facility.id === "factory-1")!.score;

    expect(goldFocusedScore).toBeGreaterThan(baselineGoldScore);
  });

  it("does not change base scores from potential", () => {
    const state = createDefaultState();
    const factory = state.facilities.find((facility) => facility.id === "factory-1")!;
    state.roster[defaultOwnedGoldFactoryOperator.id].owned = true;
    state.roster[defaultOwnedGoldFactoryOperator.id].elite = 0;
    state.roster[defaultOwnedGoldFactoryOperator.id].potential = 1;
    const baseScore = findCandidates(factory, state).find((candidate) => candidate.operatorId === defaultOwnedGoldFactoryOperator.id)!
      .score;

    state.roster[defaultOwnedGoldFactoryOperator.id].potential = 6;
    const maxPotentialScore = findCandidates(factory, state).find(
      (candidate) => candidate.operatorId === defaultOwnedGoldFactoryOperator.id
    )!.score;

    expect(maxPotentialScore).toBe(baseScore);
  });

  it("does not change base scores from level or module state", () => {
    const state = createDefaultState();
    const factory = state.facilities.find((facility) => facility.id === "factory-1")!;
    state.roster[defaultOwnedGoldFactoryOperator.id].owned = true;
    state.roster[defaultOwnedGoldFactoryOperator.id].elite = 0;
    state.roster[defaultOwnedGoldFactoryOperator.id].level = 1;
    state.roster[defaultOwnedGoldFactoryOperator.id].moduleEnabled = false;
    const baseScore = findCandidates(factory, state).find((candidate) => candidate.operatorId === defaultOwnedGoldFactoryOperator.id)!
      .score;

    state.roster[defaultOwnedGoldFactoryOperator.id].level = 90;
    state.roster[defaultOwnedGoldFactoryOperator.id].moduleEnabled = true;
    const maxedScore = findCandidates(factory, state).find((candidate) => candidate.operatorId === defaultOwnedGoldFactoryOperator.id)!
      .score;

    expect(maxedScore).toBe(baseScore);
  });

  it("uses a two-window rotation plan by default", () => {
    const state = createDefaultState();
    ownBaselineRoster(state);
    const plan = generateAssignmentPlan(state);

    expect(state.rotationCount).toBe(2);
    expect(plan.rotation).toHaveLength(2);
    expect(plan.rotation[0].assignments.length).toBeGreaterThan(0);
    expect(plan.rotation[1].recovery.length).toBeGreaterThan(0);
  });

  it("excludes dormitories from production assignment plans", () => {
    const state = createDefaultState();
    ownBaselineRoster(state);
    const plan = generateAssignmentPlan(state);

    expect(state.facilities.some((facility) => facility.type === "dormitory")).toBe(true);
    expect(plan.facilityPlans.every((facilityPlan) => facilityPlan.facility.type !== "dormitory")).toBe(true);
  });

  it("round-trips exported state json", () => {
    const state = createDefaultState();
    state.roster.char_002_amiya.owned = true;
    state.roster.char_002_amiya.elite = 2;
    state.language = "en";
    state.layout = "153";
    state.rotationCount = 2;
    state.facilities = createFacilitiesForLayout("153", state.facilities);

    const restored = importState(exportState(state));

    expect(restored.roster.char_002_amiya.owned).toBe(true);
    expect(restored.roster.char_002_amiya.elite).toBe(2);
    expect(restored.language).toBe("en");
    expect(restored.layout).toBe("153");
    expect(restored.rotationCount).toBe(2);
    expect(restored.facilities).toHaveLength(state.facilities.length);
  });
});
