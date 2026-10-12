"""Tests for llm.core.model_resolver: model aliases, provider detection and fallbacks.

ModelResolver was only exercised through the provider tests (#1691). These
cover it directly: alias resolution, pass-through of real model IDs, provider
detection, per-provider defaults and environment overrides, fallback chains,
metadata for unknown IDs, EGC_EXTRA_MODELS, and the strategy description the
dashboard shows.
"""
from __future__ import annotations

import pytest

from llm.core.model_resolver import ModelCapability, ModelResolver
from llm.core.types import ModelInfo, ProviderType

_ENV = (
    "LLM_MODEL",
    "EGC_MODEL",
    "ECC_MODEL",
    "LLM_PROVIDER",
    "EGC_EXTRA_MODELS",
    "ECC_EXTRA_MODELS",
)


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    """Every case starts without the variables the resolver reads."""
    for name in _ENV:
        monkeypatch.delenv(name, raising=False)


@pytest.mark.unit
class TestResolve:
    @pytest.mark.parametrize(
        ("alias", "expected"),
        [
            ("reasoning", "gemini-3.1-pro-preview"),
            ("fast", "gemini-3.8-flash"),
            ("cheap", "gemini-3.5-flash-lite"),
            ("flash-legacy", "gemini-3.6-flash"),
            ("ultra", "gemini-3.1-pro-preview"),
            ("opus", "gemini-3.1-pro-preview"),
            ("sonnet", "gemini-3.8-flash"),
            ("haiku", "gemini-3.5-flash-lite"),
            ("claude", "claude-sonnet-5-5"),
            ("openai", "gpt-6.1-sol"),
            ("ollama", "llama3.2"),
            ("openrouter", "openrouter/auto"),
            ("mistral", "mistral-medium-latest"),
            ("groq", "openai/gpt-oss-120b"),
            ("cohere", "command-a-plus-05-2026"),
        ],
    )
    def test_aliases_map_to_real_ids(self, alias, expected):
        assert ModelResolver.resolve(alias) == expected

    def test_aliases_ignore_case_and_surrounding_spaces(self):
        assert ModelResolver.resolve("  SONNET ") == "gemini-3.8-flash"

    def test_registered_ids_are_normalized_to_lowercase(self):
        assert ModelResolver.resolve("GEMINI-2.5-FLASH") == "gemini-2.5-flash"

    @pytest.mark.parametrize(
        "model_id",
        [
            "gemini-9.9-test",
            "gemma-4-27b",
            "claude-opus-9",
            "gpt-5",
            "o3-mini",
            "deepseek-v4",
            "command-r-plus-99-2099",
            "codestral-2601",
            "Vendor/New-Model",
            "projects/p/locations/us/publishers/google/models/gemini-9.9-test",
        ],
    )
    def test_real_looking_ids_pass_through_unchanged(self, model_id):
        assert ModelResolver.resolve(model_id) == model_id

    def test_unknown_symbolic_hint_falls_back_to_the_provider_default(self):
        assert ModelResolver.resolve("turbo-max", "claude") == "claude-sonnet-5-5"
        assert ModelResolver.resolve("turbo-max") == "gemini-3.8-flash"

    @pytest.mark.parametrize("hint", [None, ""])
    def test_no_hint_resolves_to_the_default(self, hint):
        assert ModelResolver.resolve(hint) == "gemini-3.8-flash"
        assert ModelResolver.resolve(hint, "openai") == "gpt-6.1-sol"


@pytest.mark.unit
class TestDefaultModel:
    @pytest.mark.parametrize(
        ("provider", "expected"),
        [
            ("gemini", "gemini-3.8-flash"),
            ("claude", "claude-sonnet-5-5"),
            ("openai", "gpt-6.1-sol"),
            ("ollama", "llama3.2"),
            ("openrouter", "openrouter/auto"),
            ("mistral", "mistral-medium-latest"),
            ("deepseek", "deepseek-flash"),
            ("groq", "openai/gpt-oss-120b"),
            ("cohere", "command-a-plus-05-2026"),
            ("CLAUDE", "claude-sonnet-5-5"),
        ],
    )
    def test_each_provider_has_a_default(self, provider, expected):
        assert ModelResolver.default_model(provider) == expected

    def test_unknown_provider_gets_the_global_default(self):
        assert ModelResolver.default_model("no-such-provider") == "gemini-3.8-flash"

    def test_llm_provider_picks_the_provider_when_none_is_given(self, monkeypatch):
        monkeypatch.setenv("LLM_PROVIDER", "openai")
        assert ModelResolver.default_model() == "gpt-6.1-sol"

    def test_env_model_is_used_for_its_own_provider(self, monkeypatch):
        monkeypatch.setenv("LLM_MODEL", "claude-opus-9")
        assert ModelResolver.default_model("claude") == "claude-opus-9"

    def test_env_model_of_another_provider_is_ignored(self, monkeypatch):
        monkeypatch.setenv("LLM_MODEL", "claude-opus-9")
        assert ModelResolver.default_model("gemini") == "gemini-3.8-flash"

    def test_env_model_alias_is_resolved(self, monkeypatch):
        monkeypatch.setenv("EGC_MODEL", "sonnet")
        assert ModelResolver.default_model("gemini") == "gemini-3.8-flash"

    def test_env_model_precedence_and_legacy_name(self, monkeypatch):
        # Both ids are shut down: the alias points at the replacement the vendor names.
        monkeypatch.setenv("ECC_MODEL", "gemini-2.0-flash")
        assert ModelResolver.default_model("gemini") == "gemini-3.6-flash"
        monkeypatch.setenv("EGC_MODEL", "gemini-1.5-pro")
        assert ModelResolver.default_model("gemini") == "gemini-3.8-flash"
        monkeypatch.setenv("LLM_MODEL", "gemini-2.5-flash-lite")
        assert ModelResolver.default_model("gemini") == "gemini-2.5-flash-lite"

    def test_resolve_without_hint_honors_the_env_model(self, monkeypatch):
        monkeypatch.setenv("LLM_MODEL", "gpt-5")
        assert ModelResolver.resolve(None, "openai") == "gpt-5"

    def test_env_model_of_an_unregistered_groq_vendor_model_is_honored(self, monkeypatch):
        # Groq and OpenRouter both host "vendor/model" IDs; a Groq model not
        # yet in the registry must not be mistaken for an OpenRouter one and
        # silently dropped in favor of the provider default.
        monkeypatch.setenv("LLM_MODEL", "openai/gpt-oss-20b")
        assert ModelResolver.default_model("groq") == "openai/gpt-oss-20b"

    def test_env_model_of_another_provider_is_still_ignored_for_groq(self, monkeypatch):
        monkeypatch.setenv("LLM_MODEL", "claude-opus-9")
        assert ModelResolver.default_model("groq") == "openai/gpt-oss-120b"

    def test_env_model_of_an_unregistered_groq_native_id_is_honored(self, monkeypatch):
        # Not every Groq model id has a "/"; a plain native id (no other
        # provider's shape rule matches it either) must not default to
        # gemini just because it fell through every specific shape check.
        monkeypatch.setenv("LLM_MODEL", "llama-3.3-70b-versatile")
        assert ModelResolver.default_model("groq") == "llama-3.3-70b-versatile"


@pytest.mark.unit
class TestProviderDetection:
    @pytest.mark.parametrize(
        ("model_id", "provider"),
        [
            ("vendor/new-model", "openrouter"),
            ("claude-opus-9", "claude"),
            ("gpt-5", "openai"),
            ("o1-preview", "openai"),
            ("o4-mini", "openai"),
            ("mistral-small-9", "mistral"),
            ("ministral-8b", "mistral"),
            ("codestral-2601", "mistral"),
            ("gemma-4-27b", "gemini"),
            ("gemini-9.9-test", "gemini"),
            ("deepseek-v4", "deepseek"),
            ("command-r-plus", "cohere"),
            ("projects/p/locations/us/publishers/google/models/gemini-9.9-test", "gemini"),
            ("something-else", "gemini"),
        ],
    )
    def test_unknown_ids_are_routed_by_shape(self, model_id, provider):
        assert ModelResolver.get_model_info(model_id)["provider"] == provider

    def test_the_registry_wins_over_the_slash_rule(self):
        # openai/gpt-oss-120b is a Groq model despite its vendor/model shape.
        assert ModelResolver.get_model_info("openai/gpt-oss-120b")["provider"] == "groq"


@pytest.mark.unit
class TestFallbacks:
    def test_chain_follows_the_registry_without_repeating(self):
        chain = ModelResolver.fallback_chain("gemini-2.5-pro")
        assert chain == [
            "gemini-3.8-flash",
            "gemini-3.6-flash",
            "gemini-3.5-flash-lite",
            "gemini-3.1-flash-lite",
        ]
        assert "gemini-2.5-pro" not in chain

    def test_chain_of_unknown_or_terminal_model_is_empty(self):
        assert ModelResolver.fallback_chain("no-such-model") == []
        assert ModelResolver.fallback_chain("gemini-1.5-flash-8b") == []

    def test_chain_stops_on_a_cycle(self, monkeypatch):
        monkeypatch.setattr(ModelResolver, "_REGISTRY", {
            "a": {"provider": "gemini", "fallback": "b"},
            "b": {"provider": "gemini", "fallback": "a"},
        })
        assert ModelResolver.fallback_chain("a") == ["b"]

    def test_get_fallback_single_step(self):
        assert ModelResolver.get_fallback("claude-opus-4-5") == "claude-sonnet-5-5"
        assert ModelResolver.get_fallback("claude-haiku-5-5") is None
        assert ModelResolver.get_fallback("no-such-model") is None

    def test_get_fallback_ignores_targets_outside_the_registry(self, monkeypatch):
        monkeypatch.setattr(ModelResolver, "_REGISTRY", {"a": {"provider": "gemini", "fallback": "ghost"}})
        assert ModelResolver.get_fallback("a") is None

    def test_fallback_map_points_only_at_registered_models(self):
        mapping = ModelResolver.fallback_map()
        assert mapping["gemini-2.5-pro"] == "gemini-3.8-flash"
        assert all(target in ModelResolver._REGISTRY for target in mapping.values())
        assert "gemini-1.5-flash-8b" not in mapping

    def test_fallback_map_seeds_unknown_gemini_extras_only(self):
        mapping = ModelResolver.fallback_map("gemini-9.9-test", "vendor/new-model", "", "gemini-2.5-pro")
        assert mapping["gemini-9.9-test"] == "gemini-3.8-flash"
        assert "vendor/new-model" not in mapping
        assert "" not in mapping
        assert mapping["gemini-2.5-pro"] == "gemini-3.8-flash"


@pytest.mark.unit
class TestMetadata:
    def test_registry_info_is_a_copy(self):
        info = ModelResolver.get_model_info("gemini-2.5-pro")
        info["context_window"] = 1
        assert ModelResolver.get_model_info("gemini-2.5-pro")["context_window"] == 2000000

    def test_unknown_ids_get_conservative_defaults(self):
        info = ModelResolver.get_model_info("claude-opus-9")
        assert info["unknown"] is True
        assert info["capabilities"] == [ModelCapability.TOOL_CALLING]
        assert info["fallback"] == "claude-sonnet-5-5"
        assert info["supports_vision"] is False
        assert info["context_window"] == 32768

    def test_unknown_gemini_ids_fall_back_to_flash(self):
        assert ModelResolver.get_model_info("gemini-9.9-test")["fallback"] == "gemini-3.8-flash"

    def test_capabilities_and_supports(self):
        assert ModelResolver.supports("gemini-2.5-pro", ModelCapability.REASONING)
        assert not ModelResolver.supports("gemini-2.5-pro", ModelCapability.LOW_LATENCY)
        assert ModelResolver.capabilities("vendor/new-model") == [ModelCapability.TOOL_CALLING]

    def test_pick_by_capability_takes_the_first_registered_match(self):
        assert ModelResolver.pick_by_capability(ModelCapability.REASONING) == "gemini-3.8-flash"
        assert ModelResolver.pick_by_capability(ModelCapability.LOW_LATENCY, "claude") == "claude-haiku-5-5"

    def test_pick_by_capability_without_a_match_uses_the_provider_default(self):
        assert ModelResolver.pick_by_capability(ModelCapability.MULTIMODAL, "ollama") == "llama3.2"


@pytest.mark.unit
class TestListing:
    def test_list_models_filters_by_provider_case_insensitively(self):
        models = ModelResolver.list_models("CLAUDE")
        assert models == ["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-4-5"]
        assert set(ModelResolver.list_models()) == set(ModelResolver._REGISTRY)

    def test_extra_models_are_appended_once_and_filtered(self, monkeypatch):
        monkeypatch.setenv("EGC_EXTRA_MODELS", " gemini-9.9-test, ,claude-opus-9,gemini-2.5-pro ")
        gemini = ModelResolver.list_models("gemini")
        assert gemini.count("gemini-9.9-test") == 1
        assert gemini.count("gemini-2.5-pro") == 1
        assert "claude-opus-9" not in gemini
        assert "claude-opus-9" in ModelResolver.list_models()

    def test_legacy_extra_models_variable_is_honored(self, monkeypatch):
        monkeypatch.setenv("ECC_EXTRA_MODELS", "gemini-9.9-test")
        assert "gemini-9.9-test" in ModelResolver.list_models("gemini")
        monkeypatch.setenv("EGC_EXTRA_MODELS", "gemini-8.8-test")
        assert "gemini-8.8-test" in ModelResolver.list_models("gemini")
        assert "gemini-9.9-test" not in ModelResolver.list_models("gemini")

    def test_list_available_models_starts_with_the_tiers_without_duplicates(self):
        names = ModelResolver.list_available_models()
        assert names[:5] == ["pro", "flash", "flash-lite", "flash-legacy", "ultra"]
        assert len(names) == len(set(names))
        assert "sonnet" in names

    def test_model_infos_carry_the_registry_metadata(self):
        infos = ModelResolver.model_infos("claude")
        assert [i.name for i in infos] == ModelResolver.list_models("claude")
        assert all(isinstance(i, ModelInfo) and i.provider == ProviderType.CLAUDE for i in infos)

    def test_model_infos_tag_as_overrides_the_provider(self):
        infos = ModelResolver.model_infos("gemini", tag_as=ProviderType.VERTEX_AI)
        assert infos and all(i.provider == ProviderType.VERTEX_AI for i in infos)

    def test_model_infos_unknown_provider_tag_falls_back_to_gemini(self, monkeypatch):
        monkeypatch.setattr(ModelResolver, "_REGISTRY", {"x-model": {"provider": "not-a-provider"}})
        infos = ModelResolver.model_infos()
        assert [(i.name, i.provider) for i in infos] == [("x-model", ProviderType.GEMINI)]

    def test_menu_choices_label_known_ids_and_echo_unknown_ones(self, monkeypatch):
        monkeypatch.setenv("EGC_EXTRA_MODELS", "gemini-9.9-test")
        choices = dict(ModelResolver.menu_choices("gemini"))
        assert choices["gemini-2.5-pro"].startswith("Gemini 2.5 Pro")
        assert choices["gemini-9.9-test"] == "gemini-9.9-test"


@pytest.mark.unit
class TestDescribeStrategy:
    def test_default_is_dynamic_routing(self):
        info = ModelResolver.describe_strategy()
        assert info["strategy"] == "Dynamic Routing"
        assert info["provider_id"] == "gemini"
        assert info["provider"] == "Google Gemini"
        assert info["resolved_model"] == "gemini-3.8-flash"
        assert info["preferred_capability"] == "reasoning"
        assert info["fallback_chain"].startswith("gemini-3.8-flash -> gemini-3.6-flash")

    def test_explicit_model_is_fallback_protected(self):
        info = ModelResolver.describe_strategy("gpt-4o-mini")
        assert info["strategy"] == "Explicit model (fallback-protected)"
        assert info["provider"] == "OpenAI"
        assert info["preferred_capability"] == "low-latency"

    def test_alias_hint_is_still_dynamic(self):
        assert ModelResolver.describe_strategy("sonnet")["strategy"] == "Dynamic Routing"

    def test_env_model_for_the_provider_is_pinned(self, monkeypatch):
        monkeypatch.setenv("LLM_MODEL", "gemini-2.5-flash")
        info = ModelResolver.describe_strategy()
        assert info["strategy"] == "Pinned via environment"
        assert info["resolved_model"] == "gemini-2.5-flash"

    def test_reports_the_real_provider_for_an_unregistered_groq_native_id(self, monkeypatch):
        # Regression: describe_strategy used to report "gemini" for a model
        # that default_model had already correctly pinned to groq, because
        # the provider hint never reached the second _provider_for call.
        monkeypatch.setenv("LLM_MODEL", "llama-3.3-70b-versatile")
        info = ModelResolver.describe_strategy(provider="groq")
        assert info["provider_id"] == "groq"
        assert info["resolved_model"] == "llama-3.3-70b-versatile"
        assert info["strategy"] == "Pinned via environment"

    def test_preferred_capability_code_and_general(self, monkeypatch):
        monkeypatch.setattr(ModelResolver, "_REGISTRY", {
            "gemini-code-only": {"provider": "gemini", "capabilities": [ModelCapability.CODE]},
        })
        assert ModelResolver.describe_strategy("gemini-code-only")["preferred_capability"] == "code"
        assert ModelResolver.describe_strategy("vendor/new-model")["preferred_capability"] == "general"


@pytest.mark.unit
class TestCatalogRefreshMistralCohereDeepSeek:
    """#1695, #1696, #1697: Mistral, Cohere and DeepSeek ids checked against the vendors on 2026-10-11."""

    def test_mistral_default_is_the_model_the_vendor_recommends(self):
        assert ModelResolver.default_model("mistral") == "mistral-medium-latest"
        assert ModelResolver.fallback_chain("mistral-large-4") == ["mistral-medium-latest", "mistral-large-latest", "mistral-small-latest", "ministral-14b-latest", "ministral-8b-latest", "ministral-3b-latest"]

    def test_retired_mistral_ids_resolve_to_the_replacement_the_vendor_names(self):
        assert ModelResolver.resolve("mistral-large-2411") == "mistral-medium-latest"
        assert ModelResolver.resolve("mistral-medium-2508") == "mistral-medium-latest"
        assert ModelResolver.resolve("mistral-small-2506") == "mistral-small-latest"
        assert ModelResolver.resolve("codestral-2508") == "codestral-2508"

    def test_cohere_catalog_carries_the_live_models_and_maps_the_deprecated_ids(self):
        live = set(ModelResolver.list_models("cohere"))
        assert {"command-a-plus-05-2026", "command-a-03-2025", "command-a-reasoning-08-2025", "command-r-plus-08-2024", "command-r-08-2024", "command-r7b-12-2024"} <= live
        assert ModelResolver.resolve("command-r-plus") == "command-r-plus-08-2024"
        assert ModelResolver.resolve("command-r") == "command-r-08-2024"
        assert ModelResolver.resolve("command-light") == "command-r7b-12-2024"
        assert ModelResolver.default_model("cohere") == "command-a-plus-05-2026"

    def test_deepseek_default_and_retired_ids(self):
        assert ModelResolver.default_model("deepseek") == "deepseek-flash"
        assert ModelResolver.resolve("deepseek-chat") == "deepseek-flash"
        assert ModelResolver.resolve("deepseek-reasoner") == "deepseek-flash"
        assert ModelResolver.resolve("deepseek-v4-flash") == "deepseek-flash"
        assert ModelResolver.get_fallback("deepseek-v4-pro") == "deepseek-flash"
        assert ModelResolver.supports("deepseek-flash", ModelCapability.TOOL_CALLING)

    @pytest.mark.parametrize("provider", ["mistral", "cohere", "deepseek"])
    def test_every_registered_model_has_a_menu_label(self, provider):
        for model_id, label in ModelResolver.menu_choices(provider):
            assert label != model_id, model_id


@pytest.mark.unit
class TestCatalogRefreshGeminiClaudeOpenAI:
    """#1692, #1693, #1694: Gemini, Vertex AI, Claude and OpenAI ids checked against the vendors on 2026-10-11."""

    def test_gemini_default_is_the_flash_the_models_page_presents_first(self):
        assert ModelResolver.default_model("gemini") == "gemini-3.8-flash"
        assert ModelResolver.get_fallback("gemini-3.1-pro-preview") == "gemini-3.8-flash"

    def test_shut_down_gemini_ids_resolve_to_the_replacement_the_vendor_names(self):
        assert ModelResolver.resolve("gemini-2.0-flash") == "gemini-3.6-flash"
        assert ModelResolver.resolve("gemini-2.0-flash-lite") == "gemini-3.1-flash-lite"
        assert ModelResolver.resolve("gemini-1.5-flash-8b") == "gemini-3.5-flash-lite"
        assert "gemini-2.0-flash" not in ModelResolver.list_models("gemini")

    def test_gemini_25_line_stays_registered_for_the_accounts_that_still_have_it(self):
        assert ModelResolver.resolve("gemini-2.5-flash") == "gemini-2.5-flash"
        assert ModelResolver.get_fallback("gemini-2.5-flash") == "gemini-3.6-flash"

    def test_vertex_ai_borrows_the_current_gemini_catalog(self):
        from llm.core.types import ProviderType
        names = {m.name for m in ModelResolver.model_infos("gemini", tag_as=ProviderType.VERTEX_AI)}
        assert {"gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.1-pro-preview"} <= names

    def test_claude_default_and_retired_ids(self):
        assert ModelResolver.default_model("claude") == "claude-sonnet-5-5"
        assert ModelResolver.resolve("claude-sonnet-4-7") == "claude-sonnet-5-5"
        assert ModelResolver.resolve("claude-haiku-4-7") == "claude-haiku-5-5"
        assert ModelResolver.fallback_chain("claude-fable-5-1") == ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]

    def test_openai_default_and_chain(self):
        assert ModelResolver.default_model("openai") == "gpt-6.1-sol"
        assert ModelResolver.fallback_chain("gpt-6-astra") == ["gpt-6.1-sol", "gpt-6-luna", "gpt-4o", "gpt-4o-mini"]

    @pytest.mark.parametrize("provider", ["gemini", "claude", "openai"])
    def test_every_registered_model_has_a_menu_label(self, provider):
        for model_id, label in ModelResolver.menu_choices(provider):
            assert label != model_id, model_id
