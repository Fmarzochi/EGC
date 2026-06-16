# Especificacao do EGC

A especificacao do EGC e executavel. Ela vive em JSON Schemas em `schemas/`, em manifestos de instalacao em `scripts/lib/`, e em testes em `tests/spec/`. Este documento e o indice que os une.

## Versao da spec

`SPEC_VERSION = 0.1.0` (declarado em `agent.yaml`)

Semver se aplica: `MAJOR.MINOR.PATCH`.

- `PATCH`: Documentacao, correcao de digitacao, mudancas sem impacto no contrato
- `MINOR`: Mudancas aditivas nos schemas (novos campos opcionais, novos tiers opcionais)
- `MAJOR`: Campos removidos, identificadores renomeados, semantica alterada, novos campos obrigatorios

Uma janela de deprecacao de 90 dias se aplica para mudancas `MAJOR` que quebram compatibilidade em superficies publicas (alvos de instalacao, nomes de ferramentas MCP, nomes de eventos de hook).

## O que a spec cobre

| Superficie | Especificado por | Validado por |
|---------|--------------|--------------|
| Tiers de integracao | [`integration-tiers.md`](./integration-tiers.md) | `tests/spec/integration-tiers.test.js` |
| Contrato de hooks | `schemas/hooks.schema.json` | `tests/hooks/hooks.test.js` |
| Manifesto de plugin | `schemas/plugin.schema.json` | `tests/plugin-manifest.test.js` |
| Mapa de runtime | `schemas/runtime-map.schema.json` | `tests/test_orchestrator.py` |
| Perfis de instalacao | `schemas/install-profiles.schema.json` | `tests/lib/install-manifests.test.js` |
| Modulos de instalacao | `schemas/install-modules.schema.json` | `tests/scripts/doctor.test.js` |
| Componentes de instalacao | `schemas/install-components.schema.json` | `tests/lib/install-manifests.test.js` |
| Deteccao de gerenciador de pacotes | `schemas/package-manager.schema.json` | `tests/scripts/auto-update.test.js` |
| Metadados de proveniencia | `schemas/provenance.schema.json` | `tests/lib/skill-dashboard.test.js` |
| Armazenamento de estado | `schemas/state-store.schema.json` | `tests/lib/state-store.test.js` |
| Configuracao de instalacao EGC | `schemas/egc-install-config.schema.json` | `tests/lib/install-targets.test.js` |
| Estado de instalacao | `schemas/install-state.schema.json` | lacuna: sem teste dedicado (validado indiretamente via fluxo install-apply) |
| Registro de agentes | `schemas/agents-registry.schema.json` | lacuna: sem validador dedicado |
| Registro de skills | `schemas/skills-registry.schema.json` | lacuna: sem validador dedicado |

## Pontos de entrada por audiencia

**Adicionando um novo harness?** Leia [`integration-tiers.md`](./integration-tiers.md).

**Implementando um hook personalizado?** Leia `schemas/hooks.schema.json` e `tests/hooks/hooks.test.js` para exemplos funcionais.

**Auditando seu fork?** Execute `node scripts/harness-audit.js`.

**Migrando entre versoes MAJOR?** Leia o changelog mais o ADR relevante em `docs/decisions/` (planejado).

## O que NAO esta especificado ainda

Esta secao e deliberadamente publica. Rastrear lacunas honestamente e melhor que omissoes aspiracionais.

- **Schema de contrato de harness**: `harness-contract.schema.json` ainda nao existe. O contrato e implicito em `install-apply.js`. Este e o proximo passo de maturacao.
- **Testes de conformidade por harness**: `tests/spec/{target}.smoke.test.js` ainda nao existe.
- **ADRs**: `docs/decisions/` ainda nao existe. Cerca de 5-7 ADRs retroativos sao necessarios para decisoes ja tomadas.
- **HARNESS-{target}.md por alvo Tier 1/2**: resumo de uma pagina por alvo com mantenedor, exemplo de instalacao e casos extremos conhecidos.
