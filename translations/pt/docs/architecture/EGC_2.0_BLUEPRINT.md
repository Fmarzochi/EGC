# BLUEPRINT ARQUITETURAL EGC 2.0: O AGENTE OS

**Arquiteto:** Unidade Arquitetural EGC
**Status:** Proposta de Design
**Alvo:** Runtime Soberano Unificado
**Versao:** 1.0.0 (Proposta de Design)

---

## 1. VISAO: DE WRAPPER A OS

O EGC v1 provou a viabilidade de uma cadeia cognitiva hibrida Node/Python. No entanto, seu **Modelo de Criacao de Processos** cria sobrecarga significativa, riscos de amnesia e contornos de governanca.

**EGC 2.0** faz a transicao para um **Modelo de Daemon Persistente (Agente OS)** onde o runtime vive como um unico processo de longa duracao que orquestra modelos, ferramentas e hooks por meio de IPC de alta fidelidade.

---

## 2. O PLANO DE CONTROLE UNIFICADO (PCU)

### 2.1 Host: O Kernel Rust
O scaffold Rust existente `egc/` sera promovido ao **Kernel do Sistema** primario.
- **Papel:** Supervisor de processos, host TUI e broker IPC seguro.
- **Linguagem:** Rust (por desempenho e seguranca).

### 2.2 Co-Processadores: Python e Node.js
- **Motor Python:** Hospedado como um sub-servico gerenciado para interacao com LLM e logica ReAct.
- **Motor Node.js:** Hospedado para compatibilidade de hooks legados e roteamento CLI.
- **Mecanismo IPC:** Unix Domain Sockets (POSIX) ou Named Pipes (Windows) usando um **protocolo baseado em Protobuf** (removendo a sobrecarga de JSON sobre STDIN).

---

## 3. FABRIC DE MEMORIA DETERMINISTICA

### 3.1 Unificacao de Namespace
Migracao completa de `~/.gemini/homunculus` para `~/.gemini/egc`.

### 3.2 Divisao de Armazenamento
- **Memoria Quente (RAM/SQLite):** Contexto de sessao ao vivo, instintos ativos e resultados recentes de ferramentas.
- **Memoria Fria (JSONL/Vetor):** Arquivos de sessao de longo prazo e padroes com escopo de projeto.
- **Schema Unificado:** Um banco de dados SQLite compartilhado gerenciado pelo Kernel Rust, acessivel via IPC por motores Python e Node.js.

---

## 4. GOVERNANCA DE ALTA FIDELIDADE (Bloqueio de Estado)

### 4.1 O Modelo "Interceptor"
No EGC 2.0, o `Dispatcher` e movido para o **Kernel**.
1. **Pre-voo:** Kernel intercepta a Intencao do Modelo -> Despacha hooks de bloqueio.
2. **Execucao:** Kernel executa a ferramenta (ou delega para sub-servico).
3. **Pos-voo (CIENTE DO RESULTADO):** Kernel recebe o resultado -> Despacha hooks de bloqueio -> Retorna ao Modelo.

### 4.2 Governanca de Erros
Introducao dos gatilhos `PostToolUseFailure` e `SystemPanic` para permitir recuperacao agentiva antes do termino do processo CLI.

---

## 5. ESPECIFICACOES DE INTERFACE (RASCUNHO)

### 5.1 IPC do Kernel (Pseudo-Protobuf)
```protobuf
message AgentRequest {
  string session_id = 1;
  string project_id = 2;
  ModelHint model = 3;
  string prompt = 4;
}

message ToolInterception {
  string tool_name = 1;
  map<string, string> arguments = 2;
  EventPhase phase = 3; // PreToolUse, PostToolUse
}
```

---

## 6. ESTRATEGIA DE MIGRACAO

1. **Fase Alpha:** Implementar a ponte IPC entre o TUI Rust e o Core Python.
2. **Fase Beta:** Migrar `SessionRecorder` para o armazenamento SQLite do Kernel.
3. **Fase Gamma:** Redirecionar a CLI `egc` para se comunicar com o Daemon em vez de criar `gemini.js`.

---
**Veredicto:** O EGC 2.0 elimina o problema do "Cerebro Isolado" criando um sistema circulatorio compartilhado para contexto e governanca.
