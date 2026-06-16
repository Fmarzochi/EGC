# Descoberta de Instalacao Seletiva do egc 2.0

## Proposito

Este documento transforma o requisito de instalacao seletiva do mega-plano de 11 de marco em um design concreto de descoberta do egc 2.0.

O objetivo nao e apenas "menos arquivos copiados durante a instalacao." O alvo real e um sistema de instalacao que pode responder, deterministicamente:

- o que foi solicitado
- o que foi resolvido
- o que foi copiado ou gerado
- quais transforms especificas de target foram aplicadas
- o que o egc possui e pode remover ou reparar com seguranca depois

Esse e o contrato ausente entre a instalacao do egc 1.x e um plano de controle do egc 2.0.

## Fundacao Implementada Atual

O primeiro substrato de instalacao seletiva ja existe no repositorio:

- `manifests/install-modules.json`
- `manifests/install-profiles.json`
- `schemas/install-modules.schema.json`
- `schemas/install-profiles.schema.json`
- `schemas/install-state.schema.json`
- `scripts/ci/validate-install-manifests.js`
- `scripts/lib/install-manifests.js`
- `scripts/lib/install/request.js`
- `scripts/lib/install/runtime.js`
- `scripts/lib/install/apply.js`
- `scripts/lib/install-targets/`
- `scripts/lib/install-state.js`
- `scripts/lib/install-executor.js`
- `scripts/lib/install-lifecycle.js`
- `scripts/egc.js`
- `scripts/install-apply.js`
- `scripts/install-plan.js`
- `scripts/list-installed.js`
- `scripts/doctor.js`

Capacidades atuais:

- catalogos de modulo e perfil legivel por maquina
- validacao CI que entradas de manifesto apontam para caminhos reais do repositorio
- expansao de dependencia e filtragem de target
- planejamento de operacao com reconhecimento de adaptador
- normalizacao canonical de requisicao para modos de instalacao legados e de manifesto
- despacho de runtime explicito de requisicoes normalizadas em criacao de plano
- instalacoes legadas e de manifesto escrevem install-state duravel
- inspecao somente leitura de planos de instalacao antes de qualquer mutacao
- roteamento CLI unificado `egc` para instalacao, planejamento e comandos de ciclo de vida
- inspecao e mutacao de ciclo de vida via `list-installed`, `doctor`, `repair` e `uninstall`

Limitacao atual:

- semantica de mesclagem/remocao especifica de target ainda esta em nivel de scaffold para alguns modulos
- compatibilidade legada com `egc-install` ainda aponta para `install.sh`
- superficie de publicacao ainda e ampla em `package.json`

## Revisao do Codigo Atual

O stack de instalador atual ja e muito mais saudavel do que o instalador shell legado orientado a linguagem original, mas ainda concentra muita responsabilidade em poucos arquivos.

### Caminho de Runtime Atual

O fluxo de runtime hoje e:

1. `install.sh`
   thin shell wrapper que resolve a raiz real do pacote
2. `scripts/install-apply.js`
   CLI de instalador voltado ao usuario para modos legado e de manifesto
3. `scripts/lib/install/request.js`
   analise de CLI mais normalizacao canonical de requisicao
4. `scripts/lib/install/runtime.js`
   despacho de runtime de requisicoes normalizadas em planos de instalacao
5. `scripts/lib/install-executor.js`
   traducao de argumentos, compatibilidade legada, materializacao de operacao, mutacao de sistema de arquivos e escrita de install-state
6. `scripts/lib/install-manifests.js`
   carregamento de catalogo de modulo/perfil mais expansao de dependencia
7. `scripts/lib/install-targets/`
   scaffold de raiz de target e caminho de destino
8. `scripts/lib/install-state.js`
   leitura/escrita de install-state com schema
9. `scripts/lib/install-lifecycle.js`
   comportamento de doctor/repair/uninstall derivado de operacoes armazenadas

Isso e suficiente para provar o substrato de instalacao seletiva, mas nao suficiente para fazer a arquitetura do instalador parecer estabelecida.

### Pontos Fortes Atuais

- intencao de instalacao agora e explicita por meio de `--profile` e `--modules`
- analise de requisicao e normalizacao de requisicao agora estao separadas do shell CLI
- resolucao de raiz de target ja esta adaptadorizada
- comandos de ciclo de vida agora usam install-state duravel em vez de adivinhar
- o repositorio ja tem um entrypoint Node unificado por meio de `egc` e `install-apply.js`

### Acoplamento Atual Ainda Presente

1. `install-executor.js` e menor do que antes, mas ainda carrega muitas camadas de planejamento e materializacao ao mesmo tempo.
   O limite de requisicao agora esta extraido, mas traducao de requisicao legada, expansao de plano de manifesto e materializacao de operacao ainda coexistem.
2. Adaptadores de target ainda sao muito finos.
   Hoje eles principalmente resolvem raizes e constroem caminhos de destino. A semantica real de instalacao ainda vive em branches de executor e heuristicas de caminho.
3. O limite planner/executor ainda nao esta suficientemente limpo.
   `install-manifests.js` resolve modulos, mas o conjunto final de operacoes de instalacao ainda esta parcialmente construido em logica especifica do executor.
4. Comportamento de ciclo de vida depende de operacoes registradas de baixo nivel mais do que de semanticas de modulo estaveis.
   Isso funciona para copia de arquivo simples, mas torna-se fragil para comportamentos de mesclagem/geracao/remocao.
5. O modo de compatibilidade esta misturado diretamente no runtime principal do instalador.
   Instalacoes de linguagem legadas devem se comportar como um adaptador de requisicao, nao como uma arquitetura de instalador paralela.

## Mudancas Arquiteturais Modulares Propostas

O proximo passo arquitetural e separar o instalador em camadas explicitas, com cada camada retornando dados estaveis em vez de imediatamente mutando arquivos.

### Estado Alvo

O pipeline de instalacao desejado e:

1. Superficie CLI
2. normalizacao de requisicao
3. resolucao de modulo
4. planejamento de target
5. planejamento de operacao
6. execucao
7. persistencia de install-state
8. servicos de ciclo de vida construidos no mesmo contrato de operacao

A ideia principal e simples:

- manifestos descrevem conteudo
- adaptadores descrevem semantica de aterrissagem especifica de target
- planners descrevem o que deve acontecer
- executores aplicam esses planos
- comandos de ciclo de vida reutilizam o mesmo modelo de plano/estado em vez de reinventa-lo

### Camadas de Runtime Propostas

#### 1. Superficie CLI

Responsabilidade:

- analisar somente intencao do usuario
- rotear para install, plan, doctor, repair, uninstall
- renderizar saida humana ou JSON

Nao deve possuir:

- traducao de linguagem legada
- regras de instalacao especificas de target
- construcao de operacao

Arquivos sugeridos:

```text
scripts/egc.js
scripts/install-apply.js
scripts/install-plan.js
scripts/doctor.js
scripts/repair.js
scripts/uninstall.js
```

Esses permanecem como entrypoints, mas tornam-se thin wrappers em torno de modulos de biblioteca.

#### 2. Normalizador de Requisicao

Responsabilidade:

- traduzir flags CLI brutas em uma requisicao de instalacao canonical
- converter instalacoes de linguagem legadas em uma forma de requisicao de compatibilidade
- rejeitar entradas mistas ou ambiguas cedo

Requisicao canonical sugerida:

```json
{
  "mode": "manifest",
  "target": "cursor",
  "profile": "developer",
  "modules": [],
  "legacyLanguages": [],
  "dryRun": false
}
```

ou, em modo de compatibilidade:

```json
{
  "mode": "legacy-compat",
  "target": "gemini",
  "profile": null,
  "modules": [],
  "legacyLanguages": ["typescript", "python"],
  "dryRun": false
}
```

Isso deixa o resto do pipeline ignorar se a requisicao veio de sintaxe CLI antiga ou nova.

#### 3. Resolvedor de Modulos

Responsabilidade:

- carregar catalogos de manifesto
- expandir dependencias
- rejeitar conflitos
- filtrar modulos nao suportados por target
- retornar um objeto de resolucao canonical

Esta camada deve permanecer pura e somente leitura.

Nao deve saber:

- caminhos de destino no sistema de arquivos
- semantica de mesclagem
- estrategias de copia

Arquivo mais proximo atual:

- `scripts/lib/install-manifests.js`

Divisao sugerida:

```text
scripts/lib/install/catalog.js
scripts/lib/install/resolve-request.js
scripts/lib/install/resolve-modules.js
```

#### 4. Planner de Target

Responsabilidade:

- selecionar o adaptador de target de instalacao
- resolver a raiz do target
- resolver o caminho do install-state
- expandir regras de mapeamento de modulo para target
- emitir intencoes de operacao com reconhecimento de target

E aqui que o significado especifico de target deve viver.

Exemplos:

- gemini pode preservar a hierarquia nativa em `~/.gemini`
- Cursor pode sincronizar filhos da raiz `.cursor` empacotados de forma diferente das regras
- configuracoes geradas podem exigir semantica de mesclagem ou substituicao dependendo do target

Arquivos mais proximos atuais:

- `scripts/lib/install-targets/helpers.js`
- `scripts/lib/install-targets/registry.js`

Evolucao sugerida:

```text
scripts/lib/install/targets/registry.js
scripts/lib/install/targets/gemini-home.js
scripts/lib/install/targets/cursor-project.js
scripts/lib/install/targets/antigravity-project.js
```

Cada adaptador deve eventualmente expor mais do que `resolveRoot`. Deve possuir mapeamento de caminho e estrategia para sua familia de target.

#### 5. Planner de Operacao

Responsabilidade:

- transformar resolucao de modulo mais regras de adaptador em um grafo de operacao tipado
- emitir operacoes de primeira classe como:
  - `copy-file`
  - `copy-tree`
  - `merge-json`
  - `render-template`
  - `remove`
- anexar metadados de propriedade e validacao

Esta e a costura arquitetural ausente no instalador atual.

Hoje, operacoes sao parcialmente em nivel de scaffold e parcialmente especificas do executor. O egc 2.0 deve tornar o planejamento de operacao uma fase independente para que:

- `plan` se torne uma visualizacao verdadeira da execucao
- `doctor` possa validar comportamento pretendido, nao apenas arquivos atuais
- `repair` possa reconstruir o trabalho ausente exato com seguranca
- `uninstall` possa reverter apenas operacoes gerenciadas

#### 6. Motor de Execucao

Responsabilidade:

- aplicar um grafo de operacao tipado
- aplicar regras de sobrescrita e propriedade
- preparar escritas com seguranca
- coletar resultados finais de operacoes aplicadas

Esta camada nao deve decidir *o que* fazer. Deve decidir apenas *como* aplicar um tipo de operacao fornecido com seguranca.

Arquivo mais proximo atual:

- `scripts/lib/install-executor.js`

Refatoracao recomendada:

```text
scripts/lib/install/executor/apply-plan.js
scripts/lib/install/executor/apply-copy.js
scripts/lib/install/executor/apply-merge-json.js
scripts/lib/install/executor/apply-remove.js
```

Isso transforma a logica do executor de um grande runtime ramificado em um conjunto de pequenos handlers de operacao.

#### 7. Armazenamento de Install-State

Responsabilidade:

- validar e persistir install-state
- registrar requisicao canonical, resolucao e operacoes aplicadas
- suportar comandos de ciclo de vida sem forca-los a fazer engenharia reversa das instalacoes

Arquivo mais proximo atual:

- `scripts/lib/install-state.js`

Esta camada ja esta perto da forma certa. A principal mudanca restante e armazenar metadados de operacao mais ricos assim que semantica de mesclagem/geracao for real.

#### 8. Servicos de Ciclo de Vida

Responsabilidade:

- `list-installed`: inspecionar somente estado
- `doctor`: comparar visao desejada/install-state com o sistema de arquivos atual
- `repair`: regenerar um plano a partir do estado e reaplicar operacoes seguras
- `uninstall`: remover apenas saidas de propriedade do egc

Arquivo mais proximo atual:

- `scripts/lib/install-lifecycle.js`

Esta camada deve eventualmente operar em tipos de operacao e politicas de propriedade, nao apenas em registros brutos `copy-file`.

## Layout de Arquivo Proposto

O estado final modular limpo deve parecer aproximadamente com isso:

```text
scripts/lib/install/
  catalog.js
  request.js
  resolve-modules.js
  plan-operations.js
  state-store.js
  targets/
    registry.js
    gemini-home.js
    cursor-project.js
    antigravity-project.js
    codex-home.js
    opencode-home.js
  executor/
    apply-plan.js
    apply-copy.js
    apply-merge-json.js
    apply-render-template.js
    apply-remove.js
  lifecycle/
    discover.js
    doctor.js
    repair.js
    uninstall.js
```

Isso nao e uma divisao de empacotamento. E uma divisao de propriedade de codigo dentro do repositorio atual para que cada camada tenha um trabalho.

## Mapa de Migracao dos Arquivos Atuais

O caminho de migracao de menor risco e evolutivo, nao uma reescrita.

### Manter

- `install.sh` como o shim de compatibilidade publico
- `scripts/egc.js` como a CLI unificada
- `scripts/lib/install-state.js` como ponto de partida para o store de estado
- IDs de adaptadores de target atuais e localizacoes de estado

### Extrair

- analise de requisicao e traducao de compatibilidade fora de `scripts/lib/install-executor.js`
- planejamento de operacao com reconhecimento de target fora de branches de executor e para adaptadores de target mais modulos de planner
- analise especifica de ciclo de vida fora do monolito de ciclo de vida compartilhado em servicos menores

### Substituir Gradualmente

- heuristicas amplas de copia de caminho com operacoes tipadas
- planejamento de adaptador somente scaffold com semanticas de propriedade do adaptador
- branches de instalacao de linguagem legada com traducao de requisicao legada no mesmo pipeline de planner/executor

## Mudancas Arquiteturais Imediatas a Fazer

Se o objetivo e egc 2.0 e nao apenas "funcionando suficientemente," os proximos passos de modularizacao devem ser:

1. dividir `install-executor.js` em modulos de normalizacao de requisicao, planejamento de operacao e execucao
2. mover decisoes de estrategia especificas de target para metodos de planejamento de propriedade do adaptador
3. fazer `repair` e `uninstall` operarem em handlers de operacao tipados em vez de apenas registros `copy-file` simples
4. ensinar os manifestos sobre estrategia de instalacao e propriedade para que o planner nao dependa mais de heuristicas de caminho
5. reduzir a superficie de publicacao npm somente apos os limites do modulo interno estarem estaveis

## Por que o Modelo Atual Nao e Suficiente

Hoje o egc ainda se comporta como um copiador amplo de payload:

- `install.sh` e orientado a linguagem e com branches de target pesados
- targets sao parcialmente implicitos no layout de diretorio
- desinstalacao, reparo e doctor agora existem mas ainda sao comandos de ciclo de vida iniciais
- o repositorio nao pode provar o que uma instalacao anterior realmente escreveu
- a superficie de publicacao ainda e ampla em `package.json`

Isso cria os problemas ja mencionados no mega plano:

- usuarios puxam mais conteudo do que seu harness ou workflow precisa
- suporte e atualizacoes sao mais dificeis porque instalacoes nao sao registradas
- comportamento de target diverge porque logica de instalacao e duplicada em branches shell
- targets futuros como Codex ou OpenCode exigem mais logica de caso especial em vez de reutilizar um contrato de instalacao estavel

## Tese de Design do egc 2.0

A instalacao seletiva deve ser modelada como:

1. resolver a intencao solicitada em um grafo de modulo canonical
2. traduzir esse grafo por meio de um adaptador de target
3. executar um conjunto de operacoes de instalacao determinista
4. escrever install-state como a fonte de verdade duravel

Isso significa que o egc 2.0 precisa de dois contratos, nao um:

- um contrato de conteudo: quais modulos existem e como dependem uns dos outros
- um contrato de target: como esses modulos ficam dentro de gemini, Cursor, Antigravity, Codex ou OpenCode

O repositorio atual tinha apenas a primeira metade em forma inicial. O repositorio atual agora tem o primeiro slice vertical completo, mas nao a semantica especifica de target completa.

## Restricoes de Design

1. Manter `EGC` como o repositorio de fonte canonical.
2. Preservar fluxos de `install.sh` existentes durante a migracao.
3. Suportar targets com escopo de home e de projeto do mesmo planner.
4. Tornar desinstalacao/reparo/doctor possiveis sem adivinhar.
5. Evitar que logica de copia especifica de target volte para definicoes de modulo.
6. Manter suporte futuro a Codex e OpenCode aditivo, nao uma reescrita.

## Artefatos Canonicos

### 1. Catalogo de Modulos

O catalogo de modulos e o grafo de conteudo canonical.

Campos atuais ja implementados:

- `id`
- `kind`
- `description`
- `paths`
- `targets`
- `dependencies`
- `defaultInstall`
- `cost`
- `stability`

Campos ainda necessarios para o egc 2.0:

- `installStrategy`: por exemplo `copy`, `flatten-rules`, `generate`, `merge-config`
- `ownership`: se o egc possui totalmente o caminho de destino ou apenas arquivos gerados abaixo dele
- `pathMode`: por exemplo `preserve`, `flatten`, `target-template`
- `conflicts`: modulos ou familias de caminho que nao podem coexistir em um target
- `publish`: se o modulo e empacotado por padrao, opcional ou gerado pos-instalacao

Forma futura sugerida:

```json
{
  "id": "hooks-runtime",
  "kind": "hooks",
  "paths": ["hooks", "scripts/hooks"],
  "targets": ["gemini", "cursor", "opencode"],
  "dependencies": [],
  "installStrategy": "copy",
  "pathMode": "preserve",
  "ownership": "managed",
  "defaultInstall": true,
  "cost": "medium",
  "stability": "stable"
}
```

### 2. Catalogo de Perfis

Perfis permanecem finos.

Devem expressar intencao do usuario, nao duplicar logica de target.

Exemplos atuais ja implementados:

- `core`
- `developer`
- `security`
- `research`
- `full`

Campos ainda necessarios:

- `defaultTargets`
- `recommendedFor`
- `excludes`
- `requiresConfirmation`

Isso deixa o egc 2.0 dizer coisas como:

- `developer` e o padrao recomendado para gemini e Cursor
- `research` pode ser pesado para instalacoes locais estreitas
- `full` e permitido mas nao padrao

### 3. Adaptadores de Target

Esta e a camada ausente principal.

O grafo de modulo nao deve saber:

- onde fica o home do gemini
- como o Cursor nivela ou remapeia conteudo
- quais arquivos de configuracao precisam de semantica de mesclagem em vez de copia cega

Isso pertence a um adaptador de target.

Interface sugerida:

```ts
type InstallTargetAdapter = {
  id: string;
  kind: "home" | "project";
  supports(target: string): boolean;
  resolveRoot(input?: string): Promise<string>;
  planOperations(input: InstallOperationInput): Promise<InstallOperation[]>;
  validate?(input: InstallOperationInput): Promise<ValidationIssue[]>;
};
```

Primeiros adaptadores sugeridos:

1. `gemini-home`: escreve em `~/.gemini/...`
2. `cursor-project`: escreve em `./.cursor/...`
3. `antigravity-project`: escreve em `./.agent/...`
4. `codex-home`: depois
5. `opencode-home`: depois

Isso corresponde ao mesmo padrao ja proposto no documento de descoberta de adaptador de sessao: contrato canonical primeiro, adaptador especifico de harness segundo.

## Modelo de Planejamento de Instalacao

A CLI atual `scripts/install-plan.js` prova que o repositorio pode resolver modulos solicitados em um conjunto de modulos filtrado.

O egc 2.0 precisa da proxima camada: planejamento de operacao.

Fases sugeridas:

1. normalizacao de entrada: analisar `--target`, `--profile`, `--modules`, traduzir args de linguagem legados opcionalmente
2. resolucao de modulo: expandir dependencias, rejeitar conflitos, filtrar por targets suportados
3. planejamento de adaptador: resolver raiz do target, derivar operacoes exatas de copia ou geracao, identificar mesclagens de configuracao e remapeamentos de target
4. saida dry-run: mostrar modulos selecionados, modulos ignorados, operacoes exatas de arquivo
5. mutacao: executar o plano de operacao
6. escrita de estado: persistir install-state somente apos conclusao bem-sucedida

Forma de operacao sugerida:

```json
{
  "kind": "copy",
  "moduleId": "rules-core",
  "source": "rules/common/coding-style.md",
  "destination": "/Users/example/.gemini/rules/egc/common/coding-style.md",
  "ownership": "managed",
  "overwritePolicy": "replace"
}
```

Outros tipos de operacao:

- `copy`
- `copy-tree`
- `flatten-copy`
- `render-template`
- `merge-json`
- `merge-jsonc`
- `mkdir`
- `remove`

## Contrato de Install-State

O install-state e o contrato duravel que o egc 1.x esta perdendo.

Convencoes de caminho sugeridas:

- target gemini: `~/.gemini/egc/install-state.json`
- target Cursor: `./.cursor/egc-install-state.json`
- target Antigravity: `./.agent/egc-install-state.json`
- target futuro Codex: `~/.codex/egc-install-state.json`

Payload sugerido:

```json
{
  "schemaVersion": "egc.install.v1",
  "installedAt": "2026-03-13T00:00:00Z",
  "lastValidatedAt": "2026-03-13T00:00:00Z",
  "target": {
    "id": "gemini-home",
    "root": "/Users/example/.gemini"
  },
  "request": {
    "profile": "developer",
    "modules": ["orchestration"],
    "legacyLanguages": ["typescript", "python"]
  },
  "resolution": {
    "selectedModules": [
      "rules-core",
      "agents-core",
      "commands-core",
      "hooks-runtime",
      "platform-configs",
      "workflow-quality",
      "framework-language",
      "database",
      "orchestration"
    ],
    "skippedModules": []
  },
  "source": {
    "repoVersion": "1.0.0",
    "repoCommit": "git-sha",
    "manifestVersion": 1
  },
  "operations": [
    {
      "kind": "copy",
      "moduleId": "rules-core",
      "destination": "/Users/example/.gemini/rules/egc/common/coding-style.md",
      "digest": "sha256:..."
    }
  ]
}
```

Requisitos de estado:

- detalhes suficientes para a desinstalacao remover apenas saidas gerenciadas pelo egc
- detalhes suficientes para o reparo comparar arquivos instalados desejados versus reais
- detalhes suficientes para o doctor explicar a deriva em vez de adivinhar

## Comandos de Ciclo de Vida

Os seguintes comandos sao a superficie de ciclo de vida para install-state:

1. `egc list-installed`
2. `egc uninstall`
3. `egc doctor`
4. `egc repair`

Status de implementacao atual:

- `egc list-installed` roteia para `node scripts/list-installed.js`
- `egc uninstall` roteia para `node scripts/uninstall.js`
- `egc doctor` roteia para `node scripts/doctor.js`
- `egc repair` roteia para `node scripts/repair.js`
- entrypoints de script legados permanecem disponiveis durante a migracao

### `list-installed`

Responsabilidades:

- mostrar id e raiz do target
- mostrar perfil/modulos solicitados
- mostrar modulos resolvidos
- mostrar versao de fonte e hora de instalacao

### `uninstall`

Responsabilidades:

- carregar install-state
- remover apenas destinos gerenciados pelo egc registrados no estado
- deixar arquivos nao relacionados escritos pelo usuario intocados
- excluir install-state somente apos limpeza bem-sucedida

### `doctor`

Responsabilidades:

- detectar arquivos gerenciados ausentes
- detectar deriva de configuracao inesperada
- detectar raizes de target que nao existem mais
- detectar incompatibilidade de manifesto/versao

### `repair`

Responsabilidades:

- reconstruir o plano de operacao desejado a partir do install-state
- recopiar arquivos gerenciados ausentes ou derivados
- recusar reparo se os modulos solicitados nao existirem mais no manifesto atual, a menos que exista um mapa de compatibilidade

## Camada de Compatibilidade Legada

O `install.sh` atual aceita:

- `--target <gemini|cursor|antigravity>`
- uma lista de nomes de linguagens

Esse comportamento nao pode desaparecer em um corte porque os usuarios ja dependem dele.

O egc 2.0 deve traduzir argumentos de linguagem legados em uma requisicao de compatibilidade.

Abordagem sugerida:

1. manter a forma CLI existente para modo legado
2. mapear nomes de linguagens para requisicoes de modulo como `rules-core`, subconjuntos de regras compativeis com target
3. escrever install-state mesmo para instalacoes legadas
4. rotular a requisicao como `legacyMode: true`

Exemplo:

```json
{
  "request": {
    "legacyMode": true,
    "legacyLanguages": ["typescript", "python"]
  }
}
```

Isso mantem o comportamento antigo disponivel enquanto move todas as instalacoes para o mesmo contrato de estado.

## Limite de Publicacao

O pacote npm atual ainda publica um payload amplo por meio de `package.json`.

O egc 2.0 deve melhorar isso cuidadosamente.

Sequencia recomendada:

1. manter um unico pacote npm canonical primeiro
2. usar manifestos para direcionar a selecao em tempo de instalacao antes de alterar a forma de publicacao
3. apenas depois considerar reduzir a superficie empacotada onde seguro

Por que:

- instalacao seletiva pode ser lancada antes de cirurgia agressiva de pacote
- desinstalacao e reparo dependem de install-state mais do que de mudancas de publicacao
- suporte a Codex/OpenCode e mais facil se a fonte do pacote permanecer unificada

Direcoes possiveis mais tarde:

- bundles slim gerados por perfil
- tarballs especificos de target gerados
- busca remota opcional de modulos pesados

Essas sao Fase 3 ou posterior, nao pre-requisitos para instalacoes com reconhecimento de perfil.

## Sequencia de Implementacao

### Fase 1: Planner para Contrato

1. manter schema e resolvedor de manifesto atuais
2. adicionar planejamento de operacao em cima de modulos resolvidos
3. definir schema de estado `egc.install.v1`
4. escrever install-state em instalacao bem-sucedida

### Fase 2: Adaptadores de Target

1. extrair comportamento de instalacao gemini em adaptador `gemini-home`
2. extrair comportamento de instalacao Cursor em adaptador `cursor-project`
3. extrair comportamento de instalacao Antigravity em adaptador `antigravity-project`
4. reduzir `install.sh` para analise de argumentos mais invocacao de adaptador

### Fase 3: Ciclo de Vida

1. adicionar semantica mais forte de mesclagem/remocao especifica de target
2. estender cobertura de reparo/desinstalacao para operacoes nao de copia
3. reduzir superficie de publicacao de pacote para o grafo de modulos em vez de pastas amplas
4. decidir quando `egc-install` deve se tornar um alias fino para `egc install`

### Fase 4: Publicacao e Targets Futuros

1. avaliar reducao segura da superficie de publicacao de `package.json`
2. adicionar `codex-home`
3. adicionar `opencode-home`
4. considerar bundles de perfil gerados se a pressao de empacotamento permanecer alta

## Recomendacao

Trate o resolvedor de manifesto atual como adaptador `0` para instalacoes:

1. preservar a superficie de instalacao atual
2. mover comportamento de copia real para tras de adaptadores de target
3. escrever install-state para toda instalacao bem-sucedida
4. fazer desinstalacao, doctor e repair dependerem apenas de install-state
5. somente entao reduzir empacotamento ou adicionar mais targets

Esse e o caminho mais curto do sprawl do instalador do egc 1.x para um contrato de instalacao/controle do egc 2.0 que e determinista, sustentavel e extensivel.
