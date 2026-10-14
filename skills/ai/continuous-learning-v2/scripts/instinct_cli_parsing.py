"""Instinct file parsing and path validation for the Instinct CLI.

Pure functions: none of these read a module-level path constant that the
test suite monkeypatches (see instinct_cli_paths.py's docstring), so they
are safe to call from any module without losing patch visibility.
"""

import re
import sys
from pathlib import Path

from instinct_cli_paths import ALLOWED_INSTINCT_EXTENSIONS

# ─────────────────────────────────────────────
# Path Validation
# ─────────────────────────────────────────────


def _validate_file_path(path_str: str, must_exist: bool = False) -> Path:
    """Validate and resolve a file path, guarding against path traversal.

    Raises ValueError if the path is invalid or suspicious.
    """
    path = Path(path_str).expanduser().resolve()

    blocked_prefixes = [
        "/etc", "/usr", "/bin", "/sbin", "/proc", "/sys",
        "/var/log", "/var/run", "/var/lib", "/var/spool",
        "/private/etc",
        "/private/var/log", "/private/var/run", "/private/var/db",
    ]
    path_s = str(path)
    for prefix in blocked_prefixes:
        if path_s.startswith(prefix + "/") or path_s == prefix:
            raise ValueError(f"Path '{path}' targets a system directory")

    if must_exist and not path.exists():
        raise ValueError(f"Path does not exist: {path}")

    return path


def _validate_instinct_id(instinct_id: str) -> bool:
    """Validate instinct IDs before using them in filenames."""
    if not instinct_id or len(instinct_id) > 128:
        return False
    if "/" in instinct_id or "\\" in instinct_id:
        return False
    if ".." in instinct_id:
        return False
    if instinct_id.startswith("."):
        return False
    return bool(re.match(r"^[A-Za-z0-9][A-Za-z0-9._-]*$", instinct_id))


def _yaml_quote(value: str) -> str:
    """Quote a string for safe YAML frontmatter serialization.

    Uses double quotes and escapes embedded double-quote characters to
    prevent malformed YAML when the value contains quotes.
    """
    escaped = value.replace('\\', '\\\\').replace('"', '\\"')
    return f'"{escaped}"'


# ─────────────────────────────────────────────
# Instinct Parser
# ─────────────────────────────────────────────


def parse_instinct_file(content: str) -> list[dict]:
    """Parse YAML-like instinct file format.

    Each instinct is delimited by a pair of ``---`` markers (YAML frontmatter).
    Note: ``---`` is always treated as a frontmatter boundary; instinct body
    content must use ``***`` or ``___`` for horizontal rules to avoid ambiguity.
    """
    instincts = []
    current = {}
    in_frontmatter = False
    content_lines = []

    for line in content.split('\n'):
        if line.strip() == '---':
            if in_frontmatter:
                in_frontmatter = False
            else:
                in_frontmatter = True
                if current:
                    current['content'] = '\n'.join(content_lines).strip()
                    instincts.append(current)
                current = {}
                content_lines = []
        elif in_frontmatter:
            if ':' in line:
                key, value = line.split(':', 1)
                key = key.strip()
                value = value.strip()
                if value.startswith('"') and value.endswith('"'):
                    value = value[1:-1].replace('\\"', '"').replace('\\\\', '\\')
                elif value.startswith("'") and value.endswith("'"):
                    value = value[1:-1].replace("''", "'")
                if key == 'confidence':
                    try:
                        current[key] = float(value)
                    except ValueError:
                        current[key] = 0.5
                else:
                    current[key] = value
        else:
            content_lines.append(line)

    if current:
        current['content'] = '\n'.join(content_lines).strip()
        instincts.append(current)

    return [i for i in instincts if i.get('id')]


def _load_instincts_from_dir(directory: Path, source_type: str, scope_label: str) -> list[dict]:
    """Load instincts from a single directory."""
    instincts = []
    if not directory.exists():
        return instincts
    files = [
        file for file in sorted(directory.iterdir())
        if file.is_file() and file.suffix.lower() in ALLOWED_INSTINCT_EXTENSIONS
    ]
    for file in files:
        try:
            content = file.read_text(encoding="utf-8")
            parsed = parse_instinct_file(content)
            for inst in parsed:
                inst['_source_file'] = str(file)
                inst['_source_type'] = source_type
                inst['_scope_label'] = scope_label
                if 'scope' not in inst:
                    inst['scope'] = scope_label
            instincts.extend(parsed)
        except Exception as e:
            print(f"Warning: Failed to parse {file}: {e}", file=sys.stderr)
    return instincts
