# Issue #27 current deterministic optimizer benchmark re-audit

## 監査メタデータとscope

- 再監査日: 2026-08-07（Asia/Tokyo）
- accepted fixture parent head: `20f25f757a97dbb76bf71b93f8af71d0155d7be9`
- PR #39 rebase前local head: `b332ebcb3003dd502ea66fbf29eccb572de017f5`
- 対象: accepted PR39 re-audit worktreeをauthority baselineとし、PR40の固定source evidenceだけを追補した結果
- 制約: production optimizer修正、fixture expected-valueのobservationへのコピー、Issue #28 mutation、install、commit、push、GitHub mutationは行わない。成功したnetwork accessは使用しない

過去監査のbranch/base、未コミット成果物、network試行に関する記述はcurrent scopeの根拠にせず、この文書内のSHAはaccepted PR39 baselineの識別にだけ使用する。

## Observation authority

`src/lib/optimizerIssue27Audit.ts`は、regionとoptional explicit owned operator IDsから1個の`AppState`を構築する。ownership設定後、同じstateとchecked-in `operatorAvailabilitySnapshot`からactual owned region-available IDsをsnapshot順で読み戻す。

- actual owned IDsがregion snapshotの全IDと完全一致するときだけ`roster: { mode: "all-unlocked" }`とする。
- それ以外は`roster: { mode: "explicit", operatorIds: actualOwnedIds }`とする。
- callerがroster metadataを別途宣言するAPIはない。`generateAssignmentPlan`、metadata region、runtime availability commit、roster metadataは同じstate/snapshot境界から得る。
- availability snapshotに存在して軽量operator catalogに未収録のIDも、選択されたownershipとしてstateに保持する。optimizerはoperator recordのないIDを候補にしないが、metadataが実stateのownershipを隠さないようにする。
- JP/CN all-unlocked、Glasgow explicit、accepted Wikiru explicitを維持する。
- `generateAssignmentPlan`はactual resource quantitiesを返さないため、observationの`resources`はmissingのままにする。fixtureの`expected.output`はコピーしない。
- label-only compositionはoperator ID集合を同定できないためunprovedのままにする。

GLOBAL base mechanics observationは、checked-in fixture constantsを消費する`simulateFacilityProduction`、`simulateTradingPostDrones24h`、`evaluateSustainableCycle`のrepository内経路を診断する。これはchecked-in repository constantsの再現であり、独立した外部game truthの検証ではない。

## Current deterministic result

```text
optimizer benchmarks: FAILED (passed=0 failed=1 not-run=0 non-gating=4 invalid=0)
NON-GATING jp-243-factory-3group-2025-11
NON-GATING jp-glasgow-trading-125
NON-GATING cn-243-3shift-2026-06
NON-GATING base-mechanics-2026-07
FAIL jp-wikiru-backup38-12h-v2 rotation/state-model/cycleHours: expected 36, actual 24
```

CompatibilityはGREENではない。aggregateは`FAILED`である。5 fixtureのcurrent statusは次のとおり。

| fixture | contract / confidence | Gate | current observation |
|---|---|---:|---|
| `jp-243-factory-3group-2025-11` | legacy / `disputed` | non-gating | JP all-unlocked。12 factory assignmentsのoccupantはID化済みでremote supportは別表現。referenceは36h・3 shifts、planは24h・2 windows。quantities missing |
| `jp-glasgow-trading-125` | legacy / `disputed` | non-gating | JP Glasgow explicit。referenceは1x24h、planは2x12h。quantities missing |
| `cn-243-3shift-2026-06` | legacy / `disputed` | non-gating | CN all-unlocked。57 source namesは全てaccepted regional snapshot内。軽量runtime catalogにない2 IDはsource-only。12h source commentと3x8h benchmarkが衝突し、workshop/training assignmentも曖昧。planは2x12h、quantities missing |
| `base-mechanics-2026-07` | legacy / `corroborated` | non-gating | 15 checked-in formula valuesのrepository内diagnostic。独立外部検証ではない |
| `jp-wikiru-backup38-12h-v2` | `phase1-pass-fail-v1` / `corroborated` | gating, FAIL | JP explicit。metadata boundary一致後、最初のfailureはfull rotation `cycleHours`: expected 36、plan 24。quantities missing |

`corroborated`を`confirmed`とは扱わない。legacy disputed fixturesとdiagnostic-only base mechanicsはaggregate pass/failをgateしない。accepted fixtureだけがgatingであり、そのfailureによりaggregateは`FAILED`となる。

## PR40 source-evidence integration scope

PR40の固定source evidenceは、accepted five-fixture gate modelを変更せずlegacy fixtureの参照構成を具体化する。

- JP factoryは全occupantをoperator IDで保持し、Viviana/Flametailと未解決のWhisperainをfacility slot外のremote supportとして分離する。
- CN fixed config/operator poolの57 source namesをID化する。全IDはaccepted CN regional snapshotに存在する一方、`char_1052_kalts2`と`char_4133_logos`は軽量operator catalogに未収録のためsource-onlyとしてrunnable composition matchingから除外する。
- CN config commentの12h/queueとbenchmarkの3x8h、およびworkshop/trainingの重複配置解釈はmachine-readable conflict/disputed evidenceとして保持する。
- この追加証拠はlegacy fixtureをgatingへ昇格せず、accepted Wikiru fixtureのcanonical authority、runtime equality、24h evaluation window、36h full-cycle contractを変更しない。search correctnessやexternal game truthも主張しない。

## Accepted fixture: 24h output windowと36h sustainability witness

`jp-wikiru-backup38-12h-v2`は次の2つの時間境界を意図的に分けている。

- `evaluationWindow`: 24h、12h x 2 shifts、`groups-a-b`と`groups-b-c`。`expected.output`のresource quantitiesはこのconcrete 24-hour windowに対応する。
- full rotation: 36h、12h x 3 shifts、`groups-a-b`、`groups-b-c`、`groups-c-a`。51 explicit operator IDs、各shift 12施設・29配置、operator stateとgold/drone ledgerを含むsustainability witnessである。

current plan observationは24h・2 windows (`current-window-1`, `current-window-2`)だけで、actual quantitiesを持たない。したがって、24h expected resource outputとの数量比較も、36h full-cycleのoperator state/resource equalityとcycle closureも証明できない。accepted compositionはlabel-onlyではないが、current planは2-windowかつ別のshift/facility identityであり、36hの3-shift composition equalityを成立させられない。

## 原因のauthorityと分類

runnerの通常mismatchは`certainty: "suspected"`のままにする。`provenCauses`は、同一path・同一categoryのerrorがあり、かつexact executable evidenceを提示できる場合だけ昇格できる。current observationsは`provenCauses`を追加していない。

次はnamed testで確認するexecutable repository factsである。repository内再現を独立した外部game truthと混同しない。

| repository fact | named executable evidence | 意味する範囲 |
|---|---|---|
| 現行planは36h/3-groupでなく24h/2-window | `locks the smallest reproducible 3-group versus 2-window state mismatch` | state-model mismatchを再現する。外部理論値そのものの正しさは証明しない |
| planにresource/sustainable-cycle outputsがない | `confirms generated plans do not expose quantity or sustainable-cycle results` | actual quantityがmissingである理由を再現する |
| fractional hoursの平均が整数時間へtruncateされる | `confirms optimizer morale/time averaging still truncates fractional hours` | continuous curve limitationをsynthetic caseで再現する |
| CN source-only operatorとsource conflictをrunnable compositionから分離する | `keeps unavailable quantities missing and CN source conflicts diagnostic` | disputed evidenceを比較可能occupantやactual quantityへ昇格しない |
| all-unlocked metadataとregion/commitがstate snapshot由来 | `derives all-unlocked metadata and provenance from the state snapshot consumed by the plan` | caller metadataとの二重authorityを排除する |
| explicit metadataがactual regional ownership由来 | `derives explicit metadata from actual region-available ownership with no caller roster declaration` | unavailable/unknown IDをmetadataへ偽装できない |
| disputed/legacyはdiagnostic、acceptedだけがgating | `keeps disputed and formula-only references diagnostic while the accepted contract gates` | aggregate gate policyを固定する |

`search`や`interpretation`は、actual resource comparisonとfull composition equalityが成立しない現状では確定原因に昇格できない。通常mismatchはsuspectedのままにし、missing quantityを0またはfixture expected値として扱わない。

## Follow-upsとdependency status

#30（reference/runtime provenance分離）と#31（AppState region伝播）はprior dependenciesとしてcompleted。PR40 evidenceは#32相当のcomposition identityをfixtureへ統合するが、外部Issueのstatus mutationは主張しない。

| Issue | OPEN scope | current blocker |
|---|---|---|
| #32 | composition IDs | PR40 evidenceでJP occupant ID、remote support、CN source-only/conflict evidenceをfixtureへ統合 |
| #33 | schedule state | 3 groups、36h full rotation、可変shift identityをplan stateで表現する |
| #34 | continuous curves | fractional時間とmorale境界を連続/区分計算する |
| #35 | plan quantities / drone ledger | assignment planからactual resourcesとdrone内訳を生成する |
| #36 | sustainability integration | schedule、morale、recovery、inventory、cycle closureをplanへ統合する |

#28は本監査のout of scopeであり、mutationしていない。production fix、expected-value copyingも行っていない。

## このworktreeでの検証

以下はaccepted PR39 re-audit baselineの記録であり、このconflict resolution後のcountへは未更新である。current rebase validationの実出力はrebase ticketの完了報告をauthorityとする。

- focused audit: `./node_modules/.bin/vitest run src/lib/optimizerIssue27Audit.test.ts --reporter=verbose` — 1 file / 9 tests PASS
- runner + audit: `./node_modules/.bin/vitest run src/lib/optimizerBenchmarkRunner.test.ts src/lib/optimizerIssue27Audit.test.ts --reporter=verbose` — 2 files / 32 tests PASS
- full suite: `./node_modules/.bin/vitest run` — 17 files / 562 tests PASS
- build: `./node_modules/.bin/tsc -b && ./node_modules/.bin/vite build` — TypeScript PASS、Vite 1715 modules transformed、build PASS
- base-skill audit: `node scripts/audit-base-skills.mjs` — exit 0。330 operators / 607 skills / 616 effects、unclassified production effects 0、unmodeled production curves 0、morale descriptions without model 0
- localization audit: `node scripts/audit-localization.mjs` — exit 0。330 operators。missing counts: operator names en 6 / ja 6、skill descriptions en 34 / ja 9、skill names en 34 / ja 9
- `git diff --check`: PASS
