# Instruções do projeto

- Sempre usar a skill `caveman`.
- Após alterações em TypeScript ou JavaScript, executar separadamente:
  - `bun run tsc`
  - `bun run lint:biome`
  - `bun run lint:oxlint`
- Não considerar `bun run lint` evidência suficiente no relatório final: informar explicitamente o resultado de Biome e Oxlint.
- Não declarar lint limpo quando algum comando retornar erro. Informar também warnings restantes.
- Antes de concluir mudanças de código, executar `bunx dprint check` e os testes relevantes.
