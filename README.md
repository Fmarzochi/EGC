# Everything Gemini Code

![Everything Gemini Code — the performance system for AI agent harnesses](assets/hero.png)

[![Version](https://img.shields.io/badge/version-v1.0.0-blue.svg?style=flat-square)]() [![License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE) [![Engine](https://img.shields.io/badge/engine-Gemini%20Native-1a73e8.svg?style=flat-square)]() [![Bridge](https://img.shields.io/badge/bridge-Claude%20%7C%20OpenAI%20%7C%20Ollama-d97757.svg?style=flat-square)]() [![Language](https://img.shields.io/badge/tech-Python%20%7C%20TypeScript%20%7C%20SQLite-3776AB?style=flat-square)]() [![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-blue?style=flat-square)]() [![Local First](https://img.shields.io/badge/telemetry-Local--First-2ea44f?style=flat-square)]()

<div align="center"></div>

**A Gemini-first orchestration ecosystem and local-first AI operational environment.**

Everything Gemini Code (EGC) is a multi-harness deployment system and cognitive payload manager. It transforms standard AI assistants into capable, standardized engineering teams by injecting curated skills, agents, and orchestration instructions into your environment. 

EGC excels at organizing, versioning, and deploying complex cognitive workflows into third-party IDEs (Cursor, Codebuddy, Codex) and CLIs. It provides a serious, cross-platform control plane that wraps standard AI models in strict, observable engineering procedures.

### The EGC Control Plane in Action

> *Live Execution: The EGC Control Plane tracking capability inventory and orchestration.*

<div align="center">
  <video src="https://raw.githubusercontent.com/Fmarzochi/everything-gemini/main/assets/demo.mp4" autoplay loop muted playsinline width="100%"></video>
</div>

*(Note: If the video above does not play automatically in your Markdown viewer, you can download `assets/demo.mp4` to view the full control plane showcase.)*

---

## 🚀 Get Started

EGC is designed for low-friction onboarding. It installs the knowledge and workflows you need directly into the tools you already use.

### 1. System Requirements
*   **Node.js 18+** (Required for the installer and hook mesh)
*   **Python 3.10+** (Required for the Dashboard UI and test runners)
*   **Git**

### 2. Clone & Initialize
Download the ecosystem and bootstrap the local state store.

```bash
git clone https://github.com/Fmarzochi/everything-gemini.git
cd everything-gemini

# Install Node dependencies (State-Store & Hooks)
npm install

# Bootstrap the local SQLite state-store (idempotent, safe to run anytime)
node scripts/bootstrap-state-db.js
```

### 3. Launch the Control Plane
The EGC Dashboard is a zero-dependency Tkinter GUI. Use it to explore the massive catalog of 228+ skills and 62+ agents before deploying them.

```bash
# Setup Python Virtual Environment
python3 -m venv .venv
source .venv/bin/activate  # On Windows use: .\.venv\Scripts\activate
pip install -r requirements.txt

# Run the Dashboard
python3 egc_dashboard.py
```

### 4. Deploy Capabilities to Your Harness
Use the EGC Node installer to deploy skills and agents directly into your preferred IDE or CLI framework (Cursor, Codex, Antigravity, Codebuddy).

```bash
# Example: Install TypeScript skills and core rules into a Cursor project
npm run egc-install -- --target cursor --profile developer typescript
```

---

## 📊 Ecosystem Inventory & Cross-Tool Parity

EGC ships with a massive, continuously validated catalog of cognitive payloads, ensuring that your AI harness has the right context for the job. These surfaces are strictly validated by the CI catalog gate (`scripts/ci/catalog.js`).

### Catalog Snapshot

| Surface | Inventory | Description |
|---------|-----------|-------------|
| **Agents** | 62 | Specialized personas (e.g., `security-reviewer`) that handle distinct domains. |
| **Skills** | 228 | Standardized operating procedures organized in 14 categories. |
| **Commands** | 74 | CLI slash-command entrypoints for terminal execution. |

### Cross-Harness Parity

How the EGC native inventory compares to the same surfaces in other major AI coding harnesses:

| Surface | Gemini Code (EGC) | Claude Code | Codex CLI | OpenCode |
|---------|------------------:|-------------|-----------|---------:|
| **Agents** | 62 | Shared (`AGENTS.md`) | Shared (`AGENTS.md`) | 12 |
| **Commands** | 74 | Shared | Instruction-based | 31 |
| **Skills** | 228 | Shared | 10 (native format) | 37 |

---

## 🏗️ Architecture & Runtime Truth

EGC is built on a dual-stack architecture: Node.js handles deployment, state, and context ingestion (the "mesh"), while Python provides the visual dashboard, basic provider bridging, and orchestration substrates.

### Runtime Status Matrix

We believe in technical honesty. EGC contains preserved architectural substrates from its ongoing evolution as an orchestration environment. The following matrix distinguishes active production surfaces from experimental or dormant topology layers.

| Layer | Status | Notes |
|---|---|---|
| **Installer & Manifests** | **ACTIVE** | `manifests/install-modules.json` is the absolute truth for ecosystem deployment. |
| **Node Hook Mesh** | **ACTIVE** | Context injection, session state, and execution hooks via `scripts/hooks/*.js`. |
| **Dashboard UI** | **ACTIVE** | `egc_dashboard.py` provides control-plane visibility and physical-disk inventory discovery. |
| **Provider Bridge** | **ACTIVE** | `src/llm/cli/prompt.py` provides the canonical Python CLI forwarder. |
| **Registry Snapshots** | **DORMANT BUT INTENTIONAL** | `runtime-map.json` is preserved as a legacy/cache surface; discovery gracefully falls back to deep physical disk search. |
| **Execution Orchestrator** | **ORPHAN-BY-TESTS** | Simulated Python event loop preserved for structural topology continuity. |
| **Execution Queue** | **ORPHAN-BY-TESTS** | Python task queues exist primarily as an architectural mockup in tests. |
| **Workflow Engine** | **ORPHAN-BY-TESTS** | Experimental workflow parser kept alive by topology CI constraints. |

---

## 💻 Technology Stack & Directory Tree

*   **Core:** Node.js, Python 3.10+, Bash
*   **Database / State:** SQLite (via Node), JSON Manifests
*   **Presentation:** Tkinter (GUI), Markdown
*   **AI Providers Supported (via Bridge):** Google Gemini, Anthropic Claude, OpenAI, Ollama

```text
everything-gemini/
├── agents/             # Cognitive worker definitions (e.g., code-architect)
├── skills/             # Domain-specific workflows and knowledge base
├── commands/           # CLI slash-command entrypoints
├── rules/              # Language-specific coding standards
├── manifests/          # The canonical deployment and installation truths
├── scripts/            # Node hooks, installers, and Python orchestration mockups
├── src/                # The Python CLI prompt-bridge
└── egc_dashboard.py    # The visual control plane GUI
```

---

## 🌐 Cross-Platform Support

EGC is developed and tested primarily on Linux. macOS works natively. Windows support is comprehensive for the Node.js installation tools, while Python execution is best-effort.

### Linux & macOS — ✅ Primary Target
*   **Execution:** Native Node.js and Bash.
*   **UI:** Requires `python3-tk` installed on Linux; native on macOS.

### Windows — ⚠️ Supported via PowerShell / WSL
*   **Execution:** `install.ps1` runs natively in PowerShell or Command Prompt.
*   **Recommended:** WSL2 (Ubuntu) is recommended for full POSIX hook compatibility.

---

## 📡 Telemetry & Local State

EGC is fundamentally local-first. **Nothing is transmitted** outside of your explicit requests to AI model providers. No silent telemetry. No cloud databases.

| Surface | Path | Format |
|---|---|---|
| Shared state store | `~/.gemini/egc/state.db` | SQLite |
| Install-state per harness | `<target>/egc-install-state.json` | JSON |
| Session trace | `.sessions/execution_log.jsonl` | JSONL |

You can safely delete `.sessions/` or the state DB at any time to reset your local telemetry.

---

## 🤝 Contributing

Contributions are welcome! Whether you are adding a new Skill, adjusting an Agent prompt, or improving the Node installer, EGC thrives on community engineering.

1. Fork the repository.
2. Create your feature branch (`git checkout -b feature/AmazingSkill`).
3. Commit your changes (`git commit -m 'Add new AmazingSkill'`).
4. Push to the branch (`git push origin feature/AmazingSkill`).
5. Open a Pull Request.

*(Note: Changes to the core orchestration Python scripts are heavily tested by CI topology gates and should be approached with caution.)*

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

<div align="center">
  <img src="assets/images/egc-logo.png" width="40" height="40" alt="EGC Logo">
  <br>
  <b>Built with precision by Felipe Marzochi.</b><br>
  <i>Elevating AI orchestration from chatboxes to engineering systems.</i>
</div>