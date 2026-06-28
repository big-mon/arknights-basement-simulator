# AGENTS.md

## Project

This repository is a Vite + React + TypeScript single-page app for an Arknights base rotation simulator.

The app lets users select owned operators, choose a base layout, and see facility assignment / rotation suggestions for trade posts, factories, power plants, control center, and dormitories.

## Environment

- Use the repository package manager: `pnpm`.
- The expected package manager version is declared in `package.json`.
- This machine uses `mise` for Node-related tools. Do not install Node, pnpm, or other tools globally.
- If the sandbox cannot resolve a `mise` shim, prefer the existing mise-managed pnpm binary instead of changing machine-wide settings.
- Do not use administrator privileges unless explicitly requested.

## Common Commands

- Start local dev server: `pnpm dev`
- Run tests: `pnpm test`
- Build: `pnpm build`
- Run both tests and build: `pnpm validate`
- Import game data: `pnpm import:game-data`

`pnpm import:game-data` fetches remote data and therefore needs network access.

## Repository Layout

- `src/App.tsx`: main UI and app state wiring.
- `src/components/`: reusable UI components.
- `src/lib/optimizer.ts`: assignment, scoring, and rotation logic.
- `src/lib/optimizer.test.ts`: optimizer-focused tests.
- `src/App.test.tsx`: app behavior, UI, localization, and regression tests.
- `src/data/operators.json`: generated lightweight operator/base-skill data used by the app.
- `src/data/operator-name-overrides.json`: manually maintained localized name corrections.
- `scripts/import-game-data.mjs`: importer that normalizes upstream game data into `operators.json`.

## Data Sources And Name Quality

The importer currently uses:

- CN game data from `Kengxxiao/ArknightsGameData`
- Yostar `ja_JP` and `en_US` game data from `Kengxxiao/ArknightsGameData_YoStar`

Do not assume that every `ja_JP` value is a confirmed correct Japanese display name. Some newer or region-lagged operators may be missing, untranslated, provisional, or still identical to Chinese names.

When correcting localized names:

- Update `src/data/operator-name-overrides.json`.
- Update the corresponding generated entry in `src/data/operators.json` if the app data is already checked in.
- Add or update a regression expectation in `src/App.test.tsx`.
- Prefer citing a source in the commit or PR description when the correction comes from an external page.

Important current limitation: `operator-name-overrides.json` is named like an override file, but the importer historically behaved more like "fill missing names" in some cases. If touching the importer, make the intended precedence explicit and test it.

Preferred name precedence for future work:

1. Manually verified Japanese name override.
2. Yostar `ja_JP` name.
3. English name.
4. Chinese name with a visible "name uncertain" indication in UI.

Avoid using missing Japanese data as a hard "not implemented in Japan" judgment. Keep the operator included and show uncertainty instead.

## Optimizer Notes

The optimizer is intentionally MVP-level and runs in the browser.

When changing scoring or assignment behavior, check these cases carefully:

- Product-specific factory effects such as gold, battle records, and originium must not be treated as generic percentages.
- Rotation windows should avoid reusing the same operator between rotation groups unless the feature is explicitly changed.
- Facility-specific conditions, same-facility operator conditions, named-operator conditions, and affiliation/faction conditions should be covered by tests.
- Dormitory effects primarily affect morale recovery and should not be assumed to directly boost production unless the skill text says so.

Add focused tests in `src/lib/optimizer.test.ts` for logic changes.

## UI Notes

- The UI is Japanese-first, with language switching for Japanese, Chinese, and English.
- Keep controls compact and practical; this is a simulator/tool, not a landing page.
- Clickable cards and choice controls should show pointer cursor and have clear selected states.
- Facility cards in proposal output use distinct soft colors:
  - Trading post: blue
  - Factory: yellow
  - Power plant: green

## Validation

Before finishing code or data changes, run the smallest relevant validation:

- Name/data-only changes: `pnpm test` and usually `pnpm build`.
- Optimizer changes: `pnpm test` and `pnpm build`.
- UI-only changes: `pnpm test`, `pnpm build`, and browser smoke check when practical.

If validation cannot be run, explain why clearly.

## Git Workflow

- Do not commit directly to `main`.
- Use a feature branch, preferably with the `codex/` prefix.
- Keep commits focused.
- Do not revert unrelated user changes.
- The configured remote is expected to be `origin` at `git@github.com:big-mon/arknights-basement-simulator.git`.

## Encoding Notes

Keep files UTF-8. PowerShell output may display Japanese text as mojibake in some contexts; do not "fix" Japanese strings solely because terminal output looks garbled. Confirm via file diff, tests, or browser output.
