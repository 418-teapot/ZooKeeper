"""Tests for installer.variants: [zoo.variants] collection and validation."""

from __future__ import annotations

from installer.variants import collect_agent_variants, collect_variants


def _base_toml(
    variants: dict,
    providers: dict | None = None,
    agents: dict | None = None,
) -> dict:
    """Build a toml dict with [zoo.variants] plus optional sections."""
    toml_data: dict[str, object] = {"zoo": {"variants": variants}}
    if providers is not None:
        toml_data["provider"] = providers
    if agents is not None:
        toml_data["agent"] = agents
    return toml_data


def _providers() -> dict:
    """Two providers with a couple of models each."""
    return {
        "Cambricon": {"npm": "@ai-sdk/anthropic", "models": {"glm-5.2": {}}},
        "OpenAI": {
            "npm": "@ai-sdk/openai-compatible",
            "models": {"gpt-5.5": {}},
        },
    }


# ── collect_variants ─────────────────────────────────────────────────────


def test_collect_variants_valid_entries() -> None:
    """Valid \"Provider/model\" keys are returned as-is."""
    variants = {"Cambricon/glm-5.2": "high", "OpenAI/gpt-5.5": "max"}
    result = collect_variants(_base_toml(variants, providers=_providers()))
    assert result == variants


def test_collect_variants_invalid_key_format_skipped(capsys) -> None:
    """Keys without Provider/model shape are skipped with a warning."""
    variants = {
        "glm-5.2": "high",
        "/glm-5.2": "high",
        "Cambricon/glm-5.2/extra": "high",
    }
    result = collect_variants(_base_toml(variants, providers=_providers()))
    assert result == {}
    assert "键格式无效" in capsys.readouterr().out


def test_collect_variants_unknown_provider_skipped(capsys) -> None:
    """Keys referencing an undeclared provider are skipped."""
    result = collect_variants(
        _base_toml({"Nope/glm-5.2": "high"}, providers=_providers())
    )
    assert result == {}
    assert "provider 不存在" in capsys.readouterr().out


def test_collect_variants_unknown_model_skipped(capsys) -> None:
    """Keys referencing an undeclared model are skipped."""
    result = collect_variants(
        _base_toml({"Cambricon/nope": "high"}, providers=_providers())
    )
    assert result == {}
    assert "模型不存在" in capsys.readouterr().out


def test_collect_variants_empty_variant_name_skipped(capsys) -> None:
    """An empty or non-string variant name is skipped."""
    result = collect_variants(
        _base_toml({"Cambricon/glm-5.2": ""}, providers=_providers())
    )
    assert result == {}
    assert "variant 名为空或非字符串" in capsys.readouterr().out


def test_collect_variants_non_str_value_skipped(capsys) -> None:
    """A value that is neither a string nor a subtable is skipped."""
    result = collect_variants(
        _base_toml({"Cambricon/glm-5.2": 42}, providers=_providers())
    )
    assert result == {}
    assert "既非字符串也非子表" in capsys.readouterr().out


def test_collect_variants_ignores_agent_subtables() -> None:
    """[zoo.variants.<agent>] subtables belong to the per-agent channel."""
    variants = {"beaver": {"OpenAI/gpt-5.5": "low"}}
    toml_data = _base_toml(
        variants, providers=_providers(), agents={"beaver": {}}
    )
    assert collect_variants(toml_data) == {}


def test_collect_variants_missing_section_returns_empty() -> None:
    """A missing or malformed [zoo.variants] section yields {}."""
    assert collect_variants({}) == {}
    assert collect_variants({"zoo": {}}) == {}
    assert collect_variants({"zoo": {"variants": "not-a-dict"}}) == {}


# ── collect_agent_variants ───────────────────────────────────────────────


def test_collect_agent_variants_valid_subtable() -> None:
    """A per-agent subtable with valid entries is collected."""
    toml_data = _base_toml(
        {"beaver": {"OpenAI/gpt-5.5": "low"}},
        providers=_providers(),
        agents={"beaver": {}, "dolphin": {}},
    )
    assert collect_agent_variants(toml_data) == {
        "beaver": {"OpenAI/gpt-5.5": "low"}
    }


def test_collect_agent_variants_unknown_agent_skips_whole_subtable(
    capsys,
) -> None:
    """An undeclared agent name discards the whole subtable."""
    toml_data = _base_toml(
        {"ghost": {"OpenAI/gpt-5.5": "low"}},
        providers=_providers(),
        agents={"beaver": {}},
    )
    assert collect_agent_variants(toml_data) == {}
    assert "不是已声明的 agent" in capsys.readouterr().out


def test_collect_agent_variants_mixed_valid_invalid(capsys) -> None:
    """Invalid entries inside a subtable are skipped, valid ones kept."""
    toml_data = _base_toml(
        {
            "beaver": {
                "OpenAI/gpt-5.5": "low",
                "Nope/gpt-5.5": "high",
                "OpenAI/ghost": "high",
                "Cambricon/glm-5.2": "",
            }
        },
        providers=_providers(),
        agents={"beaver": {}},
    )
    assert collect_agent_variants(toml_data) == {
        "beaver": {"OpenAI/gpt-5.5": "low"}
    }
    assert "provider 不存在" in capsys.readouterr().out


def test_collect_agent_variants_ignores_flat_entries() -> None:
    """Flat \"Provider/model\" entries belong to the global channel."""
    toml_data = _base_toml(
        {"Cambricon/glm-5.2": "high"},
        providers=_providers(),
        agents={"beaver": {}},
    )
    assert collect_agent_variants(toml_data) == {}


def test_collect_agent_variants_missing_section_returns_empty() -> None:
    """A missing [zoo.variants] or [agent] section yields {}."""
    assert collect_agent_variants({}) == {}
    assert collect_agent_variants({"zoo": {"variants": {"beaver": {}}}}) == {}
