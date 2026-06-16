# Template de Capacidade de Produto

Use este template quando existe intencao de produto mas as restricoes de implementacao ainda sao implicitas.

O objetivo e criar um contrato de capacidade duravel, nao mais um documento de planejamento vago.

## Capacidade

- **Nome da capacidade:**
- **Fonte:** PRD / issue / discussao / roadmap / nota do fundador
- **Ator principal:**
- **Resultado apos lancamento:**
- **Sinal de sucesso:**

## Intencao do Produto

Descreva a promessa visivel ao usuario em um curto paragrafo.

## Restricoes

Liste as regras que devem ser verdadeiras antes do inicio da implementacao:

- regras de negocio
- limites de escopo
- invariantes
- restricoes de rollout
- restricoes de migracao
- restricoes de compatibilidade retroativa
- restricoes de billing / autenticacao / conformidade

## Atores e Superficies

- ator(es)
- superficies de UI
- superficies de API
- superficies de automacao / operador
- superficies de relatorios / dashboard

## Estados e Transicoes

Descreva o ciclo de vida em termos de estados explicitos e transicoes permitidas.

Exemplo:

- `rascunho -> ativo -> pausado -> concluido`
- `pendente -> aprovado -> provisionado -> revogado`

## Contrato de Interface

- entradas
- saidas
- efeitos colaterais necessarios
- estados de falha
- tentativas / recuperacao
- expectativas de idempotencia

## Implicacoes de Dados

- fonte de verdade
- novas entidades ou campos
- limites de propriedade
- expectativas de retencao / exclusao

## Seguranca e Politica

- limites de confianca
- requisitos de permissao
- caminhos de abuso
- requisitos de politica / governanca

## Nao-Objetivos

Liste o que esta capacidade explicitamente nao possui.

## Questoes em Aberto

Capture as decisoes nao resolvidas que bloqueiam a implementacao.

## Entrega

- **Pronto para implementacao?**
- **Precisa de revisao arquitetural?**
- **Precisa de esclarecimento de produto?**
- **Proximo lane egc:** `project-flow-ops` / `tdd-workflow` / `verification-loop` / outro
