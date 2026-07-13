# Project instructions

- After TypeScript or JavaScript changes, run separately:
  - `bun run tsc`
  - `bun run lint:biome`
  - `bun run lint:oxlint`
- Do not consider `bun run lint` sufficient evidence in the final report: explicitly report the Biome and Oxlint results.
- Do not declare lint clean when any command returns an error. Also report any remaining warnings.
- Before completing code changes, run `bunx dprint check` and the relevant tests.
