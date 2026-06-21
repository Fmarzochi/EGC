# Modelo de Ameaca: Extended Global Context (EGC)

## Visao Geral do Sistema

O EGC e um runtime de memoria e orquestracao de IA local. Nao tem servicos de rede, superficie de autenticacao nem modelo de acesso multiusuario. A superficie de ataque e limitada a:

1. O pacote npm e suas dependencias
2. Os servidores MCP executando como processos stdio locais
3. O pipeline de CI/CD do GitHub Actions
4. Hooks de sessao que processam dados de transcript

## Atores

| Ator | Nivel de Confianca | Descricao |
|-------|-------------|-------------|
| Usuario local | Totalmente confiavel | Executa o EGC em sua propria maquina |
| Contribuidor | Parcialmente confiavel | Envia PRs; nao pode fazer merge sem revisao |
| Autor de dependencia | Nao confiavel | Pacotes npm de terceiros |
| Ferramenta de IA (Claude Code, etc.) | Confiavel em runtime | Chama ferramentas MCP; executa no mesmo contexto de usuario |
| Runner do GitHub Actions | Confiavel | Ambiente sandbox efemero |
| Autor de PR (fork) | Nao confiavel | Codigo de forks nao acessa segredos |

## Superficies de Ataque e Mitigacoes

### 1. Injecao de Dependencia / Cadeia de Suprimentos

**Ameaca:** Um pacote npm malicioso ou comprometido e introduzido.

**Mitigacoes:**
- Todas as dependencias sao bloqueadas via `package-lock.json`
- Dependabot monitora alertas de vulnerabilidade
- `dependency-review.yml` bloqueia PRs que introduzem dependencias de alta severidade
- CI executa `npm audit` em cada push

### 2. Injecao de Comando via Entradas MCP

**Ameaca:** Uma chamada MCP gerada por IA maliciosa tenta executar comandos shell arbitrarios.

**Mitigacoes:**
- `egc-guardian` valida todas as chamadas de ferramentas antes da execucao via `validate_command`
- Comandos shell sao construidos a partir de padroes autorizados, nao interpolacao de string bruta

### 3. Vazamento de Credenciais em Logs

**Ameaca:** Valores sensiveis (chaves de API, tokens de sessao) aparecem em arquivos de transcript de sessao.

**Mitigacoes:**
- Hook de sessao sanitiza o conteudo do transcript antes de gravar no disco
- Arquivos de estado em `~/.egc/state/` contem apenas metadados estruturados, nao transcritos brutos

### 4. Comprometimento do Pipeline CI/CD

**Ameaca:** Um PR malicioso aciona um workflow que acessa segredos ou modifica o release.

**Mitigacoes:**
- Eventos `pull_request` de forks nao tem acesso aos segredos do repositorio
- `pull_request_target` nao e usado em nenhum workflow
- Workflows usam permissoes minimas por padrao
- Workflow de release so dispara em tags de versao enviadas pelo mantenedor
- Todas as acoes de terceiros sao fixadas em SHAs especificos de commit

## Caminhos de Codigo Criticos

| Caminho | Risco | Protecao |
|------|------|-----------|
| `scripts/egc-guardian/src/validate_command.ts` | Alto: controla toda execucao shell | Revisado em cada mudanca |
| `install.sh` / `install.ps1` | Medio: modifica configuracoes globais de ferramentas de IA | Verificado no CI em Linux, macOS, Windows |
| `scripts/hooks/session-end.js` | Medio: le transcript, grava no disco | Stdin limitado (1MB); tratamento estruturado de erros |
| `mcp/servers/egc-memory/` | Baixo: apenas le/grava arquivos de estado | Sem execucao shell; E/S de arquivo puro |

## Risco Residual

O EGC e uma ferramenta de desenvolvedor que executa com permissoes totais do usuario local por design. Uma maquina host comprometida, ferramenta de IA comprometida ou pacote npm comprometido poderia afetar o EGC. Esses riscos estao fora do controle do EGC e sao mitigados pelo ambiente host.

## Data de Revisao

2026-06-04: Felipe Marzochi
