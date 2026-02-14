"""Tests for extraction schemas."""
import pytest
import json
from src.schemas import get_schema_for_doctype
from src.schemas.code import CodeMetadata
from src.schemas.slack import SlackMetadata, ActionItem as SlackActionItem
from src.schemas.email import EmailMetadata, ActionItem as EmailActionItem
from src.schemas.meeting import MeetingMetadata, ActionItem as MeetingActionItem, TopicSegment
from src.schemas.image import ImageMetadata
from src.schemas.pdf import PDFMetadata, Section
from src.schemas.article import ArticleMetadata
from src.schemas.text import TextMetadata
from src.schemas.entities import Entity, Relationship, EntityExtractionResult


def test_code_schema():
    """Test code metadata schema."""
    data = {
        "summary": "A test class",
        "purpose": "Testing",
        "complexity": "low"
    }
    metadata = CodeMetadata(**data)
    
    assert metadata.summary == "A test class"
    assert metadata.purpose == "Testing"
    assert metadata.complexity == "low"
    
    # Test serialization
    json_str = metadata.model_dump_json()
    assert isinstance(json_str, str)
    parsed = json.loads(json_str)
    assert parsed["summary"] == "A test class"


def test_slack_schema():
    """Test Slack metadata schema."""
    data = {
        "summary": "Discussion about feature X",
        "decisions": ["Implement feature X"],
        "action_items": [
            {"task": "Write spec", "assignee": "Alice"}
        ],
        "sentiment": "positive"
    }
    metadata = SlackMetadata(**data)
    
    assert metadata.summary == "Discussion about feature X"
    assert len(metadata.decisions) == 1
    assert len(metadata.action_items) == 1
    assert metadata.action_items[0].task == "Write spec"


def test_email_schema():
    """Test email metadata schema."""
    data = {
        "urgency": "high",
        "intent": "request",
        "action_items": [
            {"task": "Review PR", "assignee": "Bob"}
        ],
        "summary": "Please review the PR"
    }
    metadata = EmailMetadata(**data)
    
    assert metadata.urgency == "high"
    assert metadata.intent == "request"
    assert len(metadata.action_items) == 1


def test_meeting_schema():
    """Test meeting metadata schema."""
    data = {
        "decisions": ["Approved budget"],
        "action_items": [
            {"task": "Schedule followup", "assignee": "Charlie", "deadline": "2026-02-20"}
        ],
        "topic_segments": [
            {"topic": "Budget", "summary": "Discussed Q1 budget"}
        ]
    }
    metadata = MeetingMetadata(**data)
    
    assert len(metadata.decisions) == 1
    assert len(metadata.action_items) == 1
    assert len(metadata.topic_segments) == 1
    assert metadata.action_items[0].deadline == "2026-02-20"


def test_image_schema():
    """Test image metadata schema."""
    data = {
        "description": "A photo of a cat",
        "detected_objects": ["cat", "furniture"],
        "ocr_text": "Hello World",
        "image_type": "photo"
    }
    metadata = ImageMetadata(**data)
    
    assert metadata.description == "A photo of a cat"
    assert "cat" in metadata.detected_objects
    assert metadata.ocr_text == "Hello World"


def test_pdf_schema():
    """Test PDF metadata schema."""
    data = {
        "summary": "Technical specification",
        "key_entities": ["API", "Database"],
        "sections": [
            {"title": "Introduction", "summary": "Overview of the system"}
        ]
    }
    metadata = PDFMetadata(**data)
    
    assert metadata.summary == "Technical specification"
    assert len(metadata.key_entities) == 2
    assert len(metadata.sections) == 1


def test_article_schema():
    """Test article metadata schema."""
    data = {
        "summary": "How to use Python",
        "takeaways": ["Python is easy", "Start with basics"],
        "tags": ["python", "tutorial"],
        "target_audience": "Beginners"
    }
    metadata = ArticleMetadata(**data)
    
    assert metadata.summary == "How to use Python"
    assert len(metadata.takeaways) == 2
    assert "python" in metadata.tags


def test_text_schema():
    """Test generic text metadata schema."""
    data = {
        "summary": "A generic document",
        "key_entities": ["Entity1", "Entity2"]
    }
    metadata = TextMetadata(**data)
    
    assert metadata.summary == "A generic document"
    assert len(metadata.key_entities) == 2
    assert "Entity1" in metadata.key_entities


def test_entity_schema():
    """Test entity extraction schema."""
    data = {
        "entities": [
            {"name": "AuthService", "type": "class", "description": "Handles authentication"}
        ],
        "relationships": [
            {"source": "AuthService", "target": "JWT", "type": "uses", "description": "Uses JWT for tokens"}
        ]
    }
    result = EntityExtractionResult(**data)
    
    assert len(result.entities) == 1
    assert result.entities[0].name == "AuthService"
    assert len(result.relationships) == 1
    assert result.relationships[0].type == "uses"


def test_get_schema_for_doctype_code():
    """Test schema router for code type."""
    schema_class, prompt = get_schema_for_doctype("code")
    assert schema_class == CodeMetadata
    assert "{text}" in prompt
    assert "{schema}" in prompt


def test_get_schema_for_doctype_slack():
    """Test schema router for slack type."""
    schema_class, prompt = get_schema_for_doctype("slack")
    assert schema_class == SlackMetadata
    assert "slack" in prompt.lower() or "conversation" in prompt.lower()


def test_get_schema_for_doctype_email():
    """Test schema router for email type."""
    schema_class, prompt = get_schema_for_doctype("email")
    assert schema_class == EmailMetadata
    assert "email" in prompt.lower()


def test_get_schema_for_doctype_meeting():
    """Test schema router for meeting type."""
    schema_class, prompt = get_schema_for_doctype("meeting")
    assert schema_class == MeetingMetadata
    assert "meeting" in prompt.lower()


def test_get_schema_for_doctype_image():
    """Test schema router for image type."""
    schema_class, prompt = get_schema_for_doctype("image")
    assert schema_class == ImageMetadata
    assert "image" in prompt.lower()


def test_get_schema_for_doctype_pdf():
    """Test schema router for pdf type."""
    schema_class, prompt = get_schema_for_doctype("pdf")
    assert schema_class == PDFMetadata
    assert "pdf" in prompt.lower() or "document" in prompt.lower()


def test_get_schema_for_doctype_article():
    """Test schema router for article type."""
    schema_class, prompt = get_schema_for_doctype("article")
    assert schema_class == ArticleMetadata
    assert "article" in prompt.lower()


def test_get_schema_for_doctype_fallback():
    """Test schema router falls back for unknown types."""
    from src.schemas.text import TextMetadata
    
    schema_class, prompt = get_schema_for_doctype("unknown")
    # Should return text schema as fallback
    assert schema_class == TextMetadata
    assert prompt is not None


def test_schema_serialization():
    """Test that all schemas can be serialized to JSON schema."""
    for doc_type in ["code", "slack", "email", "meeting", "image", "pdf", "article", "text"]:
        schema_class, _ = get_schema_for_doctype(doc_type)
        json_schema = schema_class.model_json_schema()
        
        # Verify it's a valid schema dict
        assert isinstance(json_schema, dict)
        assert "properties" in json_schema or "type" in json_schema


def test_text_schema_explicit():
    """Test that 'text' doc type returns TextMetadata explicitly."""
    from src.schemas.text import TextMetadata
    
    schema_class, prompt = get_schema_for_doctype("text")
    assert schema_class == TextMetadata
    assert "text" in prompt.lower() or "generic" in prompt.lower()
