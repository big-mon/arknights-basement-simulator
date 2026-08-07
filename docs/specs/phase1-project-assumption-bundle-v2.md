# Phase 1 project assumption bundle v2

Issue #53 のbundle v2は、v1の監査履歴を変更せず、知覚情報製造組のproduction groupと勤務枠対応だけを修正する。bundle IDと許可仮定IDはv1から変更せず、versionを整数`2`とし、内容に対応する新しい小文字64-hex SHA-256を持つ。

チェックイン済みartifactは `src/data/phase1-project-assumption-bundle-v2.json`、再生成器は `scripts/generate-phase1-assumption-bundle-v2.mjs`、version-pinされたloaderは `loadPhase1AssumptionBundleV2` とする。v1のartifact、generator、仕様書および既定loaderは置換しない。

## v1からの差分

高価値注文仮定と符号付き等価体力差分仮定は、object key、array順、値を含めてv1と同じJSON semanticsを保つ。知覚情報製造組では計算式、オペレーター、全解放スキル、12時間、宿舎占有20を保ち、次だけを変更する。

- `scope.productionGroupId`: `C`
- `groups-a-b`: 非稼働。0とは推定せずfail closed
- `groups-b-c`: Perception Information `20`
- `groups-c-a`: Perception Information `10`

従って12時間勤務枠の導出値は次のとおりとなる。

- `groups-b-c`: thought chain `40`; Aroma `0.35833333333333334`; Waai Fu `0.40`; Rosmontis `0.40`; full group `1.1583333333333334`
- `groups-c-a`: thought chain `30`; Aroma `0.35833333333333334`; Waai Fu `0.40`; Rosmontis `0.30`; full group `1.0583333333333333`

## Hash・生成契約

canonicalization、hash除外field、primary/sensitivity境界、mutation policyはv1と同じである。generatorはv1のcanonical source objectを複製し、上記versionと知覚情報mappingだけを置換してhashを再計算する。`--check`はv2 artifactとのbyte一致を検査する。ネットワーク、時刻、環境変数、乱数、fixture期待出力は参照しない。
