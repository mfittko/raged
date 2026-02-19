"""Meeting notes metadata extraction schema."""

from pydantic import BaseModel, Field


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

    summary_short: str = ""
    summary_medium: str = ""
    summary_long: str = ""
    summary: str = ""
    keywords: list[str] = Field(default_factory=list)
    decisions: list[str] = Field(default_factory=list)
    action_items: list[ActionItem] = Field(default_factory=list)
    topic_segments: list[TopicSegment] = Field(default_factory=list)


# Prompt template for meeting metadata extraction
PROMPT = """Analyze these meeting notes and extract metadata.

Provide:
- summary_short: A one-sentence summary of the meeting
- summary_medium: A 2-3 sentence summary of the meeting
- summary_long: A detailed paragraph summary of the meeting
- summary: Same content as summary_medium for backward compatibility
- keywords: List of important keywords from the meeting
- decisions: List of decisions made in the meeting
- action_items: List of action items with task, assignee, and deadline (if mentioned)
- topic_segments: List of topics discussed with a summary for each

Meeting notes:
{text}

Respond with valid JSON matching this schema: {schema}"""
