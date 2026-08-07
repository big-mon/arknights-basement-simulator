#!/usr/bin/env python3
"""Create the version-1 load-bearing JP game-data extract for this packet."""

import argparse
import hashlib
import json
from pathlib import Path

COMMIT = "7faf192d15eeac8b236c561a1938679f4642279e"
CHARACTER_SHA = "e5db4e916181700195397e67bf5fafd9897ebdd8961b6702a17985b8c61f463d"
BUILDING_SHA = "162f838e5e1cdd10cda98cd77ae9fc68931c48d8c3230952cdcce8670ebda6da"

OPERATOR_IDS = [
    "char_002_amiya", "char_010_chen", "char_107_liskam", "char_112_siege", "char_154_morgan",
    "char_159_peacok", "char_190_clour", "char_2014_nian", "char_2015_dusk",
    "char_2023_ling", "char_2024_chyue", "char_214_kafka", "char_237_gravel",
    "char_241_panda", "char_243_waaifu", "char_253_greyy", "char_254_vodfox",
    "char_300_phenxi", "char_308_swire", "char_332_archet", "char_336_folivo",
    "char_338_iris", "char_377_gdglow", "char_385_finlpp", "char_391_rosmon",
    "char_400_weedy", "char_4032_provs", "char_4047_pianst", "char_4054_malist",
    "char_4087_ines", "char_4098_vvana", "char_4106_bryota", "char_4110_delphn",
    "char_416_zumama", "char_4179_monstr", "char_420_flamtl", "char_430_fartth",
    "char_431_ashlok", "char_436_whispr", "char_446_aroma", "char_455_nothin",
    "char_473_mberry", "char_485_pallas", "char_486_takila", "char_496_wildmn",
    "char_1011_lava2", "char_1019_siege2", "char_1027_greyy2", "char_1039_thorn2",
    "char_1044_hsgma2", "char_1050_chen3"
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
KAFKA_E2_REFERENCE = "/chars/char_214_kafka/buffChar/0/buffData/1"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source_dir", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    character_path = args.source_dir / "character_table.json"
    building_path = args.source_dir / "building_data.json"
    if digest(character_path) != CHARACTER_SHA or digest(building_path) != BUILDING_SHA:
        raise SystemExit("full JP game-data source hash mismatch")
    characters = json.loads(character_path.read_text(encoding="utf-8"))
    building = json.loads(building_path.read_text(encoding="utf-8"))
    missing = [operator_id for operator_id in OPERATOR_IDS if operator_id not in characters]
    missing += [operator_id for operator_id in RESULT_BUFF_IDS if operator_id not in building["chars"]]
    missing += [buff_id for buff_id in ADDITIONAL_BUFF_DEFINITION_IDS if buff_id not in building["buffs"]]
    if missing:
        raise SystemExit(f"missing load-bearing rows: {missing}")
    kafka_e2_row = building["chars"]["char_214_kafka"]["buffChar"][0]["buffData"][1]
    if kafka_e2_row != {"buffId": "trade_ord_wt&cost[011]", "cond": {"phase": "PHASE_2", "level": 1}}:
        raise SystemExit("Kafka E2 source reference identity mismatch")
    character_rows = {
        operator_id: {
            "name": characters[operator_id]["name"],
            "profession": characters[operator_id]["profession"],
            "rarity": characters[operator_id]["rarity"],
            "isNotObtainable": characters[operator_id]["isNotObtainable"]
        }
        for operator_id in OPERATOR_IDS
    }
    building_rows = {}
    for operator_id, selected_buff_ids in RESULT_BUFF_IDS.items():
        source_row = building["chars"][operator_id]
        source_buffs = {
            buff["buffId"]: buff
            for phase in source_row["buffChar"]
            for buff in phase.get("buffData", [])
        }
        absent = [buff_id for buff_id in selected_buff_ids if buff_id not in source_buffs or buff_id not in building["buffs"]]
        if absent:
            raise SystemExit(f"missing result-affecting buff rows for {operator_id}: {absent}")
        building_rows[operator_id] = {
            "charId": source_row["charId"],
            "maxManpower": source_row["maxManpower"],
            "buffChar": [{"buffData": [source_buffs[buff_id] for buff_id in selected_buff_ids]}]
        }
    buff_ids = sorted(
        {buff_id for buff_ids in RESULT_BUFF_IDS.values() for buff_id in buff_ids}
        | set(ADDITIONAL_BUFF_DEFINITION_IDS)
    )
    extract = {
        "schemaVersion": 1,
        "source": {
            "repository": "ArknightsAssets/ArknightsGamedata",
            "commit": COMMIT,
            "characterTable": {
                "path": "jp/gamedata/excel/character_table.json",
                "fullBlobContentSha256": CHARACTER_SHA
            },
            "buildingData": {
                "path": "jp/gamedata/excel/building_data.json",
                "fullBlobContentSha256": BUILDING_SHA
            }
        },
        "rowIdentity": {
            "characterTable": [f"/{operator_id}" for operator_id in OPERATOR_IDS],
            "buildingChars": [f"/chars/{operator_id}" for operator_id in RESULT_BUFF_IDS],
            "buildingBuffs": [f"/buffs/{buff_id}" for buff_id in buff_ids],
            "kafkaE2UnlockedBuffReference": KAFKA_E2_REFERENCE
        },
        "characters": character_rows,
        "buildingChars": building_rows,
        "buildingBuffs": {buff_id: building["buffs"][buff_id] for buff_id in buff_ids}
    }
    args.output.write_text(json.dumps(extract, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
