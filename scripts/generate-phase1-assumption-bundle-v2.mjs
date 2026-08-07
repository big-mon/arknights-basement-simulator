import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildPhase1AssumptionBundle,
  calculateContentSha256
} from "./generate-phase1-assumption-bundle.mjs";

const outputUrl = new URL("../src/data/phase1-project-assumption-bundle-v2.json", import.meta.url);

export function buildPhase1AssumptionBundleV2() {
  const bundle = structuredClone(buildPhase1AssumptionBundle());
  const perception = bundle.assumptions[1];

  bundle.version = 2;
  perception.scope.productionGroupId = "C";
  perception.primary.activeShifts = {
    "groups-b-c": { elapsedWorkHours: 12, dormitoryOccupancy: 20, perceptionInfo: 20 },
    "groups-c-a": { elapsedWorkHours: 12, dormitoryOccupancy: 20, perceptionInfo: 10 }
  };
  perception.primary.inactiveShiftIds = ["groups-a-b"];
  bundle.contentSha256 = calculateContentSha256(bundle);
  return bundle;
}

export function serializePhase1AssumptionBundleV2() {
  return `${JSON.stringify(buildPhase1AssumptionBundleV2(), null, 2)}\n`;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const serialized = serializePhase1AssumptionBundleV2();
  if (process.argv.includes("--stdout")) {
    process.stdout.write(serialized);
  } else if (process.argv.includes("--check")) {
    if (readFileSync(outputUrl, "utf8") !== serialized) {
      console.error("phase1 assumption bundle v2 artifact is not deterministic/current");
      process.exitCode = 1;
    }
  } else {
    writeFileSync(outputUrl, serialized, "utf8");
  }
}
