"""Slack message metadata extraction schema."""

from pydantic import BaseModel, Field


class ActionItem(BaseModel):
    """An action item from a Slack conversation."""

    task: str
    assignee: str = ""


class SlackMetadata(BaseModel):
    """Metadata extracted from Slack messages."""

    summary_short: str = ""
    summary_medium: str = ""
    summary_long: str = ""
    summary: str = ""
    keywords: list[str] = Field(default_factory=list)
    decisions: list[str] = Field(default_factory=list)
    action_items: list[ActionItem] = Field(default_factory=list)
    sentiment: str  # positive, neutral, negative


# Prompt template for Slack metadata extraction
PROMPT = """Analyze this Slack conversation and extract metadata.

Provide:
- summary_short: A one-sentence summary of the conversation
- summary_medium: A 2-3 sentence summary of the conversation
- summary_long: A detailed paragraph summary of the conversation
- summary: Same content as summary_medium for backward compatibility
- keywords: List of important keywords for the conversation
- decisions: List of decisions made in the conversation
- action_items: List of action items with task and assignee (if mentioned)
- sentiment: Overall sentiment of the conversation (positive, neutral, or negative)

Slack conversation:
{text}

Respond with valid JSON matching this schema: {schema}"""
