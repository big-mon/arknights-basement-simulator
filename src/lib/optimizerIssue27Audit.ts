import { createDefaultState } from "../data/defaults";
import { optimizerBenchmarkFixtures } from "../data/optimizer-benchmarks";
import { createMaxLevel243BenchmarkContext } from "./benchmarkBaseContext";
import { simulateFacilityProduction } from "./facilityProduction";
import {
  availableOperatorIds,
  operatorAvailabilitySnapshot,
  type OperatorAvailabilityRegion
} from "./operatorAvailability";
import { generateAssignmentPlan } from "./optimizer";
import {
  runOptimizerBenchmarkBatch,
  type BenchmarkObservation,
  type BenchmarkObservationMap,
  type OptimizerBenchmarkBatchResult
} from "./optimizerBenchmarkRunner";
import { createResourceLedger } from "./resourceLedger";
import { evaluateSustainableCycle, type SustainableCycleInput } from "./sustainableCycleEvaluator";
import { simulateTradingPostDrones24h } from "./tradingPostDrones";
import type { Assignment, AppState } from "../types";

const emptyLedger = () => createResourceLedger();

function emptyCycle(overrides: Partial<SustainableCycleInput> = {}): SustainableCycleInput {
  return {
    shifts: [
      { id: "first", startHour: 0, endHour: 12, assignments: [], resourceLedger: emptyLedger() },
      { id: "second", startHour: 12, endHour: 24, assignments: [], resourceLedger: emptyLedger() }
    ],
    initialMorale: {},
    recoveryPlacements: [],
    startingGold: 0,
    ...overrides
  };
}

function observeDefaultMoraleCap(): number {
  let largestAccepted = 0;
  for (let morale = 1; morale <= 100; morale += 1) {
    try {
      evaluateSustainableCycle(emptyCycle({ initialMorale: { probe: morale } }));
      largestAccepted = morale;
    } catch (error) {
      if (error instanceof RangeError && /morale cap/.test(error.message)) break;
      throw error;
    }
  }
  return largestAccepted;
}

function createMechanicsObservation(): BenchmarkObservation {
  const moraleCap = observeDefaultMoraleCap();
  const work = emptyCycle({ initialMorale: { worker: moraleCap } });
  work.shifts[0].assignments.push({ facilityId: "factory-1", operatorId: "worker" });
  const workResult = evaluateSustainableCycle(work);
  const recoveryResult = evaluateSustainableCycle(emptyCycle({
    initialMorale: { resting: 0 },
    recoveryPlacements: [{
      dormitoryId: "dormitory-1",
      operatorId: "resting",
      startHour: 0,
      endHour: 12
    }]
  }));
  const gold = simulateFacilityProduction({
    durationHours: 1,
    facility: { kind: "factory", level: 3, product: "gold" }
  });
  const records = simulateFacilityProduction({
    durationHours: 1,
    facility: { kind: "factory", level: 3, product: "battleRecord" }
  });
  const orders = simulateFacilityProduction({
    durationHours: 1,
    facility: { kind: "tradingPost", level: 3, orderType: "normalLmd" }
  });
  const drones = simulateTradingPostDrones24h({
    initialDrones: 1,
    powerPlantSkillIncrements: [],
    allocations: [{ targetFacilityId: "trading-1", drones: 1 }],
    baseContext: createMaxLevel243BenchmarkContext()
  });
  const probability = (goldAmount: number) =>
    orders.orderDistribution.outcomes.find((outcome) => outcome.gold === goldAmount)?.probability ?? Number.NaN;

  return {
    metadata: {
      region: "GLOBAL"
    },
    formulaValues: {
      "operator-morale-cap": moraleCap,
      "base-morale-consumption": (moraleCap - workResult.operators[0].finalMorale) / 12,
      "max-dormitory-recovery": recoveryResult.operators[0].timeline[0].ratePerHour,
      "drone-cap": drones.inventory.cap,
      "base-drone-recovery": drones.generation.baseRatePerHour,
      "drone-time-reduction": drones.targets[0].shortenedMinutes,
      "battle-record-time": records.base.minutesPerUnit,
      "battle-record-exp": "expPerUnit" in records.base ? records.base.expPerUnit : Number.NaN,
      "gold-time": gold.base.minutesPerUnit,
      "order-two-probability": probability(2),
      "order-three-probability": probability(3),
      "order-four-probability": probability(4),
      "expected-order-gold": orders.orderDistribution.expectedGoldPerOrder,
      "expected-order-lmd": orders.orderDistribution.expectedLmdPerOrder,
      "expected-order-time": orders.base.minutesPerOrder
    }
  };
}

function assignmentsByFacility(assignments: readonly Assignment[]): Record<string, string[]> {
  const grouped: Record<string, string[]> = {};
  for (const assignment of assignments) {
    (grouped[assignment.facilityId] ??= []).push(assignment.operatorId);
  }
  return Object.fromEntries(
    Object.entries(grouped).map(([facilityId, operatorIds]) => [facilityId, [...operatorIds].sort()])
  );
}

function createOwnedRegionalState(
  region: OperatorAvailabilityRegion,
  explicitOperatorIds?: readonly string[]
): AppState {
  const state = createDefaultState();
  state.region = region;
  const ownedIds = new Set(explicitOperatorIds ?? availableOperatorIds(operatorAvailabilitySnapshot, region));
  for (const [operatorId, entry] of Object.entries(state.roster)) entry.owned = ownedIds.has(operatorId);
  return state;
}

function createOptimizerObservation(
  region: OperatorAvailabilityRegion,
  roster: BenchmarkObservation["metadata"]["roster"],
  explicitOperatorIds?: readonly string[]
): BenchmarkObservation {
  const state = createOwnedRegionalState(region, explicitOperatorIds);
  const plan = generateAssignmentPlan(state);
  const source = operatorAvailabilitySnapshot.regions[region].source;
  const observation: BenchmarkObservation = {
    metadata: {
      region: state.region,
      runtimeDataProvenance: { operatorAvailabilitySourceCommit: source.commit },
      roster
    },
    rotation: {
      cycleHours: plan.rotation.reduce((total, window) => total + window.hours, 0),
      shifts: plan.rotation.map((window, index) => ({
        id: `current-window-${index + 1}`,
        durationHours: window.hours,
        assignments: assignmentsByFacility(window.assignments)
      }))
    }
    // generateAssignmentPlan exposes scores/efficiencies, not actual resource quantities.
    // Missing resources are intentionally left missing rather than copied from fixture expectations.
  };
  return observation;
}

export function createIssue27CurrentObservations(): BenchmarkObservationMap {
  const glasgowIds = ["char_4110_delphn", "char_154_morgan", "char_112_siege"] as const;
  return {
    "base-mechanics-2026-07": createMechanicsObservation(),
    "jp-243-factory-3group-2025-11": createOptimizerObservation("JP", { mode: "all-unlocked" }),
    "jp-glasgow-trading-125": createOptimizerObservation(
      "JP",
      { mode: "explicit", operatorIds: [...glasgowIds] },
      glasgowIds
    ),
    "cn-243-3shift-2026-06": createOptimizerObservation("CN", { mode: "all-unlocked" })
  };
}

export function runIssue27CurrentImplementationAudit(): OptimizerBenchmarkBatchResult {
  return runOptimizerBenchmarkBatch(optimizerBenchmarkFixtures, createIssue27CurrentObservations());
}
