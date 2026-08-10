"""OpenCode host configuration generation from parsed TOML data."""

import os
from typing import Optional

from installer.envfile import resolve_env_refs_deep
from installer.output import info, warn
from installer.variants import collect_agent_variants

_MODE_CATEGORIES = ("agents", "skills", "hooks", "tools", "commands")


def parse_mode_profile(toml_data: dict) -> Optional[dict]:
    """Extract the single active mode profile from ``[zoo.mode.*]``.

    ``zoo.mode`` must hold exactly one sub-table — the active profile —
    whose category lists (``agents`` / ``skills`` / ``hooks`` / ``tools``
    / ``commands``) declare which loadable units are generated.  An
    absent category becomes an empty list; unknown keys are ignored.

    There is no default profile: a missing, empty, ambiguous (multiple
    sub-tables), or malformed section yields ``None`` with a Chinese
    warning so the caller can skip the profile-driven generation step
    instead of falling back to a full set.

    Args:
        toml_data: The parsed TOML dictionary.

    Returns:
        A dict with a ``name`` key plus the five category lists, or
        ``None`` when the section is missing or invalid.
    """
    zoo = toml_data.get("zoo")
    if not isinstance(zoo, dict):
        warn("[zoo.mode.*] 未配置，跳过 profile 相关生成")
        return None
    mode = zoo.get("mode")
    if not isinstance(mode, dict) or not mode:
        warn("[zoo.mode.*] 未配置或为空，跳过 profile 相关生成")
        return None
    if len(mode) > 1:
        warn(
            f"[zoo.mode.*] 存在多个 profile"
            f"（{', '.join(sorted(mode))}），只能出现一个，跳过"
        )
        return None
    name, profile = next(iter(mode.items()))
    if not isinstance(profile, dict):
        warn(f"[zoo.mode.{name}] 不是子表，跳过 profile 相关生成")
        return None
    result: dict = {"name": name}
    for category in _MODE_CATEGORIES:
        values = profile.get(category)
        if values is None:
            result[category] = []
            continue
        if not isinstance(values, list) or not all(
            isinstance(v, str) for v in values
        ):
            warn(
                f"[zoo.mode.{name}] 的 {category} 必须是字符串数组，"
                "跳过 profile 相关生成"
            )
            return None
        result[category] = values
    return result


def build_config(
    toml_data: dict,
    project_dir: str,
    env: dict[str, str],
    profile_agents: Optional[list[str]] = None,
) -> dict:
    """Convert parsed TOML data into the OpenCode JSON configuration.

    Fields in the [defaults] section are promoted to the top-level of the config.
    All {env:} placeholders are resolved to actual values from the env dict.
    Providers with missing credentials are already filtered out by the caller.
    Agent sections are emitted for names listed in *profile_agents* plus any
    section explicitly disabled with ``disable = true`` (explicit disable is
    orthogonal to the mode profile and must survive filtering); when
    *profile_agents* is ``None`` (no active mode profile) no ``[agent.*]``
    section is written at all — there is no default agent list.

    Args:
        toml_data: The dictionary returned by parse_toml() (providers already filtered).
        project_dir: The project root directory path, used to locate plugin files.
        env: The environment variable dictionary (from parse_env_file).
        profile_agents: Agent names allowed by the active mode profile, or
            ``None`` to omit agent sections entirely.

    Returns:
        A configuration dictionary ready to be serialized as opencode.json.
    """
    project_dir = os.path.abspath(project_dir)

    plugin_rel = os.path.join("src", "opencode.ts")
    plugin_abs = os.path.join(project_dir, plugin_rel)
    plugin_uri = "file://" + plugin_abs

    if not os.path.exists(plugin_abs):
        warn(f"插件文件不存在 → {plugin_abs}")
        warn(f"项目目录检测为: {project_dir}")
    else:
        info("✓ OpenCode 扩展: src/opencode.ts")

    config: dict = {}

    if "$schema" in toml_data:
        config["$schema"] = toml_data["$schema"]
    config["plugin"] = [plugin_uri]
    if "provider" in toml_data:
        config["provider"] = toml_data["provider"]
    if profile_agents is not None:
        agents = toml_data.get("agent")
        if isinstance(agents, dict):
            filtered = {
                name: data
                for name, data in agents.items()
                if name in profile_agents
                or (isinstance(data, dict) and data.get("disable") is True)
            }
            if filtered:
                config["agent"] = filtered
    if "defaults" in toml_data:
        for k, v in toml_data["defaults"].items():
            config[k] = v
    if "mcp" in toml_data and toml_data["mcp"]:
        config["mcp"] = toml_data["mcp"]

    config = resolve_env_refs_deep(config, env)

    # Inject per-agent variants from [zoo.variants.<agent>] subtables.  The
    # variant is set on an agent's dict only when the agent declares a model
    # field and that resolved model matches a key in the subtable.  A model
    # without a configured variant is a normal case, so no warning is emitted
    # and the agent is left untouched.  This runs after env resolution, so the
    # model value is already the final "Provider/model" string.
    agent_variants = collect_agent_variants(toml_data)
    if agent_variants:
        agents = config.get("agent")
        if isinstance(agents, dict):
            for agent_name, agent_data in agents.items():
                if not isinstance(agent_data, dict):
                    continue
                model = agent_data.get("model")
                if not isinstance(model, str):
                    continue
                subtable = agent_variants.get(agent_name)
                if not subtable:
                    continue
                variant = subtable.get(model)
                if variant:
                    agent_data["variant"] = variant

    return config
