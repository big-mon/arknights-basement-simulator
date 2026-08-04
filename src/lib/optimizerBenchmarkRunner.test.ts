import { describe, expect, it } from "vitest";
import { optimizerBenchmarkFixtures } from "../data/optimizer-benchmarks";
import type { OptimizerBenchmark, ResourceOutputBenchmark } from "./optimizerBenchmark";
import {
  operatorAvailabilitySnapshot,
  type OperatorAvailabilityRegion
} from "./operatorAvailability";
import {
  formatOptimizerBenchmarkBatchResult,
  runOptimizerBenchmarkBatch,
  type BenchmarkObservation,
  type BenchmarkObservationMap
} from "./optimizerBenchmarkRunner";

const alternativeCommit = "0000000000000000000000000000000000000000";
const checkedGatingFixture = optimizerBenchmarkFixtures.find((item) =>
  (item as { contractVersion?: string }).contractVersion === "phase1-pass-fail-v1"
) as ResourceOutputBenchmark;

function genericOperatorIds(region: OperatorAvailabilityRegion): readonly [string, string, string, string] {
  const operatorIds = operatorAvailabilitySnapshot.regions[region].operatorIds;
  return [operatorIds[0], operatorIds[1], operatorIds[2], operatorIds[3]];
}

function resourceFixture(
  region: OperatorAvailabilityRegion,
  overrides: Record<string, unknown> = {}
): unknown {
  const [operatorA, operatorB, operatorC, operatorD] = genericOperatorIds(region);
  return {
    kind: "resource-output",
    scope: "facility-team",
    id: "runner-case",
    region,
    referenceProvenance: { version: "reference-plan-v1", observedAt: "2026-08-04" },
    runtimeDataProvenance: {
      operatorAvailabilitySourceCommit: operatorAvailabilitySnapshot.regions[region].source.commit
    },
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
    roster: { mode: "explicit", operatorIds: [operatorA, operatorB, operatorC, operatorD] },
    rotation: {
      cycleHours: 24,
      shifts: [{
        id: "day",
        durationHours: 24,
        assignments: {
          "trading-1": { operatorIds: [operatorA, operatorB] },
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

function observation(
  region: OperatorAvailabilityRegion,
  overrides: Partial<BenchmarkObservation> = {}
): BenchmarkObservation {
  const [operatorA, operatorB, operatorC, operatorD] = genericOperatorIds(region);
  return {
    metadata: {
      region,
      runtimeDataProvenance: {
        operatorAvailabilitySourceCommit: operatorAvailabilitySnapshot.regions[region].source.commit
      },
      roster: { mode: "explicit", operatorIds: [operatorA, operatorB, operatorC, operatorD] }
    },
    rotation: {
      cycleHours: 24,
      shifts: [{
        id: "day",
        durationHours: 24,
        assignments: { "trading-1": [operatorB, operatorA] }
      }]
    },
    resources: { lmd: 100 },
    ...overrides
  };
}

function gatingFixture(id: string): ResourceOutputBenchmark {
  const fixture = structuredClone(checkedGatingFixture);
  fixture.id = id;
  return fixture;
}

function savedReferenceObservation(fixture: ResourceOutputBenchmark): BenchmarkObservation {
  return {
    metadata: {
      region: fixture.region,
      referenceProvenance: { version: fixture.referenceProvenance.version },
      runtimeDataProvenance: structuredClone(fixture.runtimeDataProvenance),
      roster: structuredClone(fixture.roster)
    },
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
  };
}

function expectedResource(fixture: ResourceOutputBenchmark, resource: keyof ResourceOutputBenchmark["expected"]["output"]): number {
  const value = fixture.expected.output[resource];
  if (value === undefined) throw new Error(`${fixture.id} must define expected ${resource}`);
  return value;
}

describe("runOptimizerBenchmarkBatch", () => {
  it("passes an exact observation and compares operator sets independent of order", () => {
    const result = runOptimizerBenchmarkBatch([resourceFixture("JP")], { "runner-case": observation("JP") });

    expect(result.aggregateStatus).toBe("passed");
    expect(result.counts).toEqual({ passed: 0, failed: 0, "not-run": 0, "non-gating": 1, invalid: 0 });
    expect(result.cases[0]).toMatchObject({ id: "runner-case", status: "non-gating", gating: false });
    expect(result.cases[0].diagnostics.filter((item) => item.severity === "error")).toHaveLength(0);
    expect(result.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "composition/search/day/trading-label-only",
      severity: "info",
      category: "search"
    }));
  });

  it("compares remote support requirements deterministically without treating them as occupants", () => {
    const fixture = resourceFixture() as Record<string, any>;
    fixture.rotation.shifts[0].assignments["trading-1"].remoteSupport = {
      operatorIds: ["support-b", "support-a"],
      unresolved: [{ sourceName: "Unknown Support", reason: "Not mapped by the fixed source catalog." }],
      notes: ["Remote support is outside the trading-post slot count."]
    };

    const matched = runOptimizerBenchmarkBatch([fixture], {
      "runner-case": observation({
        rotation: {
          cycleHours: 24,
          shifts: [{
            id: "day",
            durationHours: 24,
            assignments: { "trading-1": ["b", "a"] },
            remoteSupportOperatorIds: { "trading-1": ["support-a", "support-b"] }
          }]
        }
      } as any)
    });
    const missing = runOptimizerBenchmarkBatch([fixture], { "runner-case": observation() });

    expect(matched.cases[0]).toMatchObject({ status: "passed", matchedComposition: "primary" });
    expect(matched.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "composition/remote-support/day/trading-1",
      passed: true
    }));
    expect(matched.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "reference/unresolved-support/day/trading-1/Unknown Support",
      severity: "info"
    }));
    expect(missing.cases[0]).toMatchObject({
      status: "failed",
      smallestMismatchPath: "composition/remote-support/day/trading-1"
    });
  });

  it("rejects an unexpected observed shift as a state-model mismatch", () => {
    const [operatorA, operatorB] = genericOperatorIds("JP");
    const result = runOptimizerBenchmarkBatch([resourceFixture("JP")], {
      "runner-case": observation("JP", {
        rotation: {
          cycleHours: 24,
          shifts: [
            { id: "day", durationHours: 24, assignments: { "trading-1": [operatorB, operatorA] } },
            { id: "night", durationHours: 24, assignments: { "trading-1": [operatorA, operatorB] } }
          ]
        }
      })
    });

    expect(result.cases[0]).toMatchObject({
      status: "non-gating",
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
    const [operatorA, operatorB] = genericOperatorIds("JP");
    const result = runOptimizerBenchmarkBatch([resourceFixture("JP")], {
      "runner-case": observation("JP", {
        rotation: {
          cycleHours: 24,
          shifts: [
            { id: "day", durationHours: 24, assignments: { "trading-1": [operatorB, operatorA] } },
            { id: "day", durationHours: 24, assignments: { "trading-1": [operatorA, operatorB] } }
          ]
        }
      })
    });

    expect(result.cases[0]).toMatchObject({
      status: "non-gating",
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
    const fixture = resourceFixture("CN", {
      id: "cn-one-percent",
      referenceProvenance: { version: "cn-reference-v1", observedAt: "2026-08-04" },
      roster: { mode: "all-unlocked" },
      expected: {
        output: { lmd: 100 },
        formulas: ["lmd = 100"],
        tolerance: { type: "relative", value: 0.01, zeroExpectedAbsolute: 0.1 }
      }
    });
    const base = observation("CN", {
      metadata: {
        region: "CN",
        runtimeDataProvenance: {
          operatorAvailabilitySourceCommit: operatorAvailabilitySnapshot.regions.CN.source.commit
        },
        roster: { mode: "all-unlocked" }
      }
    });
    const within = runOptimizerBenchmarkBatch([fixture], { "cn-one-percent": { ...base, resources: { lmd: 101 } } });
    const outside = runOptimizerBenchmarkBatch([fixture], { "cn-one-percent": { ...base, resources: { lmd: 101.0001 } } });

    expect(within.cases[0]).toMatchObject({ status: "non-gating" });
    expect(within.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "calculation/resource-values/lmd",
      passed: true,
      absoluteError: 1,
      relativeError: 0.01,
      tolerance: { type: "relative", value: 0.01, zeroExpectedAbsolute: 0.1 }
    }));
    expect(outside.cases[0]).toMatchObject({ status: "non-gating", smallestMismatchPath: "calculation/resource-values/lmd" });
  });

  it("applies absolute tolerance and the explicit expected-zero fallback without division", () => {
    const absolute = runOptimizerBenchmarkBatch([resourceFixture("JP")], {
      "runner-case": observation("JP", { resources: { lmd: 100.5 } })
    });
    const zeroFixture = resourceFixture("JP", {
      expected: {
        output: { lmd: 0 },
        formulas: ["lmd = 0"],
        tolerance: { type: "relative", value: 0.01, zeroExpectedAbsolute: 0.25 }
      }
    });
    const zero = runOptimizerBenchmarkBatch([zeroFixture], {
      "runner-case": observation("JP", { resources: { lmd: 0.2 } })
    });

    expect(absolute.cases[0].status).toBe("non-gating");
    expect(zero.cases[0].status).toBe("non-gating");
    expect(zero.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "calculation/resource-values/lmd",
      absoluteError: 0.2,
      relativeError: undefined,
      appliedTolerance: { type: "absolute-zero-fallback", value: 0.25 }
    }));
  });

  it("accepts an explicitly declared equivalent composition without weakening resources", () => {
    const fixture = resourceFixture("JP");
    const [, , operatorC, operatorD] = genericOperatorIds("JP");
    (fixture as ResourceOutputBenchmark).expected.equivalentCompositions = [{
      shifts: [{ shiftId: "day", assignments: { "trading-1": [operatorC, operatorD] } }]
    }];
    const result = runOptimizerBenchmarkBatch([fixture], {
      "runner-case": observation("JP", {
        rotation: { cycleHours: 24, shifts: [{ id: "day", durationHours: 24, assignments: { "trading-1": [operatorD, operatorC] } }] },
        resources: { lmd: 99 }
      })
    });

    expect(result.cases[0]).toMatchObject({ status: "non-gating", matchedComposition: "equivalent[0]" });
    expect(result.cases[0].smallestMismatchPath).toBe("calculation/resource-values/lmd");
  });

  it("requires the primary composition to have exact facility and operator sets", () => {
    const [operatorA, operatorB, operatorC] = genericOperatorIds("JP");
    const extraFacility = runOptimizerBenchmarkBatch([resourceFixture("JP")], {
      "runner-case": observation("JP", {
        rotation: {
          cycleHours: 24,
          shifts: [{
            id: "day",
            durationHours: 24,
            assignments: {
              "trading-1": [operatorB, operatorA],
              "trading-label-only": [operatorC]
            }
          }]
        }
      })
    });
    const extraOperator = runOptimizerBenchmarkBatch([resourceFixture("JP")], {
      "runner-case": observation("JP", {
        rotation: {
          cycleHours: 24,
          shifts: [{
            id: "day",
            durationHours: 24,
            assignments: { "trading-1": [operatorB, operatorA, operatorC] }
          }]
        }
      })
    });

    expect(extraFacility.cases[0].matchedComposition).toBeUndefined();
    expect(extraFacility.cases[0].smallestMismatchPath).toBe("composition/search/day/trading-label-only/unexpected");
    expect(extraFacility.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "composition/search/day/trading-label-only/unexpected",
      category: "search",
      severity: "error",
      certainty: "suspected",
      expected: "absent",
      actual: "present"
    }));
    expect(extraOperator.cases[0].matchedComposition).toBeUndefined();
    expect(extraOperator.cases[0].smallestMismatchPath).toBe("composition/search/day/trading-1");
  });

  it("requires equivalent compositions to have exact facility sets", () => {
    const fixture = resourceFixture("JP") as ResourceOutputBenchmark;
    const [operatorA, , operatorC, operatorD] = genericOperatorIds("JP");
    fixture.expected.equivalentCompositions = [{
      shifts: [{ shiftId: "day", assignments: { "trading-1": [operatorC, operatorD] } }]
    }];
    const result = runOptimizerBenchmarkBatch([fixture], {
      "runner-case": observation("JP", {
        rotation: {
          cycleHours: 24,
          shifts: [{
            id: "day",
            durationHours: 24,
            assignments: {
              "trading-1": [operatorD, operatorC],
              "trading-label-only": [operatorA]
            }
          }]
        }
      })
    });

    expect(result.cases[0].matchedComposition).toBeUndefined();
    expect(result.cases[0].smallestMismatchPath).toBe("composition/search/day/trading-1");
    expect(result.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "composition/search/day/trading-label-only/unexpected",
      category: "search",
      severity: "error",
      expected: "absent",
      actual: "present"
    }));
  });

  it("orders mismatches canonically across declaration permutations", () => {
    const [operatorA, operatorB, operatorC, operatorD] = genericOperatorIds("JP");
    const fixture = resourceFixture("JP", {
      rotation: {
        cycleHours: 24,
        shifts: [
          { id: "night", durationHours: 12, assignments: { "trading-z": { operatorIds: [operatorC] }, "trading-a": { operatorIds: [operatorD] } } },
          { id: "day", durationHours: 12, assignments: { "trading-z": { operatorIds: [operatorA] }, "trading-a": { operatorIds: [operatorB] } } }
        ]
      }
    }) as ResourceOutputBenchmark;
    const permutedFixture = structuredClone(fixture);
    permutedFixture.rotation.shifts.reverse();
    for (const shift of permutedFixture.rotation.shifts) {
      shift.assignments = Object.fromEntries(Object.entries(shift.assignments).reverse());
    }
    const firstObservation = observation("JP", {
      rotation: {
        cycleHours: 24,
        shifts: [
          { id: "day", durationHours: 10, assignments: { "unexpected-z": [operatorA], "trading-a": [operatorB], "trading-z": [operatorA] } },
          { id: "night", durationHours: 10, assignments: { "unexpected-a": [operatorC], "trading-a": [operatorD], "trading-z": [operatorC] } }
        ]
      },
      resources: { lmd: 99 },
      interpretedEffects: [
        { id: "z-effect", expected: 2, actual: 1 },
        { id: "a-effect", expected: 2, actual: 1 }
      ],
      provenCauses: [
        { category: "calculation", path: "calculation/resource-values/lmd", evidence: "calculation audit" },
        { category: "interpretation", path: "skill-interpretation/a-effect", evidence: "skill audit" }
      ]
    });
    const permutedObservation = structuredClone(firstObservation);
    permutedObservation.rotation!.shifts.reverse();
    for (const shift of permutedObservation.rotation!.shifts) {
      shift.assignments = Object.fromEntries(Object.entries(shift.assignments).reverse());
    }
    permutedObservation.interpretedEffects!.reverse();
    permutedObservation.provenCauses!.reverse();

    const first = runOptimizerBenchmarkBatch([fixture], { "runner-case": firstObservation });
    const second = runOptimizerBenchmarkBatch([permutedFixture], { "runner-case": permutedObservation });

    expect(first.cases[0].smallestMismatchPath).toBe("rotation/state-model/shifts/day/durationHours");
    expect(second.cases[0].smallestMismatchPath).toBe(first.cases[0].smallestMismatchPath);
    expect(second.cases[0].diagnostics).toEqual(first.cases[0].diagnostics);
    expect(formatOptimizerBenchmarkBatchResult(second)).toBe(formatOptimizerBenchmarkBatchResult(first));
  });

  it("selects failures by the documented cross-category hierarchy", () => {
    const [operatorA, operatorB] = genericOperatorIds("CN");
    const fixture = gatingFixture("cross-category-hierarchy");
    const current = savedReferenceObservation(fixture);
    const firstShiftId = current.rotation!.shifts[0].id;
    current.metadata.region = "CN";
    current.metadata.referenceProvenance = { version: "wrong-reference" };
    current.metadata.runtimeDataProvenance = { operatorAvailabilitySourceCommit: alternativeCommit };
    current.metadata.roster = { mode: "explicit", operatorIds: [operatorA, operatorB] };
    current.rotation!.cycleHours += 1;
    current.rotation!.shifts[0].assignments.unexpected = [operatorA];
    current.resources = {
      ...current.resources,
      goldProduced: expectedResource(fixture, "goldProduced") - 1
    };
    const result = runOptimizerBenchmarkBatch([fixture], { [fixture.id]: current });

    expect(result.cases[0].smallestMismatchPath).toBe("metadata/reference-provenance/version");
    expect(result.cases[0].diagnostics.filter((item) => item.severity === "error").map((item) => item.path)).toEqual([
      "metadata/reference-provenance/version",
      "metadata/runtime-data-provenance/region",
      "metadata/runtime-data-provenance/operatorAvailabilitySourceCommit",
      "metadata/runtime-data-provenance/roster/operatorIds",
      "rotation/state-model/cycleHours",
      `composition/search/${firstShiftId}/unexpected/unexpected`,
      "calculation/resource-values/goldProduced"
    ]);
    expect(formatOptimizerBenchmarkBatchResult(result)).toContain(
      "FAIL cross-category-hierarchy metadata/reference-provenance/version:"
    );
  });

  it("reports wrong metadata, rotation, and composition at stable hierarchical paths", () => {
    const [operatorA, , operatorC] = genericOperatorIds("CN");
    const result = runOptimizerBenchmarkBatch([resourceFixture("JP")], {
      "runner-case": observation("JP", {
        metadata: {
          region: "CN",
          runtimeDataProvenance: { operatorAvailabilitySourceCommit: alternativeCommit },
          roster: { mode: "explicit", operatorIds: [operatorA] }
        },
        rotation: { cycleHours: 12, shifts: [{ id: "night", durationHours: 12, assignments: { "trading-1": [operatorC] } }] }
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
    const result = runOptimizerBenchmarkBatch([resourceFixture("JP")], { "runner-case": observation("JP") });

    expect(result.cases[0].status).toBe("non-gating");
    expect(result.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "metadata/reference-provenance/version",
      severity: "info",
      expected: "reference-plan-v1",
      actual: undefined
    }));
    expect(result.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "metadata/runtime-data-provenance/operatorAvailabilitySourceCommit",
      passed: true,
      expected: operatorAvailabilitySnapshot.regions.JP.source.commit,
      actual: operatorAvailabilitySnapshot.regions.JP.source.commit
    }));
  });

  it("diagnoses a runtime boundary mismatch at the precise source-data path", () => {
    const [operatorA, operatorB] = genericOperatorIds("JP");
    const result = runOptimizerBenchmarkBatch([resourceFixture("JP")], {
      "runner-case": observation("JP", {
        metadata: {
          region: "JP",
          runtimeDataProvenance: { operatorAvailabilitySourceCommit: alternativeCommit },
          roster: { mode: "explicit", operatorIds: [operatorA, operatorB] }
        }
      })
    });

    expect(result.cases[0]).toMatchObject({
      status: "non-gating",
      smallestMismatchPath: "metadata/runtime-data-provenance/operatorAvailabilitySourceCommit"
    });
  });

  it("fails when a fixture requires a runtime boundary but the observation omits it", () => {
    const [operatorA, operatorB] = genericOperatorIds("JP");
    const result = runOptimizerBenchmarkBatch([resourceFixture("JP")], {
      "runner-case": observation("JP", {
        metadata: { region: "JP", roster: { mode: "explicit", operatorIds: [operatorA, operatorB] } }
      })
    });

    expect(result.cases[0]).toMatchObject({
      status: "non-gating",
      smallestMismatchPath: "metadata/runtime-data-provenance/operatorAvailabilitySourceCommit"
    });
    expect(result.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "metadata/runtime-data-provenance/operatorAvailabilitySourceCommit",
      actual: undefined,
      severity: "error"
    }));
  });

  it("never substitutes reference provenance for a missing runtime boundary", () => {
    const [operatorA, operatorB] = genericOperatorIds("JP");
    const result = runOptimizerBenchmarkBatch([resourceFixture("JP")], {
      "runner-case": observation("JP", {
        metadata: {
          region: "JP",
          referenceProvenance: { version: alternativeCommit },
          roster: { mode: "explicit", operatorIds: [operatorA, operatorB] }
        }
      })
    });

    expect(result.cases[0]).toMatchObject({
      status: "non-gating",
      smallestMismatchPath: "metadata/reference-provenance/version"
    });
    expect(result.cases[0].diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "metadata/reference-provenance/version",
        expected: "reference-plan-v1",
        actual: alternativeCommit
      }),
      expect.objectContaining({
        path: "metadata/runtime-data-provenance/operatorAvailabilitySourceCommit",
        actual: undefined
      })
    ]));
  });

  it("reports explicit interpretation checks and only auditor evidence as proven", () => {
    const result = runOptimizerBenchmarkBatch([resourceFixture("JP")], {
      "runner-case": observation("JP", {
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

  it("compares every disputed formula ID deterministically without making it gate", () => {
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
      status: "non-gating",
      smallestMismatchPath: "calculation/formula-values/operator-morale-cap"
    });
  });

  it("reports a deterministic formula-derived mismatch from a valid gating observation", () => {
    const fixture = gatingFixture("gating-formula-mismatch");
    const current = savedReferenceObservation(fixture);
    current.resources = { ...current.resources, goldProduced: expectedResource(fixture, "goldProduced") + 1 };
    const result = runOptimizerBenchmarkBatch([fixture], { [fixture.id]: current });

    expect(fixture.expected.formulas).not.toHaveLength(0);
    expect(result.cases[0]).toMatchObject({
      status: "failed",
      gating: true,
      smallestMismatchPath: "calculation/resource-values/goldProduced"
    });
  });

  it("executes disputed observations diagnostically but excludes them from gating", () => {
    const fixture = resourceFixture("JP", { confidence: "disputed" });
    const result = runOptimizerBenchmarkBatch([fixture], {
      "runner-case": observation("JP", { resources: { lmd: 1 } })
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
      gatingFixture("missing-case"),
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
    const result = runOptimizerBenchmarkBatch([resourceFixture("JP")], {
      "runner-case": observation("JP", { resources: { lmd: 100, goldProduced: 4 } })
    });

    expect(result.cases[0].status).toBe("non-gating");
    expect(result.cases[0].diagnostics).toContainEqual(expect.objectContaining({
      path: "calculation/resource-values/goldProduced",
      severity: "info",
      message: expect.stringContaining("extra actual resource")
    }));
  });

  it("preserves fixture order, formats deterministic minimal failures, and does not mutate inputs", () => {
    const fixtures = [gatingFixture("z-first"), gatingFixture("a-second")];
    const observations: BenchmarkObservationMap = {
      "z-first": savedReferenceObservation(fixtures[0]),
      "a-second": savedReferenceObservation(fixtures[1])
    };
    observations["z-first"]!.resources = {
      ...observations["z-first"]!.resources,
      goldProduced: expectedResource(fixtures[0], "goldProduced") - 1
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
      "FAIL z-first calculation/resource-values/goldProduced: expected 91.183333333333, actual 90.183333333333, absolute error 1 exceeds absolute tolerance 0",
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
              )),
              remoteSupportOperatorIds: Object.fromEntries(Object.entries(shift.assignments).flatMap(([facilityId, assignment]) =>
                assignment.remoteSupport?.operatorIds ? [[facilityId, [...assignment.remoteSupport.operatorIds]]] : []
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
