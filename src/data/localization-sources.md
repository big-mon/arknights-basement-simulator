# Localization sources

- Official Japanese and English game data: `Kengxxiao/ArknightsGameData_YoStar`
- Official Chinese game data: `Kengxxiao/ArknightsGameData`
- English translations for content not yet present in the global data: Arknights Terra Wiki (`arknights.wiki.gg`)
- Manually verified operator display names: `operator-name-overrides.json`

Official game data has priority except where a manual override corrects a verified error. Wiki translations are only imported when the official English value is absent. Japanese skill text is not machine-translated: unreleased content remains explicitly detectable by `pnpm audit:localization` until a reliable Japanese source exists.
