import { beforeAll, describe, expect, it } from "vitest";
import jpFactory from "../data/optimizer-benchmarks/jp-243-factory-3group-2025-11.json";
import cnFullBase from "../data/optimizer-benchmarks/cn-243-3shift-2026-06.json";
import jpWikiru from "../data/optimizer-benchmarks/jp-wikiru-backup38-12h-v2.json";
import { createDefaultState } from "../data/defaults";
import { optimizerBenchmarkFixtures } from "../data/optimizer-benchmarks";
import { availableOperatorIds, operatorAvailabilitySnapshot } from "./operatorAvailability";
import { averageEffectEfficiency, averageMoraleCurveEfficiency, generateAssignmentPlan } from "./optimizer";
import { calculateCanonicalSha256 } from "./phase1AssumptionBundle";
import {
  createIssue27CurrentObservations,
  createIssue27OptimizerObservation,
  createResourceOutputBenchmarkExecutionInput
} from "./optimizerIssue27Audit";
import {
  effectiveBenchmarkScheduleAuthority,
  validateOptimizerBenchmark,
  type ResourceOutputBenchmark
} from "./optimizerBenchmark";
import { formatOptimizerBenchmarkBatchResult, runOptimizerBenchmarkBatch } from "./optimizerBenchmarkRunner";
import { evaluateReferenceCompositionDiagnostic } from "./optimizerReferenceDiagnostic";
import type { BenchmarkObservationMap, OptimizerBenchmarkBatchResult } from "./optimizerBenchmarkRunner";

function validatedJpFactoryFixture() {
  const validated = validateOptimizerBenchmark(jpFactory);
  if (!validated.ok || validated.value.kind !== "resource-output") {
    throw new Error(validated.ok ? "wrong fixture kind" : validated.errors.join("\n"));
  }
  return validated.value;
}

describe("Issue #27 current-implementation audit", () => {
  let observations: BenchmarkObservationMap;
  let result: OptimizerBenchmarkBatchResult;

  beforeAll(() => {
    observations = createIssue27CurrentObservations();
    result = runOptimizerBenchmarkBatch(optimizerBenchmarkFixtures, observations);
  });

  it("reports every checked-in fixture with deterministic gating diagnostics", () => {
    expect(formatOptimizerBenchmarkBatchResult(result)).toBe([
      "optimizer benchmarks: FAILED (passed=0 failed=2 not-run=0 non-gating=3 invalid=0)",
      "FAIL jp-243-factory-3group-2025-11 rotation/state-model/shifts/groups-a-b/activeGroupIds: expected [\"group-a\",\"group-b\"], actual missing",
      "NON-GATING jp-glasgow-trading-125",
      "NON-GATING cn-243-3shift-2026-06",
      "NON-GATING base-mechanics-2026-07",
      "FAIL jp-wikiru-backup38-12h-v2 composition/search/groups-a-b/control-center: expected [\"char_4179_monstr\",\"char_2024_chyue\",\"char_2015_dusk\",\"char_2023_ling\",\"char_4098_vvana\"], actual missing"
    ].join("\n"));
  }, 30_000);

  it("separates informational reference provenance from the proven runtime boundaries", () => {
    const jpCase = result.cases.find((item) => item.id === "jp-243-factory-3group-2025-11");
    const cnCase = result.cases.find((item) => item.id === "cn-243-3shift-2026-06");

    expect(jpCase?.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "metadata/reference-provenance/version",
        severity: "info",
        expected: "Wikiru backup 38 (2025-11-02 18:43:20)",
        actual: undefined
      }),
      expect.objectContaining({
        path: "metadata/runtime-data-provenance/operatorAvailabilitySourceCommit",
        passed: true,
        expected: "7faf192d15eeac8b236c561a1938679f4642279e",
        actual: "7faf192d15eeac8b236c561a1938679f4642279e"
      })
    ]));
    expect(cnCase?.diagnostics).toContainEqual(expect.objectContaining({
      path: "metadata/runtime-data-provenance/operatorAvailabilitySourceCommit",
      passed: true,
      expected: "81c6d458a1778a9ba878a95c4e6fe48fb4254041"
    }));
  });

  it("derives the accepted Wikiru schedule while leaving composition search unresolved", () => {
    const jpScheduleAuthority = effectiveBenchmarkScheduleAuthority(validatedJpFactoryFixture());
    expect(jpScheduleAuthority.status).toBe("complete");
    if (jpScheduleAuthority.status !== "complete") {
      throw new Error(jpScheduleAuthority.errors.join("\n"));
    }
    expect(jpScheduleAuthority.schedule.shifts).toHaveLength(3);
    expect(cnFullBase.schedule.shifts).toHaveLength(3);
    expect(observations["jp-243-factory-3group-2025-11"]?.rotation).toMatchObject({
      cycleHours: 36,
      shifts: [{ id: "groups-a-b", durationHours: 12 }, { id: "groups-b-c", durationHours: 12 }, { id: "groups-c-a", durationHours: 12 }]
    });
    expect(observations["cn-243-3shift-2026-06"]?.rotation?.shifts).toHaveLength(3);
    expect(observations["jp-wikiru-backup38-12h-v2"]?.metadata.roster).toEqual(jpWikiru.roster);
    expect(observations["jp-wikiru-backup38-12h-v2"]?.rotation).toMatchObject({
      cycleHours: 36,
      shifts: [
        { id: "groups-a-b", durationHours: 12, startHour: 0, endHour: 12, activeGroupIds: ["group-a", "group-b"], recoveryGroupIds: ["group-c"] },
        { id: "groups-b-c", durationHours: 12, startHour: 12, endHour: 24, activeGroupIds: ["group-b", "group-c"], recoveryGroupIds: ["group-a"] },
        { id: "groups-c-a", durationHours: 12, startHour: 24, endHour: 36, activeGroupIds: ["group-a", "group-c"], recoveryGroupIds: ["group-b"] }
      ]
    });
    expect(observations["jp-wikiru-backup38-12h-v2"]?.rotation?.shifts.map((shift) => shift.assignments)).toEqual([
      {},
      {},
      {}
    ]);
    expect(jpWikiru.rotation.shifts.some((shift) => Object.keys(shift.assignments).length > 0)).toBe(true);
    expect(observations["cn-243-3shift-2026-06"]?.rotation?.shifts.every((shift) =>
      Object.keys(shift.assignments).length === 0
    )).toBe(true);
    expect(observations["cn-243-3shift-2026-06"]?.planEvidence).toBeUndefined();
    expect(observations["cn-243-3shift-2026-06"]?.objectiveEvidence).toBeUndefined();
  });

  it("keeps the accepted Wikiru canonical file and witness semantics pinned", () => {
    expect("schedule" in jpWikiru).toBe(false);
    expect(calculateCanonicalSha256(jpWikiru)).toBe(
      "a9f1f69b2bceff6896cc2bdcfaa61b88d648548fb21729a9a3ec19afae96f8b5"
    );
    expect(jpWikiru.rotation).toMatchObject({
      cycleHours: 36,
      workerGroupCount: 3,
      shifts: [
        { id: "groups-a-b", durationHours: 12, workerGroupIds: ["group-a", "group-b"] },
        { id: "groups-b-c", durationHours: 12, workerGroupIds: ["group-b", "group-c"] },
        { id: "groups-c-a", durationHours: 12, workerGroupIds: ["group-c", "group-a"] }
      ]
    });
  });

  it("fails closed for incomplete JP and CN quantities without inventing resources", () => {
    expect(observations["jp-243-factory-3group-2025-11"]?.resources).toBeUndefined();
    expect(observations["jp-243-factory-3group-2025-11"]?.planResourceMissingReasons).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "schedule-group-unpopulated" })])
    );
    expect(observations["cn-243-3shift-2026-06"]?.resources).toBeUndefined();
    expect(observations["jp-243-factory-3group-2025-11"]?.planEvidence).toMatchObject({
      search: { proofStatus: "not-certified" },
      simultaneousOperatorConflicts: [],
      supportResourceScenario: { requested: true, complete: true },
      resourceEvaluation: { status: "incomplete", missingCount: expect.any(Number) }
    });
    expect(observations["jp-wikiru-backup38-12h-v2"]?.resources).toBeUndefined();
    expect(observations["jp-wikiru-backup38-12h-v2"]?.planResourceMissingReasons).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "schedule-group-unpopulated" })])
    );
    expect(result.cases.find((item) => item.id === "cn-243-3shift-2026-06")?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "reference/source-only/shift-1/office-1/char_1052_kalts2",
          severity: "info",
          message: "source-only operator is excluded from runnable composition matching"
        }),
        expect.objectContaining({
          path: "reference/conflict/schedule.shifts.durationHours",
          severity: "info",
          expected: "12 hours per queue",
          actual: "8 hours per shift"
        }),
        expect.objectContaining({ path: "calculation/resource-values/lmd", actual: undefined })
      ])
    );
    expect(result.cases.find((item) => item.id === "cn-243-3shift-2026-06")?.diagnostics).not.toContainEqual(
      expect.objectContaining({ message: "reference composition is label-only and is not independently identified" })
    );
  });

  it("feeds independently calculated resources for a complete generated plan", () => {
    const glasgow = observations["jp-glasgow-trading-125"];

    expect(glasgow?.planResourceMissingReasons).toBeUndefined();
    expect(glasgow?.resources).toEqual(expect.objectContaining({
      goldProduced: expect.any(Number),
      goldConsumed: expect.any(Number),
      goldNetChange: expect.any(Number),
      battleRecordExp: expect.any(Number),
      lmd: expect.any(Number),
      dronesUsed: expect.any(Number),
      droneLmd: expect.any(Number),
      droneGoldConsumed: expect.any(Number)
    }));
  });

  it("keeps disputed and formula-only references diagnostic while the accepted contract gates", () => {
    for (const id of [
      "jp-glasgow-trading-125",
      "cn-243-3shift-2026-06",
      "base-mechanics-2026-07"
    ]) {
      expect(result.cases.find((item) => item.id === id)).toMatchObject({ status: "non-gating", gating: false });
    }
    expect(result.cases.find((item) => item.id === "jp-243-factory-3group-2025-11")).toMatchObject({
      status: "failed",
      gating: true,
      smallestMismatchPath: "rotation/state-model/shifts/groups-a-b/activeGroupIds"
    });
    expect(result.cases.find((item) => item.id === "jp-wikiru-backup38-12h-v2")).toMatchObject({
      status: "failed",
      gating: true,
      smallestMismatchPath: "composition/search/groups-a-b/control-center"
    });
  });

  it("derives all-unlocked metadata and provenance from the state snapshot consumed by the plan", () => {
    const jp = createIssue27OptimizerObservation("JP");
    const cn = createIssue27OptimizerObservation("CN");

    expect(jp.metadata).toEqual({
      region: "JP",
      runtimeDataProvenance: {
        operatorAvailabilitySourceCommit: operatorAvailabilitySnapshot.regions.JP.source.commit
      },
      roster: { mode: "all-unlocked" }
    });
    expect(cn.metadata).toEqual({
      region: "CN",
      runtimeDataProvenance: {
        operatorAvailabilitySourceCommit: operatorAvailabilitySnapshot.regions.CN.source.commit
      },
      roster: { mode: "all-unlocked" }
    });
  }, 30_000);

  it("derives explicit metadata from actual region-available ownership with no caller roster declaration", () => {
    const configuredIds = ["char_4110_delphn", "char_154_morgan", "char_112_siege", "not-in-state"];
    const expectedIds = operatorAvailabilitySnapshot.regions.JP.operatorIds.filter((operatorId) =>
      configuredIds.includes(operatorId)
    );
    const createWithIgnoredDeclaration = createIssue27OptimizerObservation as unknown as (
      region: "JP",
      operatorIds: readonly string[],
      ignoredRosterDeclaration: unknown
    ) => BenchmarkObservationMap[string];
    const observation = createWithIgnoredDeclaration("JP", configuredIds, {
      mode: "all-unlocked",
      operatorIds: ["caller-cannot-declare-metadata"]
    });

    expect(createIssue27OptimizerObservation).toHaveLength(2);
    expect(observation?.metadata).toEqual({
      region: "JP",
      runtimeDataProvenance: {
        operatorAvailabilitySourceCommit: operatorAvailabilitySnapshot.regions.JP.source.commit
      },
      roster: { mode: "explicit", operatorIds: expectedIds }
    });
  });

  it("covers optimizer time and morale curves at fractional boundaries", () => {
    const effect = {
      facility: "factory" as const,
      efficiency: 0,
      description: { en: "synthetic fractional-hour audit curve" },
      timeCurve: { initialEfficiency: 0, efficiencyPerHour: 0.1, maxEfficiency: 1 }
    };

    expect(averageEffectEfficiency(effect, 2)).toBeCloseTo((0.1 * 1 + 0.2 * 1) / 2);
    expect(averageEffectEfficiency(effect, 2.5)).toBeCloseTo(
      (0.1 * 1 + 0.2 * 1 + 0.3 * 0.5) / 2.5
    );
    expect(averageMoraleCurveEfficiency({
      initialEfficiency: 0.3,
      efficiencyPerStep: -0.1,
      moralePerStep: 2,
      minEfficiency: 0
    }, 2.5, 1)).toBeCloseTo((0.3 * 2 + 0.2 * 0.5) / 2.5);
  });

  it("exposes typed plan quantities and an integrated sustainable-cycle result", () => {
    const plan = generateAssignmentPlan(createDefaultState());

    expect(plan.resources).toMatchObject({
      status: "complete",
      assumptions: {
        facilityProductionCalculator: "simulateFacilityProduction",
        droneCalculator: "simulateTradingPostDrones24h"
      }
    });
    expect(plan.resources.per24Ledger).toBeDefined();
    expect(plan.sustainability).toMatchObject({ status: "evaluated" });
  });

  it("preserves whole-plan sustainability evidence for resource-output observations", () => {
    const glasgow = observations["jp-glasgow-trading-125"];
    const jp = observations["jp-243-factory-3group-2025-11"];
    const cn = observations["cn-243-3shift-2026-06"];

    expect(glasgow?.planSustainability).toMatchObject({ status: "evaluated" });
    expect(jp?.planSustainability).toMatchObject({
      status: "incomplete",
      missing: expect.arrayContaining([expect.objectContaining({ code: "plan-resources-incomplete" })])
    });
    expect(cn?.planSustainability).toBeUndefined();
    expect(result.cases.find((item) => item.id === "jp-243-factory-3group-2025-11")?.diagnostics).toContainEqual(
      expect.objectContaining({
        path: "calculation/resource-values/goldProduced",
        actual: jp?.resources?.goldProduced,
        severity: "error"
      })
    );
  });

  it("does not let fixture expected-output changes alter generated-plan observations", () => {
    const changedFixtures = structuredClone(optimizerBenchmarkFixtures) as Array<{
      id?: string;
      kind?: string;
      expected?: { output?: Record<string, number> };
    }>;
    for (const fixture of changedFixtures) {
      if (fixture.id === "jp-glasgow-trading-125" && fixture.kind === "resource-output" && fixture.expected?.output) {
        for (const resource of Object.keys(fixture.expected.output)) {
          fixture.expected.output[resource] = 987654321;
        }
      }
    }

    expect(createIssue27CurrentObservations(changedFixtures)).toEqual(observations);
  });

  it("fails closed when the generated JP plan and real reference authority are incomplete", () => {
    const jp = observations["jp-243-factory-3group-2025-11"]!;
    const jpCase = result.cases.find((item) => item.id === "jp-243-factory-3group-2025-11")!;

    expect(jp.planEvidence?.production.completedWindowIds).toEqual([]);
    expect(jp.planEvidence?.supportResourceScenario).toMatchObject({
      complete: true,
      resolvedSourceIds: expect.arrayContaining([
        "whisperain-office-perception-groups-a-b",
        "dusk-control-perception-groups-b-c"
      ]),
      fixedSourceEvidenceSourceIds: expect.arrayContaining([
        "whisperain-office-perception-groups-a-b",
        "dusk-control-perception-groups-b-c"
      ])
    });
    expect(jpCase).toMatchObject({
      status: "failed",
      searchProofStatus: "not-certified"
    });
    expect(jpCase.matchedComposition).toBeUndefined();
    expect(jpCase.acceptanceMode).toBeUndefined();
    expect(jpCase.objectiveComparison).toBeUndefined();
    expect(jp.objectiveEvidence?.candidate).toMatchObject({ status: "incomplete", authority: "unavailable" });
    expect(jp.objectiveEvidence?.reference).toMatchObject({
      status: "incomplete",
      authority: "unavailable",
      reason: "reference-sustainability-incomplete",
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
    expect(jpCase.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "calculation/resource-values/goldProduced",
        severity: "error",
        actual: undefined,
        expected: expect.any(Number)
      }),
      expect.objectContaining({
        path: "calculation/resource-values/battleRecordExp",
        severity: "error",
        actual: undefined,
        expected: expect.any(Number)
      })
    ]));
  });

  describe("Issue #28 resource-output benchmark adapter", () => {
    function fixture(id = "jp-243-factory-3group-2025-11"): ResourceOutputBenchmark {
      const validated = optimizerBenchmarkFixtures
        .map(validateOptimizerBenchmark)
        .find((candidate) => candidate.ok && candidate.value.id === id);
      if (!validated?.ok || validated.value.kind !== "resource-output") throw new Error(`invalid fixture ${id}`);
      return structuredClone(validated.value);
    }

    it.each([
      ["balanced", { gold: 0.5, battleRecord: 0.5, lmd: 0 }],
      ["battleRecord", { gold: 0, battleRecord: 1, lmd: 0 }],
      ["lmd", { gold: 0, battleRecord: 0, lmd: 1 }]
    ] as const)("creates fresh explicit-roster state and deterministic %s objective options", (profile, preference) => {
      const benchmark = fixture();
      benchmark.assumptions.objectiveProfile = profile;
      const first = createResourceOutputBenchmarkExecutionInput(benchmark);
      const second = createResourceOutputBenchmarkExecutionInput(benchmark);

      expect(first.state).not.toBe(second.state);
      expect(first.state.region).toBe(benchmark.region);
      expect(first.state.preference).toEqual(preference);
      expect(Object.entries(first.state.roster).filter(([, entry]) => entry.owned).map(([id]) => id).sort())
        .toEqual(benchmark.roster.mode === "explicit" ? [...benchmark.roster.operatorIds].sort() :
          [...availableOperatorIds(operatorAvailabilitySnapshot, benchmark.region)].sort());
      const authority = effectiveBenchmarkScheduleAuthority(benchmark);
      if (authority.status !== "complete") throw new Error(authority.errors.join("\n"));
      expect(first.state.schedule).toEqual({
        cycleHours: authority.schedule.cycleHours,
        groups: authority.schedule.groups,
        shifts: authority.schedule.shifts.map(({ durationHours: _durationHours, ...shift }) => shift)
      });
      expect(first.state.schedule.groups).not.toBe(authority.schedule.groups);
      expect(first.state.schedule.shifts[0].activeGroupIds).not.toBe(authority.schedule.shifts[0].activeGroupIds);
      expect(first.options).toEqual({ supportResourceScenario: benchmark.supportResourceScenario });
      expect(first.options.supportResourceScenario).toBe(benchmark.supportResourceScenario);
      expect(first.state.facilities.some((facility) => facility.type === ("office" as never))).toBe(false);
    });

    it("keeps expected output, reference compositions, labels, and provenance out of candidate generation", () => {
      const original = fixture();
      const changed = structuredClone(original);
      changed.expected.output.goldProduced = 987654321;
      changed.rotation.shifts[0].assignments["factory-gold-1"]!.operatorIds = ["expected-only-mutant"];
      changed.rotation.shifts[0].assignments["factory-gold-1"]!.label = "expected-only label";
      changed.expected.equivalentCompositions = [{
        shifts: [{ shiftId: changed.rotation.shifts[0].id, assignments: { "factory-gold-1": ["equivalent-only-mutant"] } }]
      }];
      changed.referenceProvenance.version = "expected-only provenance";
      changed.sources[0].title = "expected-only source title";

      expect(createResourceOutputBenchmarkExecutionInput(changed))
        .toEqual(createResourceOutputBenchmarkExecutionInput(original));
    });
  });
});
