"""Tests for installer.pi: pi models.json/agents.json/settings configuration."""

from __future__ import annotations

import json

from installer.jsonio import write_json
from installer.pi import (
    _convert_provider_to_pi,
    _npm_to_api_type,
    build_pi_agents_config,
    build_pi_models_config,
    build_pi_settings,
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
            "dummy-small": {
                "id": "dummy-small",
                "name": "dummy-small",
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
    result = _convert_provider_to_pi("Dummy", _anthropic_provider())
    assert result is not None
    assert result["baseUrl"] == "https://api.example.com"
    assert result["api"] == "anthropic-messages"
    assert result["apiKey"] == "test-key"
    assert result["headers"] == {"x-project": "personal"}
    model = result["models"][0]
    assert model["id"] == "dummy-small"
    assert model["name"] == "dummy-small"
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
            "Dummy": {
                "npm": "@ai-sdk/anthropic",
                "options": {
                    "baseURL": "{env:CAMBRICON_BASE_URL}",
                    "apiKey": "{env:CAMBRICON_API_KEY}",
                },
                "models": {"dummy-small": {"name": "dummy-small"}},
            }
        }
    }
    env = {
        "CAMBRICON_BASE_URL": "https://api.example.com/v1",
        "CAMBRICON_API_KEY": "secret",
    }
    assert build_pi_models_config(toml_data, env) == {
        "providers": {
            "Dummy": {
                "baseUrl": "https://api.example.com",
                "api": "anthropic-messages",
                "apiKey": "secret",
                "headers": {},
                "models": [{"id": "dummy-small", "name": "dummy-small"}],
            }
        }
    }


def test_build_pi_models_config_non_dict_providers() -> None:
    """A missing or non-dict provider section yields an empty providers map."""
    assert build_pi_models_config({}, {}) == {"providers": {}}
    assert build_pi_models_config({"provider": "nope"}, {}) == {
        "providers": {}
    }


# ── build_pi_settings ─────────────────────────────────────────────────


def test_build_pi_settings_env_ref_split() -> None:
    """{env:VAR} default-model refs split into defaultProvider/defaultModel."""
    settings = build_pi_settings(
        "/abs/src/pi.ts",
        "{env:ZOO_WHALE_MODEL}",
        {"ZOO_WHALE_MODEL": "Dummy/dummy-small"},
        ["Dummy"],
    )
    assert settings == {
        "extensions": ["/abs/src/pi.ts"],
        "defaultThinkingLevel": "high",
        "defaultProvider": "Dummy",
        "defaultModel": "dummy-small",
    }


def test_build_pi_settings_plain_string_split() -> None:
    """A hardcoded (non-placeholder) default model still splits."""
    settings = build_pi_settings(
        "/abs/src/pi.ts", "Dummy/dummy-small", {}, ["Dummy"]
    )
    assert settings == {
        "extensions": ["/abs/src/pi.ts"],
        "defaultThinkingLevel": "high",
        "defaultProvider": "Dummy",
        "defaultModel": "dummy-small",
    }


def test_build_pi_settings_missing_env_only_extensions(capsys) -> None:
    """A missing env var degrades to extensions-only with a warning."""
    settings = build_pi_settings(
        "/abs/src/pi.ts", "{env:ZOO_WHALE_MODEL}", {}, []
    )
    assert settings == {
        "extensions": ["/abs/src/pi.ts"],
        "defaultThinkingLevel": "high",
    }
    assert "defaultProvider" not in settings
    assert "defaultModel" not in settings
    assert "环境变量" in capsys.readouterr().out


def test_build_pi_settings_missing_defaults_section(capsys) -> None:
    """A missing [defaults].model degrades to extensions-only with a warning."""
    settings = build_pi_settings(
        "/abs/src/pi.ts", None, {"ZOO_WHALE_MODEL": "x"}, []
    )
    assert settings == {
        "extensions": ["/abs/src/pi.ts"],
        "defaultThinkingLevel": "high",
    }
    assert "defaultProvider" not in settings
    assert "环境变量" in capsys.readouterr().out


def test_build_pi_settings_empty_env_value(capsys) -> None:
    """An empty resolved value degrades to extensions-only with a warning."""
    settings = build_pi_settings(
        "/abs/src/pi.ts", "{env:ZOO_WHALE_MODEL}", {"ZOO_WHALE_MODEL": ""}, []
    )
    assert settings == {
        "extensions": ["/abs/src/pi.ts"],
        "defaultThinkingLevel": "high",
    }
    assert "defaultProvider" not in settings
    assert "为空" in capsys.readouterr().out


def test_build_pi_settings_no_slash(capsys) -> None:
    """A value without '/' degrades to extensions-only with a warning."""
    settings = build_pi_settings(
        "/abs/src/pi.ts",
        "{env:ZOO_WHALE_MODEL}",
        {"ZOO_WHALE_MODEL": "dummy-small"},
        [],
    )
    assert settings == {
        "extensions": ["/abs/src/pi.ts"],
        "defaultThinkingLevel": "high",
    }
    assert "defaultProvider" not in settings
    assert "分隔" in capsys.readouterr().out


def test_build_pi_settings_pruned_provider_still_writes(capsys) -> None:
    """A provider absent from this run's providers warns but still writes."""
    settings = build_pi_settings(
        "/abs/src/pi.ts",
        "{env:ZOO_WHALE_MODEL}",
        {"ZOO_WHALE_MODEL": "Foo/bar"},
        ["Dummy"],
    )
    assert settings == {
        "extensions": ["/abs/src/pi.ts"],
        "defaultThinkingLevel": "high",
        "defaultProvider": "Foo",
        "defaultModel": "bar",
    }
    assert "Foo" in capsys.readouterr().out


# ── build_pi_agents_config ──────────────────────────────────────────────


def _agent_toml() -> dict:
    """A minimal TOML map: providers plus ``[agent.*]`` model references."""
    return {
        "provider": {
            "Dummy": {
                "models": {
                    "dummy-large": {
                        "id": "dummy-large",
                        "name": "dummy-large",
                    },
                    "dummy-small": {
                        "id": "dummy-small",
                        "name": "dummy-small",
                    },
                    # Table key differs from the registry id.
                    "renamed-key": {"id": "dummy-renamed"},
                    # No id field → falls back to the table key itself.
                    "fallback-model": {"name": "fallback-model"},
                    # id present but not a string → fail-closed.
                    "bad-id": {"id": 42},
                }
            },
            "StaticProvider": {
                "models": {"static-model": {"id": "static-model"}},
            },
        },
        "agent": {
            "dolphin": {"model": "{env:ZOO_WHALE_MODEL}"},
            "beaver": {"model": "{env:ZOO_ANT_MODEL}"},
            "plain": {"model": "StaticProvider/static-model"},
            "nolabel": {"color": "#FF0000"},
            "disabled": {"disable": True},
        },
    }


def test_build_pi_agents_config_resolves_all_models(capsys) -> None:
    """Placeholders resolve to provider + registry model id (not env value)."""
    env = {
        "ZOO_WHALE_MODEL": "Dummy/dummy-large",
        "ZOO_ANT_MODEL": "Dummy/dummy-small",
    }
    result = build_pi_agents_config(_agent_toml(), env)
    assert result == {
        "agents": {
            "dolphin": {"provider": "Dummy", "model": "dummy-large"},
            "beaver": {"provider": "Dummy", "model": "dummy-small"},
            "plain": {"provider": "StaticProvider", "model": "static-model"},
        }
    }
    # A plain literal model emits no warning.
    assert capsys.readouterr().out == ""


def test_build_pi_agents_config_uses_registry_id(capsys) -> None:
    """The model id comes from the provider table's id field, not the key."""
    toml_data = {
        "provider": {
            "Dummy": {
                "models": {"dummy-prefixed": {"id": "dummy/prefixed-id"}}
            }
        },
        "agent": {"beaver": {"model": "Dummy/dummy-prefixed"}},
    }
    result = build_pi_agents_config(toml_data, {})
    assert result == {
        "agents": {
            "beaver": {"provider": "Dummy", "model": "dummy/prefixed-id"}
        }
    }
    assert capsys.readouterr().out == ""


def test_build_pi_agents_config_missing_id_falls_back_to_key(capsys) -> None:
    """A model table without an id field falls back to the table key."""
    result = build_pi_agents_config(
        {"agent": {"plain": {"model": "Dummy/fallback-model"}}}
        | {
            "provider": {
                "Dummy": {"models": {"fallback-model": {"name": "x"}}}
            }
        },
        {},
    )
    assert result == {
        "agents": {"plain": {"provider": "Dummy", "model": "fallback-model"}}
    }
    assert capsys.readouterr().out == ""


def test_build_pi_agents_config_missing_provider_omits_agent(capsys) -> None:
    """A provider absent from [provider] omits the agent (fail-closed)."""
    toml_data = {
        "provider": {"Dummy": {"models": {"m": {"id": "m"}}}},
        "agent": {
            "dolphin": {"model": "Missing/m"},
            "beaver": {"model": "Dummy/m"},
        },
    }
    result = build_pi_agents_config(toml_data, {})
    assert "dolphin" not in result["agents"]
    assert "beaver" in result["agents"]
    assert "Missing" in capsys.readouterr().out


def test_build_pi_agents_config_missing_model_key_omits_agent(capsys) -> None:
    """A model key absent from the provider's models omits the agent."""
    toml_data = {
        "provider": {"Dummy": {"models": {"m": {"id": "m"}}}},
        "agent": {"dolphin": {"model": "Dummy/ghost"}},
    }
    result = build_pi_agents_config(toml_data, {})
    assert "dolphin" not in result["agents"]
    assert "ghost" in capsys.readouterr().out


def test_build_pi_agents_config_non_string_id_omits_agent(capsys) -> None:
    """A non-string id field omits the agent (fail-closed)."""
    result = build_pi_agents_config(
        {"agent": {"plain": {"model": "Dummy/bad-id"}}}
        | {"provider": {"Dummy": {"models": {"bad-id": {"id": 42}}}}},
        {},
    )
    assert "plain" not in result["agents"]
    assert "不是字符串" in capsys.readouterr().out


def test_build_pi_agents_config_missing_env_omits_agent(capsys) -> None:
    """An agent whose {env:VAR} model var is unset is omitted (fail-closed)."""
    result = build_pi_agents_config(_agent_toml(), {})
    assert result == {
        "agents": {
            "plain": {"provider": "StaticProvider", "model": "static-model"},
        }
    }
    assert "dolphin" not in result["agents"]
    assert "beaver" not in result["agents"]
    out = capsys.readouterr().out
    assert "dolphin" in out and "beaver" in out
    assert "model" in out


def test_build_pi_agents_config_missing_model_omits_agent() -> None:
    """An agent with no model field is omitted entirely."""
    result = build_pi_agents_config(_agent_toml(), {"ZOO_WHALE_MODEL": "x"})
    assert "nolabel" not in result["agents"]
    assert "disabled" not in result["agents"]
    assert "plain" in result["agents"]


def test_build_pi_agents_config_non_dict_section() -> None:
    """A missing or non-dict agent section yields an empty agents map."""
    assert build_pi_agents_config({}, {}) == {"agents": {}}
    assert build_pi_agents_config({"agent": "nope"}, {}) == {"agents": {}}
    assert build_pi_agents_config({"agent": {"bad": 42}}, {}) == {"agents": {}}


def test_build_pi_agents_config_empty_env_value_omits_agent(capsys) -> None:
    """An empty resolved model value omits the agent with a warning."""
    result = build_pi_agents_config(
        _agent_toml(),
        {"ZOO_WHALE_MODEL": "", "ZOO_ANT_MODEL": "Dummy/dummy-small"},
    )
    assert "dolphin" not in result["agents"]
    assert "beaver" in result["agents"]
    assert "为空" in capsys.readouterr().out


def test_build_pi_agents_config_invalid_model_omits_agent(capsys) -> None:
    """A resolved value lacking '/' omits the agent with a warning."""
    result = build_pi_agents_config(
        _agent_toml(),
        {
            "ZOO_WHALE_MODEL": "no-slash",
            "ZOO_ANT_MODEL": "Dummy/dummy-small",
        },
    )
    assert "dolphin" not in result["agents"]
    assert "beaver" in result["agents"]
    assert "分隔" in capsys.readouterr().out


# ── Full-rebuild semantics on disk ──────────────────────────────────────


def test_build_pi_agents_config_rebuilds_and_overwrites(tmp_path) -> None:
    """A stale agents.json from a prior run is fully overwritten."""
    agents_path = tmp_path / "agents.json"
    stale = {
        "agents": {
            "dolphin": {"model": "OldProvider/old"},
            "retired": {"model": "RetiredProvider/retired"},
        },
        "extra": {"dolphin": "shape"},
    }
    write_json(str(agents_path), stale)

    env = {"ZOO_WHALE_MODEL": "Dummy/dummy-large"}
    write_json(str(agents_path), build_pi_agents_config(_agent_toml(), env))

    with open(agents_path, encoding="utf-8") as f:
        emitted = json.load(f)
    # The stale "retired" entry and the "extra" key are gone: the file is
    # rebuilt from scratch rather than merged.
    assert emitted == {
        "agents": {
            "dolphin": {"provider": "Dummy", "model": "dummy-large"},
            "plain": {"provider": "StaticProvider", "model": "static-model"},
        }
    }


def test_build_pi_agents_config_rebuilds_even_when_empty(tmp_path) -> None:
    """An agent section with only placeholder models still overwrites."""
    agents_path = tmp_path / "agents.json"
    write_json(str(agents_path), {"agents": {"stale": {"model": "x"}}})

    # No env vars → every placeholder agent is omitted, but the stale
    # entry must not survive either.
    write_json(str(agents_path), build_pi_agents_config(_agent_toml(), {}))

    with open(agents_path, encoding="utf-8") as f:
        emitted = json.load(f)
    assert emitted == {
        "agents": {
            "plain": {"provider": "StaticProvider", "model": "static-model"},
        }
    }


def test_build_pi_agents_config_structure_reserved_shape() -> None:
    """The entry shape is a provider + registry model id pair."""
    result = build_pi_agents_config(
        {
            "provider": {
                "Dummy": {"models": {"dummy-large": {"id": "dummy-large"}}}
            },
            "agent": {"dolphin": {"model": "Dummy/dummy-large"}},
        },
        {},
    )
    assert result["agents"]["dolphin"] == {
        "provider": "Dummy",
        "model": "dummy-large",
    }
