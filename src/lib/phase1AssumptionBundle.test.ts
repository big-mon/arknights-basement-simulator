import { describe, expect, it } from "vitest";
import artifact from "../data/phase1-project-assumption-bundle-v1.json";
// The dependency-free Node generator is JavaScript so it can run without a TypeScript loader.
// @ts-expect-error The generator intentionally has no emitted declaration file.
import { serializePhase1AssumptionBundle } from "../../scripts/generate-phase1-assumption-bundle.mjs";
import {
  PHASE1_ASSUMPTION_IDS,
  calculatePhase1BundleContentSha256,
  deriveHighValueOrders,
  derivePerceptionFactoryEfficiency,
  deriveSignedMoraleDelta,
  loadPhase1AssumptionBundle,
  validatePhase1AssumptionBundle
} from "./phase1AssumptionBundle";

function independentlyCanonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(independentlyCanonicalize).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) =>
      `${JSON.stringify(key)}:${independentlyCanonicalize(object[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function independentlyHashBundle(value: Record<string, unknown>): Promise<string> {
  const content = { ...value };
  delete content.contentSha256;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(independentlyCanonicalize(content))
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("Phase 1 project assumption bundle v1", () => {
  it("contains exactly the three allowed stable domains and assumption IDs", () => {
    const bundle = loadPhase1AssumptionBundle();

    expect(bundle.allowedAssumptionIds).toEqual(PHASE1_ASSUMPTION_IDS);
    expect(bundle.assumptions.map((assumption) => assumption.id)).toEqual(PHASE1_ASSUMPTION_IDS);
    expect(bundle.assumptions.map((assumption) => assumption.domain)).toEqual([
      "high-value-order-probability",
      "perception-information-factory-efficiency",
      "signed-equivalent-morale-delta"
    ]);
    expect(bundle.contract.hiddenCalibrationInputs).toEqual([]);
    expect(bundle.contract.fixtureConfidence).toBe("corroborated");
    expect(Object.isFrozen(bundle)).toBe(true);
    expect(Object.isFrozen(bundle.assumptions[0].primary)).toBe(true);
  });

  it("rejects content, allowed-ID, unknown-key, domain, and hidden-calibration tampering", () => {
    const contentTamper = structuredClone(artifact) as any;
    contentTamper.assumptions[0].primary.warmupHours.increased = 6;
    expect(() => validatePhase1AssumptionBundle(contentTamper)).toThrow(/contentSha256/);

    const idTamper = structuredClone(artifact) as any;
    idTamper.allowedAssumptionIds[0] = "phase1.not-allowed.v1";
    expect(() => validatePhase1AssumptionBundle(idTamper)).toThrow(/allowedAssumptionIds/);

    const unknownKey = structuredClone(artifact) as any;
    unknownKey.assumptions[0].primary.wikiruThroughput = 125.42;
    expect(() => validatePhase1AssumptionBundle(unknownKey)).toThrow(/unknown key/);

    const nestedUnknownKey = structuredClone(artifact) as any;
    nestedUnknownKey.assumptions[1].primary.allUnlockedSkills.rosmontis.unlockedTier = "E2";
    expect(() => validatePhase1AssumptionBundle(nestedUnknownKey)).toThrow(/unknown key/);

    const domainTamper = structuredClone(artifact) as any;
    domainTamper.assumptions[0].domain = "fourth-domain";
    expect(() => validatePhase1AssumptionBundle(domainTamper)).toThrow(/domain/);
  });

  it("regenerates byte-identical canonical JSON and the same lowercase SHA-256", () => {
    const generated = serializePhase1AssumptionBundle();
    expect(generated).toBe(`${JSON.stringify(artifact, null, 2)}\n`);

    const bundle = loadPhase1AssumptionBundle(JSON.parse(generated));
    expect(bundle.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(calculatePhase1BundleContentSha256(bundle)).toBe(bundle.contentSha256);
  });

  it("sorts object keys for hashing while preserving semantic array order", () => {
    const reorderedRoot = Object.fromEntries(Object.entries(artifact).reverse());
    expect(calculatePhase1BundleContentSha256(reorderedRoot)).toBe(artifact.contentSha256);

    const reorderedAssumptions = structuredClone(artifact) as any;
    reorderedAssumptions.assumptions.reverse();
    expect(calculatePhase1BundleContentSha256(reorderedAssumptions)).not.toBe(artifact.contentSha256);
  });

  it("keeps diagnostic-only sensitivity structurally separate from primary authority", () => {
    const bundle = loadPhase1AssumptionBundle();
    const assumption = bundle.assumptions[0];
    const changedSensitivity = structuredClone(assumption) as typeof assumption;
    changedSensitivity.diagnosticOnlySensitivity.shiftHours = [1, 24];

    expect(deriveHighValueOrders(assumption, { shiftHours: 12, level: "increased", orderAcquisitionEfficiency: 0.25 }))
      .toEqual(deriveHighValueOrders(changedSensitivity, { shiftHours: 12, level: "increased", orderAcquisitionEfficiency: 0.25 }));
  });

  it("derives high-value distribution, gold consumption, and LMD from elapsed work time", () => {
    const assumption = loadPhase1AssumptionBundle().assumptions[0];
    expect(assumption.scope.effectLevels).toEqual(["slight", "doubleSlight", "increased"]);
    for (const level of ["slight", "doubleSlight", "increased"] as const) {
      expect(() => deriveHighValueOrders(assumption, {
        shiftHours: 12, level, orderAcquisitionEfficiency: 0
      })).not.toThrow();
    }

    const nonCanonicalScope = structuredClone(artifact) as any;
    nonCanonicalScope.assumptions[0].scope.effectLevels = ["slight", ["double", "slight"].join("-"), "increased"];
    nonCanonicalScope.contentSha256 = calculatePhase1BundleContentSha256(nonCanonicalScope);
    expect(() => validatePhase1AssumptionBundle(nonCanonicalScope)).toThrow(/effectLevels/);

    const result = deriveHighValueOrders(assumption, {
      shiftHours: 12,
      level: "increased",
      orderAcquisitionEfficiency: 0
    });

    expect(result.averageProgress).toBeCloseTo(19 / 24);
    expect(result.distribution).toEqual([
      expect.closeTo(0.10208333333333333, 12),
      expect.closeTo(0.18333333333333335, 12),
      expect.closeTo(0.7145833333333333, 12)
    ]);
    expect(result.expectedGoldPerOrder).toBeCloseTo(3.6125);
    expect(result.expectedOrderHours).toBeCloseTo(4.17375);
    expect(result.goldConsumed).toBeCloseTo(result.expectedOrders * result.expectedGoldPerOrder);
    expect(result.lmd).toBeCloseTo(result.goldConsumed * 500);
    expect(() => deriveHighValueOrders(assumption, {
      shiftHours: 12, level: "increased", orderAcquisitionEfficiency: 0,
      fixtureExpectedThroughput: 125.42
    } as any)).toThrow(/unknown key/);
  });

  it("derives the full all-unlocked Perception Information factory group per 12-hour active shift", () => {
    const assumption = loadPhase1AssumptionBundle().assumptions[1];

    expect(assumption.primary.allUnlockedSkills.aroma.timeCurve).toEqual({
      initialEfficiency: 0,
      efficiencyPerHour: 0.02,
      maxEfficiency: 0.2,
      startsAfterFirstHour: true,
      segmentHours: 1
    });
    expect(assumption.primary.allUnlockedSkills.waaiFu).not.toHaveProperty(
      ["normalOptimizer", "ModeledEfficiency"].join("")
    );
    expect(assumption.primary.allUnlockedSkills.waaiFu.resultAffectingOtherOperatorScaling).toEqual({
      otherEfficiencyPerStep: 0.05,
      efficiencyPerStep: 0.05,
      maxEfficiency: 0.4
    });
    expect(assumption.primary.allUnlockedSkills.rosmontis).toEqual(expect.objectContaining({
      efficiencySkillId: "manu_prod_spd_bd[010]",
      efficiencyPerThoughtChain: 0.01,
      scalingPerThoughtChain: 1
    }));

    expect(derivePerceptionFactoryEfficiency(assumption, "groups-a-b")).toEqual({
      shiftId: "groups-a-b",
      operatorIds: ["char_446_aroma", "char_243_waaifu", "char_391_rosmon"],
      elapsedWorkHours: 12,
      dormitoryOccupancy: 20,
      perceptionInfo: 20,
      thoughtChain: 40,
      componentEfficiencies: {
        aromaGold: 0.25,
        aromaTimeCurve: expect.closeTo(0.10833333333333334, 12),
        aroma: expect.closeTo(0.35833333333333334, 12),
        waaiFu: 0.4,
        rosmontis: 0.4
      },
      groupEfficiency: expect.closeTo(1.1583333333333334, 12)
    });

    expect(derivePerceptionFactoryEfficiency(assumption, "groups-b-c")).toEqual({
      shiftId: "groups-b-c",
      operatorIds: ["char_446_aroma", "char_243_waaifu", "char_391_rosmon"],
      elapsedWorkHours: 12,
      dormitoryOccupancy: 20,
      perceptionInfo: 10,
      thoughtChain: 30,
      componentEfficiencies: {
        aromaGold: 0.25,
        aromaTimeCurve: expect.closeTo(0.10833333333333334, 12),
        aroma: expect.closeTo(0.35833333333333334, 12),
        waaiFu: 0.4,
        rosmontis: 0.3
      },
      groupEfficiency: expect.closeTo(1.0583333333333333, 12)
    });

    const lowerCap = structuredClone(assumption);
    lowerCap.primary.allUnlockedSkills.waaiFu.resultAffectingOtherOperatorScaling.maxEfficiency = 0.3;
    expect(derivePerceptionFactoryEfficiency(lowerCap, "groups-a-b").componentEfficiencies.waaiFu).toBe(0.3);

    const uncappedStepBoundary = structuredClone(assumption);
    uncappedStepBoundary.primary.allUnlockedSkills.aroma.goldEfficiency = 0.251;
    uncappedStepBoundary.primary.allUnlockedSkills.aroma.timeCurve.efficiencyPerHour = 0;
    uncappedStepBoundary.primary.allUnlockedSkills.rosmontis.efficiencyPerThoughtChain = 0;
    uncappedStepBoundary.primary.allUnlockedSkills.waaiFu.resultAffectingOtherOperatorScaling.maxEfficiency = 1;
    expect(derivePerceptionFactoryEfficiency(
      uncappedStepBoundary,
      "groups-a-b"
    ).componentEfficiencies.waaiFu).toBeCloseTo(0.25, 12);

    const changedSensitivity = structuredClone(assumption);
    changedSensitivity.diagnosticOnlySensitivity.fixedPerceptionInfoPoints = [10];
    expect(derivePerceptionFactoryEfficiency(changedSensitivity, "groups-a-b"))
      .toEqual(derivePerceptionFactoryEfficiency(assumption, "groups-a-b"));
    expect(() => derivePerceptionFactoryEfficiency(assumption, "groups-c-a")).toThrow(/not active/);
    expect(() => derivePerceptionFactoryEfficiency(assumption, "unknown-shift")).toThrow(/unknown shift/);
  });

  it("derives signed work, threshold-aware recovery, and eligible exchange deltas", () => {
    const assumption = loadPhase1AssumptionBundle().assumptions[2];

    expect(deriveSignedMoraleDelta(assumption, {
      mode: "work", startMorale: 10, durationHours: 12, consumptionRatePerHour: 1
    })).toEqual({ mode: "work", startMorale: 10, endMorale: 0, signedDelta: -10 });

    const recovery = deriveSignedMoraleDelta(assumption, {
      mode: "ordinary-recovery", startMorale: 8, durationHours: 4, recoveryRatePerHour: 2,
      conditionalModifiers: [{ moraleAtMost: 10, additionalRatePerHour: 1 }]
    });
    expect(recovery.mode).toBe("ordinary-recovery");
    expect(recovery.endMorale).toBeCloseTo(50 / 3);
    expect(recovery.signedDelta).toBeCloseTo(26 / 3);

    const exchange = deriveSignedMoraleDelta(assumption, {
      mode: "exchange-support", sourceMoraleBefore: 24, targetMoraleBefore: 7
    });
    expect(exchange).toEqual({
      mode: "exchange-support", sourceEndMorale: 7, targetEndMorale: 24,
      sourceSignedDelta: -17, targetSignedDelta: 17, totalSignedDelta: 0
    });
    const exchangeDeltas = exchange as { sourceSignedDelta: number; targetSignedDelta: number };
    expect(exchangeDeltas.sourceSignedDelta + exchangeDeltas.targetSignedDelta).toBe(0);

    expect(() => deriveSignedMoraleDelta(assumption, {
      mode: "exchange-support", sourceMoraleBefore: 24, targetMoraleBefore: 7,
      sourceOperatorId: "char_101_sora", targetOperatorId: "char_101_sora"
    })).toThrow(/distinct/);
  });

  it("rejects ineligible exchange support and same-version silent content mutation", () => {
    const bundle = loadPhase1AssumptionBundle();
    expect(() => deriveSignedMoraleDelta(bundle.assumptions[2], {
      mode: "exchange-support", sourceMoraleBefore: 23, targetMoraleBefore: 7
    })).toThrow(/full morale/);

    const legacyEventFields = [
      ["source", "IsFull"].join(""),
      ["sameDormitory", "Event"].join(""),
      ["sourceUseCount", "InShift"].join(""),
      ["sourceWorkedInCurrentOrPreviousRecovery", "Interval"].join(""),
      ["sourceAndTarget", "Distinct"].join("")
    ];
    for (const legacyEventField of legacyEventFields) {
      expect(() => deriveSignedMoraleDelta(bundle.assumptions[2], {
        mode: "exchange-support", sourceMoraleBefore: 24, targetMoraleBefore: 7,
        [legacyEventField]: true
      } as any)).toThrow(/unknown key/);
    }

    const silentlyMutated = structuredClone(artifact) as any;
    silentlyMutated.assumptions[0].diagnosticOnlySensitivity.shiftHours = [6, 18];
    silentlyMutated.contentSha256 = calculatePhase1BundleContentSha256(silentlyMutated);
    expect(validatePhase1AssumptionBundle(silentlyMutated).contentSha256).toBe(silentlyMutated.contentSha256);
    expect(() => loadPhase1AssumptionBundle(silentlyMutated)).toThrow(/pinned v1 tuple/);

    const formerCheckedInHash = structuredClone(artifact) as any;
    formerCheckedInHash.contentSha256 = "de17fdf86018bd59d99d3f1f17ac6328010c8970da90d05e66546534921d6947";
    expect(() => validatePhase1AssumptionBundle(formerCheckedInHash)).toThrow(/contentSha256 mismatch/);
  });
});

describe("Phase 1 project assumption bundle v2", () => {
  it("generates the separately versioned correction deterministically with an independently verified hash", async () => {
    const artifactV2 = (await import("../data/phase1-project-assumption-bundle-v2.json")).default;
    // The dependency-free Node generator is JavaScript so it can run without a TypeScript loader.
    // @ts-expect-error The generator intentionally has no emitted declaration file.
    const { serializePhase1AssumptionBundleV2 } = await import("../../scripts/generate-phase1-assumption-bundle-v2.mjs");
    const generated = serializePhase1AssumptionBundleV2();

    expect(artifactV2.id).toBe(artifact.id);
    expect(artifactV2.version).toBe(2);
    expect(Number.isInteger(artifactV2.version)).toBe(true);
    expect(artifactV2.allowedAssumptionIds).toEqual(PHASE1_ASSUMPTION_IDS);
    expect(JSON.stringify(artifactV2.assumptions[0])).toBe(JSON.stringify(artifact.assumptions[0]));
    expect(JSON.stringify(artifactV2.assumptions[2])).toBe(JSON.stringify(artifact.assumptions[2]));
    expect(artifactV2.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await independentlyHashBundle(artifactV2)).toBe(artifactV2.contentSha256);
    expect(generated).toBe(`${JSON.stringify(artifactV2, null, 2)}\n`);
    expect(serializePhase1AssumptionBundleV2()).toBe(generated);
  });

  it("loads its own pinned tuple and derives the corrected production-group shifts", async () => {
    const artifactV2 = (await import("../data/phase1-project-assumption-bundle-v2.json")).default;
    const { loadPhase1AssumptionBundleV2 } = await import("./phase1AssumptionBundle");
    const bundle = loadPhase1AssumptionBundleV2();
    const perception = bundle.assumptions[1];

    expect(bundle.version).toBe(2);
    expect(bundle.contentSha256).toBe(artifactV2.contentSha256);
    expect(perception.scope.productionGroupId).toBe("C");
    expect(perception.scope.inactiveShiftBehavior).toBe("fail-closed");
    expect(perception.primary.inactiveShiftIds).toEqual(["groups-a-b"]);
    expect(() => derivePerceptionFactoryEfficiency(perception, "groups-a-b")).toThrow(/not active/);
    expect(derivePerceptionFactoryEfficiency(perception, "groups-b-c")).toEqual(expect.objectContaining({
      shiftId: "groups-b-c",
      perceptionInfo: 20,
      thoughtChain: 40,
      componentEfficiencies: expect.objectContaining({
        aroma: expect.closeTo(0.35833333333333334, 12),
        waaiFu: 0.4,
        rosmontis: 0.4
      }),
      groupEfficiency: expect.closeTo(1.1583333333333334, 12)
    }));
    expect(derivePerceptionFactoryEfficiency(perception, "groups-c-a")).toEqual(expect.objectContaining({
      shiftId: "groups-c-a",
      perceptionInfo: 10,
      thoughtChain: 30,
      componentEfficiencies: expect.objectContaining({
        aroma: expect.closeTo(0.35833333333333334, 12),
        waaiFu: 0.4,
        rosmontis: 0.3
      }),
      groupEfficiency: expect.closeTo(1.0583333333333333, 12)
    }));
  });
});
