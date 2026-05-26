# Security Policy

## Supported Versions

| Version | Supported |
| :--- | :--- |
| 1.0.x | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability in the Everything Gemini Code (EGC) runtime, please report it responsibly. **Do not open public GitHub issues for security vulnerabilities.**

Direct all sensitive reports to the official project maintainer:

**Email:** [fmarzochi@gmail.com](mailto:fmarzochi@gmail.com)

Please include:
- A technical description of the vulnerability.
- Steps to reproduce.
- Affected version(s).
- Impact assessment.

## Responsible Disclosure

You can expect:
- **Acknowledgment** within 72 hours.
- **Coordination** on the disclosure process.
- **Remediation or mitigation** as part of the maintenance lifecycle.

## Security Scope

This policy covers the official `everything-gemini` repository, specifically:

- **Core Runtime**: Orchestrator, Execution Engine, Memory Mesh, and Event Bus.
- **Agent Lifecycle**: Loader, Executor, and Identity Resolver modules.
- **Installation**: `install.sh` and `install.ps1`.
- **Governance**: Rules, Hooks, and Skill definitions.

## Runtime Security Model

EGC is a local-first, MCP-native runtime. Security is managed via:

- **Execution Validation**: Shell commands are validated against an allowlist by `egc-guardian` (`validate_command` tool) before execution.
- **Write Protection**: Writes to sensitive paths (`~/.ssh`, `/etc`, and similar) are blocked by `egc-guardian` (`validate_write` tool).
- **Persistence**: Session memory (`~/.egc/state/`) is stored locally via `egc-memory`. EGC does not transmit session data to external servers.

## Security Hardening Philosophy

EGC adheres to the principle of **Defensive Execution**:

1. **Local-Only Operation**: No external telemetry or cloud-based daemons are required.
2. **Authorization**: Workflows are dispatched via the `ExecutionOrchestrator`, providing a centralized control point.
3. **Core Runtime Separation**: Core engine components are decoupled from user-modifiable workflows.
4. **Structured Logging**: Security-critical transitions are captured via structured logging for offline audit.

## Operational Best Practices

- **Diagnostic Validation**: Run `egc doctor` to verify MCP server health and configuration.
- **Git Hygiene**: Keep sensitive session data (`.sessions/`) excluded via `.gitignore`.
- **Privilege**: Run the runtime with the least privilege required by the host OS.

## Maintenance & Governance

The EGC project is maintained independently. Security updates are managed as part of the standard release cycle. The architecture is designed for auditability and runtime verification.

---

### Maintainer
**Felipe Marzochi**  
[GitHub](https://github.com/Fmarzochi) | [LinkedIn](https://www.linkedin.com/in/felipemarzochi/) | [X](https://x.com/MarzochiFelipe)

### Security Contact
For all security-related inquiries or vulnerability disclosures, contact:
- **Email:** [fmarzochi@gmail.com](mailto:fmarzochi@gmail.com)
