

from __future__ import annotations

import os
import sys
from enum import Enum

try:
    from llm.core.model_resolver import ModelResolver
except Exception:  # pragma: no cover - selector still works standalone
    ModelResolver = None  # type: ignore[assignment]


class Color(str, Enum):
    RESET = "\033[0m"
    BOLD = "\033[1m"
    GREEN = "\033[92m"
    YELLOW = "\033[93m"
    BLUE = "\033[94m"
    CYAN = "\033[96m"


def print_banner() -> None:
    banner = f"""{Color.CYAN}
╔════════════════════════════════════════════════════════════╗
║   EGC — Everything Gemini Code                             ║
║   Desenvolvido por Felipe Marzochi  -  @FEMARZOCHI         ║
║   https://github.com/Fmarzochi/EGC           ║
║   © Todos os direitos reservados                           ║
╚════════════════════════════════════════════════════════════╝{Color.RESET}"""
    print(banner)


def print_providers(providers: list[tuple[str, str]]) -> None:
    print(f"\n{Color.BOLD}Available Providers:{Color.RESET}\n")
    for i, (name, desc) in enumerate(providers, 1):
        print(f"  {Color.GREEN}{i}{Color.RESET}. {Color.BOLD}{name}{Color.RESET} - {desc}")


def select_provider(providers: list[tuple[str, str]]) -> str | None:
    if not providers:
        print("No providers available.")
        return None

    print_providers(providers)

    while True:
        try:
            choice = input(f"\n{Color.YELLOW}Select provider (1-{len(providers)}): {Color.RESET}").strip()
            if not choice:
                return None
            idx = int(choice) - 1
            if 0 <= idx < len(providers):
                return providers[idx][0]
            print(f"{Color.YELLOW}Invalid selection. Try again.{Color.RESET}")
        except ValueError:
            print(f"{Color.YELLOW}Please enter a number.{Color.RESET}")


def select_model(models: list[tuple[str, str]]) -> str | None:
    if not models:
        print("No models available.")
        return None

    print(f"\n{Color.BOLD}Available Models:{Color.RESET}\n")
    for i, (name, desc) in enumerate(models, 1):
        print(f"  {Color.GREEN}{i}{Color.RESET}. {Color.BOLD}{name}{Color.RESET} - {desc}")

    while True:
        try:
            choice = input(f"\n{Color.YELLOW}Select model (1-{len(models)}): {Color.RESET}").strip()
            if not choice:
                return None
            idx = int(choice) - 1
            if 0 <= idx < len(models):
                return models[idx][0]
            print(f"{Color.YELLOW}Invalid selection. Try again.{Color.RESET}")
        except ValueError:
            print(f"{Color.YELLOW}Please enter a number.{Color.RESET}")


def save_config(provider: str, model: str, persist: bool = False) -> None:
    config = f"LLM_PROVIDER={provider}\nLLM_MODEL={model}\n"
    env_file = ".llm.env"

    with open(env_file, "w") as f:
        f.write(config)

    print(f"\n{Color.GREEN}✓{Color.RESET} Config saved to {Color.CYAN}{env_file}{Color.RESET}")

    if persist:
        os.environ["LLM_PROVIDER"] = provider
        os.environ["LLM_MODEL"] = model
        print(f"{Color.GREEN}✓{Color.RESET} Config loaded to current session")


def interactive_select(
    providers: list[tuple[str, str]] | None = None,
    models_per_provider: dict[str, list[tuple[str, str]]] | None = None,
    persist: bool = False,
) -> tuple[str, str] | None:
    print_banner()

    if providers is None:
        providers = [
            ("gemini", "Google Gemini (1.5 / 2.x, dynamic routing) - default"),
            ("openrouter", "OpenRouter (broker: Gemini / Claude / GPT / Llama / ...)"),
            ("claude", "Anthropic Claude (compat bridge)"),
            ("openai", "OpenAI GPT (compat bridge)"),
            ("ollama", "Local Ollama models"),
        ]

    if models_per_provider is None:
        if ModelResolver is not None:
            # Catalogue and labels come from the centralized registry, so the
            # selector never carries a hardcoded model list of its own.
            models_per_provider = {
                name: ModelResolver.menu_choices(name) for name, _ in providers
            }
            # Always offer a symbolic "auto" entry that defers to dynamic routing.
            for name in list(models_per_provider):
                models_per_provider[name].insert(0, ("default", f"Auto - dynamic routing ({ModelResolver.default_model(name)})"))
        else:  # pragma: no cover - only when the resolver cannot be imported
            # Fallback when ModelResolver is unavailable: only offer symbolic "Auto".
            # The runtime will still try to load ModelResolver when generate() is called.
            models_per_provider = {
                name: [("default", "Auto - dynamic routing")] for name, _ in providers
            }

    provider = select_provider(providers)
    if not provider:
        return None

    models = models_per_provider.get(provider, [])
    model = select_model(models)
    if not model:
        return None

    print(f"\n{Color.GREEN}Selected: {Color.BOLD}{provider}{Color.RESET} / {Color.BOLD}{model}{Color.RESET}")

    save_config(provider, model, persist)

    return (provider, model)


def main() -> None:
    result = interactive_select(persist=True)

    if result:
        print(f"\n{Color.GREEN}Ready to use!{Color.RESET}")
        print(f"  export LLM_PROVIDER={result[0]}")
        print(f"  export LLM_MODEL={result[1]}")
    else:
        print("\nSelection cancelled.")
        sys.exit(0)


if __name__ == "__main__":
    main()
