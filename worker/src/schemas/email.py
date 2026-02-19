"""Email metadata extraction schema."""

from pydantic import BaseModel, Field


class ActionItem(BaseModel):
    """An action item from an email."""

    task: str
    assignee: str = ""


class EmailMetadata(BaseModel):
    """Metadata extracted from email messages."""

    urgency: str  # low, normal, high, critical
    intent: str  # request, fyi, approval, escalation
    action_items: list[ActionItem] = Field(default_factory=list)
    summary_short: str = ""
    summary_medium: str = ""
    summary_long: str = ""
    summary: str = ""
    keywords: list[str] = Field(default_factory=list)


# Prompt template for email metadata extraction
PROMPT = """Analyze this email and extract metadata.

Provide:
- urgency: Urgency level (low, normal, high, or critical)
- intent: Main intent (request, fyi, approval, or escalation)
- action_items: List of action items mentioned with task and assignee if specified
- summary_short: A one-sentence summary of the email
- summary_medium: A 2-3 sentence summary of the email
- summary_long: A detailed paragraph summary of the email
- summary: Same content as summary_medium for backward compatibility
- keywords: List of important keywords (people, projects, requests, deadlines)

Email:
{text}

Respond with valid JSON matching this schema: {schema}"""
