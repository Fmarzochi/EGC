"""Claude provider adapter."""

from __future__ import annotations

import os
from typing import Any

try:
    from anthropic import Anthropic

    _ANTHROPIC_AVAILABLE = True
except ImportError:
    _ANTHROPIC_AVAILABLE = False

from llm.core.interface import (
    CLIENT_TIMEOUT,
    AuthenticationError,
    ContextLengthError,
    LLMProvider,
    RateLimitError,
)
from llm.core.types import (
    LLMInput,
    LLMOutput,
    Message,
    ModelInfo,
    ProviderType,
    Role,
    ToolCall,
)
from llm.core.model_resolver import ModelResolver
from llm.core.redact import redact_secrets


class ClaudeProvider(LLMProvider):
    provider_type = ProviderType.CLAUDE

    def __init__(self, api_key: str | None = None, base_url: str | None = None) -> None:
        if not _ANTHROPIC_AVAILABLE:
            raise ImportError(
                "anthropic package is required to use ClaudeProvider. "
                "Install with: pip install everything-gemini[claude]"
            )
        from anthropic import Anthropic

        self.client = Anthropic(
            api_key=api_key or os.environ.get("ANTHROPIC_API_KEY"),
            base_url=base_url,
            timeout=CLIENT_TIMEOUT,
        )
        self._models = [
            ModelInfo(
                name="claude-opus-4-5",
                provider=ProviderType.CLAUDE,
                supports_tools=True,
                supports_vision=True,
                max_tokens=8192,
                context_window=200000,
            ),
            ModelInfo(
                name="claude-sonnet-4-7",
                provider=ProviderType.CLAUDE,
                supports_tools=True,
                supports_vision=True,
                max_tokens=8192,
                context_window=200000,
            ),
            ModelInfo(
                name="claude-haiku-4-7",
                provider=ProviderType.CLAUDE,
                supports_tools=True,
                supports_vision=False,
                max_tokens=4096,
                context_window=200000,
            ),
        ]

    @staticmethod
    def _extract_tool_calls(blocks) -> list[ToolCall] | None:
        calls = []
        for block in blocks:
            if getattr(block, "type", None) != "tool_use":
                continue
            tool_input = getattr(block, "input", {})
            calls.append(
                ToolCall(
                    id=getattr(block, "id", ""),
                    name=getattr(block, "name", ""),
                    arguments=dict(tool_input) if isinstance(tool_input, dict) else {},
                )
            )
        return calls or None

    @staticmethod
    def _tool_result_block(msg: Message) -> dict[str, Any]:
        if not msg.tool_call_id:
            raise ValueError("a tool message needs tool_call_id to answer a tool_use block")
        return {"type": "tool_result", "tool_use_id": msg.tool_call_id, "content": msg.content}

    @staticmethod
    def _add_tool_result(turns: list[dict[str, Any]], block: dict[str, Any]) -> None:
        # Every result of one assistant turn travels in the same user turn, so
        # the block joins the user turn the builder just opened when there is one.
        previous = turns[-1] if turns else None
        if previous and previous["role"] == "user" and isinstance(previous["content"], list):
            previous["content"].append(block)
        else:
            turns.append({"role": "user", "content": [block]})

    @staticmethod
    def _assistant_turn(msg: Message) -> dict[str, Any]:
        blocks: list[dict[str, Any]] = [{"type": "text", "text": msg.content}] if msg.content else []
        blocks.extend(
            {"type": "tool_use", "id": tc.id, "name": tc.name, "input": tc.arguments}
            for tc in msg.tool_calls or []
        )
        return {"role": "assistant", "content": blocks}

    @classmethod
    def _build_request(cls, messages: list[Message]) -> tuple[str | None, list[dict[str, Any]]]:
        # The Messages API takes the system prompt as a top-level parameter and
        # has no tool role: an assistant turn carries its calls as tool_use
        # blocks and the results travel as tool_result blocks in the next user
        # turn.
        system_parts: list[str] = []
        turns: list[dict[str, Any]] = []
        for msg in messages:
            if msg.role == Role.SYSTEM:
                system_parts.append(msg.content)
            elif msg.role == Role.TOOL:
                cls._add_tool_result(turns, cls._tool_result_block(msg))
            elif msg.role == Role.ASSISTANT and msg.tool_calls:
                turns.append(cls._assistant_turn(msg))
            else:
                turns.append({"role": msg.role.value, "content": msg.content})
        return ("\n\n".join(system_parts) or None, turns)

    @staticmethod
    def _map_error(e: Exception) -> None:
        msg = redact_secrets(str(e))
        if "401" in msg or "authentication" in msg.lower():
            raise AuthenticationError(msg, provider=ProviderType.CLAUDE) from e
        if "429" in msg or "rate_limit" in msg.lower():
            raise RateLimitError(msg, provider=ProviderType.CLAUDE) from e
        if "context" in msg.lower() and "length" in msg.lower():
            raise ContextLengthError(msg, provider=ProviderType.CLAUDE) from e
        raise e

    def generate(self, input: LLMInput) -> LLMOutput:
        if input.stream:
            # Streaming is not implemented in this adapter. Fail loudly instead
            # of silently downgrading to a blocking call, which would mislead
            # callers into thinking they are consuming a stream.
            raise NotImplementedError("streaming not supported")
        try:
            system, turns = self._build_request(input.messages)
            params: dict[str, Any] = {
                "model": input.model or self.get_default_model(),
                "messages": turns,
                "temperature": input.temperature,
                "max_tokens": input.max_tokens if input.max_tokens else 8192,
            }
            if system:
                params["system"] = system
            if input.tools:
                params["tools"] = [
                    {
                        "name": t.name,
                        "description": t.description,
                        "input_schema": t.parameters,
                    }
                    for t in input.tools
                ]
            response = self.client.messages.create(**params)
            content = "".join(
                block.text or ""
                for block in response.content
                if getattr(block, "type", None) == "text"
            )
            return LLMOutput(
                content=content,
                tool_calls=self._extract_tool_calls(response.content),
                model=response.model,
                usage={
                    "input_tokens": response.usage.input_tokens,
                    "output_tokens": response.usage.output_tokens,
                },
                stop_reason=response.stop_reason,
            )
        except Exception as e:
            self._map_error(e)

    def list_models(self) -> list[ModelInfo]:
        return self._models.copy()

    def validate_config(self) -> bool:
        return bool(self.client.api_key)

    def get_default_model(self) -> str:
        # Resolved via the centralized registry (honors LLM_MODEL when it
        # targets the Claude provider); no model ID hardcoded here.
        return ModelResolver.resolve(None, provider="claude")
