"""Tests for the tool-call argument parser the providers share."""

import pytest

from llm.core.interface import ToolArgumentsError
from llm.core.tool_arguments import parse_tool_arguments
from llm.core.types import ProviderType


class _UncomparableArguments:
    def __eq__(self, other: object) -> bool:
        raise RuntimeError("compared")


@pytest.mark.unit
@pytest.mark.parametrize("raw", [None, "", b"", bytearray()])
def test_missing_arguments_parse_to_an_empty_dict(raw: object) -> None:
    assert parse_tool_arguments(raw) == {}


@pytest.mark.unit
@pytest.mark.parametrize("raw", ['{"path": "a.txt"}', b'{"path": "a.txt"}', bytearray(b'{"path": "a.txt"}'), {"path": "a.txt"}])
def test_a_json_object_parses_to_a_dict(raw: object) -> None:
    assert parse_tool_arguments(raw) == {"path": "a.txt"}


@pytest.mark.unit
@pytest.mark.parametrize("raw", ['{"secret": NaN}', '{"secret": Infinity}', '{"secret": -Infinity}', b'{"secret": "\xff"}', '{"secret": oops'])
def test_invalid_json_raises_without_echoing_the_arguments(raw: object) -> None:
    with pytest.raises(ToolArgumentsError) as exc:
        parse_tool_arguments(raw, ProviderType.OPENAI)
    assert exc.value.provider == ProviderType.OPENAI
    assert "secret" not in str(exc.value)


@pytest.mark.unit
def test_an_unsupported_type_raises_without_being_compared() -> None:
    with pytest.raises(ToolArgumentsError) as exc:
        parse_tool_arguments(_UncomparableArguments(), ProviderType.OLLAMA)
    assert exc.value.provider == ProviderType.OLLAMA
    assert "_UncomparableArguments" in str(exc.value)
