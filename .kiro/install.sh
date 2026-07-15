#!/bin/bash
#
# EGC Kiro Installer
# Installs EGC (Extended Global Context) workflows into a Kiro project.
#
# Usage:
#   ./install.sh              # Install to current directory
#   ./install.sh /path/to/dir # Install to specific directory
#   ./install.sh ~            # Install globally to ~/.kiro/
#

set -euo pipefail

# When globs match nothing, expand to empty list instead of the literal pattern
shopt -s nullglob

# Resolve the directory where this script lives
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# The script lives inside .kiro/, so SCRIPT_DIR *is* the source.
# If invoked from the repo root (e.g., .kiro/install.sh), SCRIPT_DIR already
# points to the .kiro directory: no need to append /.kiro again.
SOURCE_KIRO="$SCRIPT_DIR"

# Target directory: argument or current working directory
TARGET="${1:-.}"

# Expand ~ to $HOME
if [ "$TARGET" = "~" ] || [[ "$TARGET" == "~/"* ]]; then
  TARGET="${TARGET/#\~/$HOME}"
fi

# Resolve to absolute path
TARGET="$(cd "$TARGET" 2>/dev/null && pwd || echo "$TARGET")"

echo "EGC Kiro Installer"
echo "=================="
echo ""
echo "Source:  $SOURCE_KIRO"
echo "Target:  $TARGET/.kiro/"
echo ""

# Subdirectories to create and populate. Skills are NOT handled here: they
# ship through the unified Tier 1 pipeline (`egc install --target kiro`),
# which stays in sync with the full skill library instead of this script's
# old hand-curated snapshot.
SUBDIRS="agents steering hooks scripts settings"

# Create all required .kiro/ subdirectories
for dir in $SUBDIRS; do
  mkdir -p "$TARGET/.kiro/$dir"
done

# Counters for summary
agents=0; steering=0; hooks=0; scripts=0; settings=0

# Copy agents (JSON for CLI, Markdown for IDE)
if [ -d "$SOURCE_KIRO/agents" ]; then
  for f in "$SOURCE_KIRO/agents"/*.json "$SOURCE_KIRO/agents"/*.md; do
    [ -f "$f" ] || continue
    local_name=$(basename "$f")
    if [ ! -f "$TARGET/.kiro/agents/$local_name" ]; then
      cp "$f" "$TARGET/.kiro/agents/" 2>/dev/null || true
      agents=$((agents + 1))
    fi
  done
fi

if [ -d "$SOURCE_KIRO/steering" ]; then
  for f in "$SOURCE_KIRO/steering"/*.md; do
    local_name=$(basename "$f")
    if [ ! -f "$TARGET/.kiro/steering/$local_name" ]; then
      cp "$f" "$TARGET/.kiro/steering/" 2>/dev/null || true
      steering=$((steering + 1))
    fi
  done
fi

# Copy hooks (.kiro.hook files and README)
if [ -d "$SOURCE_KIRO/hooks" ]; then
  for f in "$SOURCE_KIRO/hooks"/*.kiro.hook "$SOURCE_KIRO/hooks"/*.md; do
    [ -f "$f" ] || continue
    local_name=$(basename "$f")
    if [ ! -f "$TARGET/.kiro/hooks/$local_name" ]; then
      cp "$f" "$TARGET/.kiro/hooks/" 2>/dev/null || true
      hooks=$((hooks + 1))
    fi
  done
fi

if [ -d "$SOURCE_KIRO/scripts" ]; then
  for f in "$SOURCE_KIRO/scripts"/*.sh; do
    local_name=$(basename "$f")
    if [ ! -f "$TARGET/.kiro/scripts/$local_name" ]; then
      cp "$f" "$TARGET/.kiro/scripts/" 2>/dev/null || true
      chmod +x "$TARGET/.kiro/scripts/$local_name" 2>/dev/null || true
      scripts=$((scripts + 1))
    fi
  done
fi

if [ -d "$SOURCE_KIRO/settings" ]; then
  for f in "$SOURCE_KIRO/settings"/*; do
    [ -f "$f" ] || continue
    local_name=$(basename "$f")
    if [ ! -f "$TARGET/.kiro/settings/$local_name" ]; then
      cp "$f" "$TARGET/.kiro/settings/" 2>/dev/null || true
      settings=$((settings + 1))
    fi
  done
fi

# Installation summary
echo "Installation complete!"
echo ""
echo "Components installed:"
echo "  Agents:    $agents"
echo "  Steering:  $steering"
echo "  Hooks:     $hooks"
echo "  Scripts:   $scripts"
echo "  Settings:  $settings"
echo ""
echo "Note: skills are not installed by this script anymore. Run"
echo "  'egc install --target kiro' to install skills from the full,"
echo "  always up-to-date EGC skill library."
echo ""
echo "Next steps:"
echo "  1. Open your project in Kiro"
echo "  2. Agents: Automatic in IDE, /agent swap in CLI"
echo "  3. Skills: run 'egc install --target kiro', then available via / menu in chat"
echo "  4. Steering files with 'auto' inclusion load automatically"
echo "  5. Toggle hooks in the Agent Hooks panel"
echo "  6. Copy desired MCP servers from .kiro/settings/mcp.json.example to .kiro/settings/mcp.json"
