"""Static analysis tests for ZooKeeper prompt-config consistency.

All tests are zero-LLM-cost, pure file inspection.
"""

import tomllib
from pathlib import Path

import pytest

# ── Paths ────────────────────────────────────────────────────────────────

REPO_ROOT = Path(__file__).resolve().parent.parent
CONFIG_TOML = REPO_ROOT / "config.toml"
PROMPTS_DIR = REPO_ROOT / "core" / "prompts"
THRESHOLDS_TOML = REPO_ROOT / "tests" / "thresholds.toml"

# ── Shared phrases for structural checks ─────────────────────────────────

ROLE_PHRASES = ["role", "you are", "你的角色"]
DELEGATE_PHRASES = ["delegate", "委派", "subagent"]
RESTRICTION_PHRASES = ["do not", "never", "must not", "绝不", "不要"]

AGENT_STRUCTURE_REQUIREMENTS: dict[str, list[list[str]]] = {
    # Each value is a list of phrase-groups; for each group,
    # at least one phrase must appear in the prompt.
    "build": [DELEGATE_PHRASES],
    "general": [RESTRICTION_PHRASES],
    "explore": [RESTRICTION_PHRASES],
    "spider": [RESTRICTION_PHRASES],
}

# Max estimated tokens (len // 3) per prompt.
MAX_PROMPT_TOKENS = 5000


# ── Helpers ──────────────────────────────────────────────────────────────


def _load_config() -> dict:
    """Parse and return the project config.toml."""
    with open(CONFIG_TOML, "rb") as f:
        return tomllib.load(f)


def _load_thresholds() -> dict:
    """Parse and return tests/thresholds.toml."""
    with open(THRESHOLDS_TOML, "rb") as f:
        return tomllib.load(f)


def _get_agent_names(config: dict | None = None) -> list[str]:
    """Extract sorted list of agent names from ``[agent.<name>]`` sections.

    TOML ``[agent.build]`` is parsed as ``config["agent"]["build"]``.

    Args:
        config: Parsed config.toml dict. Loaded fresh if None.

    Returns:
        Sorted list of agent name strings.
    """
    if config is None:
        config = _load_config()
    agents = config.get("agent", {})
    return sorted(agents.keys())


def _get_denied_tools(config: dict, agent_name: str) -> list[str]:
    """Return tool names marked ``= "deny"`` for the given agent.

    Args:
        config: Parsed config.toml dict.
        agent_name: Agent section name (e.g. ``"build"``).

    Returns:
        List of denied tool name strings.
    """
    agent = config.get("agent", {}).get(agent_name, {})
    permission = agent.get("permission", {})
    return [tool for tool, status in permission.items() if status == "deny"]


# ── Data for parametrization ────────────────────────────────────────────

_CONFIG = _load_config()
_AGENT_NAMES = _get_agent_names(_CONFIG)

_DENIED_PAIRS: list[tuple[str, str]] = []
for _name in _AGENT_NAMES:
    for _tool in _get_denied_tools(_CONFIG, _name):
        _DENIED_PAIRS.append((_name, _tool))

# Known tools in the OpenCode tool set.
_KNOWN_TOOLS = {
    "task",
    "read",
    "edit",
    "write",
    "bash",
    "grep",
    "glob",
    "webfetch",
    "websearch",
}


# ── Test: prompt does not claim denied tools ─────────────────────────────


@pytest.mark.parametrize("agent,tool", _DENIED_PAIRS)
def test_prompt_not_claims_denied_tools(agent: str, tool: str) -> None:
    """Fail if a prompt explicitly claims the agent has access to a tool that
    is denied in ``config.toml``.

    The OpenCode deny mechanism removes the tool from the agent's tool
    definition entirely, so the LLM never sees it.  If a prompt tells the
    LLM it *has* a denied tool, that is a real inconsistency — the LLM will
    attempt to call a non-existent tool.

    Detection strategy — find lines where the tool name appears in a
    "tool-availability context":
    * Inside a ``== Your tools ==`` / ``you have access`` section, OR
    * On a line that itself contains availability keywords (``have access``,
      ``you have``, ``your tool``, ``available``).
    """
    prompt_path = PROMPTS_DIR / f"{agent}.md"
    if not prompt_path.is_file():
        pytest.skip(
            f"Prompt file missing for agent '{agent}' — checked by test_prompts_exist"
        )

    content = prompt_path.read_text(encoding="utf-8")
    lines = content.splitlines()

    in_tool_context = False
    claiming_lines: list[str] = []

    for line in lines:
        line_lower = line.lower().strip()

        # Detect tool-listing section headers.
        if any(
            p in line_lower
            for p in [
                "your tools",
                "== tools",
                "you have access",
                "available tools",
            ]
        ):
            in_tool_context = True
        elif line_lower.startswith("=="):
            # Any other section heading — reset context.
            in_tool_context = False

        if tool.lower() not in line_lower:
            continue

        # Determine the portion of the line that actually lists a tool name.
        # For bullet entries like "- grep: search patterns" only the text
        # before the colon is the tool name; text after is description.
        if in_tool_context and line_lower.startswith("- "):
            colon_idx = line_lower.find(":")
            search_zone = (
                line_lower[:colon_idx] if colon_idx > 0 else line_lower
            )
        else:
            search_zone = line_lower

        # Check whether the denied tool appears in a claiming context.
        if in_tool_context and tool.lower() in search_zone:
            claiming_lines.append(line.strip())
        elif not in_tool_context and any(
            p in line_lower
            for p in ["have access", "you have", "your tool", "available"]
        ):
            claiming_lines.append(line.strip())

    assert not claiming_lines, (
        f"Prompt {agent}.md claims access to denied tool '{tool}' in:\n"
        + "\n".join(f"  {cl}" for cl in claiming_lines)
        + "\n\nEither remove the claim from the prompt, or remove "
        f"'{tool} = \"deny\"' from [agent.{agent}.permission] in config.toml."
    )


# ── Test: config does not deny claimed tools ─────────────────────────────


def _extract_claimed_tools(agent: str, content: str) -> list[str]:
    """Extract tool names that the prompt explicitly claims the agent has.

    Operates inside ``== Your tools ==`` / ``you have access`` sections.
    For bullet entries (``- <tool>: ...``) only the text before the colon is
    considered; description text after the colon is ignored.
    """
    lines = content.splitlines()
    claimed: list[str] = []
    in_tools_section = False

    for line in lines:
        line_lower = line.lower().strip()

        if any(
            p in line_lower
            for p in [
                "your tools",
                "== tools",
                "you have access",
                "available tools",
            ]
        ):
            in_tools_section = True
            # The header line itself may contain a comma-separated list of
            # tools (e.g. "you have access to read, edit, write, bash, ...").
            for tool in _KNOWN_TOOLS:
                if tool in line_lower and tool != "task":
                    claimed.append(tool)
        elif line_lower.startswith("=="):
            in_tools_section = False
        elif in_tools_section and line_lower.startswith("- "):
            # Bullet entry: only the text before the colon is the tool name.
            colon_idx = line_lower.find(":")
            zone = line_lower[:colon_idx] if colon_idx > 0 else line_lower
            for tool in _KNOWN_TOOLS:
                if tool in zone and tool != "task":
                    claimed.append(tool)

    return claimed


@pytest.mark.parametrize("agent", _AGENT_NAMES)
def test_config_not_denies_claimed_tools(agent: str) -> None:
    """Inverse check: for every tool a prompt claims is available, verify
    that ``config.toml`` does NOT deny it.

    This catches cases where the prompt was updated to grant a tool without
    the corresponding deny rule in config.toml being removed.
    """
    prompt_path = PROMPTS_DIR / f"{agent}.md"
    if not prompt_path.is_file():
        pytest.skip(
            f"Prompt file missing for agent '{agent}' — checked by test_prompts_exist"
        )

    content = prompt_path.read_text(encoding="utf-8")
    claimed_tools = _extract_claimed_tools(agent, content)
    denied_tools = _get_denied_tools(_CONFIG, agent)

    conflicting = [t for t in claimed_tools if t in denied_tools]
    assert not conflicting, (
        f"Agent '{agent}' claims these tools in {agent}.md but config.toml "
        f"denies them:\n"
        + "\n".join(f"  - {t}" for t in conflicting)
        + "\n\nEither remove the deny rule from "
        f"[agent.{agent}.permission] in config.toml, or update {agent}.md "
        f"to not list the tool as available."
    )


# ── Test: prompt structure ──────────────────────────────────────────────


@pytest.mark.parametrize("agent", _AGENT_NAMES)
def test_prompt_structure(agent: str) -> None:
    """Check each prompt contains a role definition and the required structural phrases."""
    prompt_path = PROMPTS_DIR / f"{agent}.md"
    if not prompt_path.is_file():
        pytest.skip(
            f"Prompt file missing for agent '{agent}' — checked by test_prompts_exist"
        )

    content_lower = prompt_path.read_text(encoding="utf-8").lower()

    # Role definition — all agents
    assert any(p in content_lower for p in ROLE_PHRASES), (
        f"{agent}.md is missing a role definition. Expected one of: {ROLE_PHRASES}"
    )

    # Agent-specific structure requirements
    phrase_groups = AGENT_STRUCTURE_REQUIREMENTS.get(agent)
    if phrase_groups is None:
        pytest.skip(f"No structure requirements defined for agent '{agent}'")
    for group in phrase_groups:
        assert any(p in content_lower for p in group), (
            f"{agent}.md is missing required phrases. Expected one of: {group}"
        )


# ── Test: token budget ──────────────────────────────────────────────────


@pytest.mark.parametrize("agent", _AGENT_NAMES)
def test_token_budget(agent: str) -> None:
    """Verify each prompt is under the estimated token budget.

    Uses a rough heuristic of 3 characters per token.
    """
    prompt_path = PROMPTS_DIR / f"{agent}.md"
    if not prompt_path.is_file():
        pytest.skip(
            f"Prompt file missing for agent '{agent}' — checked by test_prompts_exist"
        )

    content = prompt_path.read_text(encoding="utf-8")
    estimated_tokens = len(content) // 3
    assert estimated_tokens < MAX_PROMPT_TOKENS, (
        f"{agent}.md estimated at ~{estimated_tokens} tokens "
        f"(len={len(content)} chars, len/3) which exceeds "
        f"the {MAX_PROMPT_TOKENS} token budget. "
        f"Consider shortening the prompt."
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
