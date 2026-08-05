import { describe, expect, it } from "vitest";
import jpFactoryInput from "../data/optimizer-benchmarks/jp-243-factory-3group-2025-11.json";
import { createDefaultState } from "../data/defaults";
import { effectiveBenchmarkScheduleAuthority, validateOptimizerBenchmark } from "./optimizerBenchmark";
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
  it("fails closed only on Aroma fatigue while retaining complete exact resource mechanics", () => {
    const fixture = validatedFixture();
    const diagnostic = evaluateReferenceCompositionDiagnostic(fixture);

    expect(diagnostic.status).toBe("incomplete");
    if (diagnostic.status !== "incomplete") throw new Error("diagnostic unexpectedly completed");
    expect(diagnostic.diagnostics).toEqual([expect.objectContaining({
      code: "fatigued-before-shift-end",
      path: "sustainability",
      message: expect.stringContaining("char_446_aroma")
    })]);
    expect(diagnostic.diagnostics[0].message).toContain("groups-b-c");
    expect(diagnostic.diagnostics).not.toContainEqual(expect.objectContaining({
      code: "drone-state-not-closed"
    }));
    expect(diagnostic.objectiveEvidence).toMatchObject({
      status: "incomplete",
      authority: "unavailable",
      objectiveProfile: "balanced",
      weights: { gold: 0.5, battleRecord: 0.5, lmd: 0 },
      provenance: "exact-window-facility-normal-mechanics-evaluation",
      completeness: {
        supportResourceScenario: "complete",
        resourceEvaluation: "complete",
        requiredWindowIds: ["groups-a-b", "groups-b-c", "groups-c-a"],
        evaluatedWindowIds: ["groups-a-b", "groups-b-c", "groups-c-a"],
        requiredFacilityEvaluationCount: 12,
        evaluatedFacilityEvaluationCount: 12
      },
      reason: "reference-sustainability-incomplete"
    });
    expect(diagnostic.objectiveEvidence.sustainability).toMatchObject({
      status: "evaluated",
      result: {
        sustainable: false,
        failures: [expect.objectContaining({
          code: "fatigued-before-shift-end",
          operatorId: "char_446_aroma",
          shiftId: "groups-b-c"
        })]
      }
    });
    expect(diagnostic.resourceEvaluation).toMatchObject({ status: "complete" });
    expect(diagnostic.resourceEvaluation?.drone?.targetFacilityId).toMatch(/^trading-/);
    expect(diagnostic.resourceEvaluation?.cycleLedger?.dronesGenerated)
      .toBeCloseTo(diagnostic.resourceEvaluation?.cycleLedger?.dronesUsed ?? Number.NaN, 12);
  });

  it("uses each declared schedule window duration for the authoritative objective", () => {
    const fixture = structuredClone(validatedFixture());
    fixture.rotation.cycleHours = 24;
    fixture.rotation.shifts.forEach((shift) => { shift.durationHours = 8; });

    const diagnostic = evaluateReferenceCompositionDiagnostic(fixture);

    expect(diagnostic.status).toBe("complete");
    if (diagnostic.status !== "complete") throw new Error(JSON.stringify(diagnostic.diagnostics));
    expect(diagnostic.objectiveEvidence.completeness).toMatchObject({
      requiredFacilityEvaluationCount: 12,
      evaluatedFacilityEvaluationCount: 12
    });
    expect(Number.isFinite(diagnostic.objectiveEvidence.value)).toBe(true);
  });

  it("calculates the declared composition through ordinary mechanics", () => {
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

    expect(diagnostic.status).toBe("incomplete");
    if (diagnostic.status !== "incomplete") throw new Error("diagnostic unexpectedly completed");
    expect(diagnostic.resourceEvaluation).toMatchObject({ status: "complete" });
    const perceptionWindows = diagnostic.resourceEvaluation!.windows.flatMap((window) =>
      window.facilities.filter((facility) => facility.operatorIds.includes("char_391_rosmon"))
    );
    expect(perceptionWindows).toEqual([
      expect.objectContaining({
        efficiencyEvaluation: expect.objectContaining({
          fixedResourceAmounts: expect.objectContaining({ perceptionInfo: 20 }),
          fixedDormitoryOccupancy: 20
        })
      }),
      expect.objectContaining({
        efficiencyEvaluation: expect.objectContaining({
          fixedResourceAmounts: expect.objectContaining({ perceptionInfo: 10 }),
          fixedDormitoryOccupancy: 20
        })
      })
    ]);
    expect(diagnostic.resourceEvaluation!.evidence?.fixedSources).toHaveLength(8);
    expect(new Set(diagnostic.resourceEvaluation!.evidence?.fixedSources.map((source) => source.sourceId)).size).toBe(8);
    expect(diagnostic.resourceEvaluation!.drone?.targetFacilityId).toMatch(/^trading-/);
    expect(diagnostic.resourceEvaluation!.cycleLedger?.dronesGenerated)
      .toBeCloseTo(diagnostic.resourceEvaluation!.cycleLedger?.dronesUsed ?? Number.NaN, 12);
  });

  it("fails closed through the public diagnostic when rotation schedule authority is incomplete", () => {
    const fixture = structuredClone(validatedFixture());
    fixture.rotation.shifts[0].workerGroupIds = ["not stable"];

    const diagnostic = evaluateReferenceCompositionDiagnostic(fixture);

    expect(diagnostic).toEqual(expect.objectContaining({
      status: "incomplete",
      diagnostics: expect.arrayContaining([
        {
          code: "schedule-authority-incomplete",
          path: "rotation",
          message: "rotation.shifts[0].workerGroupIds[0] must be a stable ID"
        }
      ]),
      objectiveEvidence: expect.objectContaining({
        status: "incomplete",
        authority: "unavailable",
        reason: "schedule-authority-incomplete"
      })
    }));
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

  it("keeps mechanically evaluated reference objective evidence independent of expected output", () => {
    const original = validatedFixture();
    const changed = structuredClone(original);
    changed.expected.output.goldProduced = 987654321;
    changed.expected.output.battleRecordExp = 123456789;

    expect(evaluateReferenceCompositionDiagnostic(changed).objectiveEvidence)
      .toEqual(evaluateReferenceCompositionDiagnostic(original).objectiveEvidence);
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
