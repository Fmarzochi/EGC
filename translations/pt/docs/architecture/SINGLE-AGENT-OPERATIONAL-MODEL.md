# Modelo Operacional de Agente Unico

Este documento estabelece a governanca operacional oficial e permanente para o projeto EGC - Extended Global Context. Ele aplica estritamente um paradigma de execucao de agente unico, proibindo explicitamente orquestracao automatica, delegacao recursiva e qualquer modificacao do estado global do sistema host.

## Diretivas Principais

### 1. Imutabilidade Absoluta do Estado Global
Agentes e processos operando dentro deste repositorio **JAMAIS DEVEM** modificar:
- `~/.gemini` (Configuracoes globais do Gemini)
- `~/.npm-global` (Modulos NPM globais)
- Configuracoes globais do sistema ou variaveis de ambiente.
- O bundle interno do Google ou politicas internas da CLI.
- Runtimes globais ou plugins globais.

### 2. Localidade Estrita de Projeto
Todos os comportamentos, scripts e execucoes devem ser:
- **Escopo de repositorio:** Confinados inteiramente dentro dos limites do repositorio `EGC`.
- **Local ao projeto:** Todos os caminhos de leitura, escrita e execucao de arquivos devem ser relativos a raiz do projeto.
- **Autocontidos:** O projeto nao deve depender de dependencias externas nao padronizadas que nao estejam explicitamente declaradas no gerenciador de pacotes.

### 3. Localizacao de Recursos
Todos os recursos operacionais devem residir exclusivamente dentro da estrutura de diretorios do projeto:
- `./agents`
- `./skills`
- `./scripts`
- `./docs`
- `./research`

### 4. Comportamentos Proibidos
Os seguintes comportamentos em tempo de execucao sao estritamente proibidos para evitar consumo composto de cota, loops infinitos e imprevisibilidade operacional:
- `invoke_agent` (Delegacao para sub-agentes via loop principal).
- Loops de orquestracao automatica.
- Planejadores recursivos.
- Investigacao automatica ou arqueologia de runtime.
- Forensica de bundle.
- Governanca auto-modificadora (agentes alterando estas regras principais).

### 5. Modo Operacional Oficial
O modo operacional padrao e o **Modo de Execucao de Agente Unico**. As tarefas devem ser executadas diretamente pelo agente ativo dentro de uma unica linha linear de execucao.

### 6. Capacidades Multi-Agente Futuras
Qualquer implementacao futura de fluxos de trabalho multi-agente deve seguir as seguintes restricoes:
- Exigir autorizacao explicita (opt-in pelo usuario).
- Ser implementada inteiramente de forma local ao projeto (por exemplo, via scripts locais orquestrando processos CLI separados, nao recursao interna de runtime).
- Nunca alterar o ambiente global.
- Nunca criar dependencias no layout especifico ou diretorio HOME da maquina host.

### 7. Portabilidade Universal
O repositorio foi projetado para ser totalmente portavel. Deve funcionar corretamente:
- Em qualquer sistema operacional (Linux, macOS, Windows).
- Em qualquer caminho de diretorio.
- Sem nenhuma dependencia no caminho do diretorio `HOME` do usuario.
