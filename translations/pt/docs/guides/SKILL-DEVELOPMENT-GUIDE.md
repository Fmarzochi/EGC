# Guia de Desenvolvimento de Skills

Um guia abrangente para criar skills eficazes para o EGC - Extended Global Context.

## Sumario

- [O que Sao Skills?](#o-que-sao-skills)
- [Arquitetura de Skills](#arquitetura-de-skills)
- [Criando Sua Primeira Skill](#criando-sua-primeira-skill)
- [Categorias de Skills](#categorias-de-skills)
- [Escrevendo Conteudo Eficaz de Skill](#escrevendo-conteudo-eficaz-de-skill)
- [Boas Praticas](#boas-praticas)
- [Padroes Comuns](#padroes-comuns)
- [Testando Sua Skill](#testando-sua-skill)
- [Submetendo Sua Skill](#submetendo-sua-skill)
- [Galeria de Exemplos](#galeria-de-exemplos)

---

## O que Sao Skills?

Skills sao **modulos de conhecimento** que o Gemini Code carrega com base no contexto. Elas fornecem:

- **Expertise de dominio**: Padroes de framework, idiomas de linguagem, boas praticas
- **Definicoes de fluxo de trabalho**: Processos passo a passo para tarefas comuns
- **Material de referencia**: Trechos de codigo, checklists, arvores de decisao
- **Injecao de contexto**: Ativam quando condicoes especificas sao atendidas

Ao contrario de **agentes** (subassistentes especializados) ou **comandos** (acoes disparadas pelo usuario), skills sao conhecimento passivo que o Gemini Code referencia quando relevante.

### Quando as Skills Ativam

Skills ativam quando:
- A tarefa do usuario corresponde ao dominio da skill
- O Gemini Code detecta contexto relevante
- Um comando referencia uma skill
- Um agente precisa de conhecimento de dominio

### Skill vs Agente vs Comando

| Componente | Proposito | Ativacao |
|------------|-----------|----------|
| **Skill** | Repositorio de conhecimento | Baseada em contexto (automatica) |
| **Agente** | Executor de tarefas | Delegacao explicita |
| **Comando** | Acao do usuario | Invocado pelo usuario (`/comando`) |
| **Hook** | Automacao | Disparado por evento |
| **Regra** | Diretrizes sempre ativas | Sempre ativo |

---

## Arquitetura de Skills

### Estrutura de Arquivos

```
skills/
+-- nome-da-sua-skill/
    +-- SKILL.md           # Obrigatorio: Definicao principal da skill
    +-- examples/          # Opcional: Exemplos de codigo
    |   +-- basic.ts
    |   +-- advanced.ts
    +-- references/        # Opcional: Referencias externas
        +-- links.md
```

### Formato do SKILL.md

```markdown
---
name: nome-da-skill
description: Descricao breve mostrada na lista de skills e usada para auto-ativacao
origin: egc
---

# Titulo da Skill

Visao geral breve do que esta skill cobre.

## Quando Ativar

Descreva cenarios onde o gemini deve usar esta skill.

## Conceitos Principais

Padroes e diretrizes principais.

## Exemplos de Codigo

\`\`\`typescript
// Exemplos praticos e testados
\`\`\`

## Anti-Padroes

Mostre o que NAO fazer com exemplos concretos.

## Boas Praticas

- Diretrizes acionaveis
- O que fazer e o que evitar

## Skills Relacionadas

Links para skills complementares.
```

### Campos do Frontmatter YAML

| Campo | Obrigatorio | Descricao |
|-------|-------------|-----------|
| `name` | Sim | Identificador em minusculo com hifens (ex.: `react-patterns`) |
| `description` | Sim | Descricao de uma linha para lista de skills e auto-ativacao |
| `origin` | Nao | Identificador de fonte (ex.: `egc`, `community`, nome do projeto) |
| `tags` | Nao | Array de tags para categorizacao |
| `version` | Nao | Versao da skill para rastrear atualizacoes |

---

## Criando Sua Primeira Skill

### Etapa 1: Escolha um Foco

Boas skills sao **focadas e acionaveis**:

| BOAS: Bom Foco | RUINS: Muito Amplo |
|----------------|-------------------|
| `react-hook-patterns` | `react` |
| `postgresql-indexing` | `databases` |
| `pytest-fixtures` | `python-testing` |
| `nextjs-app-router` | `nextjs` |

### Etapa 2: Crie o Diretorio

```bash
mkdir -p skills/nome-da-sua-skill
```

### Etapa 3: Escreva o SKILL.md

Template minimo:

```markdown
---
name: nome-da-sua-skill
description: Descricao breve de quando usar esta skill
---

# Titulo da Sua Skill

Visao geral breve (1 a 2 sentencas).

## Quando Ativar

- Cenario 1
- Cenario 2
- Cenario 3

## Conceitos Principais

### Conceito 1

Explicacao com exemplos.

### Conceito 2

Outro padrao com codigo.

## Exemplos de Codigo

\`\`\`typescript
// Exemplo pratico
\`\`\`

## Boas Praticas

- Faca isso
- Evite aquilo

## Skills Relacionadas

- `skill-relacionada-1`
- `skill-relacionada-2`
```

### Etapa 4: Adicione Conteudo

Escreva conteudo que o Gemini possa **usar imediatamente**:

- BOM: Exemplos de codigo prontos para copiar
- BOM: Arvores de decisao claras
- BOM: Checklists de verificacao
- RUIM: Explicacoes vagas sem exemplos
- RUIM: Prosa longa sem orientacao acionavel

---

## Categorias de Skills

### Padroes de Linguagem

Foco em codigo idiomatico, convencoes de nomenclatura e padroes especificos da linguagem.

**Exemplos:** `python-patterns`, `golang-patterns`, `typescript-standards`

```markdown
---
name: python-patterns
description: Idiomas Python, boas praticas e padroes para codigo limpo e idiomatico.
---

# Padroes Python

## Quando Ativar

- Escrevendo codigo Python
- Refatorando modulos Python
- Revisao de codigo Python

## Conceitos Principais

### Gerenciadores de Contexto

\`\`\`python
# Sempre use gerenciadores de contexto para recursos
with open('arquivo.txt') as f:
    conteudo = f.read()
\`\`\`
```

### Padroes de Framework

Foco em convencoes especificas do framework, padroes comuns e anti-padroes.

**Exemplos:** `django-patterns`, `nextjs-patterns`, `springboot-patterns`

### Skills de Fluxo de Trabalho

Definem processos passo a passo para tarefas comuns de desenvolvimento.

**Exemplos:** `tdd-workflow`, `code-review-workflow`, `deployment-checklist`

### Conhecimento de Dominio

Conhecimento especializado para dominios especificos (seguranca, performance, etc.).

**Exemplos:** `security-review`, `performance-optimization`, `api-design`

### Integracao de Ferramentas

Orientacao para usar ferramentas, bibliotecas ou servicos especificos.

**Exemplos:** `supabase-patterns`, `docker-patterns`, `mcp-server-patterns`

---

## Escrevendo Conteudo Eficaz de Skill

### 1. Comece com "Quando Ativar"

Esta secao e **critica** para auto-ativacao. Seja especifico:

```markdown
## Quando Ativar

- Criando novos componentes React
- Refatorando componentes existentes
- Depurando problemas de estado React
- Revisando codigo React para boas praticas
```

### 2. Use "Mostrar, Nao Contar"

Ruim:
```markdown
## Tratamento de Erros

Sempre trate erros adequadamente em funcoes async.
```

Bom:
```markdown
## Tratamento de Erros

\`\`\`typescript
async function fetchData(url: string) {
  try {
    const response = await fetch(url)

    if (!response.ok) {
      throw new Error(\`HTTP \${response.status}: \${response.statusText}\`)
    }

    return await response.json()
  } catch (error) {
    console.error('Fetch falhou:', error)
    throw new Error('Falha ao buscar dados')
  }
}
\`\`\`

### Pontos Chave

- Verifique \`response.ok\` antes de analisar
- Logue erros para depuracao
- Re-lance com mensagem amigavel ao usuario
```

### 3. Inclua Anti-Padroes

Mostre o que NAO fazer:

```markdown
## Anti-Padroes

### RUIM: Mutacao Direta de Estado

\`\`\`typescript
// NUNCA faca isso
user.name = 'Novo Nome'
items.push(novoItem)
\`\`\`

### BOM: Atualizacoes Imutaveis

\`\`\`typescript
// SEMPRE faca isso
const userAtualizado = { ...user, name: 'Novo Nome' }
const itensAtualizados = [...items, novoItem]
\`\`\`
```

### 4. Forneca Checklists

Checklists sao acionaveis e faceis de seguir:

```markdown
## Checklist Pre-Deploy

- [ ] Todos os testes passando
- [ ] Sem console.log em codigo de producao
- [ ] Variaveis de ambiente documentadas
- [ ] Segredos nao hardcoded
- [ ] Tratamento de erros completo
- [ ] Validacao de entrada implementada
```

### 5. Use Arvores de Decisao

Para decisoes complexas:

```markdown
## Escolhendo a Abordagem Certa

\`\`\`
Precisa buscar dados?
+-- Requisicao unica -> use fetch diretamente
+-- Multiplas independentes -> Promise.all()
+-- Multiplas dependentes -> await sequencialmente
+-- Com cache -> use SWR ou React Query
\`\`\`
```

---

## Boas Praticas

### FACA

| Pratica | Exemplo |
|---------|---------|
| **Seja especifico** | "Use `useCallback` para handlers de eventos passados para componentes filhos" |
| **Mostre exemplos** | Inclua codigo pronto para copiar |
| **Explique O POR QUE** | "Imutabilidade evita efeitos colaterais inesperados no estado React" |
| **Vincule skills relacionadas** | "Veja tambem: `react-performance`" |
| **Mantenha o foco** | Uma skill = um dominio/conceito |
| **Use secoes** | Headers claros para facil leitura |

### NAO FACA

| Pratica | Por que e Ruim |
|---------|----------------|
| **Seja vago** | "Escreva bom codigo" - nao e acionavel |
| **Prosa longa** | Dificil de analisar, melhor como codigo |
| **Cubra muito** | "Padroes Python, Django e Flask" - muito amplo |
| **Pule exemplos** | Teoria sem pratica e menos util |
| **Ignore anti-padroes** | Aprender o que NAO fazer e valioso |

### Diretrizes de Conteudo

1. **Tamanho**: 200 a 500 linhas tipico, 800 linhas maximo
2. **Blocos de codigo**: Inclua identificador de linguagem
3. **Headers**: Use hierarquia `##` e `###`
4. **Listas**: Use `-` para nao ordenadas, `1.` para ordenadas
5. **Tabelas**: Para comparacoes e referencias

---

## Padroes Comuns

### Padrao 1: Skill de Padroes

```markdown
---
name: padroes-de-linguagem
description: Padroes de codificacao e boas praticas para [linguagem].
---

# Padroes de [Linguagem]

## Quando Ativar

- Escrevendo codigo [linguagem]
- Revisao de codigo
- Configurando lint

## Convencoes de Nomenclatura

| Elemento | Convencao | Exemplo |
|----------|-----------|---------|
| Variaveis | camelCase | nomeUsuario |
| Constantes | SCREAMING_SNAKE | MAX_TENTATIVAS |
| Funcoes | camelCase | buscarUsuario |
| Classes | PascalCase | ServicoUsuario |

## Exemplos de Codigo

[Inclua exemplos praticos]

## Configuracao de Lint

[Inclua configuracao]

## Skills Relacionadas

- `testes-de-linguagem`
- `seguranca-de-linguagem`
```

### Padrao 2: Skill de Fluxo de Trabalho

```markdown
---
name: fluxo-de-tarefa
description: Fluxo de trabalho passo a passo para [tarefa].
---

# Fluxo de Trabalho de [Tarefa]

## Quando Ativar

- [Gatilho 1]
- [Gatilho 2]

## Pre-requisitos

- [Requisito 1]
- [Requisito 2]

## Etapas

### Etapa 1: [Nome]

[Descricao]

\`\`\`bash
[Comandos]
\`\`\`

### Etapa 2: [Nome]

[Descricao]

## Verificacao

- [ ] [Verificacao 1]
- [ ] [Verificacao 2]

## Solucao de Problemas

| Problema | Solucao |
|----------|---------|
| [Problema] | [Solucao] |
```

### Padrao 3: Skill de Referencia

```markdown
---
name: referencia-de-api
description: Referencia rapida para [API/Biblioteca].
---

# Referencia de [API/Biblioteca]

## Quando Ativar

- Usando [API/Biblioteca]
- Consultando sintaxe de [API/Biblioteca]

## Operacoes Comuns

### Operacao 1

\`\`\`typescript
// Uso basico
\`\`\`

### Operacao 2

\`\`\`typescript
// Uso avancado
\`\`\`

## Configuracao

[Inclua exemplos de configuracao]

## Tratamento de Erros

[Inclua padroes de erro]
```

---

## Testando Sua Skill

### Teste Local

1. **Copie para o diretorio de skills do Gemini Code**:
   ```bash
   cp -r skills/nome-da-sua-skill ~/.gemini/skills/
   ```

2. **Teste com o Gemini Code**:
   ```
   Voce: "Preciso fazer [tarefa que deveria ativar sua skill]"

   O Gemini deve referenciar os padroes da sua skill.
   ```

3. **Verifique a ativacao**:
   - Peca ao Gemini para explicar um conceito da sua skill
   - Verifique se ele usa seus exemplos e padroes
   - Garanta que ele segue suas diretrizes

### Checklist de Validacao

- [ ] **Frontmatter YAML valido** - Sem erros de sintaxe
- [ ] **Nome segue a convencao** - minusculo-com-hifens
- [ ] **Descricao e clara** - Diz quando usar
- [ ] **Exemplos funcionam** - Codigo compila e executa
- [ ] **Links validos** - Skills relacionadas existem
- [ ] **Sem dados sensiveis** - Sem chaves de API, tokens, caminhos

### Testando Exemplos de Codigo

```bash
# Da raiz do repositorio
npx tsc --noEmit skills/nome-da-sua-skill/examples/*.ts

# Ou de dentro do diretorio da skill
npx tsc --noEmit examples/*.ts

# Da raiz do repositorio
python -m py_compile skills/nome-da-sua-skill/examples/*.py

# Ou de dentro do diretorio da skill
python -m py_compile examples/*.py

# Da raiz do repositorio
go build ./skills/nome-da-sua-skill/examples/...

# Ou de dentro do diretorio da skill
go build ./examples/...
```

---

## Submetendo Sua Skill

### 1. Faca Fork e Clone

```bash
gh repo fork Fmarzochi/EGC --clone
cd EGC
```

### 2. Crie uma Branch

```bash
git checkout -b feat/skill-nome-da-sua-skill
```

### 3. Adicione Sua Skill

```bash
mkdir -p skills/nome-da-sua-skill
# Crie o SKILL.md
```

### 4. Valide

```bash
# Verifique o frontmatter YAML
head -10 skills/nome-da-sua-skill/SKILL.md

# Verifique a estrutura
ls -la skills/nome-da-sua-skill/

# Execute os testes se disponiveis
npm test
```

### 5. Commit e Push

```bash
git add skills/nome-da-sua-skill/
git commit -s -m "feat(skills): adiciona skill nome-da-sua-skill"
git push -u origin feat/skill-nome-da-sua-skill
```

### 6. Crie o Pull Request

Use este template de PR:

```markdown
## Resumo

Descricao breve da skill e por que ela e valiosa.

## Tipo de Skill

- [ ] Padroes de linguagem
- [ ] Padroes de framework
- [ ] Fluxo de trabalho
- [ ] Conhecimento de dominio
- [ ] Integracao de ferramentas

## Testes

Como testei esta skill localmente.

## Checklist

- [ ] Frontmatter YAML valido
- [ ] Exemplos de codigo testados
- [ ] Segue as diretrizes de skills
- [ ] Sem dados sensiveis
- [ ] Gatilhos de ativacao claros
```

---

## Galeria de Exemplos

### Exemplo 1: Padroes de Linguagem

**Arquivo:** `skills/rust-patterns/SKILL.md`

```markdown
---
name: rust-patterns
description: Idiomas Rust, padroes de ownership e boas praticas para codigo seguro e idiomatico.
origin: egc
---

# Padroes Rust

## Quando Ativar

- Escrevendo codigo Rust
- Tratando ownership e borrowing
- Tratamento de erros com Result/Option
- Implementando traits

## Padroes de Ownership

### Regras de Borrowing

\`\`\`rust
// BOM: Empreste quando nao precisar de ownership
fn process_data(data: &str) -> usize {
    data.len()
}

// BOM: Tome ownership quando precisar modificar ou consumir
fn consume_data(data: Vec<u8>) -> String {
    String::from_utf8(data).unwrap()
}
\`\`\`

## Tratamento de Erros

### Padrao Result

\`\`\`rust
use thiserror::Error;

#[derive(Error, Debug)]
pub enum AppError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Parse error: {0}")]
    Parse(#[from] std::num::ParseIntError),
}

pub type AppResult<T> = Result<T, AppError>;
\`\`\`

## Skills Relacionadas

- `rust-testing`
- `rust-security`
```

### Exemplo 2: Padroes de Framework

**Arquivo:** `skills/fastapi-patterns/SKILL.md`

```markdown
---
name: fastapi-patterns
description: Padroes FastAPI para roteamento, injecao de dependencia, validacao e operacoes async.
origin: egc
---

# Padroes FastAPI

## Quando Ativar

- Construindo aplicacoes FastAPI
- Criando endpoints de API
- Implementando injecao de dependencia
- Lidando com operacoes async de banco de dados

## Estrutura do Projeto

\`\`\`
app/
+-- main.py              # Entrypoint da aplicacao FastAPI
+-- routers/             # Handlers de rota
|   +-- users.py
|   +-- items.py
+-- models/              # Modelos Pydantic
|   +-- user.py
|   +-- item.py
+-- services/            # Logica de negocio
|   +-- user_service.py
+-- dependencies.py      # Dependencias compartilhadas
\`\`\`

## Injecao de Dependencia

\`\`\`python
from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

async def get_db() -> AsyncSession:
    async with AsyncSessionLocal() as session:
        yield session

@router.get("/users/{user_id}")
async def get_user(
    user_id: int,
    db: AsyncSession = Depends(get_db)
):
    pass
\`\`\`

## Skills Relacionadas

- `python-patterns`
- `pydantic-validation`
```

### Exemplo 3: Skill de Fluxo de Trabalho

**Arquivo:** `skills/refactoring-workflow/SKILL.md`

```markdown
---
name: refactoring-workflow
description: Fluxo de trabalho sistematico de refatoracao para melhorar a qualidade do codigo sem alterar o comportamento.
origin: egc
---

# Fluxo de Trabalho de Refatoracao

## Quando Ativar

- Melhorando estrutura de codigo
- Reduzindo divida tecnica
- Simplificando codigo complexo
- Extraindo componentes reutilizaveis

## Pre-requisitos

- Todos os testes passando
- Diretorio de trabalho Git limpo
- Branch de feature criada

## Etapas do Fluxo de Trabalho

### Etapa 1: Identifique o Alvo da Refatoracao

- Procure code smells (metodos longos, codigo duplicado, classes grandes)
- Verifique a cobertura de testes para a area alvo
- Documente o comportamento atual

### Etapa 2: Garanta que Existem Testes

\`\`\`bash
# Execute os testes para verificar o comportamento atual
npm test

# Verifique a cobertura para os arquivos alvo
npm run test:coverage
\`\`\`

### Etapa 3: Faca Pequenas Mudancas

- Uma refatoracao por vez
- Execute testes apos cada mudanca
- Commit frequentemente

### Etapa 4: Verifique que o Comportamento Nao Mudou

\`\`\`bash
# Execute o suite completo de testes
npm test

# Execute testes E2E
npm run test:e2e
\`\`\`

## Refatoracoes Comuns

| Smell | Refatoracao |
|-------|-------------|
| Metodo longo | Extrair metodo |
| Codigo duplicado | Extrair para funcao compartilhada |
| Classe grande | Extrair classe |
| Lista longa de parametros | Introduzir objeto de parametro |

## Checklist

- [ ] Testes existem para o codigo alvo
- [ ] Fiz mudancas pequenas e focadas
- [ ] Testes passam apos cada mudanca
- [ ] Comportamento nao mudou
- [ ] Commit feito com mensagem clara
```

---

## Recursos Adicionais

- [CONTRIBUTING.md](../../.github/CONTRIBUTING.md) - Diretrizes gerais de contribuicao
- [project-guidelines-template](./examples/project-guidelines-template.md) - Template de skill especifica de projeto
- [coding-standards](../skills/coding-standards/SKILL.md) - Exemplo de skill de padroes
- [tdd-workflow](../skills/tdd-workflow/SKILL.md) - Exemplo de skill de fluxo de trabalho
- [security-review](../skills/security-review/SKILL.md) - Exemplo de skill de conhecimento de dominio

---

**Lembre-se**: Uma boa skill e focada, acionavel e imediatamente util. Escreva skills que voce mesmo gostaria de usar.
