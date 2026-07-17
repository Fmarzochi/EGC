#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

const NODES = [
    {
        id: 'orchestration:ExecutionOrchestrator',
        class: 'ACTIVE',
        kind: 'orchestrator',
        path: 'scripts/orchestration/orchestrator.py',
        summary: 'Async orchestrator: queue, sessions, dispatch, health introspection.'
    },
    {
        id: 'orchestration:AGENT_ROUTER',
        class: 'ACTIVE',
        kind: 'orchestrator',
        path: 'scripts/orchestration/router.py',
        summary: 'Domain-based agent routing with affinity map.'
    },
    {
        id: 'runtime:TRACER',
        class: 'ACTIVE',
        kind: 'tracer',
        path: 'scripts/runtime/tracer.py',
        summary: 'Thread-safe JSONL tracer for orchestration events.'
    },
    {
        id: 'runtime:EXECUTION_QUEUE',
        class: 'ACTIVE',
        kind: 'queue',
        path: 'scripts/runtime/async_task_queue.py',
        summary: 'Asyncio queue powering orchestrator workers.'
    },
    {
        id: 'runtime:SESSION_MANAGER',
        class: 'ACTIVE',
        kind: 'registry',
        path: 'scripts/runtime/session_manager.py',
        summary: 'Persistent session manager for execution sessions.'
    },
    {
        id: 'execution:AgentExecutor',
        class: 'ACTIVE',
        kind: 'dispatcher',
        path: 'scripts/execution/agent_executor.py',
        summary: 'Executes agent prompts via llm.cli.prompt subprocess.'
    },
    {
        id: 'execution:SandboxController',
        class: 'ACTIVE',
        kind: 'dispatcher',
        path: 'scripts/execution/sandbox.py',
        summary: 'Workspace sandbox boundary controller.'
    },
    {
        id: 'execution:tool_runner',
        class: 'ACTIVE',
        kind: 'dispatcher',
        path: 'scripts/execution/tool_runner.py',
        summary: 'Allowlist-guarded subprocess command runner.'
    },
    {
        id: 'workflows:WorkflowEngine',
        class: 'ACTIVE',
        kind: 'workflow',
        path: 'scripts/workflows/workflow_engine.py',
        summary: 'Plans and executes multi-step workflows with optional parallel orchestrator.'
    },
    {
        id: 'memory:persistent_memory',
        class: 'ACTIVE',
        kind: 'registry',
        path: 'scripts/memory/persistent_memory.py',
        summary: 'SQLite-backed persistent memory with state.db tee.'
    },
    {
        id: 'llm:dispatcher',
        class: 'ACTIVE',
        kind: 'dispatcher',
        path: 'src/llm/dispatcher.py',
        summary: 'Hook mesh dispatcher reading hooks/hooks.json.'
    },
    {
        id: 'llm:providers:gemini',
        class: 'ACTIVE',
        kind: 'provider',
        path: 'src/llm/providers/gemini.py',
        summary: 'Gemini provider implementation.'
    },
    {
        id: 'llm:providers:claude',
        class: 'ACTIVE',
        kind: 'provider',
        path: 'src/llm/providers/claude.py',
        summary: 'Claude provider implementation.'
    },
    {
        id: 'llm:providers:openai',
        class: 'ACTIVE',
        kind: 'provider',
        path: 'src/llm/providers/openai.py',
        summary: 'OpenAI provider implementation.'
    },
    {
        id: 'llm:providers:openrouter',
        class: 'ACTIVE',
        kind: 'provider',
        path: 'src/llm/providers/openrouter.py',
        summary: 'OpenRouter provider implementation.'
    },
    {
        id: 'llm:providers:ollama',
        class: 'ACTIVE',
        kind: 'provider',
        path: 'src/llm/providers/ollama.py',
        summary: 'Ollama local provider implementation.'
    },
    {
        id: 'llm:cli:prompt',
        class: 'ACTIVE',
        kind: 'cli',
        path: 'src/llm/cli/prompt.py',
        summary: 'Python ReAct prompt CLI entrypoint (python -m llm.cli.prompt).'
    },
    {
        id: 'node:install-apply',
        class: 'ACTIVE',
        kind: 'loader',
        path: 'scripts/install-apply.js',
        summary: 'Node installer entrypoint for EGC, Cursor, Antigravity targets.'
    },
    {
        id: 'node:install-targets',
        class: 'ACTIVE',
        kind: 'loader',
        path: 'scripts/lib/install-targets/',
        summary: 'Target-specific install adapters (gemini-home, cursor, codex, opencode, etc.).'
    },
    {
        id: 'node:hooks-dispatcher',
        class: 'ACTIVE',
        kind: 'hooks',
        path: 'scripts/hooks/pre-bash-dispatcher.js',
        summary: 'Pre/post bash hook dispatchers delegating to bash-hook-dispatcher.'
    },
    {
        id: 'node:gemini-bridge',
        class: 'ACTIVE',
        kind: 'cli',
        path: 'scripts/gemini.js',
        summary: 'Node bridge that spawns the Python llm.cli.prompt backend.'
    },
    {
        id: 'manifest:gemini-plugin',
        class: 'ACTIVE',
        kind: 'manifest',
        path: '.gemini-plugin/plugin.json',
        summary: 'Gemini plugin manifest consumed by install-apply.'
    },
    {
        id: 'manifest:codex-plugin',
        class: 'ACTIVE',
        kind: 'manifest',
        path: '.codex-plugin/plugin.json',
        summary: 'Codex plugin manifest consumed by install-apply.'
    },
    {
        id: 'state:sqlite',
        class: 'ACTIVE',
        kind: 'registry',
        path: '~/.gemini/egc/state.db',
        summary: 'Shared SQLite state database for instincts and runtime metadata.'
    },
];

const IMPORT_RULES = [
    {
        from: 'orchestration:ExecutionOrchestrator',
        source: 'scripts/orchestration/orchestrator.py',
        targets: [
            { needle: 'from orchestration.router import AGENT_ROUTER', to: 'orchestration:AGENT_ROUTER' },
            { needle: 'from runtime.tracer import TRACER', to: 'runtime:TRACER' },
            { needle: 'from execution.agent_executor import AgentExecutor', to: 'execution:AgentExecutor' },
            { needle: 'from execution.sandbox import SandboxController', to: 'execution:SandboxController' },
            { needle: 'from runtime.async_task_queue import EXECUTION_QUEUE', to: 'runtime:EXECUTION_QUEUE' },
            { needle: 'from execution.tool_runner import', to: 'execution:tool_runner' }
        ]
    },
    {
        from: 'execution:AgentExecutor',
        source: 'scripts/execution/agent_executor.py',
        targets: [
            { needle: 'from execution.tool_runner import', to: 'execution:tool_runner' }
        ]
    },
    {
        from: 'workflows:WorkflowEngine',
        source: 'scripts/workflows/workflow_engine.py',
        targets: [
            { needle: 'from execution.agent_executor import AgentExecutor', to: 'execution:AgentExecutor' },
            { needle: 'from orchestration.orchestrator import ExecutionOrchestrator', to: 'orchestration:ExecutionOrchestrator' }
        ]
    },
    {
        from: 'llm:cli:prompt',
        source: 'src/llm/cli/prompt.py',
        targets: [
            { needle: 'from llm.dispatcher import Dispatcher', to: 'llm:dispatcher' },
            { needle: 'from llm.providers import get_provider', to: 'llm:providers:gemini' },
            { needle: 'from llm.providers import get_provider', to: 'llm:providers:claude' },
            { needle: 'from llm.providers import get_provider', to: 'llm:providers:openai' },
            { needle: 'from llm.providers import get_provider', to: 'llm:providers:openrouter' },
            { needle: 'from llm.providers import get_provider', to: 'llm:providers:ollama' }
        ]
    }
];

const STATIC_EDGES = [
    {
        from: 'execution:AgentExecutor',
        to: 'llm:cli:prompt',
        relation: 'spawns',
        evidence: 'scripts/execution/agent_executor.py: cmd = ["python3", "-m", "llm.cli.prompt", "-p", prompt]'
    },
    {
        from: 'runtime:TRACER',
        to: 'state:sqlite',
        relation: 'writes',
        evidence: 'TRACER writes .sessions/execution_log.jsonl alongside SQLite state'
    },
    {
        from: 'node:gemini-bridge',
        to: 'llm:cli:prompt',
        relation: 'spawns',
        evidence: 'scripts/gemini.js: spawnSync(pythonBin, ["-m", "llm.cli.prompt", ...])'
    },
    {
        from: 'memory:persistent_memory',
        to: 'state:sqlite',
        relation: 'writes',
        evidence: 'scripts/memory/persistent_memory.py: sqlite3.connect(~/.gemini/egc/state.db)'
    },
    {
        from: 'node:install-apply',
        to: 'manifest:gemini-plugin',
        relation: 'reads',
        evidence: 'scripts/lib/install-targets/gemini-home.js: nativeRootRelativePath = .gemini-plugin'
    },
    {
        from: 'node:install-apply',
        to: 'manifest:codex-plugin',
        relation: 'reads',
        evidence: 'scripts/lib/install-targets/ targets resolve .codex-plugin/plugin.json'
    },
    {
        from: 'node:install-apply',
        to: 'node:install-targets',
        relation: 'loads',
        evidence: "scripts/install-apply.js: require('./lib/install-targets/...')"
    },
    {
        from: 'node:hooks-dispatcher',
        to: 'llm:dispatcher',
        relation: 'references',
        evidence: 'pre-bash-dispatcher.js delegates to bash-hook-dispatcher; mesh consumed by Dispatcher'
    },
    {
        from: 'orchestration:AGENT_ROUTER',
        to: 'runtime:SESSION_MANAGER',
        relation: 'references',
        evidence: 'ExecutionOrchestrator wires router and session_manager via shared runtime context'
    }
];

function readSource(relative) {
    const abs = path.join(ROOT, relative);
    try {
        return fs.readFileSync(abs, 'utf8');
    } catch (_err) {
        return '';
    }
}

function deriveImportEdges() {
    const edges = [];
    const seen = new Set();
    for (const rule of IMPORT_RULES) {
        const text = readSource(rule.source);
        if (!text) continue;
        for (const target of rule.targets) {
            if (!text.includes(target.needle)) continue;
            const key = `${rule.from}->${target.to}:imports`;
            if (seen.has(key)) continue;
            seen.add(key);
            edges.push({
                from: rule.from,
                to: target.to,
                relation: 'imports',
                evidence: `${rule.source}: ${target.needle}`
            });
        }
    }
    return edges;
}

function validateNodeIds(edges) {
    const ids = new Set(NODES.map((n) => n.id));
    return edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
}

function buildGraph() {
    const importEdges = deriveImportEdges();
    const allEdges = validateNodeIds([...importEdges, ...STATIC_EDGES]);
    return {
        generatedAt: new Date().toISOString(),
        repoRoot: ROOT,
        nodes: NODES,
        edges: allEdges
    };
}

function toDot(graph) {
    const lines = [];
    lines.push(
      'digraph EGCRuntime {',
      '  rankdir=LR;',
      '  node [shape=box, fontname="Helvetica"];'
    );
    for (const node of graph.nodes) {
        const label = String.raw`${node.id}\n[${node.class}/${node.kind}]`;
        lines.push(`  "${node.id}" [label="${label}"];`);
    }
    for (const edge of graph.edges) {
        lines.push(`  "${edge.from}" -> "${edge.to}" [label="${edge.relation}"];`);
    }
    lines.push('}');
    return lines.join('\n');
}

function main() {
    const graph = buildGraph();
    if (process.argv.includes('--dot')) {
        process.stdout.write(toDot(graph) + '\n');
        return;
    }
    process.stdout.write(JSON.stringify(graph, null, 2) + '\n');
}

main();
