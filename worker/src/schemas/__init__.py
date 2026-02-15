"""Schema router and registry."""

from typing import Tuple, Type
from pydantic import BaseModel


def get_schema_for_doctype(doc_type: str) -> Tuple[Type[BaseModel], str]:
    """Get the Pydantic schema and prompt template for a document type.

    Args:
        doc_type: Document type (code, slack, email, meeting, image, pdf, article, text)

    Returns:
        Tuple of (schema_class, prompt_template)
    """
    if doc_type == "code":
        from src.schemas.code import CodeMetadata, PROMPT

        return CodeMetadata, PROMPT

    elif doc_type == "slack":
        from src.schemas.slack import SlackMetadata, PROMPT

        return SlackMetadata, PROMPT

    elif doc_type == "email":
        from src.schemas.email import EmailMetadata, PROMPT

        return EmailMetadata, PROMPT

    elif doc_type == "meeting":
        from src.schemas.meeting import MeetingMetadata, PROMPT

        return MeetingMetadata, PROMPT

    elif doc_type == "image":
        from src.schemas.image import ImageMetadata, PROMPT

        return ImageMetadata, PROMPT

    elif doc_type == "pdf":
        from src.schemas.pdf import PDFMetadata, PROMPT

        return PDFMetadata, PROMPT

    elif doc_type == "article":
        from src.schemas.article import ArticleMetadata, PROMPT

        return ArticleMetadata, PROMPT

    elif doc_type == "text":
        # Explicit handling for generic text
        from src.schemas.text import TextMetadata, PROMPT

        return TextMetadata, PROMPT

    else:
        # Fallback for unknown types - use generic text schema
        from src.schemas.text import TextMetadata, PROMPT

        return TextMetadata, PROMPT


__all__ = ["get_schema_for_doctype"]
