"""Slack message metadata extraction schema."""

from pydantic import BaseModel
from typing import List


class ActionItem(BaseModel):
    """An action item from a Slack conversation."""

    task: str
    assignee: str = ""


class SlackMetadata(BaseModel):
    """Metadata extracted from Slack messages."""

    summary: str
    decisions: List[str] = []
    action_items: List[ActionItem] = []
    sentiment: str  # positive, neutral, negative


# Prompt template for Slack metadata extraction
PROMPT = """Analyze this Slack conversation and extract metadata.

Provide:
- summary: A brief summary of the conversation
- decisions: List of decisions made in the conversation
- action_items: List of action items with task and assignee (if mentioned)
- sentiment: Overall sentiment of the conversation (positive, neutral, or negative)

Slack conversation:
{text}

Respond with valid JSON matching this schema: {schema}"""
