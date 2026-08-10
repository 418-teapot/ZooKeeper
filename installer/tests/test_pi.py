"""Tests for installer.pi: pi models.json configuration generation."""

from __future__ import annotations

from installer.pi import (
    _convert_provider_to_pi,
    _npm_to_api_type,
    build_pi_models_config,
)


def _anthropic_provider() -> dict:
    """A provider using @ai-sdk/anthropic with a /v1 base URL."""
    return {
        "npm": "@ai-sdk/anthropic",
        "options": {
            "baseURL": "https://api.example.com/v1",
            "apiKey": "test-key",
            "headers": {"x-project": "personal"},
        },
        "models": {
            "glm-5.2": {
                "id": "glm-5.2",
                "name": "glm-5.2",
                "reasoning": True,
                "limit": {"context": 200000, "output": 128000},
                "cost": {
                    "input": 6.8,
                    "output": 23.8,
                    "cache_read": 0.6,
                    "cache_write": 7.5,
                },
            }
        },
    }


# ── _npm_to_api_type ─────────────────────────────────────────────────────


def test_npm_to_api_type_anthropic() -> None:
    """Anthropic npm packages map to anthropic-messages (case-insensitive)."""
    assert _npm_to_api_type("@ai-sdk/anthropic") == "anthropic-messages"
    assert _npm_to_api_type("@AI-SDK/Anthropic") == "anthropic-messages"


def test_npm_to_api_type_openai() -> None:
    """OpenAI npm packages map to openai-completions."""
    assert (
        _npm_to_api_type("@ai-sdk/openai-compatible") == "openai-completions"
    )


def test_npm_to_api_type_unknown() -> None:
    """Unrecognised npm packages map to None."""
    assert _npm_to_api_type("@ai-sdk/unknown") is None


# ── _convert_provider_to_pi ──────────────────────────────────────────────


def test_convert_provider_strips_v1_for_anthropic() -> None:
    """anthropic-messages baseUrl drops the trailing /v1 suffix."""
    result = _convert_provider_to_pi("Aliyun", _anthropic_provider())
    assert result is not None
    assert result["baseUrl"] == "https://api.example.com"
    assert result["api"] == "anthropic-messages"
    assert result["apiKey"] == "test-key"
    assert result["headers"] == {"x-project": "personal"}
    model = result["models"][0]
    assert model["id"] == "glm-5.2"
    assert model["name"] == "glm-5.2"
    assert model["reasoning"] is True
    assert model["contextWindow"] == 200000
    assert model["maxTokens"] == 128000
    assert model["cost"] == {
        "input": 6.8,
        "output": 23.8,
        "cacheRead": 0.6,
        "cacheWrite": 7.5,
    }


def test_convert_provider_keeps_v1_for_openai() -> None:
    """openai-completions baseUrl keeps the /v1 suffix."""
    provider = {
        "npm": "@ai-sdk/openai-compatible",
        "options": {"baseURL": "https://api.openai.com/v1", "apiKey": "k"},
        "models": {"gpt-5.5": {"name": "gpt-5.5"}},
    }
    result = _convert_provider_to_pi("OpenAI", provider)
    assert result is not None
    assert result["baseUrl"] == "https://api.openai.com/v1"
    assert result["api"] == "openai-completions"
    model = result["models"][0]
    assert "reasoning" not in model
    assert "contextWindow" not in model
    assert "maxTokens" not in model
    assert "cost" not in model


def test_convert_provider_cost_four_fields_defaulted() -> None:
    """Missing cost fields default to 0 with snake_case renamed to camelCase."""
    provider = {
        "npm": "@ai-sdk/anthropic",
        "options": {"baseURL": "https://api.example.com"},
        "models": {"m": {"cost": {"input": 1}}},
    }
    result = _convert_provider_to_pi("P", provider)
    assert result is not None
    assert result["models"][0]["cost"] == {
        "input": 1,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
    }


def test_convert_provider_reasoning_only_when_true() -> None:
    """reasoning is emitted only when explicitly true."""
    provider = {
        "npm": "@ai-sdk/anthropic",
        "options": {"baseURL": "https://api.example.com"},
        "models": {"a": {"reasoning": False}, "b": {}},
    }
    result = _convert_provider_to_pi("P", provider)
    assert result is not None
    assert "reasoning" not in result["models"][0]
    assert "reasoning" not in result["models"][1]


def test_convert_provider_missing_npm_skipped(capsys) -> None:
    """A provider whose npm field is not a string is skipped with a warning."""
    assert _convert_provider_to_pi("bad", {"npm": 42}) is None
    assert "缺少 npm 字段" in capsys.readouterr().out


def test_convert_provider_empty_npm_skipped(capsys) -> None:
    """A provider without an npm field falls through to the unknown type."""
    assert _convert_provider_to_pi("bad", {"options": {}}) is None
    assert "npm 类型无法识别" in capsys.readouterr().out


def test_convert_provider_unknown_npm_skipped(capsys) -> None:
    """A provider with an unrecognised npm type is skipped with a warning."""
    assert _convert_provider_to_pi("bad", {"npm": "@ai-sdk/weird"}) is None
    assert "npm 类型无法识别" in capsys.readouterr().out


def test_convert_provider_handles_non_dict_options_and_models() -> None:
    """Non-dict options/models degrade to empty defaults."""
    provider = {
        "npm": "@ai-sdk/anthropic",
        "options": "oops",
        "models": "oops",
    }
    result = _convert_provider_to_pi("P", provider)
    assert result is not None
    assert result["baseUrl"] == ""
    assert result["models"] == []


# ── build_pi_models_config ───────────────────────────────────────────────


def test_build_pi_models_config_resolves_env_refs() -> None:
    """{env:VAR} refs resolve before conversion (including /v1 stripping)."""
    toml_data = {
        "provider": {
            "Aliyun": {
                "npm": "@ai-sdk/anthropic",
                "options": {
                    "baseURL": "{env:CAMBRICON_BASE_URL}",
                    "apiKey": "{env:CAMBRICON_API_KEY}",
                },
                "models": {"glm-5.2": {"name": "glm-5.2"}},
            }
        }
    }
    env = {
        "CAMBRICON_BASE_URL": "https://api.example.com/v1",
        "CAMBRICON_API_KEY": "secret",
    }
    assert build_pi_models_config(toml_data, env) == {
        "providers": {
            "Aliyun": {
                "baseUrl": "https://api.example.com",
                "api": "anthropic-messages",
                "apiKey": "secret",
                "headers": {},
                "models": [{"id": "glm-5.2", "name": "glm-5.2"}],
            }
        }
    }


def test_build_pi_models_config_non_dict_providers() -> None:
    """A missing or non-dict provider section yields an empty providers map."""
    assert build_pi_models_config({}, {}) == {"providers": {}}
    assert build_pi_models_config({"provider": "nope"}, {}) == {
        "providers": {}
    }
