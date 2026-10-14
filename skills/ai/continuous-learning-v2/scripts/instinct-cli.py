#!/usr/bin/env python3
"""
Instinct CLI - Manage instincts for Continuous Learning v2

v2.1: Project-scoped instincts — different projects get different instincts,
      with global instincts applied universally.

Commands:
  status   - Show all instincts (project + global) and their status
  import   - Import instincts from file or URL
  export   - Export instincts to file
  evolve   - Cluster instincts into skills/commands/agents
  promote  - Promote project instincts to global scope
  projects - List all known projects and their instinct counts
  prune    - Delete pending instincts older than 30 days (TTL)
"""

import argparse
import json
import hashlib
import os
import subprocess
import sys
import re
from pathlib import Path
from datetime import datetime, timezone
from collections import defaultdict

# Siblings live next to this script; make sure they resolve regardless of
# how this file is invoked (direct CLI run, or loaded under a different
# module name via importlib.util, as the test suite does).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from instinct_cli_paths import (  # noqa: E402
    _home_dir,
    HOMUNCULUS_DIR,
    PROJECTS_DIR,
    REGISTRY_FILE,
    GLOBAL_INSTINCTS_DIR,
    GLOBAL_PERSONAL_DIR,
    GLOBAL_INHERITED_DIR,
    GLOBAL_EVOLVED_DIR,
    GLOBAL_OBSERVATIONS_FILE,
    PROMOTE_CONFIDENCE_THRESHOLD,
    PROMOTE_MIN_PROJECTS,
    ALLOWED_INSTINCT_EXTENSIONS,
    PENDING_TTL_DAYS,
    PENDING_EXPIRY_WARNING_DAYS,
    _ensure_global_dirs,
)
from instinct_cli_parsing import (  # noqa: E402
    _validate_file_path,
    _validate_instinct_id,
    _yaml_quote,
    parse_instinct_file,
    _load_instincts_from_dir,
)
from instinct_cli_transfer import cmd_import, cmd_export  # noqa: E402
from instinct_cli_evolve import cmd_evolve, _generate_evolved  # noqa: E402
from instinct_cli_pending import cmd_prune, _collect_pending_instincts  # noqa: E402

try:
    import fcntl
    _HAS_FCNTL = True
except ImportError:
    _HAS_FCNTL = False  # Windows — skip file locking


# ─────────────────────────────────────────────
# Project Detection (Python equivalent of detect-project.sh)
# ─────────────────────────────────────────────

def detect_project() -> dict:
    """Detect current project context. Returns dict with id, name, root, project_dir."""
    project_root = None

    # 1. GEMINI_PROJECT_DIR env var
    env_dir = os.environ.get("GEMINI_PROJECT_DIR")
    if env_dir and os.path.isdir(env_dir):
        project_root = env_dir

    # 2. git repo root
    if not project_root:
        try:
            result = subprocess.run(
                ["git", "rev-parse", "--show-toplevel"],
                capture_output=True, text=True, timeout=5
            )
            if result.returncode == 0:
                project_root = result.stdout.strip()
        except (subprocess.TimeoutExpired, FileNotFoundError):
            pass

    # Normalize: strip trailing slashes to keep basename and hash stable
    if project_root:
        project_root = project_root.rstrip("/")

    # 3. No project — global fallback
    if not project_root:
        return {
            "id": "global",
            "name": "global",
            "root": "",
            "project_dir": HOMUNCULUS_DIR,
            "instincts_personal": GLOBAL_PERSONAL_DIR,
            "instincts_inherited": GLOBAL_INHERITED_DIR,
            "evolved_dir": GLOBAL_EVOLVED_DIR,
            "observations_file": GLOBAL_OBSERVATIONS_FILE,
        }

    project_name = os.path.basename(project_root)

    # Derive project ID from git remote URL or path
    remote_url = ""
    try:
        result = subprocess.run(
            ["git", "-C", project_root, "remote", "get-url", "origin"],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0:
            remote_url = result.stdout.strip()
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass

    hash_source = remote_url if remote_url else project_root
    project_id = hashlib.sha256(hash_source.encode()).hexdigest()[:12]

    project_dir = PROJECTS_DIR / project_id

    for d in [
        project_dir / "instincts" / "personal",
        project_dir / "instincts" / "inherited",
        project_dir / "observations.archive",
        project_dir / "evolved" / "skills",
        project_dir / "evolved" / "commands",
        project_dir / "evolved" / "agents",
    ]:
        d.mkdir(parents=True, exist_ok=True)

    _update_registry(project_id, project_name, project_root, remote_url)

    return {
        "id": project_id,
        "name": project_name,
        "root": project_root,
        "remote": remote_url,
        "project_dir": project_dir,
        "instincts_personal": project_dir / "instincts" / "personal",
        "instincts_inherited": project_dir / "instincts" / "inherited",
        "evolved_dir": project_dir / "evolved",
        "observations_file": project_dir / "observations.jsonl",
    }


def _update_registry(pid: str, pname: str, proot: str, premote: str) -> None:
    """Update the projects.json registry.

    Uses file locking (where available) to prevent concurrent sessions from
    overwriting each other's updates.
    """
    REGISTRY_FILE.parent.mkdir(parents=True, exist_ok=True)
    lock_path = REGISTRY_FILE.parent / f".{REGISTRY_FILE.name}.lock"
    lock_fd = None

    try:
        # Acquire advisory lock to serialize read-modify-write
        if _HAS_FCNTL:
            lock_fd = open(lock_path, "w")
            fcntl.flock(lock_fd, fcntl.LOCK_EX)

        try:
            with open(REGISTRY_FILE, encoding="utf-8") as f:
                registry = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            registry = {}

        registry[pid] = {
            "name": pname,
            "root": proot,
            "remote": premote,
            "last_seen": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        }

        tmp_file = REGISTRY_FILE.parent / f".{REGISTRY_FILE.name}.tmp.{os.getpid()}"
        with open(tmp_file, "w", encoding="utf-8") as f:
            json.dump(registry, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_file, REGISTRY_FILE)
    finally:
        if lock_fd is not None:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
            lock_fd.close()


def load_registry() -> dict:
    """Load the projects registry."""
    try:
        with open(REGISTRY_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def load_all_instincts(project: dict, include_global: bool = True) -> list[dict]:
    """Load all instincts: project-scoped + global.

    Project-scoped instincts take precedence over global ones when IDs conflict.
    """
    instincts = []

    # 1. Load project-scoped instincts (if not already global)
    if project["id"] != "global":
        instincts.extend(_load_instincts_from_dir(
            project["instincts_personal"], "personal", "project"
        ))
        instincts.extend(_load_instincts_from_dir(
            project["instincts_inherited"], "inherited", "project"
        ))

    # 2. Load global instincts
    if include_global:
        global_instincts = []
        global_instincts.extend(_load_instincts_from_dir(
            GLOBAL_PERSONAL_DIR, "personal", "global"
        ))
        global_instincts.extend(_load_instincts_from_dir(
            GLOBAL_INHERITED_DIR, "inherited", "global"
        ))

        # Deduplicate: project-scoped wins over global when same ID
        project_ids = {i.get('id') for i in instincts}
        for gi in global_instincts:
            if gi.get('id') not in project_ids:
                instincts.append(gi)

    return instincts


def load_project_only_instincts(project: dict) -> list[dict]:
    """Load only project-scoped instincts (no global).

    In global fallback mode (no git project), returns global instincts.
    """
    if project.get("id") == "global":
        instincts = _load_instincts_from_dir(GLOBAL_PERSONAL_DIR, "personal", "global")
        instincts += _load_instincts_from_dir(GLOBAL_INHERITED_DIR, "inherited", "global")
        return instincts
    return load_all_instincts(project, include_global=False)


# ─────────────────────────────────────────────
# Status Command
# ─────────────────────────────────────────────

def cmd_status(args) -> int:
    """Show status of all instincts (project + global)."""
    project = detect_project()
    instincts = load_all_instincts(project)

    if not instincts:
        print("No instincts found.")
        print(f"\nProject: {project['name']} ({project['id']})")
        print(f"  Project instincts:  {project['instincts_personal']}")
        print(f"  Global instincts:   {GLOBAL_PERSONAL_DIR}")
    else:
        project_instincts = [i for i in instincts if i.get('_scope_label') == 'project']
        global_instincts = [i for i in instincts if i.get('_scope_label') == 'global']

        print(f"\n{'='*60}")
        print(f"  INSTINCT STATUS - {len(instincts)} total")
        print(f"{'='*60}\n")

        print(f"  Project:  {project['name']} ({project['id']})")
        print(f"  Project instincts: {len(project_instincts)}")
        print(f"  Global instincts:  {len(global_instincts)}")
        print()

        if project_instincts:
            print(f"## PROJECT-SCOPED ({project['name']})")
            print()
            _print_instincts_by_domain(project_instincts)

        if global_instincts:
            print("## GLOBAL (apply to all projects)")
            print()
            _print_instincts_by_domain(global_instincts)

        # Observations stats
        obs_file = project.get("observations_file")
        if obs_file and Path(obs_file).exists():
            with open(obs_file, encoding="utf-8") as f:
                obs_count = sum(1 for _ in f)
            print(f"-" * 60)
            print(f"  Observations: {obs_count} events logged")
            print(f"  File: {obs_file}")

    # Pending instinct stats
    pending = _collect_pending_instincts(PROJECTS_DIR, GLOBAL_INSTINCTS_DIR, ALLOWED_INSTINCT_EXTENSIONS)
    if pending:
        print(f"\n{'-'*60}")
        print(f"  Pending instincts: {len(pending)} awaiting review")

        if len(pending) >= 5:
            print(f"\n  ⚠ {len(pending)} pending instincts awaiting review."
                  f" Unreviewed instincts auto-delete after {PENDING_TTL_DAYS} days.")

        expiry_threshold = PENDING_TTL_DAYS - PENDING_EXPIRY_WARNING_DAYS
        expiring_soon = [p for p in pending
                         if p["age_days"] >= expiry_threshold and p["age_days"] < PENDING_TTL_DAYS]
        if expiring_soon:
            print(f"\n  Expiring within {PENDING_EXPIRY_WARNING_DAYS} days:")
            for item in expiring_soon:
                days_left = max(0, PENDING_TTL_DAYS - item["age_days"])
                print(f"    - {item['name']} ({days_left}d remaining)")

    print(f"\n{'='*60}\n")
    return 0


def _print_instincts_by_domain(instincts: list[dict]) -> None:
    """Helper to print instincts grouped by domain."""
    by_domain = defaultdict(list)
    for inst in instincts:
        domain = inst.get('domain', 'general')
        by_domain[domain].append(inst)

    for domain in sorted(by_domain.keys()):
        domain_instincts = by_domain[domain]
        print(f"  ### {domain.upper()} ({len(domain_instincts)})")
        print()

        for inst in sorted(domain_instincts, key=lambda x: -x.get('confidence', 0.5)):
            conf = inst.get('confidence', 0.5)
            conf_bar = '█' * int(conf * 10) + '░' * (10 - int(conf * 10))
            trigger = inst.get('trigger', 'unknown trigger')
            scope_tag = f"[{inst.get('scope', '?')}]"

            print(f"    {conf_bar} {int(conf*100):3d}%  {inst.get('id', 'unnamed')} {scope_tag}")
            print(f"              trigger: {trigger}")

            content = inst.get('content', '')
            action_match = re.search(r'## Action\s*\n\s*(.+?)(?:\n\n|\n##|$)', content, re.DOTALL)
            if action_match:
                action = action_match.group(1).strip().split('\n')[0]
                print(f"              action: {action[:60]}{'...' if len(action) > 60 else ''}")

            print()


# ─────────────────────────────────────────────
# Promote Command
# ─────────────────────────────────────────────

def _find_cross_project_instincts() -> dict:
    """Find instincts that appear in multiple projects (promotion candidates).

    Returns dict mapping instinct ID → list of (project_id, instinct) tuples.
    """
    registry = load_registry()
    cross_project = defaultdict(list)

    for pid, pinfo in registry.items():
        project_dir = PROJECTS_DIR / pid
        personal_dir = project_dir / "instincts" / "personal"
        inherited_dir = project_dir / "instincts" / "inherited"

        # Track instinct IDs already seen for this project to avoid counting
        # the same instinct twice within one project (e.g. in both personal/ and inherited/)
        seen_in_project = set()
        for d, stype in [(personal_dir, "personal"), (inherited_dir, "inherited")]:
            for inst in _load_instincts_from_dir(d, stype, "project"):
                iid = inst.get('id')
                if iid and iid not in seen_in_project:
                    seen_in_project.add(iid)
                    cross_project[iid].append((pid, pinfo.get('name', pid), inst))

    # Filter to only those appearing in 2+ unique projects
    return {iid: entries for iid, entries in cross_project.items() if len(entries) >= 2}


def _show_promotion_candidates(project: dict) -> None:
    """Show instincts that could be promoted from project to global."""
    cross = _find_cross_project_instincts()

    if not cross:
        return

    global_instincts = _load_instincts_from_dir(GLOBAL_PERSONAL_DIR, "personal", "global")
    global_instincts += _load_instincts_from_dir(GLOBAL_INHERITED_DIR, "inherited", "global")
    global_ids = {i.get('id') for i in global_instincts}

    candidates = []
    for iid, entries in cross.items():
        if iid in global_ids:
            continue
        avg_conf = sum(e[2].get('confidence', 0.5) for e in entries) / len(entries)
        if avg_conf >= PROMOTE_CONFIDENCE_THRESHOLD:
            candidates.append({
                'id': iid,
                'projects': [(pid, pname) for pid, pname, _ in entries],
                'avg_confidence': avg_conf,
                'sample': entries[0][2],
            })

    if candidates:
        print(f"\n## PROMOTION CANDIDATES (project -> global)\n")
        print(f"  These instincts appear in {PROMOTE_MIN_PROJECTS}+ projects with high confidence:\n")
        for cand in candidates[:10]:
            proj_names = ', '.join(pname for _, pname in cand['projects'])
            print(f"  * {cand['id']} (avg: {cand['avg_confidence']:.0%})")
            print(f"    Found in: {proj_names}")
            print()
        print(f"  Run `instinct-cli.py promote` to promote these to global scope.\n")


def cmd_promote(args) -> int:
    """Promote project-scoped instincts to global scope."""
    project = detect_project()

    if args.instinct_id:
        # Promote a specific instinct
        return _promote_specific(project, args.instinct_id, args.force, args.dry_run)
    else:
        # Auto-detect promotion candidates
        return _promote_auto(project, args.force, args.dry_run)


def _promote_specific(project: dict, instinct_id: str, force: bool, dry_run: bool = False) -> int:
    """Promote a specific instinct by ID from current project to global."""
    if not _validate_instinct_id(instinct_id):
        print(f"Invalid instinct ID: '{instinct_id}'.", file=sys.stderr)
        return 1

    project_instincts = load_project_only_instincts(project)
    target = next((i for i in project_instincts if i.get('id') == instinct_id), None)

    if not target:
        print(f"Instinct '{instinct_id}' not found in project {project['name']}.")
        return 1

    global_instincts = _load_instincts_from_dir(GLOBAL_PERSONAL_DIR, "personal", "global")
    global_instincts += _load_instincts_from_dir(GLOBAL_INHERITED_DIR, "inherited", "global")
    if any(i.get('id') == instinct_id for i in global_instincts):
        print(f"Instinct '{instinct_id}' already exists in global scope.")
        return 1

    print(f"\nPromoting: {instinct_id}")
    print(f"  From: project '{project['name']}'")
    print(f"  Confidence: {target.get('confidence', 0.5):.0%}")
    print(f"  Domain: {target.get('domain', 'general')}")

    if dry_run:
        print("\n[DRY RUN] No changes made.")
        return 0

    if not force:
        response = input(f"\nPromote to global? [y/N] ")
        if response.lower() != 'y':
            print("Cancelled.")
            return 0

    output_file = GLOBAL_PERSONAL_DIR / f"{instinct_id}.yaml"
    output_content = "---\n"
    output_content += f"id: {target.get('id')}\n"
    output_content += f"trigger: {_yaml_quote(target.get('trigger', 'unknown'))}\n"
    output_content += f"confidence: {target.get('confidence', 0.5)}\n"
    output_content += f"domain: {target.get('domain', 'general')}\n"
    output_content += f"source: {target.get('source', 'promoted')}\n"
    output_content += f"scope: global\n"
    output_content += f"promoted_from: {project['id']}\n"
    output_content += f"promoted_date: {datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')}\n"
    output_content += "---\n\n"
    output_content += target.get('content', '') + "\n"

    output_file.write_text(output_content, encoding="utf-8")
    print(f"\nPromoted '{instinct_id}' to global scope.")
    print(f"  Saved to: {output_file}")
    return 0


def _promote_auto(project: dict, force: bool, dry_run: bool) -> int:
    """Auto-promote instincts found in multiple projects."""
    cross = _find_cross_project_instincts()

    global_instincts = _load_instincts_from_dir(GLOBAL_PERSONAL_DIR, "personal", "global")
    global_instincts += _load_instincts_from_dir(GLOBAL_INHERITED_DIR, "inherited", "global")
    global_ids = {i.get('id') for i in global_instincts}

    candidates = []
    for iid, entries in cross.items():
        if iid in global_ids:
            continue
        avg_conf = sum(e[2].get('confidence', 0.5) for e in entries) / len(entries)
        if avg_conf >= PROMOTE_CONFIDENCE_THRESHOLD and len(entries) >= PROMOTE_MIN_PROJECTS:
            candidates.append({
                'id': iid,
                'entries': entries,
                'avg_confidence': avg_conf,
            })

    if not candidates:
        print("No instincts qualify for auto-promotion.")
        print(f"  Criteria: appears in {PROMOTE_MIN_PROJECTS}+ projects, avg confidence >= {PROMOTE_CONFIDENCE_THRESHOLD:.0%}")
        return 0

    print(f"\n{'='*60}")
    print(f"  AUTO-PROMOTION CANDIDATES - {len(candidates)} found")
    print(f"{'='*60}\n")

    for cand in candidates:
        proj_names = ', '.join(pname for _, pname, _ in cand['entries'])
        print(f"  {cand['id']} (avg: {cand['avg_confidence']:.0%})")
        print(f"    Found in {len(cand['entries'])} projects: {proj_names}")

    if dry_run:
        print(f"\n[DRY RUN] No changes made.")
        return 0

    if not force:
        response = input(f"\nPromote {len(candidates)} instincts to global? [y/N] ")
        if response.lower() != 'y':
            print("Cancelled.")
            return 0

    promoted = 0
    for cand in candidates:
        if not _validate_instinct_id(cand['id']):
            print(f"Skipping invalid instinct ID during promotion: {cand['id']}", file=sys.stderr)
            continue

        # Use the highest-confidence version
        best_entry = max(cand['entries'], key=lambda e: e[2].get('confidence', 0.5))
        inst = best_entry[2]

        output_file = GLOBAL_PERSONAL_DIR / f"{cand['id']}.yaml"
        output_content = "---\n"
        output_content += f"id: {inst.get('id')}\n"
        output_content += f"trigger: {_yaml_quote(inst.get('trigger', 'unknown'))}\n"
        output_content += f"confidence: {cand['avg_confidence']}\n"
        output_content += f"domain: {inst.get('domain', 'general')}\n"
        output_content += f"source: auto-promoted\n"
        output_content += f"scope: global\n"
        output_content += f"promoted_date: {datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')}\n"
        output_content += f"seen_in_projects: {len(cand['entries'])}\n"
        output_content += "---\n\n"
        output_content += inst.get('content', '') + "\n"

        output_file.write_text(output_content, encoding="utf-8")
        promoted += 1

    print(f"\nPromoted {promoted} instincts to global scope.")
    return 0


# ─────────────────────────────────────────────
# Projects Command
# ─────────────────────────────────────────────

def cmd_projects(args) -> int:
    """List all known projects and their instinct counts."""
    registry = load_registry()

    if not registry:
        print("No projects registered yet.")
        print("Projects are auto-detected when you use your AI coding tool in a git repo.")
        return 0

    print(f"\n{'='*60}")
    print(f"  KNOWN PROJECTS - {len(registry)} total")
    print(f"{'='*60}\n")

    for pid, pinfo in sorted(registry.items(), key=lambda x: x[1].get('last_seen', ''), reverse=True):
        project_dir = PROJECTS_DIR / pid
        personal_dir = project_dir / "instincts" / "personal"
        inherited_dir = project_dir / "instincts" / "inherited"

        personal_count = len(_load_instincts_from_dir(personal_dir, "personal", "project"))
        inherited_count = len(_load_instincts_from_dir(inherited_dir, "inherited", "project"))
        obs_file = project_dir / "observations.jsonl"
        if obs_file.exists():
            with open(obs_file, encoding="utf-8") as f:
                obs_count = sum(1 for _ in f)
        else:
            obs_count = 0

        print(f"  {pinfo.get('name', pid)} [{pid}]")
        print(f"    Root: {pinfo.get('root', 'unknown')}")
        if pinfo.get('remote'):
            print(f"    Remote: {pinfo['remote']}")
        print(f"    Instincts: {personal_count} personal, {inherited_count} inherited")
        print(f"    Observations: {obs_count} events")
        print(f"    Last seen: {pinfo.get('last_seen', 'unknown')}")
        print()

    # Global stats
    global_personal = len(_load_instincts_from_dir(GLOBAL_PERSONAL_DIR, "personal", "global"))
    global_inherited = len(_load_instincts_from_dir(GLOBAL_INHERITED_DIR, "inherited", "global"))
    print(f"  GLOBAL")
    print(f"    Instincts: {global_personal} personal, {global_inherited} inherited")

    print(f"\n{'='*60}\n")
    return 0


# ─────────────────────────────────────────────
# ─────────────────────────────────────────────

def main() -> int:
    _ensure_global_dirs()
    parser = argparse.ArgumentParser(description='Instinct CLI for Continuous Learning v2.1 (Project-Scoped)')
    subparsers = parser.add_subparsers(dest='command', help='Available commands')

    # Status
    status_parser = subparsers.add_parser('status', help='Show instinct status (project + global)')

    import_parser = subparsers.add_parser('import', help='Import instincts')
    import_parser.add_argument('source', help='File path or URL')
    import_parser.add_argument('--dry-run', action='store_true', help='Preview without importing')
    import_parser.add_argument('--force', action='store_true', help='Skip confirmation')
    import_parser.add_argument('--min-confidence', type=float, help='Minimum confidence threshold')
    import_parser.add_argument('--scope', choices=['project', 'global'], default='project',
                               help='Import scope (default: project)')

    export_parser = subparsers.add_parser('export', help='Export instincts')
    export_parser.add_argument('--output', '-o', help='Output file')
    export_parser.add_argument('--domain', help='Filter by domain')
    export_parser.add_argument('--min-confidence', type=float, help='Minimum confidence')
    export_parser.add_argument('--scope', choices=['project', 'global', 'all'], default='all',
                               help='Export scope (default: all)')

    # Evolve
    evolve_parser = subparsers.add_parser('evolve', help='Analyze and evolve instincts')
    evolve_parser.add_argument('--generate', action='store_true', help='Generate evolved structures')

    # Promote (new in v2.1)
    promote_parser = subparsers.add_parser('promote', help='Promote project instincts to global scope')
    promote_parser.add_argument('instinct_id', nargs='?', help='Specific instinct ID to promote')
    promote_parser.add_argument('--force', action='store_true', help='Skip confirmation')
    promote_parser.add_argument('--dry-run', action='store_true', help='Preview without promoting')

    # Projects (new in v2.1)
    projects_parser = subparsers.add_parser('projects', help='List known projects and instinct counts')

    # Prune (pending instinct TTL)
    prune_parser = subparsers.add_parser('prune', help='Delete pending instincts older than TTL')
    prune_parser.add_argument('--max-age', type=int, default=PENDING_TTL_DAYS,
                              help=f'Max age in days before pruning (default: {PENDING_TTL_DAYS})')
    prune_parser.add_argument('--dry-run', action='store_true', help='Preview without deleting')
    prune_parser.add_argument('--quiet', action='store_true', help='Suppress output (for automated use)')

    args = parser.parse_args()

    if args.command == 'status':
        return cmd_status(args)
    elif args.command == 'import':
        return cmd_import(args, detect_project, load_project_only_instincts)
    elif args.command == 'export':
        return cmd_export(args, detect_project, load_project_only_instincts, load_all_instincts)
    elif args.command == 'evolve':
        return cmd_evolve(args, detect_project, load_all_instincts, _show_promotion_candidates)
    elif args.command == 'promote':
        return cmd_promote(args)
    elif args.command == 'projects':
        return cmd_projects(args)
    elif args.command == 'prune':
        return cmd_prune(args, PROJECTS_DIR, GLOBAL_INSTINCTS_DIR, ALLOWED_INSTINCT_EXTENSIONS)
    else:
        parser.print_help()
        return 1


if __name__ == '__main__':
    sys.exit(main())
