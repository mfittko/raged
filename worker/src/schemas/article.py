"""Article/blog post metadata extraction schema."""

from pydantic import BaseModel


class ArticleMetadata(BaseModel):
    """Metadata extracted from articles and blog posts."""

    summary: str
    takeaways: list[str] = []
    tags: list[str] = []
    target_audience: str = ""


# Prompt template for article metadata extraction
PROMPT = """Analyze this article and extract metadata.

Provide:
- summary: A summary of the article
- takeaways: List of key takeaways or main points
- tags: List of relevant tags or topics
- target_audience: Description of the intended audience

Article:
{text}

Respond with valid JSON matching this schema: {schema}"""
