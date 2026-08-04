# Issue #27 現行オプティマイザー差分監査

## 監査メタデータ

- 実施日: 2026-08-04 (Asia/Tokyo)
- ブランチ: `codex/optimizer-accuracy-phase1`
- base SHA: `3959cb1acb0e80ac159f50e1c6756df287670bc0`
- 対象: Issue #31 region伝播後の作業ツリー（Issue #19〜#31の未コミット成果物を含む）
- 制約: Issue #31だけを実装し、region selector UI、生成データ、schedule/calculation/search、GitHub Issueを変更しない
- GitHub参照: Issue #12〜#17はGitHub connectorでread-only取得。Issue #31の`gh issue view 31`はネットワーク制限で失敗したため、依頼本文のacceptanceを実装契約として使用した

実行コマンド（すべてchecked-inのローカルbinary）:

```text
./node_modules/.bin/vitest run src/lib/optimizerBenchmark.test.ts src/lib/optimizerBenchmarkRunner.test.ts --reporter=verbose
./node_modules/.bin/vitest run src/lib/optimizerIssue27Audit.test.ts --reporter=verbose
./node_modules/.bin/vitest run src/lib/optimizer.test.ts --reporter=verbose -t "models unpromoted Jaye|models promoted Jaye|includes Gnosis|models high-value order probability|uses the beta curve|combines Tequila|models Pepe and Closure|separates Chain of Thought|counts active Rhine Tech|lets Highmore convert|applies dormitory recovery target|applies Perfumer|uses one full-morale Fiammetta|does not use Fiammetta"
./node_modules/.bin/vitest run src/lib/sustainableCycleEvaluator.test.ts --reporter=verbose -t "splits continuous recovery exactly|swaps morale at an explicit same-dorm event|rejects exchange when the source"
./node_modules/.bin/vitest run --reporter=verbose
./node_modules/.bin/tsc -b
./node_modules/.bin/vite build
node scripts/audit-base-skills.mjs
git diff --check
```

変更前のchecked-in runner suiteは14/14 passだった。ただし全fixtureを通すテストは`synthetic saved-reference observations`であり、fixtureの期待資源値をそのまま観測値へ複製するrunner plumbing testである。独立した現行実装監査ではないことがテスト内コメントにも明記されている。本監査ではこのpassを精度証拠に数えない。

## 現行実装観測の作り方

`src/lib/optimizerIssue27Audit.ts`はテスト/監査専用で、次の実コード経路だけを使用する。

- GLOBAL mechanics: `simulateFacilityProduction`、`simulateTradingPostDrones24h`、`evaluateSustainableCycle`の戻り値から15式を観測する。
- JP/CN roster: `operatorAvailabilitySnapshot`と`availableOperatorIds`を使用する。snapshotはJP 314人、CN 324人。
- optimizer構成/state: 地域別all-unlocked stateまたは明示rosterに`AppState.region`を設定して`generateAssignmentPlan`へ渡し、通常plan経路が返したrotation/assignmentだけを観測する。
- actual resources: `generateAssignmentPlan`が返さないため未設定のままにする。`expected.output`からの補完はしない。

GLOBAL calculatorは`base-mechanics-2026-07.json`の定数を直接importしている。そのためGLOBAL passは「fixtureと同じchecked-in定数を消費する実計算経路の回帰」であり、外部資料から独立した再検証ではない。

## Runner結果

```text
optimizer benchmarks: FAILED (passed=1 failed=2 not-run=0 non-gating=1 invalid=0)
FAIL jp-243-factory-3group-2025-11 rotation/state-model/cycleHours: expected 36, actual 24
NON-GATING jp-glasgow-trading-125
FAIL cn-243-3shift-2026-06 rotation/state-model/shifts/current-window-1/unexpected: expected absent, actual present
PASS base-mechanics-2026-07
```

旧`gameDataVersion`は削除した。資料版は`referenceProvenance.version`、実行roster境界は`runtimeDataProvenance.operatorAvailabilitySourceCommit`へ分離した。JP/CNのruntime commitはchecked-in `operatorAvailabilitySnapshot`と同じcommitとしてlike-for-likeで合格し、独立観測していないreference版はinformationalである。runtime commitをreference版へコピーして合格させてはいない。

| fixture | Gate | status | 最小再現と実数量 |
|---|---|---|---|
| `base-mechanics-2026-07` GLOBAL | gating | PASS | 15/15式が実calculator/evaluator経路で一致。上記の同一定数依存あり |
| `jp-243-factory-3group-2025-11` | gating | FAIL | runtime boundary一致。fixtureは36h・3 shifts、現行planは24h・2x12h。`goldProduced`と`battleRecordExp`はmissing |
| `jp-glasgow-trading-125` | non-gating (`disputed`) | NON-GATING | runtime boundary一致。reference-team 1x24hに対し現行planは2x12h。互換代替枠がlabel-only。`goldConsumed`と`lmd`はmissing |
| `cn-243-3shift-2026-06` | gating | FAIL | runtime boundary一致。fixtureは3x8h、現行planは2x12h。full-base編成は全shift label-only。3資源すべてmissing |

## 原因分類と証拠

| 分類 | 確度 | 診断 | コード/テスト証拠 |
|---|---|---|---|
| `source-data` | provenance mismatch resolved by #30 | fixtureの資料版とregional snapshot commitを別フィールドで保持し、runtime boundary同士だけを比較する | `referenceProvenance`; `runtimeDataProvenance.operatorAvailabilitySourceCommit`; `separates informational reference provenance from the proven runtime boundaries` |
| `state-model` | proven | 公開fixtureは3グループだが現行出力は固定2 window | `buildRotationWindows`は引数に関係なく2要素・各12h; `locks the smallest reproducible 3-group versus 2-window state mismatch`; 既存`uses a two-window rotation plan by default` |
| `calculation` | proven missing plan integration | actual-quantity/drone/sustainable-cycle evaluatorは存在するが`generateAssignmentPlan`の戻り値に計算結果がない | `confirms generated plans do not expose quantity or sustainable-cycle results`; resource diagnosticsはmissingであり0ではない。Appはこのplanを表示するためUIにも数量は渡らない |
| `calculation` | proven | optimizer側のtime/morale曲線平均は`Math.trunc(shiftHours)`で端数時間を捨てる。#23のcontinuous facility calculatorとは独立に残る | `averageEffectEfficiency`, `averageMoraleCurveEfficiency`; `confirms optimizer morale/time averaging still truncates fractional hours` |
| `reference` | proven limitation | label-only assignmentはoperator集合を同定できず、構成一致を証明できない | runnerの`reference composition is label-only and is not independently identified`; `keeps unavailable quantities missing and label-only compositions unproved` |
| `state-model` | resolved by #31 | `AppState.region`を保存・移行し、通常candidate/plan経路がregional snapshotで所有rosterを絞る | `AppState`; `propagates AppState region through the audit's normal plan path`; JP除外/CN許可回帰 |
| `search` | unresolved | 現行planと理論編成のoperator集合/同値出力を比較できないため、探索が候補を落とすかは証明不能 | label-only fixtureとmissing resource quantitiesが先行blocker |
| `interpretation` | unresolved globally | #12〜#17の個別テストはpassしたが、fixture全編成のスキル解釈はoperator ID不足で再検証不能 | 下記回帰表。unit passを外部証明とは扱わない |
| `reference` | unresolved | Glasgowは単一sourceの`disputed`、CN throughputは外部simulator由来の`corroborated`でゲーム内実測ではない | fixtureの`confidence`/`sources`/`notes` |

確認済みでない事項を`search`や`interpretation`の確定原因へ昇格させない。特に資源値missingを期待値0やfixture値で埋めない。

## Issue #12〜#17 回帰と#25 external-style再検証

focused optimizer実行結果は14 passed / 107 skipped、sustainable evaluatorは3 passed / 12 skippedだった。

| Issue | read-only取得したタイトル | 実行した既存テスト（すべてPASS） |
|---|---|---|
| #12 | ジェイの注文残数依存スキルを回収間隔込みでモデル化する | `models unpromoted Jaye from average empty order slots`; `models promoted Jaye's limit reduction and average stored orders separately`; `includes Gnosis's Karlan order-limit and efficiency modifiers in promoted Jaye's model` |
| #13 | 勤務時間で変動する高価値注文確率を12時間平均でモデル化する | `models high-value order probability over a 12-hour shift`; `uses the beta curve for mixed probability effects and stacks two alpha effects`; `combines Tequila's natural high-value bonus with probability effects` |
| #14 | 特別オーダー（ペペ／クロージャ）を期待値モデルへ追加する | `models Pepe and Closure fixed special orders with their speed rules` |
| #15 | 知覚情報の派生資源を施設・消費先ごとに分離する | `separates Chain of Thought from Soundless Resonance using actual dormitory occupancy` |
| #16 | 基地スキル系統の変換・発動数依存をモデル化する | `counts active Rhine Tech skills for Astgenne and Dorothy`; `lets Highmore convert Rhine Tech and Pinus skills into Standardization` |
| #17 | 条件付き宿舎回復と体力交換をローテーションへ反映する | `applies dormitory recovery target affiliation and operator conditions`; `applies Perfumer's extra recovery only at 20 morale or below`; `uses one full-morale Fiammetta swap per recovery shift`; `does not use Fiammetta as a full-morale swap source after she worked the shift` |

#25後の別evaluator経路でも次を再実行しPASSした。

- `splits continuous recovery exactly where a threshold modifier stops applying`
- `swaps morale at an explicit same-dorm event and limits each full source to one use`
- `rejects exchange when the source is not full, is outside the event dorm, or worked in the recovery interval`

これは現行optimizerテストとは別のtimeline evaluatorを通すexternal-style revalidationだが、同一repository内のsynthetic testであり、ゲーム内実測や独立外部実装による証明ではない。

## Gate順blocker

1. Gate B / reference: label-only assignmentsで理論operator構成を同定できない。
2. Gate B / state-model: 3グループcycleをAppState/plan/evaluatorが表現できない。
3. Gate C / calculation: fractional shiftのoptimizer曲線平均が不連続に切り捨てられる。
4. Gate C / calculation: actual quantityとdrone ledgerがplanへ未統合で、資源差分が計算不能。
5. Gate E / state-model+calculation: sustainable-cycle evaluatorがplanへ未統合で、回復・cycle closure・金属収支を理論編成について判定不能。
6. Gate D / search: 1〜5が解消するまで探索精度を数量/同値編成で判定不能。

## 承認用follow-up Issue案（7件、GitHub未作成）

以下7件をすべて別Issueとして承認・完了するまで#28を開始しない。#28自体は変更しない。

### 1. ベンチマーク参照版とruntimeデータ版のprovenanceを分離する（Issue #30で完了）

- 目的: fixture composition/source versionとoperator availability/game-data versionを別々に観測・診断する。
- Acceptance: runner metadataに両versionを保持し、JP/CN fixtureが文字列代用なしで決定的に比較される。既存source mismatchの扱いをテストする。
- Dependencies: #26。
- Out of scope: operatorデータ更新、計算修正、探索修正。
- Evidence: `metadata/reference-provenance/version`と`metadata/runtime-data-provenance/operatorAvailabilitySourceCommit`を別々に診断し、JP/CNの最小失敗はstate-modelへ進んだ。

### 2. benchmark regionをAppStateからoptimizerまで伝播する（Issue #31で完了）

- 目的: 監査adapterだけでなく通常のplan生成経路でJP/CN roster境界を保証する。
- Acceptance: regionを明示したstate/serialization/migrationを追加し、JP planがCN-only operatorを選ばない回帰を追加する。未指定時の互換動作を定義する。
- Dependencies: 1。
- Out of scope: UI検索改善、operatorデータ再生成、編成最適化。
- Evidence: `AppState.region`、JP既定のlegacy migration、export/import round-trip、通常candidate/planのJP除外/CN許可、監査の通常plan伝播テスト。

### 3. label-only benchmark編成をoperator ID付き参照へ昇格する

- 目的: JP factoryの一部とCN full-base全体についてcomposition/equivalent teamを機械比較可能にする。
- Acceptance: source commit/ページに紐づく全assignment ID、施設、shiftをfixtureへ追加し、地域availability検証を通す。解消不能箇所は`disputed`としてGateから外す。
- Dependencies: 1, 2。
- Out of scope: optimizer修正、期待資源値からoperatorを逆算すること。
- Evidence: runnerがlabel-only pathをinfoとして報告し、composition proof不能。

### 4. 3グループ循環をschedule stateとして表現する

- 目的: 「1日2回入替」と「2グループ」を分離し、36hのJP 3-groupと24hのCN 3-shiftを表現する。
- Acceptance: 可変group/shift境界とcycleHoursを型・plan・offline testで保持する。既存2x12hを互換ケースとして残す。同時重複を拒否する。
- Dependencies: 2, 3。
- Out of scope: 生産量計算、可変交代時刻探索、UIデザイン刷新。
- Evidence: fixture 3 groups対`buildRotationWindows`固定2 windows。

### 5. optimizerの時間/体力曲線を連続境界で平均する

- 目的: `Math.trunc(shiftHours)`依存を除き、端数境界・体力閾値をquantity evaluatorと一致させる。
- Acceptance: 2.5h等の端数、最初の1時間、morale step境界を解析/区分計算し、整数時間の既存値を維持する。
- Dependencies: 4。
- Out of scope: 探索枝、resource ledger統合、スキルデータ変更。
- Evidence: `confirms optimizer morale/time averaging still truncates fractional hours`。

### 6. actual quantity・drone ledgerをassignment planへ統合する

- 目的: `simulateFacilityProduction`と`simulateTradingPostDrones24h`を選択編成へ適用し、自然/ドローン別資源実数量を返す。
- Acceptance: gold produced/consumed、battle record EXP、LMD、drone contributionを期待値コピーなしでrunnerへ渡す。未対応特殊効果はmissing+reasonにし、0扱いしない。
- Dependencies: 1〜5。
- Out of scope: search最適化、UI内訳表示、期待値を観測値へ流用するrunner plumbing。
- Evidence: 現行plan/UIに両calculatorの呼出しがなく全resource diagnosticがmissing。

### 7. sustainable cycle判定をplan/benchmarkへ統合する

- 目的: 3-group scheduleの体力、宿舎slot、条件回復、交換、gold prefix、cycle closureを選択planについて判定する。
- Acceptance: #17/#25挙動を保持し、JP/CN scheduleを評価し、持続不能理由をmachine-readableにrunnerへ渡す。3-groupに対応する前に2-shift tupleを黙って流用しない。
- Dependencies: 2〜6。
- Out of scope: search tuning、GitHub #28変更、ゲーム内実測の代替。
- Evidence: standalone evaluatorはpassするが`generateAssignmentPlan`/UIへ未接続で、型も現在2 shifts固定。

## #28開始条件

#28は上記1〜7が承認・完了し、次がすべて満たされるまで開始不可とする。

- JP/CN reference/runtime provenanceとregionが通常plan経路で追跡できる（provenance分離は#30、regionの通常AppState伝播は#31で完了）。
- Gate対象fixtureのcompositionがoperator IDで比較できる。
- 3-group scheduleとcontinuous curveが表現・計算できる。
- actual resource/drone/sustainable outputsがmissingではなく実コードから得られる。
- その後に初めて、残るcomposition/resource差を`search`原因として最小再現する。

本監査ではproduction fix、Issue作成、#28変更を行っていない。

## 最終検証結果

- focused benchmark schema/runner: 2 files / 41 tests PASS（verbose）
- focused Issue #27 audit: 1 file / 7 tests PASS（verbose）
- all tests: 14 files / 310 tests PASS（verbose）
- focused #12〜#17: 14 PASS、107 filter skip
- focused #25 external-style: 3 PASS、12 filter skip
- TypeScript: `./node_modules/.bin/tsc -b` PASS
- Vite: `./node_modules/.bin/vite build` PASS
- base-skill audit: exit 0。324 operators / 598 skills / 607 effects、unclassified production effects 0、unmodeled production curves 0、morale descriptions without model 0
- `git diff --check`: PASS
