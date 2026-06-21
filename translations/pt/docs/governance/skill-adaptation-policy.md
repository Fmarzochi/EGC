# Politica de Adaptacao de Skills

O EGC aceita ideias de repositorios externos, mas as skills publicadas precisam se tornar superficies nativas do EGC.

## Regra Padrao

Quando uma contribuicao parte de outro repositorio open-source, pacote de prompts, plugin, harness ou configuracao pessoal:

- copie a ideia, o fluxo de trabalho ou a estrutura subjacente
- adapte-a as superficies de instalacao atuais do EGC, ao fluxo de validacao e as convencoes do repositorio
- remova branding externo desnecessario, suposicoes de dependencias e enquadramentos especificos de upstream

O objetivo e reutilizacao sem transformar o EGC em um wrapper fino em torno do runtime de outra pessoa.

## Quando Manter o Nome Original

Mantenha o nome original da skill apenas quando todas as seguintes condicoes forem verdadeiras:

- a contribuicao e proxima de uma portagem direta
- o nome ja e descritivo e neutro
- a superficie ainda se comporta como o conceito upstream
- nao ha um nome nativo do EGC melhor ja no repositorio

## Quando Renomear

Renomeie a skill quando o EGC expandir, restringir ou reempacotar significativamente o trabalho original.

Gatilhos tipicos:

- o EGC adiciona comportamento, estrutura ou orientacao substancialmente novos
- o nome original e voltado ao fornecedor ou a marca da comunidade em vez de ser voltado ao fluxo de trabalho
- a contribuicao se sobrpoe a uma superficie existente do EGC e precisa de um limite mais claro
- a contribuicao agora se encaixa melhor como uma capacidade, fluxo de trabalho do operador ou camada de politica em vez de uma portagem literal

## Politica de Dependencias

O EGC prefere a superficie nativa mais estreita que resolve o problema:

- `rules/` para restricoes deterministicas
- `skills/` para fluxos de trabalho sob demanda
- MCP quando um limite de ferramenta interativa de longa duracao e justificado
- scripts locais/CLI para execucao deterministica de uso unico
- chamadas de API diretas quando a chamada remota e estreita e nao justifica um MCP

Evite publicar uma skill que existe principalmente para dizer aos usuarios que instalem ou confiem em um pacote de terceiros nao verificado.

## Perguntas de Revisao

Antes de fazer merge de uma skill contribuida, responda:

1. Esta e uma superficie reutilizavel real no EGC, ou apenas documentacao para outra ferramenta?
2. O nome atual ainda corresponde a superficie no formato EGC?
3. Ja existe uma skill do EGC que possui a maior parte desse comportamento?
4. Estamos importando um conceito ou a identidade do produto de outra pessoa?
5. Um usuario do EGC entenderia o proposito desta skill sem conhecer o repositorio upstream?

Se as respostas forem fracas, adapte mais, reduza o escopo ou nao publique.
