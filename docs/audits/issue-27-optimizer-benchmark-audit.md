# Issue #27 current deterministic optimizer benchmark re-audit

## 監査メタデータとscope

- 再監査日: 2026-08-07（Asia/Tokyo）
- 対象: accepted PR41 authorityを完全な基礎とするIssue #34の曲線平均blocker追補
- 制約: Issue #34のtime/morale曲線平均と監査証拠だけを変更し、composition search、plan数量計算、resource ledger、schedule state、UIを拡張しない

過去監査のbranch/baseや旧出力件数はcurrent authorityとして再利用しない。検証結果はrebase後に実行したコマンドから別途報告する。

## Observation authority

`src/lib/optimizerIssue27Audit.ts`は、regionとoptional explicit owned operator IDsから1個の`AppState`を構築する。ownership設定後、同じstateとchecked-in `operatorAvailabilitySnapshot`からactual owned region-available IDsをsnapshot順で読み戻す。

- actual owned IDsがregion snapshotの全IDと完全一致するときだけ`roster: { mode: "all-unlocked" }`とする。
- それ以外は`roster: { mode: "explicit", operatorIds: actualOwnedIds }`とする。
- callerがroster metadataを別途宣言するAPIはない。`generateAssignmentPlan`、metadata region、runtime availability commit、roster metadataは同じstate/snapshot境界から得る。
- availability snapshotに存在して軽量operator catalogに未収録のIDも、選択されたownershipとしてstateに保持する。optimizerはoperator recordのないIDを候補にしないが、metadataが実stateのownershipを隠さないようにする。
- JP/CN all-unlocked、Glasgow explicit、accepted Wikiru explicitを維持する。
- schedule fixtureを監査するときは、そのfixtureのstable group ID、ordered shift ID、明示境界、active/recovery group IDだけを`AppState.schedule`へ渡し、planが実際に返したschedule/assignmentを観測する。audit adapterとrunnerは同じeffective schedule authorityを使う。明示scheduleはそのままauthorityとし、accepted Wikiruはcanonical rotation witnessのexact worker-group count、stable group evidence、duplicate-free worker groups、全cycleを覆うusable durationが揃う場合に限り、duration累積境界とactive groupのexact complementとなるrecovery groupを決定的に導出する。fixture expected quantityやexpected assignmentは観測へコピーしない。
- `generateAssignmentPlan`はactual resource quantitiesを返さないため、observationの`resources`はmissingのままにする。

GLOBAL base mechanics observationは、checked-in fixture constantsを消費する`simulateFacilityProduction`、`simulateTradingPostDrones24h`、`evaluateSustainableCycle`のrepository内経路を診断する。これはchecked-in repository constantsの再現であり、独立した外部game truthの検証ではない。

## Accepted five-fixture authority

| fixture | contract / confidence | Gate | current authority |
|---|---|---:|---|
| `jp-243-factory-3group-2025-11` | legacy / `disputed` | non-gating | JP all-unlocked。12 factory assignmentsのoccupantはID化済みでremote supportは別表現。36h・3 shift scheduleをplanへ伝播するが、actual quantitiesと3-group composition searchは未解決 |
| `jp-glasgow-trading-125` | legacy / `disputed` | non-gating | JP Glasgow explicit。sourceの1x24h scheduleをplanへ伝播する。互換代替枠はlabel-onlyで、quantitiesはmissing |
| `cn-243-3shift-2026-06` | legacy / `disputed` | non-gating | CN all-unlocked。24h・3x8h scheduleをplanへ伝播する。57 source IDsのうち55はcomparable、2はsource-only。12h source commentとの衝突とworkshop/training解釈はdiagnosticのまま |
| `base-mechanics-2026-07` | legacy / `corroborated` | non-gating | checked-in formula valuesのrepository内diagnostic。独立外部検証ではない |
| `jp-wikiru-backup38-12h-v2` | `phase1-pass-fail-v1` / `corroborated` | gating | canonical SHA-256 pin、explicit roster、固定source、24h evaluation window、36h full-cycle witnessを保持する。witnessから36h・3 group・3x12h scheduleを導出したためIssue #33の36h expected対24h actual state mismatchは解消。current planはpair-active group compositionを生成せず、最初のfailureは`groups-a-b/control-center`のexpected operator IDsに対するactual missing。actual quantitiesもない |

`corroborated`を`confirmed`とは扱わない。legacy disputed fixturesとdiagnostic-only base mechanicsはaggregate pass/failをgateしない。source-only/reference conflict/disputed assignment、または未解決remote supportを含むfixtureをpass/fail eligibleへ昇格しない。

Current deterministic runner output:

```text
optimizer benchmarks: FAILED (passed=0 failed=1 not-run=0 non-gating=4 invalid=0)
NON-GATING jp-243-factory-3group-2025-11
NON-GATING jp-glasgow-trading-125
NON-GATING cn-243-3shift-2026-06
NON-GATING base-mechanics-2026-07
FAIL jp-wikiru-backup38-12h-v2 composition/search/groups-a-b/control-center: expected ["char_4179_monstr","char_2024_chyue","char_2015_dusk","char_2023_ling","char_4098_vvana"], actual missing
```

accepted Wikiruだけがcorroborated gating failureであり、4 legacy fixtureはnon-gatingのままである。

## PR40 source-evidence authority

- accepted Wikiru fixtureはcanonical content SHA-256で固定し、runtime provenanceとexplicit rosterのexact equalityを要求する。
- `evaluationWindow`は具体的な連続24時間（12h x 2 shifts）であり、`expected.output`はこの窓だけに対応する。
- `rotation`は36時間（12h x 3 shifts）のfull-cycle sustainability witnessであり、51 explicit operator IDs、各shiftの施設配置、operator states、gold/drone inventoryを保持する。
- identified remote supportはfacility occupantと別に所有・比較し、missing/wrong/duplicate/unexpected supportをexact pathで診断する。
- JP factory occupant IDs、CN source-only/conflict evidence、five-fixture gate modelを保持する。schedule-state統合によってlegacy fixtureをgatingへ昇格しない。
- composition comparisonはshift/facility/operator/supportの完全一致を要求する。未解決authorityでは`matchedComposition`を返さず、unexpected shift/facility/supportも診断する。

## Issue #33 schedule-state integration

共通schedule stateは`cycleHours`、stable group IDs、連続する明示境界を持つordered shifts、各shiftのactive/recovery group IDsを保持する。group数とshift数は独立であり、validatorはduplicate/unknown group、duplicate shift ID、gap、overlap、cycle外境界、未使用groupをrejectする。

runnerは明示scheduleまたはcomplete rotation witnessから得たeffective schedule authorityについて、shift配列位置ではなくstable shift IDでduration、start/end boundary、duplicate-free active/recovery group集合を常に比較する。wrong/missing/duplicate/extra group、boundary mismatch、missing/unexpected/duplicate shiftのいずれもstate-model errorとなり、gating caseをfailさせて`matchedComposition`を返さない。formatterとcross-category hierarchyはaccepted PR40のまま維持する。

accepted Wikiruのcanonical JSON自体には`fixture.schedule`を追加せず、SHA-256とsemantic pinを維持する。shared production authorityがvalidated rotation witnessからのみ、`groups-a-b` 0–12h（active A+B / recovery C）、`groups-b-c` 12–24h（active B+C / recovery A）、`groups-c-a` 24–36h（active A+C / recovery B）を導出し、audit用`AppState`とrunner gateの両方へ渡す。明示scheduleを持つlegacy fixtureは明示authorityを変更せず使い、group count、stable ID、duration coverageの証拠が不足するrotationはtyped incomplete authorityとしてdefault 24h scheduleに見せかけずfail closedとする。

これによりschedule state comparisonはcycle末の36hまで通過する。次のactual first mismatchはrunnerが報告した`composition/search/groups-a-b/control-center`で、expectedの5 operator IDsに対してactualはmissingである。fixture assignmentを観測へコピーしておらず、optimizerが生成できない第3 groupを含むrotation compositionは未解決のままである。canonical expected resource outputは連続24h evaluation windowに対する値である一方、schedule witnessは36h full cycleを表す。planはどちらのactual quantity ledgerも返さないため、resource observationは引き続きmissingである。

standalone sustainable-cycle evaluatorは可変shift数とcycle境界を受け取る一方、accepted PR38以降の次のauthorityを維持する。

- 資源はshift直下のstale `resourceLedger`ではなくfacility-owned `resourceContributions`から集約する。
- drone inventoryはshift indexごとのfractional generation、cap、prefix spend、cycle closureを検証する。
- power witness、gold prefix/carryover、morale/closureのfinite arithmetic、same-dorm exchange制約を維持する。
- operatorの非重複は同時occupancyについて検証し、時間が重ならないshift間の再利用は許容する。

## Issue #34 continuous curve integration

Issue #34のscopeでは、optimizerのtime/morale曲線平均を連続する端数時間へ対応させた。public helperの`averageEffectEfficiency`は1時間単位の区分一定値を、`averageMoraleCurveEfficiency`は消費体力閾値単位の区分一定値を、それぞれ実際の区間幅で加重平均する。cap/floor到達後も同じ連続区間モデルを保ち、不正なduration/rateは決定的に拒否する。

監査回帰はexpected fixture値をコピーせず、time curveの2時間を`(0.1 * 1 + 0.2 * 1) / 2 = 0.15`、2.5時間を`(0.1 * 1 + 0.2 * 1 + 0.3 * 0.5) / 2.5 = 0.18`、morale curveの2.5時間を`(0.3 * 2 + 0.2 * 0.5) / 2.5 = 0.28`として独立に手計算する。actual quantityのplan統合、composition search、resource ledger、schedule、standalone evaluatorはこのscopeでは変更しない。

## Remaining blockers

1. actual quantityとdrone ledgerはassignment planへ未統合で、resource observationはmissingである。
2. sustainable-cycle resultはplan/UIへ未統合である。
3. 36h scheduleを表現できても、optimizerが未生成の第3 groupを含むgroup assignmentやexternal-equivalent compositionの探索正しさは証明されない。現在のaccepted Wikiru観測ではpair-active shift assignmentがmissingである。
4. CN timing/source conflictsとsource-only mechanicsはnon-gating diagnosticのままである。

#28、Issue/GitHub state、production search、expected valuesはこのrebaseで変更していない。
