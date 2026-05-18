#!/usr/bin/env python3
"""
EGC Dashboard - Everything Gemini Code GUI
Cross-platform TkInter application for managing EGC components
"""

import tkinter as tk
from tkinter import ttk, scrolledtext, messagebox
import os
import sys
import json
import time
import logging
import subprocess
import threading
import queue
import webbrowser
from typing import Dict, List, Optional

from scripts.lib.egc_dashboard_runtime import build_terminal_launch, maximize_window
from scripts.lib.path_utils import normalize_path, to_portable_path, from_portable_path, get_file_uri, open_in_explorer

# ============================================================================
# DATA LOADERS - Load EGC data from the project
# ============================================================================

def get_project_path() -> str:
    """Get the EGC project path - assumes this script is run from the project dir"""
    return normalize_path(os.path.dirname(os.path.abspath(__file__)))


def _load_model_resolver():
    """Best-effort import of the centralized ModelResolver (src/ layout)."""
    try:
        from llm.core.model_resolver import ModelResolver  # type: ignore
        return ModelResolver
    except Exception:
        src_path = os.path.join(get_project_path(), "src")
        if os.path.isdir(src_path) and src_path not in sys.path:
            sys.path.insert(0, src_path)
        try:
            from llm.core.model_resolver import ModelResolver  # type: ignore
            return ModelResolver
        except Exception:
            return None


_MODEL_RESOLVER = _load_model_resolver()


def describe_model_strategy(model_hint: Optional[str]) -> Dict[str, str]:
    """Routing description for an agent, never a pinned model string.

    Falls back to a generic description when the resolver is not importable.
    """
    hint = (model_hint or "").strip() or None
    if _MODEL_RESOLVER is not None:
        try:
            return _MODEL_RESOLVER.describe_strategy(hint, provider="gemini")
        except Exception:
            pass

    # Generic fallback (resolver unavailable).
    return {
        "provider": "Google Gemini",
        "provider_id": "gemini",
        "strategy": "Dynamic Routing",
        "preferred_capability": "general",
        "resolved_model": "(resolved at runtime)",
        "fallback_chain": "(resolved at runtime)",
    }


def read_project_version(project_path: str) -> str:
    """Read the canonical project version from the VERSION file (fallback: package.json)."""
    try:
        vp = os.path.join(project_path, "VERSION")
        if os.path.isfile(vp):
            with open(vp, "r", encoding="utf-8") as f:
                v = f.read().strip()
                if v:
                    return v
    except Exception:
        pass
    try:
        pj = os.path.join(project_path, "package.json")
        if os.path.isfile(pj):
            with open(pj, "r", encoding="utf-8") as f:
                data = json.load(f)
                if data.get("version"):
                    return str(data["version"])
    except Exception:
        pass
    return "dev"


def _strip_inline_comment(value: str) -> str:
    """Drop a trailing ' # comment' from an unquoted scalar (best effort)."""
    in_single = in_double = False
    for i, ch in enumerate(value):
        if ch == "'" and not in_double:
            in_single = not in_single
        elif ch == '"' and not in_single:
            in_double = not in_double
        elif ch == "#" and not in_single and not in_double and i > 0 and value[i - 1] in " \t":
            return value[:i].rstrip()
    return value


def _parse_scalar(raw: str):
    """Parse a single YAML-ish scalar: quoted string, JSON-ish list, bool/None, or plain text."""
    s = raw.strip()
    if not s:
        return ""
    if (s[0] == s[-1] == '"' and len(s) >= 2) or (s[0] == s[-1] == "'" and len(s) >= 2):
        return s[1:-1]
    if s[0] == "[" and s[-1] == "]":
        inner = s[1:-1].strip()
        if not inner:
            return []
        items = []
        for part in inner.split(","):
            p = part.strip()
            if (p[:1] == p[-1:] == '"' and len(p) >= 2) or (p[:1] == p[-1:] == "'" and len(p) >= 2):
                p = p[1:-1]
            if p:
                items.append(p)
        return items
    low = s.lower()
    if low in ("true", "yes"):
        return True
    if low in ("false", "no"):
        return False
    if low in ("null", "none", "~"):
        return None
    return _strip_inline_comment(s)


def parse_frontmatter(content: str) -> Dict:
    """Tolerant YAML-frontmatter parser.

    Handles: simple ``key: value``, quoted values, JSON-ish inline lists
    (``tools: ["Read", "Bash"]``), block scalars (``key: >`` folded and
    ``key: |`` literal), block sequences (``  - item``), nested keys (kept as
    raw text under the parent), and ``#`` comments. Never raises.
    """
    metadata: Dict = {}
    if not content.startswith("---"):
        return metadata
    parts = content.split("---", 2)
    if len(parts) < 3:
        return metadata
    lines = parts[1].split("\n")

    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            i += 1
            continue
        if ":" not in line:
            i += 1
            continue
        # Only treat top-level keys (no leading indent) as keys.
        if line[:1] in (" ", "\t"):
            i += 1
            continue
        key, _, rest = line.partition(":")
        key = key.strip()
        rest = rest.strip()
        if rest in (">", "|", ">-", "|-", ">+", "|+"):
            folded = rest[0] == ">"
            block: List[str] = []
            i += 1
            base_indent = None
            while i < n:
                bl = lines[i]
                if bl.strip() == "":
                    block.append("")
                    i += 1
                    continue
                indent = len(bl) - len(bl.lstrip())
                if indent == 0:
                    break
                if base_indent is None:
                    base_indent = indent
                block.append(bl[base_indent:] if len(bl) >= base_indent else bl.lstrip())
                i += 1
            text = (" ".join(b for b in block) if folded else "\n".join(block)).strip()
            metadata[key] = " ".join(text.split()) if folded else text
            continue
        if rest == "":
            # Could be a block sequence or a nested mapping; collect raw children.
            seq: List[str] = []
            children: List[str] = []
            i += 1
            while i < n:
                cl = lines[i]
                if cl.strip() == "":
                    i += 1
                    continue
                if cl[:1] not in (" ", "\t"):
                    break
                cs = cl.strip()
                if cs.startswith("- "):
                    seq.append(_parse_scalar(cs[2:]))
                elif cs == "-":
                    seq.append("")
                else:
                    children.append(cs)
                i += 1
            if seq:
                metadata[key] = seq
            elif children:
                metadata[key] = "; ".join(children)
            else:
                metadata[key] = ""
            continue
        metadata[key] = _parse_scalar(rest)
        i += 1
    return metadata


def _as_text(value) -> str:
    """Render a frontmatter value as a human string."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, (list, tuple)):
        return ", ".join(str(v) for v in value if str(v).strip())
    return str(value).strip()


def _as_list(value) -> List[str]:
    if value is None or value == "":
        return []
    if isinstance(value, (list, tuple)):
        return [str(v).strip() for v in value if str(v).strip()]
    s = str(value).strip()
    if s.startswith("[") and s.endswith("]"):
        parsed = _parse_scalar(s)
        if isinstance(parsed, list):
            return parsed
    # Comma / pipe separated fallback.
    for sep in (",", "|", ";"):
        if sep in s:
            return [p.strip().strip('"').strip("'") for p in s.split(sep) if p.strip()]
    return [s] if s else []


def extract_section(content: str, headers: List[str], max_chars: int = 1200) -> str:
    """Extract the body of the first markdown section whose ## heading matches one of ``headers``.

    Stops at the next heading of the same or higher level. Returns a single
    flowed string (paragraphs joined), trimmed to ``max_chars``.
    """
    lines = content.split("\n")
    wanted = [h.lower() for h in headers]
    collecting = False
    start_level = 99
    out: List[str] = []
    in_code = False
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("```"):
            in_code = not in_code
            if collecting:
                out.append(stripped)
            continue
        is_header = (not in_code) and stripped.startswith("#")
        if is_header:
            level = len(stripped) - len(stripped.lstrip("#"))
            text = stripped.lstrip("#").strip().lower()
            if not collecting:
                if any(w in text for w in wanted):
                    collecting = True
                    start_level = level
                    continue
            else:
                if level <= start_level:
                    break
                out.append(stripped)
                continue
        if collecting:
            out.append(line.rstrip())
    body = "\n".join(out).strip()
    # Flow it: collapse intra-paragraph newlines, keep blank-line paragraph breaks.
    paragraphs = [" ".join(p.split()) for p in body.split("\n\n")]
    flowed = "\n\n".join(p for p in paragraphs if p).strip()
    if len(flowed) > max_chars:
        flowed = flowed[: max_chars - 3].rstrip() + "..."
    return flowed


# ---------------------------------------------------------------------------
# Cognitive metadata inference
#
# Agent / skill markdown files are not required to declare structured metadata,
# so the dashboard infers a consistent cognitive profile from the name,
# declared tools, frontmatter hints and the document body. This keeps the panel
# informative without mass-editing every agent file.
# ---------------------------------------------------------------------------

# Domain -> (label, keywords, default capability tier, governance default, badge tag)
_DOMAIN_RULES = [
    ("security",   "Security & Compliance",   ["security", "audit", "vuln", "owasp", "threat", "compliance", "healthcare", "hipaa"], "reasoning", "advisory", "dom-security"),
    ("review",     "Code Review",             ["review", "reviewer", "critique", "quality"], "reasoning", "read-only", "dom-review"),
    ("debug",      "Debugging & Diagnostics", ["debug", "debugger", "build-error", "build-resolver", "resolver", "silent-failure", "incident"], "reasoning", "read-only", "dom-debug"),
    ("test",       "Testing & TDD",           ["test", "tdd", "e2e", "coverage", "pr-test"], "balanced", "read-only", "dom-test"),
    ("planning",   "Planning & Architecture", ["plan", "planner", "architect", "architecture", "chief-of-staff", "type-design", "code-architect"], "reasoning", "advisory", "dom-plan"),
    ("refactor",   "Refactoring & Cleanup",   ["refactor", "cleaner", "simplifier", "comment", "dead-code"], "balanced", "mutating", "dom-refactor"),
    ("frontend",   "Frontend / UI / A11y",    ["frontend", "react", "ui", "ux", "a11y", "accessibility", "flutter", "seo"], "balanced", "mutating", "dom-frontend"),
    ("database",   "Database & Data Model",   ["database", "sql", "schema", "migration", "data"], "reasoning", "mutating", "dom-data"),
    ("docs",       "Documentation",           ["doc", "docs", "documentation", "doc-updater", "docs-lookup"], "balanced", "mutating", "dom-docs"),
    ("opensource", "Open Source Packaging",   ["opensource", "forker", "packager", "sanitizer"], "balanced", "mutating", "dom-oss"),
    ("orchestration", "Orchestration & Loops", ["loop-operator", "harness", "orchestr", "gan-", "conversation-analyzer", "prompt-optim", "meta-prompt"], "balanced", "advisory", "dom-orch"),
    ("language",   "Language Specialist",     ["python", "rust", "go-", "golang", "java", "kotlin", "csharp", "cpp", "typescript", "dart", "pytorch"], "balanced", "mutating", "dom-lang"),
]

# Tool name -> implied capability
_TOOL_CAPS = {
    "read": "code-comprehension", "grep": "code-search", "glob": "code-search",
    "bash": "shell-execution", "edit": "code-mutation", "write": "code-mutation",
    "multiedit": "code-mutation", "webfetch": "research", "websearch": "research",
    "task": "delegation", "todowrite": "planning",
}


def _infer_domain(name: str, description: str, body: str):
    name_l = (name or "").lower()
    # Pass 1: match against the agent/skill name (most reliable signal).
    for dom_id, label, keywords, tier, gov, tag in _DOMAIN_RULES:
        if any(kw in name_l for kw in keywords):
            return dom_id, label, tier, gov, tag
    # Pass 2: fall back to the description + start of the body.
    hay = " ".join([description or "", (body or "")[:600]]).lower()
    for dom_id, label, keywords, tier, gov, tag in _DOMAIN_RULES:
        if any(kw in hay for kw in keywords):
            return dom_id, label, tier, gov, tag
    return "general", "General Purpose", "balanced", "advisory", "dom-general"


def infer_cognitive_metadata(kind: str, name: str, description: str, tools, model_hint: str, body: str) -> Dict:
    """Return a structured cognitive profile for an agent or skill.

    kind: 'agent' or 'skill'. Never raises.
    """
    try:
        name = name or ""
        description = description or ""
        body = body or ""
        tool_list = _as_list(tools)
        dom_id, dom_label, tier, governance, badge = _infer_domain(name, description, body)

        # Capabilities: from tools + domain.
        caps = []
        for t in tool_list:
            cap = _TOOL_CAPS.get(t.strip().lower())
            if cap and cap not in caps:
                caps.append(cap)
        domain_cap = {
            "security": "security-audit", "review": "code-review", "debug": "root-cause-analysis",
            "test": "test-engineering", "planning": "solution-design", "refactor": "code-refactoring",
            "frontend": "ui-implementation", "database": "data-modeling", "docs": "technical-writing",
            "opensource": "release-packaging", "orchestration": "workflow-orchestration",
            "language": "language-expertise", "general": "general-assistance",
        }.get(dom_id)
        if domain_cap and domain_cap not in caps:
            caps.insert(0, domain_cap)
        if not caps:
            caps = ["general-assistance"]

        # Model strategy hint: explicit frontmatter hint wins, else domain tier.
        hint = (model_hint or "").strip()
        if hint:
            strat = describe_model_strategy(hint)
        else:
            strat = describe_model_strategy(tier)
            strat = dict(strat)
            strat["strategy"] = "Dynamic Routing"  # no explicit hint

        # Delegation role: agents that can spawn tasks orchestrate; others are leaf workers.
        orchestrates = any(t.strip().lower() == "task" for t in tool_list) or dom_id in ("planning", "orchestration")
        delegation = "orchestrator (can delegate to sub-agents)" if orchestrates else "leaf worker (terminal in delegation chain)"

        # Governance scope refinement: real file mutation comes from Edit/Write.
        has_bash = any(t.strip().lower() == "bash" for t in tool_list)
        mutating_tools = any(t.strip().lower() in ("edit", "write", "multiedit") for t in tool_list)
        if mutating_tools:
            governance = "mutating"

        # Risk level (shell access raises it independently of write scope).
        if mutating_tools and has_bash:
            risk = "elevated (shell + file mutation)"
        elif mutating_tools:
            risk = "moderate (file mutation)"
        elif has_bash:
            risk = "moderate (shell access, no writes)"
        elif governance == "advisory":
            risk = "low (advisory/output only)"
        else:
            risk = "low (read-only)"

        # Compatible providers: EGC is Gemini-native; the others are kept as bridges.
        providers = ["Google Gemini (primary)", "Anthropic Claude (bridge)", "OpenAI (bridge)", "Ollama (local bridge)"]

        # Semantic tags.
        tags = [dom_id]
        if orchestrates:
            tags.append("orchestrator")
        if "research" in caps:
            tags.append("research-capable")
        tags.append("mutating" if mutating_tools else "non-mutating")
        if has_bash:
            tags.append("shell")

        return {
            "domain": dom_label,
            "domain_id": dom_id,
            "execution_category": dom_label,
            "capabilities": caps,
            "compatible_providers": providers,
            "model_strategy": strat,
            "governance_scope": governance,
            "delegation": delegation,
            "risk": risk,
            "semantic_tags": tags,
            "tools": tool_list,
            "badge": badge,
            "cognitive_layer": "Python cognitive core (provider) + Node governance mesh (hooks)",
        }
    except Exception:
        return {
            "domain": "General Purpose", "domain_id": "general", "execution_category": "General Purpose",
            "capabilities": ["general-assistance"], "compatible_providers": ["Google Gemini (primary)"],
            "model_strategy": describe_model_strategy(model_hint), "governance_scope": "advisory",
            "delegation": "leaf worker", "risk": "low", "semantic_tags": ["general"],
            "tools": _as_list(tools), "badge": "dom-general",
            "cognitive_layer": "Python cognitive core + Node governance mesh",
        }


_AGENT_ROLE_HEADERS = [
    "your role", "review process", "objective", "mission", "purpose",
    "responsibilities", "what you do", "overview", "role", "process",
]
_AGENT_WHEN_HEADERS = [
    "when to use", "when invoked", "when to activate", "use this agent",
    "triggers", "activation", "use when",
]

_SKILL_ACTIVATION_HEADERS = [
    "when to use", "activation", "trigger", "usage", "when invoked"
]

def _get_registry_path(project_path: str) -> Optional[str]:
    """Get the path to the EGC registry."""
    paths = [
        os.path.join(project_path, "internal", "registry", "runtime-map.json"),
        os.path.join(project_path, "registry", "runtime-map.json")
    ]
    for p in paths:
        if os.path.isfile(p):
            return p
    return None

def _humanize_name(slug: str) -> str:
    return slug.replace("-", " ").replace("_", " ").strip().title()


def load_agents(project_path: str) -> List[Dict]:
    """Load agents from the hybrid registry and physical directories."""
    agents_list: List[Dict] = []
    registry_path = os.path.join(project_path, "registry", "runtime-map.json")
    
    seen_slugs = set()

    if os.path.isfile(registry_path):
        try:
            with open(registry_path, "r", encoding="utf-8") as f:
                registry = json.load(f)
                for agent_meta in registry.get("agents", []):
                    # Prefer hot mounted link for operations, fallback to physical
                    agent_path = os.path.join(project_path, from_portable_path(agent_meta.get("targetLink", agent_meta["physicalPath"])))
                    if not os.path.exists(agent_path): 
                        agent_path = os.path.join(project_path, from_portable_path(agent_meta["physicalPath"]))
                        if not os.path.exists(agent_path):
                            continue
                    
                    slug = agent_meta["name"].replace(".md", "")
                    if slug in seen_slugs: continue
                    
                    try:
                        with open(agent_path, "r", encoding="utf-8") as f2:
                            content = f2.read()
                    except Exception as e:
                        print(f"Error parsing agent {agent_path}: {e}")
                        continue
                        
                    metadata = parse_frontmatter(content)
                    name = _as_text(metadata.get("name")) or slug
                    description = _as_text(metadata.get("description"))
                    tools = metadata.get("tools", [])
                    model_hint = _as_text(metadata.get("model"))

                    cog = infer_cognitive_metadata("agent", name, description, tools, model_hint, content)
                    agents_list.append({
                        "name": name,
                        "slug": slug,
                        "purpose": description or f"{_humanize_name(slug)} agent",
                        "when_to_use": extract_section(content, _AGENT_WHEN_HEADERS) or f"Invoked for {cog['domain'].lower()} tasks.",
                        "role": extract_section(content, _AGENT_ROLE_HEADERS),
                        "tools": cog["tools"],
                        "tools_display": ", ".join(cog["tools"]) if cog["tools"] else "(inherits)",
                        "model": model_hint,
                        "model_strategy": cog["model_strategy"],
                        "cognitive": cog,
                        "source": agent_path,
                    })
                    seen_slugs.add(slug)
        except Exception as e:
            print(f"Registry load error: {e}")

    # Fallback to physical scanning for unmapped agents
    agents_dir = os.path.join(project_path, "agents")
    hot_agents_dir = os.path.join(project_path, ".agents", "agents")
    
    for d in [agents_dir, hot_agents_dir]:
        if not os.path.isdir(d): continue
        for item in sorted(os.listdir(d)):
            if not item.endswith(".md") or item.startswith("_"): continue
            slug = item[:-3]
            if slug in seen_slugs: continue
            
            agent_path = os.path.join(d, item)
            try:
                with open(agent_path, "r", encoding="utf-8") as f:
                    content = f.read()
                metadata = parse_frontmatter(content)
                name = _as_text(metadata.get("name")) or slug
                cog = infer_cognitive_metadata("agent", name, "", [], "", content)
                agents_list.append({
                    "name": name, "slug": slug, "purpose": _as_text(metadata.get("description")) or f"{_humanize_name(slug)} agent",
                    "when_to_use": "Direct discovery", "role": "", "tools": [], "tools_display": "(inherits)",
                    "model": "", "model_strategy": cog["model_strategy"], "cognitive": cog, "source": agent_path,
                })
                seen_slugs.add(slug)
            except: continue

    return agents_list

def _skill_category(name: str, domain_id: str) -> str:
    """Derive a sensible UI category based on domain_id or name."""
    if domain_id and domain_id != "general":
        return domain_id.replace('-', ' ').title()
    parts = name.split('-')
    if len(parts) > 1:
        return parts[0].title()
    return "General"


def load_skills(project_path: str) -> List[Dict]:
    skills: List[Dict] = []
    registry_path = _get_registry_path(project_path)
    if registry_path:
        try:
            with open(registry_path, "r", encoding="utf-8") as f:
                registry = json.load(f)
                for skill_meta in registry.get("skills", []):
                    skill_path = os.path.join(project_path, from_portable_path(skill_meta.get("targetLink", skill_meta["physicalPath"])))
                    skill_file = os.path.join(skill_path, "SKILL.md")
                    if not os.path.isfile(skill_file):
                        skill_path = os.path.join(project_path, from_portable_path(skill_meta["physicalPath"]))
                        skill_file = os.path.join(skill_path, "SKILL.md")
                        if not os.path.isfile(skill_file): continue
                    try:
                        with open(skill_file, "r", encoding="utf-8") as f2: content = f2.read()
                        metadata = parse_frontmatter(content)
                        name = _as_text(metadata.get("name")) or _humanize_name(skill_meta["name"])
                        description = _as_text(metadata.get("description"))
                        cog = infer_cognitive_metadata("skill", name, description, [], "", content)
                        runtime_tuple = tuple(cog.get("runtime", []))
                        tools_tuple = tuple(cog.get("tools", []))
                        skills.append({
                            "name": name, "slug": skill_meta["id"], "description": description or f"{_humanize_name(skill_meta['name'])} skill",
                            "category": _skill_category(skill_meta["name"], cog["domain_id"]),
                            "activation": extract_section(content, _SKILL_ACTIVATION_HEADERS) or "Auto-activated.",
                            "path": skill_path, "cognitive": {**cog, "runtime": runtime_tuple, "tools": tools_tuple},
                        })
                    except Exception as e: logging.warning(f"Error parsing skill: {e}")
        except Exception as e: logging.error(f"Skill registry error: {e}")
    return skills

def load_commands(project_path: str) -> List[Dict]:
    """Load commands from commands directory"""
    commands_dir = os.path.join(project_path, "commands")
    commands = []
    
    if os.path.exists(commands_dir):
        for item in os.listdir(commands_dir):
            if item.endswith('.md'):
                cmd_path = os.path.join(commands_dir, item)
                try:
                    with open(cmd_path, 'r', encoding='utf-8') as f:
                        content = f.read()
                        metadata = parse_frontmatter(content)
                        
                        cmd_name = item[:-3]
                        description = metadata.get('description', "")
                        
                        if not description:
                            lines = content.split('\n')
                            for line in lines:
                                if line.startswith('# '):
                                    description = line[2:].strip()
                                    break
                        
                        commands.append({
                            'name': cmd_name,
                            'description': description or cmd_name.replace('-', ' ').title()
                        })
                except Exception as e:
                    print(f"Error parsing command {cmd_path}: {e}")

    return commands

def load_rules(project_path: str) -> List[Dict]:
    """Load rules from rules directory"""
    rules_dir = os.path.join(project_path, "rules")
    rules = []
    
    if os.path.exists(rules_dir):
        for item in os.listdir(rules_dir):
            item_path = os.path.join(rules_dir, item)
            if os.path.isdir(item_path):
                # Common rules
                language = 'Common' if item == "common" else item.title()
                for file in os.listdir(item_path):
                    if file.endswith('.md'):
                        rule_path = os.path.join(item_path, file)
                        description = ""
                        try:
                            with open(rule_path, 'r', encoding='utf-8') as f:
                                content = f.read()
                                # Try to get title or first line
                                for line in content.split('\n'):
                                    if line.strip():
                                        description = line.strip('# ')
                                        break
                        except Exception as e:
                            print(f"Error reading rule {rule_path}: {e}")
                            
                        rules.append({
                            'name': file[:-3],
                            'language': language,
                            'description': description,
                            'path': rule_path
                        })
    
    # Fallback rules
    if not rules:
        rules = [
            {'name': 'coding-style', 'language': 'Common', 'description': 'Style guide', 'path': ''},
            {'name': 'git-workflow', 'language': 'Common', 'description': 'Git flow', 'path': ''},
            {'name': 'testing', 'language': 'Common', 'description': 'TDD rules', 'path': ''},
            {'name': 'performance', 'language': 'Common', 'description': 'Token rules', 'path': ''},
            {'name': 'patterns', 'language': 'Common', 'description': 'Design patterns', 'path': ''},
            {'name': 'security', 'language': 'Common', 'description': 'Security rules', 'path': ''},
            {'name': 'typescript', 'language': 'TypeScript', 'description': 'TS patterns', 'path': ''},
            {'name': 'python', 'language': 'Python', 'description': 'Python rules', 'path': ''},
            {'name': 'golang', 'language': 'Go', 'description': 'Go rules', 'path': ''},
            {'name': 'swift', 'language': 'Swift', 'description': 'Swift rules', 'path': ''},
            {'name': 'php', 'language': 'PHP', 'description': 'PHP rules', 'path': ''},
        ]
    
    return rules

# ============================================================================
# MAIN APPLICATION
# ============================================================================

class EGCDashboard(tk.Tk):
    """Main EGC Dashboard Application"""

    def __init__(self):
        super().__init__()

        self.project_path = get_project_path()
        self.title("EGC — Everything Gemini Code")
        self.geometry("1100x800")

        self.withdraw()

        self.agents = load_agents(self.project_path)
        self.skills = load_skills(self.project_path)
        self.commands = load_commands(self.project_path)
        self.rules = load_rules(self.project_path)

        self.create_widgets()
        
        # Hydration complete, show window
        self.deiconify()

    def _load_logo(self, header_frame: tk.Frame):
        """Load the official EGC logo from assets/images/egc-logo.png."""
        logo_path = os.path.join(self.project_path, "assets", "images", "egc-logo.png")
        self.logo_image = None
        
        if os.path.exists(logo_path):
            try:
                img = tk.PhotoImage(file=logo_path)
                self.logo_image = img.subsample(5, 5)
                ttk.Label(header_frame, image=self.logo_image).pack(side=tk.LEFT, padx=(0, 10))
                return
            except Exception as e:
                logging.warning(f"Failed to load logo %s: %s", logo_path, e)
        
        logging.info("Dashboard initialized without branding asset.")

    def create_widgets(self):
        """Create all UI widgets"""
        # Main container
        main_frame = ttk.Frame(self)
        main_frame.pack(fill=tk.BOTH, expand=True, padx=10, pady=10)
        
        # Header
        header_frame = ttk.Frame(main_frame)
        header_frame.pack(fill=tk.X, pady=(0, 10))
        
        self._load_logo(header_frame)
        
        # Title and Credit container
        title_frame = ttk.Frame(header_frame)
        title_frame.pack(side=tk.LEFT, fill=tk.Y)
        
        main_title_frame = ttk.Frame(title_frame)
        main_title_frame.pack(side=tk.TOP, anchor=tk.W)

        self.title_label = ttk.Label(main_title_frame, text="EGC Control Plane", font=('Open Sans', 18, 'bold'))
        self.title_label.pack(side=tk.LEFT)

        # Displayed version (kept simple as v1.0.0; the VERSION file / package.json
        # are not touched by the dashboard).
        self.project_version = "1.0.0"
        self.version_label = ttk.Label(main_title_frame, text=f"v{self.project_version}", font=('Open Sans', 10), foreground='gray')
        self.version_label.pack(side=tk.LEFT, padx=(10, 0))

        cred_font = ('Open Sans', 9)
        # Line 2: the normal product title + author, with the (c) symbol in front
        # of the author's name. "Felipe Marzochi" is a hyperlink to the author's
        # GitHub profile (not the repo).
        sub_credit_frame = ttk.Frame(title_frame)
        sub_credit_frame.pack(side=tk.TOP, anchor=tk.W)
        ttk.Label(sub_credit_frame, text="Everything Gemini Code  -  Desenvolvido por © ",
                  font=cred_font, foreground='gray').pack(side=tk.LEFT)
        self._make_link(sub_credit_frame, "Felipe Marzochi", "https://github.com/Fmarzochi", cred_font)
        # Line 3 (last line): repository link.
        repo_frame = ttk.Frame(title_frame)
        repo_frame.pack(side=tk.TOP, anchor=tk.W)
        self._make_link(repo_frame, "github.com/Fmarzochi/everything-gemini",
                        "https://github.com/Fmarzochi/everything-gemini", cred_font)

        # Notebook (tabs)
        self.notebook = ttk.Notebook(main_frame)

        self.create_agents_tab()
        self.create_skills_tab()
        self.create_commands_tab()
        self.create_rules_tab()
        self.create_live_tab()
        self.create_runtime_tab()
        self.create_execute_tab()
        self.create_settings_tab()

        # Pack notebook after hydration
        self.notebook.pack(fill=tk.BOTH, expand=True)
        
        self.refresh_live_execution()
        
        # Status bar
        status_frame = ttk.Frame(main_frame)
        status_frame.pack(fill=tk.X, pady=(10, 0))
        
        self.status_label = ttk.Label(status_frame, 
                                       text=f"Ready | Agents: {len(self.agents)} | Skills: {len(self.skills)} | Commands: {len(self.commands)}",
                                       font=('Arial', 9), foreground='gray')
        self.status_label.pack(side=tk.LEFT)

        self.credit_label = ttk.Label(status_frame,
                                       text="Everything Gemini Code  -  Desenvolvido por © Felipe Marzochi  -  github.com/Fmarzochi/everything-gemini",
                                       font=('Arial', 9), foreground='gray')
        self.credit_label.pack(side=tk.RIGHT)
    
    # =========================================================================
    # AGENTS TAB
    # =========================================================================
    
    def create_agents_tab(self):
        """Create Agents tab"""
        frame = ttk.Frame(self.notebook)
        self.notebook.add(frame, text=f"Agents ({len(self.agents)})")
        
        search_frame = ttk.Frame(frame)
        search_frame.pack(fill=tk.X, padx=10, pady=10)
        
        ttk.Label(search_frame, text="Search:").pack(side=tk.LEFT)
        self.agent_search = ttk.Entry(search_frame, width=30)
        self.agent_search.pack(side=tk.LEFT, padx=5)
        self.agent_search.bind('<KeyRelease>', self.filter_agents)
        
        ttk.Label(search_frame, text="Count:").pack(side=tk.LEFT, padx=(20, 0))
        self.agent_count_label = ttk.Label(search_frame, text=str(len(self.agents)))
        self.agent_count_label.pack(side=tk.LEFT)
        
        # Split pane: list + details
        paned = ttk.PanedWindow(frame, orient=tk.HORIZONTAL)
        paned.pack(fill=tk.BOTH, expand=True, padx=10, pady=(0, 10))
        
        # Agent list
        list_frame = ttk.Frame(paned)
        paned.add(list_frame, weight=2)

        columns = ('name', 'domain', 'governance', 'purpose')
        self.agent_tree = ttk.Treeview(list_frame, columns=columns, show='tree headings')
        self.agent_tree.heading('#0', text='#')
        self.agent_tree.heading('name', text='Agent')
        self.agent_tree.heading('domain', text='Domain')
        self.agent_tree.heading('governance', text='Scope')
        self.agent_tree.heading('purpose', text='Purpose')
        self.agent_tree.column('#0', width=36, stretch=False)
        self.agent_tree.column('name', width=170, stretch=False)
        self.agent_tree.column('domain', width=140, stretch=False)
        self.agent_tree.column('governance', width=80, stretch=False)
        self.agent_tree.column('purpose', width=320)
        self._configure_badge_tags(self.agent_tree)

        self.agent_tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        # Scrollbar
        scrollbar = ttk.Scrollbar(list_frame, orient=tk.VERTICAL, command=self.agent_tree.yview)
        self.agent_tree.configure(yscrollcommand=scrollbar.set)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)

        # Details panel
        details_frame = ttk.Frame(paned)
        paned.add(details_frame, weight=1)

        agent_head = ttk.Frame(details_frame)
        agent_head.pack(fill=tk.X)
        ttk.Label(agent_head, text="Agent Intelligence", font=('Arial', 11, 'bold')).pack(side=tk.LEFT, pady=5)
        self.agent_open_file_btn = ttk.Button(agent_head, text="Open .md", state=tk.DISABLED,
                                              command=lambda: self._open_path(self._selected_agent_source))
        self.agent_open_file_btn.pack(side=tk.RIGHT, padx=2)
        self.agent_open_dir_btn = ttk.Button(agent_head, text="Open folder", state=tk.DISABLED,
                                             command=lambda: self._open_path(os.path.dirname(self._selected_agent_source) if self._selected_agent_source else ""))
        self.agent_open_dir_btn.pack(side=tk.RIGHT, padx=2)
        self._selected_agent_source = ""

        self.agent_details = scrolledtext.ScrolledText(details_frame, wrap=tk.WORD, height=15)
        self.agent_details.pack(fill=tk.BOTH, expand=True)

        self.agent_tree.bind('<<TreeviewSelect>>', self.on_agent_select)

        # Populate list
        self.populate_agents(self.agents)

    def _configure_badge_tags(self, tree):
        """Color-code rows by cognitive domain (badge tag)."""
        palette = {
            "dom-security": "#fde7e9", "dom-review": "#e7f0fd", "dom-debug": "#fff3e0",
            "dom-test": "#e8f5e9", "dom-plan": "#ede7f6", "dom-refactor": "#e0f7fa",
            "dom-frontend": "#fce4ec", "dom-data": "#e8eaf6", "dom-docs": "#f1f8e9",
            "dom-oss": "#fff8e1", "dom-orch": "#e0f2f1", "dom-lang": "#f3e5f5",
            "dom-general": "#f5f5f5",
        }
        for tag, color in palette.items():
            try:
                tree.tag_configure(tag, background=color)
            except Exception:
                pass

    def populate_agents(self, agents: List[Dict]):
        """Populate agents list"""
        for item in self.agent_tree.get_children():
            self.agent_tree.delete(item)
        for i, agent in enumerate(agents, 1):
            cog = agent.get('cognitive', {})
            self.agent_tree.insert(
                '', tk.END, text=str(i),
                values=(agent['name'], cog.get('domain', 'General'), cog.get('governance_scope', '-'), agent['purpose']),
                tags=(cog.get('badge', 'dom-general'),),
            )

    def filter_agents(self, event=None):
        """Filter agents by name, purpose, domain or semantic tag."""
        query = self.agent_search.get().lower().strip()
        if not query:
            filtered = self.agents
        else:
            def matches(a):
                cog = a.get('cognitive', {})
                hay = " ".join([
                    a['name'], a['purpose'], cog.get('domain', ''),
                    " ".join(cog.get('semantic_tags', [])), " ".join(cog.get('capabilities', [])),
                ]).lower()
                return query in hay
            filtered = [a for a in self.agents if matches(a)]
        self.populate_agents(filtered)
        self.agent_count_label.config(text=str(len(filtered)))
    
    def on_agent_select(self, event):
        """Render the structured cognitive profile of the selected agent."""
        selection = self.agent_tree.selection()
        if not selection:
            return
        item = self.agent_tree.item(selection[0])
        agent_name = item['values'][0]
        agent = next((a for a in self.agents if a['name'] == agent_name), None)
        if not agent:
            return
        cog = agent.get('cognitive', {}) or {}
        strat = agent.get('model_strategy') or cog.get('model_strategy') or describe_model_strategy(agent.get('model', ""))
        raw_hint = (agent.get('model') or "").strip()

        def block(title, body):
            return f"== {title} ==\n{body}\n"

        sections = [f"# AGENT  /{agent.get('slug', agent['name'])}\n{agent['name']}\n"]
        sections.append(block("Purpose", agent['purpose']))
        sections.append(block("Domain / Execution Category", cog.get('domain', 'General Purpose')))
        sections.append(block("When to Use", agent.get('when_to_use', '(see agent file)')))
        if agent.get('role') and agent['role'] != agent.get('when_to_use'):
            sections.append(block("Operating Procedure (excerpt)", agent['role']))
        sections.append(block("Capabilities", "- " + "\n- ".join(cog.get('capabilities', ['general-assistance']))))
        sections.append(block("Tools", agent.get('tools_display', '(inherits caller tools)')))
        sections.append(block("Governance Scope", f"{cog.get('governance_scope', 'advisory')}   |   Risk: {cog.get('risk', 'low')}"))
        sections.append(block("Delegation Behavior", cog.get('delegation', 'leaf worker')))
        sections.append(block("Semantic Tags", ", ".join(cog.get('semantic_tags', []))))
        sections.append(block(
            "Provider / Model Strategy",
            "\n".join([
                f"Provider:            {strat.get('provider', 'Google Gemini')}",
                f"Strategy:            {strat.get('strategy', 'Dynamic Routing')}",
                f"Preferred capability:{' '}{strat.get('preferred_capability', 'general')}",
                f"Resolved model:      {strat.get('resolved_model', '(resolved at runtime)')}",
                f"Fallback chain:      {strat.get('fallback_chain', '(resolved at runtime)')}",
                f"Frontmatter hint:    {raw_hint or '(none - fully dynamic)'}",
            ]),
        ))
        sections.append(block("Compatible Providers", ", ".join(cog.get('compatible_providers', ['Google Gemini (primary)']))))
        sections.append(block("Cognitive Layer", cog.get('cognitive_layer', 'Python cognitive core + Node governance mesh')))
        sections.append(block("Invocation", f"/{agent.get('slug', agent['name'])}   (slash command)  or  agent delegation via the Task tool.\nModels are routed dynamically by the EGC ModelResolver - never pinned to a fixed model ID."))
        if agent.get('source'):
            sections.append(block("Source", agent['source']))

        self.agent_details.delete('1.0', tk.END)
        self.agent_details.insert('1.0', "\n".join(sections))

        self._selected_agent_source = agent.get('source', "") or ""
        has_src = bool(self._selected_agent_source) and os.path.exists(self._selected_agent_source)
        try:
            self.agent_open_file_btn.config(state=(tk.NORMAL if has_src else tk.DISABLED))
            self.agent_open_dir_btn.config(state=(tk.NORMAL if has_src else tk.DISABLED))
        except Exception:
            pass

    # =========================================================================
    # SKILLS TAB
    # =========================================================================
    
    def create_skills_tab(self):
        """Create Skills tab"""
        frame = ttk.Frame(self.notebook)
        self.notebook.add(frame, text=f"Skills ({len(self.skills)})")
        
        filter_frame = ttk.Frame(frame)
        filter_frame.pack(fill=tk.X, padx=10, pady=10)
        
        ttk.Label(filter_frame, text="Search:").pack(side=tk.LEFT)
        self.skill_search = ttk.Entry(filter_frame, width=25)
        self.skill_search.pack(side=tk.LEFT, padx=5)
        self.skill_search.bind('<KeyRelease>', self.filter_skills)
        
        ttk.Label(filter_frame, text="Category:").pack(side=tk.LEFT, padx=(20, 0))
        self.skill_category = ttk.Combobox(filter_frame, values=['All'] + self.get_categories(), width=15)
        self.skill_category.set('All')
        self.skill_category.pack(side=tk.LEFT, padx=5)
        self.skill_category.bind('<<ComboboxSelected>>', self.filter_skills)
        
        ttk.Label(filter_frame, text="Count:").pack(side=tk.LEFT, padx=(20, 0))
        self.skill_count_label = ttk.Label(filter_frame, text=str(len(self.skills)))
        self.skill_count_label.pack(side=tk.LEFT)
        
        paned = ttk.PanedWindow(frame, orient=tk.HORIZONTAL)
        paned.pack(fill=tk.BOTH, expand=True, padx=10, pady=(0, 10))
        
        # Skill list
        list_frame = ttk.Frame(paned)
        paned.add(list_frame, weight=1)
        
        columns = ('name', 'category', 'description')
        self.skill_tree = ttk.Treeview(list_frame, columns=columns, show='tree headings')
        self.skill_tree.heading('#0', text='#')
        self.skill_tree.heading('name', text='Skill Name')
        self.skill_tree.heading('category', text='Category')
        self.skill_tree.heading('description', text='Description')
        
        self.skill_tree.column('#0', width=40)
        self.skill_tree.column('name', width=180)
        self.skill_tree.column('category', width=100)
        self.skill_tree.column('description', width=300)
        self._configure_badge_tags(self.skill_tree)

        self.skill_tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        
        scrollbar = ttk.Scrollbar(list_frame, orient=tk.VERTICAL, command=self.skill_tree.yview)
        self.skill_tree.configure(yscrollcommand=scrollbar.set)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        
        # Details
        details_frame = ttk.Frame(paned)
        paned.add(details_frame, weight=1)

        skill_head = ttk.Frame(details_frame)
        skill_head.pack(fill=tk.X)
        ttk.Label(skill_head, text="Skill Intelligence", font=('Arial', 11, 'bold')).pack(side=tk.LEFT, pady=5)
        self.skill_open_file_btn = ttk.Button(skill_head, text="Open SKILL.md", state=tk.DISABLED,
                                              command=lambda: self._open_path(os.path.join(self._selected_skill_path, "SKILL.md") if self._selected_skill_path else ""))
        self.skill_open_file_btn.pack(side=tk.RIGHT, padx=2)
        self.skill_open_dir_btn = ttk.Button(skill_head, text="Open folder", state=tk.DISABLED,
                                             command=lambda: self._open_path(self._selected_skill_path))
        self.skill_open_dir_btn.pack(side=tk.RIGHT, padx=2)
        self._selected_skill_path = ""

        self.skill_details = scrolledtext.ScrolledText(details_frame, wrap=tk.WORD, height=15)
        self.skill_details.pack(fill=tk.BOTH, expand=True)

        self.skill_tree.bind('<<TreeviewSelect>>', self.on_skill_select)
        
        self.populate_skills(self.skills)
    
    def get_categories(self) -> List[str]:
        """Get unique categories from skills"""
        categories = set(s['category'] for s in self.skills)
        return sorted(categories)
    
    def populate_skills(self, skills: List[Dict]):
        """Populate skills list"""
        for item in self.skill_tree.get_children():
            self.skill_tree.delete(item)
        for i, skill in enumerate(skills, 1):
            badge = (skill.get('cognitive', {}) or {}).get('badge', 'dom-general')
            self.skill_tree.insert('', tk.END, text=str(i),
                                  values=(skill['name'], skill['category'], skill['description']),
                                  tags=(badge,))
    
    def filter_skills(self, event=None):
        """Filter skills based on search and category"""
        search = self.skill_search.get().lower()
        category = self.skill_category.get()
        
        filtered = self.skills
        
        if category != 'All':
            filtered = [s for s in filtered if s['category'] == category]
        
        if search:
            filtered = [s for s in filtered 
                       if search in s['name'].lower() or search in s['description'].lower()]
        
        self.populate_skills(filtered)
        self.skill_count_label.config(text=str(len(filtered)))
    
    def on_skill_select(self, event):
        """Render the structured cognitive profile of the selected skill."""
        selection = self.skill_tree.selection()
        if not selection:
            return
        item = self.skill_tree.item(selection[0])
        skill_name = item['values'][0]
        skill = next((s for s in self.skills if s['name'] == skill_name), None)
        if not skill:
            return
        cog = skill.get('cognitive', {}) or {}

        def block(title, body):
            return f"== {title} ==\n{body}\n"

        sections = [f"# SKILL  {skill.get('slug', skill['name'])}\n{skill['name']}\n"]
        sections.append(block("Description", skill['description']))
        sections.append(block("Semantic Category / Execution Domain", f"{skill['category']}   |   {cog.get('domain', 'General')}"))
        sections.append(block("Activation Triggers", skill.get('activation', '(see SKILL.md)')))
        sections.append(block("Capabilities", "- " + "\n- ".join(cog.get('capabilities', ['general-assistance']))))
        sections.append(block("Runtime / Governance Scope", f"{cog.get('governance_scope', 'advisory')}   |   Risk: {cog.get('risk', 'low')}"))
        sections.append(block("Orchestration Impact", cog.get('delegation', 'leaf worker')))
        sections.append(block("Semantic Tags", ", ".join(cog.get('semantic_tags', []))))
        sections.append(block("Provider Affinity", ", ".join(cog.get('compatible_providers', ['Google Gemini (primary)']))))
        sections.append(block("Cognitive Layer", cog.get('cognitive_layer', 'Python cognitive core + Node governance mesh')))
        sections.append(block("Source", get_file_uri(os.path.join(skill['path'], 'SKILL.md'))))
        sections.append(block("Usage", "Activated automatically when the working context matches this skill's domain; open SKILL.md for the full procedure and examples."))

        self.skill_details.delete('1.0', tk.END)
        self.skill_details.insert('1.0', "\n".join(sections))

        self._selected_skill_path = skill.get('path', "") or ""
        has_dir = bool(self._selected_skill_path) and os.path.isdir(self._selected_skill_path)
        has_file = has_dir and os.path.isfile(os.path.join(self._selected_skill_path, "SKILL.md"))
        try:
            self.skill_open_dir_btn.config(state=(tk.NORMAL if has_dir else tk.DISABLED))
            self.skill_open_file_btn.config(state=(tk.NORMAL if has_file else tk.DISABLED))
        except Exception:
            pass
    
    # =========================================================================
    # COMMANDS TAB
    # =========================================================================
    
    def create_commands_tab(self):
        """Create Commands tab"""
        frame = ttk.Frame(self.notebook)
        self.notebook.add(frame, text=f"Commands ({len(self.commands)})")
        
        # Info
        info_frame = ttk.Frame(frame)
        info_frame.pack(fill=tk.X, padx=10, pady=10)
        
        ttk.Label(info_frame, text="Slash Commands for Gemini Code:", 
                  font=('Arial', 10, 'bold')).pack(anchor=tk.W)
        ttk.Label(info_frame, text="Use these commands in Gemini Code by typing /command_name", 
                  foreground='gray').pack(anchor=tk.W)
        
        # Commands list
        list_frame = ttk.Frame(frame)
        list_frame.pack(fill=tk.BOTH, expand=True, padx=10, pady=(0, 10))
        
        columns = ('name', 'description')
        self.command_tree = ttk.Treeview(list_frame, columns=columns, show='tree headings')
        self.command_tree.heading('#0', text='#')
        self.command_tree.heading('name', text='Command')
        self.command_tree.heading('description', text='Description')
        
        self.command_tree.column('#0', width=40)
        self.command_tree.column('name', width=150)
        self.command_tree.column('description', width=400)
        
        self.command_tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        
        scrollbar = ttk.Scrollbar(list_frame, orient=tk.VERTICAL, command=self.command_tree.yview)
        self.command_tree.configure(yscrollcommand=scrollbar.set)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        
        # Populate
        for i, cmd in enumerate(self.commands, 1):
            self.command_tree.insert('', tk.END, text=str(i), 
                                   values=('/' + cmd['name'], cmd['description']))
    
    # =========================================================================
    # RULES TAB
    # =========================================================================
    
    def create_rules_tab(self):
        """Create Rules tab"""
        frame = ttk.Frame(self.notebook)
        self.notebook.add(frame, text=f"Rules ({len(self.rules)})")
        
        # Info
        info_frame = ttk.Frame(frame)
        info_frame.pack(fill=tk.X, padx=10, pady=10)
        
        ttk.Label(info_frame, text="Coding Rules by Language:", 
                  font=('Arial', 10, 'bold')).pack(anchor=tk.W)
        ttk.Label(info_frame, text="These rules are automatically applied in Gemini Code", 
                  foreground='gray').pack(anchor=tk.W)
        
        filter_frame = ttk.Frame(frame)
        filter_frame.pack(fill=tk.X, padx=10, pady=5)
        
        ttk.Label(filter_frame, text="Language:").pack(side=tk.LEFT)
        self.rules_language = ttk.Combobox(filter_frame, 
                                           values=['All'] + self.get_rule_languages(), 
                                           width=15)
        self.rules_language.set('All')
        self.rules_language.pack(side=tk.LEFT, padx=5)
        self.rules_language.bind('<<ComboboxSelected>>', self.filter_rules)
        
        # Split pane: list + details
        paned = ttk.PanedWindow(frame, orient=tk.HORIZONTAL)
        paned.pack(fill=tk.BOTH, expand=True, padx=10, pady=(0, 10))

        # Rules list
        list_frame = ttk.Frame(paned)
        paned.add(list_frame, weight=1)
        
        columns = ('name', 'language')
        self.rules_tree = ttk.Treeview(list_frame, columns=columns, show='tree headings')
        self.rules_tree.heading('#0', text='#')
        self.rules_tree.heading('name', text='Rule Name')
        self.rules_tree.heading('language', text='Language')
        
        self.rules_tree.column('#0', width=40)
        self.rules_tree.column('name', width=200)
        self.rules_tree.column('language', width=100)
        
        self.rules_tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        
        scrollbar = ttk.Scrollbar(list_frame, orient=tk.VERTICAL, command=self.rules_tree.yview)
        self.rules_tree.configure(yscrollcommand=scrollbar.set)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        
        # Details panel
        details_frame = ttk.Frame(paned)
        paned.add(details_frame, weight=1)
        
        ttk.Label(details_frame, text="Rule Details", font=('Arial', 11, 'bold')).pack(anchor=tk.W, pady=5)
        
        self.rule_details = scrolledtext.ScrolledText(details_frame, wrap=tk.WORD, height=15)
        self.rule_details.pack(fill=tk.BOTH, expand=True)

        self.rules_tree.bind('<<TreeviewSelect>>', self.on_rule_select)
        
        self.populate_rules(self.rules)
    
    def on_rule_select(self, event):
        """Handle rule selection"""
        selection = self.rules_tree.selection()
        if not selection:
            return
        
        item = self.rules_tree.item(selection[0])
        rule_name = item['values'][0]
        
        rule = next((r for r in self.rules if r['name'] == rule_name), None)
        if rule:
            content = ""
            if rule['path'] and os.path.exists(rule['path']):
                try:
                    with open(rule['path'], 'r', encoding='utf-8') as f:
                        content = f.read()
                except:
                    content = "Error reading rule file."
            else:
                content = rule['description']
                
            details = f"""Rule: {rule['name']}
Language: {rule['language']}
Path: {rule['path']}

---
Content:
{content}"""
            self.rule_details.delete('1.0', tk.END)
            self.rule_details.insert('1.0', details)

    def get_rule_languages(self) -> List[str]:
        """Get unique languages from rules"""
        languages = set(r['language'] for r in self.rules)
        return sorted(languages)
    
    def populate_rules(self, rules: List[Dict]):
        """Populate rules list"""
        for item in self.rules_tree.get_children():
            self.rules_tree.delete(item)
        
        for i, rule in enumerate(rules, 1):
            self.rules_tree.insert('', tk.END, text=str(i),
                                  values=(rule['name'], rule['language']))
    
    def filter_rules(self, event=None):
        """Filter rules by language"""
        language = self.rules_language.get()

        if language == 'All':
            filtered = self.rules
        else:
            filtered = [r for r in self.rules if r['language'] == language]

        self.populate_rules(filtered)

    # =========================================================================
    # LIVE EXECUTION TAB
    # =========================================================================

    def create_live_tab(self):
        """Create Live Execution tab"""
        frame = ttk.Frame(self.notebook)
        self.notebook.add(frame, text="Live Execution")

        # Header with controls
        header = ttk.Frame(frame)
        header.pack(fill=tk.X, padx=10, pady=10)

        ttk.Label(header, text="Live Orchestration Events", font=('Arial', 11, 'bold')).pack(side=tk.LEFT)
        self.auto_scroll_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(header, text="Auto-scroll", variable=self.auto_scroll_var).pack(side=tk.RIGHT)

        # Events Treeview
        columns = ('timestamp', 'type', 'agent', 'data')
        self.live_tree = ttk.Treeview(frame, columns=columns, show='headings')
        self.live_tree.heading('timestamp', text='Time')
        self.live_tree.heading('type', text='Event')
        self.live_tree.heading('agent', text='Agent')
        self.live_tree.heading('data', text='Details')

        self.live_tree.column('timestamp', width=120, stretch=False)
        self.live_tree.column('type', width=100, stretch=False)
        self.live_tree.column('agent', width=120, stretch=False)
        self.live_tree.column('data', width=400)

        self.live_tree.pack(fill=tk.BOTH, expand=True, padx=10, pady=(0, 10))

        scrollbar = ttk.Scrollbar(frame, orient=tk.VERTICAL, command=self.live_tree.yview)
        self.live_tree.configure(yscrollcommand=scrollbar.set)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)

        self.last_trace_count = 0

    def refresh_live_execution(self):
        """Update the live execution feed from the log file efficiently"""
        log_path = os.path.join(self.project_path, ".sessions", "execution_log.jsonl")
        MAX_ROWS = 1000  # Prevent memory bloat
        
        if os.path.exists(log_path):
            try:
                with open(log_path, "r", encoding="utf-8") as f:
                    lines = f.readlines()
                    if len(lines) > self.last_trace_count:
                        new_lines = lines[self.last_trace_count:]
                        
                        for line in new_lines:
                            try:
                                event = json.loads(line)
                                ts = time.strftime('%H:%M:%S', time.localtime(event['timestamp']))
                                etype = event.get('type', 'event')
                                data = event.get('data', {})
                                agent = data.get('selected_agent', data.get('failed_agent', '-'))

                                details = str(data)
                                if etype == 'start': details = f"Task: {data.get('task')}"
                                elif etype == 'error': details = f"ERROR: {data.get('message')}"

                                item = self.live_tree.insert('', tk.END, values=(ts, etype, agent, details))
                                if self.auto_scroll_var.get():
                                    self.live_tree.see(item)
                            except json.JSONDecodeError:
                                pass # Skip malformed lines
                        
                        self.last_trace_count = len(lines)
                        
                        # Prune excess rows to reduce memory pressure
                        children = self.live_tree.get_children()
                        if len(children) > MAX_ROWS:
                            for child in children[:-MAX_ROWS]:
                                self.live_tree.delete(child)
                                
            except Exception as e:
                # Silently fail in refresh loop
                pass

        # Schedule next refresh
        self.after(2000, self.refresh_live_execution)

    # =========================================================================
    # RUNTIME TAB (Control-plane / Observability)
    # =========================================================================

    def _runtime_snapshot(self) -> str:
        """Build the text body for the Runtime tab: provider, model registry,
        fallback chains, hook mesh, observers, and ecosystem counts."""
        lines: List[str] = []
        lines.append("# EGC RUNTIME / CONTROL PLANE")
        lines.append(f"Project: Everything Gemini Code  v{getattr(self, 'project_version', read_project_version(self.project_path))}")
        lines.append(f"Path:    {self.project_path}")
        lines.append("")

        # --- Provider / model intelligence ---
        lines.append("== PROVIDER & MODEL ROUTING ==")
        active_provider = os.environ.get("LLM_PROVIDER", os.environ.get("EGC_PROVIDER", "gemini"))
        env_model = os.environ.get("LLM_MODEL") or os.environ.get("EGC_MODEL") or os.environ.get("ECC_MODEL") or "(unset - dynamic)"
        lines.append(f"Active provider (env):  {active_provider}")
        lines.append(f"Model override (env):   {env_model}")
        if _MODEL_RESOLVER is not None:
            try:
                strat = _MODEL_RESOLVER.describe_strategy(None, provider="gemini")
                lines.append(f"Default strategy:       {strat.get('strategy')}  ->  {strat.get('resolved_model')}")
                lines.append(f"Default fallback chain: {strat.get('fallback_chain')}")
                lines.append("")
                lines.append("Model registry (capability-tiered, dynamic; future / Vertex IDs pass through):")
                for mid in _MODEL_RESOLVER.list_models("gemini"):
                    info = _MODEL_RESOLVER.get_model_info(mid)
                    caps = ", ".join(str(getattr(c, "value", c)) for c in info.get("capabilities", []))
                    cw = info.get("context_window")
                    lines.append(f"  - {mid:<26} ctx={cw or '?':<9} caps=[{caps}]")
                lines.append("")
                lines.append("Symbolic aliases (legacy + tiers, all resolver-mapped):")
                lines.append("  " + ", ".join(_MODEL_RESOLVER.list_available_models()))
            except Exception as e:
                lines.append(f"  (ModelResolver query failed: {e})")
        else:
            lines.append("  (ModelResolver not importable from this process - showing static info only)")
        lines.append("")

        # --- Hook mesh ---
        lines.append("== HOOK MESH (governance) ==")
        hooks_json = os.path.join(self.project_path, "hooks", "hooks.json")
        if os.path.isfile(hooks_json):
            try:
                with open(hooks_json, "r", encoding="utf-8") as f:
                    hooks = json.load(f)
                hook_root = hooks.get("hooks", hooks) if isinstance(hooks, dict) else {}
                for event, matchers in (hook_root.items() if isinstance(hook_root, dict) else []):
                    count = 0
                    if isinstance(matchers, list):
                        for m in matchers:
                            count += len(m.get("hooks", [])) if isinstance(m, dict) else 0
                    lines.append(f"  {event:<22} {count} hook(s)")
            except Exception as e:
                lines.append(f"  (could not parse hooks.json: {e})")
        else:
            lines.append("  (hooks/hooks.json not found)")
        lines.append("")

        # --- Observers / continuous learning ---
        lines.append("== OBSERVERS / CONTINUOUS LEARNING ==")
        clv2 = os.path.join(self.project_path, "skills", "continuous-learning-v2")
        if os.path.isdir(clv2):
            agents_dir = os.path.join(clv2, "agents")
            hooks_dir = os.path.join(clv2, "hooks")
            n_agents = len([f for f in os.listdir(agents_dir)]) if os.path.isdir(agents_dir) else 0
            n_hooks = len([f for f in os.listdir(hooks_dir)]) if os.path.isdir(hooks_dir) else 0
            lines.append(f"  continuous-learning-v2: {n_agents} agent script(s), {n_hooks} hook script(s)")
            lines.append("  observer-loop guards: EGC_SKIP_OBSERVE / EGC_HOOK_PROFILE (canonical) + ECC_* (legacy bridge)")
        else:
            lines.append("  (continuous-learning-v2 skill not installed)")
        lines.append("")

        # --- Ecosystem counts ---
        lines.append("== ECOSYSTEM ==")
        lines.append(f"  Agents:   {len(self.agents)}")
        lines.append(f"  Skills:   {len(self.skills)}")
        lines.append(f"  Commands: {len(self.commands)}")
        lines.append(f"  Rules:    {len(self.rules)}")
        # Domain distribution of agents.
        dist: Dict[str, int] = {}
        for a in self.agents:
            d = (a.get("cognitive", {}) or {}).get("domain", "General Purpose")
            dist[d] = dist.get(d, 0) + 1
        lines.append("  Agent domains: " + ", ".join(f"{k} ({v})" for k, v in sorted(dist.items(), key=lambda kv: -kv[1])))
        lines.append("")
        lines.append("---")
        lines.append("EGC routes models dynamically (no fixed model); Gemini is the native provider,")
        lines.append("with Claude / OpenAI / Ollama kept as interchangeable bridges. ECC_* env vars and")
        lines.append("symbol aliases remain valid as a permanent legacy compatibility layer.")
        return "\n".join(lines)

    def create_runtime_tab(self):
        """Create the Runtime / control-plane tab."""
        frame = ttk.Frame(self.notebook)
        self.notebook.add(frame, text="Runtime")

        bar = ttk.Frame(frame)
        bar.pack(fill=tk.X, padx=10, pady=10)
        ttk.Label(bar, text="Runtime & Provider Intelligence", font=('Arial', 11, 'bold')).pack(side=tk.LEFT)
        ttk.Button(bar, text="Refresh", command=self.refresh_runtime).pack(side=tk.RIGHT)

        self.runtime_text = scrolledtext.ScrolledText(frame, wrap=tk.WORD)
        self.runtime_text.pack(fill=tk.BOTH, expand=True, padx=10, pady=(0, 10))
        try:
            self.runtime_text.insert('1.0', self._runtime_snapshot())
        except Exception as e:
            self.runtime_text.insert('1.0', f"(runtime snapshot unavailable: {e})")

    def refresh_runtime(self):
        """Re-render the runtime snapshot."""
        try:
            self.runtime_text.delete('1.0', tk.END)
            self.runtime_text.insert('1.0', self._runtime_snapshot())
        except Exception as e:
            self.runtime_text.delete('1.0', tk.END)
            self.runtime_text.insert('1.0', f"(runtime snapshot unavailable: {e})")

    # =========================================================================
    # SETTINGS TAB
    # =========================================================================

    def create_execute_tab(self):
        """Execute tab — minimal control plane that runs the Python ReAct runtime."""
        frame = ttk.Frame(self.notebook)
        self.notebook.add(frame, text="Execute")

        ttk.Label(
            frame,
            text="Run a prompt through the Python ReAct runtime (python -m llm.cli.prompt). Requires a provider key (e.g. GEMINI_API_KEY).",
            font=('Open Sans', 10), foreground='gray', wraplength=900, justify=tk.LEFT,
        ).pack(fill=tk.X, padx=10, pady=(10, 5))

        entry_frame = ttk.Frame(frame)
        entry_frame.pack(fill=tk.X, padx=10, pady=5)
        ttk.Label(entry_frame, text="Prompt:").pack(side=tk.LEFT, padx=(0, 5))
        self.execute_prompt_entry = ttk.Entry(entry_frame)
        self.execute_prompt_entry.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=5)
        self.execute_run_button = ttk.Button(entry_frame, text="Run", command=self._on_execute_run)
        self.execute_run_button.pack(side=tk.LEFT)

        output_frame = ttk.LabelFrame(frame, text="Runtime output", padding=10)
        output_frame.pack(fill=tk.BOTH, expand=True, padx=10, pady=10)
        self.execute_output = scrolledtext.ScrolledText(output_frame, wrap=tk.WORD, height=20, state=tk.DISABLED)
        self.execute_output.pack(fill=tk.BOTH, expand=True)

        self._execute_queue = None
        self._execute_thread = None

    def _append_execute_output(self, text: str) -> None:
        if not hasattr(self, 'execute_output'):
            return
        self.execute_output.configure(state=tk.NORMAL)
        self.execute_output.insert(tk.END, text)
        self.execute_output.see(tk.END)
        self.execute_output.configure(state=tk.DISABLED)

    def _on_execute_run(self) -> None:
        prompt = self.execute_prompt_entry.get().strip()
        if not prompt or self._execute_thread is not None:
            return
        self.execute_run_button.configure(state=tk.DISABLED)
        self._append_execute_output(f"$ python -m llm.cli.prompt -p {prompt!r}\n")

        env = os.environ.copy()
        src_path = os.path.join(self.project_path, "src")
        existing_pp = env.get("PYTHONPATH", "")
        env["PYTHONPATH"] = src_path + (os.pathsep + existing_pp if existing_pp else "")
        env.setdefault("EGC_SESSION_ID", f"dashboard-{int(time.time())}")
        env.setdefault("EGC_PLUGIN_ROOT", self.project_path)
        env.setdefault("PROJECT_ROOT", self.project_path)

        self._execute_queue = queue.Queue()

        def runner():
            try:
                proc = subprocess.Popen(
                    [sys.executable, "-m", "llm.cli.prompt", "-p", prompt],
                    cwd=self.project_path,
                    env=env,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    bufsize=1,
                )
                for line in proc.stdout:
                    self._execute_queue.put(line)
                proc.wait()
                self._execute_queue.put(f"\n[exit code: {proc.returncode}]\n")
            except Exception as exc:
                self._execute_queue.put(f"[error] {exc}\n")
            finally:
                self._execute_queue.put(None)

        self._execute_thread = threading.Thread(target=runner, daemon=True)
        self._execute_thread.start()
        self.after(100, self._poll_execute_output)

    def _poll_execute_output(self) -> None:
        if self._execute_queue is None:
            return
        try:
            while True:
                item = self._execute_queue.get_nowait()
                if item is None:
                    self._execute_queue = None
                    self._execute_thread = None
                    self.execute_run_button.configure(state=tk.NORMAL)
                    return
                self._append_execute_output(item)
        except queue.Empty:
            pass
        self.after(100, self._poll_execute_output)

    def create_settings_tab(self):
        """Create Settings tab"""
        frame = ttk.Frame(self.notebook)
        self.notebook.add(frame, text="Settings")
        
        # Project path
        path_frame = ttk.LabelFrame(frame, text="Project Path", padding=10)
        path_frame.pack(fill=tk.X, padx=10, pady=10)
        
        self.path_entry = ttk.Entry(path_frame, width=60)
        self.path_entry.insert(0, self.project_path)
        self.path_entry.pack(side=tk.LEFT, fill=tk.X, expand=True)
        
        ttk.Button(path_frame, text="Browse...", command=self.browse_path).pack(side=tk.LEFT, padx=5)
        
        # Theme
        theme_frame = ttk.LabelFrame(frame, text="Appearance", padding=10)
        theme_frame.pack(fill=tk.X, padx=10, pady=10)
        
        ttk.Label(theme_frame, text="Theme:").pack(anchor=tk.W)
        self.theme_var = tk.StringVar(value='light')
        light_rb = ttk.Radiobutton(theme_frame, text="Light", variable=self.theme_var, 
                       value='light', command=self.apply_theme)
        light_rb.pack(anchor=tk.W)
        dark_rb = ttk.Radiobutton(theme_frame, text="Dark", variable=self.theme_var, 
                       value='dark', command=self.apply_theme)
        dark_rb.pack(anchor=tk.W)
        
        font_frame = ttk.LabelFrame(frame, text="Font", padding=10)
        font_frame.pack(fill=tk.X, padx=10, pady=10)
        
        ttk.Label(font_frame, text="Font Family:").pack(anchor=tk.W)
        self.font_var = tk.StringVar(value='Open Sans')
        
        fonts = ['Open Sans', 'Arial', 'Helvetica', 'Times New Roman', 'Courier New', 'Verdana', 'Georgia', 'Tahoma', 'Trebuchet MS']
        self.font_combo = ttk.Combobox(font_frame, textvariable=self.font_var, values=fonts, state='readonly')
        self.font_combo.pack(anchor=tk.W, fill=tk.X, pady=(5, 0))
        self.font_combo.bind('<<ComboboxSelected>>', lambda e: self.apply_theme())
        
        ttk.Label(font_frame, text="Font Size:").pack(anchor=tk.W, pady=(10, 0))
        self.size_var = tk.StringVar(value='10')
        sizes = ['8', '9', '10', '11', '12', '14', '16', '18', '20']
        self.size_combo = ttk.Combobox(font_frame, textvariable=self.size_var, values=sizes, state='readonly', width=10)
        self.size_combo.pack(anchor=tk.W, pady=(5, 0))
        self.size_combo.bind('<<ComboboxSelected>>', lambda e: self.apply_theme())
        
        # Quick Actions
        actions_frame = ttk.LabelFrame(frame, text="Quick Actions", padding=10)
        actions_frame.pack(fill=tk.BOTH, expand=True, padx=10, pady=10)
        
        ttk.Button(actions_frame, text="Open Project in Terminal", 
                  command=self.open_terminal).pack(fill=tk.X, pady=2)
        ttk.Button(actions_frame, text="Open README", 
                  command=self.open_readme).pack(fill=tk.X, pady=2)
        ttk.Button(actions_frame, text="Open AGENTS.md", 
                  command=self.open_agents).pack(fill=tk.X, pady=2)
        ttk.Button(actions_frame, text="Refresh Data", 
                  command=self.refresh_data).pack(fill=tk.X, pady=2)
        
        # About
        about_frame = ttk.LabelFrame(frame, text="About", padding=10)
        about_frame.pack(fill=tk.X, padx=10, pady=10)
        
        about_text = (
            "Everything Gemini Code\n"
            "Desenvolvido por © Felipe Marzochi\n"
            "https://github.com/Fmarzochi/everything-gemini\n\n"
            "Cognitive agentic runtime / orchestration fabric, Gemini-native.\n"
            "Cross-platform control plane for exploring and operating EGC\n"
            "agents, skills, rules, commands and runtime.\n\n"
            f"Version: {getattr(self, 'project_version', '1.0.0')}"
        )
        ttk.Label(about_frame, text=about_text, justify=tk.LEFT).pack(anchor=tk.W)
    
    def browse_path(self):
        """Browse for project path"""
        from tkinter import filedialog
        path = filedialog.askdirectory(initialdir=self.project_path)
        if path:
            self.path_entry.delete(0, tk.END)
            self.path_entry.insert(0, path)
    
    def _open_url(self, url: str):
        """Open a URL in the default web browser."""
        try:
            webbrowser.open(url)
        except Exception as e:
            messagebox.showerror("Error", f"Could not open URL:\n{url}\n\n{e}")

    def _make_link(self, parent, text: str, url: str, font):
        """Create a clickable hyperlink-styled label that opens `url` in the browser."""
        link = ttk.Label(parent, text=text, font=font, foreground="#1565c0", cursor="hand2")
        link.pack(side=tk.LEFT)
        link.bind("<Button-1>", lambda _e, u=url: self._open_url(u))
        link.bind("<Enter>", lambda _e, w=link: w.configure(font=(font[0], font[1], "underline")))
        link.bind("<Leave>", lambda _e, w=link: w.configure(font=font))
        return link

    def _open_path(self, path: str):
        """Open a file or directory in the OS default handler (cross-platform)."""
        if not open_in_explorer(path):
            messagebox.showerror("Not found", f"Path not found or could not be opened:\n{path or '(empty)'}")

    def open_terminal(self):
        """Open terminal at project path"""
        path = self.path_entry.get()
        argv, kwargs = build_terminal_launch(path)
        subprocess.Popen(argv, **kwargs)
    
    def open_readme(self):
        """Open README in default browser/reader"""
        path = os.path.join(self.path_entry.get(), 'README.md')
        if not open_in_explorer(path):
            messagebox.showerror("Error", "README.md not found")
    
    def open_agents(self):
        """Open AGENTS.md"""
        path = os.path.join(self.path_entry.get(), 'AGENTS.md')
        if not open_in_explorer(path):
            messagebox.showerror("Error", "AGENTS.md not found")
    
    def refresh_data(self):
        """Refresh all data"""
        self.project_path = self.path_entry.get()
        self.project_version = read_project_version(self.project_path)
        self.agents = load_agents(self.project_path)
        self.skills = load_skills(self.project_path)
        self.commands = load_commands(self.project_path)
        self.rules = load_rules(self.project_path)

        # Update tabs (Agents/Skills/Commands/Rules are tabs 0-3; Runtime=4, Settings=5)
        self.notebook.tab(0, text=f"Agents ({len(self.agents)})")
        self.notebook.tab(1, text=f"Skills ({len(self.skills)})")
        self.notebook.tab(2, text=f"Commands ({len(self.commands)})")
        self.notebook.tab(3, text=f"Rules ({len(self.rules)})")

        # Repopulate
        self.populate_agents(self.agents)
        self.populate_skills(self.skills)
        try:
            self.version_label.config(text=f"v{self.project_version}")
        except Exception:
            pass
        try:
            self.refresh_runtime()
        except Exception:
            pass

        self.status_label.config(
            text=f"Ready | v{self.project_version} | Agents: {len(self.agents)} | Skills: {len(self.skills)} | Commands: {len(self.commands)} | Rules: {len(self.rules)}"
        )
        messagebox.showinfo("Success", "Data refreshed successfully!")

    def apply_theme(self):
        theme = self.theme_var.get()
        font_family = self.font_var.get()
        font_size = int(self.size_var.get())
        font_tuple = (font_family, font_size)
        
        if theme == 'dark':
            bg_color = '#2b2b2b'
            fg_color = '#ffffff'
            entry_bg = '#3c3c3c'
            frame_bg = '#2b2b2b'
            select_bg = '#0f5a9e'
        else:
            bg_color = '#f0f0f0'
            fg_color = '#000000'
            entry_bg = '#ffffff'
            frame_bg = '#f0f0f0'
            select_bg = '#e0e0e0'
        
        self.configure(background=bg_color)
        
        style = ttk.Style()
        style.configure('.', background=bg_color, foreground=fg_color, font=font_tuple)
        style.configure('TFrame', background=bg_color, font=font_tuple)
        style.configure('TLabel', background=bg_color, foreground=fg_color, font=font_tuple)
        style.configure('TNotebook', background=bg_color, font=font_tuple)
        style.configure('TNotebook.Tab', background=frame_bg, foreground=fg_color, font=font_tuple)
        style.map('TNotebook.Tab', background=[('selected', select_bg)])
        style.configure('Treeview', background=entry_bg, foreground=fg_color, fieldbackground=entry_bg, font=font_tuple)
        style.configure('Treeview.Heading', background=frame_bg, foreground=fg_color, font=font_tuple)
        style.configure('TEntry', fieldbackground=entry_bg, foreground=fg_color, font=font_tuple)
        style.configure('TButton', background=frame_bg, foreground=fg_color, font=font_tuple)
        
        self.title_label.configure(font=(font_family, 18, 'bold'))
        self.version_label.configure(font=(font_family, 10))
        
        def update_widget_colors(widget):
            try:
                widget.configure(background=bg_color)
            except:
                pass
            for child in widget.winfo_children():
                try:
                    child.configure(background=bg_color)
                except:
                    pass
                try:
                    update_widget_colors(child)
                except:
                    pass
        
        try:
            update_widget_colors(self)
        except:
            pass
        
        self.update()


# ============================================================================
# ============================================================================

def main():
    """Main entry point"""
    app = EGCDashboard()
    print("[TRACE] creating Tk root")
    print("[TRACE] entering mainloop")
    app.mainloop()


if __name__ == "__main__":
    main()
