"""Tests for Neo4j graph operations."""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from src.graph import (
    upsert_entity,
    upsert_document,
    add_mention,
    add_relationship,
    get_entity_neighborhood,
    get_entity,
    search_entities,
)


@pytest.fixture
def mock_driver():
    """Create a mock Neo4j driver."""
    driver = MagicMock()
    session = MagicMock()
    session.run = AsyncMock()
    driver.session.return_value.__aenter__ = AsyncMock(return_value=session)
    driver.session.return_value.__aexit__ = AsyncMock(return_value=None)
    return driver, session


@pytest.mark.asyncio
async def test_upsert_entity(mock_driver):
    """Test entity upsert operation."""
    driver, session = mock_driver

    with patch("src.graph.get_driver", return_value=driver):
        await upsert_entity("TestClass", "class", "A test class")

        # Verify the query was called
        assert session.run.called
        call_args = session.run.call_args
        assert "MERGE" in call_args[0][0]
        assert "Entity" in call_args[0][0]


@pytest.mark.asyncio
async def test_upsert_document(mock_driver):
    """Test document upsert operation."""
    driver, session = mock_driver

    with patch("src.graph.get_driver", return_value=driver):
        await upsert_document("doc-123", "code", "src/test.py", "docs", "Test file")

        # Verify the query was called
        assert session.run.called
        call_args = session.run.call_args
        assert "MERGE" in call_args[0][0]
        assert "Document" in call_args[0][0]


@pytest.mark.asyncio
async def test_add_mention(mock_driver):
    """Test adding a MENTIONS relationship."""
    driver, session = mock_driver

    with patch("src.graph.get_driver", return_value=driver):
        await add_mention("doc-123", "TestClass")

        # Verify the query was called
        assert session.run.called
        call_args = session.run.call_args
        assert "MENTIONS" in call_args[0][0]


@pytest.mark.asyncio
async def test_add_relationship(mock_driver):
    """Test adding a RELATES_TO relationship."""
    driver, session = mock_driver

    with patch("src.graph.get_driver", return_value=driver):
        await add_relationship("ClassA", "ClassB", "uses", "ClassA uses ClassB")

        # Verify the query was called
        assert session.run.called
        call_args = session.run.call_args
        assert "RELATES_TO" in call_args[0][0]


@pytest.mark.asyncio
async def test_get_entity_neighborhood(mock_driver):
    """Test getting entity neighborhood."""
    driver, session = mock_driver

    # Mock the query result
    mock_record = {
        "e": MagicMock(
            get=lambda k, d=None: {
                "name": "TestClass",
                "type": "class",
                "description": "Test",
                "mentionCount": 5,
            }.get(k, d)
        ),
        "connections": [
            MagicMock(
                get=lambda k, d=None: {"name": "OtherClass", "type": "class"}.get(k, d)
            )
        ],
        "documents": [
            MagicMock(
                get=lambda k, d=None: {
                    "id": "doc-1",
                    "docType": "code",
                    "source": "test.py",
                }.get(k, d)
            )
        ],
    }

    mock_result = AsyncMock()
    mock_result.single = AsyncMock(return_value=mock_record)
    session.run = AsyncMock(return_value=mock_result)

    with patch("src.graph.get_driver", return_value=driver):
        result = await get_entity_neighborhood("TestClass", depth=2)

        assert result["entity"] is not None
        assert result["entity"]["name"] == "TestClass"
        assert len(result["connections"]) > 0
        assert len(result["documents"]) > 0


@pytest.mark.asyncio
async def test_get_entity_neighborhood_not_found(mock_driver):
    """Test getting neighborhood for non-existent entity."""
    driver, session = mock_driver

    mock_result = AsyncMock()
    mock_result.single = AsyncMock(return_value=None)
    session.run = AsyncMock(return_value=mock_result)

    with patch("src.graph.get_driver", return_value=driver):
        result = await get_entity_neighborhood("NonExistent")

        assert result["entity"] is None
        assert result["connections"] == []
        assert result["documents"] == []


@pytest.mark.asyncio
async def test_get_entity(mock_driver):
    """Test getting a single entity."""
    driver, session = mock_driver

    mock_entity = MagicMock()
    mock_entity.get.side_effect = lambda k, d=None: {
        "name": "TestClass",
        "type": "class",
        "description": "Test",
        "mentionCount": 3,
    }.get(k, d)

    mock_record = {"e": mock_entity}
    mock_result = AsyncMock()
    mock_result.single = AsyncMock(return_value=mock_record)
    session.run = AsyncMock(return_value=mock_result)

    with patch("src.graph.get_driver", return_value=driver):
        entity = await get_entity("TestClass")

        assert entity is not None
        assert entity["name"] == "TestClass"
        assert entity["type"] == "class"


@pytest.mark.asyncio
async def test_get_entity_not_found(mock_driver):
    """Test getting a non-existent entity."""
    driver, session = mock_driver

    mock_result = AsyncMock()
    mock_result.single = AsyncMock(return_value=None)
    session.run = AsyncMock(return_value=mock_result)

    with patch("src.graph.get_driver", return_value=driver):
        entity = await get_entity("NonExistent")

        assert entity is None


@pytest.mark.asyncio
async def test_search_entities(mock_driver):
    """Test entity search."""
    driver, session = mock_driver

    mock_entities = [
        MagicMock(
            get=lambda k, d=None, i=i: {
                "name": f"Entity{i}",
                "type": "class",
                "description": "Test",
                "mentionCount": 5 - i,
            }.get(k, d)
        )
        for i in range(3)
    ]

    async def mock_iter(self):
        for entity in mock_entities:
            yield {"e": entity}

    mock_result = MagicMock()
    mock_result.__aiter__ = mock_iter
    session.run = AsyncMock(return_value=mock_result)

    with patch("src.graph.get_driver", return_value=driver):
        results = await search_entities("Entity", limit=10)

        assert len(results) == 3
        assert all("name" in r for r in results)
