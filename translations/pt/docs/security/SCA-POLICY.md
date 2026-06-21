# Politica de Analise de Composicao de Software (SCA)

## Finalidade

Esta politica define como o EGC identifica, rastreia e remedia vulnerabilidades e problemas de licenca em suas dependencias.

## Ferramentas

| Ferramenta | Funcao |
|------|----------|
| Dependabot | Alertas automatizados e PRs para vulnerabilidades de dependencias |
| `dependency-review.yml` | Bloqueia PRs que introduzem dependencias de severidade alta ou critica |
| `npm audit` | Executado no CI em cada push; falha em achados de alta/critica severidade |

## Limites de Remediacao de Vulnerabilidades

| Severidade | Tempo Maximo para Remediar |
|----------|--------------------------|
| Critica | 7 dias |
| Alta | 14 dias |
| Moderada | 90 dias |
| Baixa / Info | Melhor esforco; tratado em atualizacoes agendadas de dependencias |

## Gate de Release

Nenhum release pode prosseguir se `npm audit` relatar qualquer vulnerabilidade `alta` ou `critica` na arvore de dependencias. O workflow de CI de release aplica essa verificacao automaticamente.

PRs que introduzem novas dependencias com vulnerabilidades conhecidas sao automaticamente bloqueados por `dependency-review.yml` antes de poderem ser mergeados.

## Politica de Licencas

As dependencias devem usar licencas compativeis com MIT (a licenca do projeto). As seguintes familias de licencas sao aceitaveis:

- MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, CC0-1.0, 0BSD

Licencas que exigem propagacao de copyleft (GPL, LGPL, AGPL) nao sao permitidas sem aprovacao explicita do mantenedor.

## Politica de SAST (Teste de Seguranca de Analise Estatica)

| Ferramenta | Escopo | Limite de Falha |
|------|-------|------------------|
| CodeQL | Consultas de seguranca JavaScript/TypeScript | Qualquer achado de alta/critica bloqueia o merge |
| ESLint | Qualidade de codigo e regras adjacentes a seguranca | Qualquer erro bloqueia o merge |

## Conformidade

Todas as mudancas na base de codigo sao automaticamente avaliadas pelas verificacoes de SCA listadas acima. PRs nao podem ser mergeados se a verificacao `dependency-review` falhar.
