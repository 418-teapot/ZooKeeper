"""Tests for installer.envfile: .env parsing and {env:VAR} resolution."""

from __future__ import annotations

import pytest

from installer.envfile import (
    _filter_missing_entries,
    parse_env_file,
    resolve_env_refs_deep,
)

# ── parse_env_file ───────────────────────────────────────────────────────


def test_parse_env_file_quotes_stripped_duplicates_keep_first(
    tmp_path, capsys
) -> None:
    """Quoted values are stripped; invalid lines and empty keys are skipped."""
    env_path = tmp_path / ".env"
    env_path.write_text(
        "\n".join(
            [
                'QUOTED="hello world"',
                "SINGLE='single value'",
                "INVALID LINE NO EQUALS",
                "=no-name",
                "EMPTY_KEY=",
                "DUP=first",
                "DUP=second",
                "# comment",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    env = parse_env_file(str(env_path))
    assert env == {
        "QUOTED": "hello world",
        "SINGLE": "single value",
        "EMPTY_KEY": "",
        "DUP": "first",
    }
    out = capsys.readouterr().out
    assert "忽略无效行" in out
    assert "忽略空键名" in out


def test_parse_env_file_missing_file_returns_empty() -> None:
    """A missing .env file yields an empty dict without error."""
    assert parse_env_file("/nonexistent/.env") == {}


# ── resolve_env_refs_deep ────────────────────────────────────────────────


def test_resolve_env_refs_deep_whole_placeholder() -> None:
    """A standalone {env:VAR} is replaced by the raw env value."""
    assert resolve_env_refs_deep("{env:FOO}", {"FOO": "bar"}) == "bar"


def test_resolve_env_refs_deep_embedded_placeholder() -> None:
    """An embedded {env:VAR} is substituted inside the surrounding text."""
    assert resolve_env_refs_deep("Token {env:FOO}", {"FOO": "abc"}) == (
        "Token abc"
    )


def test_resolve_env_refs_deep_nested_structures() -> None:
    """Dicts and lists are walked recursively; primitives pass through."""
    obj = {
        "a": ["{env:FOO}", 42, {"b": "x-{env:BAR}"}],
        "c": "{env:FOO}-{env:BAR}",
    }
    env = {"FOO": "f", "BAR": "b"}
    assert resolve_env_refs_deep(obj, env) == {
        "a": ["f", 42, {"b": "x-b"}],
        "c": "f-b",
    }


def test_resolve_env_refs_deep_missing_var_exits(capsys) -> None:
    """A missing variable prints an error and raises SystemExit."""
    with pytest.raises(SystemExit):
        resolve_env_refs_deep("{env:NOPE}", {})
    assert "变量 NOPE 未在 .env 中设置" in capsys.readouterr().err


def test_resolve_env_refs_deep_no_refs_untouched() -> None:
    """Strings without placeholders and non-container values are unchanged."""
    assert resolve_env_refs_deep("plain", {}) == "plain"
    assert resolve_env_refs_deep(42, {}) == 42


# ── _filter_missing_entries ──────────────────────────────────────────────


def _providers() -> dict:
    """Two providers, one with a missing credential env var."""
    return {
        "good": {"options": {"apiKey": "plain"}},
        "bad": {"options": {"apiKey": "{env:FOO}"}},
        "bare": {"apiKey": "plain"},
    }


def test_filter_missing_entries_with_scope_key(capsys) -> None:
    """Entries are scanned only inside the ``options`` sub-dict."""
    toml_data = {"provider": _providers()}
    _filter_missing_entries(
        toml_data, "provider", "provider", {}, scope_key="options"
    )
    assert set(toml_data["provider"]) == {"good", "bare"}
    assert "provider bad 的环境变量未配置" in capsys.readouterr().out


def test_filter_missing_entries_without_scope_key(capsys) -> None:
    """Without a scope key the whole entry dict is scanned."""
    toml_data = {
        "mcp": {
            "ok": {"url": "https://x"},
            "miss": {"url": "https://x/{env:TOKEN}"},
            "notext": "not-a-dict",
        }
    }
    _filter_missing_entries(toml_data, "mcp", "MCP 服务器", {})
    assert set(toml_data["mcp"]) == {"ok", "notext"}
    assert "MCP 服务器 miss 的环境变量未配置" in capsys.readouterr().out


def test_filter_missing_entries_missing_section_noop() -> None:
    """A missing section leaves the dict untouched."""
    data = {}
    _filter_missing_entries(data, "provider", "provider", {})
    assert data == {}


def test_filter_missing_entries_non_dict_section_noop() -> None:
    """A non-dict section leaves the dict untouched."""
    data = {"provider": "not-a-dict"}
    _filter_missing_entries(data, "provider", "provider", {})
    assert data == {"provider": "not-a-dict"}
