import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const outputUrl = new URL("../src/data/phase1-project-assumption-bundle-v1.json", import.meta.url);

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function calculateContentSha256(bundle) {
  const { contentSha256: _excluded, ...content } = bundle;
  return createHash("sha256").update(canonicalize(content), "utf8").digest("hex");
}

export function buildPhase1AssumptionBundle() {
  const bundle = {
    id: "arknights-basement.phase1-project-assumptions",
    version: 1,
    contentSha256: "",
    allowedAssumptionIds: [
      "phase1.high-value-order-probability.v1",
      "phase1.perception-information-factory-efficiency.v1",
      "phase1.signed-equivalent-morale-delta.v1"
    ],
    contract: {
      canonicalization: "recursive-object-keys-lexicographic-arrays-preserve-order-json-utf8",
      hashExcludes: ["contentSha256"],
      hiddenCalibrationInputs: [],
      fixtureConfidence: "corroborated",
      primaryAuthority: "primary-only-diagnostic-sensitivity-never-mutates-pass-fail",
      mutationPolicy: "content-change-requires-new-version-and-fixture-review"
    },
    assumptions: [
      {
        id: "phase1.high-value-order-probability.v1",
        domain: "high-value-order-probability",
        formulaIdentifier: "linear-warmup-time-weighted-order-expectation-v1",
        units: {
          shiftHours: "hour",
          probability: "probability",
          orderHours: "hour/order",
          gold: "gold",
          lmd: "LMD"
        },
        inputs: ["shiftHours", "level", "orderAcquisitionEfficiency"],
        scope: {
          effectLevels: ["slight", "doubleSlight", "increased"],
          excludes: ["external-throughput", "fixture-expected-output", "wikiru-aggregate", "random-order-sequence"]
        },
        provenance: [
          {
            issue: "#12-#17 Phase 1 base-mechanics and complex-skill decisions",
            pullRequest: "#18 merged",
            commit: "14263b18dd242f8ccd5080a103384101c64b8f6c",
            path: "src/lib/optimizer.ts",
            symbol: "normalGoldOrderDistribution; highValueOrderDistributions; averageHighValueOrderDistribution; expectedLmdPerHour",
            status: "merged-project-model-decision"
          },
          {
            issue: "#12-#17 Phase 1 base-skill metadata decisions",
            pullRequest: "#18 merged",
            commit: "14263b18dd242f8ccd5080a103384101c64b8f6c",
            path: "src/data/base-skill-overrides.json",
            symbol: "highValueOrderProbability warmupHours",
            status: "merged-project-model-decision"
          }
        ],
        primary: {
          normalDistribution: [0.3, 0.5, 0.2],
          orderGold: [2, 3, 4],
          orderHours: [2.4, 3.5, 4.6],
          targetDistributions: {
            slight: [0.15, 0.3, 0.55],
            doubleSlight: [0.13, 0.22, 0.65],
            increased: [0.05, 0.1, 0.85]
          },
          warmupHours: { slight: 3, doubleSlight: 3, increased: 5 },
          averageProgress: "t=0=>0;0<t<w=>t/(2*w);t>=w=>1-w/(2*t)",
          lmdPerGold: 500
        },
        diagnosticOnlySensitivity: {
          shiftHours: [8, 12, 16],
          authority: "diagnostic-only"
        }
      },
      {
        id: "phase1.perception-information-factory-efficiency.v1",
        domain: "perception-information-factory-efficiency",
        formulaIdentifier: "perception-information-full-factory-group-per-active-shift-v1",
        units: {
          dormitoryOccupancy: "occupied-slot",
          perceptionInfo: "point",
          thoughtChain: "point",
          elapsedWorkHours: "hour",
          efficiency: "fraction"
        },
        inputs: ["shiftId"],
        scope: {
          scheduleCycle: "groups-a-b/groups-b-c/groups-c-a",
          productionGroupId: "B",
          inactiveShiftBehavior: "fail-closed",
          excludes: [
            "36h-average", "24h-proportional-conversion", "wikiru-125.42-percent", "fixture-expected-output",
            "facility-count-resources-as-direct-waai-fu-efficiency"
          ]
        },
        provenance: [
          {
            issue: "#12-#17 complex base-skill model decisions",
            pullRequest: "#18 merged",
            commit: "14263b18dd242f8ccd5080a103384101c64b8f6c",
            path: "src/data/operators.json; src/data/base-skill-overrides.json",
            symbol: "char_446_aroma; char_243_waaifu manu_prod_spd_variable2[000]; char_391_rosmon manu_prod_spd_bd[010] per-1 scaling",
            status: "merged-project-model-decision"
          },
          {
            issue: "#46 pinned schedule/scenario inputs",
            pullRequest: "#48 open stacked PR",
            commit: "3428e1b33897fa039e04246f8513114480c5c1cd",
            path: "docs/specs/optimizer-normalized-theoretical-scenarios.md;src/data/optimizer-benchmarks/jp-243-factory-3group-2025-11.json",
            symbol: "JP normalized scenario;supportResourceScenario;schedule.shifts",
            status: "version-pinned-scenario-input-reference"
          }
        ],
        primary: {
          operatorIds: ["char_446_aroma", "char_243_waaifu", "char_391_rosmon"],
          formula: "aroma=goldEfficiency+averageBoundedHourlyTimeCurve(elapsedWorkHours);thoughtChain=dormitoryOccupancy+perceptionInfo;rosmontis=floor(thoughtChain/scalingPerThoughtChain)*efficiencyPerThoughtChain;waaiFuOtherResultAffectingEfficiency=aroma+rosmontis;waaiFuSteps=floor(waaiFuOtherResultAffectingEfficiency/otherEfficiencyPerStep);waaiFu=min(waaiFuSteps*efficiencyPerStep,maxEfficiency);groupEfficiency=aroma+waaiFu+rosmontis",
          allUnlockedSkills: {
            aroma: {
              operatorId: "char_446_aroma",
              skillIds: ["manu_formula_spd&cost[001]", "manu_prod_spd_addition[100]"],
              goldEfficiency: 0.25,
              timeCurve: {
                initialEfficiency: 0,
                efficiencyPerHour: 0.02,
                maxEfficiency: 0.2,
                startsAfterFirstHour: true,
                segmentHours: 1
              }
            },
            waaiFu: {
              operatorId: "char_243_waaifu",
              skillId: "manu_prod_spd_variable2[000]",
              resultAffectingOtherOperatorScaling: {
                otherEfficiencyPerStep: 0.05,
                efficiencyPerStep: 0.05,
                maxEfficiency: 0.4
              }
            },
            rosmontis: {
              operatorId: "char_391_rosmon",
              resourceSkillId: "manu_prod_spd_bd_n1[000]",
              efficiencySkillId: "manu_prod_spd_bd[010]",
              thoughtChainPerDormitoryOccupant: 1,
              thoughtChainPerPerceptionInfo: 1,
              efficiencyPerThoughtChain: 0.01,
              scalingPerThoughtChain: 1
            }
          },
          activeShifts: {
            "groups-a-b": { elapsedWorkHours: 12, dormitoryOccupancy: 20, perceptionInfo: 20 },
            "groups-b-c": { elapsedWorkHours: 12, dormitoryOccupancy: 20, perceptionInfo: 10 }
          },
          inactiveShiftIds: ["groups-c-a"]
        },
        diagnosticOnlySensitivity: {
          fixedPerceptionInfoPoints: [10, 20],
          authority: "diagnostic-only"
        }
      },
      {
        id: "phase1.signed-equivalent-morale-delta.v1",
        domain: "signed-equivalent-morale-delta",
        formulaIdentifier: "bounded-work-recovery-fixed-boundary-exchange-signed-delta-v1",
        units: {
          morale: "morale",
          durationHours: "hour",
          ratePerHour: "morale/hour",
          signedDelta: "morale"
        },
        inputs: [
          "mode", "startMorale", "durationHours", "consumptionRatePerHour", "recoveryRatePerHour",
          "conditionalModifiers", "sourceMoraleBefore", "targetMoraleBefore", "sourceOperatorId", "targetOperatorId"
        ],
        scope: {
          modes: ["work", "ordinary-recovery", "exchange-support"],
          idleDelta: 0,
          idleDomainExpansion: false,
          exchangeBoundary: [
            "source-morale-equals-modeled-cap", "swap-boundary-values", "optional-identities-distinct"
          ],
          excludes: [
            "#20-placement-uniqueness-witness", "#20-activity-witness", "#20-support-capacity-witness",
            "#50-continuity-witness", "#50-cycle-closure-witness", "wikiru-24h-output"
          ]
        },
        provenance: [
          {
            issue: "#12-#17 base mechanics decisions",
            pullRequest: "#18 merged",
            commit: "14263b18dd242f8ccd5080a103384101c64b8f6c",
            path: "src/lib/optimizer.ts;src/data/optimizer-benchmarks/base-mechanics-2026-07.json",
            symbol: "moraleCapacity;baseMoraleConsumptionPerHour;maxDormitoryRecoveryPerHour",
            status: "merged-project-model-decision"
          },
          {
            issue: "#53 approved per-shift abstraction",
            pullRequest: "#37 Issue #53 assumption bundle",
            commit: "not-applicable",
            path: "docs/specs/phase1-project-assumption-bundle-v1.md",
            symbol: "fixed-slot-boundary morale exchange abstraction",
            status: "approved-project-abstraction"
          }
        ],
        primary: {
          moraleCap: 24,
          baseWorkConsumptionRatePerHour: 1,
          ordinaryDormitoryRecoveryRatePerHour: 4,
          workFormula: "end=max(0,start-rate*duration);delta=end-start",
          recoveryFormula: "integrate-effective-rate-at-thresholds;end=min(cap,start+integral);delta=end-start",
          exchangeFormula: "require(sourceBefore=moraleCap);sourceEnd=targetBefore;targetEnd=sourceBefore;sourceDelta=sourceEnd-sourceBefore;targetDelta=targetEnd-targetBefore;sourceDelta+targetDelta=0"
        },
        diagnosticOnlySensitivity: {
          workConsumptionRatePerHour: [0.75, 1, 1.25],
          authority: "diagnostic-only"
        }
      }
    ]
  };
  bundle.contentSha256 = calculateContentSha256(bundle);
  return bundle;
}

export function serializePhase1AssumptionBundle() {
  return `${JSON.stringify(buildPhase1AssumptionBundle(), null, 2)}\n`;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const serialized = serializePhase1AssumptionBundle();
  if (process.argv.includes("--stdout")) {
    process.stdout.write(serialized);
  } else if (process.argv.includes("--check")) {
    if (readFileSync(outputUrl, "utf8") !== serialized) {
      console.error("phase1 assumption bundle artifact is not deterministic/current");
      process.exitCode = 1;
    }
  } else {
    writeFileSync(outputUrl, serialized, "utf8");
  }
}
