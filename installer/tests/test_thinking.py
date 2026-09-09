"""Tests for installer.thinking: shared validation of the model ``thinking`` field."""

from __future__ import annotations

from installer.thinking import thinking_level, validate_thinking


def _toml(model_entry: dict, npm: str = "@ai-sdk/anthropic") -> dict:
    """Build a minimal TOML map with one provider and one model table."""
    return {"provider": {"P": {"npm": npm, "models": {"m": model_entry}}}}


# ── validate_thinking ────────────────────────────────────────────────────


def test_validate_thinking_accepts_known_levels(capsys) -> None:
    """high / max / none produce no warning."""
    for level in ("high", "max", "none"):
        validate_thinking(_toml({"thinking": level}))
    assert capsys.readouterr().out == ""


def test_validate_thinking_ignores_absent_field(capsys) -> None:
    """A model without a thinking field is not checked."""
    validate_thinking(_toml({"reasoning": True}))
    assert capsys.readouterr().out == ""


def test_validate_thinking_reports_unknown_level(capsys) -> None:
    """An unknown level is reported with the model path and allowed values."""
    validate_thinking(_toml({"thinking": "ultra"}))
    out = capsys.readouterr().out
    assert "provider.P.models.m" in out
    assert "取值无效" in out
    assert "ultra" in out


def test_validate_thinking_reports_non_string_level(capsys) -> None:
    """A non-string level is reported as such."""
    validate_thinking(_toml({"thinking": True}))
    out = capsys.readouterr().out
    assert "必须为字符串" in out


def test_validate_thinking_reports_every_bad_model(capsys) -> None:
    """Each offending model produces its own warning."""
    toml_data = {
        "provider": {
            "P": {
                "npm": "@ai-sdk/anthropic",
                "models": {"a": {"thinking": "low"}, "b": {"thinking": 3}},
            },
            "Q": {
                "npm": "@ai-sdk/openai",
                "models": {"c": {"thinking": "high"}},
            },
        }
    }
    validate_thinking(toml_data)
    out = capsys.readouterr().out
    assert "provider.P.models.a" in out
    assert "provider.P.models.b" in out
    assert "provider.Q.models.c" not in out


def test_validate_thinking_tolerates_malformed_sections(capsys) -> None:
    """Non-dict provider/model tables are skipped without crashing."""
    validate_thinking({})
    validate_thinking({"provider": "oops"})
    validate_thinking({"provider": {"P": {"models": "oops"}}})
    validate_thinking({"provider": {"P": {"models": {"m": "oops"}}}})
    assert capsys.readouterr().out == ""


# ── thinking_level ───────────────────────────────────────────────────────


def test_thinking_level_returns_requested_levels() -> None:
    """high and max are returned unchanged."""
    assert thinking_level({"thinking": "high"}) == "high"
    assert thinking_level({"thinking": "max"}) == "max"


def test_thinking_level_none_and_invalid_degrade() -> None:
    """Absent, ``none`` and invalid values all mean "inject nothing"."""
    assert thinking_level({}) is None
    assert thinking_level({"thinking": "none"}) is None
    assert thinking_level({"thinking": "ultra"}) is None
    assert thinking_level({"thinking": True}) is None
