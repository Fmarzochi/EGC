"""Import and export of instinct files for the Instinct CLI.

cmd_import and cmd_export take detect_project and the loader they need as
explicit parameters rather than importing them, since those two functions
live in instinct-cli.py and read module globals the test suite monkeypatches
there (see instinct_cli_paths.py's docstring) -- a frozen import here would
silently stop observing a patch applied to instinct-cli.py's copy.
"""

import os
import sys
import urllib.request
from datetime import datetime
from pathlib import Path

from instinct_cli_paths import GLOBAL_INHERITED_DIR, GLOBAL_INSTINCTS_DIR, GLOBAL_PERSONAL_DIR
from instinct_cli_parsing import _load_instincts_from_dir, _validate_file_path, _yaml_quote, parse_instinct_file


def cmd_import(args, detect_project_fn, load_project_only_instincts_fn) -> int:
    """Import instincts from file or URL."""
    project = detect_project_fn()
    source = args.source

    target_scope = args.scope or "project"
    if target_scope == "project" and project["id"] == "global":
        print("No project detected. Importing as global scope.")
        target_scope = "global"

    if source.startswith('http://') or source.startswith('https://'):
        print(f"Fetching from URL: {source}")
        try:
            with urllib.request.urlopen(source) as response:
                content = response.read().decode('utf-8')
        except Exception as e:
            print(f"Error fetching URL: {e}", file=sys.stderr)
            return 1
    else:
        try:
            path = _validate_file_path(source, must_exist=True)
        except ValueError as e:
            print(f"Invalid path: {e}", file=sys.stderr)
            return 1
        if not path.is_file():
            print(f"Error: '{path}' is not a regular file.", file=sys.stderr)
            return 1
        content = path.read_text(encoding="utf-8")

    new_instincts = parse_instinct_file(content)
    if not new_instincts:
        print("No valid instincts found in source.")
        return 1

    print(f"\nFound {len(new_instincts)} instincts to import.")
    print(f"Target scope: {target_scope}")
    if target_scope == "project":
        print(f"Target project: {project['name']} ({project['id']})")
    print()

    # Load existing instincts for dedup, scoped to the target to avoid
    # cross-scope shadowing (project instincts hiding global ones or vice versa)
    if target_scope == "global":
        existing = _load_instincts_from_dir(GLOBAL_PERSONAL_DIR, "personal", "global")
        existing += _load_instincts_from_dir(GLOBAL_INHERITED_DIR, "inherited", "global")
    else:
        existing = load_project_only_instincts_fn(project)
    existing_ids = {i.get('id') for i in existing}

    # Deduplicate within the import source: keep highest confidence per ID
    best_by_id = {}
    for inst in new_instincts:
        inst_id = inst.get('id')
        if inst_id not in best_by_id or inst.get('confidence', 0.5) > best_by_id[inst_id].get('confidence', 0.5):
            best_by_id[inst_id] = inst
    deduped_instincts = list(best_by_id.values())

    # Categorize against existing instincts on disk
    to_add = []
    duplicates = []
    to_update = []

    for inst in deduped_instincts:
        inst_id = inst.get('id')
        if inst_id in existing_ids:
            existing_inst = next((e for e in existing if e.get('id') == inst_id), None)
            if existing_inst:
                if inst.get('confidence', 0) > existing_inst.get('confidence', 0):
                    to_update.append(inst)
                else:
                    duplicates.append(inst)
        else:
            to_add.append(inst)

    min_conf = args.min_confidence if args.min_confidence is not None else 0.0
    to_add = [i for i in to_add if i.get('confidence', 0.5) >= min_conf]
    to_update = [i for i in to_update if i.get('confidence', 0.5) >= min_conf]

    # Display summary
    if to_add:
        print(f"NEW ({len(to_add)}):")
        for inst in to_add:
            print(f"  + {inst.get('id')} (confidence: {inst.get('confidence', 0.5):.2f})")

    if to_update:
        print(f"\nUPDATE ({len(to_update)}):")
        for inst in to_update:
            print(f"  ~ {inst.get('id')} (confidence: {inst.get('confidence', 0.5):.2f})")

    if duplicates:
        print(f"\nSKIP ({len(duplicates)} - already exists with equal/higher confidence):")
        for inst in duplicates[:5]:
            print(f"  - {inst.get('id')}")
        if len(duplicates) > 5:
            print(f"  ... and {len(duplicates) - 5} more")

    if args.dry_run:
        print("\n[DRY RUN] No changes made.")
        return 0

    if not to_add and not to_update:
        print("\nNothing to import.")
        return 0

    # Confirm
    if not args.force:
        response = input(f"\nImport {len(to_add)} new, update {len(to_update)}? [y/N] ")
        if response.lower() != 'y':
            print("Cancelled.")
            return 0

    if target_scope == "global":
        output_dir = GLOBAL_INHERITED_DIR
    else:
        output_dir = project["instincts_inherited"]

    output_dir.mkdir(parents=True, exist_ok=True)

    # Collect stale files for instincts being updated (deleted after new file is written).
    # Allow deletion from any subdirectory (personal/ or inherited/) within the
    # target scope to prevent the same ID existing in both places. Guard against
    # cross-scope deletion by restricting to the scope's instincts root.
    if target_scope == "global":
        scope_root = GLOBAL_INSTINCTS_DIR.resolve()
    else:
        scope_root = (project["project_dir"] / "instincts").resolve() if project["id"] != "global" else GLOBAL_INSTINCTS_DIR.resolve()
    stale_paths = []
    for inst in to_update:
        inst_id = inst.get('id')
        stale = next((e for e in existing if e.get('id') == inst_id), None)
        if stale and stale.get('_source_file'):
            stale_path = Path(stale['_source_file']).resolve()
            if stale_path.exists() and str(stale_path).startswith(str(scope_root) + os.sep):
                stale_paths.append(stale_path)

    # Write new file first (safe: if this fails, stale files are preserved)
    timestamp = datetime.now().strftime('%Y%m%d-%H%M%S')
    source_name = Path(source).stem if not source.startswith('http') else 'web-import'
    output_file = output_dir / f"{source_name}-{timestamp}.yaml"

    all_to_write = to_add + to_update
    output_content = f"# Imported from {source}\n# Date: {datetime.now().isoformat()}\n# Scope: {target_scope}\n"
    if target_scope == "project":
        output_content += f"# Project: {project['name']} ({project['id']})\n"
    output_content += "\n"

    for inst in all_to_write:
        output_content += "---\n"
        output_content += f"id: {inst.get('id')}\n"
        output_content += f"trigger: {_yaml_quote(inst.get('trigger', 'unknown'))}\n"
        output_content += f"confidence: {inst.get('confidence', 0.5)}\n"
        output_content += f"domain: {inst.get('domain', 'general')}\n"
        output_content += "source: inherited\n"
        output_content += f"scope: {target_scope}\n"
        output_content += f"imported_from: {_yaml_quote(source)}\n"
        if target_scope == "project":
            output_content += f"project_id: {project['id']}\n"
            output_content += f"project_name: {project['name']}\n"
        if inst.get('source_repo'):
            output_content += f"source_repo: {inst.get('source_repo')}\n"
        output_content += "---\n\n"
        output_content += inst.get('content', '') + "\n\n"

    output_file.write_text(output_content, encoding="utf-8")

    # Remove stale files only after the new file has been written successfully
    for stale_path in stale_paths:
        try:
            stale_path.unlink()
        except OSError:
            pass  # best-effort removal

    print(f"\nImport complete!")
    print(f"   Scope: {target_scope}")
    print(f"   Added: {len(to_add)}")
    print(f"   Updated: {len(to_update)}")
    print(f"   Saved to: {output_file}")

    return 0


def cmd_export(args, detect_project_fn, load_project_only_instincts_fn, load_all_instincts_fn) -> int:
    """Export instincts to file."""
    project = detect_project_fn()

    if args.scope == "project":
        instincts = load_project_only_instincts_fn(project)
    elif args.scope == "global":
        instincts = _load_instincts_from_dir(GLOBAL_PERSONAL_DIR, "personal", "global")
        instincts += _load_instincts_from_dir(GLOBAL_INHERITED_DIR, "inherited", "global")
    else:
        instincts = load_all_instincts_fn(project)

    if not instincts:
        print("No instincts to export.")
        return 1

    if args.domain:
        instincts = [i for i in instincts if i.get('domain') == args.domain]

    if args.min_confidence:
        instincts = [i for i in instincts if i.get('confidence', 0.5) >= args.min_confidence]

    if not instincts:
        print("No instincts match the criteria.")
        return 1

    output = f"# Instincts export\n# Date: {datetime.now().isoformat()}\n# Total: {len(instincts)}\n"
    if args.scope:
        output += f"# Scope: {args.scope}\n"
    if project["id"] != "global":
        output += f"# Project: {project['name']} ({project['id']})\n"
    output += "\n"

    for inst in instincts:
        output += "---\n"
        for key in ['id', 'trigger', 'confidence', 'domain', 'source', 'scope',
                     'project_id', 'project_name', 'source_repo']:
            if inst.get(key):
                value = inst[key]
                if key == 'trigger':
                    output += f'{key}: {_yaml_quote(value)}\n'
                else:
                    output += f"{key}: {value}\n"
        output += "---\n\n"
        output += inst.get('content', '') + "\n\n"

    if args.output:
        try:
            out_path = _validate_file_path(args.output)
        except ValueError as e:
            print(f"Invalid output path: {e}", file=sys.stderr)
            return 1
        if out_path.is_dir():
            print(f"Error: '{out_path}' is a directory, not a file.", file=sys.stderr)
            return 1
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(output, encoding="utf-8")
        print(f"Exported {len(instincts)} instincts to {out_path}")
    else:
        print(output)

    return 0
