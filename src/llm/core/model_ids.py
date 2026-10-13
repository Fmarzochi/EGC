"""Model ID constants shared by the registry, the aliases and the provider adapters.

Each id was checked against the vendor documentation named in the comment above it.
"""

# Module-level model ID constants to avoid string duplication (SonarCloud S1192)
GEMINI_25_PRO = "gemini-2.5-pro"
GEMINI_25_FLASH = "gemini-2.5-flash"
GEMINI_25_FLASH_LITE = "gemini-2.5-flash-lite"
GEMINI_20_FLASH_LITE = "gemini-2.0-flash-lite"
GEMINI_15_FLASH = "gemini-1.5-flash"
GEMINI_15_FLASH_8B = "gemini-1.5-flash-8b"
# Gemini API ids checked on 2026-10-11 (ai.google.dev/gemini-api/docs/models and
# docs/deprecations): the 3.x line is current, the 2.5 line is still served to
# accounts that used it, 2.0 and 1.5 are shut down and map to a replacement.
GEMINI_38_FLASH = "gemini-3.8-flash"
GEMINI_36_FLASH = "gemini-3.6-flash"
GEMINI_35_FLASH_LITE = "gemini-3.5-flash-lite"
GEMINI_31_FLASH_LITE = "gemini-3.1-flash-lite"
GEMINI_31_PRO_PREVIEW = "gemini-3.1-pro-preview"
GEMINI_20_FLASH_RETIRED = "gemini-2.0-flash"
GEMINI_15_PRO_RETIRED = "gemini-1.5-pro"
# Claude API ids checked on 2026-10-11 (platform.claude.com, models overview).
CLAUDE_OPUS_55 = "claude-opus-5-5"
CLAUDE_FABLE_51 = "claude-fable-5-1"
CLAUDE_SONNET_55 = "claude-sonnet-5-5"
CLAUDE_HAIKU_55 = "claude-haiku-5-5"
CLAUDE_SONNET_47_RETIRED = "claude-sonnet-4-7"
CLAUDE_HAIKU_47_RETIRED = "claude-haiku-4-7"
# OpenAI ids checked on 2026-10-11 (developers.openai.com/api/docs/models).
GPT6_ASTRA = "gpt-6-astra"
GPT61_SOL = "gpt-6.1-sol"
GPT6_LUNA = "gpt-6-luna"
OPENAI_GPT_4O_MINI = "openai/gpt-4o-mini"
OPENROUTER_AUTO = "openrouter/auto"
OPENAI_GPT_OSS_120B = "openai/gpt-oss-120b"
LLAMA32 = "llama3.2"
# Ollama library ids checked on 2026-10-11 (https://ollama.com/library): the
# bare name is the library default tag; a tagged id such as "qwen3:8b" passes
# through resolve() unchanged.
QWEN3 = "qwen3"
GPT_OSS = "gpt-oss"
LLAMA33 = "llama3.3"
LLAMA31 = "llama3.1"
GEMMA4 = "gemma4"
DEEPSEEK_R1_OLLAMA = "deepseek-r1"
# Groq production ids checked on 2026-10-11 (https://console.groq.com/docs/models).
GROQ_GPT_OSS_20B = "openai/gpt-oss-20b"
GROQ_LLAMA33_70B = "llama-3.3-70b-versatile"
GROQ_LLAMA31_8B = "llama-3.1-8b-instant"
# OpenRouter ids checked on 2026-10-11 (https://openrouter.ai/<vendor>/<model>).
QWEN35_397B = "qwen/qwen3.5-397b-a17b"
QWEN3_235B_RETIRED = "qwen/qwen3-235b-a22b"
ANTHROPIC_CLAUDE_SONNET_55 = "anthropic/claude-sonnet-5.5"
OPENAI_GPT6_ASTRA = "openai/gpt-6-astra"
GOOGLE_GEMINI_38_FLASH = "google/gemini-3.8-flash"
GOOGLE_GEMINI_25_FLASH = "google/gemini-2.5-flash"
OPENAI_GPT_4O = "openai/gpt-4o"
ANTHROPIC_CLAUDE_SONNET_45 = "anthropic/claude-sonnet-4.5"

# Mistral ids checked on 2026-10-11 (docs.mistral.ai: models overview, changelog,
# vibe/code/cli/configuration and studio/conversations/function-calling). The
# "-latest" alias of each line is the id the vendor documents for the API.
MISTRAL_MEDIUM_LATEST = "mistral-medium-latest"
MISTRAL_LARGE_LATEST = "mistral-large-latest"
MISTRAL_LARGE_4 = "mistral-large-4"
MISTRAL_SMALL_LATEST = "mistral-small-latest"
CODESTRAL_LATEST = "codestral-latest"
MINISTRAL_14B_LATEST = "ministral-14b-latest"
MINISTRAL_8B_LATEST = "ministral-8b-latest"
MINISTRAL_3B_LATEST = "ministral-3b-latest"
# Cohere ids checked on 2026-10-11 (docs.cohere.com/docs/models).
COHERE_COMMAND_A_PLUS = "command-a-plus-05-2026"
COHERE_COMMAND_A = "command-a-03-2025"
COHERE_COMMAND_A_REASONING = "command-a-reasoning-08-2025"
COHERE_COMMAND_A_VISION = "command-a-vision-07-2025"
COHERE_COMMAND_A_TRANSLATE = "command-a-translate-08-2025"
COHERE_COMMAND_R_PLUS = "command-r-plus-08-2024"
COHERE_COMMAND_R = "command-r-08-2024"
COHERE_COMMAND_R7B = "command-r7b-12-2024"
# DeepSeek ids checked on 2026-10-11 (api-docs.deepseek.com: quick_start/pricing,
# updates and guides/thinking_mode). Thinking is a request parameter on the
# current API, not a model id.
DEEPSEEK_FLASH = "deepseek-flash"
DEEPSEEK_V4_PRO = "deepseek-v4-pro"
DEEPSEEK_CHAT_RETIRED = "deepseek-chat"
DEEPSEEK_REASONER_RETIRED = "deepseek-reasoner"
DEEPSEEK_V4_FLASH_RETIRED = "deepseek-v4-flash"
DEEPSEEK_V4_FLASH_VISION_RETIRED = "deepseek-v4-flash-vision-exp"

# Ids the registry and the OpenRouter menu reuse.
GPT_4O = "gpt-4o"
GPT_4O_MINI = "gpt-4o-mini"
DEEPSEEK_CHAT_V3 = "deepseek/deepseek-chat-v3-0324"
QWEN3_32B = "qwen/qwen3-32b"
LLAMA4_SCOUT = "meta-llama/llama-4-scout"
