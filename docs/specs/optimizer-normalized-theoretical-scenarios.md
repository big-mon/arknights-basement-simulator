# Optimizer Normalized-Theoretical Support Scenario 実装仕様書

## 文書情報

- 状態: 承認済み仕様
- 対象: Phase 1のJP benchmark採点・composition search前提
- 主対象地域: JP
- 副対象地域: CN（non-gating）
- 関係: Phase 1精度改善仕様を置換せず、固定support scenarioの契約を補足する

## Problem Statement

JP factory benchmarkは、公開された24時間生産量を厳密なgolden valueとして扱っている。しかし、その値の一部はfactory外のsupport operatorへ依存する。特にPerception Information teamの公開効率は、事務室、制御中枢、宿舎人数、operator morale閾値を含む複数support phaseの平均である。現fixtureはfactory rotationを記録しているが、support phaseを完全には記録していない。

すべてのsupport facility、morale遷移、回復scheduleを完全simulationすることは、Phase 1の目的に対して複雑すぎる。一方、公開されたteam効率を特定factory teamへ直接割り当てると、composition searchをreferenceへ誘導し、代替teamや限定所持rosterへ一般化できない。

したがってbenchmarkは、再現可能なnormalized-theoretical scenarioと完全な実ゲームsimulationを区別しなければならない。所有、地域availability、施設capacity、operator conflict、production formula、composition searchは通常optimizer経路に残し、明示的に文書化した複雑なsupport変数だけをshift内で一定にできる必要がある。

また、現在の作業にはsource-backed factory計算修正、support scenario state、composition searchという3つの責務が混在している。これらはIssue #28へまとめず、依存順に分離して提供する。

## Solution

optimizerへoptionalかつ一般的なsupport-resource scenario inputを追加する。scenarioは明示したschedule windowへ固定resource contributionを与え、source operatorとsource facilityを識別する。optimizerはsource operatorの所有と地域availabilityを検証し、operatorとfacility slotを予約し、同時再利用を防ぎ、寄与をplan evidenceへ記録する。将来のscenarioがより詳細なmodelを選択しない限り、sourceのwindow内morale遷移はsimulationしない。

JP benchmarkは`normalized-theoretical` benchmarkとする。36時間・3 group scheduleの自然生産を24時間へ正規化する。ドローン、在庫停止、操作遅延、実在庫差分は除外する。離散的なscenario assumptionはexactとし、公開されたGold・EXP集計値は丸めと正規化を考慮して相対±0.1%で比較する。

benchmarkは通常のoperator skill計算、candidate生成、global conflict処理、resource ledger評価、benchmark比較を通る。expected outputまたはreference team IDをproduction scoringへ渡してはならない。reference compositionまたは機械的なoutput-equivalent compositionを受け入れる。実用探索はglobal optimality未証明でも合格できるが、not-certifiedを明示する。

JPをPhase 1のgating regionとする。CNはsource timing、runtime roster、assignment conflictが独立に解決されるまでsecondary/non-gatingとする。

## User Stories

1. optimizer利用者として、benchmarkがnormalized-theoretical outputであると分かるようにしたい。実ゲーム在庫差分と誤認しないためである。
2. optimizer利用者として、browser実用時間内で有用なcompositionを得たい。
3. optimizer利用者として、未証明探索をnot-certifiedと表示してほしい。global optimumと誤認しないためである。
4. benchmark保守者として、複雑なcross-facility resourceを明示的なscenario inputにしたい。前提をreview・再現できるためである。
5. benchmark保守者として、固定resourceをsource operator、region、facility、shift、amount、provenanceへ紐づけたい。説明不能なmagic numberを防ぐためである。
6. benchmark保守者として、外部集計値を明示的な許容差で比較したい。公開値の丸めでgateが失敗しないためである。
7. benchmark保守者として、所有、地域、slot、conflictはexactに検証したい。数値許容差で不正planを隠さないためである。
8. 限定所持利用者として、未所持support operatorの固定寄与を無効にしたい。所有していないsupportを使用しないためである。
9. JP利用者として、CN-only operatorをrotating teamとfixed supportの両方から除外したい。
10. reviewerとして、source/data・計算修正、scenario model、searchを分離したい。責務単位でreviewできるためである。
11. reviewerとして、expected outputをcandidate scoringから除外したい。fixture copyingではなく通常計算と探索を検証するためである。
12. reviewerとして、reference operator IDを比較・test diagnosticだけに使用したい。production searchを一般化するためである。
13. reviewerとして、missing/invalid support sourceをtyped diagnosticにしたい。unsupported caseを0またはpartial successにしないためである。
14. reviewerとして、すべてのproduction facilityとschedule dimensionが埋まるまで合格させたくない。empty-plan false greenを防ぐためである。
15. model保守者として、fixed contributionをplan evidenceへexactly once記録したい。scoreとledgerの二重計上を防ぐためである。
16. model保守者として、入力順序に依存しない決定的な結果を得たい。
17. 将来のsimulator開発者として、fixed scenario契約をoptionalかつ一般的にしたい。exact support simulatorへ段階的に置換できるためである。
18. CN benchmark保守者として、未解決CN assumptionをnon-gating diagnosticとして残したい。JP進捗のためにCN値を捏造しないためである。
19. project保守者として、現experimental dirty workを保全しながらclean issue branchを再構成したい。有用なtestや探索知見を失わず、混在差分をshipしないためである。
20. project保守者として、各前提とsearchをStacked Issue/PRで提供したい。依存順を明示するためである。

## Implementation Decisions

### Benchmark contract

- benchmark targetは`normalized-theoretical`であり、完全なgameplay reproductionではない。
- canonical cycleが36時間でも自然生産を24時間へ正規化する。
- JP factory gateからドローン、在庫停止、回収timing、操作遅延、実在庫差分を除外する。
- JPはgating、CNはsecondary/non-gatingとする。
- 外部Gold・EXP集計値は相対±0.1%で比較する。
- source、schedule、ownership、region、capacity、conflictの離散条件はexactとする。

### Optional support-resource scenario

- optimizerはoptionalなsupport-resource scenarioを受け取る。未指定時の通常App動作は変えない。
- Phase 1ではscenario UIを追加しない。
- fixed sourceはschedule window、source operator、source facility、resource、amount、provenanceを識別する。
- sourceはoperatorがowned、regionally available、対象facilityへ配置可能、他で同時予約されていない場合だけ有効になる。
- window内moraleをsimulationしない場合も、sourceは実operatorとfacility capacityを予約する。
- invalid/unresolved sourceはtyped diagnosticを返す。0へ黙って変換せず、complete benchmark resultを許可しない。
- fixed contributionはscoring contextとplan resource evidenceへexactly once現れる。
- scenarioは一般optimizer inputであり、preferred production teamまたはexpected outputを識別しない。

### JP normalized scenario

- canonical scheduleは36時間cycleの3×12時間windowであり、各windowで2 production groupがactiveになる。
- 関連cross-facility計算のdormitory occupancyを20へ固定する。
- `groups-a-b`ではWhisperainをPerception Information production groupのoffice support sourceとする。
- officeはLevel 2、recruitment slot 3とし、initial slotを除く2 slotからPerception Information `+20`をwindow内固定で与える。
- `groups-b-c`ではDuskを同production groupのControl Center support sourceとし、Perception Information `+10`をwindow内固定で与える。
- Duskのwindow内morale閾値はPhase 1では積分しない。`+10`固定が明示的な簡略化である。
- Iris/Czernyの詳細resource chainはこのfactory benchmarkで展開しない。他scenarioに対する0とは推定せず、scope外として記録する。
- Flametail、Viviana、Greyy the Lightningbearer等のremote/static prerequisiteも、同じ一般source契約またはsource-backed通常mechanicsによりoperatorとfacility capacityを予約する。

### Factory calculation prerequisites

- skill textで保証される場合、automation型skillが通常teammate efficiencyを抑制しても、facility-count由来factory productivityは有効なままにする。
- Metalwork skill-family metadataを明示し、operator-name判定ではなく通常metadataからfamily-sensitive effectを評価する。
- calculation fixをscenario supportおよびcomposition searchより先に完了・検証する。

### Search semantics

- production searchへfixture expected outputまたはpreferred composition IDを渡さない。
- documented reference/equivalent compositionまたはbenchmark tolerance内のoutput equivalenceでcomposition acceptanceを合格にできる。
- completeかつ全dimensionが埋まったplanを必須とする。partial/empty planは失敗する。
- exhaustive proofが可能なsmall searchだけcertifiedにできる。
- 未証明frontierをpruneしたsearchは`composition-search-not-certified`または同等に具体的なtyped diagnosticを返す。
- runtime内でvalid reference/equivalent planを得た場合、certification不足だけを理由に実用benchmarkを失敗させない。
- user-facing/API上、uncertified planをproven optimumと呼ばない。
- repository benchmark環境でJP plan generationを10秒未満にする。境界ぎりぎりではなく余裕を確保する。

### Dependency and worktree strategy

依存順:

1. Issue #36 plan sustainability（既存parent）
2. 新規前提A: JP factory skill metadata・suppression計算
3. 新規前提B: fixed support-resource scenario
4. Issue #28: global composition search
5. Issue #29: constrained-roster acceptance

現experimental dirty branchとstashは保全する。accepted predecessorからclean worktreeを作り、有用なtest・search improvementだけを責務に応じて回収する。experimental full office simulationやUI変更はdirty差分に存在することを理由にshipしない。

## Testing Decisions

### Test方針

testは外部から意味のあるbehaviorを検証する。team mechanics、scenario activation/reservation、complete plan output、resource ledger、diagnostic、determinism、runtimeを対象とし、private helperのcall countや内部container構造を固定しない。expected benchmark outputをobserved plan構築へ使用してはならない。

### Primary acceptance seam

checked-in fixtureをbenchmark state構築、通常assignment plan生成、plan resource evaluation、batch benchmark comparisonへ通し、次を確認する。

- JP caseがgatingかつpassed
- planがcompleteで全production dimensionが埋まる
- reference/equivalent compositionまたはoutput equivalenceを満たす
- Gold・EXPが相対±0.1%以内
- fixed support sourceがownership、region、slot、conflictを満たす
- missing supportがpartial successにならない
- uncertified resultにtyped diagnosticがある
- 入力順序を変えてもmaterial resultが同じ
- 10秒未満

### Focused prerequisite A seam

実operator teamを通常candidate/team calculation境界で評価し、次をexact確認する。

- sourceで保証されたfacility-count productivityがsuppression後も有効
- Purestream/Weedy/Eunectes teamのdocumented calculation
- Metalwork family metadata
- VivianaとMetalwork teamのdocumented interaction
- operator-name/fixture-ID special caseがない

### Focused prerequisite B seam

optional scenarioあり/なしのplan生成で次を確認する。

- fixed resourceが指定windowだけで有効
- source operatorとfacility slotが予約される
- unowned/region-unavailable sourceがtyped unresolvedになる
- simultaneous reuseを拒否する
- scoreとplan evidenceへexactly once反映する
- scenario未指定時に通常App behaviorを維持する
- scenario input順序がoutputを変えない

### Focused Issue #28 seam

synthetic conflict searchで次を確認する。

- 旧fixed candidate limitより後ろの既知best optionを到達可能にする
- 旧beamが失ったglobal combinationを到達可能にする
- dependency-derived support/team変更がcoordinate-descent basinを越える
- pruningがnon-certificationを報告する
- infeasible dimensionがpartial selectionを返さない
- deterministic ordering/tie-breakを維持する

### Validation suite

各Issueでfocused tests、TypeScript compilation、関連optimizer/benchmark/resource/sustainability tests、full Vitest、production build、base-skill audit、diff validationを実行する。testはchecked-in dataを使い、mutable external sourceを取得しない。

## Out of Scope

- ゲーム内24時間ログとの厳密一致
- JP normalized scenarioにおけるDusk morale閾値の連続simulation
- office、Control Center、dormitory、workshop、training room rotationの完全最適化
- office/scenario設定UI
- CNのPhase 1 strict gate化
- CN timing、source-only roster、workshop/training conflictの解決
- 153 layout
- 可変shift boundary探索
- 実用JP benchmarkへのglobal-optimality proof必須化
- team固有production-efficiency override
- test実行中のexternal data取得
- preserved dirty worktreeに存在することだけを理由としたexperimental full-office implementationのship

## Further Notes

公開JP aggregateはnormalized comparison targetとして有用だが、exact gameplay outputの証明ではない。fixed scenario値はprovenanceを持つ明示的assumptionであり、将来exact support simulatorへ置換できる。置換時も一般optimizer input境界を維持し、同じhighest-level benchmark seamで影響を証明する。

本仕様書だけではcommit、push、Pull Request、merge、deploy、GitHub Issue作成を承認しない。
