"""Config-hardening tests: AI credential/env cleaning (no network, no secrets).

On hosts like Railway the AI_* settings are real OS environment variables, so a
value pasted with surrounding quotes or stray whitespace is sent to the provider
verbatim and rejected (HTTP 401) even when the key itself is correct. The
Settings validator strips that noise; these tests pin that behaviour.
"""
from __future__ import annotations

from app.config import Settings


def test_ai_env_strips_surrounding_quotes_and_whitespace():
    s = Settings(
        ai_api_key='  "sk-live-abc123"  ',
        ai_base_url=" 'https://api.anthropic.com/v1' ",
        ai_model=" claude-sonnet-4 ",
        ai_api_style=" anthropic ",
    )
    assert s.ai_api_key == "sk-live-abc123"
    assert s.ai_base_url == "https://api.anthropic.com/v1"
    assert s.ai_model == "claude-sonnet-4"
    assert s.ai_api_style == "anthropic"


def test_ai_env_strips_single_quotes_too():
    s = Settings(ai_api_key="'sk-openai-xyz'")
    assert s.ai_api_key == "sk-openai-xyz"


def test_ai_env_leaves_a_clean_key_untouched():
    # A correct key with no quotes/whitespace must be passed through unchanged
    # (we only strip noise, never mutate the credential characters).
    s = Settings(ai_api_key="sk-live-abc123")
    assert s.ai_api_key == "sk-live-abc123"


def test_ai_env_keeps_internal_characters():
    # Quotes only stripped when they wrap the WHOLE value, not mid-string.
    s = Settings(ai_model='gpt-4o-"mini"')
    assert s.ai_model == 'gpt-4o-"mini"'
