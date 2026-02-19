"""Tests for worker configuration resolution."""

import importlib

import pytest


@pytest.fixture
def reloaded_config(monkeypatch):
    """Reload src.config after applying environment changes."""

    def _reload(**env_vars: str | None):
        keys = {
            "EXTRACTOR_PROVIDER",
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
        }

        for key in keys:
            monkeypatch.delenv(key, raising=False)

        for key, value in env_vars.items():
            if value is None:
                monkeypatch.delenv(key, raising=False)
            else:
                monkeypatch.setenv(key, value)

        import src.config

        return importlib.reload(src.config)

    return _reload


def test_provider_defaults_to_ollama(reloaded_config):
    """Provider defaults to ollama when no keys are set."""
    config = reloaded_config()
    assert config.EXTRACTOR_PROVIDER == "ollama"


def test_provider_auto_uses_openai_key(reloaded_config):
    """Auto provider selects OpenAI when key is present."""
    config = reloaded_config(OPENAI_API_KEY="test-key")
    assert config.EXTRACTOR_PROVIDER == "openai"


def test_provider_auto_uses_anthropic_when_openai_missing(reloaded_config):
    """Auto provider selects Anthropic when only Anthropic key is present."""
    config = reloaded_config(ANTHROPIC_API_KEY="anthropic-key")
    assert config.EXTRACTOR_PROVIDER == "anthropic"


def test_provider_explicit_ollama_takes_precedence(reloaded_config):
    """Explicit EXTRACTOR_PROVIDER setting overrides key-based auto selection."""
    config = reloaded_config(EXTRACTOR_PROVIDER="ollama", OPENAI_API_KEY="test-key")
    assert config.EXTRACTOR_PROVIDER == "ollama"


def test_provider_invalid_value_raises(reloaded_config):
    """Invalid provider names fail fast with clear error."""
    with pytest.raises(ValueError, match="Invalid EXTRACTOR_PROVIDER"):
        reloaded_config(EXTRACTOR_PROVIDER="invalid-provider")
