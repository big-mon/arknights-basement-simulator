# Phase 1 project assumption bundle v1

Issue #53 のオフライン仮定bundleは `arknights-basement.phase1-project-assumptions` / version `1` とし、次の3 IDだけを許可する。

1. `phase1.high-value-order-probability.v1`
2. `phase1.perception-information-factory-efficiency.v1`
3. `phase1.signed-equivalent-morale-delta.v1`

チェックイン済みartifactは `src/data/phase1-project-assumption-bundle-v1.json`、loaderと導出APIは `src/lib/phase1AssumptionBundle.ts`、再生成器は `scripts/generate-phase1-assumption-bundle.mjs` に置く。再生成器はネットワーク、時刻、環境変数、乱数、fixture期待出力を参照しない。

## Hash・version契約

SHA-256入力は、rootの `contentSha256` fieldだけを除外したbundle contentである。object keyは各階層でUnicode code-unit順にsortし、array順は保存し、JSON primitiveをJSON表現にしてUTF-8でhashする。artifact表示順や空白はhashへ影響しない。hashは小文字64-hexとする。

loaderはschema/hashだけでなく、チェックイン済みv1の `(id, version, contentSha256)` tupleも照合する。このため内容を変えてhashだけ更新する同versionのsilent mutationは拒否される。内容変更時は新versionを発行し、依存fixtureを再審査する。generatorの `--check` はtracked artifactとのbyte一致を検査する。

未知key、未知domain、未知assumption ID、4番目のdomain、hidden calibration inputはfail closedで拒否する。bundle使用fixtureのconfidenceは `corroborated` であり、open PRの判断をconfirmed external truthとは扱わない。

## 1. 高価値注文

固定境界はmerged PR #18、commit `14263b18dd242f8ccd5080a103384101c64b8f6c` の `src/lib/optimizer.ts` (`normalGoldOrderDistribution`, `highValueOrderDistributions`, `averageHighValueOrderDistribution`, `expectedLmdPerHour`) と `src/data/base-skill-overrides.json` (`highValueOrderProbability`, warm-up 3h/5h) である。

通常分布は2/3/4純金注文に対して `0.30/0.50/0.20`、時間は `2.4/3.5/4.6 h`。target分布とscopeのcanonical levelはoptimizerのkeyと同じ `slight`、`doubleSlight`、`increased` の3つだけであり、分布は順に `0.15/0.30/0.55`、`0.13/0.22/0.65`、`0.05/0.10/0.85`。勤務時間 `t`、warm-up `w` の平均進捗は `t=0: 0`、`0<t<w: t/(2w)`、`t>=w: 1-w/(2t)` で、通常分布からtargetへ線形補間する。各分布から期待注文時間、純金消費、`500 LMD/gold` のLMDを直接導出する。

外部throughput、fixture期待値、Wikiru集計、ランダム注文列は入力にしない。

## 2. 知覚情報製造組

対象は `char_446_aroma`, `char_243_waaifu`, `char_391_rosmon` の3人全員をall-unlockedで同じ金製造所へ置いたfull groupである。operator/base mechanicsのauthorityはmerged Issues #12–#17 / PR #18 commit `14263b18dd242f8ccd5080a103384101c64b8f6c` とする。

勤務枠inputはIssue #46とopen stacked PR #48のreview済みcommit `3428e1b33897fa039e04246f8513114480c5c1cd` にある `docs/specs/optimizer-normalized-theoretical-scenarios.md` の「JP normalized scenario」と `src/data/optimizer-benchmarks/jp-243-factory-3group-2025-11.json` の `supportResourceScenario` / `schedule.shifts` にversion-pinする。

- Aroma: `manu_formula_spd&cost[001]` の金 `0.25` と `manu_prod_spd_addition[100]` の時間曲線を加算する。時間曲線は初期0、1時間幅、最初の1時間は増分なし、以後1時間ごとに `0.02`、上限 `0.20`。通常window再評価と同じく各shift開始からelapsed workを数え直し、12hの加重平均は `1.30 / 12 = 0.10833333333333334`、Aroma合計は `0.35833333333333334`。
- Waai Fu: `manu_prod_spd_variable2[000]` は同じ製造所にいる他2人のresult-affecting efficiencyだけを入力とする。`otherEfficiency = aromaGold + aromaTimeCurveAverage + rosmontisEfficiency`、`steps = floor(otherEfficiency / 0.05)`、`waaiFu = min(steps * 0.05, 0.40)`。dormitory occupancyやPerception Informationなどのfacility-count resourceはWaai Fuへ直接加算せず、それらから導出されたRosmontisのresult-affecting efficiencyだけを使う。
- Rosmontis: `manu_prod_spd_bd_n1[000]` により `thoughtChain = dormitoryOccupancy + perceptionInfo`。all-unlockedでは未昇進 `manu_prod_spd_bd[000]` の `per:2` ではなく、E2 `manu_prod_spd_bd[010]` の `per:1` と `0.01` を使うため、寄与は `floor(thoughtChain / 1) * 0.01`。
- full group: `groupEfficiency = aromaGold + aromaTimeCurveAverage + waaiFu + rosmontisEfficiency`。

- `groups-a-b`: elapsed work 12h、dormitory occupancy 20、Whisperain / office Level 2 / recruitment slot 3由来のPerception Information 20、thought chain 40。Waai Fuのother efficiencyは `0.35833333333333334 + 0.40` でcapに達する。componentはAroma `0.35833333333333334`、Waai Fu `0.40`、Rosmontis `0.40`、full group `1.1583333333333334`。
- `groups-b-c`: elapsed work 12h、dormitory occupancy 20、Dusk由来のPerception Information 10、thought chain 30。window内morale thresholdは積分せず10固定。Waai Fuのother efficiencyは `0.35833333333333334 + 0.30` でcapに達する。componentはAroma `0.35833333333333334`、Waai Fu `0.40`、Rosmontis `0.30`、full group `1.0583333333333333`。
- `groups-c-a`: Perception Information production group Bが回復側で非稼働。0と推定せずfail closed。

open PR #48 commit `3428e1b33897fa039e04246f8513114480c5c1cd` は勤務枠・support resourceのpinned scenario input参照に限り、外部truthやmodel authorityにはしない。Issue #46のreference diagnostic内部にある24h explicit inspection値は、各12h通常windowの時間境界として流用しない。Wikiru `+125.42%`、公開Gold/EXP、fixture expected output、24h aggregate、36h平均の24h比例換算は入力にも校正にも使わない。

## 3. 符号付き等価体力差分

数値mechanicsの境界はmerged Issues #12–#17 / PR #18 commit `14263b18dd242f8ccd5080a103384101c64b8f6c`、exchangeの境界はapproved Issue #53 per-shift abstractionとする。open PR #44のevent sequencingはこのassumptionのauthorityにもprovenanceにも使用しない。

- work: `end=max(0,start-consumptionRatePerHour*durationHours)`、deltaは `end-start <= 0`。
- ordinary recovery: thresholdごとのconditional modifierを含む有効rateをcapまで区分積分し、deltaは `end-start >= 0`。
- exchange support: inputは固定slot境界の `mode`, `sourceMoraleBefore`, `targetMoraleBefore` だけを必須とする。sourceの数値morale自体がmodeled capと等しいことを要求し、source/targetの境界値をswapする。target deltaは `sourceBefore-targetBefore`、source deltaはその逆で、合計deltaは0。identityを与える場合はsource/targetの両方を任意の追加fieldとして与え、同一actorを拒否する目的だけに使う。timestamp、順序、same-dorm boolean、once-per-shift counter、previous recovery interval/work historyは入力にしない。

morale cap 24、base work consumption 1/h、ordinary Lv5 dormitory recovery 4/hはmerged PR #18のmodel decisionと一致する。idleのdelta 0は説明上記録するが、第4 mode/domainを許可するassumption IDにはしない。placement uniqueness、activity、support capacityはIssue #20 witness、continuityとcycle closureはIssue #50 witnessの責務としてscopeから除外する。Wikiru 24h出力もIssue #53の対象外である。

## Primaryとsensitivity

各assumptionの `primary` だけが導出および将来のpass/fail authorityを持つ。`diagnosticOnlySensitivity` は明示的な診断点であり、primary APIは参照しない。感度値を変更してもprimary導出結果は変化しない。高価値注文の8h/12h/16hは承認済みrotation境界、知覚情報の10/20 pointsは固定support sourceそのもの、体力消費rateは数学的parameter variationである。sourceにない任意の知覚情報deltaや外部expected outputから作った感度値は置かない。
