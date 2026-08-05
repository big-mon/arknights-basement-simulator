import { describe, expect, it } from "vitest";
import jpFactoryInput from "../data/optimizer-benchmarks/jp-243-factory-3group-2025-11.json";
import { createDefaultState } from "../data/defaults";
import { effectiveBenchmarkScheduleAuthority, validateOptimizerBenchmark } from "./optimizerBenchmark";
import { runOptimizerBenchmarkBatch } from "./optimizerBenchmarkRunner";
import { evaluateReferenceCompositionDiagnostic } from "./optimizerReferenceDiagnostic";
import { inspectExplicitFacilityTeams } from "./optimizer";

function validatedFixture() {
  const validated = validateOptimizerBenchmark(jpFactoryInput);
  if (!validated.ok || validated.value.kind !== "resource-output") {
    throw new Error(validated.ok ? "wrong fixture kind" : validated.errors.join("\n"));
  }
  return validated.value;
}

describe("JP normalized-theoretical reference composition diagnostic", () => {
  it("calculates the declared composition through ordinary mechanics within relative 0.1%", () => {
    const fixture = validatedFixture();
    expect(effectiveBenchmarkScheduleAuthority(fixture)).toEqual({
      status: "complete",
      source: "rotation-witness",
      schedule: {
        cycleHours: 36,
        groups: [{ id: "group-a" }, { id: "group-b" }, { id: "group-c" }],
        shifts: [
          {
            id: "groups-a-b",
            durationHours: 12,
            startHour: 0,
            endHour: 12,
            activeGroupIds: ["group-a", "group-b"],
            recoveryGroupIds: ["group-c"]
          },
          {
            id: "groups-b-c",
            durationHours: 12,
            startHour: 12,
            endHour: 24,
            activeGroupIds: ["group-b", "group-c"],
            recoveryGroupIds: ["group-a"]
          },
          {
            id: "groups-c-a",
            durationHours: 12,
            startHour: 24,
            endHour: 36,
            activeGroupIds: ["group-c", "group-a"],
            recoveryGroupIds: ["group-b"]
          }
        ]
      }
    });
    const diagnostic = evaluateReferenceCompositionDiagnostic(fixture);

    expect(diagnostic.status).toBe("complete");
    if (diagnostic.status !== "complete") throw new Error(JSON.stringify(diagnostic.diagnostics));
    expect(diagnostic.resources.goldProduced).toBeCloseTo(91.38333333333334, 10);
    expect(diagnostic.resources.battleRecordExp).toBeCloseTo(33830, 8);
    expect(diagnostic.observation.rotation).toMatchObject({
      cycleHours: 36,
      shifts: [
        {
          id: "groups-a-b",
          durationHours: 12,
          startHour: 0,
          endHour: 12,
          activeGroupIds: ["group-a", "group-b"],
          recoveryGroupIds: ["group-c"]
        },
        {
          id: "groups-b-c",
          durationHours: 12,
          startHour: 12,
          endHour: 24,
          activeGroupIds: ["group-b", "group-c"],
          recoveryGroupIds: ["group-a"]
        },
        {
          id: "groups-c-a",
          durationHours: 12,
          startHour: 24,
          endHour: 36,
          activeGroupIds: ["group-c", "group-a"],
          recoveryGroupIds: ["group-b"]
        }
      ]
    });

    const perceptionWindows = diagnostic.resourceEvaluation.windows.flatMap((window) =>
      window.facilities.filter((facility) => facility.operatorIds.includes("char_391_rosmon"))
    );
    expect(perceptionWindows).toEqual([
      expect.objectContaining({
        efficiencyEvaluation: expect.objectContaining({
          fixedResourceAmounts: { perceptionInfo: 20 },
          fixedDormitoryOccupancy: 20
        })
      }),
      expect.objectContaining({
        efficiencyEvaluation: expect.objectContaining({
          fixedResourceAmounts: { perceptionInfo: 10 },
          fixedDormitoryOccupancy: 20
        })
      })
    ]);
    expect(diagnostic.resourceEvaluation.evidence?.fixedSources).toHaveLength(8);
    expect(new Set(diagnostic.resourceEvaluation.evidence?.fixedSources.map((source) => source.sourceId)).size).toBe(8);

    const batch = runOptimizerBenchmarkBatch([fixture], { [fixture.id]: diagnostic.observation });
    expect(batch.aggregateStatus).toBe("passed");
    expect(batch.counts.passed).toBe(1);
  });

  it("fails closed through the public diagnostic when rotation schedule authority is incomplete", () => {
    const fixture = structuredClone(validatedFixture());
    fixture.rotation.shifts[0].workerGroupIds = ["not stable"];

    const diagnostic = evaluateReferenceCompositionDiagnostic(fixture);

    expect(diagnostic).toEqual({
      status: "incomplete",
      diagnostics: expect.arrayContaining([
        {
          code: "schedule-authority-incomplete",
          path: "rotation",
          message: "rotation.shifts[0].workerGroupIds[0] must be a stable ID"
        }
      ])
    });
    expect("resources" in diagnostic).toBe(false);
  });

  it("is deterministic when support source input order changes", () => {
    const fixture = validatedFixture();
    const reversed = structuredClone(fixture);
    reversed.supportResourceScenario!.sources.reverse();

    expect(evaluateReferenceCompositionDiagnostic(reversed)).toEqual(
      evaluateReferenceCompositionDiagnostic(fixture)
    );
  });

  it("returns typed incomplete output when ordinary remote supports overbook a support facility", () => {
    const fixture = structuredClone(validatedFixture());
    const shift = fixture.rotation.shifts.find((candidate) => candidate.id === "groups-b-c");
    if (!shift) throw new Error("groups-b-c fixture shift is missing");
    const assignment = shift.assignments["factory-battle-record-1"];
    if (!assignment) throw new Error("fixture assignment is missing");
    const remoteSupport = assignment.remoteSupport = {
      facilityId: "control-1",
      operatorIds: ["char_420_flamtl"],
      notes: ["Synthetic overbooking mutation"]
    };
    remoteSupport.operatorIds.push(
      "char_002_amiya",
      "char_400_weedy",
      "char_416_zumama"
    );

    const diagnostic = evaluateReferenceCompositionDiagnostic(fixture);

    expect(diagnostic.status).toBe("incomplete");
    if (diagnostic.status !== "incomplete") throw new Error("diagnostic unexpectedly completed");
    expect(diagnostic.diagnostics).toContainEqual(expect.objectContaining({
      code: "source-facility-capacity-conflict",
      operatorId: "char_2015_dusk",
      facilityId: "control-1"
    }));
    expect("resources" in diagnostic).toBe(false);
  });

  it.each(["char_436_whispr", "char_2015_dusk"])(
    "returns typed incomplete output when fixed source %s is unowned",
    (operatorId) => {
      const diagnostic = evaluateReferenceCompositionDiagnostic(validatedFixture(), {
        unownedOperatorIds: [operatorId]
      });

      expect(diagnostic).toEqual(expect.objectContaining({ status: "incomplete" }));
      if (diagnostic.status !== "incomplete") throw new Error("diagnostic unexpectedly completed");
      expect(diagnostic.diagnostics).toContainEqual(expect.objectContaining({
        code: "source-operator-unowned",
        operatorId
      }));
      expect("resources" in diagnostic).toBe(false);
    }
  );

  it.each(["char_436_whispr", "char_2015_dusk"])(
    "returns typed incomplete output when fixed source %s is missing",
    (operatorId) => {
      const fixture = structuredClone(validatedFixture());
      fixture.supportResourceScenario!.sources.find((source) => source.operatorId === operatorId)!.operatorId =
        `missing-${operatorId}`;
      const diagnostic = evaluateReferenceCompositionDiagnostic(fixture);

      expect(diagnostic).toEqual(expect.objectContaining({ status: "incomplete" }));
      if (diagnostic.status !== "incomplete") throw new Error("diagnostic unexpectedly completed");
      expect(diagnostic.diagnostics).toContainEqual(expect.objectContaining({
        code: "source-operator-not-found",
        operatorId: `missing-${operatorId}`
      }));
      expect("resources" in diagnostic).toBe(false);
    }
  );
});

describe("explicit facility-team inspection validation", () => {
  it("rejects missing facilities, unowned operators, conflicts, and over-capacity teams deterministically", () => {
    const state = createDefaultState();
    const input = {
      teams: [{
        facilityId: "factory-1",
        operatorIds: ["char_241_panda", "char_241_panda", "char_159_peacok", "char_4054_malist"]
      }, {
        facilityId: "missing-facility",
        operatorIds: ["missing-operator"]
      }],
      evaluationHours: 12
    } as const;

    const first = inspectExplicitFacilityTeams(state, input);
    const second = inspectExplicitFacilityTeams(state, input);
    expect(first).toEqual(second);
    expect(first.status).toBe("incomplete");
    expect(first.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(expect.arrayContaining([
      "facility-capacity-exceeded",
      "facility-not-found",
      "operator-assignment-conflict",
      "operator-not-found",
      "operator-unowned"
    ]));
    expect(first.teams).toEqual([]);
    expect(first.supportAssignments).toEqual([]);
  });
});
