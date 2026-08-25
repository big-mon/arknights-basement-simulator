import { beforeAll, describe, expect, it } from "vitest";
import { createDefaultState } from "../data/defaults";
import jpFixtureJson from "../data/optimizer-benchmarks/jp-243-factory-3group-2025-11.json";
import { availableOperatorIds, operatorAvailabilitySnapshot } from "./operatorAvailability";
import { effectiveBenchmarkScheduleAuthority, validateOptimizerBenchmark } from "./optimizerBenchmark";
import { evaluateCandidateObjectiveEvidence } from "./optimizerIssue27Audit";
import { evaluateReferenceCompositionDiagnostic } from "./optimizerReferenceDiagnostic";
import { validateSchedule } from "./schedule";
import {
  buildFacilityTeamOptionSet,
  evaluateWindowFacilityEfficiencies,
  findCandidates,
  generateAssignmentPlan,
  inspectExplicitFacilityTeams,
  materializeScheduleAwareRotation
} from "./optimizer";
import type { AppState, FacilitySlot, ScheduleState } from "../types";

const simpleFactoryOperatorIds = ["char_241_panda", "char_159_peacok", "char_4054_malist"] as const;

function syntheticProductionState(
  schedule: ScheduleState,
  operatorIds: readonly string[] = simpleFactoryOperatorIds,
  facilities: FacilitySlot[] = [
    { id: "factory-a", type: "factory", name: "Factory A", slotCount: 1, product: "battleRecord" },
    { id: "factory-b", type: "factory", name: "Factory B", slotCount: 1, product: "battleRecord" }
  ]
): AppState {
  const state = createDefaultState();
  state.schedule = structuredClone(schedule);
  state.facilities = structuredClone(facilities);
  for (const entry of Object.values(state.roster)) entry.owned = false;
  for (const operatorId of operatorIds) {
    state.roster[operatorId].owned = true;
    state.roster[operatorId].elite = 2;
  }
  return state;
}

const overlappingThreeGroupSchedule: ScheduleState = {
  cycleHours: 12,
  groups: [{ id: "A" }, { id: "B" }, { id: "C" }],
  shifts: [
    { id: "a-b", startHour: 0, endHour: 4, activeGroupIds: ["A", "B"], recoveryGroupIds: ["C"] },
    { id: "b-c", startHour: 4, endHour: 8, activeGroupIds: ["B", "C"], recoveryGroupIds: ["A"] },
    { id: "c-a", startHour: 8, endHour: 12, activeGroupIds: ["C", "A"], recoveryGroupIds: ["B"] }
  ]
};

function jpFixture() {
  const validated = validateOptimizerBenchmark(jpFixtureJson);
  if (!validated.ok || validated.value.kind !== "resource-output") throw new Error("invalid JP fixture");
  return validated.value;
}

function allOwnedJpState(): AppState {
  const fixture = jpFixture();
  const authority = effectiveBenchmarkScheduleAuthority(fixture);
  if (authority.status === "incomplete") throw new Error(authority.errors.join("\n"));
  const state = createDefaultState();
  state.region = "JP";
  state.preference = { gold: 0.5, battleRecord: 0.5, lmd: 0 };
  state.schedule = {
    cycleHours: authority.schedule.cycleHours,
    groups: structuredClone(authority.schedule.groups),
    shifts: authority.schedule.shifts.map(({ id, startHour, endHour, activeGroupIds, recoveryGroupIds }) => ({
      id, startHour, endHour, activeGroupIds: [...activeGroupIds], recoveryGroupIds: [...recoveryGroupIds]
    }))
  };
  const available = new Set(availableOperatorIds(operatorAvailabilitySnapshot, "JP"));
  for (const [operatorId, entry] of Object.entries(state.roster)) entry.owned = available.has(operatorId);
  return state;
}

function jointSupportBasinState(): AppState {
  const state = allOwnedJpState();
  const ownedOperatorIds = new Set([
    "char_241_panda", "char_159_peacok", "char_4054_malist",
    "char_431_ashlok", "char_496_wildmn", "char_430_fartth",
    "char_485_pallas", "char_336_folivo", "char_190_clour",
    "char_1031_slent2", "char_242_otter", "char_4062_totter",
    "char_003_kalts", "char_420_flamtl", "char_4098_vvana"
  ]);
  for (const [operatorId, entry] of Object.entries(state.roster)) {
    entry.owned = ownedOperatorIds.has(operatorId);
    entry.elite = 2;
  }
  state.facilities = state.facilities.filter((facility) =>
    facility.id === "factory-3" || facility.id === "factory-4" || facility.id === "control-1"
  );
  const control = state.facilities.find((facility) => facility.id === "control-1");
  if (!control) throw new Error("missing control center");
  control.slotCount = 1;
  return state;
}

function combinedSupportBasinState(): AppState {
  const state = allOwnedJpState();
  const ownedOperatorIds = new Set([
    "char_241_panda", "char_431_ashlok", "char_400_weedy",
    "char_1027_greyy2", "char_420_flamtl", "char_4098_vvana"
  ]);
  for (const [operatorId, entry] of Object.entries(state.roster)) {
    entry.owned = ownedOperatorIds.has(operatorId);
    entry.elite = 2;
  }
  state.facilities = state.facilities.filter((facility) =>
    facility.id === "factory-3" || facility.id === "factory-4" ||
    facility.id === "power-1" || facility.id === "control-1"
  );
  for (const facility of state.facilities) {
    if (facility.type === "factory") {
      facility.product = "battleRecord";
      facility.slotCount = 1;
    }
    if (facility.type === "power" || facility.type === "control") facility.slotCount = 1;
  }
  return state;
}

type JointSupportDiagnostic = Extract<ReturnType<typeof generateAssignmentPlan>["diagnostics"][number], {
  code: "joint-support-search-not-certified";
}>;

type ScheduledSupportProfile = Extract<ReturnType<typeof generateAssignmentPlan>["diagnostics"][number], {
  code: "scheduled-support-profile";
}>;

function jointSupportDiagnostic(plan: ReturnType<typeof generateAssignmentPlan>) {
  const diagnostic = plan.diagnostics.find((item): item is JointSupportDiagnostic =>
    item.code === "joint-support-search-not-certified"
  );
  if (!diagnostic) throw new Error("missing joint support diagnostic");
  return diagnostic;
}

function materialProduction(plan: ReturnType<typeof generateAssignmentPlan>) {
  return [...new Set(plan.rotation.flatMap((window) => window.assignments
    .filter((assignment) => assignment.facilityId.startsWith("factory-"))
    .map((assignment) => assignment.operatorId)))].sort();
}

function scheduledSupportEvidence(plan: ReturnType<typeof generateAssignmentPlan>) {
  const diagnostic = plan.diagnostics.find((item): item is ScheduledSupportProfile =>
    item.code === "scheduled-support-profile"
  );
  if (!diagnostic) throw new Error("missing scheduled support diagnostic");
  return diagnostic;
}

function scheduleAwareAssignmentSnapshot(rotation: ReturnType<typeof generateAssignmentPlan>["rotation"]) {
  return rotation.map((window) => ({
    shiftId: window.shiftId,
    assignments: window.assignments.map((assignment) => ({
      operatorId: assignment.operatorId,
      efficiency: assignment.efficiency,
      moraleConsumptionPerHour: assignment.moraleConsumptionPerHour,
      dormitoryRecoveryPerHour: assignment.dormitoryRecoveryPerHour,
      recoveryProvenance: assignment.recoveryProvenance,
      shiftUptime: assignment.shiftUptime,
      fatigueHours: assignment.fatigueHours,
      recoveryHours: assignment.recoveryHours
    }))
  }));
}

describe("Issue #28 schedule-aware composition integration", () => {
  describe("contiguous cyclic duration mechanics", () => {
    it("selects the higher contiguous-block option when reset-window ranking would choose the other team", () => {
      const sixHourWindows: ScheduleState = {
        cycleHours: 18,
        groups: structuredClone(overlappingThreeGroupSchedule.groups),
        shifts: overlappingThreeGroupSchedule.shifts.map((shift) => ({
          ...structuredClone(shift),
          startHour: shift.startHour * 1.5,
          endHour: shift.endHour * 1.5
        }))
      };
      const state = syntheticProductionState(
        sixHourWindows,
        ["char_446_aroma", "char_122_beagle", "char_123_fang", "char_124_kroos"]
      );
      const facility = state.facilities[0];
      const resetCandidates = findCandidates(facility, state, 0, {
        assignments: [],
        facilities: state.facilities,
        roster: state.roster,
        shiftHours: 6
      });
      const resetEfficiency = (operatorId: string) =>
        resetCandidates.find((assignment) => assignment.operatorId === operatorId)?.efficiency;

      expect(resetEfficiency("char_446_aroma")).toBeCloseTo(0.05, 12);
      expect(resetEfficiency("char_122_beagle")).toBeCloseTo(0.1, 12);
      expect(resetEfficiency("char_122_beagle")!).toBeGreaterThan(resetEfficiency("char_446_aroma")!);

      const plan = generateAssignmentPlan(state);
      const selected = new Set(plan.rotation.flatMap((window) =>
        window.assignments.map((assignment) => assignment.operatorId)
      ));
      const aromaEfficiencies = plan.rotation.flatMap((window) => window.assignments
        .filter((assignment) => assignment.operatorId === "char_446_aroma")
        .map((assignment) => assignment.efficiency));

      expect(selected).toContain("char_446_aroma");
      expect(selected).not.toContain("char_122_beagle");
      expect(aromaEfficiencies).toEqual([expect.closeTo(0.05, 12), expect.closeTo(1 / 6, 12)]);
      expect(aromaEfficiencies.reduce((sum, efficiency) => sum + efficiency, 0) / aromaEfficiencies.length)
        .toBeGreaterThan(resetEfficiency("char_122_beagle")!);
    });

    it("continues a time curve across adjacent work windows and resets it after recovery", () => {
      const state = syntheticProductionState(
        overlappingThreeGroupSchedule,
        ["char_446_aroma", "char_123_fang", "char_124_kroos"]
      );

      const plan = generateAssignmentPlan(state);
      const aromaSegments = plan.rotation
        .filter((window) => window.assignments.some((assignment) => assignment.operatorId === "char_446_aroma"))
        .map((window) => ({
          shiftId: window.shiftId,
          efficiency: window.assignments.find((assignment) => assignment.operatorId === "char_446_aroma")!.efficiency
        }));

      expect(aromaSegments).toHaveLength(2);
      expect(aromaSegments.map(({ efficiency }) => efficiency).sort((left, right) => left - right))
        .toEqual([expect.closeTo(0.03, 12), expect.closeTo(0.11, 12)]);
    });

    it("carries morale spent into the next adjacent window's morale-curve segment", () => {
      const state = syntheticProductionState(
        overlappingThreeGroupSchedule,
        ["char_4062_totter", "char_123_fang", "char_124_kroos"]
      );

      const plan = generateAssignmentPlan(state);
      const efficiencies = plan.rotation
        .flatMap((window) => window.assignments
          .filter((assignment) => assignment.operatorId === "char_4062_totter")
          .map((assignment) => assignment.efficiency))
        .sort((left, right) => left - right);

      expect(efficiencies).toEqual([expect.closeTo(0.25, 12), expect.closeTo(0.3, 12)]);
    });

    it("keeps schedule-aware materialization and evidence idempotent without double duration adjustment", () => {
      const state = syntheticProductionState(
        overlappingThreeGroupSchedule,
        ["char_446_aroma", "char_123_fang", "char_124_kroos"]
      );
      const candidate = generateAssignmentPlan(state, { supportResourceScenario: { sources: [] } });
      if (!candidate.supportResourceScenario?.complete) throw new Error("synthetic support context is incomplete");

      const referenceRotation = materializeScheduleAwareRotation(
        state,
        candidate.rotation,
        candidate.supportResourceScenario
      );
      const twiceMaterializedRotation = materializeScheduleAwareRotation(
        state,
        referenceRotation,
        candidate.supportResourceScenario
      );
      const referenceEvaluations = evaluateWindowFacilityEfficiencies(
        state,
        candidate.facilityPlans,
        referenceRotation,
        candidate.supportResourceScenario
      );
      const twiceMaterializedEvaluations = evaluateWindowFacilityEfficiencies(
        state,
        candidate.facilityPlans,
        twiceMaterializedRotation,
        candidate.supportResourceScenario
      );

      expect(referenceRotation.map((window) => window.assignments.map(({ operatorId, efficiency }) => ({
        operatorId,
        efficiency
      })))).toEqual(candidate.rotation.map((window) => window.assignments.map(({ operatorId, efficiency }) => ({
        operatorId,
        efficiency
      }))));
      expect(twiceMaterializedRotation).toBe(referenceRotation);
      expect(twiceMaterializedRotation).toEqual(referenceRotation);
      expect(referenceEvaluations).toEqual(candidate.windowFacilityEfficiencyEvaluations);
      expect(twiceMaterializedEvaluations).toEqual(referenceEvaluations);
    });

    it("restores caller-mutated nested materialization data from pristine authoritative input", () => {
      const state = syntheticProductionState(
        overlappingThreeGroupSchedule,
        ["char_446_aroma", "char_123_fang", "char_124_kroos"]
      );
      const candidate = generateAssignmentPlan(state, { supportResourceScenario: { sources: [] } });
      if (!candidate.supportResourceScenario?.complete) throw new Error("synthetic support context is incomplete");
      const expected = scheduleAwareAssignmentSnapshot(candidate.rotation);
      const aroma = candidate.rotation
        .flatMap((window) => window.assignments)
        .find((assignment) => assignment.operatorId === "char_446_aroma");
      if (!aroma?.recoveryProvenance) throw new Error("missing materialized Aroma recovery provenance");

      aroma.efficiency = 999;
      aroma.moraleConsumptionPerHour = 999;
      aroma.recoveryHours = 999;
      aroma.recoveryProvenance = { ...aroma.recoveryProvenance, sources: [] };

      const restored = materializeScheduleAwareRotation(
        state,
        candidate.rotation,
        candidate.supportResourceScenario
      );
      const restoredAgain = materializeScheduleAwareRotation(
        state,
        restored,
        candidate.supportResourceScenario
      );

      expect(scheduleAwareAssignmentSnapshot(restored)).toEqual(expected);
      expect(scheduleAwareAssignmentSnapshot(restoredAgain)).toEqual(expected);
    });

    it("invalidates a marked rotation when relevant roster context changes in place", () => {
      const state = syntheticProductionState(
        overlappingThreeGroupSchedule,
        ["char_446_aroma", "char_123_fang", "char_124_kroos"]
      );
      const candidate = generateAssignmentPlan(state, { supportResourceScenario: { sources: [] } });
      if (!candidate.supportResourceScenario?.complete) throw new Error("synthetic support context is incomplete");
      const before = scheduleAwareAssignmentSnapshot(candidate.rotation);

      for (const entry of Object.values(state.roster)) {
        entry.owned = true;
        entry.elite = 2;
      }
      const reevaluated = materializeScheduleAwareRotation(
        state,
        candidate.rotation,
        candidate.supportResourceScenario
      );
      const after = scheduleAwareAssignmentSnapshot(reevaluated);

      expect(after).not.toEqual(before);
    });

    it("normalizes a structured clone without applying duration mechanics twice", () => {
      const state = syntheticProductionState(
        overlappingThreeGroupSchedule,
        ["char_446_aroma", "char_123_fang", "char_124_kroos"]
      );
      const candidate = generateAssignmentPlan(state, { supportResourceScenario: { sources: [] } });
      if (!candidate.supportResourceScenario?.complete) throw new Error("synthetic support context is incomplete");
      const expected = scheduleAwareAssignmentSnapshot(candidate.rotation);

      const cloned = structuredClone(candidate.rotation);
      const normalized = materializeScheduleAwareRotation(
        state,
        cloned,
        candidate.supportResourceScenario
      );
      const normalizedAgain = materializeScheduleAwareRotation(
        state,
        normalized,
        candidate.supportResourceScenario
      );

      expect(scheduleAwareAssignmentSnapshot(normalized)).toEqual(expected);
      expect(scheduleAwareAssignmentSnapshot(normalizedAgain)).toEqual(expected);

      const corruptClone = structuredClone(candidate.rotation);
      const provenance = corruptClone[0].scheduleAwareMaterialization;
      if (!provenance) throw new Error("structuredClone dropped typed schedule-aware provenance");
      provenance.sourceWindow.assignments[0].efficiency = 999;
      expect(() => materializeScheduleAwareRotation(
        state,
        corruptClone,
        candidate.supportResourceScenario
      )).toThrow("Invalid schedule-aware materialization provenance");
    });
  });

  describe("joint static support and rotating production", () => {
    it("uses a feasible combined scheduled-support context to cross two independent dependency basins", () => {
      const state = combinedSupportBasinState();
      const reversed = structuredClone(state);
      reversed.facilities.reverse();
      reversed.schedule.groups.reverse();
      reversed.roster = Object.fromEntries(Object.entries(reversed.roster).reverse());

      const plan = generateAssignmentPlan(state);
      const reversedPlan = generateAssignmentPlan(reversed);
      const diagnostic = jointSupportDiagnostic(plan);
      const selected = diagnostic.selectedSupportOperatorIds;

      expect(selected).toEqual(expect.arrayContaining(["char_1027_greyy2", "char_420_flamtl"]));
      expect(materialProduction(plan)).toEqual(expect.arrayContaining([
        "char_400_weedy", "char_431_ashlok"
      ]));
      expect(diagnostic.aggregateScore).toBeGreaterThan(diagnostic.initialAggregateScore);
      expect(diagnostic.retainedRequirementSignatures).toEqual(diagnostic.requirementSignatures);
      expect(diagnostic.discardedSeeds).toBeGreaterThanOrEqual(0);
      expect(diagnostic.seedCount).toBeLessThanOrEqual(diagnostic.seedLimit);

      const proofs = diagnostic.removalProofs.filter((proof) =>
        proof.supportOperatorId === "char_1027_greyy2" || proof.supportOperatorId === "char_420_flamtl"
      );
      expect(new Set(proofs.map((proof) => proof.supportOperatorId))).toEqual(
        new Set(["char_1027_greyy2", "char_420_flamtl"])
      );
      for (const proof of proofs) {
        const beneficiaryIds = proof.productionOperatorIds;
        expect(beneficiaryIds).toEqual(expect.arrayContaining(
          proof.supportOperatorId === "char_1027_greyy2"
            ? ["char_400_weedy"]
            : ["char_431_ashlok"]
        ));
        const inspection = inspectExplicitFacilityTeams(state, {
          teams: [{ facilityId: proof.productionFacilityId, operatorIds: beneficiaryIds }],
          supportPlacements: [{ facilityId: proof.supportFacilityId, operatorIds: [proof.supportOperatorId] }],
          evaluationHours: proof.windowHours
        });
        const removed = inspectExplicitFacilityTeams(state, {
          teams: [{ facilityId: proof.productionFacilityId, operatorIds: beneficiaryIds }],
          evaluationHours: proof.windowHours
        });
        expect(inspection.status).toBe("complete");
        expect(removed.status).toBe("complete");
        if (inspection.status === "complete" && removed.status === "complete") {
          expect(inspection.teams[0].expectedEfficiency).toBeCloseTo(proof.withSupportEfficiency, 12);
          expect(removed.teams[0].expectedEfficiency).toBeCloseTo(proof.withoutSupportEfficiency, 12);
        }
      }

      expect(jointSupportDiagnostic(reversedPlan).selectedSupportOperatorIds).toEqual(selected);
      expect(jointSupportDiagnostic(reversedPlan).aggregateScore).toBeCloseTo(diagnostic.aggregateScore, 12);
      expect(materialProduction(reversedPlan)).toEqual(materialProduction(plan));
    });

    it("retains every dependency requirement before applying the bounded combined-seed limit", () => {
      const plan = generateAssignmentPlan(combinedSupportBasinState());
      const diagnostic = jointSupportDiagnostic(plan);
      expect(diagnostic.requirementSignatures.length).toBeGreaterThan(2);
      expect(diagnostic.retainedRequirementSignatures).toEqual(diagnostic.requirementSignatures);
      expect(diagnostic.seedLimit).toBeGreaterThan(0);
      expect(diagnostic.discardedSeeds).toBeGreaterThanOrEqual(0);
      expect(diagnostic.provenance).toBe("bounded-joint-static-support-production-removal-proven");
    });

    it("crosses a coordinate basin with a physical support placement and is input-order invariant", () => {
      const state = jointSupportBasinState();
      const reversedState = structuredClone(state);
      reversedState.facilities.reverse();
      reversedState.schedule.groups.reverse();
      reversedState.roster = Object.fromEntries(Object.entries(reversedState.roster).reverse());

      const canonical = generateAssignmentPlan(state);
      const reversed = generateAssignmentPlan(reversedState);
      const diagnostic = jointSupportDiagnostic(canonical);
      const reversedDiagnostic = jointSupportDiagnostic(reversed);

      expect(diagnostic.initialSupportOperatorIds).not.toContain("char_420_flamtl");
      expect(diagnostic.selectedSupportOperatorIds).toContain("char_420_flamtl");
      expect(diagnostic.selectedSupportOperatorIds).not.toContain("char_4098_vvana");
      expect(materialProduction(canonical)).toEqual(expect.arrayContaining([
        "char_431_ashlok", "char_496_wildmn", "char_430_fartth"
      ]));
      expect(diagnostic.bestProductionOnlyAggregateScore).toBeLessThanOrEqual(diagnostic.initialAggregateScore);
      expect(diagnostic.bestStaticOnlyAggregateScore).toBeLessThanOrEqual(diagnostic.initialAggregateScore);
      expect(diagnostic.aggregateScore).toBeGreaterThan(diagnostic.initialAggregateScore);
      expect(diagnostic.rounds).toBeGreaterThan(0);
      expect(diagnostic.work).toBeGreaterThan(0);
      expect(diagnostic.startsEvaluated).toBeGreaterThan(1);

      expect(reversedDiagnostic.selectedSupportOperatorIds).toEqual(diagnostic.selectedSupportOperatorIds);
      expect(reversedDiagnostic.aggregateScore).toBeCloseTo(diagnostic.aggregateScore, 12);
      expect(materialProduction(reversed)).toEqual(materialProduction(canonical));

      const placement = scheduledSupportEvidence(canonical).supportPlacements.find((item) =>
        item.kind === "ordinary" && item.operatorId === "char_420_flamtl"
      );
      const proof = diagnostic.removalProofs.find((item) => item.supportOperatorId === "char_420_flamtl");
      expect(proof).toBeDefined();
      if (!placement || !proof) return;
      const beneficiaryGroups = state.schedule.groups.filter(({ id: groupId }) => {
        const activeShifts = state.schedule.shifts.filter((shift) => shift.activeGroupIds.includes(groupId));
        return activeShifts.length > 0 && activeShifts.every((shift) => {
          const assignments = canonical.rotation.find((window) => window.shiftId === shift.id)?.assignments ?? [];
          return state.facilities.some((facility) => facility.type === "factory" &&
            proof.productionOperatorIds.every((operatorId) => assignments.some((assignment) =>
              assignment.facilityId === facility.id && assignment.operatorId === operatorId
            )));
        });
      });
      expect(beneficiaryGroups).toHaveLength(1);
      const beneficiaryGroupId = beneficiaryGroups[0].id;
      const expectedWorkWindowIds = state.schedule.shifts
        .filter((shift) => shift.activeGroupIds.includes(beneficiaryGroupId))
        .map((shift) => shift.id);
      const expectedRecoveryWindowIds = state.schedule.shifts
        .filter((shift) => shift.recoveryGroupIds.includes(beneficiaryGroupId))
        .map((shift) => shift.id);
      expect(placement.groupId).toBe(beneficiaryGroupId);
      expect(placement.scheduleWindowIds).toEqual(expectedWorkWindowIds);
      expect(placement.recoveryWindowIds).toEqual(expectedRecoveryWindowIds);
      expect(scheduledSupportEvidence(reversed).supportPlacements.find((item) =>
        item.kind === "ordinary" && item.operatorId === placement.operatorId
      )).toEqual(placement);
      for (const shiftId of expectedRecoveryWindowIds) {
        expect(canonical.rotation.find((window) => window.shiftId === shiftId)?.assignments
          .map((assignment) => assignment.operatorId)).not.toContain(placement.operatorId);
      }
    });

    it("reports removal-proven support rather than treating an owned possible supporter as active", () => {
      const state = jointSupportBasinState();
      const plan = generateAssignmentPlan(state);
      const diagnostic = jointSupportDiagnostic(plan);
      const proof = diagnostic.removalProofs.find((item) => item.supportOperatorId === "char_420_flamtl");
      expect(proof).toBeDefined();
      if (!proof) return;

      const supportFacility = state.facilities.find((facility) => facility.id === proof.supportFacilityId);
      expect(supportFacility?.type).toBe("control");
      expect(state.roster[proof.supportOperatorId].owned).toBe(true);
      expect(plan.facilityPlans.find((facilityPlan) => facilityPlan.facility.id === proof.supportFacilityId)
        ?.assignments.map((assignment) => assignment.operatorId)).toContain(proof.supportOperatorId);
      expect(plan.facilityPlans.find((facilityPlan) => facilityPlan.facility.id === proof.supportFacilityId)
        ?.assignments.length).toBeLessThanOrEqual(supportFacility!.slotCount);
      expect(proof.withSupportEfficiency).toBeGreaterThan(proof.withoutSupportEfficiency);

      const inspection = inspectExplicitFacilityTeams(state, {
        teams: [{ facilityId: proof.productionFacilityId, operatorIds: proof.productionOperatorIds }],
        supportPlacements: [{ facilityId: proof.supportFacilityId, operatorIds: [proof.supportOperatorId] }],
        evaluationHours: proof.windowHours
      });
      expect(inspection.status).toBe("complete");
      expect(inspection.diagnostics).toEqual([]);

      const removed = inspectExplicitFacilityTeams(state, {
        teams: [{ facilityId: proof.productionFacilityId, operatorIds: proof.productionOperatorIds }],
        evaluationHours: proof.windowHours
      });
      expect(removed.status).toBe("complete");
      if (inspection.status === "complete" && removed.status === "complete") {
        expect(inspection.teams[0].expectedEfficiency).toBeCloseTo(proof.withSupportEfficiency, 12);
        expect(removed.teams[0].expectedEfficiency).toBeCloseTo(proof.withoutSupportEfficiency, 12);
        expect(inspection.teams[0].expectedEfficiency).toBeGreaterThan(removed.teams[0].expectedEfficiency);
      }
    });
  });

  it("populates every required production facility in every active three-group window", () => {
    const state = syntheticProductionState(overlappingThreeGroupSchedule);
    const plan = generateAssignmentPlan(state);

    expect(plan.rotation).toHaveLength(3);
    for (const window of plan.rotation) {
      expect(window.incompleteGroupIds).toEqual([]);
      for (const facility of state.facilities) {
        expect(window.assignments.filter((assignment) => assignment.facilityId === facility.id))
          .toHaveLength(facility.slotCount);
      }
    }
    expect(plan.diagnostics).toContainEqual(expect.objectContaining({
      code: "schedule-group-search-profile",
      completion: "complete"
    }));
  });

  it("routes validator-approved variable-width three-group schedules through the generic optimizer", () => {
    const schedule: ScheduleState = {
      cycleHours: 12,
      groups: [{ id: "A" }, { id: "B" }, { id: "C" }],
      shifts: [
        { id: "a-b", startHour: 0, endHour: 4, activeGroupIds: ["A", "B"], recoveryGroupIds: ["C"] },
        { id: "c", startHour: 4, endHour: 8, activeGroupIds: ["C"], recoveryGroupIds: ["A", "B"] },
        { id: "a-c", startHour: 8, endHour: 12, activeGroupIds: ["A", "C"], recoveryGroupIds: ["B"] }
      ]
    };
    const state = syntheticProductionState(schedule, [
      "char_241_panda", "char_159_peacok", "char_4054_malist",
      "char_431_ashlok", "char_496_wildmn", "char_430_fartth"
    ]);

    expect(validateSchedule(schedule)).toMatchObject({ ok: true });

    const plan = generateAssignmentPlan(state);
    const middleWindow = plan.rotation.find((window) => window.shiftId === "c");

    expect(plan.diagnostics.some((diagnostic) =>
      diagnostic.code === "schedule-group-search-profile"
    )).toBe(false);
    expect(plan.facilityPlans.every((facilityPlan) =>
      facilityPlan.assignments.length === facilityPlan.facility.slotCount
    )).toBe(true);
    expect(middleWindow).toMatchObject({ incompleteGroupIds: ["C"] });
    expect(plan.diagnostics).toContainEqual(expect.objectContaining({
      code: "schedule-group-unpopulated",
      groupId: "C",
      shiftId: "c"
    }));
  });

  it("forbids reuse across overlapping groups but permits half-open adjacency", () => {
    const overlapping = generateAssignmentPlan(syntheticProductionState(overlappingThreeGroupSchedule));
    const groupOperators = new Map<string, Set<string>>();
    for (const shift of overlappingThreeGroupSchedule.shifts) {
      const ids = overlapping.rotation.find((window) => window.shiftId === shift.id)!.assignments
        .map((assignment) => assignment.operatorId);
      for (const groupId of shift.activeGroupIds) {
        const seen = groupOperators.get(groupId) ?? new Set<string>();
        ids.forEach((operatorId) => seen.add(operatorId));
        groupOperators.set(groupId, seen);
      }
    }
    const selected = overlapping.rotation.flatMap((window) => window.assignments.map((assignment) => assignment.operatorId));
    expect(new Set(selected).size).toBe(3);

    const adjacentSchedule: ScheduleState = {
      cycleHours: 12,
      groups: [{ id: "A" }, { id: "B" }, { id: "C" }],
      shifts: [
        { id: "a", startHour: 0, endHour: 4, activeGroupIds: ["A"], recoveryGroupIds: [] },
        { id: "b", startHour: 4, endHour: 8, activeGroupIds: ["B"], recoveryGroupIds: [] },
        { id: "c", startHour: 8, endHour: 12, activeGroupIds: ["C"], recoveryGroupIds: [] }
      ]
    };
    const adjacent = generateAssignmentPlan(syntheticProductionState(
      adjacentSchedule,
      [simpleFactoryOperatorIds[0]],
      [{ id: "factory-a", type: "factory", name: "Factory A", slotCount: 1, product: "battleRecord" }]
    ));

    expect(adjacent.rotation.every((window) => window.incompleteGroupIds.length === 0)).toBe(true);
    expect(new Set(adjacent.rotation.flatMap((window) =>
      window.assignments.map((assignment) => assignment.operatorId)
    ))).toEqual(new Set([simpleFactoryOperatorIds[0]]));
  });

  it("fails closed with typed stable dimensions when the roster is infeasible", () => {
    const plan = generateAssignmentPlan(syntheticProductionState(
      overlappingThreeGroupSchedule,
      [simpleFactoryOperatorIds[0]]
    ));
    const incompleteDimensionIds = [
      "A:schedule:factory:battleRecord:0",
      "B:schedule:factory:battleRecord:0",
      "C:schedule:factory:battleRecord:0"
    ];

    expect(plan.diagnostics).toContainEqual({
      code: "composition-search-infeasible",
      incompleteDimensionIds,
      message: "Composition search could not fill 3 required dimensions"
    });
    expect(plan.diagnostics).toContainEqual(expect.objectContaining({
      code: "schedule-group-search-profile",
      completion: "infeasible",
      incompleteDimensionIds
    }));
    expect(plan.rotation.every((window) => window.incompleteGroupIds.length > 0)).toBe(true);
    expect(plan.rotation.flatMap((window) => window.assignments)).toEqual([]);
  });

  it("generates the known deep JP factory teams through ordinary candidates", () => {
    const state = allOwnedJpState();
    const expectedByProduct = {
      battleRecord: [
        ["char_241_panda", "char_159_peacok", "char_4054_malist"],
        ["char_431_ashlok", "char_496_wildmn", "char_430_fartth"],
        ["char_485_pallas", "char_336_folivo", "char_190_clour"]
      ],
      gold: [
        ["char_385_finlpp", "char_400_weedy", "char_416_zumama"],
        ["char_446_aroma", "char_243_waaifu", "char_391_rosmon"],
        ["char_4106_bryota", "char_237_gravel", "char_1039_thorn2"]
      ]
    } as const;
    const missing: string[] = [];

    for (const [product, teams] of Object.entries(expectedByProduct)) {
      const facility = state.facilities.find((candidate) =>
        candidate.type === "factory" && candidate.product === product
      );
      if (!facility) throw new Error(`missing ${product} factory`);
      const productCandidates = findCandidates(facility, state);
      const signatures = new Set(buildFacilityTeamOptionSet(productCandidates, facility.slotCount).options
        .map((team) => team.map(({ operatorId }) => operatorId).sort().join("|")));
      for (const team of teams) {
        const signature = [...team].sort().join("|");
        if (!signatures.has(signature)) missing.push(`${product}:${signature}`);
      }
    }

    expect(missing).toEqual([]);
  });

  describe("complete JP three-group schedule", () => {
    let plan: ReturnType<typeof generateAssignmentPlan>;
    let elapsedMs = Number.NaN;

    beforeAll(() => {
      const fixture = jpFixture();
      const startedAt = performance.now();
      plan = generateAssignmentPlan(allOwnedJpState(), {
        supportResourceScenario: fixture.supportResourceScenario
      });
      elapsedMs = performance.now() - startedAt;
    }, 25_000);

    it("fills every active production slot without simultaneous duplicates", () => {
      const state = allOwnedJpState();
      const productionFacilities = state.facilities.filter((facility) =>
        facility.type === "factory" || facility.type === "trading"
      );
      expect(plan.rotation).toHaveLength(state.schedule.shifts.length);
      expect(
        plan.rotation.every((window) => window.incompleteGroupIds.length === 0),
        JSON.stringify(plan.diagnostics)
      ).toBe(true);
      for (const window of plan.rotation) {
        const ids = window.assignments.map(({ operatorId }) => operatorId);
        expect(new Set(ids).size, window.shiftId).toBe(ids.length);
        for (const facility of productionFacilities) {
          expect(window.assignments.filter((assignment) => assignment.facilityId === facility.id))
            .toHaveLength(facility.slotCount);
        }
      }
      expect(plan.diagnostics).toContainEqual(expect.objectContaining({
        code: "schedule-group-search-profile",
        completion: "complete"
      }));
    });

    it("proves a negative-efficiency support only when its removal breaks authoritative closure", () => {
      const diagnostic = jointSupportDiagnostic(plan);
      const proof = diagnostic.removalProofs.find((item) => item.supportOperatorId === "char_206_gnosis");

      expect(proof).toMatchObject({
        supportOperatorId: "char_206_gnosis",
        necessity: {
          kind: "resource-or-sustainability-failure",
          withSupport: {
            resourceStatus: "complete",
            sustainable: true
          },
          withoutSupport: {
            resourceStatus: "complete",
            resourceClosureSatisfied: false,
            sustainabilityStatus: "not-evaluated"
          }
        }
      });
      expect(proof).toBeDefined();
      if (!proof) return;
      expect(proof.withSupportEfficiency).toBeLessThan(proof.withoutSupportEfficiency);

      const reorderedState = allOwnedJpState();
      reorderedState.facilities.reverse();
      reorderedState.schedule.groups.reverse();
      reorderedState.roster = Object.fromEntries(Object.entries(reorderedState.roster).reverse());
      const reorderedScenario = structuredClone(jpFixture().supportResourceScenario);
      reorderedScenario?.sources.reverse();
      const reorderedPlan = generateAssignmentPlan(reorderedState, {
        supportResourceScenario: reorderedScenario
      });
      const reorderedProof = jointSupportDiagnostic(reorderedPlan).removalProofs.find((item) =>
        item.supportOperatorId === "char_206_gnosis"
      );

      expect(reorderedProof).toEqual(proof);
      expect(materialProduction(reorderedPlan)).toEqual(materialProduction(plan));

      const irrelevantState = jointSupportBasinState();
      irrelevantState.roster.char_206_gnosis.owned = true;
      irrelevantState.roster.char_206_gnosis.elite = 2;
      const irrelevantDiagnostic = jointSupportDiagnostic(generateAssignmentPlan(irrelevantState));
      expect(irrelevantDiagnostic.selectedSupportOperatorIds).not.toContain("char_206_gnosis");
      expect(irrelevantDiagnostic.removalProofs.map((item) => item.supportOperatorId))
        .not.toContain("char_206_gnosis");
    }, 30_000);

    it("uses the exact fixed-resource windows within the PR #49 cold-search CI guard", () => {
      const fixture = jpFixture();
      const candidateObjective = evaluateCandidateObjectiveEvidence(fixture, allOwnedJpState(), plan);
      const referenceDiagnostic = evaluateReferenceCompositionDiagnostic(fixture);
      expect(plan.supportResourceScenario).toMatchObject({ complete: true });
      expect(plan.windowFacilityEfficiencyEvaluations?.find((item) =>
        item.scheduleWindowId === "groups-a-b" && item.fixedResourceAmounts.perceptionInfo === 20
      )).toBeDefined();
      expect(plan.windowFacilityEfficiencyEvaluations?.find((item) =>
        item.scheduleWindowId === "groups-b-c" && item.fixedResourceAmounts.perceptionInfo === 10
      )).toBeDefined();
      const ledger = plan.resources.per24Ledger;
      expect(ledger).toBeDefined();
      expect(Number.isFinite(ledger!.battleRecordExp)).toBe(true);
      expect(Number.isFinite(ledger!.goldProduced)).toBe(true);
      expect(
        candidateObjective,
        JSON.stringify({ candidateObjective, sustainability: plan.sustainability })
      ).toMatchObject({ status: "complete", authority: "authoritative" });
      expect(referenceDiagnostic.status).toBe("incomplete");
      if (candidateObjective.status !== "complete" || referenceDiagnostic.status !== "incomplete") return;
      const referenceObjective = referenceDiagnostic.objectiveEvidence;
      expect(Number.isFinite(candidateObjective.value)).toBe(true);
      expect(candidateObjective.objectiveProfile).toBe(referenceObjective.objectiveProfile);
      expect(candidateObjective.weights).toEqual(referenceObjective.weights);
      expect(candidateObjective.provenance).toBe(referenceObjective.provenance);
      expect(candidateObjective.value).toBeCloseTo(8.649444444444445, 12);
      expect(candidateObjective.sustainability).toMatchObject({
        status: "evaluated",
        result: { sustainable: true, failures: [] }
      });
      expect(referenceObjective).toMatchObject({
        status: "incomplete",
        authority: "unavailable",
        reason: "reference-sustainability-incomplete",
        completeness: {
          supportResourceScenario: "complete",
          resourceEvaluation: "complete",
          requiredFacilityEvaluationCount: 12,
          evaluatedFacilityEvaluationCount: 12
        },
        sustainability: {
        status: "evaluated",
          result: {
            sustainable: false,
            failures: [expect.objectContaining({
              code: "fatigued-before-shift-end",
              operatorId: "char_446_aroma",
              shiftId: "groups-b-c"
            })]
          }
        }
      });
      expect(referenceDiagnostic.diagnostics).toEqual([
        expect.objectContaining({
          code: "fatigued-before-shift-end",
          message: expect.stringContaining("char_446_aroma")
        })
      ]);
      // PR #49 bounded global-search CI guard; not an optimality or performance claim.
      const pr49ColdSearchCiGuardMs = 20_000;
      expect(elapsedMs).toBeLessThan(pr49ColdSearchCiGuardMs);
    });

    it("materializes ordinary and fixed support only in their exact work windows with recovery evidence", () => {
      const evidence = scheduledSupportEvidence(plan);
      const ordinaryByOperator = Object.fromEntries(evidence.supportPlacements
        .filter((item) => item.kind === "ordinary")
        .map((item) => [item.operatorId, item]));
      expect(ordinaryByOperator.char_1027_greyy2).toMatchObject({ facilityId: "power-1" });
      expect(ordinaryByOperator.char_420_flamtl).toMatchObject({ facilityId: "control-1" });
      expect(ordinaryByOperator.char_4098_vvana).toMatchObject({ facilityId: "control-1" });
      expect(evidence.supportPlacements.filter((item) => item.kind === "fixed")).toEqual([
        expect.objectContaining({ operatorId: "char_436_whispr", scheduleWindowIds: ["groups-a-b"] }),
        expect.objectContaining({ operatorId: "char_2015_dusk", scheduleWindowIds: ["groups-b-c"] })
      ]);
      expect(evidence.supportRecoveryValidated).toBe(true);
      expect(evidence.supportCapacityValidated).toBe(true);

      for (const item of Object.values(ordinaryByOperator)) {
        expect(item.groupId).toBeDefined();
        if (!item.groupId) throw new Error(`ordinary support ${item.operatorId} has no selected group`);
        const groupId = item.groupId;
        const expectedWorkWindowIds = plan.schedule.shifts
          .filter((shift) => shift.activeGroupIds.includes(groupId))
          .map((shift) => shift.id);
        const expectedRecoveryWindowIds = plan.schedule.shifts
          .filter((shift) => shift.recoveryGroupIds.includes(groupId))
          .map((shift) => shift.id);
        expect(item.scheduleWindowIds).toEqual(expectedWorkWindowIds);
        expect(item.recoveryWindowIds).toEqual(expectedRecoveryWindowIds);
        expect(item.scheduleWindowIds.some((shiftId) => item.recoveryWindowIds.includes(shiftId))).toBe(false);
        for (const shiftId of item.scheduleWindowIds) {
          expect(plan.rotation.find((window) => window.shiftId === shiftId)?.assignments
            .filter((assignment) => assignment.operatorId === item.operatorId)).toHaveLength(1);
        }
        for (const shiftId of item.recoveryWindowIds) {
          expect(plan.rotation.find((window) => window.shiftId === shiftId)?.assignments
            .map((assignment) => assignment.operatorId)).not.toContain(item.operatorId);
          expect(plan.rotation.find((window) => window.shiftId === shiftId)?.recovery
            .map((assignment) => assignment.operatorId)).toContain(item.operatorId);
        }
      }
    });

    it("materializes authoritative morale provenance for every canonical worker kind", () => {
      const state = allOwnedJpState();
      const evidence = scheduledSupportEvidence(plan);
      const observedKinds = new Set<"production" | "static" | "ordinary-support" | "fixed-support">();

      for (const window of plan.rotation) {
        for (const assignment of window.assignments.filter((item) => !item.doesNotConsumeFacilitySlot)) {
          const facility = state.facilities.find((item) => item.id === assignment.facilityId);
          const placement = evidence.supportPlacements.find((item) =>
            item.operatorId === assignment.operatorId &&
            item.facilityId === assignment.facilityId &&
            item.scheduleWindowIds.includes(window.shiftId)
          );
          observedKinds.add(
            facility?.type === "factory" || facility?.type === "trading"
              ? "production"
              : placement?.kind === "ordinary"
                ? "ordinary-support"
                : placement?.kind === "fixed"
                  ? "fixed-support"
                  : "static"
          );
          expect(assignment.moraleConsumptionPerHour, `${window.shiftId}:${assignment.operatorId}:consumption`)
            .toEqual(expect.any(Number));
          expect(assignment.recoveryProvenance, `${window.shiftId}:${assignment.operatorId}:recovery`)
            .toBeDefined();
        }
      }

      expect(observedKinds).toEqual(new Set([
        "production", "static", "ordinary-support", "fixed-support"
      ]));
    });

    it("shares one physical support slot across non-overlapping fixed and ordinary work windows", () => {
      const fixture = jpFixture();
      if (!fixture.supportResourceScenario) throw new Error("missing JP support resource scenario");
      const movedScenario = structuredClone(fixture.supportResourceScenario);
      const dusk = movedScenario.sources.find((source) => source.operatorId === "char_2015_dusk");
      if (!dusk) throw new Error("missing Dusk source");
      dusk.scheduleWindowId = "groups-c-a";
      dusk.facility.capacity = 1;
      dusk.facility.slot = 1;
      movedScenario.sources = [dusk];
      const state = jointSupportBasinState();
      state.roster.char_2015_dusk.owned = true;
      const moved = generateAssignmentPlan(state, { supportResourceScenario: movedScenario });
      const evidence = scheduledSupportEvidence(moved);
      const fixedDusk = evidence.supportPlacements.find((item) =>
        item.kind === "fixed" && item.operatorId === "char_2015_dusk"
      );
      const ordinarySupport = evidence.supportPlacements.find((item) =>
        item.kind === "ordinary" && item.facilityId === fixedDusk?.facilityId &&
        item.operatorId !== fixedDusk.operatorId
      );

      expect(moved.supportResourceScenario?.complete).toBe(true);
      expect(fixedDusk).toMatchObject({
        facilityId: "control-1",
        scheduleWindowIds: ["groups-c-a"],
        recoveryWindowIds: []
      });
      expect(ordinarySupport).toBeDefined();
      if (!ordinarySupport || !fixedDusk) return;
      expect(ordinarySupport.operatorId).not.toBe(fixedDusk.operatorId);
      expect(ordinarySupport.scheduleWindowIds.length).toBeGreaterThan(0);
      expect(ordinarySupport.scheduleWindowIds).not.toContain(fixedDusk.scheduleWindowIds[0]);
      for (const shiftId of ordinarySupport.scheduleWindowIds) {
        const controlOperators = moved.rotation.find((window) => window.shiftId === shiftId)?.assignments
          .filter((assignment) => assignment.facilityId === "control-1")
          .map((assignment) => assignment.operatorId);
        expect(controlOperators).toEqual([ordinarySupport.operatorId]);
      }
      const fixedWindow = moved.rotation.find((window) => window.shiftId === "groups-c-a");
      expect(fixedWindow?.assignments.filter((assignment) => assignment.facilityId === "control-1")
        .map((assignment) => assignment.operatorId)).toEqual(["char_2015_dusk"]);
      expect(fixedWindow?.recovery.map((assignment) => assignment.operatorId)).toContain(ordinarySupport.operatorId);
      expect(fixedWindow?.assignments.map((assignment) => assignment.operatorId)).not.toContain(ordinarySupport.operatorId);
      expect(evidence.completion).toBe("complete");
      expect(evidence.supportCapacityValidated).toBe(true);
      expect(evidence.supportRecoveryValidated).toBe(true);
    });
  });
});
