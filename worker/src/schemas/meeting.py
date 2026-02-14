"""Meeting notes metadata extraction schema."""
from pydantic import BaseModel
from typing import List


class ActionItem(BaseModel):
    """An action item from a meeting."""
    task: str
    assignee: str = ""
    deadline: str = ""


class TopicSegment(BaseModel):
    """A topic discussed in the meeting."""
    topic: str
    summary: str


class MeetingMetadata(BaseModel):
    """Metadata extracted from meeting notes."""
    decisions: List[str] = []
    action_items: List[ActionItem] = []
    topic_segments: List[TopicSegment] = []


# Prompt template for meeting metadata extraction
PROMPT = """Analyze these meeting notes and extract metadata.

Provide:
- decisions: List of decisions made in the meeting
- action_items: List of action items with task, assignee, and deadline (if mentioned)
- topic_segments: List of topics discussed with a summary for each

Meeting notes:
{text}

Respond with valid JSON matching this schema: {schema}"""
