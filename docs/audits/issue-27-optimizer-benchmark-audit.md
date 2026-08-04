# Issue #27 current deterministic optimizer benchmark re-audit

## 監査メタデータとscope

- 再監査日: 2026-08-07（Asia/Tokyo）
- accepted stack parent（PR40 head）: `9cea2686467455b05a6b3c1ae8a757390ed1494e`
- 対象: accepted PR40 authorityへIssue #33のvariable schedule-state commitをsemantic rebaseした結果
- 制約: schedule state表現・保存・plan伝播・standalone evaluator対応だけを統合し、composition search、plan数量計算、UIデザイン、fixture expected outputを拡張しない

過去監査のbranch/baseや旧出力件数はcurrent authorityとして再利用しない。検証結果はrebase後に実行したコマンドから別途報告する。

## Observation authority

`src/lib/optimizerIssue27Audit.ts`は、regionとoptional explicit owned operator IDsから1個の`AppState`を構築する。ownership設定後、同じstateとchecked-in `operatorAvailabilitySnapshot`からactual owned region-available IDsをsnapshot順で読み戻す。

- actual owned IDsがregion snapshotの全IDと完全一致するときだけ`roster: { mode: "all-unlocked" }`とする。
- それ以外は`roster: { mode: "explicit", operatorIds: actualOwnedIds }`とする。
- callerがroster metadataを別途宣言するAPIはない。`generateAssignmentPlan`、metadata region、runtime availability commit、roster metadataは同じstate/snapshot境界から得る。
- availability snapshotに存在して軽量operator catalogに未収録のIDも、選択されたownershipとしてstateに保持する。optimizerはoperator recordのないIDを候補にしないが、metadataが実stateのownershipを隠さないようにする。
- JP/CN all-unlocked、Glasgow explicit、accepted Wikiru explicitを維持する。
- schedule fixtureを監査するときは、そのfixtureのstable group ID、ordered shift ID、明示境界、active/recovery group IDだけを`AppState.schedule`へ渡し、planが実際に返したschedule/assignmentを観測する。fixture expected quantityやexpected assignmentは観測へコピーしない。
- `generateAssignmentPlan`はactual resource quantitiesを返さないため、observationの`resources`はmissingのままにする。

GLOBAL base mechanics observationは、checked-in fixture constantsを消費する`simulateFacilityProduction`、`simulateTradingPostDrones24h`、`evaluateSustainableCycle`のrepository内経路を診断する。これはchecked-in repository constantsの再現であり、独立した外部game truthの検証ではない。

## Accepted five-fixture authority

| fixture | contract / confidence | Gate | current authority |
|---|---|---:|---|
| `jp-243-factory-3group-2025-11` | legacy / `disputed` | non-gating | JP all-unlocked。12 factory assignmentsのoccupantはID化済みでremote supportは別表現。36h・3 shift scheduleをplanへ伝播するが、actual quantitiesと3-group composition searchは未解決 |
| `jp-glasgow-trading-125` | legacy / `disputed` | non-gating | JP Glasgow explicit。sourceの1x24h scheduleをplanへ伝播する。互換代替枠はlabel-onlyで、quantitiesはmissing |
| `cn-243-3shift-2026-06` | legacy / `disputed` | non-gating | CN all-unlocked。24h・3x8h scheduleをplanへ伝播する。57 source IDsのうち55はcomparable、2はsource-only。12h source commentとの衝突とworkshop/training解釈はdiagnosticのまま |
| `base-mechanics-2026-07` | legacy / `corroborated` | non-gating | checked-in formula valuesのrepository内diagnostic。独立外部検証ではない |
| `jp-wikiru-backup38-12h-v2` | `phase1-pass-fail-v1` / `corroborated` | gating | canonical SHA-256 pin、explicit roster、固定source、24h evaluation window、36h full-cycle witnessを保持する。current planはlegacy-compatible 24h・2x12h scheduleでactual quantitiesもないため、最初のfailureは36h expected対24h actual |

`corroborated`を`confirmed`とは扱わない。legacy disputed fixturesとdiagnostic-only base mechanicsはaggregate pass/failをgateしない。source-only/reference conflict/disputed assignment、または未解決remote supportを含むfixtureをpass/fail eligibleへ昇格しない。

## PR40 source-evidence authority

- accepted Wikiru fixtureはcanonical content SHA-256で固定し、runtime provenanceとexplicit rosterのexact equalityを要求する。
- `evaluationWindow`は具体的な連続24時間（12h x 2 shifts）であり、`expected.output`はこの窓だけに対応する。
- `rotation`は36時間（12h x 3 shifts）のfull-cycle sustainability witnessであり、51 explicit operator IDs、各shiftの施設配置、operator states、gold/drone inventoryを保持する。
- identified remote supportはfacility occupantと別に所有・比較し、missing/wrong/duplicate/unexpected supportをexact pathで診断する。
- JP factory occupant IDs、CN source-only/conflict evidence、five-fixture gate modelを保持する。schedule-state統合によってlegacy fixtureをgatingへ昇格しない。
- composition comparisonはshift/facility/operator/supportの完全一致を要求する。未解決authorityでは`matchedComposition`を返さず、unexpected shift/facility/supportも診断する。

## Issue #33 schedule-state integration

共通schedule stateは`cycleHours`、stable group IDs、連続する明示境界を持つordered shifts、各shiftのactive/recovery group IDsを保持する。group数とshift数は独立であり、validatorはduplicate/unknown group、duplicate shift ID、gap、overlap、cycle外境界、未使用groupをrejectする。

runnerはschedule fixtureについて、shift配列位置ではなくstable shift IDでduration、start/end boundary、active/recovery group集合を比較する。state mismatchまたは未解決composition authorityがある場合は`matchedComposition`を返さない。formatterとcross-category hierarchyはaccepted PR40のまま維持する。

standalone sustainable-cycle evaluatorは可変shift数とcycle境界を受け取る一方、accepted PR38以降の次のauthorityを維持する。

- 資源はshift直下のstale `resourceLedger`ではなくfacility-owned `resourceContributions`から集約する。
- drone inventoryはshift indexごとのfractional generation、cap、prefix spend、cycle closureを検証する。
- power witness、gold prefix/carryover、morale/closureのfinite arithmetic、same-dorm exchange制約を維持する。
- operatorの非重複は同時occupancyについて検証し、時間が重ならないshift間の再利用は許容する。

## Remaining blockers

1. actual quantityとdrone ledgerはassignment planへ未統合で、resource observationはmissingである。
2. sustainable-cycle resultはplan/UIへ未統合である。
3. optimizerのfractional time/morale curve問題はschedule表現とは別scopeである。
4. scheduleを表現できても、未生成group assignmentやexternal-equivalent compositionの探索正しさは証明されない。
5. CN timing/source conflictsとsource-only mechanicsはnon-gating diagnosticのままである。

#28、Issue/GitHub state、production search、expected valuesはこのrebaseで変更していない。
