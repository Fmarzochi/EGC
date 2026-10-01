# EGC 2.0 ARCHITECTURAL BLUEPRINT: THE AGENT OS

**Architect:** EGC Architectural Unit  
**Status:** Design Proposal  
**Target:** Unified Sovereign Runtime  
**Version:** 1.0.0 (Design Proposal)

---

## 1. VISION: FROM WRAPPER TO OS

EGC v1 proved the viability of a hybrid Node/Python cognitive chain. However, its **Process-Spawning Model** creates significant overhead, amnesia risks, and governance bypasses. 

**EGC 2.0** transitions to a **Persistent Daemon Model (Agent OS)** where the runtime lives as a single, long-running process that orchestrates models, tools, and hooks through high-fidelity IPC.

---

## 2. THE UNIFIED CONTROL PLANE (UCP)

### 2.1 Host: The Rust Kernel
The existing `egc/` Rust scaffold will be promoted to the primary **System Kernel**.
- **Role:** Process supervisor, TUI host, and secure IPC broker.
- **Language:** Rust (for performance and safety).

### 2.2 Co-Processors: Python & Node.js
- **Python Engine:** Hosted as a managed sub-service for LLM interaction and ReAct logic.
- **Node.js Engine:** Hosted for legacy hook compatibility and CLI routing.
- **IPC Mechanism:** Unix Domain Sockets (POSIX) or Named Pipes (Windows) using a **Protobuf-based protocol** (removing JSON-over-STDIN overhead).

---

## 3. DETERMINISTIC MEMORY FABRIC

### 3.1 Namespace Unification
Complete migration from `~/.egc-learning` to `~/.gemini/egc`.

### 3.2 Storage Tiering
- **Hot Memory (RAM/SQLite):** Live session context, active instincts, and recent tool results.
- **Cold Memory (JSONL/Vector):** Long-term session archives and project-scoped patterns.
- **Unified Schema:** A shared SQLite database managed by the Rust Kernel, accessible via IPC by both Python and Node.js engines.

---

## 4. HIGH-FIDELITY GOVERNANCE (State-Blocking)

### 4.1 The "Interceptor" Model
In EGC 2.0, the `Dispatcher` is moved into the **Kernel**.
1. **Pre-Flight:** Kernel intercepts Model Intent -> Dispatches blocking hooks.
2. **Execution:** Kernel executes the tool (or delegates to sub-service).
3. **Post-Flight (RESULT-AWARE):** Kernel receives result -> Dispatches blocking hooks -> Returns to Model.

### 4.2 Error Governance
Introduction of `PostToolUseFailure` and `SystemPanic` triggers to allow agental recovery before the CLI process terminates.

---

## 5. INTERFACE SPECIFICATIONS (DRAFT)

### 5.1 Kernel IPC (Pseudo-Protobuf)
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

## 6. MIGRATION STRATEGY

1. **Phase Alpha:** Implement the IPC bridge between the Rust TUI and the Python Core.
2. **Phase Beta:** Migrate `SessionRecorder` to the Kernel's SQLite store.
3. **Phase Gamma:** Redirect the `egc` CLI to communicate with the Daemon instead of spawning `gemini.js`.

---
**Verdict:** EGC 2.0 eliminates the "Isolated Brain" problem by creating a shared circulatory system for context and governance.
