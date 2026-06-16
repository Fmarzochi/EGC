# Mapa de Subsistemas do EGC

Esta pagina classifica os subsistemas de nivel superior e subarvores notaveis do repositorio EGC para que os contribuidores possam ver rapidamente o que esta ativo, o que e gerado, o que e preservado por razoes historicas e o que esta dormente.

## Taxonomia

- **ACTIVE**: invocado pelo CI, runtime ou fluxos de usuario suportados.
- **GENERATED**: produzido por ferramentas; seguro para regenerar.
- **ARCHIVAL**: instantaneo historico, preservado intencionalmente.
- **DORMANT**: codigo presente mas nao conectado a nenhum caminho de execucao.
- **LEGACY**: substituido; mantido para compatibilidade de migracao.
- **DEPRECATED**: programado para remocao quando os consumidores migrarem.

## Mapa

### Superficies ativas

| Caminho | Classe | Notas |
|---|---|---|
| `agents/` | ACTIVE | 62 definicoes de agentes, fonte da verdade |
| `commands/` | ACTIVE | 74 comandos de barra |
| `skills/` | ACTIVE | 228 skills em 14 namespaces |
| `rules/` | ACTIVE | Regras de codificacao para varias linguagens |
| `hooks/` | ACTIVE | Manifesto (`hooks.json`); implementacoes em `scripts/hooks/` |
| `scripts/hooks/` | ACTIVE | 25 hooks carregados diretamente pelo `hooks/hooks.json`; restante transitivo |
| `scripts/lib/` | ACTIVE | Bibliotecas de carregamento usadas pelos adaptadores de instalacao |
| `scripts/lib/install-targets/` | ACTIVE | Adaptadores por alvo (cursor, codex, antigravity, gemini, codebuddy, opencode) |
| `scripts/ci/` | ACTIVE | Validadores invocados pelo `.github/workflows/reusable-validate.yml` |
| `scripts/install-apply.js` | ACTIVE | `bin: egc-install` |
| `scripts/egc.js` | ACTIVE | `bin: egc` |
| `scripts/doctor.js`, `scripts/bootstrap-state-db.js`, `scripts/build-opencode.js` | ACTIVE | scripts npm |
| `manifests/install-{modules,profiles,components}.json` | ACTIVE | Driver do adaptador de instalacao |
| `schemas/*.json` | ACTIVE | Validados no CI |
| `.gemini-plugin/`, `.codex-plugin/` | ACTIVE | Manifestos de plugin |
| `.cursor/`, `.codex/`, `.kiro/`, `.trae/`, `.codebuddy/`, `.opencode/` | ACTIVE | Pacotes de codigo-fonte especificos do harness |
| `.agents/` | ACTIVE | Camada de materializacao; taxonomia hot/cold/shadowed |
| `tests/` (`*.test.js`) | ACTIVE | Executado por `tests/run-all.js` (glob: `**/*.test.js`) |
| `install.sh`, `install.ps1` | ACTIVE | Pontos de entrada multiplataforma (linha Windows coberta pelo CI) |

### Gerado / regeneravel

| Caminho | Classe | Notas |
|---|---|---|
| `src/everything_gemini.egg-info/` | GENERATED | Produzido por `pip install -e .` / setuptools; seguro para regenerar |
| `.opencode/dist/` | GENERATED | Construido por `npm run build:opencode`; gitignored |
| `node_modules/` | GENERATED | npm padrao |
| `internal/registry/runtime-map.json` | ACTIVE | Cache quente gerado da topologia operacional; atualizado por `scripts/runtime/discovery.js` |

### Archival

| Caminho | Classe | Notas |
|---|---|---|
| `.agents/.agents/` | ARCHIVAL | Artefato de montagem recursiva preservado desde o baseline; links simbolicos agora relativos |
| `internal/registry/{agents,skills}-registry.json` | ARCHIVAL | Instantaneos historicos de inventario de versao anterior |
| `legacy-command-shims/` | ARCHIVAL | Shims de compatibilidade para muscle memory de `/tdd`, `/eval`, `/verify` |
| `agent.yaml` | ARCHIVAL | Manifesto Spec 0.1.0; sem consumidor ativo; util como contrato historico |

### Dormant

| Caminho | Classe | Notas |
|---|---|---|
| `scripts/runtime/` (router, mount-all, unmount-all, activator) | DORMANT | `discovery.js` e ACTIVE, mas scripts de roteamento/montagem sao dormentes |
| `scripts/orchestration/router.py` | DORMANT | Mesmo desvio de caminho de registro |
| `scripts/health-check.js` | DORMANT | Mesmo desvio de caminho de registro |
| `scripts/generate-plugin-manifest.js` | DORMANT | Mesmo desvio de caminho de registro |

## Politica de Governanca

- Itens **ACTIVE**: mudancas passam pela revisao normal.
- Itens **GENERATED**: nao editar manualmente; regenerar a partir do codigo-fonte.
- Itens **ARCHIVAL**: manter a menos que seja explicitamente autorizado para remocao.
- Itens **DORMANT**: nao reativar oportunisticamente.
- Itens **LEGACY** / **DEPRECATED**: incluir um alvo de migracao.

Em caso de duvida: preservar e classificar; nao deletar.
