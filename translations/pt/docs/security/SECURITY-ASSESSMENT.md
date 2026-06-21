# Avaliacao de Seguranca: Extended Global Context (EGC)

## Escopo

Esta avaliacao cobre o runtime do EGC e seus componentes primarios:

- Servidores MCP: `egc-guardian`, `egc-memory`
- Scripts de instalacao: `install.sh`, `install.ps1`
- Scripts de hook: `scripts/hooks/`
- Pontos de entrada CLI: `scripts/egc.js`, `scripts/egc-doctor.js`

## Limites de Confianca

| Limite | Descricao |
|----------|-------------|
| Sistema de arquivos local | O EGC le e grava arquivos de estado em `~/.egc/`. Acesso e apenas do usuario local. |
| Sockets da ferramenta de IA | Servidores MCP se comunicam com ferramentas de IA via stdio ou sockets nomeados. Sem exposicao de rede. |
| Dependencias externas | Pacotes npm. Fixados via `package-lock.json`, auditados via Dependabot. |
| GitHub Actions | CI/CD executa em sandboxes efemeras com permissoes minimas. |

## Identificacao de Ameacas

### Alta Probabilidade / Alto Impacto

| Ameaca | Mitigacao |
|--------|-----------|
| Cadeia de suprimentos de dependencia maliciosa | Dependencias fixadas via package-lock.json; alertas Dependabot; npm audit no CI |
| Injecao de comando via entradas MCP | `egc-guardian` valida todas as chamadas de ferramentas via `validate_command` antes da execucao |
| Vazamento de credenciais em logs de sessao | Sanitizacao do transcript da sessao remove variaveis de ambiente sensiveis da saida de log |

### Media Probabilidade / Medio Impacto

| Ameaca | Mitigacao |
|--------|-----------|
| Acesso nao autorizado ao sistema de arquivos | Servidor MCP executa no contexto do usuario; sem escalonamento de privilegios |
| Adulteracao de arquivo de estado | Arquivos de estado em `~/.egc/` sao texto simples; sem dados sensiveis de seguranca armazenados |
| Injecao de prompt via transcript | Ferramenta de IA e responsavel pelo tratamento de prompts; EGC fornece apenas dados brutos de sessao |

### Baixa Probabilidade

| Ameaca | Mitigacao |
|--------|-----------|
| Negacao de servico via transcript grande | Limite de 1MB de stdin em hooks de sessao |
| JSON malformado causando falha em hook | Try/catch em todos os parsers JSONL; saida graciosamente em caso de erro |

## Limitacoes Conhecidas

- O EGC e uma ferramenta apenas local; nao tem componente de servidor, autenticacao ou servicos de rede.
- A postura de seguranca depende da seguranca da maquina host e das integracoes de ferramentas de IA.
- Injecao de prompt de conteudo externo e uma preocupacao do nivel da ferramenta de IA, nao enderecavel na camada do EGC.

## Data da Avaliacao

2026-06-04
