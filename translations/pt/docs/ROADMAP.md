# Roadmap do EGC

Este documento descreve a direcao de desenvolvimento planejada para o EGC (Extended Global Context).

## v1.1.0: Expansao de Memoria (Lancada em 13/06/2026)

- `working_memory`: armazenamento transitorio chave-valor com TTL (issue #138)
- `lessons`: conhecimento entre sessoes com decaimento de confianca (issue #140)
- `detect_patterns`: analise comportamental a partir de eventos de hook (issue #141)
- `compress_observations`: compressao de observacoes baseada em regras (issue #142)
- `search_history`: busca de texto completo com ranking BM25 sobre decisoes (issue #139)
- Estado do projeto ciente de branch: escopo de `get_state`/`update_state` por branch do git (issue #137)
- Pipeline de consolidacao de estado a cada chamada de `update_state` (issue #143)
- Hook SessionStart executa de forma idempotente apos reinstalacoes do harness

## v1.2.0: Expansao do Ecossistema

- Suporte a harnesses de IA adicionais (Zed, Windsurf, Continue)
- Sistema de plugins para agentes e skills da comunidade
- Perfis e substituicoes de skills por projeto

## v1.3.0: Governanca e Seguranca

- Revisao formal de seguranca por parte independente
- Caso de asseguranca documentando propriedades de seguranca
- Contribuicao de pelo menos dois mantenedores ativos (fator de onibus >= 2)
- Geracao de SBOM (Software Bill of Materials)

## v2.0.0: Runtime de Producao

- API estavel do servidor MCP com interfaces versionadas
- egc-guardian e egc-memory promovidos para GA
- Federacao de memoria entre projetos
- Instalacoes para times e organizacoes

## Nao-Objetivos

- O EGC nao visa substituir provedores de IA: ele os aumenta
- O EGC nao armazena nem transmite codigo do usuario para terceiros
- O EGC nao exige conectividade com a nuvem em instalacoes locais
