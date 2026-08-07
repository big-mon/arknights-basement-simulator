#!/usr/bin/env python3
"""Offline independent reproducer/verifier for Wikiru backup 38 (12h v2)."""

import argparse
import hashlib
import json
import math
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

PACKET_ID = "wikiru-backup38-12h-v2"
SNAPSHOT_SHA = "33b7f7d08f5249b0d93efad441ef1dd7ec95d7e5939fdda7e02c9625d9cb45a8"
GAME_EXTRACT_SHA = "af44f691c7708fa7f2e024df47d4a9fa05610d62f95e60ba9c2c3e40a840b923"
BASE_MECHANICS_SHA = "b046b63ff91ba0374a913146e3195a8f892ceb26520453375fd16440932defdf"
BUNDLE_FILE_SHA = "8a8e03596fda0f77cf4169914126a48d3abd8d27e1518a4d76fce4e374567edf"
BUNDLE_CONTENT_SHA = "5aca766b23d7eabfbb924d460b878d07351c5377ec0007ee12194de7fe1565ba"
GAME_COMMIT = "7faf192d15eeac8b236c561a1938679f4642279e"
CHARACTER_FULL_SHA = "e5db4e916181700195397e67bf5fafd9897ebdd8961b6702a17985b8c61f463d"
BUILDING_FULL_SHA = "162f838e5e1cdd10cda98cd77ae9fc68931c48d8c3230952cdcce8670ebda6da"
SHIFT_IDS = ["groups-a-b", "groups-b-c", "groups-c-a"]
FACILITIES = {
    "制御中枢": ("control-center", 5),
    "応接室": ("reception", 2),
    "記録製造1": ("factory-battle-record-1", 3),
    "記録製造2": ("factory-battle-record-2", 3),
    "純金製造1": ("factory-gold-1", 3),
    "純金製造2": ("factory-gold-2", 3),
    "貿易所1": ("trading-post-1", 3),
    "貿易所2": ("trading-post-2", 3),
    "発電所1": ("power-plant-1", 1),
    "発電所2": ("power-plant-2", 1),
    "発電所3": ("power-plant-3", 1),
    "事務室": ("office", 1)
}
COLOR_GROUPS = {
    "background-color:#99ffff;": "A",
    "background-color:#ff99ff;": "B",
    "background-color:#ffff99;": "C",
    "background-color:#cccccc;": "support"
}
ACTIVE_GROUPS = [{"A", "B"}, {"B", "C", "support"}, {"C", "A"}]
ALLOWED_ASSUMPTIONS = [
    "phase1.high-value-order-probability.v1",
    "phase1.perception-information-factory-efficiency.v1",
    "phase1.signed-equivalent-morale-delta.v1"
]
RESULT_BUFF_IDS = {
    "char_214_kafka": ["trade_ord_wt&cost[011]"],
    "char_190_clour": ["manu_prod_limit&cost[0000]", "manu_prod_spd_variable[000]"],
    "char_253_greyy": ["power_rec_spd[020]"],
    "char_336_folivo": ["manu_prod_spd_addition[041]", "manu_formula_limit[0000]"],
    "char_377_gdglow": ["power_rec_spd[023]"],
    "char_4032_provs": ["trade_ord_law[000]", "trade_ord_against[010]"],
    "char_4179_monstr": ["control_prod_spd[1000]"],
    "char_485_pallas": ["manu_prod_limit&cost[003]", "manu_formula_spd[000]"],
    "char_486_takila": ["trade_ord_long[010]"],
    "char_1011_lava2": ["power_rec_spd[022]"],
    "char_1027_greyy2": ["power_rec_drone[000]"],
    "char_1044_hsgma2": ["control_token_prod_spd3[000]"],
    "char_107_liskam": ["power_rec_spd[021]"]
}
ADDITIONAL_BUFF_DEFINITION_IDS = ["trade_ord_wt&cost[010]"]
KAFKA_OPERATOR_ID = "char_214_kafka"
KAFKA_UNLOCKED_BUFF_ID = "trade_ord_wt&cost[011]"
KAFKA_TICKET_DEFINITION_BUFF_ID = "trade_ord_wt&cost[010]"
KAFKA_E2_REFERENCE = "/chars/char_214_kafka/buffChar/0/buffData/1"
SHAMARE_KAFKA_TEQUILA_TEAM = ["char_254_vodfox", KAFKA_OPERATOR_ID, "char_486_takila"]


class EvidenceError(Exception):
    pass


def fail(message):
    raise EvidenceError(message)


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def rounded(value):
    value = round(float(value), 12)
    return 0.0 if value == -0.0 else value


class TableParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tables = []
        self.table = None
        self.row = None
        self.cell = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "table":
            self.table = []
        elif self.table is not None and tag == "tr":
            self.row = []
        elif self.row is not None and tag in ("td", "th"):
            self.cell = {"text": "", "style": attrs.get("style", "")}

    def handle_data(self, data):
        if self.cell is not None:
            self.cell["text"] += data

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self.cell is not None:
            self.cell["text"] = " ".join(self.cell["text"].split())
            self.row.append(self.cell)
            self.cell = None
        elif tag == "tr" and self.row is not None:
            self.table.append(self.row)
            self.row = None
        elif tag == "table" and self.table is not None:
            self.tables.append(self.table)
            self.table = None


def read_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"cannot read {path.name}: {error}")


def verify_fixed_inputs(root):
    paths = {
        "snapshot": root / "inputs/wikiru-backup38-20260806.html",
        "game": root / "inputs/jp-game-data-extract-v1.json",
        "mechanics": root / "inputs/base-mechanics-2026-07.json",
        "bundle": root / "inputs/phase1-project-assumption-bundle-v2.json"
    }
    expected = {
        "snapshot": SNAPSHOT_SHA,
        "game": GAME_EXTRACT_SHA,
        "mechanics": BASE_MECHANICS_SHA,
        "bundle": BUNDLE_FILE_SHA
    }
    for key, path in paths.items():
        try:
            actual = sha256_bytes(path.read_bytes())
        except OSError as error:
            fail(f"missing pinned input {path}: {error}")
        if actual != expected[key]:
            fail(f"pinned {key} hash mismatch: {actual}")
    snapshot_text = paths["snapshot"].read_text(encoding="utf-8")
    if "バックアップ38 (2025-11-02 (日) 18:43:20)" not in snapshot_text:
        fail("pinned Wikiru backup/date marker missing")
    if 'datePublished":"2026-08-06T02:37:05+00:00' not in snapshot_text:
        fail("pinned Wikiru reference date marker missing")
    return snapshot_text, read_json(paths["game"]), read_json(paths["mechanics"]), read_json(paths["bundle"])


def validate_game_extract(game):
    source = game.get("source", {})
    if game.get("schemaVersion") != 1 or source.get("commit") != GAME_COMMIT:
        fail("JP game-data extract version/commit mismatch")
    if source.get("characterTable") != {
        "path": "jp/gamedata/excel/character_table.json",
        "fullBlobContentSha256": CHARACTER_FULL_SHA
    }:
        fail("JP character_table provenance mismatch")
    if source.get("buildingData") != {
        "path": "jp/gamedata/excel/building_data.json",
        "fullBlobContentSha256": BUILDING_FULL_SHA
    }:
        fail("JP building_data provenance mismatch")
    for operator_id, row in game.get("characters", {}).items():
        if f"/{operator_id}" not in game.get("rowIdentity", {}).get("characterTable", []):
            fail(f"untracked character row {operator_id}")
        if row.get("isNotObtainable") is not False:
            fail(f"non-obtainable roster actor {operator_id}")
    expected_buff_ids = sorted(
        {buff_id for buff_ids in RESULT_BUFF_IDS.values() for buff_id in buff_ids}
        | set(ADDITIONAL_BUFF_DEFINITION_IDS)
    )
    if list(game.get("buildingChars", {})) != list(RESULT_BUFF_IDS):
        fail("JP building-character extract is not load-bearing-minimal")
    if sorted(game.get("buildingBuffs", {})) != expected_buff_ids:
        fail("JP building-buff extract is not load-bearing-minimal")
    if game.get("rowIdentity", {}).get("buildingChars") != [f"/chars/{operator_id}" for operator_id in RESULT_BUFF_IDS]:
        fail("JP building-character row identity mismatch")
    if game.get("rowIdentity", {}).get("buildingBuffs") != [f"/buffs/{buff_id}" for buff_id in expected_buff_ids]:
        fail("JP building-buff row identity mismatch")
    if game.get("rowIdentity", {}).get("kafkaE2UnlockedBuffReference") != KAFKA_E2_REFERENCE:
        fail("Kafka E2 source-reference pointer mismatch")
    for operator_id, buff_ids in RESULT_BUFF_IDS.items():
        if list(unlocked_buff_rows(game, operator_id)) != buff_ids:
            fail(f"JP building-character buff selection mismatch {operator_id}")


def validate_bundle(bundle):
    if bundle.get("id") != "arknights-basement.phase1-project-assumptions" or bundle.get("version") != 2:
        fail("assumption bundle identity/version mismatch")
    if bundle.get("allowedAssumptionIds") != ALLOWED_ASSUMPTIONS:
        fail("assumption bundle allowed IDs mismatch")
    content = dict(bundle)
    content.pop("contentSha256", None)
    content_hash = sha256_bytes(canonical(content).encode("utf-8"))
    if bundle.get("contentSha256") != BUNDLE_CONTENT_SHA or content_hash != BUNDLE_CONTENT_SHA:
        fail("assumption bundle content hash mismatch")
    if bundle.get("contract", {}).get("fixtureConfidence") != "corroborated":
        fail("bundle confidence mismatch")
    perception = bundle["assumptions"][1]
    if perception["scope"].get("productionGroupId") != "C":
        fail("perception production group must be C")
    if perception["primary"].get("inactiveShiftIds") != ["groups-a-b"]:
        fail("perception inactive shift mismatch")
    active = perception["primary"].get("activeShifts")
    if active != {
        "groups-b-c": {"elapsedWorkHours": 12, "dormitoryOccupancy": 20, "perceptionInfo": 20},
        "groups-c-a": {"elapsedWorkHours": 12, "dormitoryOccupancy": 20, "perceptionInfo": 10}
    }:
        fail("perception active shift inputs mismatch")


def parse_source_composition(snapshot_text, game):
    parser = TableParser()
    parser.feed(snapshot_text)
    header = ["配置場所", "シフト1", "シフト2", "シフト3"]
    matching = [table for table in parser.tables if table and [cell["text"] for cell in table[0]][:4] == header]
    if len(matching) != 1:
        fail(f"expected one Wikiru composition table, found {len(matching)}")
    by_name = {}
    for operator_id, row in game["characters"].items():
        name = row["name"]
        if name in by_name:
            fail(f"ambiguous extracted canonical name {name}")
        by_name[name] = operator_id
    shifts = [{"id": shift_id, "hours": 12, "facilities": {}} for shift_id in SHIFT_IDS]
    rows = []
    room_label = None
    actor_groups = {}
    for row in matching[0][1:]:
        if len(row) == 4:
            room_label = row[0]["text"]
            cells = row[1:]
        elif len(row) == 3:
            cells = row
        else:
            fail(f"unexpected Wikiru table row width {len(row)}")
        if room_label not in FACILITIES:
            fail(f"unknown Wikiru facility {room_label}")
        facility_id = FACILITIES[room_label][0]
        for shift_index, cell in enumerate(cells):
            name = cell["text"]
            if name not in by_name:
                fail(f"Wikiru operator missing from pinned JP extract: {name}")
            if cell["style"] not in COLOR_GROUPS:
                fail(f"unknown Wikiru group color {cell['style']}")
            operator_id = by_name[name]
            group_id = COLOR_GROUPS[cell["style"]]
            prior = actor_groups.setdefault(operator_id, group_id)
            if prior != group_id:
                fail(f"operator changes Wikiru group: {operator_id}")
            if group_id not in ACTIVE_GROUPS[shift_index]:
                fail(f"inactive group appears in {SHIFT_IDS[shift_index]}: {operator_id}")
            shifts[shift_index]["facilities"].setdefault(facility_id, []).append(operator_id)
            rows.append({
                "facilityLabel": room_label,
                "facilityId": facility_id,
                "shiftId": SHIFT_IDS[shift_index],
                "sourceName": name,
                "operatorId": operator_id,
                "sourceColor": cell["style"],
                "groupId": group_id
            })
    return shifts, rows, actor_groups


def validate_composition(root, parsed_shifts, parsed_rows):
    composition = read_json(root / "composition.json")
    if composition.get("schemaVersion") != 1 or composition.get("layout") != "243":
        fail("composition schema/layout mismatch")
    if composition.get("shiftOrder") != SHIFT_IDS or composition.get("shiftHours") != 12 or composition.get("cycleHours") != 36:
        fail("composition timing/order mismatch")
    if composition.get("facilityProducts") != {
        "factory-gold-1": "gold", "factory-gold-2": "gold",
        "factory-battle-record-1": "battleRecord", "factory-battle-record-2": "battleRecord"
    }:
        fail("composition fixed product model mismatch")
    if composition.get("shifts") != parsed_shifts:
        fail("pinned Wikiru composition mismatch: assignments/facilities differ from snapshot")
    extract = read_json(root / "wikiru-primary-extract-v1.json")
    expected_extract = {
        "schemaVersion": 1,
        "tableHeader": ["配置場所", "シフト1", "シフト2", "シフト3"],
        "colorGroupMapping": {"#99ffff": "A", "#ff99ff": "B", "#ffff99": "C", "#cccccc": "support"},
        "rows": parsed_rows
    }
    if extract != expected_extract:
        fail("pinned Wikiru primary extract mismatch")
    expected_facilities = {value[0]: value[1] for value in FACILITIES.values()}
    for shift in parsed_shifts:
        if set(shift["facilities"]) != set(expected_facilities):
            fail(f"facility identity mismatch in {shift['id']}")
        actors = []
        for facility_id, capacity in expected_facilities.items():
            assigned = shift["facilities"][facility_id]
            if len(assigned) != capacity:
                fail(f"facility capacity mismatch {shift['id']} {facility_id}")
            actors.extend(assigned)
        if len(actors) != 29 or len(set(actors)) != 29:
            fail(f"active actor overlap/count mismatch in {shift['id']}")
    return composition


def mechanic(mechanics, formula_id):
    matches = [item for item in mechanics.get("formulas", []) if item.get("id") == formula_id]
    if len(matches) != 1:
        fail(f"missing base mechanic {formula_id}")
    return float(matches[0]["expectedValue"])


def unlocked_buff_rows(game, operator_id):
    row = game.get("buildingChars", {}).get(operator_id)
    if row is None:
        return {}
    result = {}
    for slot in row["buffChar"]:
        for item in slot.get("buffData", []):
            buff_id = item["buffId"]
            if buff_id not in game.get("buildingBuffs", {}):
                fail(f"missing extracted building buff {buff_id}")
            result[buff_id] = game["buildingBuffs"][buff_id]
    return result


def require_buff(game, operator_id, buff_id):
    buff = unlocked_buff_rows(game, operator_id).get(buff_id)
    if buff is None or buff.get("buffId") != buff_id:
        fail(f"JP building buff evidence mismatch {operator_id}/{buff_id}")
    return buff


def plain_description(buff):
    return re.sub(r"<[^>]*>", "", buff.get("description", ""))


def capture_number(text, pattern, label):
    match = re.search(pattern, text)
    if not match:
        fail(f"numeric rule missing from {label}: {pattern}")
    return float(match.group(1))


def capture_percent(text, pattern, label):
    return capture_number(text, pattern, label) / 100.0


def direct_efficiency(game, operator_id, buff_id, description_pattern):
    buff = require_buff(game, operator_id, buff_id)
    value = capture_percent(plain_description(buff), description_pattern, f"{operator_id}/{buff_id}")
    field_value = float(buff.get("efficiency", 0)) / 100.0
    if field_value and not math.isclose(value, field_value, abs_tol=1e-12):
        fail(f"building buff description/efficiency mismatch {operator_id}/{buff_id}")
    return value


def source_fact(snapshot_text, pattern, identity_guard):
    match = re.search(pattern, snapshot_text)
    if not match:
        fail(f"Wikiru numeric source fact missing: {pattern}")
    value = float(match.group(1)) / 100.0
    if not math.isclose(value, identity_guard, abs_tol=1e-12):
        fail(f"Wikiru numeric source identity changed: {value} != {identity_guard}")
    return value


def piecewise_proviso_efficiency(snapshot_text, start, end):
    match = re.search(
        r"実際には([0-9.]+)%が([0-9.]+)時間と([0-9.]+)\+([0-9.]+)%が([0-9.]+)時間",
        snapshot_text
    )
    if not match:
        fail("Wikiru Proviso piecewise source facts missing")
    first_efficiency = float(match.group(1)) / 100.0
    first_duration = float(match.group(2))
    second_base = float(match.group(3)) / 100.0
    second_addition = float(match.group(4)) / 100.0
    second_duration = float(match.group(5))
    source_segments = [
        {"elapsedWorkInterval": [0.0, first_duration], "efficiency": first_efficiency},
        {"elapsedWorkInterval": [first_duration, first_duration + second_duration], "efficiency": second_base + second_addition}
    ]
    if not 0 <= start < end <= first_duration + second_duration:
        fail(f"Proviso elapsed-work interval outside pinned piecewise curve: [{start},{end})")
    overlaps = []
    weighted = 0.0
    for segment in source_segments:
        overlap_start = max(float(start), segment["elapsedWorkInterval"][0])
        overlap_end = min(float(end), segment["elapsedWorkInterval"][1])
        duration = max(0.0, overlap_end - overlap_start)
        if duration:
            weighted += duration * segment["efficiency"]
            overlaps.append({
                "elapsedWorkInterval": [rounded(overlap_start), rounded(overlap_end)],
                "durationHours": rounded(duration),
                "efficiency": rounded(segment["efficiency"])
            })
    effective = weighted / (end - start)
    return rounded(effective), {
        "source": "inputs/wikiru-backup38-20260806.html",
        "elapsedWorkInterval": [rounded(start), rounded(end)],
        "sourceSegments": [
            {"elapsedWorkInterval": [rounded(value) for value in segment["elapsedWorkInterval"]], "efficiency": rounded(segment["efficiency"])}
            for segment in source_segments
        ],
        "overlapSegments": overlaps,
        "equation": "(" + "+".join(f"{item['durationHours']}h*{item['efficiency']}" for item in overlaps) + f")/{rounded(end - start)}h",
        "effectiveEfficiency": rounded(effective)
    }


def perception_efficiency(bundle, shift_id):
    assumption = bundle["assumptions"][1]["primary"]
    if shift_id in assumption["inactiveShiftIds"]:
        fail(f"inactive perception group requested for {shift_id}")
    shift = assumption["activeShifts"][shift_id]
    skills = assumption["allUnlockedSkills"]
    curve = skills["aroma"]["timeCurve"]
    hourly = []
    for hour in range(shift["elapsedWorkHours"]):
        elapsed_steps = hour if curve["startsAfterFirstHour"] else hour + 1
        hourly.append(min(curve["maxEfficiency"], elapsed_steps * curve["efficiencyPerHour"]))
    aroma = skills["aroma"]["goldEfficiency"] + sum(hourly) / len(hourly)
    thought_chain = (
        shift["dormitoryOccupancy"] * skills["rosmontis"]["thoughtChainPerDormitoryOccupant"]
        + shift["perceptionInfo"] * skills["rosmontis"]["thoughtChainPerPerceptionInfo"]
    )
    rosmontis = math.floor(thought_chain / skills["rosmontis"]["scalingPerThoughtChain"]) * skills["rosmontis"]["efficiencyPerThoughtChain"]
    scaling = skills["waaiFu"]["resultAffectingOtherOperatorScaling"]
    steps = math.floor((aroma + rosmontis) / scaling["otherEfficiencyPerStep"] + 1e-12)
    waai_fu = min(steps * scaling["efficiencyPerStep"], scaling["maxEfficiency"])
    return {"aroma": aroma, "thoughtChain": thought_chain, "waaiFu": waai_fu, "rosmontis": rosmontis, "group": aroma + waai_fu + rosmontis}


def average_progress(t, warmup):
    if t == 0:
        return 0.0
    if t < warmup:
        return t / (2 * warmup)
    return 1 - warmup / (2 * t)


def segment_distribution(bundle, level, start, end):
    primary = bundle["assumptions"][0]["primary"]
    warmup = primary["warmupHours"][level]
    integral_start = start * average_progress(start, warmup)
    integral_end = end * average_progress(end, warmup)
    progress = (integral_end - integral_start) / (end - start)
    normal = primary["normalDistribution"]
    target = primary["targetDistributions"][level]
    return [normal[i] + (target[i] - normal[i]) * progress for i in range(len(normal))]


def kafka_high_value_order_level(game, bundle, composition):
    for shift in composition["shifts"][:2]:
        matches = [
            actors for facility_id, actors in shift["facilities"].items()
            if facility_id.startswith("trading-post-") and actors == SHAMARE_KAFKA_TEQUILA_TEAM
        ]
        if len(matches) != 1:
            fail(f"fixed Shamare/Kafka/Tequila team identity mismatch {shift['id']}")

    kafka_row = game.get("buildingChars", {}).get(KAFKA_OPERATOR_ID)
    if kafka_row is None or kafka_row.get("charId") != KAFKA_OPERATOR_ID:
        fail("Kafka building-character identity mismatch")
    unlocked_rows = [
        item
        for slot in kafka_row.get("buffChar", [])
        for item in slot.get("buffData", [])
        if item.get("cond") == {"phase": "PHASE_2", "level": 1}
    ]
    expected_unlocked = {"buffId": KAFKA_UNLOCKED_BUFF_ID, "cond": {"phase": "PHASE_2", "level": 1}}
    if unlocked_rows != [expected_unlocked]:
        fail("Kafka E2/unlocked row identity mismatch")
    kafka_buff = require_buff(game, KAFKA_OPERATOR_ID, KAFKA_UNLOCKED_BUFF_ID)
    canonical_buff = game.get("buildingBuffs", {}).get(KAFKA_TICKET_DEFINITION_BUFF_ID)
    if canonical_buff is None or canonical_buff.get("buffId") != KAFKA_TICKET_DEFINITION_BUFF_ID:
        fail("Kafka ticket-named parallel beta buff definition identity mismatch")
    stable_fields = {
        "buffIcon": "trading", "skillIcon": "bskill_tra_wt&cost2", "sortId": 4005,
        "buffColor": "#0075a9", "textColor": "#ffffff", "buffCategory": "OUTPUT",
        "roomType": "TRADING", "efficiency": 0, "targetGroupSortId": 0, "targets": {}
    }
    for buff_id, buff in ((KAFKA_UNLOCKED_BUFF_ID, kafka_buff), (KAFKA_TICKET_DEFINITION_BUFF_ID, canonical_buff)):
        if any(buff.get(field) != value for field, value in stable_fields.items()):
            fail(f"Kafka high-value stable fields mismatch {buff_id}")
    comparable_fields = set(stable_fields) | {"description"}
    if any(kafka_buff.get(field) != canonical_buff.get(field) for field in comparable_fields):
        fail("Kafka unlocked/ticket-named parallel beta semantics mismatch")
    description = plain_description(kafka_buff)
    match = re.fullmatch(
        r"貿易所配置時、配置貿易所の高価値な金属オーダーの獲得率が(わずかに上昇|上昇)"
        r"（勤務時間が確率に影響する）、1時間ごとの体力消費量-0\.25",
        description
    )
    if not match:
        fail("Kafka high-value Japanese description semantics mismatch")
    semantic_to_level = {"わずかに上昇": "slight", "上昇": "increased"}
    level = semantic_to_level.get(match.group(1))
    if level != "increased":
        fail(f"Kafka high-value semantic level mismatch: {level}")

    assumption = bundle["assumptions"][0]
    if assumption.get("id") != "phase1.high-value-order-probability.v1":
        fail("high-value-order assumption identity mismatch")
    primary = assumption.get("primary", {})
    availability = {
        "scope.effectLevels": assumption.get("scope", {}).get("effectLevels", []),
        "primary.targetDistributions": primary.get("targetDistributions", {}),
        "primary.warmupHours": primary.get("warmupHours", {})
    }
    if any(level not in structure for structure in availability.values()):
        fail(f"derived Kafka bundle level unavailable: {level}")
    return level, {
        "sourcePath": "jp/gamedata/excel/building_data.json",
        "extractPath": "inputs/jp-game-data-extract-v1.json",
        "operatorId": KAFKA_OPERATOR_ID,
        "teamOperatorIds": SHAMARE_KAFKA_TEQUILA_TEAM,
        "evaluationShiftIds": SHIFT_IDS[:2],
        "unlockedBuffId": KAFKA_UNLOCKED_BUFF_ID,
        "unlockedRowIdentity": KAFKA_E2_REFERENCE,
        "unlockCondition": {"phase": "PHASE_2", "level": 1},
        "ticketNamedParallelDefinitionBuffId": KAFKA_TICKET_DEFINITION_BUFF_ID,
        "ticketNamedParallelDefinitionRowIdentity": f"/buffs/{KAFKA_TICKET_DEFINITION_BUFF_ID}",
        "descriptionSemantic": match.group(1),
        "derivedCanonicalLevel": level,
        "bundleAvailability": list(availability)
    }


def order_metrics(bundle, distribution, mode, trading_rules):
    primary = bundle["assumptions"][0]["primary"]
    hours = sum(distribution[i] * primary["orderHours"][i] for i in range(len(distribution)))
    if mode == "proviso":
        rule = trading_rules["proviso"]
        delivered = [
            gold + rule["breachAdditionalGold"] if gold < rule["breachThresholdGold"] else gold
            for gold in primary["orderGold"]
        ]
        gold = sum(distribution[i] * delivered[i] for i in range(len(distribution)))
        lmd = gold * primary["lmdPerGold"]
    else:
        gold = sum(distribution[i] * primary["orderGold"][i] for i in range(len(distribution)))
        lmd = gold * primary["lmdPerGold"]
        if mode == "tequila":
            rule = trading_rules["tequila"]
            qualifying_probability = sum(
                distribution[i]
                for i, order_gold in enumerate(primary["orderGold"])
                if order_gold > rule["minimumExclusiveGold"]
            )
            lmd += qualifying_probability * rule["bonusLmd"]
    return {"hours": hours, "gold": gold, "lmd": lmd, "distribution": distribution}


def throughput(hours, efficiency, metrics):
    orders = hours * (1 + efficiency) / metrics["hours"]
    return {"orders": orders, "gold": orders * metrics["gold"], "lmd": orders * metrics["lmd"]}


def drone_throughput(drones, metrics, drone_minutes):
    orders = drones * drone_minutes / 60 / metrics["hours"]
    return {"orders": orders, "gold": orders * metrics["gold"], "lmd": orders * metrics["lmd"]}


def validate_numeric_sources(snapshot_text, game):
    facts = {
        "battleA": source_fact(snapshot_text, r"表記効率(110)%", 1.10),
        "battleB24Average": source_fact(snapshot_text, r"平均表記効率(104\.75)%", 1.0475),
        "battleCShift1": source_fact(snapshot_text, r"ヴィヴィアナのいる1コマ目が表記効率(126)%", 1.26),
        "battleCShift2": source_fact(snapshot_text, r"ヴィヴィアナのいない2コマ目が表記効率(105)%", 1.05),
        "goldA": source_fact(snapshot_text, r"施設数に応じて製造所の効率を上げるスキルを持つ組。表記効率は(140)%", 1.40),
        "goldB": source_fact(snapshot_text, r"金属工芸組。.*?表記効率(123)%", 1.23),
        "shamare": source_fact(snapshot_text, r"シャマレで表記効率を固定（(90)%）", 0.90),
        "glasgowShift1": source_fact(snapshot_text, r"デルフィーンのいる1コマ目は表記効率(135)%", 1.35),
        "glasgowShift2": source_fact(snapshot_text, r"デルフィーンがいない2コマ目は表記効率(115)%", 1.15),
        "tradingControl": source_fact(snapshot_text, r"全貿易所の受注効率\+([0-9]+)%", 0.07)
    }
    pallas = direct_efficiency(game, "char_485_pallas", "manu_formula_spd[000]", r"作戦記録製造の製造効率\+([0-9.]+)%")
    vermeil_buff = require_buff(game, "char_190_clour", "manu_prod_spd_variable[000]")
    vermeil_per_storage = capture_percent(
        plain_description(vermeil_buff), r"保管上限1上昇につき、製造効率\+([0-9.]+)%", "char_190_clour/manu_prod_spd_variable[000]"
    )
    storage_buffs = [
        ("char_190_clour", "manu_prod_limit&cost[0000]"),
        ("char_485_pallas", "manu_prod_limit&cost[003]"),
        ("char_336_folivo", "manu_formula_limit[0000]")
    ]
    storage_increases = [
        capture_number(plain_description(require_buff(game, actor, buff_id)), r"保管上限\+([0-9.]+)", f"{actor}/{buff_id}")
        for actor, buff_id in storage_buffs
    ]
    vermeil = vermeil_per_storage * sum(storage_increases)
    scene_buff = require_buff(game, "char_336_folivo", "manu_prod_spd_addition[041]")
    scene_description = plain_description(scene_buff)
    first_hours = int(capture_number(scene_description, r"最初の([0-9.]+)時間", "char_336_folivo/manu_prod_spd_addition[041]"))
    scene_initial = capture_percent(scene_description, r"最初の[0-9.]+時間製造効率\+([0-9.]+)%", "char_336_folivo/manu_prod_spd_addition[041]")
    scene_increment = capture_percent(scene_description, r"1時間ごと更に\+([0-9.]+)%", "char_336_folivo/manu_prod_spd_addition[041]")
    scene_cap = capture_percent(scene_description, r"最終的に\+([0-9.]+)%", "char_336_folivo/manu_prod_spd_addition[041]")
    scene_field = float(scene_buff.get("efficiency", 0)) / 100.0
    if not math.isclose(scene_initial, scene_field, abs_tol=1e-12):
        fail("Scene initial description/efficiency mismatch")
    shift_hours = 12
    scene_hourly = [
        scene_initial if hour < first_hours else min(scene_cap, scene_initial + (hour - first_hours + 1) * scene_increment)
        for hour in range(shift_hours)
    ]
    facts["battleBShift1"] = pallas + vermeil + sum(scene_hourly) / shift_hours
    facts["battleBShift2"] = pallas + vermeil + scene_cap
    if not math.isclose((facts["battleBShift1"] + facts["battleBShift2"]) / 2, facts["battleB24Average"], abs_tol=1e-12):
        fail("Pallas/Scene/Vermeil shift derivation does not reproduce Wikiru average")
    control_identities = {
        "groups-a-b": ("char_4179_monstr", "control_prod_spd[1000]"),
        "groups-b-c": ("char_1044_hsgma2", "control_token_prod_spd3[000]"),
        "groups-c-a": ("char_4179_monstr", "control_prod_spd[1000]")
    }
    control = {
        shift_id: direct_efficiency(game, operator_id, buff_id, r"全製造所の製造効率\+([0-9.]+)%")
        for shift_id, (operator_id, buff_id) in control_identities.items()
    }
    proviso_threshold = capture_number(
        plain_description(require_buff(game, "char_4032_provs", "trade_ord_law[000]")),
        r"納品数が([0-9.]+)を下回る", "char_4032_provs/trade_ord_law[000]"
    )
    proviso_addition = capture_number(
        plain_description(require_buff(game, "char_4032_provs", "trade_ord_against[010]")),
        r"納品数が\+([0-9.]+)追加", "char_4032_provs/trade_ord_against[010]"
    )
    tequila_description = plain_description(require_buff(game, "char_486_takila", "trade_ord_long[010]"))
    tequila_threshold = capture_number(tequila_description, r"納品数が([0-9.]+)を上回る", "char_486_takila/trade_ord_long[010]")
    tequila_bonus = capture_number(tequila_description, r"報酬金額が\+([0-9.]+)追加", "char_486_takila/trade_ord_long[010]")
    trading_rules = {
        "proviso": {"breachThresholdGold": proviso_threshold, "breachAdditionalGold": proviso_addition},
        "tequila": {"minimumExclusiveGold": tequila_threshold, "bonusLmd": tequila_bonus}
    }
    numeric_origins = {
        "wikiruCapturedEfficiencies": {
            "source": "inputs/wikiru-backup38-20260806.html",
            "values": {key: rounded(value) for key, value in facts.items() if not key.startswith("battleBShift")}
        },
        "battleRecordGroupB": {
            "source": "inputs/jp-game-data-extract-v1.json",
            "buffIds": ["manu_formula_spd[000]", "manu_prod_spd_variable[000]", "manu_prod_limit&cost[0000]", "manu_prod_limit&cost[003]", "manu_formula_limit[0000]", "manu_prod_spd_addition[041]"],
            "pallasEfficiency": rounded(pallas), "storageIncreases": [rounded(value) for value in storage_increases],
            "vermeilEfficiencyPerStorage": rounded(vermeil_per_storage), "vermeilEfficiency": rounded(vermeil),
            "sceneHourlyEfficiencies": [rounded(value) for value in scene_hourly], "sceneCap": rounded(scene_cap)
        },
        "controlCenterFactoryEfficiency": {
            shift_id: {"operatorId": control_identities[shift_id][0], "buffId": control_identities[shift_id][1], "efficiency": rounded(value)}
            for shift_id, value in control.items()
        },
        "tradingRules": {
            "source": "inputs/jp-game-data-extract-v1.json",
            "proviso": {"buffIds": ["trade_ord_law[000]", "trade_ord_against[010]"], **trading_rules["proviso"]},
            "tequila": {"buffIds": ["trade_ord_long[010]"], **trading_rules["tequila"]}
        }
    }
    return facts, control, trading_rules, numeric_origins


def generated_drones(game, mechanics, shift, numeric_origins):
    base = mechanic(mechanics, "base-drone-recovery")
    cap = mechanic(mechanics, "drone-cap")
    shift_id = shift["id"]
    if shift_id not in SHIFT_IDS:
        fail(f"unknown drone-ledger shift {shift_id}")
    power_actors = [actors[0] for facility_id, actors in shift["facilities"].items() if facility_id.startswith("power-plant-")]
    actor_rules = []
    for actor in power_actors:
        candidates = []
        for buff_id, buff in unlocked_buff_rows(game, actor).items():
            description = plain_description(buff)
            direct = re.search(r"ドローンの回復速度\+([0-9.]+)%", description)
            conditional = re.search(r"ドローンの上限数([0-9.]+)につき、ドローンの回復速度\+([0-9.]+)%（最大\+([0-9.]+)%まで）", description)
            if conditional:
                divisor = float(conditional.group(1))
                per_step = float(conditional.group(2)) / 100.0
                maximum = float(conditional.group(3)) / 100.0
                value = min(math.floor(cap / divisor) * per_step, maximum)
                candidates.append((value, buff_id, {"kind": "drone-cap-scaling", "capPerStep": divisor, "efficiencyPerStep": per_step, "maximum": maximum, "efficiency": value}))
            elif direct:
                value = float(direct.group(1)) / 100.0
                field_value = float(buff.get("efficiency", 0)) / 100.0
                if not math.isclose(value, field_value, abs_tol=1e-12):
                    fail(f"power buff description/efficiency mismatch {actor}/{buff_id}")
                candidates.append((value, buff_id, {"kind": "direct", "efficiency": value}))
        if not candidates:
            fail(f"missing result-affecting power buff for {actor}/{shift_id}")
        value, buff_id, rule = max(candidates, key=lambda candidate: candidate[0])
        actor_rules.append({"operatorId": actor, "buffId": buff_id, **rule})
    bonus = sum(rule["efficiency"] for rule in actor_rules)
    numeric_origins["powerPlantDroneRecovery"]["shifts"][shift_id] = actor_rules
    return float(shift["hours"]) * base * (1 + bonus)


def work_locations_by_shift(parsed_shifts):
    result = []
    for shift in parsed_shifts:
        locations = {}
        for facility_id, assigned in shift["facilities"].items():
            for actor in assigned:
                if actor in locations:
                    fail(f"duplicate active actor {actor}")
                locations[actor] = facility_id
        result.append(locations)
    return result


def state_end_from_activity(start, activity, morale, label):
    mode = activity.get("mode")
    cap = float(morale["moraleCap"])
    if mode == "work":
        duration = float(activity.get("activeHours"))
        return max(0.0, start - float(morale["baseWorkConsumptionRatePerHour"]) * duration)
    if mode == "ordinary-recovery":
        duration = float(activity.get("activeHours"))
        return min(cap, start + float(morale["ordinaryDormitoryRecoveryRatePerHour"]) * duration)
    if mode in ("idle", "support"):
        return start
    if mode == "exchange-support":
        return None
    fail(f"unknown sustainability mode {mode} at {label}")


def allocate_dormitory_slots(actors):
    for index, shift_id in enumerate(SHIFT_IDS):
        occupants = sorted(
            actor for actor, states in actors.items()
            if states[index]["activity"]["mode"] in ("ordinary-recovery", "support")
        )
        if len(occupants) > 20:
            fail(f"dormitory total capacity exceeded {shift_id}: {len(occupants)}")
        for position, actor in enumerate(occupants):
            actors[actor][index]["activity"]["dormitoryId"] = f"dormitory-{position // 5 + 1}"
            actors[actor][index]["activity"]["slot"] = position % 5 + 1


def validate_sustainability(sustainability, parsed_shifts, actor_groups, morale, perception_active_shifts):
    work_locations = work_locations_by_shift(parsed_shifts)
    actors = sustainability.get("actors", {})
    cap = float(morale["moraleCap"])
    if sustainability.get("cycleHours") != sum(shift["hours"] for shift in parsed_shifts) or sustainability.get("slotLevelAbstraction") is not True:
        fail("sustainability cycle/abstraction mismatch")
    saved_dormitory_occupancy = {
        entry.get("shiftId"): entry.get("occupied")
        for entry in sustainability.get("dormitoryOccupancy", [])
    }
    for shift_id, active_input in perception_active_shifts.items():
        expected_occupied = active_input["dormitoryOccupancy"]
        if saved_dormitory_occupancy.get(shift_id) != expected_occupied:
            fail(f"bundle Perception active-shift dormitory occupancy mismatch {shift_id}: concrete={saved_dormitory_occupancy.get(shift_id)} bundle={expected_occupied}")
    expected_actors = set(actor_groups) | {"char_300_phenxi", "char_338_iris", "char_4047_pianst", "char_002_amiya", "char_2014_nian"}
    if set(actors) != expected_actors or sustainability.get("actorCount") != len(expected_actors):
        fail("sustainability actor identity/count mismatch")
    for actor, states in actors.items():
        if len(states) != len(SHIFT_IDS):
            fail(f"incomplete actor activity coverage {actor}")
        for index, state in enumerate(states):
            label = f"{actor}/{SHIFT_IDS[index]}"
            if state.get("shiftId") != SHIFT_IDS[index]:
                fail(f"morale timing mismatch {label}")
            start = float(state.get("startMorale"))
            end = float(state.get("endMorale"))
            delta = float(state.get("signedDelta"))
            if not 0 <= start <= cap or not 0 <= end <= cap:
                fail(f"morale bounds mismatch {label}")
            if index and not math.isclose(start, float(states[index - 1]["endMorale"]), abs_tol=1e-12):
                fail(f"morale continuity mismatch {label}")
            activity = state.get("activity", {})
            mode = activity.get("mode")
            shift_hours = float(parsed_shifts[index]["hours"])
            if mode in ("work", "idle", "support") and not math.isclose(float(activity.get("activeHours")), shift_hours, abs_tol=1e-12):
                fail(f"activity duration mismatch {label}")
            if mode == "ordinary-recovery" and not 0 <= float(activity.get("activeHours")) <= shift_hours:
                fail(f"ordinary recovery duration mismatch {label}")
            should_work = actor in work_locations[index]
            if (mode == "work") != should_work:
                fail(f"work iff assignment mismatch {label}")
            if mode == "work" and activity.get("facilityId") != work_locations[index][actor]:
                fail(f"work facility mismatch {label}")
            expected_end = state_end_from_activity(start, activity, morale, label)
            if expected_end is not None and (not math.isclose(end, expected_end, abs_tol=1e-12) or not math.isclose(delta, expected_end - start, abs_tol=1e-12)):
                fail(f"mode-derived morale delta mismatch {label}")
        if not math.isclose(float(states[-1]["endMorale"]), float(states[0]["startMorale"]), abs_tol=1e-12):
            fail(f"morale closure mismatch {actor}")

    dormitory_occupancy = []
    exchange_occupancy = []
    for index, shift_id in enumerate(SHIFT_IDS):
        occupants = sorted(
            actor for actor, states in actors.items()
            if states[index]["activity"]["mode"] in ("ordinary-recovery", "support")
        )
        slots = set()
        for position, actor in enumerate(occupants):
            activity = actors[actor][index]["activity"]
            expected_location = (f"dormitory-{position // 5 + 1}", position % 5 + 1)
            actual_location = (activity.get("dormitoryId"), activity.get("slot"))
            if actual_location != expected_location:
                fail(f"non-deterministic dormitory assignment {actor}/{shift_id}")
            if actual_location in slots:
                fail(f"dormitory slot overlap {shift_id}/{actual_location}")
            slots.add(actual_location)
        per_dorm = []
        for dorm_index in range(4):
            dormitory_id = f"dormitory-{dorm_index + 1}"
            dorm_actors = [actor for actor in occupants if actors[actor][index]["activity"]["dormitoryId"] == dormitory_id]
            ordinary = sum(actors[actor][index]["activity"]["mode"] == "ordinary-recovery" for actor in dorm_actors)
            support = sum(actors[actor][index]["activity"]["mode"] == "support" for actor in dorm_actors)
            if len(dorm_actors) > 5:
                fail(f"dormitory capacity exceeded {shift_id}/{dormitory_id}")
            per_dorm.append({"dormitoryId": dormitory_id, "ordinaryRecoveryOccupied": ordinary, "supportOccupied": support, "occupied": len(dorm_actors), "capacity": 5})
        ordinary_total = sum(states[index]["activity"]["mode"] == "ordinary-recovery" for states in actors.values())
        support_total = sum(states[index]["activity"]["mode"] == "support" for states in actors.values())
        dormitory_occupancy.append({
            "shiftId": shift_id, "ordinaryRecoveryOccupied": ordinary_total, "supportOccupied": support_total,
            "occupied": len(occupants), "capacity": 20, "dormitories": per_dorm
        })
        if shift_id in perception_active_shifts:
            expected_occupied = perception_active_shifts[shift_id]["dormitoryOccupancy"]
            if len(occupants) != expected_occupied:
                fail(f"bundle Perception active-shift dormitory occupancy mismatch {shift_id}: concrete={len(occupants)} bundle={expected_occupied}")

        exchange_states = [(actor, states[index]) for actor, states in actors.items() if states[index]["activity"]["mode"] == "exchange-support"]
        pairs = {}
        for actor, state in exchange_states:
            capacity_id = state["activity"].get("capacityId")
            pairs.setdefault(capacity_id, []).append((actor, state))
        if len(pairs) > 1:
            fail(f"exchange pair capacity exceeded {shift_id}")
        for capacity_id, pair in pairs.items():
            if capacity_id != "morale-exchange-1" or len(pair) != 2:
                fail(f"exchange capacity/occupancy mismatch {shift_id}")
            by_role = {state["activity"].get("role"): (actor, state) for actor, state in pair}
            if set(by_role) != {"source", "target"}:
                fail(f"exchange roles mismatch {shift_id}")
            source_actor, source = by_role["source"]
            target_actor, target = by_role["target"]
            if source_actor == target_actor or source["activity"].get("counterparty") != target_actor or target["activity"].get("counterparty") != source_actor:
                fail(f"exchange reciprocal counterparty mismatch {shift_id}")
            if not math.isclose(float(source["startMorale"]), cap, abs_tol=1e-12):
                fail(f"exchange source must start at morale cap {shift_id}")
            if not math.isclose(float(source["endMorale"]), float(target["startMorale"]), abs_tol=1e-12) or not math.isclose(float(target["endMorale"]), float(source["startMorale"]), abs_tol=1e-12):
                fail(f"exchange state swap mismatch {shift_id}")
            for state in (source, target):
                if not math.isclose(float(state["signedDelta"]), float(state["endMorale"]) - float(state["startMorale"]), abs_tol=1e-12):
                    fail(f"exchange signed delta mismatch {shift_id}")
            if not math.isclose(float(source["signedDelta"]) + float(target["signedDelta"]), 0.0, abs_tol=1e-12):
                fail(f"exchange signed deltas do not sum to zero {shift_id}")
        exchange_occupancy.append({"shiftId": shift_id, "pairsOccupied": len(pairs), "pairCapacity": 1, "actorsOccupied": len(exchange_states)})
    if sustainability.get("dormitoryOccupancy") != dormitory_occupancy:
        fail("dormitory occupancy witness mismatch")
    if sustainability.get("exchangeSupportOccupancy") != exchange_occupancy:
        fail("exchange occupancy witness mismatch")
    closure = all(states[-1]["endMorale"] == states[0]["startMorale"] for states in actors.values())
    if sustainability.get("returnsToInitialState") is not closure or not closure:
        fail("sustainability closure result mismatch")


def build_sustainability(parsed_shifts, actor_groups, game, bundle):
    morale = bundle["assumptions"][2]["primary"]
    if morale != {
        "moraleCap": 24,
        "baseWorkConsumptionRatePerHour": 1,
        "ordinaryDormitoryRecoveryRatePerHour": 4,
        "workFormula": "end=max(0,start-rate*duration);delta=end-start",
        "recoveryFormula": "integrate-effective-rate-at-thresholds;end=min(cap,start+integral);delta=end-start",
        "exchangeFormula": "require(sourceBefore=moraleCap);sourceEnd=targetBefore;targetEnd=sourceBefore;sourceDelta=sourceEnd-sourceBefore;targetDelta=targetEnd-targetBefore;sourceDelta+targetDelta=0"
    }:
        fail("signed morale primary formula/input mismatch")
    fiammetta = "char_300_phenxi"
    ling = "char_2023_ling"
    fixed_dorm = ["char_338_iris", "char_4047_pianst"]
    support_only_helpers = ["char_002_amiya", "char_2014_nian"]
    for actor in list(actor_groups) + [fiammetta] + fixed_dorm + support_only_helpers:
        if actor not in game["characters"]:
            fail(f"sustainability actor absent from JP catalog: {actor}")
    if set(game["characters"]) != set(actor_groups) | {fiammetta, *fixed_dorm, *support_only_helpers}:
        fail("JP character extract is not load-bearing-minimal")
    shift_hours = float(parsed_shifts[0]["hours"])
    cap = float(morale["moraleCap"])
    recovery_rate = float(morale["ordinaryDormitoryRecoveryRatePerHour"])
    initial_by_group = {"A": shift_hours, "B": cap, "C": 0.0, "support": shift_hours}
    recovery_shift_by_group = {"A": 1, "B": 2, "C": 0, "support": 2}
    work_locations = work_locations_by_shift(parsed_shifts)
    actor_initial = {actor: initial_by_group[group] for actor, group in actor_groups.items()}
    actor_initial[fiammetta] = cap
    actor_initial.update({actor: cap for actor in fixed_dorm})
    actor_initial.update({actor: cap for actor in support_only_helpers})
    actors = {actor: [] for actor in sorted(actor_initial)}
    current = dict(actor_initial)
    for index, shift_id in enumerate(SHIFT_IDS):
        activities = {}
        for actor in actors:
            if actor in support_only_helpers:
                activities[actor] = {"mode": "support" if index == 1 else "idle", "activeHours": shift_hours}
            elif actor in fixed_dorm:
                activities[actor] = {"mode": "support", "activeHours": shift_hours}
            elif actor == fiammetta and index == 1:
                activities[actor] = {"mode": "exchange-support", "role": "source", "counterparty": ling, "capacityId": "morale-exchange-1"}
            elif actor == ling and index == 1:
                activities[actor] = {"mode": "exchange-support", "role": "target", "counterparty": fiammetta, "capacityId": "morale-exchange-1"}
            elif actor in work_locations[index]:
                activities[actor] = {"mode": "work", "facilityId": work_locations[index][actor], "activeHours": shift_hours}
            else:
                group = actor_groups.get(actor)
                should_recover = (actor == fiammetta and index == len(SHIFT_IDS) - 1) or (group is not None and recovery_shift_by_group[group] == index)
                target = actor_initial[actor] if index == len(SHIFT_IDS) - 1 else cap
                if should_recover and current[actor] < target:
                    activities[actor] = {"mode": "ordinary-recovery", "activeHours": (target - current[actor]) / recovery_rate}
                else:
                    activities[actor] = {"mode": "idle", "activeHours": shift_hours}
        exchange_source_start = current[fiammetta]
        exchange_target_start = current[ling]
        for actor, activity in activities.items():
            start = current[actor]
            if activity["mode"] == "exchange-support":
                end = exchange_target_start if activity["role"] == "source" else exchange_source_start
            else:
                end = state_end_from_activity(start, activity, morale, f"{actor}/{shift_id}")
            delta = end - start
            actors[actor].append({"shiftId": shift_id, "startMorale": start, "signedDelta": delta, "endMorale": end, "activity": activity})
            current[actor] = end
    allocate_dormitory_slots(actors)
    dorm_occupancy = []
    exchange_occupancy = []
    for index, shift_id in enumerate(SHIFT_IDS):
        per_dorm = []
        for dorm_index in range(4):
            dormitory_id = f"dormitory-{dorm_index + 1}"
            dorm_states = [states[index] for states in actors.values() if states[index]["activity"].get("dormitoryId") == dormitory_id]
            ordinary = sum(state["activity"]["mode"] == "ordinary-recovery" for state in dorm_states)
            support = sum(state["activity"]["mode"] == "support" for state in dorm_states)
            per_dorm.append({"dormitoryId": dormitory_id, "ordinaryRecoveryOccupied": ordinary, "supportOccupied": support, "occupied": len(dorm_states), "capacity": 5})
        ordinary_total = sum(states[index]["activity"]["mode"] == "ordinary-recovery" for states in actors.values())
        support_total = sum(states[index]["activity"]["mode"] == "support" for states in actors.values())
        dorm_occupancy.append({"shiftId": shift_id, "ordinaryRecoveryOccupied": ordinary_total, "supportOccupied": support_total, "occupied": ordinary_total + support_total, "capacity": 20, "dormitories": per_dorm})
        exchange_count = sum(states[index]["activity"]["mode"] == "exchange-support" for states in actors.values())
        exchange_occupancy.append({"shiftId": shift_id, "pairsOccupied": exchange_count // 2, "pairCapacity": 1, "actorsOccupied": exchange_count})
    result = {
        "cycleHours": sum(shift["hours"] for shift in parsed_shifts),
        "slotLevelAbstraction": True,
        "actorCount": len(actors),
        "actors": actors,
        "dormitoryOccupancy": dorm_occupancy,
        "exchangeSupportOccupancy": exchange_occupancy,
        "returnsToInitialState": all(states[-1]["endMorale"] == states[0]["startMorale"] for states in actors.values())
    }
    validate_sustainability(result, parsed_shifts, actor_groups, morale, bundle["assumptions"][1]["primary"]["activeShifts"])
    return result


def resource_totals(entries, starting_gold, ending_gold):
    return {
        "goldProduced": rounded(sum(item["gold"]["produced"] for item in entries)),
        "goldConsumed": rounded(sum(item["gold"]["consumed"] for item in entries)),
        "goldNet": rounded(ending_gold - starting_gold),
        "battleRecordExp": rounded(sum(item["battleRecordExp"] for item in entries)),
        "naturalLmd": rounded(sum(item["lmd"]["natural"] for item in entries)),
        "droneLmd": rounded(sum(item["lmd"]["drone"] for item in entries)),
        "lmd": rounded(sum(item["lmd"]["total"] for item in entries)),
        "dronesGenerated": rounded(sum(item["drones"]["generated"] for item in entries)),
        "dronesStarting": entries[0]["drones"]["starting"],
        "dronesUsed": rounded(sum(item["drones"]["used"] for item in entries)),
        "dronesEnding": entries[-1]["drones"]["ending"],
        "goldStarting": rounded(starting_gold),
        "goldEnding": rounded(ending_gold)
    }


def validate_resource_ledger(output, parsed_shifts):
    shifts = output.get("shifts", [])
    if [shift.get("shiftId") for shift in shifts] != SHIFT_IDS[:2] or len(shifts) != 2:
        fail("24h benchmark shifts must exclude shift3")
    ledger = output.get("sustainability36h", {}).get("resourceLedger", {})
    entries = ledger.get("entries", [])
    if ledger.get("purpose") != "sustainability-only" or ledger.get("cycleHours") != 36 or len(entries) != 3:
        fail("36h sustainability resource ledger identity/coverage mismatch")
    expected_boundaries = [
        {"shiftId": shift["id"], "startHour": index * shift["hours"], "endHour": (index + 1) * shift["hours"]}
        for index, shift in enumerate(parsed_shifts)
    ]
    if ledger.get("shiftBoundaries") != expected_boundaries:
        fail("36h sustainability resource ledger shift boundaries mismatch")
    if entries[:2] != shifts:
        fail("24h shifts are not reused by sustainability resource ledger")
    initial = ledger.get("initial", {})
    if initial != {"gold": entries[0]["gold"]["starting"], "drones": entries[0]["drones"]["starting"]}:
        fail("36h sustainability resource ledger initial state mismatch")
    for index, entry in enumerate(entries):
        shift_id = SHIFT_IDS[index]
        if entry.get("shiftId") != shift_id or entry.get("hours") != parsed_shifts[index]["hours"]:
            fail(f"36h sustainability resource ledger entry timing mismatch {shift_id}")
        gold = entry.get("gold", {})
        drones = entry.get("drones", {})
        if any(float(value) < -1e-12 for value in (gold.get("starting", -1), gold.get("ending", -1), drones.get("starting", -1), drones.get("ending", -1))):
            fail(f"nonnegative ledger prefix violated in {shift_id}")
        if not math.isclose(float(gold["net"]), float(gold["produced"]) - float(gold["consumed"]), abs_tol=1e-9):
            fail(f"gold ledger net mismatch in {shift_id}")
        if not math.isclose(float(gold["ending"]), float(gold["starting"]) + float(gold["net"]), abs_tol=1e-9):
            fail(f"gold ledger balance mismatch in {shift_id}")
        if not math.isclose(float(drones["starting"]) + float(drones["generated"]), float(drones["used"]) + float(drones["ending"]), abs_tol=1e-9):
            fail(f"drone ledger balance mismatch in {shift_id}")
        if drones.get("destination") != "trading-post-1":
            fail(f"drone ledger destination mismatch in {shift_id}")
        if index:
            if gold["starting"] != entries[index - 1]["gold"]["ending"]:
                fail(f"gold ledger continuity mismatch at {shift_id}")
            if drones["starting"] != entries[index - 1]["drones"]["ending"]:
                fail(f"drone ledger continuity mismatch at {shift_id}")
    final = {"gold": entries[-1]["gold"]["ending"], "drones": entries[-1]["drones"]["ending"]}
    if ledger.get("final") != final:
        fail("36h sustainability resource ledger final state mismatch")
    drone_return = final["drones"] == initial["drones"]
    if ledger.get("returnsToInitialDrones") is not drone_return or not drone_return:
        fail("36h sustainability drone ledger initial-return mismatch")
    expected_totals = resource_totals(entries[:2], initial["gold"], entries[1]["gold"]["ending"])
    if output.get("totals24h") != expected_totals:
        fail("totals24h must equal exactly sustainability ledger entries 1+2")
    three_shift_totals = resource_totals(entries, initial["gold"], entries[-1]["gold"]["ending"])
    if output["totals24h"]["goldProduced"] == three_shift_totals["goldProduced"] or output["totals24h"]["lmd"] == three_shift_totals["lmd"]:
        fail("totals24h must differ from the three-shift sustainability sum")


def calculate_output(snapshot_text, game, mechanics, bundle, composition, actor_groups):
    if mechanics.get("id") != "base-mechanics-2026-07" or mechanics.get("confidence") != "corroborated":
        fail("base mechanics identity/confidence mismatch")
    facts, control_factory, trading_rules, numeric_origins = validate_numeric_sources(snapshot_text, game)
    numeric_origins["powerPlantDroneRecovery"] = {"source": "inputs/jp-game-data-extract-v1.json", "shifts": {}}
    perception2 = perception_efficiency(bundle, "groups-b-c")
    perception3 = perception_efficiency(bundle, "groups-c-a")
    normal = bundle["assumptions"][0]["primary"]["normalDistribution"]
    high_value_level, high_value_origin = kafka_high_value_order_level(game, bundle, composition)
    numeric_origins["shamareKafkaTequilaHighValueOrder"] = high_value_origin
    high1 = segment_distribution(bundle, high_value_level, 0, 12)
    high2 = segment_distribution(bundle, high_value_level, 12, 24)
    proviso_second_slot, proviso_second_trace = piecewise_proviso_efficiency(snapshot_text, 12, 24)
    proviso_first_slot, proviso_first_trace = piecewise_proviso_efficiency(snapshot_text, 0, 12)
    cyclic_phase = {
        "shiftOrder": SHIFT_IDS,
        "continuousWorkSlotsPerGroup": 2,
        "groups": {
            "A": [
                {"shiftId": "groups-a-b", "slotOrdinal": 2, **proviso_second_trace},
                {"shiftId": "groups-c-a", "slotOrdinal": 1, **proviso_first_trace}
            ],
            "B": [
                {"shiftId": "groups-a-b", "slotOrdinal": 1, "elapsedWorkInterval": [0, 12], "teams": ["gold-metalwork", "battle-record-scene", "shamare-kafka-tequila"]},
                {"shiftId": "groups-b-c", "slotOrdinal": 2, "elapsedWorkInterval": [12, 24], "teams": ["gold-metalwork", "battle-record-scene", "shamare-kafka-tequila"]}
            ],
            "C": [
                {"shiftId": "groups-b-c", "slotOrdinal": 1, "elapsedWorkInterval": [0, 12], "teams": ["perception", "glasgow", "red-pine"]},
                {"shiftId": "groups-c-a", "slotOrdinal": 2, "elapsedWorkInterval": [12, 24], "teams": ["perception", "glasgow", "red-pine"]}
            ]
        }
    }
    metrics = {
        "proviso": order_metrics(bundle, normal, "proviso", trading_rules),
        "tequila1": order_metrics(bundle, high1, "tequila", trading_rules),
        "tequila2": order_metrics(bundle, high2, "tequila", trading_rules),
        "glasgow": order_metrics(bundle, normal, "normal", trading_rules)
    }
    base_gold_minutes = mechanic(mechanics, "gold-time")
    record_minutes = mechanic(mechanics, "battle-record-time")
    record_exp = mechanic(mechanics, "battle-record-exp")
    drone_minutes = mechanic(mechanics, "drone-time-reduction")
    starting_gold = 200.0
    gold_cursor = starting_gold
    drone_cursor = 0.0
    ledger_entries = []
    evaluation_gold_end = None
    for index, shift_id in enumerate(SHIFT_IDS):
        global_factory = control_factory[shift_id]
        control_origin = numeric_origins["controlCenterFactoryEfficiency"][shift_id]
        if control_origin["operatorId"] not in composition["shifts"][index]["facilities"]["control-center"]:
            fail(f"control-center numeric rule actor is not assigned in {shift_id}")
        if index == 0:
            gold_efficiencies = [facts["goldA"], facts["goldB"]]
            record_efficiencies = [facts["battleA"], facts["battleBShift1"]]
            trading = [
                (proviso_second_slot, metrics["proviso"]),
                (facts["shamare"], metrics["tequila1"])
            ]
        elif index == 1:
            gold_efficiencies = [facts["goldB"], perception2["group"]]
            record_efficiencies = [facts["battleBShift2"], facts["battleCShift1"]]
            trading = [
                (facts["shamare"] + facts["tradingControl"], metrics["tequila2"]),
                (facts["glasgowShift1"] + facts["tradingControl"], metrics["glasgow"])
            ]
        else:
            gold_efficiencies = [perception3["group"], facts["goldA"]]
            record_efficiencies = [facts["battleCShift2"], facts["battleA"]]
            trading = [
                (facts["glasgowShift2"], metrics["glasgow"]),
                (proviso_first_slot, metrics["proviso"])
            ]
        gold_produced = sum(12 * 60 / base_gold_minutes * (1 + efficiency + global_factory) for efficiency in gold_efficiencies)
        battle_exp = sum(12 * 60 / record_minutes * record_exp * (1 + efficiency + global_factory) for efficiency in record_efficiencies)
        natural_parts = [throughput(12, efficiency, order_metric) for efficiency, order_metric in trading]
        natural_gold = sum(part["gold"] for part in natural_parts)
        natural_lmd = sum(part["lmd"] for part in natural_parts)
        generated = generated_drones(game, mechanics, composition["shifts"][index], numeric_origins)
        available = drone_cursor + generated
        drone_part = drone_throughput(available, trading[0][1], drone_minutes)
        used = available
        drone_end = available - used
        consumed = natural_gold + drone_part["gold"]
        gold_end = gold_cursor + gold_produced - consumed
        if gold_cursor < -1e-9 or gold_end < -1e-9 or drone_cursor < -1e-9 or drone_end < -1e-9:
            fail(f"nonnegative ledger prefix violated in {shift_id}")
        ledger_entries.append({
            "shiftId": shift_id,
            "hours": 12,
            "gold": {"produced": rounded(gold_produced), "consumed": rounded(consumed), "net": rounded(gold_produced - consumed), "starting": rounded(gold_cursor), "ending": rounded(gold_end)},
            "battleRecordExp": rounded(battle_exp),
            "lmd": {"natural": rounded(natural_lmd), "drone": rounded(drone_part["lmd"]), "total": rounded(natural_lmd + drone_part["lmd"])},
            "drones": {"generated": rounded(generated), "starting": rounded(drone_cursor), "used": rounded(used), "ending": rounded(drone_end), "destination": "trading-post-1"},
            "trace": {"globalFactoryEfficiency": global_factory, "goldTeamEfficiencies": [rounded(x) for x in gold_efficiencies], "battleRecordTeamEfficiencies": [rounded(x) for x in record_efficiencies], "tradingPostEfficiencies": [rounded(x[0]) for x in trading]}
        })
        gold_cursor = gold_end
        drone_cursor = drone_end
        if index == 1:
            evaluation_gold_end = gold_cursor
    if abs(drone_cursor) > 1e-12:
        fail("drone 36h continuity/closure mismatch")
    shifts = ledger_entries[:2]
    totals = resource_totals(shifts, starting_gold, evaluation_gold_end)
    sustainability = build_sustainability(composition["shifts"], actor_groups, game, bundle)
    sustainability["resourceLedger"] = {
        "purpose": "sustainability-only",
        "cycleHours": sum(shift["hours"] for shift in composition["shifts"]),
        "initial": {"gold": rounded(starting_gold), "drones": ledger_entries[0]["drones"]["starting"]},
        "shiftBoundaries": [
            {"shiftId": shift_id, "startHour": index * composition["shiftHours"], "endHour": (index + 1) * composition["shiftHours"]}
            for index, shift_id in enumerate(SHIFT_IDS)
        ],
        "entries": ledger_entries,
        "final": {"gold": rounded(gold_cursor), "drones": ledger_entries[-1]["drones"]["ending"]},
        "returnsToInitialDrones": ledger_entries[-1]["drones"]["ending"] == ledger_entries[0]["drones"]["starting"]
    }
    sensitivity_hours = bundle["assumptions"][0]["diagnosticOnlySensitivity"]["shiftHours"]
    sensitivity_warmup = bundle["assumptions"][0]["primary"]["warmupHours"]["increased"]
    result = {
        "packetId": PACKET_ID,
        "confidence": "corroborated",
        "evaluationWindow": {"hours": 24, "shiftIds": SHIFT_IDS[:2], "start": {"mode": "source-relative", "shiftId": SHIFT_IDS[0]}},
        "fullRotationShiftOrder": SHIFT_IDS,
        "shift3ResourceContribution": None,
        "shifts": shifts,
        "totals24h": totals,
        "sustainability36h": sustainability,
        "trace": {
            "numericRuleOrigins": numeric_origins,
            "cyclicElapsedWorkPhase": cyclic_phase,
            "perceptionElapsedWorkCompromise": {
                "confidence": "corroborated",
                "sourceRosterGroupCSecondWorkSlot": {"shiftId": "groups-c-a", "elapsedWorkInterval": [12, 24]},
                "approvedBundleActiveShiftInput": {
                    "shiftId": "groups-c-a",
                    "elapsedWorkHours": bundle["assumptions"][1]["primary"]["activeShifts"]["groups-c-a"]["elapsedWorkHours"]
                },
                "resourceCalculationAuthority": "approved bundle v2 field, not operational cyclic phase"
            },
            "perceptionDormitoryOccupancyWitness": {
                "purpose": "concrete dormitory occupancy witness for bundle Perception Information active-shift inputs",
                "supportOnlyHelperIds": ["char_002_amiya", "char_2014_nian"]
            }
        },
        "primaryAssumptions": {
            "initialGold": 200,
            "initialGoldRationale": "fixed round operational inventory, selected before calculation and sufficient for every checked prefix",
            "droneAllocation": "all available drones in each cycle work slot to trading-post-1; shift3 is sustainability-only",
            "deterministicPhase1Approximations": [
                {
                    "id": "segment-average-high-value-order-distribution",
                    "confidence": "corroborated",
                    "explanation": "each 12-hour slot uses subsegment/piecewise expected throughput and its segment-average high-value-order distribution rather than event-level orders"
                },
                {
                    "id": "slot-level-drone-batch-to-trading-post-1",
                    "confidence": "corroborated",
                    "explanation": "each shift's continuously generated drones are represented as a slot-level batch allocated to trading-post-1"
                },
                {
                    "id": "slot-normalized-perception-elapsed-work",
                    "confidence": "corroborated",
                    "explanation": "source roster group C is operationally in cyclic slot [12,24) during groups-c-a, while approved bundle v2 intentionally supplies slot-normalized elapsedWorkHours=12 to both active group C shifts; resource computation uses the bundle field"
                }
            ]
        },
        "diagnosticOnlySensitivity": {
            "authority": "diagnostic-only-never-pass-fail",
            "perceptionGroupEfficiency": {"perceptionInfo10": rounded(perception3["group"]), "perceptionInfo20": rounded(perception2["group"])},
            "highValueAverageProgress": {f"{hours}h": rounded(average_progress(hours, sensitivity_warmup)) for hours in sensitivity_hours}
        }
    }
    validate_resource_ledger(result, composition["shifts"])
    return result


MANIFEST_FILES = [
    "README.md", "composition.json", "extract-jp-game-data.py", "reproduce.py",
    "wikiru-primary-extract-v1.json", "inputs/base-mechanics-2026-07.json",
    "inputs/jp-game-data-extract-v1.json", "inputs/phase1-project-assumption-bundle-v2.json",
    "inputs/wikiru-backup38-20260806.html", "output.json"
]


def make_manifest(root):
    files = []
    for relative in MANIFEST_FILES:
        data = (root / relative).read_bytes()
        files.append({"path": relative, "bytes": len(data), "sha256": sha256_bytes(data)})
    return {
        "schemaVersion": 1,
        "packetId": PACKET_ID,
        "confidence": "corroborated",
        "source": {
            "url": "https://arknights.wikiru.jp/?SandBox%2F%E5%9F%BA%E5%9C%B0%E3%82%B7%E3%83%95%E3%83%88%EF%BC%881%E6%97%A52%E5%9B%9E%E5%85%A5%E6%9B%BF%EF%BC%89",
            "backup": 38,
            "backupTimestamp": "2025-11-02 18:43:20 +0900",
            "referenceDate": "2026-08-06",
            "snapshotSha256": SNAPSHOT_SHA
        },
        "jpGameData": {"repository": "ArknightsAssets/ArknightsGamedata", "commit": GAME_COMMIT, "characterTablePath": "jp/gamedata/excel/character_table.json", "characterTableFullBlobContentSha256": CHARACTER_FULL_SHA, "buildingDataPath": "jp/gamedata/excel/building_data.json", "buildingDataFullBlobContentSha256": BUILDING_FULL_SHA, "extractSha256": GAME_EXTRACT_SHA},
        "assumptionBundle": {"id": "arknights-basement.phase1-project-assumptions", "version": 2, "contentSha256": BUNDLE_CONTENT_SHA, "allowedAssumptionIds": ALLOWED_ASSUMPTIONS},
        "files": files
    }


def serialized(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def checksum_bytes(manifest):
    return ("".join(f"{entry['sha256']}  {entry['path']}\n" for entry in manifest["files"])).encode("utf-8")


def verify_manifest(root):
    manifest = read_json(root / "manifest.json")
    expected_header = make_manifest(root)
    if manifest != expected_header:
        fail("manifest metadata/file hash mismatch")
    try:
        actual_checksums = (root / "checksums.sha256").read_bytes()
    except OSError as error:
        fail(f"missing checksums.sha256: {error}")
    if actual_checksums != checksum_bytes(manifest):
        fail("checksums.sha256 mismatch")
    return manifest


def execute(root, check):
    snapshot_text, game, mechanics, bundle = verify_fixed_inputs(root)
    validate_game_extract(game)
    validate_bundle(bundle)
    parsed_shifts, parsed_rows, actor_groups = parse_source_composition(snapshot_text, game)
    composition = validate_composition(root, parsed_shifts, parsed_rows)
    output = calculate_output(snapshot_text, game, mechanics, bundle, composition, actor_groups)
    output_bytes = serialized(output)
    if check:
        try:
            checked_output = (root / "output.json").read_bytes()
        except OSError as error:
            fail(f"missing saved output: {error}")
        try:
            saved_output = json.loads(checked_output)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            fail(f"cannot parse saved output: {error}")
        validate_sustainability(
            saved_output.get("sustainability36h", {}), composition["shifts"], actor_groups,
            bundle["assumptions"][2]["primary"], bundle["assumptions"][1]["primary"]["activeShifts"]
        )
        validate_resource_ledger(saved_output, composition["shifts"])
        if saved_output.get("trace", {}).get("cyclicElapsedWorkPhase") != output["trace"]["cyclicElapsedWorkPhase"]:
            fail("cyclic elapsed-work phase mismatch")
        if checked_output != output_bytes:
            fail("saved output is not byte-identical to reproduction")
        verify_manifest(root)
        print(f"verified {PACKET_ID}: 87 assignments, 29 active slots/shift, 24h output, 36h morale/resource closure")
    else:
        (root / "output.json").write_bytes(output_bytes)
        manifest = make_manifest(root)
        (root / "manifest.json").write_bytes(serialized(manifest))
        (root / "checksums.sha256").write_bytes(checksum_bytes(manifest))
        print(f"generated {PACKET_ID}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--packet-root", type=Path)
    args = parser.parse_args()
    root = (args.packet_root or Path(__file__).resolve().parent).resolve()
    try:
        execute(root, args.check)
    except EvidenceError as error:
        print(f"verification failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
