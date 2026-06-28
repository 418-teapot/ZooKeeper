"""Static analysis tests for ZooKeeper prompt-config consistency.

All tests are zero-LLM-cost, pure file inspection.
"""

from __future__ import annotations

try:
    import tomllib
except ModuleNotFoundError:
    import tomli as tomllib  # Python < 3.11
from pathlib import Path

# ── Paths ────────────────────────────────────────────────────────────────

REPO_ROOT = Path(__file__).resolve().parent.parent
CONFIG_TOML = REPO_ROOT / "config.toml"
THRESHOLDS_TOML = REPO_ROOT / "tests" / "thresholds.toml"


# ── Helpers ──────────────────────────────────────────────────────────────


def _load_config() -> dict:
    """Parse and return the project config.toml."""
    with open(CONFIG_TOML, "rb") as f:
        return tomllib.load(f)


def _load_thresholds() -> dict:
    """Parse and return tests/thresholds.toml."""
    with open(THRESHOLDS_TOML, "rb") as f:
        return tomllib.load(f)


def _get_agent_names(config: dict = None) -> list[str]:  # type: ignore[assignment]
    """Extract sorted list of agent names from ``[agent.<name>]`` sections.

    TOML ``[agent.dolphin]`` is parsed as ``config["agent"]["dolphin"]``.
    Agents with ``disable = true`` are excluded.

    Args:
        config: Parsed config.toml dict. Loaded fresh if None.

    Returns:
        Sorted list of agent name strings.
    """
    if config is None:
        config = _load_config()
    agents = config.get("agent", {})
    return sorted(
        name
        for name, cfg in agents.items()
        if not (isinstance(cfg, dict) and cfg.get("disable"))
    )


# ── Test: threshold coverage ────────────────────────────────────────────


def test_threshold_coverage() -> None:
    """Verify every agent in config.toml has a corresponding section in
    tests/thresholds.toml (even if empty).
    """
    config = _load_config()
    thresholds = _load_thresholds()

    config_agents = set(_get_agent_names(config))
    threshold_agents = set(thresholds.keys())

    missing = config_agents - threshold_agents
    assert not missing, (
        f"The following agents appear in config.toml but are missing a "
        f"corresponding section in tests/thresholds.toml:\n"
        f"  {sorted(missing)}\n"
        f"Add an empty section like:\n"
        f"  [{', '.join(sorted(missing))}]\n"
        f"  # (empty for now)"
    )
