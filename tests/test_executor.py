"""Tests for llm.tools.executor -- tool registry and tool executor.

Part of the src/llm coverage gap flagged by the squad audit (EGC-440): the
registry and executor turn provider tool calls into results but had no test.
Covers registration/lookup and the execute paths (success, missing tool, and
an exception inside a tool becoming an error result instead of propagating).
"""
from __future__ import annotations

import pytest

from llm.core.types import ToolCall, ToolDefinition
from llm.tools.executor import ToolExecutor, ToolRegistry


def _definition(name: str) -> ToolDefinition:
    return ToolDefinition(name=name, description="d", parameters={})


@pytest.mark.unit
class TestToolRegistry:
    def test_register_and_lookup(self):
        reg = ToolRegistry()
        reg.register(_definition("echo"), lambda **kw: kw)
        assert reg.has("echo") is True
        assert reg.get("echo") is not None
        assert reg.get_definition("echo").name == "echo"
        assert [d.name for d in reg.list_tools()] == ["echo"]

    def test_missing_tool_lookup_returns_none(self):
        reg = ToolRegistry()
        assert reg.has("nope") is False
        assert reg.get("nope") is None
        assert reg.get_definition("nope") is None


@pytest.mark.unit
class TestToolExecutor:
    def test_executes_registered_tool(self):
        reg = ToolRegistry()
        reg.register(_definition("add"), lambda a, b: a + b)
        result = ToolExecutor(reg).execute(ToolCall(id="1", name="add", arguments={"a": 2, "b": 3}))
        assert result.is_error is False
        assert result.content == "5"
        assert result.tool_call_id == "1"

    def test_unknown_tool_is_error(self):
        result = ToolExecutor(ToolRegistry()).execute(ToolCall(id="9", name="ghost", arguments={}))
        assert result.is_error is True
        assert "not found" in result.content

    def test_tool_exception_becomes_error_result(self):
        reg = ToolRegistry()

        def boom(**kw):
            raise ValueError("kaboom")

        reg.register(_definition("boom"), boom)
        result = ToolExecutor(reg).execute(ToolCall(id="7", name="boom", arguments={}))
        assert result.is_error is True
        assert "kaboom" in result.content

    def test_execute_all_runs_each_call(self):
        reg = ToolRegistry()
        reg.register(_definition("up"), lambda s: s.upper())
        results = ToolExecutor(reg).execute_all([
            ToolCall(id="1", name="up", arguments={"s": "a"}),
            ToolCall(id="2", name="up", arguments={"s": "b"}),
        ])
        assert [r.content for r in results] == ["A", "B"]
