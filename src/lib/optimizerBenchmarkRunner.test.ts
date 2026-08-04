import { describe, expect, it } from "vitest";
import { optimizerBenchmarkFixtures } from "../data/optimizer-benchmarks";
import type { OptimizerBenchmark, ResourceOutputBenchmark } from "./optimizerBenchmark";
import {
  formatOptimizerBenchmarkBatchResult,
  runOptimizerBenchmarkBatch,
  type BenchmarkObservation,
  type BenchmarkObservationMap
} from "./optimizerBenchmarkRunner";

function resourceFixture(overrides: Record<string, unknown> = {}): unknown {
  return {
    kind: "resource-output",
    scope: "facility-team",
    id: "runner-case",
    region: "JP",
    referenceProvenance: { version: "reference-plan-v1", observedAt: "2026-08-04" },
    runtimeDataProvenance: { operatorAvailabilitySourceCommit: "jp-runtime-v1" },
    confidence: "corroborated",
    sources: [{
      url: "https://example.com/source",
      title: "Example",
      accessedAt: "2026-08-04",
      language: "en",
      role: "throughput"
    }],
    assumptions: {
      layout: "243",
      drones: "excluded",
      facilityProducts: ["lmd"],
      objectiveProfile: "lmd",
      notes: ["fixture"]
    },
    roster: { mode: "explicit", operatorIds: ["a", "b"] },
    rotation: {
      cycleHours: 24,
      shifts: [{
        id: "day",
        durationHours: 24,
        assignments: {
          "trading-1": { operatorIds: ["a", "b"] },
          "trading-label-only": { label: "not independently identified" }
        }
      }]
    },
    expected: {
      output: { lmd: 100 },
      formulas: ["lmd = 100"],
      tolerance: { type: "absolute", value: 0.5 }
    },
    ...overrides
  };
}

function observation(overrides: Partial<BenchmarkObservation> = {}): BenchmarkObservation {
  return {
    metadata: {
      region: "JP",
      runtimeDataProvenance: { operatorAvailabilitySourceCommit: "jp-runtime-v1" },
      roster: { mode: "explicit", operatorIds: ["a", "b"] }
    },
    rotation: {
      cycleHours: 24,
      shifts: [{
        id: "day",
        durationHours: 24,
        assignments: { "trading-1": ["b", "a"] }
      }]
    },
    resources: { lmd: 100 },
    ...overrides
  };
}

describe("runOptimizerBenchmarkBatch", () => {
  it("passes an exact observation and compares operator sets independent of order", () => {
    const result = runOptimizerBenchmarkBatch([resourceFixture()], { "runner-case": observation() });

    expect(result.aggregateStatus).toBe("passed");
    expect(result.counts).toEqual({ passed: 1, failed: 0, "not-run": 0, "non-gating": 0, invalid: 0 });
    expect(result.cases[0]).toMatchObject({ id: "runner-case", status: "passed", gating: true });
    expect(result.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "composition/search/day/trading-label-only",
      severity: "info",
      category: "search"
    }));
  });

  it("rejects an unexpected observed shift as a state-model mismatch", () => {
    const result = runOptimizerBenchmarkBatch([resourceFixture()], {
      "runner-case": observation({
        rotation: {
          cycleHours: 24,
          shifts: [
            { id: "day", durationHours: 24, assignments: { "trading-1": ["b", "a"] } },
            { id: "night", durationHours: 24, assignments: { "trading-1": ["a", "b"] } }
          ]
        }
      })
    });

    expect(result.cases[0]).toMatchObject({
      status: "failed",
      smallestMismatchPath: "rotation/state-model/shifts/night/unexpected"
    });
    expect(result.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "rotation/state-model/shifts/night/unexpected",
      category: "state-model",
      severity: "error",
      certainty: "suspected"
    }));
  });

  it("rejects duplicate observed shift IDs as a state-model mismatch", () => {
    const result = runOptimizerBenchmarkBatch([resourceFixture()], {
      "runner-case": observation({
        rotation: {
          cycleHours: 24,
          shifts: [
            { id: "day", durationHours: 24, assignments: { "trading-1": ["b", "a"] } },
            { id: "day", durationHours: 24, assignments: { "trading-1": ["a", "b"] } }
          ]
        }
      })
    });

    expect(result.cases[0]).toMatchObject({
      status: "failed",
      smallestMismatchPath: "rotation/state-model/shifts/day/duplicate-id"
    });
    expect(result.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "rotation/state-model/shifts/day/duplicate-id",
      category: "state-model",
      severity: "error",
      certainty: "suspected"
    }));
  });

  it("applies relative tolerance on both sides of the CN 1% boundary", () => {
    const fixture = resourceFixture({
      id: "cn-one-percent",
      region: "CN",
      referenceProvenance: { version: "cn-reference-v1", observedAt: "2026-08-04" },
      runtimeDataProvenance: { operatorAvailabilitySourceCommit: "cn-runtime-v1" },
      roster: { mode: "all-unlocked" },
      expected: {
        output: { lmd: 100 },
        formulas: ["lmd = 100"],
        tolerance: { type: "relative", value: 0.01, zeroExpectedAbsolute: 0.1 }
      }
    });
    const base = observation({
      metadata: {
        region: "CN",
        runtimeDataProvenance: { operatorAvailabilitySourceCommit: "cn-runtime-v1" },
        roster: { mode: "all-unlocked" }
      }
    });
    const within = runOptimizerBenchmarkBatch([fixture], { "cn-one-percent": { ...base, resources: { lmd: 101 } } });
    const outside = runOptimizerBenchmarkBatch([fixture], { "cn-one-percent": { ...base, resources: { lmd: 101.0001 } } });

    expect(within.cases[0]).toMatchObject({ status: "passed" });
    expect(within.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "calculation/resource-values/lmd",
      passed: true,
      absoluteError: 1,
      relativeError: 0.01,
      tolerance: { type: "relative", value: 0.01, zeroExpectedAbsolute: 0.1 }
    }));
    expect(outside.cases[0]).toMatchObject({ status: "failed", smallestMismatchPath: "calculation/resource-values/lmd" });
  });

  it("applies absolute tolerance and the explicit expected-zero fallback without division", () => {
    const absolute = runOptimizerBenchmarkBatch([resourceFixture()], {
      "runner-case": observation({ resources: { lmd: 100.5 } })
    });
    const zeroFixture = resourceFixture({
      expected: {
        output: { lmd: 0 },
        formulas: ["lmd = 0"],
        tolerance: { type: "relative", value: 0.01, zeroExpectedAbsolute: 0.25 }
      }
    });
    const zero = runOptimizerBenchmarkBatch([zeroFixture], {
      "runner-case": observation({ resources: { lmd: 0.2 } })
    });

    expect(absolute.cases[0].status).toBe("passed");
    expect(zero.cases[0].status).toBe("passed");
    expect(zero.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "calculation/resource-values/lmd",
      absoluteError: 0.2,
      relativeError: undefined,
      appliedTolerance: { type: "absolute-zero-fallback", value: 0.25 }
    }));
  });

  it("accepts an explicitly declared equivalent composition without weakening resources", () => {
    const fixture = resourceFixture();
    (fixture as ResourceOutputBenchmark).expected.equivalentCompositions = [{
      shifts: [{ shiftId: "day", assignments: { "trading-1": ["c", "d"] } }]
    }];
    const result = runOptimizerBenchmarkBatch([fixture], {
      "runner-case": observation({
        rotation: { cycleHours: 24, shifts: [{ id: "day", durationHours: 24, assignments: { "trading-1": ["d", "c"] } }] },
        resources: { lmd: 99 }
      })
    });

    expect(result.cases[0]).toMatchObject({ status: "failed", matchedComposition: "equivalent[0]" });
    expect(result.cases[0].smallestMismatchPath).toBe("calculation/resource-values/lmd");
  });

  it("reports wrong metadata, rotation, and composition at stable hierarchical paths", () => {
    const result = runOptimizerBenchmarkBatch([resourceFixture()], {
      "runner-case": observation({
        metadata: {
          region: "CN",
          runtimeDataProvenance: { operatorAvailabilitySourceCommit: "wrong" },
          roster: { mode: "explicit", operatorIds: ["a"] }
        },
        rotation: { cycleHours: 12, shifts: [{ id: "night", durationHours: 12, assignments: { "trading-1": ["x"] } }] }
      })
    });

    expect(result.cases[0].diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "metadata/runtime-data-provenance/region", category: "source-data", certainty: "suspected" }),
      expect.objectContaining({ path: "metadata/runtime-data-provenance/operatorAvailabilitySourceCommit", category: "source-data" }),
      expect.objectContaining({ path: "metadata/runtime-data-provenance/roster/operatorIds", category: "source-data" }),
      expect.objectContaining({ path: "rotation/state-model/cycleHours", category: "state-model" }),
      expect.objectContaining({ path: "rotation/state-model/shifts/day", category: "state-model" })
    ]));
    expect(result.cases[0].smallestMismatchPath).toBe("metadata/runtime-data-provenance/region");
  });

  it("accepts distinct reference and runtime versions and reports reference provenance informationally", () => {
    const result = runOptimizerBenchmarkBatch([resourceFixture()], { "runner-case": observation() });

    expect(result.cases[0].status).toBe("passed");
    expect(result.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "metadata/reference-provenance/version",
      severity: "info",
      expected: "reference-plan-v1",
      actual: undefined
    }));
    expect(result.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "metadata/runtime-data-provenance/operatorAvailabilitySourceCommit",
      passed: true,
      expected: "jp-runtime-v1",
      actual: "jp-runtime-v1"
    }));
  });

  it("diagnoses a runtime boundary mismatch at the precise source-data path", () => {
    const result = runOptimizerBenchmarkBatch([resourceFixture()], {
      "runner-case": observation({
        metadata: {
          region: "JP",
          runtimeDataProvenance: { operatorAvailabilitySourceCommit: "different-runtime" },
          roster: { mode: "explicit", operatorIds: ["a", "b"] }
        }
      })
    });

    expect(result.cases[0]).toMatchObject({
      status: "failed",
      smallestMismatchPath: "metadata/runtime-data-provenance/operatorAvailabilitySourceCommit"
    });
  });

  it("fails when a fixture requires a runtime boundary but the observation omits it", () => {
    const result = runOptimizerBenchmarkBatch([resourceFixture()], {
      "runner-case": observation({
        metadata: { region: "JP", roster: { mode: "explicit", operatorIds: ["a", "b"] } }
      })
    });

    expect(result.cases[0]).toMatchObject({
      status: "failed",
      smallestMismatchPath: "metadata/runtime-data-provenance/operatorAvailabilitySourceCommit"
    });
    expect(result.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "metadata/runtime-data-provenance/operatorAvailabilitySourceCommit",
      actual: undefined,
      severity: "error"
    }));
  });

  it("never substitutes reference provenance for a missing runtime boundary", () => {
    const result = runOptimizerBenchmarkBatch([resourceFixture()], {
      "runner-case": observation({
        metadata: {
          region: "JP",
          referenceProvenance: { version: "jp-runtime-v1" },
          roster: { mode: "explicit", operatorIds: ["a", "b"] }
        }
      })
    });

    expect(result.cases[0]).toMatchObject({
      status: "failed",
      smallestMismatchPath: "metadata/reference-provenance/version"
    });
    expect(result.cases[0].diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "metadata/reference-provenance/version",
        expected: "reference-plan-v1",
        actual: "jp-runtime-v1"
      }),
      expect.objectContaining({
        path: "metadata/runtime-data-provenance/operatorAvailabilitySourceCommit",
        actual: undefined
      })
    ]));
  });

  it("reports explicit interpretation checks and only auditor evidence as proven", () => {
    const result = runOptimizerBenchmarkBatch([resourceFixture()], {
      "runner-case": observation({
        interpretedEffects: [{ id: "glasgow-efficiency", expected: 1.25, actual: 1.15 }],
        provenCauses: [{ category: "interpretation", path: "skill-interpretation/glasgow-efficiency", evidence: "Audited against captured game text." }]
      })
    });

    expect(result.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "skill-interpretation/glasgow-efficiency",
      category: "interpretation",
      certainty: "proven",
      expected: 1.25,
      actual: 1.15,
      absoluteError: 0.1
    }));
    expect(result.cases[0].diagnostics.filter((item) => item.certainty === "proven")).toHaveLength(1);
  });

  it("compares every formula ID deterministically and reports the first missing value", () => {
    const fixture = optimizerBenchmarkFixtures.find((item) =>
      (item as { id?: string }).id === "base-mechanics-2026-07"
    )!;
    const formulas = (fixture as Extract<OptimizerBenchmark, { kind: "formula" }>).formulas;
    const formulaValues = Object.fromEntries(formulas.slice(1).map((formula) => [formula.id, formula.expectedValue]));
    const result = runOptimizerBenchmarkBatch([fixture], {
      "base-mechanics-2026-07": {
        metadata: {
          region: "GLOBAL",
          referenceProvenance: { version: "CN model snapshots 2026-07-31 and 2026-08-02" }
        },
        formulaValues
      }
    });

    expect(result.cases[0]).toMatchObject({
      status: "failed",
      smallestMismatchPath: "calculation/formula-values/operator-morale-cap"
    });
  });

  it("executes disputed observations diagnostically but excludes them from gating", () => {
    const fixture = resourceFixture({ confidence: "disputed" });
    const result = runOptimizerBenchmarkBatch([fixture], {
      "runner-case": observation({ resources: { lmd: 1 } })
    });

    expect(result.aggregateStatus).toBe("passed");
    expect(result.counts).toEqual({ passed: 0, failed: 0, "not-run": 0, "non-gating": 1, invalid: 0 });
    expect(result.cases[0]).toMatchObject({ status: "non-gating", gating: false });
    expect(result.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "reference/disputed",
      category: "reference",
      severity: "info"
    }));
    expect(result.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "calculation/resource-values/lmd",
      passed: false
    }));
  });

  it("marks an eligible missing observation incomplete and a malformed fixture invalid without crashing", () => {
    const result = runOptimizerBenchmarkBatch([
      resourceFixture({ id: "missing-case" }),
      { kind: "resource-output", id: "broken-case" }
    ], {});

    expect(result.aggregateStatus).toBe("failed");
    expect(result.counts).toEqual({ passed: 0, failed: 0, "not-run": 1, "non-gating": 0, invalid: 1 });
    expect(result.cases).toEqual([
      expect.objectContaining({ id: "missing-case", status: "not-run", smallestMismatchPath: "observation" }),
      expect.objectContaining({ id: "broken-case", status: "invalid", smallestMismatchPath: "fixture" })
    ]);
  });

  it("reports extra actual resources as informational and does not compare them", () => {
    const result = runOptimizerBenchmarkBatch([resourceFixture()], {
      "runner-case": observation({ resources: { lmd: 100, goldProduced: 4 } })
    });

    expect(result.cases[0].status).toBe("passed");
    expect(result.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "calculation/resource-values/goldProduced",
      severity: "info",
      message: expect.stringContaining("extra actual resource")
    }));
  });

  it("preserves fixture order, formats deterministic minimal failures, and does not mutate inputs", () => {
    const fixtures = [resourceFixture({ id: "z-first" }), resourceFixture({ id: "a-second" })];
    const observations: BenchmarkObservationMap = {
      "z-first": observation({ resources: { lmd: 99 } }),
      "a-second": observation()
    };
    const fixturesBefore = structuredClone(fixtures);
    const observationsBefore = structuredClone(observations);

    const first = runOptimizerBenchmarkBatch(fixtures, observations);
    const second = runOptimizerBenchmarkBatch(fixtures, observations);
    const text = formatOptimizerBenchmarkBatchResult(first);

    expect(first.cases.map((item) => item.id)).toEqual(["z-first", "a-second"]);
    expect(second).toEqual(first);
    expect(text).toBe([
      "optimizer benchmarks: FAILED (passed=1 failed=1 not-run=0 non-gating=0 invalid=0)",
      "FAIL z-first calculation/resource-values/lmd: expected 100, actual 99, absolute error 1 exceeds absolute tolerance 0.5",
      "PASS a-second"
    ].join("\n"));
    expect(fixtures).toEqual(fixturesBefore);
    expect(observations).toEqual(observationsBefore);
  });

  it("runs every checked-in fixture offline using synthetic saved-reference observations", () => {
    const observations: BenchmarkObservationMap = Object.fromEntries(
      optimizerBenchmarkFixtures.map((raw) => {
        const fixture = raw as OptimizerBenchmark;
        const metadata = {
          region: fixture.region,
          referenceProvenance: { version: fixture.referenceProvenance.version },
          ...(fixture.runtimeDataProvenance ? {
            runtimeDataProvenance: structuredClone(fixture.runtimeDataProvenance)
          } : {}),
          ...(fixture.kind === "resource-output" ? { roster: structuredClone(fixture.roster) } : {})
        };
        if (fixture.kind === "formula") {
          return [fixture.id, {
            metadata,
            formulaValues: Object.fromEntries(fixture.formulas.map((formula) => [formula.id, formula.expectedValue]))
          }];
        }
        return [fixture.id, {
          metadata,
          rotation: {
            cycleHours: fixture.rotation.cycleHours,
            shifts: fixture.rotation.shifts.map((shift) => ({
              id: shift.id,
              durationHours: shift.durationHours,
              assignments: Object.fromEntries(Object.entries(shift.assignments).flatMap(([facilityId, assignment]) =>
                assignment.operatorIds ? [[facilityId, [...assignment.operatorIds]]] : []
              ))
            }))
          },
          resources: { ...fixture.expected.output }
        }];
      })
    );

    const result = runOptimizerBenchmarkBatch(optimizerBenchmarkFixtures, observations);

    expect(result.cases).toHaveLength(optimizerBenchmarkFixtures.length);
    expect(result.counts.invalid).toBe(0);
    expect(result.counts.failed).toBe(0);
    expect(result.aggregateStatus).toBe("passed");
    // This proves offline runner plumbing against saved data, not independent optimizer correctness.
  });
});
