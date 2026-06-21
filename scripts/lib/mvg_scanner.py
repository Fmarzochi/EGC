#!/usr/bin/env python3
import re
import sys
from pathlib import Path

# --- Configuration ---
FORBIDDEN_PATTERNS = [
    (r'rm\s+-rf', "Destructive recursive deletion"),
    (r'sudo\s', "Privilege escalation attempt"),
    (r'chmod\s+777', "Insecure permission setting"),
    (r'curl\s+.*\s+\|\s+bash', "Unvetted remote script execution"),
    (r'wget\s+.*\s+\|\s+bash', "Unvetted remote script execution"),
    (r'>\s+/etc/', "System configuration tampering"),
    (r'\.\./\.\./\.\./', "Path traversal attempt"),
    (r'os\.system\(', "Direct shell execution from Python"),
    (r'subprocess\.call\(', "Direct subprocess execution from Python"),
    (r'eval\(', "Arbitrary code evaluation"),
    (r'exec\(', "Arbitrary code execution"),
    (r'EGC_GATEGUARD=off', "Attempt to disable governance"),
    (r'ECC_GATEGUARD=off', "Attempt to disable governance (legacy)"),
]

def scan_content(content):
    """Scan string content for forbidden patterns."""
    findings = []
    for pattern, description in FORBIDDEN_PATTERNS:
        if re.search(pattern, content, re.IGNORECASE):
            findings.append(f"{description} (Pattern: {pattern})")
    
    if findings:
        return False, findings
    return True, []

def scan_file(file_path):
    """Scan a file for risk patterns."""
    path = Path(file_path)
    if not path.exists():
        return False, ["File not found"]
    
    try:
        content = path.read_text(encoding='utf-8', errors='ignore')  # NOSONAR
        return scan_content(content)
    except Exception as e:
        return False, [f"Error reading file: {str(e)}"]

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: mvg_scanner.py <file_path>")
        sys.exit(1)
        
    success, issues = scan_file(sys.argv[1])
    if not success:
        print("RISK DETECTED:")
        for issue in issues:
            print(f"  - {issue}")
        sys.exit(1)
    else:
        print("Clean: No obvious risks detected.")
        sys.exit(0)
