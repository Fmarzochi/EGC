"""Pending-instinct helpers and the prune command for the Instinct CLI.

Every function here takes the directories it scans as explicit parameters
instead of importing instinct_cli_paths' constants directly, so a caller
that holds a monkeypatched copy of PROJECTS_DIR or GLOBAL_INSTINCTS_DIR (the
orchestrator, under test) can pass that live value straight through. See
instinct_cli_paths.py's docstring for why a frozen import would not do that.
"""

import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional


def _collect_pending_dirs(projects_dir: Path, global_instincts_dir: Path) -> list[Path]:
    """Return all pending instinct directories (global + per-project)."""
    dirs = []
    global_pending = global_instincts_dir / "pending"
    if global_pending.is_dir():
        dirs.append(global_pending)
    if projects_dir.is_dir():
        for project_dir in sorted(projects_dir.iterdir()):
            if project_dir.is_dir():
                pending = project_dir / "instincts" / "pending"
                if pending.is_dir():
                    dirs.append(pending)
    return dirs


def _parse_created_date(file_path: Path) -> Optional[datetime]:
    """Parse the 'created' date from YAML frontmatter of an instinct file.

    Falls back to file mtime if no 'created' field is found.
    """
    try:
        content = file_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None

    in_frontmatter = False
    for line in content.split('\n'):
        stripped = line.strip()
        if stripped == '---':
            if in_frontmatter:
                break  # end of frontmatter without finding created
            in_frontmatter = True
            continue
        if in_frontmatter and ':' in line:
            key, value = line.split(':', 1)
            if key.strip() == 'created':
                date_str = value.strip().strip('"').strip("'")
                for fmt in (
                    "%Y-%m-%dT%H:%M:%S%z",
                    "%Y-%m-%dT%H:%M:%SZ",
                    "%Y-%m-%dT%H:%M:%S",
                    "%Y-%m-%d",
                ):
                    try:
                        dt = datetime.strptime(date_str, fmt)
                        if dt.tzinfo is None:
                            dt = dt.replace(tzinfo=timezone.utc)
                        return dt
                    except ValueError:
                        continue

    # Fallback: file modification time
    try:
        mtime = file_path.stat().st_mtime
        return datetime.fromtimestamp(mtime, tz=timezone.utc)
    except OSError:
        return None


def _collect_pending_instincts(projects_dir: Path, global_instincts_dir: Path,
                                allowed_extensions: tuple) -> list[dict]:
    """Scan all pending directories and return info about each pending instinct.

    Each dict contains: path, created, age_days, name, parent_dir.
    """
    now = datetime.now(timezone.utc)
    results = []
    for pending_dir in _collect_pending_dirs(projects_dir, global_instincts_dir):
        files = [
            f for f in sorted(pending_dir.iterdir())
            if f.is_file() and f.suffix.lower() in allowed_extensions
        ]
        for file_path in files:
            created = _parse_created_date(file_path)
            if created is None:
                print(f"Warning: could not parse age for pending instinct: {file_path.name}", file=sys.stderr)
                continue
            age = now - created
            results.append({
                "path": file_path,
                "created": created,
                "age_days": age.days,
                "name": file_path.stem,
                "parent_dir": str(pending_dir),
            })
    return results


def cmd_prune(args, projects_dir: Path, global_instincts_dir: Path, allowed_extensions: tuple) -> int:
    """Delete pending instincts older than the TTL threshold."""
    max_age = args.max_age
    dry_run = args.dry_run
    quiet = args.quiet

    pending = _collect_pending_instincts(projects_dir, global_instincts_dir, allowed_extensions)

    expired = [p for p in pending if p["age_days"] >= max_age]
    remaining = [p for p in pending if p["age_days"] < max_age]

    if dry_run:
        if not quiet:
            if expired:
                print(f"\n[DRY RUN] Would prune {len(expired)} pending instinct(s) older than {max_age} days:\n")
                for item in expired:
                    print(f"  - {item['name']} (age: {item['age_days']}d) — {item['path']}")
            else:
                print(f"No pending instincts older than {max_age} days.")
            print(f"\nSummary: {len(expired)} would be pruned, {len(remaining)} remaining")
        return 0

    pruned = 0
    pruned_items = []
    for item in expired:
        try:
            item["path"].unlink()
            pruned += 1
            pruned_items.append(item)
        except OSError as e:
            if not quiet:
                print(f"Warning: Failed to delete {item['path']}: {e}", file=sys.stderr)

    if not quiet:
        if pruned > 0:
            print(f"\nPruned {pruned} pending instinct(s) older than {max_age} days.")
            for item in pruned_items:
                print(f"  - {item['name']} (age: {item['age_days']}d)")
        else:
            print(f"No pending instincts older than {max_age} days.")
        failed = len(expired) - pruned
        remaining_total = len(remaining) + failed
        print(f"\nSummary: {pruned} pruned, {remaining_total} remaining")

    return 0
