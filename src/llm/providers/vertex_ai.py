"""Vertex AI provider adapter.

Vertex AI is Google's enterprise access path to the same Gemini model
family :class:`GeminiProvider` already talks to via the direct API. The
``google-genai`` SDK supports both modes through the same client class --
``genai.Client(vertexai=True, project=..., location=...)`` instead of
``genai.Client(api_key=...)`` -- so this adapter subclasses
:class:`GeminiProvider` and only swaps client construction and auth source.
Model IDs, generation logic, and the model catalog are shared with
:class:`GeminiProvider`: Vertex AI serves the identical Gemini model family,
just through GCP service-account/ADC auth instead of an API key.
"""

from __future__ import annotations

import os
import re
from typing import Any

try:
    from google import genai
except ImportError:  # pragma: no cover - SDK optional
    genai = None  # type: ignore[assignment]

from llm.core.interface import CLIENT_TIMEOUT, AuthenticationError, LLMError
from llm.core.model_resolver import ModelResolver
from llm.core.types import LLMInput, LLMOutput, ProviderType
from llm.providers.gemini import GeminiProvider

_DEFAULT_LOCATION = "us-central1"
_DOMAIN_LABEL = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
_PROJECT_ID = re.compile(
    rf"^(?:{_DOMAIN_LABEL}(?:\.{_DOMAIN_LABEL})*:)?[a-z][a-z0-9-]{{4,28}}[a-z0-9]$"
)
_LOCATION = re.compile(r"^(?:global|us|eu|[a-z]+-[a-z]+\d+)$")


def _config_issue(project: str | None, location: str | None) -> str | None:
    if not project:
        return "No Google Cloud project configured for Vertex AI (set GOOGLE_CLOUD_PROJECT)"
    if not _PROJECT_ID.match(project):
        return (
            f"Vertex AI project {project!r} is not a Google Cloud project ID "
            "(6 to 30 lowercase letters, digits or hyphens, starting with a letter, "
            "optionally prefixed by a domain as in example.com:my-project)"
        )
    if not location or not _LOCATION.match(location):
        return (
            f"Vertex AI location {location!r} is not a Google Cloud location "
            "such as us-central1 or global (set GOOGLE_CLOUD_LOCATION)"
        )
    return None


class VertexAIProvider(GeminiProvider):
    provider_type = ProviderType.VERTEX_AI

    def __init__(
        self, project: str | None = None, location: str | None = None, **kwargs: Any
    ) -> None:
        if genai is None:  # NOSONAR
            raise ImportError(
                "google-genai package is required to use VertexAIProvider"
            )

        self._project = project or os.environ.get("GOOGLE_CLOUD_PROJECT")
        self._location = (
            location or os.environ.get("GOOGLE_CLOUD_LOCATION") or _DEFAULT_LOCATION
        )
        issue = _config_issue(self._project, self._location)
        if issue:
            raise AuthenticationError(issue, provider=ProviderType.VERTEX_AI)

        self.client = genai.Client(
            vertexai=True,
            project=self._project,
            location=self._location,
            http_options={"timeout": int(CLIENT_TIMEOUT * 1000)},
        )

        # Vertex AI serves the same Gemini model family/catalog: reuse it
        # instead of duplicating registry entries under a second provider key.
        self._default_model = ModelResolver.default_model("gemini")
        self._fallback_chain = ModelResolver.fallback_map(self._default_model)
        # tag_as=VERTEX_AI overrides the registry's own "gemini" provider tag
        # on the borrowed rows, so callers grouping usage/cost by
        # ModelInfo.provider don't attribute Vertex AI traffic to Gemini.
        self._models = ModelResolver.model_infos(
            "gemini", tag_as=ProviderType.VERTEX_AI
        )

    def generate(self, input: LLMInput) -> LLMOutput:  # type: ignore[override]
        try:
            return super().generate(input)
        except LLMError as exc:
            # GeminiProvider.generate() raises with provider=ProviderType.GEMINI
            # baked in at raise time. Re-tag in place so telemetry attributes
            # to VERTEX_AI while preserving the original exception subclass
            # (AuthenticationError, RateLimitError, ContextLengthError, ...).
            exc.provider = ProviderType.VERTEX_AI
            raise

    def validate_config(self) -> bool:
        return _config_issue(self._project, self._location) is None

    def get_default_model(self) -> str:
        return ModelResolver.resolve(None, provider="gemini")


__all__ = ["VertexAIProvider"]
