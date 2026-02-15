import os

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379")
QDRANT_URL = os.environ.get("QDRANT_URL", "http://localhost:6333")
NEO4J_URL = os.environ.get("NEO4J_URL", "bolt://localhost:7687")
NEO4J_USER = os.environ.get("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "")
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")

EXTRACTOR_PROVIDER = os.environ.get("EXTRACTOR_PROVIDER", "ollama")
EXTRACTOR_MODEL_FAST = os.environ.get("EXTRACTOR_MODEL_FAST", "llama3")
EXTRACTOR_MODEL_CAPABLE = os.environ.get("EXTRACTOR_MODEL_CAPABLE", "llama3")
EXTRACTOR_MODEL_VISION = os.environ.get("EXTRACTOR_MODEL_VISION", "llava")

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")

WORKER_CONCURRENCY = int(os.environ.get("WORKER_CONCURRENCY", "4"))
MAX_RETRIES = 3
QUEUE_NAME = "enrichment:pending"
DEAD_LETTER_QUEUE = "enrichment:dead-letter"

# Only validate Neo4j password if authentication is required
# NEO4J_AUTH=none means auth is disabled
NEO4J_AUTH = os.environ.get("NEO4J_AUTH", "")
if NEO4J_AUTH and NEO4J_AUTH != "none" and not NEO4J_PASSWORD:
    raise RuntimeError(
        "NEO4J_PASSWORD environment variable must be set when Neo4j authentication is enabled"
    )
