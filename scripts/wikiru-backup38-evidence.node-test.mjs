import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createHash } from "node:crypto";

const packetRoot = resolve("docs/benchmarks/evidence/wikiru-backup38-12h-v2");
const reproducer = "reproduce.py";
const acceptedBundlePath = resolve("src/data/phase1-project-assumption-bundle-v2.json");
const acceptedBundleFileSha = "8a8e03596fda0f77cf4169914126a48d3abd8d27e1518a4d76fce4e374567edf";
const acceptedBundleContentSha = "5aca766b23d7eabfbb924d460b878d07351c5377ec0007ee12194de7fe1565ba";

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function run(root, ...args) {
  return spawnSync("python3", [join(root, reproducer), ...args], {
    cwd: root,
    encoding: "utf8"
  });
}

function reseal(root) {
  const manifestPath = join(root, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const entry of manifest.files) {
    const bytes = readFileSync(join(root, entry.path));
    entry.sha256 = createHash("sha256").update(bytes).digest("hex");
    entry.bytes = bytes.length;
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const checksums = manifest.files
    .map(({ path }) => `${createHash("sha256").update(readFileSync(join(root, path))).digest("hex")}  ${path}`)
    .join("\n");
  writeFileSync(join(root, "checksums.sha256"), `${checksums}\n`);
}

function mutateAndExpectFailure(label, mutate, expectedFailure, shouldReseal = true) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), `wikiru-backup38-${label}-`));
  try {
    cpSync(packetRoot, temporaryRoot, { recursive: true });
    mutate(temporaryRoot);
    if (shouldReseal) reseal(temporaryRoot);
    const result = run(temporaryRoot, "--check");
    assert.notEqual(result.status, 0, `${label} mutation unexpectedly verified`);
    assert.match(`${result.stdout}\n${result.stderr}`, expectedFailure);
    console.log(`${label} ${shouldReseal ? "resealed " : ""}mutation rejected: ${result.stderr.trim()}`);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

test("Wikiru backup 38 models cyclic elapsed-work phases and a separate 36h resource ledger", () => {
  const packetBundlePath = join(packetRoot, "inputs/phase1-project-assumption-bundle-v2.json");
  const acceptedBundleBytes = readFileSync(acceptedBundlePath);
  const packetBundleBytes = readFileSync(packetBundlePath);
  const output = JSON.parse(readFileSync(join(packetRoot, "output.json"), "utf8"));
  const bundle = JSON.parse(packetBundleBytes);
  const bundleContent = { ...bundle };
  delete bundleContent.contentSha256;
  const failures = [];
  const expect = (condition, message) => {
    if (!condition) failures.push(message);
  };

  expect(packetBundleBytes.equals(acceptedBundleBytes),
    "packet bundle bytes must be identical to the accepted repository artifact");
  expect(createHash("sha256").update(packetBundleBytes).digest("hex") === acceptedBundleFileSha,
    "packet bundle file SHA-256 must match the accepted artifact");
  expect(bundle.contentSha256 === acceptedBundleContentSha &&
    createHash("sha256").update(canonical(bundleContent)).digest("hex") === acceptedBundleContentSha,
    "packet bundle declared and canonical content SHA-256 must match the accepted artifact");
  expect(JSON.stringify(bundle.assumptions[1].primary.activeShifts["groups-c-a"]) ===
    JSON.stringify({ elapsedWorkHours: 12, dormitoryOccupancy: 20, perceptionInfo: 10 }),
  "production group C second slot must use the accepted exact tuple with elapsedWorkHours=12");
  expect(output.shifts.length === 2 && output.shifts.map(({ shiftId }) => shiftId).join("/") === "groups-a-b/groups-b-c",
    "the 24h benchmark must contain only shifts 1 and 2");

  const phase = output.trace?.cyclicElapsedWorkPhase;
  expect(phase?.groups?.A?.[0]?.shiftId === "groups-a-b" &&
    phase.groups.A[0].elapsedWorkInterval.join(",") === "12,24" &&
    phase.groups.A[0].effectiveEfficiency === 1.32,
    "group A shift1 must directly integrate [12,24) as 4h*120% + 8h*138% = 132%");
  expect(phase?.groups?.A?.[1]?.shiftId === "groups-c-a" &&
    phase.groups.A[1].elapsedWorkInterval.join(",") === "0,12" &&
    phase.groups.A[1].effectiveEfficiency === 1.2,
    "group A shift3 must be the first continuous 12h slot at 120%");
  expect(phase?.groups?.B?.map(({ elapsedWorkInterval }) => elapsedWorkInterval.join(",")).join("/") === "0,12/12,24",
    "group B must retain [0,12) then [12,24)");
  expect(phase?.groups?.C?.map(({ elapsedWorkInterval }) => elapsedWorkInterval.join(",")).join("/") === "0,12/12,24",
    "group C must use shift2 first slot then shift3 second slot");
  expect(output.trace?.perceptionElapsedWorkCompromise?.confidence === "corroborated" &&
    output.trace.perceptionElapsedWorkCompromise.sourceRosterGroupCSecondWorkSlot.elapsedWorkInterval.join(",") === "12,24" &&
    output.trace.perceptionElapsedWorkCompromise.approvedBundleActiveShiftInput.elapsedWorkHours === 12 &&
    output.trace.perceptionElapsedWorkCompromise.resourceCalculationAuthority ===
      "approved bundle v2 field, not operational cyclic phase",
  "trace must preserve the corroborated deterministic operational-phase/bundle-field compromise");

  const ledger = output.sustainability36h?.resourceLedger;
  expect(ledger?.purpose === "sustainability-only" && ledger?.entries?.length === 3,
    "a fail-closed sustainability-only ledger with all three shifts is required");
  if (ledger?.entries?.length === 3) {
    expect(JSON.stringify(ledger.entries.slice(0, 2)) === JSON.stringify(output.shifts),
      "ledger entries 1 and 2 must reuse the saved 24h shift calculations");
    expect(ledger.entries[2].shiftId === "groups-c-a" &&
      ledger.entries[2].drones.destination === "trading-post-1",
      "shift3 must exist only in the ledger and send all drones to Glasgow trading-post-1");
    expect(!output.shifts.some(({ shiftId }) => shiftId === "groups-c-a"),
      "shift3 must never appear in shifts");
    for (let index = 0; index < ledger.entries.length; index += 1) {
      const entry = ledger.entries[index];
      expect(entry.gold.starting >= 0 && entry.gold.ending >= 0 && entry.drones.starting >= 0 && entry.drones.ending >= 0,
        `ledger prefix ${entry.shiftId} must be nonnegative`);
      if (index) {
        expect(entry.gold.starting === ledger.entries[index - 1].gold.ending,
          `gold continuity must hold at ${entry.shiftId}`);
        expect(entry.drones.starting === ledger.entries[index - 1].drones.ending,
          `drone continuity must hold at ${entry.shiftId}`);
      }
    }
    expect(ledger.entries.at(-1).drones.ending === ledger.entries[0].drones.starting,
      "the three-shift drone ledger must return to its initial state");
    expect(output.totals24h.goldProduced === ledger.entries[0].gold.produced + ledger.entries[1].gold.produced &&
      output.totals24h.lmd === ledger.entries[0].lmd.total + ledger.entries[1].lmd.total,
      "totals24h must equal exactly ledger entries 1+2");
    expect(output.totals24h.goldProduced !== ledger.entries.reduce((sum, entry) => sum + entry.gold.produced, 0) &&
      output.totals24h.lmd !== ledger.entries.reduce((sum, entry) => sum + entry.lmd.total, 0),
      "totals24h must differ from the three-shift sum");
  }

  assert.deepEqual(failures, []);
});

test("Wikiru backup 38 evidence packet independently reproduces and fails closed", () => {
  const checked = run(packetRoot, "--check");
  assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
  assert.match(checked.stdout, /verified wikiru-backup38-12h-v2/);

  mutateAndExpectFailure("operator", (root) => {
    const path = join(root, "composition.json");
    const composition = JSON.parse(readFileSync(path, "utf8"));
    composition.shifts[0].facilities["trading-post-1"][0] = "char_002_amiya";
    writeFileSync(path, `${JSON.stringify(composition, null, 2)}\n`);
  }, /pinned Wikiru composition mismatch/);
  mutateAndExpectFailure("facility", (root) => {
    const path = join(root, "composition.json");
    const composition = JSON.parse(readFileSync(path, "utf8"));
    composition.shifts[0].facilities["trading-post-X"] =
      composition.shifts[0].facilities["trading-post-1"];
    delete composition.shifts[0].facilities["trading-post-1"];
    writeFileSync(path, `${JSON.stringify(composition, null, 2)}\n`);
  }, /pinned Wikiru composition mismatch/);
  mutateAndExpectFailure("timing", (root) => {
    const path = join(root, "composition.json");
    const composition = JSON.parse(readFileSync(path, "utf8"));
    composition.shiftHours = 8;
    writeFileSync(path, `${JSON.stringify(composition, null, 2)}\n`);
  }, /composition timing\/order mismatch/);
  mutateAndExpectFailure("mapping", (root) => {
    const path = join(root, "inputs/jp-game-data-extract-v1.json");
    const extract = JSON.parse(readFileSync(path, "utf8"));
    extract.characters.char_4032_provs.name = "改変プロヴァイゾ";
    writeFileSync(path, `${JSON.stringify(extract, null, 2)}\n`);
  }, /pinned game hash mismatch/);
  mutateAndExpectFailure("kafka-semantic-level", (root) => {
    const extractPath = join(root, "inputs/jp-game-data-extract-v1.json");
    const extract = JSON.parse(readFileSync(extractPath, "utf8"));
    for (const buffId of ["trade_ord_wt&cost[010]", "trade_ord_wt&cost[011]"]) {
      extract.buildingBuffs[buffId].description =
        extract.buildingBuffs[buffId].description.replace("獲得率が<@cc.kw>上昇", "獲得率が<@cc.kw>わずかに上昇");
    }
    const extractBytes = `${JSON.stringify(extract, null, 2)}\n`;
    writeFileSync(extractPath, extractBytes);
    const extractSha = createHash("sha256").update(extractBytes).digest("hex");
    const reproducerPath = join(root, reproducer);
    const source = readFileSync(reproducerPath, "utf8").replace(
      /GAME_EXTRACT_SHA = "[0-9a-f]{64}"/,
      `GAME_EXTRACT_SHA = "${extractSha}"`
    );
    writeFileSync(reproducerPath, source);
  }, /Kafka high-value semantic level mismatch: slight/);
  mutateAndExpectFailure("input", (root) => {
    const path = join(root, "inputs/wikiru-backup38-20260806.html");
    writeFileSync(path, `${readFileSync(path, "utf8")}<!-- tampered -->\n`);
  }, /pinned snapshot hash mismatch/);
  mutateAndExpectFailure("bundle-elapsed-24", (root) => {
    const path = join(root, "inputs/phase1-project-assumption-bundle-v2.json");
    const bundle = JSON.parse(readFileSync(path, "utf8"));
    bundle.assumptions[1].primary.activeShifts["groups-c-a"].elapsedWorkHours = 24;
    const content = { ...bundle };
    delete content.contentSha256;
    bundle.contentSha256 = createHash("sha256").update(canonical(content)).digest("hex");
    writeFileSync(path, `${JSON.stringify(bundle, null, 2)}\n`);
  }, /pinned bundle hash mismatch/);
  mutateAndExpectFailure("output", (root) => {
    const path = join(root, "output.json");
    const output = JSON.parse(readFileSync(path, "utf8"));
    output.totals24h.goldProduced += 1;
    writeFileSync(path, `${JSON.stringify(output, null, 2)}\n`);
  }, /totals24h must equal exactly sustainability ledger entries 1\+2/);
  mutateAndExpectFailure("shift3-in-24h", (root) => {
    const path = join(root, "output.json");
    const output = JSON.parse(readFileSync(path, "utf8"));
    const shift3 = output.sustainability36h.resourceLedger.entries[2];
    output.shifts.push(shift3);
    output.totals24h.goldProduced += shift3.gold.produced;
    output.totals24h.lmd += shift3.lmd.total;
    writeFileSync(path, `${JSON.stringify(output, null, 2)}\n`);
  }, /24h benchmark shifts must exclude shift3/);
  mutateAndExpectFailure("cyclic-group-a-phase", (root) => {
    const path = join(root, "output.json");
    const output = JSON.parse(readFileSync(path, "utf8"));
    const phase = output.trace.cyclicElapsedWorkPhase.groups.A[0];
    phase.elapsedWorkInterval = [0, 12];
    phase.effectiveEfficiency = 1.2;
    writeFileSync(path, `${JSON.stringify(output, null, 2)}\n`);
  }, /cyclic elapsed-work phase mismatch/);
  mutateAndExpectFailure("sustainability-morale", (root) => {
    const path = join(root, "output.json");
    const output = JSON.parse(readFileSync(path, "utf8"));
    output.sustainability36h.actors.char_010_chen[0].signedDelta += 1;
    writeFileSync(path, `${JSON.stringify(output, null, 2)}\n`);
  }, /mode-derived morale delta mismatch/);
  mutateAndExpectFailure("sustainability-dorm", (root) => {
    const path = join(root, "output.json");
    const output = JSON.parse(readFileSync(path, "utf8"));
    const state = output.sustainability36h.actors.char_1019_siege2[0];
    state.activity.slot = 5;
    writeFileSync(path, `${JSON.stringify(output, null, 2)}\n`);
  }, /non-deterministic dormitory assignment/);
  mutateAndExpectFailure("sustainability-bundle-occupancy", (root) => {
    const path = join(root, "output.json");
    const output = JSON.parse(readFileSync(path, "utf8"));
    output.sustainability36h.dormitoryOccupancy[1].occupied = 19;
    writeFileSync(path, `${JSON.stringify(output, null, 2)}\n`);
  }, /bundle Perception active-shift dormitory occupancy mismatch groups-b-c: concrete=19 bundle=20/);
  mutateAndExpectFailure("sustainability-exchange", (root) => {
    const path = join(root, "output.json");
    const output = JSON.parse(readFileSync(path, "utf8"));
    output.sustainability36h.actors.char_2023_ling[1].activity.counterparty = "char_338_iris";
    writeFileSync(path, `${JSON.stringify(output, null, 2)}\n`);
  }, /exchange reciprocal counterparty mismatch/);
  mutateAndExpectFailure("hash", (root) => {
    const path = join(root, "manifest.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    manifest.files[0].sha256 = "0".repeat(64);
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }, /manifest metadata\/file hash mismatch/, false);
});
