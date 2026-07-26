"""Tests for llm.dispatcher -- hook command execution and event matching.

Fills the src/llm coverage gap flagged by the squad audit (EGC-440): the
dispatcher runs configured hook commands through a shell and sanitizes the
session id before exporting it to the hook environment, yet had no test. The
command comes from trusted hooks config (not user input), so shell=True is by
design; these tests lock in the session-id sanitization and result handling.
"""
from __future__ import annotations

import pytest

from llm.core.types import ToolCall
from llm.dispatcher import Dispatcher
from llm.session_recorder import SessionRecorder


@pytest.fixture
def dispatcher(tmp_path):
    recorder = SessionRecorder("test-session", base_dir=str(tmp_path))
    disp = Dispatcher(recorder)
    disp.project_root = str(tmp_path)
    return disp


@pytest.mark.unit
class TestExecuteHookCommand:
    def test_empty_or_missing_command_is_noop(self, dispatcher):
        assert dispatcher._execute_hook_command("", {}, None).success is True
        assert dispatcher._execute_hook_command(None, {}, None).success is True

    def test_command_receives_json_payload_on_stdin(self, dispatcher):
        # `cat` echoes the JSON payload straight back; the dispatcher parses it.
        result = dispatcher._execute_hook_command("cat", {"foo": "bar"}, "s1")
        assert result.success is True
        assert result.data == {"foo": "bar"}

    def test_nonzero_exit_is_failure(self, dispatcher):
        result = dispatcher._execute_hook_command("exit 3", {}, None)
        assert result.success is False
        assert "3" in (result.error or "")

    def test_non_json_stdout_still_succeeds_without_data(self, dispatcher):
        result = dispatcher._execute_hook_command("echo not-json", {}, None)
        assert result.success is True
        assert result.data is None

    def test_session_id_shell_metacharacters_are_sanitized(self, dispatcher):
        # A session id carrying shell metacharacters must be scrubbed to
        # [A-Za-z0-9._-] before it reaches the hook environment, so it can
        # never break out of the exported SESSION_ID value.
        malicious = "s1; rm -rf / `whoami` $(id)"
        command = r'''printf '{"sid":"%s"}' "$SESSION_ID"'''
        result = dispatcher._execute_hook_command(command, {}, malicious)
        assert result.success is True
        sid = (result.data or {}).get("sid", "")
        for ch in [";", "/", " ", "`", "$", "(", ")"]:
            assert ch not in sid
        assert sid.startswith("s1")


@pytest.mark.unit
class TestMatch:
    def test_wildcard_matches_any_tool(self, dispatcher):
        assert dispatcher._match("*", "Bash") is True
        assert dispatcher._match("*", "AnythingElse") is True

    def test_pipe_list_matches_only_listed_tools(self, dispatcher):
        assert dispatcher._match("Bash|Write", "Bash") is True
        assert dispatcher._match("Bash|Write", "Write") is True
        assert dispatcher._match("Bash|Write", "Read") is False


@pytest.mark.unit
class TestDispatch:
    def test_dispatch_with_no_hooks_returns_tool_call_unchanged(self, dispatcher):
        dispatcher.hooks_config = {"hooks": {}}
        tc = ToolCall(id="1", name="Bash", arguments={"command": "ls"})
        result = dispatcher.dispatch("PreToolUse", tool_call=tc)
        assert result.vetoed is False
        assert result.tool_call is tc
