import { describe, expect, it } from "vitest";
import { createDefaultState, createFacilitiesForLayout } from "../data/defaults";
import { exportState, importState } from "./storage";
import { findCandidates, generateAssignmentPlan } from "./optimizer";

describe("optimizer", () => {
  it("filters candidates by facility type and unlocked elite phase", () => {
    const state = createDefaultState();
    const factory = state.facilities.find((facility) => facility.id === "factory-1")!;
    const candidates = findCandidates(factory, state);

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((candidate) => candidate.facilityId === factory.id)).toBe(true);
    expect(candidates.some((candidate) => candidate.operatorId === "char_235_jesica")).toBe(false);

    state.roster.char_235_jesica = {
      ...state.roster.char_235_jesica,
      owned: true,
      elite: 1
    };

    expect(findCandidates(factory, state).some((candidate) => candidate.operatorId === "char_235_jesica")).toBe(true);
  });

  it("changes score priority when material weights change", () => {
    const state = createDefaultState();
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
    state.roster.char_237_gravel.potential = 1;
    const baseScore = findCandidates(factory, state).find((candidate) => candidate.operatorId === "char_237_gravel")!.score;

    state.roster.char_237_gravel.potential = 6;
    const maxPotentialScore = findCandidates(factory, state).find((candidate) => candidate.operatorId === "char_237_gravel")!.score;

    expect(maxPotentialScore).toBe(baseScore);
  });

  it("includes fatigue and recovery windows in the rotation plan", () => {
    const state = createDefaultState();
    const plan = generateAssignmentPlan(state);

    expect(plan.rotation).toHaveLength(3);
    expect(plan.rotation[0].assignments.length).toBeGreaterThan(0);
    expect(plan.rotation[2].recovery.length).toBeGreaterThan(0);
  });

  it("round-trips exported state json", () => {
    const state = createDefaultState();
    state.roster.char_002_amiya.owned = true;
    state.roster.char_002_amiya.elite = 2;
    state.layout = "153";
    state.facilities = createFacilitiesForLayout("153", state.facilities);

    const restored = importState(exportState(state));

    expect(restored.roster.char_002_amiya.owned).toBe(true);
    expect(restored.roster.char_002_amiya.elite).toBe(2);
    expect(restored.layout).toBe("153");
    expect(restored.facilities).toHaveLength(state.facilities.length);
  });
});
