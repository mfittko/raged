"""Tier-2 NLP extraction using spaCy and other NLP libraries."""

import logging
import threading

import spacy

logger = logging.getLogger(__name__)

# Module-level state for lazy loading
_nlp: spacy.Language | None = None
_nlp_lock = threading.Lock()


def _get_nlp() -> spacy.Language:
    """Lazy-load spaCy model with error handling."""
    global _nlp

    if _nlp is None:
        with _nlp_lock:
            if _nlp is None:  # Double-check after acquiring lock
                try:
                    _nlp = spacy.load("en_core_web_sm")
                    # Initialize TextRank once during setup
                    import pytextrank  # noqa: F401 - side-effect import for spacy pipeline

                    if "textrank" not in _nlp.pipe_names:
                        _nlp.add_pipe("textrank")
                except Exception as e:
                    raise RuntimeError(
                        f"Failed to load spaCy model 'en_core_web_sm'. "
                        f"Ensure it's installed: python -m spacy download en_core_web_sm. "
                        f"Error: {e}"
                    ) from e
    return _nlp


def extract_entities(text: str) -> list[dict[str, str]]:
    """Extract named entities from text using spaCy.

    Args:
        text: Input text to analyze

    Returns:
        List of entities with text and label (PERSON, ORG, DATE, LOC, etc.)
    """
    if not text or not text.strip():
        return []

    nlp = _get_nlp()
    doc = nlp(text)
    return [{"text": ent.text, "label": ent.label_} for ent in doc.ents]


def extract_keywords(text: str, top_n: int = 10) -> list[str]:
    """Extract keywords/phrases from text using TextRank.

    Args:
        text: Input text to analyze
        top_n: Number of top keywords to return

    Returns:
        List of keyword phrases
    """
    if not text or not text.strip():
        return []

    nlp = _get_nlp()
    doc = nlp(text)

    # Extract top phrases
    phrases = []
    for phrase in doc._.phrases[:top_n]:
        phrases.append(phrase.text)

    return phrases


def detect_language(text: str) -> str:
    """Detect the language of the text.

    Args:
        text: Input text to analyze

    Returns:
        ISO language code (e.g., 'en', 'es', 'fr') or 'unknown'
    """
    from langdetect import DetectorFactory, detect

    # Set seed for reproducibility
    DetectorFactory.seed = 0

    # Normalize text
    normalized = text.replace("\n", " ").strip()
    if not normalized:
        return "unknown"

    try:
        return detect(normalized)
    except Exception as e:
        logger.debug(f"Language detection failed for text: {e}")
        return "unknown"


def process_text_nlp(text: str) -> dict:
    """Process text with spaCy in a single pass for entities and keywords.

    This is more efficient than calling extract_entities() and extract_keywords()
    separately as it runs the spaCy pipeline only once.

    Args:
        text: Input text to analyze

    Returns:
        Dictionary with 'entities' and 'keywords' lists
    """
    if not text or not text.strip():
        return {"entities": [], "keywords": []}

    nlp = _get_nlp()
    doc = nlp(text)

    # Extract entities
    entities = [{"text": ent.text, "label": ent.label_} for ent in doc.ents]

    # Extract keywords from TextRank
    keywords = []
    for phrase in doc._.phrases[:10]:  # Top 10 keywords
        keywords.append(phrase.text)

    return {"entities": entities, "keywords": keywords}
