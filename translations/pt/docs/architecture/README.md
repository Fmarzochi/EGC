# Arquitetura do EGC

O EGC possui um runtime de producao alem de uma direcao exploratoria de kernel mantida em `architecture/` para pesquisa e evolucao do ecossistema. Esta pagina e o indice: leia primeiro, depois aprofunde-se nos documentos especificos abaixo.

## Runtime

### Runtime Node.js + MCP (coberto pelo CI)

A superficie de producao que alimenta os harnesses Gemini Code, Codex, Cursor, Antigravity, OpenCode, Kiro, Trae e Codebuddy.

| Camada | Caminho | Funcao |
|---|---|---|
| Manifestos | `.gemini-plugin/`, `.codex-plugin/`, `.gemini-plugin/marketplace.json` | Descoberta estatica de plugins |
| Adaptadores de instalacao | `scripts/lib/install-targets/` | Materializacao por alvo |
| Ponto de entrada de instalacao | `scripts/install-apply.js`, `install.sh`, `install.ps1` | Instaladores voltados ao usuario |
| Pipeline de hooks | `hooks/hooks.json` + `scripts/hooks/*` | Hooks de Pre/Post-ferramenta, sessao e governanca |
| Gates de CI | `scripts/ci/validate-*.js`, `scripts/ci/catalog.js` | Validacao de workflow |

O runtime Node/MCP e totalmente exercido pela matriz de CI (`.github/workflows/ci.yml`, `reusable-test.yml`, `reusable-validate.yml`) em Linux/macOS/Windows x Node 20/22 x npm/yarn/bun.

### Scaffolding dormante (preservado)

- `scripts/runtime/{router,discovery,mount-all,unmount-all,activator}.js`
- `scripts/orchestration/router.py`
- `scripts/health-check.js`, `scripts/generate-plugin-manifest.js`

Esses resolvem um caminho `registry/` inexistente e nao tem chamadores. Consulte `scripts/runtime/README.md` e `governance/SUBSYSTEM-MAP.md` para o status DORMANT.

## Exploracao arquitetural do EGC 2.0

`EGC_2.0_BLUEPRINT.md` e `EGC_2.0_TECHNICAL_DESIGN.md` recolhem pesquisas de evolucao do ecossistema em torno de uma variante de plano de controle unificado (kernel Rust + engine LLM Python + worker de hook Node + armazenamento de estado SQLite). Sao estudos avancados de runtime, nao um cronograma de substituicao para os runtimes de producao documentados acima.

O scaffold Rust em `egc/` esta reservado para essa exploracao. Ele nao substitui os runtimes de producao atuais.

## Documentos nesta pasta

| Arquivo | Escopo |
|---|---|
| `ARCHITECTURE-IMPROVEMENTS.md` | Melhorias e refatoracoes transversais realizadas durante a estabilizacao da v1 |
| `EGC_2.0_BLUEPRINT.md` | Visao para o Agent OS v2.0 |
| `EGC_2.0_TECHNICAL_DESIGN.md` | Integracao de componentes e contratos IPC da v2.0 |
| `SELECTIVE-INSTALL-ARCHITECTURE.md` | Sistema de modulos/perfis em `manifests/install-*.json` |
| `SELECTIVE-INSTALL-DESIGN.md` | Justificativa de design de instalacao seletiva e regras por alvo |
| `SINGLE-AGENT-OPERATIONAL-MODEL.md` | Modelo de execucao autoritativo de agente unico |
| `continuous-learning-v2-spec.md` | Especificacao de skill de aprendizado continuo v2 |
| `cross-harness.md` | Como uma unica fonte de skill e exposta em Gemini Code, Codex, Cursor, OpenCode |
