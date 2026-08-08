# ADR 0001: Accept mechanically valid objective-superior optimizer plans

- Status: Accepted
- Date: 2026-08-05

## Context

Phase 1のJP normalized-theoretical benchmarkは、外部referenceのGold・EXPを各相対±0.1%で再現することを当初の合格条件としていた。

Issue #28のglobal composition searchへ、window別ordinary/fixed support、physical support capacity、operator work/recovery、fixed resource context、normal mechanics reevaluationを統合したところ、次のcomplete planが得られた。

- Gold: `89.2`（reference `91.7893333333333`、約-2.82%）
- EXP: `34960`（reference `33613.3333333333`、約+4.01%）
- balanced normalized objective sum: `8.83`
- reference normalized objective sum: `8.73611111111111`
- objective advantage: 約`1.075%`

これらのobjective値は、candidateとreferenceの双方について、fixed support workerを実assignmentとしてmaterializeし、cyclic schedule境界を含む連続勤務時間とwhole-cycle sustainabilityを評価する同一のschedule-aware mechanicsで再評価した最終値である。

このplanはreferenceのresource別toleranceを外れる一方、同一のbalanced objective、region、roster、schedule、fixed scenarioでreferenceより高いobjective valueを持つ。Strict output-only acceptanceを維持すると、mechanically validでobjective上より良いplanを意図的に捨てるcanonical ruleが必要になり、benchmark compositionへの過学習を誘発する。

## Decision

Phase 1 benchmarkはreferenceを唯一の出力正解ではなく**reference baseline**として保持する。

従来の`reference`および`output-equivalent`に加え、次の条件をすべて満たすplanを`objective-superior`として受理できる。

1. Reference baselineと同一のregion、roster mode、schedule、objective profile、scenario assumptionsで評価する。
2. Production slot、operator conflict、window別ordinary/fixed support、support facility capacity、勤務・回復、resource observationがcompleteである。
3. Objective valueは、所有可能性やexpected outputではなく、選択された実配置をwindowごとにnormal mechanicsで再評価したauthoritative scoreから算出する。
4. Reference baselineのobjective valueをbenchmark toleranceを超えて上回る。
5. 各resourceのreferenceとの差分を引き続きdiagnosticとして記録し、隠さない。
6. Expected outputまたはreference operator IDsをproduction candidate generation、scoring、tie-breakへ渡さない。
7. Bounded searchは`objective-superior`でもglobal optimumを主張せず、typed `not-certified`を維持する。

JPは引き続きPhase 1 gating regionとする。CNはsecondary/non-gatingのままとする。

## Consequences

- Benchmark runnerとauditへ`objective-superior` acceptance modeが必要になる。
- Reference compositionを通常optimizer入力へ混入しないnegative controlを維持する。
- Objective comparisonには、reference baseline側にも同一assumptionsで評価可能なauthoritative objective evidenceが必要になる。
- Resource別±0.1%を外れたplanでも合格し得るが、差分、objective advantage、mechanical completeness、proof statusを明示する。
- Mechanical evidenceが不完全、supportがpotentialのみ、resource observationが欠落、またはobjective comparison不能なplanは`objective-superior`として受理しない。
- この決定はbenchmark期待値そのものを書き換えるものではない。

## Alternatives considered

### Gold・EXP各±0.1%だけを合格条件として維持

Mechanically validでobjective上より良いplanを不合格にし、referenceへ寄せる非本質的なcanonical ruleやscore tuningを促すため不採用。

### Gold・EXP weightを調整してreferenceを最大化

承認済みbalanced objectiveをreferenceに合わせて変更し、計算・探索誤差をweight tuningで隠すため不採用。

### Expected outputとの距離をproduction scoreへ加える

Benchmarkデータをoptimizerへ漏洩させ、通常探索ではなくfixture再現器になるため不採用。

### Balanced objectiveを全面的に再設計するまでIssue #28を停止

現在のweighted objective下で有効なsuperior planを識別でき、acceptance semanticsを分離すれば進められるため不採用。
