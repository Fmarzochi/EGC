# Guia de Configuracao e Uso do Antigravity

O [Antigravity](https://antigravity.dev) do Google e uma IDE de codificacao com IA que usa a convencao de diretorio `.agent/` para configuracao. O egc oferece suporte de primeira classe ao Antigravity por meio de seu sistema de instalacao seletiva.

## Inicio Rapido

```bash
# Instalar o egc com target Antigravity
./install.sh --target antigravity typescript

# Ou com multiplos modulos de linguagem
./install.sh --target antigravity typescript python go
```

Isso instala componentes do egc no diretorio `.agent/` do seu projeto, pronto para o Antigravity usar.

## Como Funciona o Mapeamento de Instalacao

O egc remapeia sua estrutura de componentes para corresponder ao layout esperado pelo Antigravity:

| Fonte egc | Destino Antigravity | O que contem |
|-----------|---------------------|--------------|
| `rules/` | `.agent/rules/` | Regras de linguagem e padroes de codificacao (niveladas) |
| `commands/` | `.agent/workflows/` | Slash commands tornam-se workflows do Antigravity |
| `agents/` | `.agent/skills/` | Definicoes de agentes tornam-se skills do Antigravity |

> **Nota sobre `.agents/` vs `.agent/` vs `agents/`**: O instalador lida com apenas tres caminhos de origem explicitamente: `rules` -> `.agent/rules/`, `commands` -> `.agent/workflows/`, e `agents` (sem prefixo ponto) -> `.agent/skills/`. O diretorio `.agents/` (com prefixo ponto) no repositorio egc e um **layout estatico** para definicoes de skills Codex/Antigravity e configuracoes `openai.yaml`: ele nao e mapeado diretamente pelo instalador. Qualquer caminho `.agents/` passa para a operacao de scaffold padrao. Se voce quer conteudo de `.agents/skills/` disponivel no runtime do Antigravity, deve copiar manualmente para `.agent/skills/`.

### Principais Diferencas do Gemini Code

- **Regras sao niveladas**: O Gemini Code aninha regras em subdiretorios (`rules/common/`, `rules/typescript/`). O Antigravity espera um diretorio `rules/` plano: o instalador cuida disso automaticamente.
- **Comandos tornam-se workflows**: Os arquivos `/command` do egc ficam em `.agent/workflows/`, que e o equivalente do Antigravity para slash commands.
- **Agentes tornam-se skills**: Definicoes de agentes egc mapeiam para `.agent/skills/`, onde o Antigravity procura configuracoes de skills.

## Estrutura de Diretorios Apos a Instalacao

```
seu-projeto/
+-- .agent/
|   +-- rules/
|   |   +-- coding-standards.md
|   |   +-- testing.md
|   |   +-- security.md
|   |   +-- typescript.md          # regras especificas de linguagem
|   +-- workflows/
|   |   +-- plan.md
|   |   +-- code-review.md
|   |   +-- tdd.md
|   |   +-- ...
|   +-- skills/
|   |   +-- planner.md
|   |   +-- code-reviewer.md
|   |   +-- tdd-guide.md
|   |   +-- ...
|   +-- egc-install-state.json     # rastreia o que o egc instalou
```

## A Configuracao de Agente `openai.yaml`

Cada diretorio de skill em `.agents/skills/` contem um arquivo `agents/openai.yaml` no caminho `.agents/skills/<nome-da-skill>/agents/openai.yaml` que configura a skill para o Antigravity:

```yaml
interface:
  display_name: "API Design"
  short_description: "Padroes de design de API REST e boas praticas"
  brand_color: "#F97316"
  default_prompt: "Design REST API: recursos, status codes, paginacao"
policy:
  allow_implicit_invocation: true
```

| Campo | Proposito |
|-------|-----------|
| `display_name` | Nome legivel por humanos exibido na UI do Antigravity |
| `short_description` | Descricao breve do que a skill faz |
| `brand_color` | Cor hex para o badge visual da skill |
| `default_prompt` | Prompt sugerido quando a skill e invocada manualmente |
| `allow_implicit_invocation` | Quando `true`, o Antigravity pode ativar a skill automaticamente com base no contexto |

## Gerenciando Sua Instalacao

### Verificar o que Esta Instalado

```bash
node scripts/list-installed.js --target antigravity
```

### Reparar uma Instalacao Quebrada

```bash
# Primeiro, diagnostique o que esta errado
node scripts/doctor.js --target antigravity

# Depois, restaure arquivos ausentes ou derivados
node scripts/repair.js --target antigravity
```

### Desinstalar

```bash
node scripts/uninstall.js --target antigravity
```

### Estado de Instalacao

O instalador escreve `.agent/egc-install-state.json` para rastrear quais arquivos o egc possui. Isso permite desinstalacao e reparo seguros: o egc nunca tocara em arquivos que nao criou.

## Adicionando Skills Customizadas para o Antigravity

Se voce esta contribuindo com uma nova skill e quer que ela esteja disponivel no Antigravity:

1. Crie a skill em `skills/nome-da-sua-skill/SKILL.md` normalmente
2. Adicione uma definicao de agente em `agents/nome-da-sua-skill.md`: este e o caminho que o instalador mapeia para `.agent/skills/` em tempo de execucao, tornando sua skill disponivel no harness Antigravity
3. Adicione a configuracao de agente Antigravity em `.agents/skills/nome-da-sua-skill/agents/openai.yaml`: este e um layout estatico do repositorio consumido pelo Codex para metadados de invocacao implicita
4. Espelhe o conteudo do `SKILL.md` em `.agents/skills/nome-da-sua-skill/SKILL.md`: esta copia estatica e usada pelo Codex e serve como referencia para o Antigravity
5. Mencione no seu PR que voce adicionou suporte ao Antigravity

> **Distincao chave**: O instalador implanta `agents/` (sem ponto) -> `.agent/skills/`: isso e o que torna as skills disponiveis em tempo de execucao. O diretorio `.agents/` (com prefixo ponto) e um layout estatico separado para configuracoes `openai.yaml` do Codex e nao e auto-implantado pelo instalador.

Veja [CONTRIBUTING.md](../../.github/CONTRIBUTING.md) para o guia completo de contribuicao.

## Comparacao com Outros Targets

| Feature | Gemini Code | Cursor | Codex | Antigravity |
|---------|-------------|--------|-------|-------------|
| Target de instalacao | `gemini-home` | `cursor-project` | `codex-home` | `antigravity` |
| Raiz de configuracao | `~/.gemini/` | `.cursor/` | `~/.codex/` | `.agent/` |
| Escopo | Nivel de usuario | Nivel de projeto | Nivel de usuario | Nivel de projeto |
| Formato de regras | Diretorios aninhados | Plano | Plano | Plano |
| Comandos | `commands/` | N/A | N/A | `workflows/` |
| Agentes/Skills | `agents/` | N/A | N/A | `skills/` |
| Estado de instalacao | `egc-install-state.json` | `egc-install-state.json` | `egc-install-state.json` | `egc-install-state.json` |

## Solucao de Problemas

### Skills nao carregando no Antigravity

- Verifique se o diretorio `.agent/` existe na raiz do seu projeto (nao no diretorio home)
- Verifique se `egc-install-state.json` foi criado: se ausente, re-execute o instalador
- Garanta que os arquivos tenham extensao `.md` e frontmatter valido

### Regras nao se aplicando

- Regras devem estar em `.agent/rules/`, nao em subdiretorios
- Execute `node scripts/doctor.js --target antigravity` para verificar a instalacao

### Workflows nao disponiveis

- O Antigravity procura workflows em `.agent/workflows/`, nao em `commands/`
- Se voce copiou comandos egc manualmente, renomeie o diretorio

## Recursos Relacionados

- [Arquitetura de Instalacao Seletiva](./SELECTIVE-INSTALL-ARCHITECTURE.md): como o sistema de instalacao funciona internamente
- [Design de Instalacao Seletiva](./SELECTIVE-INSTALL-DESIGN.md): decisoes de design e contratos de adaptador de target
- [CONTRIBUTING.md](../../.github/CONTRIBUTING.md): como contribuir com skills, agentes e comandos
