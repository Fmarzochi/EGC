# Design de Instalacao Seletiva do egc

## Proposito

Este documento define o design de instalacao seletiva voltado ao usuario para o egc.

Ele complementa `docs/SELECTIVE-INSTALL-ARCHITECTURE.md`, que foca na arquitetura interna de runtime e limites de codigo.

Este documento responde primeiro as perguntas de produto e operador:

- como os usuarios escolhem componentes do egc
- como a CLI deve se sentir
- qual arquivo de configuracao deve existir
- como a instalacao deve se comportar entre targets de harness
- como o design mapeia no codebase atual do egc sem exigir uma reescrita

## Problema

Hoje o egc ainda parece um instalador de payload grande, mesmo que o repositorio agora tenha suporte de manifesto e ciclo de vida de primeira passagem.

Os usuarios precisam de um modelo mental mais simples:

- instalar a baseline
- adicionar os pacotes de linguagem que realmente usam
- adicionar as configuracoes de framework que realmente querem
- adicionar pacotes de capacidade opcionais como seguranca, pesquisa ou orquestracao

O sistema de instalacao seletiva deve fazer o egc parecer composavel em vez de tudo ou nada.

No substrato atual, os componentes voltados ao usuario ainda sao uma camada de alias sobre modulos de instalacao internos mais grosseiros. Isso significa que incluir/excluir ja e util no nivel de selecao de modulo, mas alguns limites em nivel de arquivo permanecem imperfeitos ate que o grafo de modulos subjacente seja dividido de forma mais refinada.

## Objetivos

1. Deixar usuarios instalar um footprint pequeno e padrao do egc rapidamente.
2. Deixar usuarios compor instalacoes de familias de componentes reutilizaveis:
   - regras core
   - pacotes de linguagem
   - pacotes de framework
   - pacotes de capacidade
   - configuracoes de target/plataforma
3. Manter um UX consistente entre gemini, Cursor, Antigravity, Codex e OpenCode.
4. Manter instalacoes inspetaveis, repara­veis e desinstalaveis.
5. Preservar compatibilidade retroativa com o estilo atual `egc-install typescript` durante o rollout.

## Nao-Objetivos

- empacotar o egc em multiplos pacotes npm na primeira fase
- construir um marketplace remoto
- construir uma UI de plano de controle completo na mesma fase
- resolver todos os problemas de classificacao de skills antes de lancar a instalacao seletiva

## Principios de Experiencia do Usuario

### 1. Comece Pequeno

Um usuario deve poder obter uma instalacao util do egc com um comando:

```bash
egc install --target gemini --profile core
```

A experiencia padrao nao deve assumir que o usuario quer todas as familias de skills e todos os frameworks.

### 2. Construa por Intencao

O usuario deve pensar em termos de:

- "Quero a baseline de desenvolvedor"
- "Preciso de TypeScript e Python"
- "Quero Next.js e Django"
- "Quero o pacote de seguranca"

O usuario nao deve precisar conhecer os caminhos internos brutos do repositorio.

### 3. Visualize Antes de Mutar

Todo caminho de instalacao deve suportar planejamento em dry-run:

```bash
egc install --target cursor --profile developer --with lang:typescript --with framework:nextjs --dry-run
```

O plano deve mostrar claramente:

- componentes selecionados
- componentes ignorados
- raiz do target
- caminhos gerenciados
- localizacao esperada do install-state

### 4. Configuracao Local Deve Ser de Primeira Classe

Equipes devem poder commitar uma configuracao de instalacao em nivel de projeto e usar:

```bash
egc install --config egc-install.json
```

Isso permite instalacoes deterministas entre colaboradores e CI.

## Modelo de Componentes

O manifesto atual ja usa modulos e perfis de instalacao. O design voltado ao usuario deve manter essa estrutura interna, mas apresenta-la como quatro familias principais de componentes.

Nota de implementacao de curto prazo: alguns IDs de componentes voltados ao usuario ainda resolvem para modulos internos compartilhados, especialmente na camada de linguagem/framework. O catalogo melhora o UX imediatamente enquanto preserva um caminho limpo em direcao a granularidade de modulo mais refinada em fases posteriores.

### 1. Baseline

Estes sao os blocos de construcao padrao do egc:

- regras core
- agentes baseline
- comandos core
- hooks de runtime
- configuracoes de plataforma
- primitivos de qualidade de workflow

Exemplos de modulos internos atuais:

- `rules-core`
- `agents-core`
- `commands-core`
- `hooks-runtime`
- `platform-configs`
- `workflow-quality`

### 2. Pacotes de Linguagem

Pacotes de linguagem agrupam regras, orientacao e workflows para um ecossistema de linguagem.

Exemplos:

- `lang:typescript`
- `lang:python`
- `lang:go`
- `lang:java`
- `lang:rust`

Cada pacote de linguagem deve resolver para um ou mais modulos internos mais ativos especificos do target.

### 3. Pacotes de Framework

Pacotes de framework ficam acima dos pacotes de linguagem e puxam regras, skills e configuracao opcional especificos do framework.

Exemplos:

- `framework:react`
- `framework:nextjs`
- `framework:django`
- `framework:springboot`
- `framework:laravel`

Pacotes de framework devem depender do pacote de linguagem correto ou de primitivos baseline onde apropriado.

### 4. Pacotes de Capacidade

Pacotes de capacidade sao bundles de features do egc que cortam transversalmente.

Exemplos:

- `capability:security`
- `capability:research`
- `capability:orchestration`
- `capability:media`
- `capability:content`

Estes devem mapear para as familias de modulo atuais ja sendo introduzidas nos manifestos.

## Perfis

Perfis permanecem a entrada mais rapida.

Perfis voltados ao usuario recomendados:

- `core`
  baseline minima, padrao seguro para a maioria dos usuarios experimentando o egc
- `developer`
  melhor padrao para trabalho ativo de engenharia de software
- `security`
  baseline mais orientacao pesada de seguranca
- `research`
  baseline mais ferramentas de pesquisa/conteudo/investigacao
- `full`
  tudo classificado e atualmente suportado

Perfis devem ser composaveis com flags adicionais `--with` e `--without`.

Exemplo:

```bash
egc install --target gemini --profile developer --with lang:typescript --with framework:nextjs --without capability:orchestration
```

## Design CLI Proposto

### Comandos Primarios

```bash
egc install
egc plan
egc list-installed
egc doctor
egc repair
egc uninstall
egc catalog
```

### CLI de Instalacao

Forma recomendada:

```bash
egc install [--target <target>] [--profile <nome>] [--with <componente>]... [--without <componente>]... [--config <caminho>] [--dry-run] [--json]
```

Exemplos:

```bash
egc install --target gemini --profile core
egc install --target cursor --profile developer --with lang:typescript --with framework:nextjs
egc install --target antigravity --with capability:security --with lang:python
egc install --config egc-install.json
```

### CLI de Plano

Forma recomendada:

```bash
egc plan [mesmas flags de selecao que install]
```

Proposito:

- produzir uma visualizacao sem mutacao
- atuar como a superficie canonical de depuracao para instalacao seletiva

### CLI de Catalogo

Forma recomendada:

```bash
egc catalog profiles
egc catalog components
egc catalog components --family language
egc catalog show framework:nextjs
```

Proposito:

- deixar usuarios descobrir nomes de componentes validos sem ler docs
- tornar a criacao de configuracao acessivel

### CLI de Compatibilidade

Esses fluxos legados ainda devem funcionar durante a migracao:

```bash
egc-install typescript
egc-install --target cursor typescript
egc typescript
```

Internamente, esses devem normalizar para o novo modelo de requisicao e escrever o install-state da mesma forma que instalacoes modernas.

## Arquivo de Configuracao Proposto

### Nome do Arquivo

Padrao recomendado:

- `egc-install.json`

Suporte futuro opcional:

- `.egc/install.json`

### Forma da Configuracao

```json
{
  "$schema": "./schemas/egc-install-config.schema.json",
  "version": 1,
  "target": "cursor",
  "profile": "developer",
  "include": [
    "lang:typescript",
    "lang:python",
    "framework:nextjs",
    "capability:security"
  ],
  "exclude": [
    "capability:media"
  ],
  "options": {
    "hooksProfile": "standard",
    "mcpCatalog": "baseline",
    "includeExamples": false
  }
}
```

### Semantica dos Campos

- `target`
  target de harness selecionado como `gemini`, `cursor` ou `antigravity`
- `profile`
  perfil baseline para comecar
- `include`
  componentes adicionais para adicionar
- `exclude`
  componentes para subtrair do resultado do perfil
- `options`
  flags de ajuste de target/runtime que nao alteram a identidade do componente

### Regras de Precedencia

1. Argumentos CLI substituem valores do arquivo de configuracao.
2. Arquivo de configuracao substitui padroes do perfil.
3. Padroes do perfil substituem padroes de modulo interno.

Isso manteve o comportamento previsivel e facil de explicar.

## Fluxo de Instalacao Modular

O fluxo voltado ao usuario deve ser:

1. carregar arquivo de configuracao se fornecido ou auto-detectado
2. mesclar intencao CLI sobre intencao de configuracao
3. normalizar a requisicao em uma selecao canonical
4. expandir perfil em componentes baseline
5. adicionar componentes `include`
6. subtrair componentes `exclude`
7. resolver dependencias e compatibilidade de target
8. renderizar um plano
9. aplicar operacoes se nao estiver em modo dry-run
10. escrever install-state

A propriedade de UX importante e que o mesmo fluxo alimenta:

- `install`
- `plan`
- `repair`
- `uninstall`

Os comandos diferem em acao, nao em como o egc entende a instalacao selecionada.

## Comportamento de Target

A instalacao seletiva deve preservar o mesmo grafo conceitual de componentes entre todos os targets, enquanto deixa adaptadores de target decidir como o conteudo fica.

### gemini

Mais adequado para:

- baseline egc com escopo de home
- comandos, agentes, regras, hooks, config de plataforma, orquestracao

### Cursor

Mais adequado para:

- instalacoes com escopo de projeto
- regras mais automacao e configuracao local ao projeto

### Antigravity

Mais adequado para:

- instalacoes de agente/regra/workflow com escopo de projeto

### Codex / OpenCode

Devem permanecer como targets aditivos em vez de forks especiais do instalador.

O design de instalacao seletiva deve tornar esses apenas novos adaptadores mais novas regras de mapeamento especificas de target, nao novas arquiteturas de instalador.

## Viabilidade Tecnica

Este design e viavel porque o repositorio ja tem:

- manifestos de modulo e perfil de instalacao
- adaptadores de target com caminhos de install-state
- inspecao de plano
- registro de install-state
- comandos de ciclo de vida
- uma superficie CLI `egc` unificada

O trabalho ausente nao e invencao conceitual. O trabalho ausente e produtizar o substrato atual em um modelo de componente voltado ao usuario mais limpo.

### Viavel na Fase 1

- selecao de perfil + include/exclude
- analise de arquivo de configuracao `egc-install.json`
- comando de catalogo/descoberta
- mapeamento de alias de IDs de componentes voltados ao usuario para conjuntos de modulos internos
- planejamento dry-run e JSON

### Viavel na Fase 2

- semantica de adaptador de target mais rica
- operacoes com reconhecimento de mesclagem para ativos semelhantes a configuracao
- comportamento mais forte de reparo/desinstalacao para operacoes nao de copia

### Depois

- superficie de publicacao reduzida
- bundles slim gerados
- busca remota de componentes

## Mapeamento para Manifestos Atuais do egc

Os manifestos atuais ainda nao expem uma taxonomia verdadeira voltada ao usuario `lang:*` / `framework:*` / `capability:*`. Isso deve ser introduzido como uma camada de apresentacao sobre os modulos existentes, nao como um segundo motor de instalador.

Abordagem recomendada:

- manter `install-modules.json` como o catalogo de resolucao interno
- adicionar um catalogo de componentes voltado ao usuario que mapeia IDs de componentes amigaveis para um ou mais modulos internos
- deixar perfis referenciar IDs de modulos internos ou IDs de componentes voltados ao usuario durante a janela de migracao

Isso evita quebrar o substrato atual de instalacao seletiva enquanto melhora o UX.

## Rollout Sugerido

### Fase 1: Design e Descoberta

- finalizar a taxonomia de componentes voltada ao usuario
- adicionar o schema de configuracao
- adicionar design de CLI e regras de precedencia

### Fase 2: Camada de Resolucao Voltada ao Usuario

- implementar aliases de componentes
- implementar analise de arquivo de configuracao
- implementar `include` / `exclude`
- implementar `catalog`

### Fase 3: Semantica de Target Mais Forte

- mover mais logica para planejamento de propriedade do adaptador de target
- suportar operacoes de mesclagem/geracao de forma limpa
- melhorar fidelidade de reparo/desinstalacao

### Fase 4: Otimizacao de Empacotamento

- reduzir superficie publicada
- avaliar bundles gerados

## Recomendacao

O proximo movimento de implementacao nao deve ser "reescrever o instalador."

Deve ser:

1. manter o substrato atual de manifesto/runtime
2. adicionar um catalogo de componentes voltado ao usuario e arquivo de configuracao
3. adicionar selecao `include` / `exclude` e descoberta de catalogo
4. deixar o stack existente de planner e ciclo de vida consumir esse modelo

Esse e o caminho mais curto do codebase atual do egc para uma experiencia real de instalacao seletiva que parece egc 2.0 em vez de um instalador legado grande.
