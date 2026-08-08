# Objective-superior benchmark acceptance specification

## Problem Statement

Phase 1のoptimizer benchmarkは、外部referenceのresource outputを各相対±0.1%で再現するplanだけを合格としている。

Issue #28でcanonical 3-group production、window別ordinary/fixed support、physical support capacity、operator work/recovery、fixed resource context、normal mechanics reevaluationを統合した結果、同一のJP region、all-unlocked roster、schedule、balanced objective、normalized-theoretical scenarioで、referenceとは異なるがmechanically validかつobjective valueが約1.075%高いplanが得られた。この値はcandidateとreferenceの双方でfixed support workerをmaterializeし、schedule-aware contiguous cyclic workとwhole-cycle sustainabilityを適用した最終評価である。

Strict output-only acceptanceを維持すると、objective上より良いplanを意図的に捨てるか、reference compositionへ寄せる非本質的なscore/tie-breakを追加する必要がある。これはbenchmarkへの過学習を招き、通常optimizerの品質を下げる。

一方、単に「outputが違ってもscoreが高ければ合格」とすると、potential support、欠落resource observation、window外support、capacity違反、work/recovery違反、不完全planを誤って受理する危険がある。また、reference expected outputやoperator IDsをproduction scoringへ渡してはならない。

## Solution

Referenceを唯一の出力正解ではなくreference baselineとして保持する。

Benchmark acceptance modeを次の3種類として明示する。

1. `reference`: reference compositionとmechanically equivalentで、resource outputもtolerance内である。
2. `output-equivalent`: compositionは異なるが、対象resource outputがすべてtolerance内である。
3. `objective-superior`: output-equivalentではないが、同一assumptionsでmechanically validかつcompleteであり、authoritative objective valueがreference baselineをrelative toleranceより大きく上回る。

`objective-superior`でも各resourceおよびcompositionのreference差分を保持し、acceptance理由、objective advantage、mechanical evidence、search proof statusを公開する。Bounded searchは`not-certified`のままとし、global optimumを主張しない。

Reference objectiveはfixtureのexpected outputから逆算せず、benchmark側でreference compositionとrecorded support/fixed scenarioをnormal mechanicsへ通して算出する。Candidate objectiveは生成planの実配置をwindowごとにnormal mechanicsで再評価したauthoritative search objectiveを使用する。両者は同一のobjective profile、normalization、schedule duration、scenario assumptionsで比較する。

Phase 1ではobjective superiorityのrelative toleranceにfixtureのrelative tolerance `0.001`を使用する。Candidate scoreがreference scoreに対して`(candidate - reference) / abs(reference) > 0.001`を満たす場合だけsuperiorとする。Reference scoreが0または比較不能な場合、`objective-superior`では受理しない。

## User Stories

1. As an optimizer user, I want a mechanically valid plan that improves my selected objective to be accepted even when it does not reproduce a published composition, so that the optimizer is not penalized for finding a better plan.
2. As an optimizer user, I want each accepted plan’s Gold and EXP differences from the reference to remain visible, so that objective trade-offs are not hidden.
3. As an optimizer user, I want support operators to be assigned only in their actual work windows, so that claimed production bonuses correspond to feasible schedules.
4. As an optimizer user, I want ordinary support recovery windows to be represented and validated, so that a cycle-wide impossible support assignment cannot pass.
5. As an optimizer user, I want fixed support sources and facility slots reserved only in their declared windows, so that non-overlapping reuse is allowed without simultaneous conflicts.
6. As an optimizer user, I want physical support facility capacity checked per window, so that objective improvements cannot depend on impossible occupancy.
7. As an optimizer user, I want production and support operator duplication checked per window and cyclic interval, so that the accepted plan is physically coherent.
8. As an optimizer user, I want incomplete production, support, or resource observations to reject objective-superior acceptance, so that a high partial score cannot pass.
9. As an optimizer user, I want the candidate and reference evaluated under the same region, roster mode, schedule, objective profile, and scenario assumptions, so that the comparison is fair.
10. As an optimizer user, I want objective superiority calculated from normal mechanics rather than ownership potential, so that unselected supporters cannot inflate the score.
11. As an optimizer user, I want global optimality certification kept separate from benchmark acceptance, so that a useful bounded-search result can pass without a false proof claim.
12. As a benchmark maintainer, I want an explicit acceptance mode, so that I can distinguish exact reference reproduction, output equivalence, and objective superiority.
13. As a benchmark maintainer, I want candidate score, reference score, absolute advantage, and relative advantage recorded, so that an objective-superior decision is auditable.
14. As a benchmark maintainer, I want resource mismatches downgraded from gating failures only after objective-superior preconditions pass, so that the discrepancies remain visible without contradicting the accepted status.
15. As a benchmark maintainer, I want mechanical errors to remain errors under every acceptance mode, so that objective superiority cannot override invalid state.
16. As a benchmark maintainer, I want expected-output mutations to leave generated plans and authoritative reference evaluation unchanged, so that fixture expected values cannot leak into optimization.
17. As a benchmark maintainer, I want reference operator IDs used only by benchmark comparison/evaluation, so that production candidate generation and scoring remain generic.
18. As a benchmark maintainer, I want missing reference objective evidence to fail closed, so that superiority is never inferred from incomparable numbers.
19. As a benchmark maintainer, I want deterministic results under input permutation, so that acceptance does not depend on roster, facility, group, or candidate insertion order.
20. As a developer, I want the benchmark batch/audit result to be the primary acceptance seam, so that the complete normal execution path is tested rather than internal helpers.
21. As a developer, I want optimizer plan evidence to be a supporting seam, so that support, capacity, recovery, production completeness, and conflicts can be diagnosed independently.
22. As a developer, I want tiny generic composition search to retain brute-force oracle tests, so that exact kernel correctness remains independently proven.
23. As a developer, I want bounded production-scale search to report truncation and discarded work, so that `not-certified` provenance remains honest.
24. As a release reviewer, I want JP to remain gating and CN to remain secondary/non-gating, so that Phase 1 scope does not silently expand.
25. As a release reviewer, I want the existing external reference values unchanged, so that historical comparison remains available after adding objective-superior acceptance.
26. As a release reviewer, I want objective-superior acceptance to preserve the existing performance gate, so that improved correctness does not make benchmark execution impractical.

## Implementation Decisions

- The benchmark result exposes an explicit acceptance mode with `reference`, `output-equivalent`, and `objective-superior` variants.
- The result exposes an objective comparison record containing candidate value, reference value, absolute advantage, relative advantage, relative tolerance, objective profile, and authoritative provenance.
- The candidate objective authority is the selected plan’s exact window-re-evaluated aggregate. A reconstructed raw assignment sum, ownership-derived potential, expected output distance, or fixture composition match is not authoritative.
- The reference objective authority is a benchmark-only mechanical evaluation of the reference composition, remote support, fixed support scenario, and resource context under the same objective profile and normalization as the candidate.
- Reference expected output is not used to calculate reference objective superiority. It remains an independently compared external observation.
- Reference composition and support IDs may be consumed by benchmark-only evaluation and diagnostics, but are never passed into production candidate generation, retention, scoring, tie-break, or search termination.
- `objective-superior` requires all mechanical evidence to be complete: required production windows and slots, operator conflict validation, support scenario completion, scheduled support profile completion, physical support capacity, work/recovery validation, resource status, and required resource observations.
- Any missing or invalid mechanical evidence rejects `objective-superior`, regardless of candidate score.
- Candidate superiority requires a finite nonzero reference objective and relative advantage strictly greater than the configured relative tolerance.
- Phase 1 uses the fixture relative tolerance `0.001` for objective comparison. Equality at the tolerance boundary is not superior.
- Output-equivalent comparison remains per-resource and unchanged.
- When `objective-superior` passes, resource-output and composition mismatches are retained as non-gating warnings with actual, expected, absolute error, relative error, and applied tolerance.
- Source-data, state-model, calculation completeness, support, conflict, or objective-authority failures remain gating errors and cannot be downgraded by acceptance mode.
- `matchedComposition` remains reserved for reference or composition-equivalent matches. Objective-superior results identify their acceptance mode without claiming composition equivalence.
- `searchProofStatus` remains independent. A bounded objective-superior result reports `not-certified` and must not be described as globally optimal.
- The authoritative objective comparison is stable under input permutation and repeated execution.
- Existing generated-plan observation paths remain fresh and must not cache mutable application state or fixture expected output. Pure immutable mechanics may be cached for performance.
- JP remains gating. CN objective-superior diagnostics may be reported but do not gate Phase 1.
- The external benchmark fixture values and dependency manifests remain unchanged.

## Testing Decisions

- The primary acceptance seam is the benchmark batch/audit result produced through the normal optimizer path.
- The supporting seam is the externally visible optimizer plan and diagnostics used to prove mechanical validity.
- Internal seed builders, requirement maps, and score helpers are not tested directly when the same behavior can be observed at the benchmark or plan seam.
- The generic tiny composition kernel retains its existing brute-force oracle, deterministic tie-break, permutation invariance, and candidate-retention tests.
- A positive objective-superior test uses a complete mechanically valid candidate whose authoritative objective exceeds the mechanically evaluated reference by more than `0.001`, while at least one resource remains outside output-equivalent tolerance.
- The positive test asserts accepted status, `objective-superior` mode, finite candidate/reference scores, correct advantage, preserved resource warnings, and `not-certified` when search is bounded.
- A boundary test rejects relative advantage equal to or below `0.001` when outputs are not equivalent.
- A missing-reference-objective test rejects objective-superior acceptance.
- A missing-candidate-authority test rejects a raw or reconstructed score that lacks exact window provenance.
- Parameterized negative tests independently invalidate production completeness, operator conflicts, fixed support completion, ordinary support materialization, support capacity, work/recovery, resource completion, and required observations; every case must remain failed even with a numerically high candidate score.
- A potential-support negative test proves that an owned but unselected supporter cannot contribute to authoritative candidate objective.
- A fixture expected-output mutation test proves that generated plan, candidate objective, and mechanically evaluated reference objective do not change. Only external expected-output comparison diagnostics may change.
- A reference composition mutation test is benchmark-only and may change the reference objective, proving that superiority compares against mechanically evaluated composition rather than stored output values.
- Input permutation tests cover facility order, group order, roster object order, and candidate order without changing material plan, objective comparison, or acceptance mode.
- Existing reference and output-equivalent tests remain passing and retain their current semantics.
- Existing strict resource mismatch diagnostics remain asserted, but objective-superior acceptance changes their gating classification only after all preconditions pass.
- Performance verification measures a cold JP generation under ten seconds and the combined benchmark audit within its existing hook timeout.
- Full regression verification includes optimizer mechanics, support-resource scenario, resource ledger, reference diagnostic, benchmark runner, audit, TypeScript, production build, security scan, and diff check.

## Out of Scope

- Changing balanced objective weights.
- Adding distance from expected output to production scoring.
- Hard-coding reference operator IDs or outputs in production logic.
- Claiming global optimality for bounded search.
- Replacing the external reference values.
- Expanding Issue #28 into full control, power, office, dormitory, workshop, or training-room rotation optimization beyond production support dependencies.
- Limited-roster acceptance owned by Issue #29.
- Making CN a Phase 1 gating region.
- Dependency upgrades or remediation of the existing PostCSS advisory.
- Merge, deploy, or other external integration operations.

## Further Notes

- This specification implements ADR 0001 and uses the project glossary definitions for reference baseline, output-equivalent plan, mechanically valid plan, objective-superior plan, and benchmark acceptance mode.
- Current evidence motivating the decision is Gold `89.2`, EXP `34960`, candidate normalized objective sum `8.83`, reference normalized objective sum `8.73611111111111`, and relative objective advantage approximately `0.01074722`. Both objectives materialize fixed support workers and use the same schedule-aware contiguous cyclic work and whole-cycle sustainability mechanics.
- These numbers are acceptance evidence, not production constants.
- The current Issue #28 worktree remains uncommitted and preserves all prior exact search, candidate retention, scheduled support, fixed scenario, and diagnostic work.
