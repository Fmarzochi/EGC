# Documentacao do EGC

Este diretorio e o ponto de entrada canonico para tudo que nao e o `README.md` voltado ao usuario na raiz do repositorio.

Se voce nao sabe por onde comecar, leia `governance/SUBSYSTEM-MAP.md` para a classificacao formal de cada subsistema.

## Estrutura

| Pasta | Finalidade | Comece aqui |
|---|---|---|
| `architecture/` | Arquitetura completa, atual e futura | `architecture/README.md` |
| `governance/` | Classificacao de subsistemas, politicas de skills e agentes | `governance/README.md` |
| `guides/` | Guias operacionais e tutoriais para contribuidores | `guides/README.md` |
| `installation/` | Playbooks de configuracao para stacks especificas | `installation/HERMES-SETUP.md` |
| `runtime/` | Contratos de runtime (mapa de comandos/agentes, adaptador de sessao) | arquivos diretos |

## Referencias cruzadas

- `README.md` raiz: visao geral do projeto voltada ao usuario e inicio rapido.
- `.github/CONTRIBUTING.md`: governanca de engenharia e fluxo de contribuicao.
- `docs/RULES.md`: regras de governanca do engine.
- `.github/SECURITY.md`: divulgacao de vulnerabilidades.

## Ordem de leitura para um novo contribuidor

1. `README.md` raiz: o que e o EGC e como instalar.
2. `governance/SUBSYSTEM-MAP.md`: para que serve cada diretorio.
3. `architecture/README.md`: o modelo de runtime em camadas.
4. `.github/CONTRIBUTING.md`: como propor mudancas.
5. `guides/SKILL-DEVELOPMENT-GUIDE.md` se for criar uma skill, ou `guides/ANTIGRAVITY-GUIDE.md` para um exemplo completo de instalador.
