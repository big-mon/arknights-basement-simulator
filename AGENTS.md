# AGENTS.md

## Project

This repository is a Vite + React + TypeScript single-page app for an Arknights base rotation simulator. Keep changes focused on the requested behavior and preserve the browser-based, Japanese-first tool experience.

## Read By Trigger

- For domain terms, benchmark vocabulary, or rotation-model concepts, read [`CONTEXT.md`](./CONTEXT.md).
- For optimizer scoring, assignment, rotation, benchmark, or base-skill accuracy changes, read [`docs/specs/optimizer-accuracy-phase1.md`](./docs/specs/optimizer-accuracy-phase1.md). It is authoritative when [`docs/specs/optimizer-normalized-theoretical-scenarios.md`](./docs/specs/optimizer-normalized-theoretical-scenarios.md) conflicts with it.
- For benchmark acceptance changes, also read [`docs/specs/optimizer-objective-superior-acceptance.md`](./docs/specs/optimizer-objective-superior-acceptance.md) and its decision record, [`docs/adr/0001-accept-objective-superior-optimizer-plans.md`](./docs/adr/0001-accept-objective-superior-optimizer-plans.md). They are authoritative for `reference`, `output-equivalent`, and `objective-superior` acceptance semantics where older Phase 1 acceptance wording is narrower.
- For localization sources, fallback policy, or name precedence, read [`src/data/localization-sources.md`](./src/data/localization-sources.md). For the localization and import workflow, read [`CONTRIBUTING.md`](./CONTRIBUTING.md).
- For scripts and the required package-manager version, use [`package.json`](./package.json) as the authority. Follow the validation matrix in [`CONTRIBUTING.md`](./CONTRIBUTING.md) before finishing.

## Project Guardrails

- Use the repository-declared `pnpm`; keep tool setup local and use no administrator privileges unless explicitly requested.
- Treat imports as explicit network operations. Confirm network access and review generated diffs before keeping them.
- Preserve generated data and manual overrides as separate responsibilities described by the localization and contribution guides.
- Add focused optimizer regression coverage for scoring, assignment, rotation, or base-skill behavior changes.
- Keep controls compact and practical. Clickable cards and choice controls show a pointer cursor and a clear selected state.
- Preserve the proposal facility colors: trading post blue, factory yellow, and power plant green.

## Completion And Git Safety

- Use the applicable row of the validation matrix, then run `git diff --check`.
- Report every required command and browser check with its exact result. For anything not run, report `not run` and the concrete blocker.
- Keep commits focused, work on a feature branch (prefer `codex/`), and do not commit directly to `main`.
- Preserve unrelated user changes. Do not commit, push, open a pull request, merge, or deploy unless the user requests it.
- Resolve repository identity and remotes from Git when repository-specific operations are needed, rather than relying on a cached remote name, URL, or transport protocol.

## Encoding

Keep files UTF-8. PowerShell output can display Japanese text as mojibake; confirm the file diff, tests, or browser rendering before changing Japanese strings based on terminal output alone.
