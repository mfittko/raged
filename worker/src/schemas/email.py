"""Email metadata extraction schema."""
from pydantic import BaseModel
from typing import List


class ActionItem(BaseModel):
    """An action item from an email."""
    task: str
    assignee: str = ""


class EmailMetadata(BaseModel):
    """Metadata extracted from email messages."""
    urgency: str  # low, normal, high, critical
    intent: str  # request, fyi, approval, escalation
    action_items: List[ActionItem] = []
    summary: str


# Prompt template for email metadata extraction
PROMPT = """Analyze this email and extract metadata.

Provide:
- urgency: Urgency level (low, normal, high, or critical)
- intent: Main intent (request, fyi, approval, or escalation)
- action_items: List of action items mentioned with task and assignee if specified
- summary: A brief summary of the email

Email:
{text}

Respond with valid JSON matching this schema: {schema}"""
