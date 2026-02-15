"""Tests for tier-2 NLP extraction."""

import pytest

from src.tier2 import (
    detect_language,
    extract_entities,
    extract_keywords,
    process_text_nlp,
)


# Helper to check if spaCy model is available
def _spacy_model_available():
    """Check if spaCy model is installed."""
    try:
        import spacy

        spacy.load("en_core_web_sm")
        return True
    except (OSError, ImportError):
        return False


requires_spacy_model = pytest.mark.skipif(
    not _spacy_model_available(), reason="spaCy model en_core_web_sm not installed"
)


@requires_spacy_model
def test_extract_entities():
    """Test entity extraction from text."""
    text = "Apple Inc. was founded by Steve Jobs in Cupertino, California on April 1, 1976."
    entities = extract_entities(text)

    # Should find entities for organization, person, location, date
    assert len(entities) > 0
    assert any(e["label"] in ["ORG", "PERSON", "GPE", "DATE"] for e in entities)

    # Check we got Apple and Steve Jobs
    entity_texts = [e["text"] for e in entities]
    assert any("Apple" in text for text in entity_texts)
    assert any("Jobs" in text or "Steve Jobs" in text for text in entity_texts)


@requires_spacy_model
def test_extract_entities_empty():
    """Test entity extraction with empty text."""
    assert extract_entities("") == []
    assert extract_entities("   ") == []


@requires_spacy_model
def test_extract_keywords():
    """Test keyword extraction from text."""
    text = """
    Machine learning is a subset of artificial intelligence that focuses on
    building systems that can learn from data. Deep learning is a type of
    machine learning that uses neural networks with multiple layers.
    """
    keywords = extract_keywords(text, top_n=5)

    # Should return some keywords
    assert len(keywords) > 0
    assert len(keywords) <= 5

    # Keywords should be strings
    assert all(isinstance(k, str) for k in keywords)


@requires_spacy_model
def test_extract_keywords_empty():
    """Test keyword extraction with empty text."""
    assert extract_keywords("") == []
    assert extract_keywords("   ") == []


def test_detect_language_english():
    """Test language detection for English text."""
    text = "This is a sentence in English. It should be detected correctly."
    lang = detect_language(text)
    assert lang == "en"


def test_detect_language_spanish():
    """Test language detection for Spanish text."""
    text = "Esta es una frase en español. Debe ser detectada correctamente."
    lang = detect_language(text)
    assert lang == "es"


def test_detect_language_french():
    """Test language detection for French text."""
    text = "Ceci est une phrase en français. Elle devrait être détectée correctement."
    lang = detect_language(text)
    assert lang == "fr"


def test_detect_language_empty():
    """Test language detection with empty text."""
    assert detect_language("") == "unknown"
    assert detect_language("   ") == "unknown"


def test_detect_language_short():
    """Test language detection with very short text."""
    # Short text might not be reliably detected, but should not crash
    result = detect_language("Hi")
    assert isinstance(result, str)


@requires_spacy_model
def test_process_text_nlp():
    """Test single-pass NLP processing for entities and keywords."""
    text = (
        "Apple Inc. was founded by Steve Jobs in California. "
        "The company revolutionized personal computing."
    )
    result = process_text_nlp(text)

    # Verify structure
    assert "entities" in result
    assert "keywords" in result
    assert isinstance(result["entities"], list)
    assert isinstance(result["keywords"], list)

    # Verify entities were extracted
    assert len(result["entities"]) > 0
    entity_texts = [e["text"] for e in result["entities"]]
    assert any("Apple" in text for text in entity_texts)

    # Verify keywords were extracted
    assert len(result["keywords"]) > 0


@requires_spacy_model
def test_process_text_nlp_empty():
    """Test process_text_nlp with empty text."""
    result = process_text_nlp("")
    assert result == {"entities": [], "keywords": []}
