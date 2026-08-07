# Wikiru backup 38, 12-hour v2 evidence packet

This is the offline JP Phase 1 evidence packet for Issue #50. Its pass/fail confidence is exactly `corroborated`. It evaluates the first two slots (`groups-a-b`, `groups-b-c`) of the ordered 36-hour cycle. `groups-c-a` is stored only in an independent sustainability resource ledger and never contributes to `shifts` or `totals24h`.

## Pinned sources

- Composition source URL: `https://arknights.wikiru.jp/?SandBox%2F%E5%9F%BA%E5%9C%B0%E3%82%B7%E3%83%95%E3%83%88%EF%BC%881%E6%97%A52%E5%9B%9E%E5%85%A5%E6%9B%BF%EF%BC%89`
- Wikiru source fact: backup `38`, timestamp `2025-11-02 18:43:20 +0900`; preserved/reference date `2026-08-06`; raw snapshot SHA-256 `33b7f7d08f5249b0d93efad441ef1dd7ec95d7e5939fdda7e02c9625d9cb45a8`.
- JP game data: repository `ArknightsAssets/ArknightsGamedata`, commit `7faf192d15eeac8b236c561a1938679f4642279e`, paths `jp/gamedata/excel/building_data.json` and `jp/gamedata/excel/character_table.json`, full blob-content SHA-256 values `162f838e5e1cdd10cda98cd77ae9fc68931c48d8c3230952cdcce8670ebda6da` and `e5db4e916181700195397e67bf5fafd9897ebdd8961b6702a17985b8c61f463d` respectively.
- Project assumption: packet-pinned bundle v2 bytes in `inputs/phase1-project-assumption-bundle-v2.json`; ID `arknights-basement.phase1-project-assumptions`, integer version `2`, file SHA-256 `8a8e03596fda0f77cf4169914126a48d3abd8d27e1518a4d76fce4e374567edf`, content SHA-256 `5aca766b23d7eabfbb924d460b878d07351c5377ec0007ee12194de7fe1565ba`.

`inputs/wikiru-backup38-20260806.html` preserves the source bytes. `wikiru-primary-extract-v1.json` records the target table rows, source colors, stable A/B/C mapping, room identity, names, and canonical IDs. The verifier reparses the pinned HTML and compares every one of the 87 assignments, so the extract and `composition.json` cannot certify themselves.

`inputs/jp-game-data-extract-v1.json` is a deterministic, versioned load-bearing extract rather than a copy of the roughly 25 MB source inputs. It records the source commit/path/full hashes and JSON-pointer row identities. Its character rows are limited to the 51 actors used by source mapping or the sustainability witness. Its building rows are limited to buffs whose parsed descriptions/fields directly affect the reproduced numeric result, plus the ticket-named parallel beta definition; unrelated unlocked buffs are deliberately excluded. Kafka's E2 row actually references `trade_ord_wt&cost[011]`, while the parallel beta definition named by the ticket is `trade_ord_wt&cost[010]`. The reproducer records and checks both identities and requires their result semantics and stable fields to agree; the canonical assumption level is derived from Kafka's unlocked `[011]` description. Recreate those exact bytes from verified full files with:

```sh
python3 extract-jp-game-data.py /path/to/jp/gamedata/excel inputs/jp-game-data-extract-v1.json
```

## Source facts and project assumptions

Source facts are the exact room/operator/color table, the 12-hour/three-slot cycle text, the displayed team efficiencies and durations, and the operator/building rows in the pinned JP extract. Base mechanics come from the preserved `base-mechanics-2026-07.json`. The high-value-order time curve, perception-information calculation, and signed equivalent morale abstraction are project assumptions and are read only from the pinned bundle v2. The fixed Shamare/Kafka/Tequila team and Kafka's pinned JP E2/unlocked Japanese description mechanically select the bundle's canonical `increased` level; that selection is not inferred from output values or calibration. Production group C is inactive in `groups-a-b`; approved bundle v2 supplies Perception Information 20 and slot-normalized elapsed work 12 hours in `groups-b-c`, and Perception Information 10 and slot-normalized elapsed work 12 hours in `groups-c-a`.

The elapsed-work phase is cyclic, not reset at the saved 24-hour window. Group A's `groups-a-b` slot is its second continuous slot, so the pinned Proviso curve is integrated over `[12,24)`: `4h * 120% + 8h * (135% + 3%)`, giving `132%`. Its `groups-c-a` slot is the first `[0,12)` segment at `120%`. Group B retains `[0,12)` then `[12,24)` for Scene and Shamare/Kafka/Tequila; group C uses `groups-b-c` as its first slot and `groups-c-a` as its second for Perception, Glasgow, and Red-Pine.

Three deterministic Phase 1 compromises are explicit here, each with confidence `corroborated` (not confirmed): 12-hour slots use subsegments and piecewise expected throughput, including a segment-average high-value-order distribution, rather than event-level orders; continuously generated drones are represented as a slot-level batch allocated to `trading-post-1`; and although source roster group C's latter work period is the cyclic second slot `[12,24)` in `groups-c-a`, approved bundle v2 intentionally supplies slot-normalized `elapsedWorkHours=12` to both active group C shifts. Resource computation uses that bundle field, not the operational cyclic phase. The third-shift resource entry is sustainability-only.

The sustainability trace identifies `char_002_amiya` and `char_2014_nian` as recovery/support-only helpers. They occupy dormitory slots only in `groups-b-c`, are idle with zero morale delta in the other shifts, and exist solely to make the saved concrete dormitory occupancy witness equal the bundle Perception Information active input of 20; they do not affect resource totals.

The fixed initial gold inventory is 200: a round operational input selected independently before calculation, not a value fitted to the output. Gold and drone continuity are checked across all three work slots; the final gold inventory may differ from the initial inventory, while drones must return to their initial value. Every shift uses all available drones only at `trading-post-1`; in shift 3 that destination is the Glasgow team. Sensitivity values are stored separately under `diagnosticOnlySensitivity` and never affect the primary output.

## Reproduce and verify

Generation deterministically replaces only `output.json`, `manifest.json`, and `checksums.sha256`:

```sh
python3 reproduce.py
```

Read-only verification checks pinned source hashes, independent HTML extraction, canonical-ID mapping, exact capacities and assignments, cyclic elapsed-work phases, the separate three-entry sustainability resource ledger, strict 24-hour exclusion of shift 3, actor-by-actor 36-hour state transitions, saved output bytes, manifest hashes, and checksum bytes:

```sh
python3 reproduce.py --check
```

The verifier also accepts `--packet-root PATH`. The public test uses that seam to mutate a temporary copy, reseal all mutable hashes, and demonstrate that source identity changes, Kafka semantic-level selection, shift-3 leakage into the 24-hour benchmark, cyclic phase changes, and sustainability morale, resource, dormitory-slot, and reciprocal-exchange changes fail closed.
