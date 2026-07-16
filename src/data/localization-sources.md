# Localization sources

- Official Japanese and English game data: `Kengxxiao/ArknightsGameData_YoStar`
- Official Chinese game data: `Kengxxiao/ArknightsGameData`
- English translations for content not yet present in the global data: Arknights Terra Wiki (`arknights.wiki.gg`)
- Japanese base-skill names and descriptions missing from the official game-data mirror: Arknights Strategy Wiki (`arknights.wikiru.jp`)
- Manually verified operator display names: `operator-name-overrides.json`

Official game data has priority except where a manual override corrects a verified error. Wiki translations are stored in `base-skill-localization-fallbacks.json` and are only used when the corresponding official value is absent. Japanese skill text is not machine-translated.

When a Wikiru page still shows a Chinese base-skill name, the reviewed provisional Japanese name is stored in `base-skill-japanese-name-fallbacks.json`. These names remain fallbacks and yield to future official Japanese data.
