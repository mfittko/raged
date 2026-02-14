"""Tier-2 NLP extraction using spaCy and other NLP libraries."""
import spacy
import threading
from typing import List, Dict, Optional

# Module-level state for lazy loading
_nlp: Optional[spacy.Language] = None
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
                    import pytextrank
                    if "textrank" not in _nlp.pipe_names:
                        _nlp.add_pipe("textrank")
                except Exception as e:
                    raise RuntimeError(
                        f"Failed to load spaCy model 'en_core_web_sm'. "
                        f"Ensure it's installed: python -m spacy download en_core_web_sm. "
                        f"Error: {e}"
                    )
    return _nlp


def extract_entities(text: str) -> List[Dict[str, str]]:
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


def extract_keywords(text: str, top_n: int = 10) -> List[str]:
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
    from langdetect import detect, DetectorFactory
    
    # Set seed for reproducibility
    DetectorFactory.seed = 0
    
    # Normalize text
    normalized = text.replace("\n", " ").strip()
    if not normalized:
        return "unknown"
    
    try:
        return detect(normalized)
    except Exception:
        return "unknown"
