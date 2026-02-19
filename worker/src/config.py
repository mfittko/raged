import os

# API communication settings
API_URL = os.environ.get("API_URL", "http://localhost:3000")
API_TOKEN = os.environ.get("API_TOKEN", "")

# LLM provider settings
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
OLLAMA_API_KEY = os.environ.get("OLLAMA_API_KEY", "")

EXTRACTOR_MODEL_FAST = os.environ.get("EXTRACTOR_MODEL_FAST", "gpt-4.1-mini")
EXTRACTOR_MODEL_CAPABLE = os.environ.get("EXTRACTOR_MODEL_CAPABLE", "gpt-4.1-mini")
EXTRACTOR_MODEL_VISION = os.environ.get("EXTRACTOR_MODEL_VISION", "gpt-4.1-mini")
EXTRACTOR_MAX_OUTPUT_TOKENS = int(os.environ.get("EXTRACTOR_MAX_OUTPUT_TOKENS", "16384"))

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
OPENAI_BASE_URL = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1")


def resolve_extractor_provider() -> str:
    """Resolve extractor provider from environment.

    Resolution order:
    1. If EXTRACTOR_PROVIDER is explicitly set to ollama/openai/anthropic, use it.
    2. If EXTRACTOR_PROVIDER is unset or set to auto, choose based on available keys.
       - OPENAI_API_KEY => openai
       - ANTHROPIC_API_KEY => anthropic
       - fallback => ollama
    """

    provider = os.environ.get("EXTRACTOR_PROVIDER", "openai").strip().lower()
    has_openai_key = bool(os.environ.get("OPENAI_API_KEY", ""))
    has_anthropic_key = bool(os.environ.get("ANTHROPIC_API_KEY", ""))

    if provider in {"", "auto"}:
        if has_openai_key:
            return "openai"
        if has_anthropic_key:
            return "anthropic"
        return "ollama"

    if provider not in {"ollama", "openai", "anthropic"}:
        raise ValueError(
            "Invalid EXTRACTOR_PROVIDER. Expected one of: "
            "auto, ollama, openai, anthropic"
        )

    return provider


EXTRACTOR_PROVIDER = resolve_extractor_provider()

# Worker settings
WORKER_CONCURRENCY = int(os.environ.get("WORKER_CONCURRENCY", "4"))
MAX_RETRIES = 3
QUEUE_NAME = "enrichment"
