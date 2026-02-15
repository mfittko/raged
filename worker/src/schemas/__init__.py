"""Schema router and registry."""

from pydantic import BaseModel


def get_schema_for_doctype(doc_type: str) -> tuple[type[BaseModel], str]:
    """Get the Pydantic schema and prompt template for a document type.

    Args:
        doc_type: Document type (code, slack, email, meeting, image, pdf, article, text)

    Returns:
        Tuple of (schema_class, prompt_template)
    """
    if doc_type == "code":
        from src.schemas.code import PROMPT, CodeMetadata

        return CodeMetadata, PROMPT

    elif doc_type == "slack":
        from src.schemas.slack import PROMPT, SlackMetadata

        return SlackMetadata, PROMPT

    elif doc_type == "email":
        from src.schemas.email import PROMPT, EmailMetadata

        return EmailMetadata, PROMPT

    elif doc_type == "meeting":
        from src.schemas.meeting import PROMPT, MeetingMetadata

        return MeetingMetadata, PROMPT

    elif doc_type == "image":
        from src.schemas.image import PROMPT, ImageMetadata

        return ImageMetadata, PROMPT

    elif doc_type == "pdf":
        from src.schemas.pdf import PROMPT, PDFMetadata

        return PDFMetadata, PROMPT

    elif doc_type == "article":
        from src.schemas.article import PROMPT, ArticleMetadata

        return ArticleMetadata, PROMPT

    elif doc_type == "text":
        # Explicit handling for generic text
        from src.schemas.text import PROMPT, TextMetadata

        return TextMetadata, PROMPT

    else:
        # Fallback for unknown types - use generic text schema
        from src.schemas.text import PROMPT, TextMetadata

        return TextMetadata, PROMPT


__all__ = ["get_schema_for_doctype"]
