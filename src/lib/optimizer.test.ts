import { describe, expect, it } from "vitest";
import { createDefaultState, createFacilitiesForLayout, operators } from "../data/defaults";
import { exportState, importState } from "./storage";
import { findCandidates, generateAssignmentPlan } from "./optimizer";
import type { Assignment, FacilitySlot } from "../types";

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
const texas = operators.find((operator) => operator.id === "char_102_texas")!;
const lappland = operators.find((operator) => operator.id === "char_140_whitew")!;
const texasLapplandSkill = texas.skills.find((skill) => skill.id === "trade_ord_spd&cost_P[000]")!;
const leto = operators.find((operator) => operator.id === "char_194_leto")!;
const gummy = operators.find((operator) => operator.id === "char_196_sunbr")!;
const letoGummySkill = leto.skills.find((skill) => skill.id === "manu_formula_spd_P[000]")!;
const delphine = operators.find((operator) => operator.id === "char_4110_delphn")!;
const glasgowOperator = operators.find((operator) => operator.id === "char_154_morgan")!;
const delphineGlasgowSkill = delphine.skills.find((skill) => skill.id === "control_tra_limit&spd[010]")!;

function ownBaselineRoster(state: ReturnType<typeof createDefaultState>) {
  for (const operator of operators) {
    if (operator.rarity <= 4) {
      state.roster[operator.id].owned = true;
      state.roster[operator.id].elite = operator.rarity <= 3 ? 1 : 0;
    }
  }
}

function ownOperators(state: ReturnType<typeof createDefaultState>, operatorIds: string[]) {
  for (const operatorId of operatorIds) {
    state.roster[operatorId].owned = true;
    state.roster[operatorId].elite = 2;
  }
}

function contextAssignment(facility: FacilitySlot, operatorId: string): Assignment {
  return {
    facilityId: facility.id,
    operatorId,
    skillId: "context",
    score: 0,
    efficiency: 0,
    fatigueHours: 0,
    recoveryHours: 0,
    reason: "context"
  };
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

  it("requires named operators in the same facility for same-room conditional skills", () => {
    const state = createDefaultState();
    ownOperators(state, [texas.id, lappland.id]);
    const trading = state.facilities.find((facility) => facility.id === "trading-1")!;

    expect(findCandidates(trading, state).some((candidate) => candidate.skillId === texasLapplandSkill.id)).toBe(false);
    expect(
      findCandidates(trading, state, 0, {
        facilities: state.facilities,
        assignments: [contextAssignment(trading, lappland.id)]
      }).some((candidate) => candidate.skillId === texasLapplandSkill.id)
    ).toBe(true);
  });

  it("requires named operators in referenced facilities for cross-facility conditional skills", () => {
    const state = createDefaultState();
    ownOperators(state, [leto.id, gummy.id]);
    const factory = state.facilities.find((facility) => facility.id === "factory-2")!;
    const trading = state.facilities.find((facility) => facility.id === "trading-1")!;

    expect(factory.product).toBe("battleRecord");
    expect(findCandidates(factory, state).some((candidate) => candidate.skillId === letoGummySkill.id)).toBe(false);
    expect(
      findCandidates(factory, state, 0, {
        facilities: state.facilities,
        assignments: [contextAssignment(trading, gummy.id)]
      }).some((candidate) => candidate.skillId === letoGummySkill.id)
    ).toBe(true);
  });

  it("requires matching affiliation operators for faction conditional skills", () => {
    const state = createDefaultState();
    ownOperators(state, [delphine.id, glasgowOperator.id]);
    const control = state.facilities.find((facility) => facility.id === "control-1")!;
    const trading = state.facilities.find((facility) => facility.id === "trading-1")!;

    expect(glasgowOperator.affiliations).toContain("glasgow");
    expect(findCandidates(control, state).some((candidate) => candidate.skillId === delphineGlasgowSkill.id)).toBe(false);
    expect(
      findCandidates(control, state, 0, {
        facilities: state.facilities,
        assignments: [contextAssignment(trading, glasgowOperator.id)]
      }).some((candidate) => candidate.skillId === delphineGlasgowSkill.id)
    ).toBe(true);
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
