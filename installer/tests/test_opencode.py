"""Tests for installer.opencode mode-profile parsing and agent filtering.

Covers the two profile-driven behaviors introduced for ``[zoo.mode.*]``:
extracting the active profile (valid / absent / ambiguous / malformed /
multi-profile with a ``selected`` name), and ``build_config`` emitting
the profile's agent list plus every explicitly disabled ``[agent.*]``
section, with no default fallback when the profile is missing.
"""

from __future__ import annotations

from pathlib import Path

from installer.envfile import _gather_env_vars, parse_toml
from installer.opencode import build_config, parse_mode_profile

REPO_ROOT = Path(__file__).resolve().parents[2]

# ── Test data ────────────────────────────────────────────────────────────

# The canonical poly profile: every category fully populated (mirrors
# config.toml [zoo.mode.poly]).
POLY_PROFILE: dict[str, object] = {
    "agents": [
        "dolphin",
        "mola",
        "beaver",
        "lynx",
        "spider",
        "eagle",
        "kiwi",
    ],
    "skills": [
        "beaver-tdd",
        "code-review",
        "git-commit",
        "grill",
        "kiwi-distill",
        "kiwi-verify",
        "mola-plan",
        "wiki-ingest",
        "wiki-query",
        "wiki-verify",
    ],
    "hooks": [
        "task-prompt",
        "task-delegation",
        "direct-work-nudge",
        "post-task-nudge",
        "json-error-nudge",
        "context-pruning",
    ],
    "tools": ["compress", "decompress"],
    "commands": ["go", "dcp"],
}

EXPECTED_AGENTS = [
    "dolphin",
    "mola",
    "beaver",
    "lynx",
    "spider",
    "eagle",
    "kiwi",
]

# The mono profile: a minimal agent set (mirrors config.toml
# [zoo.mode.mono]).
MONO_PROFILE: dict[str, object] = {
    "agents": ["dolphin", "mola"],
    "skills": ["git-commit", "grill", "mola-plan", "wiki-query"],
    "hooks": ["context-pruning", "json-error-nudge"],
    "tools": ["compress", "decompress"],
    "commands": ["go", "dcp"],
}

# Built-in agents explicitly disabled with ``disable = true`` in
# config.toml (lines 455-466).  They must survive profile filtering so
# OpenCode's built-in agents stay disabled.
DISABLED_AGENTS = ["plan", "build", "general", "explore"]


def _zoo_with_mode(profile: object) -> dict:
    """Build a ``zoo`` dict holding ``mode`` with the given profile value."""
    return {"zoo": {"mode": {"poly": profile}}}


def _toml_with_agents(names: list[str]) -> dict:
    """Build a minimal toml dict with ``[agent.<name>]`` sections."""
    return {"agent": {name: {"model": f"Provider/{name}"} for name in names}}


# ── parse_mode_profile: valid profiles ───────────────────────────────────


def test_parse_mode_profile_full_poly() -> None:
    """A fully populated profile parses with all five category lists."""
    profile = parse_mode_profile(_zoo_with_mode(POLY_PROFILE))
    assert profile is not None
    assert profile["name"] == "poly"
    assert profile["agents"] == POLY_PROFILE["agents"]
    assert profile["skills"] == POLY_PROFILE["skills"]
    assert profile["hooks"] == POLY_PROFILE["hooks"]
    assert profile["tools"] == POLY_PROFILE["tools"]
    assert profile["commands"] == POLY_PROFILE["commands"]


def test_parse_mode_profile_absent_categories_default_to_empty() -> None:
    """A profile declaring only ``agents`` yields empty lists elsewhere."""
    profile = parse_mode_profile(_zoo_with_mode({"agents": ["dolphin"]}))
    assert profile is not None
    assert profile["name"] == "poly"
    assert profile["agents"] == ["dolphin"]
    assert profile["skills"] == []
    assert profile["hooks"] == []
    assert profile["tools"] == []
    assert profile["commands"] == []


# ── parse_mode_profile: skip paths (no default fallback) ────────────────


def test_parse_mode_profile_absent_returns_none() -> None:
    """Missing ``zoo`` / ``zoo.mode`` yields None (skip, not full load)."""
    assert parse_mode_profile({}) is None
    assert parse_mode_profile({"zoo": {}}) is None
    assert parse_mode_profile({"zoo": {"mode": {}}}) is None


def test_parse_mode_profile_ambiguous_returns_none() -> None:
    """Multiple profiles under ``zoo.mode`` yield None."""
    toml_data = {"zoo": {"mode": {"poly": POLY_PROFILE, "lite": {}}}}
    assert parse_mode_profile(toml_data) is None


def test_parse_mode_profile_multi_profile_missing_selection_warns(
    capsys,
) -> None:
    """Multiple profiles without a selection yield None plus a warning."""
    toml_data = {"zoo": {"mode": {"poly": POLY_PROFILE, "mono": MONO_PROFILE}}}
    profile = parse_mode_profile(toml_data)
    assert profile is None
    assert "存在多个 profile" in capsys.readouterr().out


def test_parse_mode_profile_multi_profile_valid_selection() -> None:
    """Multiple profiles plus a known selection returns that profile."""
    toml_data = {"zoo": {"mode": {"poly": POLY_PROFILE, "mono": MONO_PROFILE}}}
    profile = parse_mode_profile(toml_data, selected="mono")
    assert profile is not None
    assert profile["name"] == "mono"
    assert profile["agents"] == MONO_PROFILE["agents"]
    assert profile["skills"] == MONO_PROFILE["skills"]
    assert profile["hooks"] == MONO_PROFILE["hooks"]
    assert profile["tools"] == MONO_PROFILE["tools"]
    assert profile["commands"] == MONO_PROFILE["commands"]

    profile = parse_mode_profile(toml_data, selected="poly")
    assert profile is not None
    assert profile["name"] == "poly"
    assert profile["agents"] == POLY_PROFILE["agents"]


def test_parse_mode_profile_multi_profile_unknown_selection_warns(
    capsys,
) -> None:
    """Multiple profiles plus an unknown selection yield None plus a warning."""
    toml_data = {"zoo": {"mode": {"poly": POLY_PROFILE, "mono": MONO_PROFILE}}}
    assert parse_mode_profile(toml_data, selected="nope") is None
    assert "nope" in capsys.readouterr().out


def test_parse_mode_profile_single_profile_ignores_selection() -> None:
    """A single profile wins regardless of the requested selection."""
    toml_data = {"zoo": {"mode": {"mono": MONO_PROFILE}}}
    profile = parse_mode_profile(toml_data, selected="poly")
    assert profile is not None
    assert profile["name"] == "mono"
    assert profile["agents"] == MONO_PROFILE["agents"]


def test_parse_mode_profile_non_object_returns_none() -> None:
    """A non-object ``zoo.mode`` or profile value yields None."""
    assert parse_mode_profile({"zoo": {"mode": "poly"}}) is None
    assert parse_mode_profile({"zoo": {"mode": ["poly"]}}) is None
    assert parse_mode_profile(_zoo_with_mode("all")) is None
    assert parse_mode_profile(_zoo_with_mode(None)) is None


def test_parse_mode_profile_invalid_category_returns_none() -> None:
    """A category that is not a string array discards the whole profile."""
    bad: dict[str, object] = dict(POLY_PROFILE)
    bad["tools"] = "all"
    assert parse_mode_profile(_zoo_with_mode(bad)) is None

    bad = dict(POLY_PROFILE)
    bad["agents"] = ["dolphin", 42]
    assert parse_mode_profile(_zoo_with_mode(bad)) is None


# ── build_config: agent filtering ────────────────────────────────────────


def test_build_config_filters_agents_by_profile(tmp_path) -> None:
    """Only profile-listed ``[agent.*]`` sections are emitted."""
    toml_data = _toml_with_agents(["dolphin", "mola", "beaver"])
    config = build_config(
        toml_data, str(tmp_path), {}, profile_agents=["dolphin", "mola"]
    )
    assert set(config["agent"]) == {"dolphin", "mola"}


def test_build_config_keeps_disabled_agents(tmp_path) -> None:
    """Explicitly disabled agent sections survive profile filtering."""
    toml_data = {
        "agent": {
            "dolphin": {"model": "Provider/dolphin"},
            "plan": {"disable": True},
        }
    }
    config = build_config(
        toml_data, str(tmp_path), {}, profile_agents=["dolphin"]
    )
    assert set(config["agent"]) == {"dolphin", "plan"}
    assert config["agent"]["plan"] == {"disable": True}


def test_build_config_omits_agents_without_profile(tmp_path) -> None:
    """Without a profile, agent sections are omitted (no default list)."""
    toml_data = _toml_with_agents(["dolphin", "mola"])
    config = build_config(toml_data, str(tmp_path), {})
    assert "agent" not in config


def test_build_config_omits_agents_for_empty_profile(tmp_path) -> None:
    """An empty profile agent list omits agent sections."""
    toml_data = _toml_with_agents(["dolphin"])
    config = build_config(toml_data, str(tmp_path), {}, profile_agents=[])
    assert "agent" not in config


# ── Integration with the real config.toml ───────────────────────────────


def test_real_config_poly_profile_filters_agents(tmp_path) -> None:
    """The shipped config.toml emits profile agents plus disabled ones."""
    toml_data = parse_toml(str(REPO_ROOT / "config.toml"))
    profile = parse_mode_profile(toml_data, selected="poly")
    assert profile is not None
    assert profile["name"] == "poly"
    assert profile["agents"] == EXPECTED_AGENTS

    # Resolve every {env:VAR} reference with synthetic values so the
    # config build does not exit on missing variables.
    refs = _gather_env_vars(toml_data)
    env = {name: f"test-{name}" for name in refs}
    config = build_config(
        toml_data, str(tmp_path), env, profile_agents=profile["agents"]
    )
    # Profile agents are emitted alongside the explicitly disabled
    # built-in agents (plan/build/general/explore).
    assert set(config["agent"]) == set(profile["agents"]) | set(
        DISABLED_AGENTS
    )
    # Explicitly disabled sections are preserved verbatim.
    for name in DISABLED_AGENTS:
        assert config["agent"][name] == {"disable": True}
