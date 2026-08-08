import { describe, expect, it, vi } from "vitest";
import {
  buildFacilityTeamOptionSet,
  effectiveFacilityEfficiency,
  facilityTeamEligibleForScheduleComparison
} from "./optimizer";
import {
  inspectConflictFreePrefrontier,
  searchBestConflictFreeOptions,
  type ConflictFreeSearchDimension,
  type ConflictFreeSearchOption
} from "./compositionSearch";
import type { Assignment } from "../types";

function option(
  stableId: string,
  score: number,
  conflictKeys: readonly string[] = [],
  extra: Partial<ConflictFreeSearchOption<string>> = {}
): ConflictFreeSearchOption<string> {
  return { stableId, score, conflictKeys, value: stableId, ...extra };
}

function material(result: ReturnType<typeof searchBestConflictFreeOptions<string>>) {
  return result.options.map(({ stableId }) => stableId);
}

function bruteForce(dimensions: readonly ConflictFreeSearchDimension<string>[]) {
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestSignature = "";
  const visit = (index: number, used: Set<string>, selected: string[], score: number) => {
    if (index === dimensions.length) {
      const signature = selected.join("|");
      if (score > bestScore || (score === bestScore && signature < bestSignature)) {
        bestScore = score;
        bestSignature = signature;
      }
      return;
    }
    for (const candidate of dimensions[index].options) {
      const keys = candidate.conflictKeys ?? [];
      if (keys.some((key) => used.has(key))) continue;
      visit(index + 1, new Set([...used, ...keys]), [...selected, candidate.stableId], score + candidate.score);
    }
  };
  visit(0, new Set(), [], 0);
  return { score: bestScore, signature: bestSignature };
}

describe("deterministic conflict-free composition search", () => {
  it("finds the exact exhaustive optimum with a stable tie-break on tiny inputs", () => {
    const result = searchBestConflictFreeOptions([
      { stableId: "a", options: [option("a-z", 4, ["shared"]), option("a-a", 3, ["free"])] },
      { stableId: "b", options: [option("b-z", 7, ["shared"]), option("b-a", 6, ["other"])] }
    ]);

    expect(material(result)).toEqual(["a-a", "b-z"]);
    expect(result.diagnostic).toMatchObject({ completion: "complete", optimality: "certified" });
  });

  it("agrees with a brute-force oracle for every certified deterministic tiny case", () => {
    for (let seed = 0; seed < 40; seed += 1) {
      const dimensions = Array.from({ length: 3 }, (_, dimensionIndex) => ({
        stableId: `d-${dimensionIndex}`,
        options: Array.from({ length: 4 }, (_, optionIndex) => option(
          `o-${dimensionIndex}-${optionIndex}`,
          ((seed + 3) * (dimensionIndex + 5) * (optionIndex + 7)) % 19,
          optionIndex === 3 ? [] : [`k-${(seed + dimensionIndex + optionIndex) % 4}`]
        ))
      }));
      const result = searchBestConflictFreeOptions(dimensions);
      expect(result.diagnostic.optimality).toBe("certified");
      const oracle = bruteForce(dimensions);
      expect(result.options.reduce((sum, item) => sum + item.score, 0)).toBe(oracle.score);
      expect(material(result).join("|")).toBe(oracle.signature);
    }
  });

  it("does not count an explicitly empty option as filling a required dimension", () => {
    const result = searchBestConflictFreeOptions([
      { stableId: "required", options: [option("empty", 0, [], { fillsDimension: false })] },
      { stableId: "other", options: [option("worker", 1, ["worker"])] }
    ]);

    expect(result.options).toEqual([]);
    expect(result.diagnostic).toMatchObject({
      completion: "infeasible",
      incompleteDimensionIds: ["required"]
    });
  });

  it("does not lose the seventeenth facility team by insertion order", () => {
    const candidates: Assignment[] = Array.from({ length: 17 }, (_, index) => ({
      facilityId: "factory-a",
      operatorId: `operator-${String(index + 1).padStart(2, "0")}`,
      skillId: `skill-${index}`,
      score: 100 - index,
      efficiency: 1,
      fatigueHours: 24,
      recoveryHours: 6,
      reason: "Issue #28 candidate regression"
    }));

    expect(buildFacilityTeamOptionSet(candidates, 1).options.map((team) => team[0]?.operatorId))
      .toContain("operator-17");
  });

  it("bounds facility candidate construction independently of roster insertion order", () => {
    const candidates: Assignment[] = Array.from({ length: 80 }, (_, index) => ({
      facilityId: "factory-a",
      operatorId: `operator-${String(index + 1).padStart(2, "0")}`,
      skillId: `skill-${String(index + 1).padStart(2, "0")}`,
      score: 200 - index,
      efficiency: 1,
      fatigueHours: 24,
      recoveryHours: 6,
      reason: "Issue #28 bounded candidate-construction regression",
      contextSensitive: index % 7 === 0 || undefined,
      facilityStatScalings: index % 3 === 0
        ? [{
            key: index % 2 === 0 ? "storageLimit" : "orderLimit",
            base: 0,
            current: index % 5,
            efficiencyPerStep: 0.01,
            scorePerEfficiency: 1
          }]
        : undefined
    }));
    const signatures = (input: Assignment[]) => buildFacilityTeamOptionSet(input, 3).options
      .map((team) => team.map(({ operatorId, skillId }) => `${operatorId}:${skillId}`).sort().join("|"));

    const canonical = signatures(candidates);
    const reversed = signatures([...candidates].reverse());

    expect(canonical.length).toBeLessThanOrEqual(320);
    expect(reversed).toEqual(canonical);
    expect(buildFacilityTeamOptionSet(candidates, 3).diagnostic).toMatchObject({
      optimality: "not-certified",
      limitation: "candidate-generation-limited",
      retainedOptionCount: canonical.length
    });
  });

  it("keeps cached facility team options isolated from consumer mutation", () => {
    const candidates = (): Assignment[] => [
      {
        facilityId: "factory-cache-isolation",
        operatorId: "cache-isolation-a",
        skillId: "cache-isolation-skill-a",
        score: 20,
        efficiency: 1.2,
        globalStackKeys: ["cache-isolation-stack"],
        facilityStatScalings: [{
          key: "storageLimit",
          base: 0,
          current: 1,
          efficiencyPerStep: 0.01,
          scorePerEfficiency: 1
        }],
        fatigueHours: 24,
        recoveryHours: 6,
        reason: "facility-team cache isolation regression"
      },
      {
        facilityId: "factory-cache-isolation",
        operatorId: "cache-isolation-b",
        skillId: "cache-isolation-skill-b",
        score: 10,
        efficiency: 1.1,
        fatigueHours: 24,
        recoveryHours: 6,
        reason: "facility-team cache isolation regression"
      }
    ];
    const controlCandidates = (): Assignment[] => [{
      facilityId: "factory-cache-isolation-control",
      operatorId: "cache-isolation-control",
      skillId: "cache-isolation-control-skill",
      score: 5,
      efficiency: 1.05,
      fatigueHours: 24,
      recoveryHours: 6,
      reason: "facility-team cache isolation control"
    }];
    const controlBefore = buildFacilityTeamOptionSet(controlCandidates(), 1);
    const first = buildFacilityTeamOptionSet(candidates(), 2);
    const expected = structuredClone(first);
    const populatedOption = first.options.find((option) => option.length === 2);
    const assignment = populatedOption?.find(({ operatorId }) => operatorId === "cache-isolation-a");

    expect(first.diagnostic.cacheHit).toBe(false);
    expect(populatedOption).toBeDefined();
    expect(assignment).toBeDefined();
    expect(() => {
      first.options.reverse();
      populatedOption!.reverse();
      assignment!.efficiency = 999;
      assignment!.reason = "poisoned reason";
      assignment!.globalStackKeys!.push("poisoned-stack");
      assignment!.facilityStatScalings![0].current = 999;
      first.diagnostic.retainedOptionCount = 999;
      first.options.push([]);
      first.options = [];
      first.diagnostic = { ...first.diagnostic, inputCandidateCount: 999 };
    }).not.toThrow();

    const second = buildFacilityTeamOptionSet(candidates(), 2);
    const controlAfter = buildFacilityTeamOptionSet(controlCandidates(), 1);

    expect(second.diagnostic.cacheHit).toBe(true);
    expect(second.options).toEqual(expected.options);
    expect(second.diagnostic).toEqual({ ...expected.diagnostic, cacheHit: true });
    expect(controlAfter.diagnostic.cacheHit).toBe(true);
    expect(controlAfter.options).toEqual(controlBefore.options);
    expect({ ...controlAfter.diagnostic, cacheHit: controlBefore.diagnostic.cacheHit })
      .toEqual(controlBefore.diagnostic);
  });

  it("retains a zero-score context dependency with another context mechanic and ordinary filler", () => {
    const ordinary: Assignment[] = Array.from({ length: 12 }, (_, index) => ({
      facilityId: "factory-a",
      operatorId: `ordinary-${index}`,
      skillId: `ordinary-skill-${index}`,
      score: 100 - index,
      efficiency: 1,
      fatigueHours: 24,
      recoveryHours: 6,
      reason: "ordinary filler"
    }));
    const contextPair: Assignment[] = [
      {
        ...ordinary[0], operatorId: "resource-context", skillId: "resource-scaling", score: 0,
        contextSensitive: true
      },
      {
        ...ordinary[0], operatorId: "time-context", skillId: "time-curve", score: 2,
        contextSensitive: true
      }
    ];
    const signatures = buildFacilityTeamOptionSet([...ordinary, ...contextPair], 3).options
      .map((team) => team.map(({ operatorId }) => operatorId).sort().join("|"));

    expect(signatures).toContain("ordinary-0|resource-context|time-context");
  });

  it("admits modeled suppression-exempt teams to schedule comparison without changing legacy greedy selection", () => {
    const assignment = (operatorId: string, overrides: Partial<Assignment>): Assignment => ({
      facilityId: "factory-a",
      operatorId,
      skillId: `${operatorId}-skill`,
      score: 1,
      efficiency: 0.45,
      fatigueHours: 24,
      recoveryHours: 6,
      reason: "generic suppression eligibility regression",
      ...overrides
    });
    const suppressorA = assignment("suppressor-a", { suppressesOtherFactoryEfficiency: true });
    const suppressorB = assignment("suppressor-b", { suppressesOtherFactoryEfficiency: true });
    const ordinary = assignment("ordinary", { efficiency: 0.4 });
    const exemptRaw = assignment("context-exempt", {
      contextSensitive: true,
      efficiency: 0.2,
      factoryEfficiencySuppressionExemptEfficiency: 0.2
    });
    const exemptReevaluated = {
      ...exemptRaw,
      efficiency: 0.5,
      factoryEfficiencySuppressionExemptEfficiency: 0.5
    };
    const invalidTeam = [suppressorA, suppressorB, ordinary];
    const validRawTeam = [suppressorA, suppressorB, exemptRaw];
    const validReevaluatedTeam = [suppressorA, suppressorB, exemptReevaluated];
    const signatures = (assignments: Assignment[]) => buildFacilityTeamOptionSet(assignments, 3).options
      .map((team) => team.map(({ operatorId }) => operatorId).sort().join("|"));

    expect(signatures(invalidTeam)).not.toContain("ordinary|suppressor-a|suppressor-b");
    expect(facilityTeamEligibleForScheduleComparison(invalidTeam, invalidTeam, 3)).toBe(false);
    expect(signatures(validRawTeam)).toContain("context-exempt|suppressor-a|suppressor-b");
    expect(facilityTeamEligibleForScheduleComparison(validRawTeam, validReevaluatedTeam, 3)).toBe(true);
    expect(effectiveFacilityEfficiency(validReevaluatedTeam)).toBeCloseTo(1.4);
  });

  it("retains a facility-stat consumer with deep representative provider amounts", () => {
    const provider = (operatorId: string, score: number, storageLimit: number): Assignment => ({
      facilityId: "factory-a",
      operatorId,
      skillId: `provider-${storageLimit}`,
      score,
      efficiency: 1,
      storageLimit,
      fatigueHours: 24,
      recoveryHours: 6,
      reason: "facility-stat provider"
    });
    const consumer: Assignment = {
      ...provider("storage-consumer", 1, 8),
      skillId: "storage-scaling",
      contextSensitive: true,
      scalesWithFacilityStat: ["storageLimit"],
      facilityStatScalings: [{
        key: "storageLimit", base: 8, current: 8, efficiencyPerStep: 0.02, scorePerEfficiency: 1
      }]
    };
    const candidates = [
      provider("rank-1", 100, 1),
      provider("rank-2", 99, 2),
      provider("rank-3", 98, 3),
      provider("rank-4", 97, 4),
      provider("deep-eight", 20, 8),
      provider("deep-twelve", 19, 12),
      consumer
    ];
    const signatures = buildFacilityTeamOptionSet(candidates, 3).options
      .map((team) => team.map(({ operatorId }) => operatorId).sort().join("|"));

    expect(signatures).toContain("deep-eight|deep-twelve|storage-consumer");
  });

  it("retains a globally compatible option beyond the former 128-state beam", () => {
    const first = Array.from({ length: 128 }, (_, index) =>
      option(`local-${String(index).padStart(3, "0")}`, 300 - index, ["shared", `local-${index}`])
    );
    const result = searchBestConflictFreeOptions([
      { stableId: "a", options: [...first, option("deep-compatible", 1, ["free"])] },
      { stableId: "b", options: [option("payoff", 1000, ["shared"]), option("fallback", 0)] }
    ]);

    expect(material(result)).toEqual(["deep-compatible", "payoff"]);
    expect(result.diagnostic).toMatchObject({ optimality: "not-certified", limitation: "prefrontier-limited" });
  });

  it("recovers a complete nine-dimension witness omitted by pairwise prefrontier diversity", () => {
    const dimensions: ConflictFreeSearchDimension<string>[] = [{
      stableId: "d-0",
      options: [
        ...Array.from({ length: 64 }, (_, index) => option(
          `high-${String(index).padStart(2, "0")}`,
          1000 - index,
          [`block-${String(index).padStart(2, "0")}`]
        )),
        option("low-complete-witness", 1, ["free"])
      ]
    }];
    for (let dimensionIndex = 1; dimensionIndex < 9; dimensionIndex += 1) {
      const conflicts = Array.from({ length: 8 }, (_, offset) =>
        `block-${String((dimensionIndex - 1) * 8 + offset).padStart(2, "0")}`
      );
      dimensions.push({
        stableId: `d-${dimensionIndex}`,
        options: Array.from({ length: 3 }, (_, optionIndex) =>
          option(`fixed-${dimensionIndex}-${optionIndex}`, 10 - optionIndex, conflicts)
        )
      });
    }

    const result = searchBestConflictFreeOptions(dimensions);

    expect(result.diagnostic).toMatchObject({
      completion: "complete",
      optimality: "not-certified",
      limitation: "optimization-budget-limited"
    });
    expect(material(result)).toContain("low-complete-witness");
    expect(result.options).toHaveLength(9);
  });

  it("score-optimizes complete witnesses after the bounded score frontier dead-ends", () => {
    const dimensions: ConflictFreeSearchDimension<string>[] = [{
      stableId: "d-0",
      options: [
        ...Array.from({ length: 64 }, (_, index) => option(
          `dead-end-${String(index).padStart(2, "0")}`,
          1000 - index,
          [`block-${String(index).padStart(2, "0")}`]
        )),
        option("higher-score-complete", 500, ["decoy-conflict"]),
        option("low-score-feasibility-witness", 1)
      ]
    }];
    for (let dimensionIndex = 1; dimensionIndex < 9; dimensionIndex += 1) {
      const fatalConflicts = Array.from({ length: 8 }, (_, offset) =>
        `block-${String((dimensionIndex - 1) * 8 + offset).padStart(2, "0")}`
      );
      dimensions.push({
        stableId: `d-${dimensionIndex}`,
        options: [
          ...Array.from({ length: 70 }, (_, optionIndex) => option(
            `decoy-${dimensionIndex}-${String(optionIndex).padStart(2, "0")}`,
            9 - optionIndex,
            [...fatalConflicts, "decoy-conflict"]
          )),
          option(`fixed-${dimensionIndex}`, 10, fatalConflicts)
        ]
      });
    }

    const result = searchBestConflictFreeOptions(dimensions);

    expect(result.diagnostic.completion).toBe("complete");
    expect(material(result)).toContain("higher-score-complete");
    expect(material(result)).not.toContain("low-score-feasibility-witness");
    expect(result.options.reduce((sum, candidate) => sum + candidate.score, 0)).toBe(580);
  });

  it("selects the same bounded result and diagnostics under slow and fast clocks", () => {
    const dimensions: ConflictFreeSearchDimension<string>[] = [{
      stableId: "d-0",
      options: [
        ...Array.from({ length: 64 }, (_, index) => option(
          `dead-end-${String(index).padStart(2, "0")}`,
          1000 - index,
          [`block-${String(index).padStart(2, "0")}`]
        )),
        option("higher-score-complete", 500, ["decoy-conflict"]),
        option("low-score-feasibility-witness", 1)
      ]
    }];
    for (let dimensionIndex = 1; dimensionIndex < 9; dimensionIndex += 1) {
      const fatalConflicts = Array.from({ length: 8 }, (_, offset) =>
        `block-${String((dimensionIndex - 1) * 8 + offset).padStart(2, "0")}`
      );
      dimensions.push({
        stableId: `d-${dimensionIndex}`,
        options: [
          ...Array.from({ length: 70 }, (_, optionIndex) => option(
            `decoy-${dimensionIndex}-${String(optionIndex).padStart(2, "0")}`,
            9 - optionIndex,
            [...fatalConflicts, "decoy-conflict"]
          )),
          option(`fixed-${dimensionIndex}`, 10, fatalConflicts)
        ]
      });
    }

    const now = vi.spyOn(performance, "now");
    try {
      now.mockReturnValueOnce(0).mockReturnValue(1_001);
      const slowClock = searchBestConflictFreeOptions(dimensions);
      now.mockReset().mockReturnValue(0);
      const fastClock = searchBestConflictFreeOptions(dimensions);

      expect({ options: material(slowClock), diagnostic: slowClock.diagnostic }).toEqual({
        options: material(fastClock),
        diagnostic: fastClock.diagnostic
      });
    } finally {
      now.mockRestore();
    }
  });

  it("retains low-ranked mechanic/dependency representatives in the prefrontier", () => {
    const result = inspectConflictFreePrefrontier([{
      stableId: "factory",
      options: [
        ...Array.from({ length: 90 }, (_, index) => option(`rank-${index}`, 1000 - index, [`worker-${index}`])),
        option("mechanic", 1, ["mechanic-worker"], { retentionKeys: ["mechanic:conversion"] }),
        option("dependency", 0, ["dependency-worker"], { retentionKeys: ["dependency:remote"] })
      ]
    }]);

    expect(result.dimensionOptions.factory).toEqual(expect.arrayContaining(["mechanic", "dependency"]));
    expect(result.discardedOptions).toBeGreaterThan(0);
  });

  it("retains a deeply ranked empty or minimum-conflict fallback in a bounded prefrontier", () => {
    const result = inspectConflictFreePrefrontier([{
      stableId: "factory",
      options: [
        ...Array.from({ length: 90 }, (_, index) => option(`rank-${index}`, 1000 - index, ["shared", `worker-${index}`])),
        option("deep-empty", 0)
      ]
    }]);

    expect(result.dimensionOptions.factory).toContain("deep-empty");
  });

  it("returns no partial options and exact incomplete dimensions when truly infeasible", () => {
    const result = searchBestConflictFreeOptions([
      { stableId: "a", options: [option("a", 1, ["shared"])] },
      { stableId: "b", options: [option("b", 1, ["shared"])] },
      { stableId: "c", options: [option("c", 1, ["other"])] }
    ]);

    expect(result.options).toEqual([]);
    expect(result.diagnostic.completion).toBe("infeasible");
    expect(result.diagnostic.incompleteDimensionIds).toEqual(["b"]);
  });

  it("reports budget exhaustion as unknown instead of falsely certifying infeasibility", () => {
    const dimensions = Array.from({ length: 9 }, (_, dimensionIndex) => ({
      stableId: `d-${dimensionIndex}`,
      options: Array.from({ length: 5 }, (_, optionIndex) => option(
        `o-${dimensionIndex}-${optionIndex}`,
        10 - optionIndex,
        dimensionIndex === 0 || dimensionIndex === 8
          ? ["fatal"]
          : [`free-${dimensionIndex}-${optionIndex}`]
      ))
    }));

    const result = searchBestConflictFreeOptions(dimensions);

    expect(result.options).toEqual([]);
    expect(result.diagnostic).toMatchObject({
      completion: "unknown",
      optimality: "not-certified",
      limitation: "feasibility-budget-limited",
      feasibilityBudgetExhausted: true
    });
    expect(result.diagnostic.feasibilityVisitedStates).toBe(result.diagnostic.feasibilityWorkBudget);
  });

  it("returns exactly one option per dimension for a complete result", () => {
    const dimensions = Array.from({ length: 8 }, (_, index) => ({
      stableId: `d-${index}`,
      options: [option(`filled-${index}`, 1, [`worker-${index}`])]
    }));
    const result = searchBestConflictFreeOptions(dimensions);

    expect(result.diagnostic.completion).toBe("complete");
    expect(result.options).toHaveLength(dimensions.length);
  });

  it("is materially invariant to canonical/reversed dimensions and options", () => {
    const dimensions = [
      { stableId: "b", options: [option("b2", 2, ["x"]), option("b1", 1, ["b"])] },
      { stableId: "a", options: [option("a2", 2, ["x"]), option("a1", 1, ["a"])] }
    ];
    const canonical = searchBestConflictFreeOptions(dimensions);
    const reversed = searchBestConflictFreeOptions([...dimensions].reverse().map((dimension) => ({
      ...dimension,
      options: [...dimension.options].reverse()
    })));

    expect(material(reversed)).toEqual(material(canonical));
  });

  it("certifies only exhaustive search and taints every bounded discard", () => {
    const exhaustive = searchBestConflictFreeOptions([
      { stableId: "tiny", options: [option("a", 2, ["a"]), option("b", 1, ["b"])] }
    ]);
    const bounded = searchBestConflictFreeOptions([{
      stableId: "large",
      options: Array.from({ length: 200 }, (_, index) => option(`o-${index}`, 200 - index, [`k-${index}`]))
    }]);

    expect(exhaustive.diagnostic).toMatchObject({ optimality: "certified", discardedStates: 0 });
    expect(bounded.diagnostic).toMatchObject({
      optimality: "not-certified",
      limitation: "prefrontier-limited"
    });
    expect(bounded.diagnostic.discardedStates).toBeGreaterThan(0);
  });
});
