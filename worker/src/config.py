import os

# API communication settings
API_URL = os.environ.get("API_URL", "http://localhost:3000")
API_TOKEN = os.environ.get("API_TOKEN", "")

# LLM provider settings
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")

EXTRACTOR_PROVIDER = os.environ.get("EXTRACTOR_PROVIDER", "ollama")
EXTRACTOR_MODEL_FAST = os.environ.get("EXTRACTOR_MODEL_FAST", "llama3")
EXTRACTOR_MODEL_CAPABLE = os.environ.get("EXTRACTOR_MODEL_CAPABLE", "llama3")
EXTRACTOR_MODEL_VISION = os.environ.get("EXTRACTOR_MODEL_VISION", "llava")

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")

# Worker settings
WORKER_CONCURRENCY = int(os.environ.get("WORKER_CONCURRENCY", "4"))
MAX_RETRIES = 3
QUEUE_NAME = "enrichment"
