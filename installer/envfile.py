"""Parse config.toml and .env files and resolve {env:VAR} placeholders."""

import os
import re
import sys

try:
    import tomllib
except ModuleNotFoundError:
    import tomli as tomllib  # Python < 3.11

from installer.output import error, info, warn


def parse_toml(filepath: str) -> dict:
    """Parse a TOML file into a Python dictionary using the stdlib tomllib.

    Args:
        filepath: Path to the TOML file.

    Returns:
        The parsed dictionary structure.

    Raises:
        FileNotFoundError: Raised by open() when the file does not exist.
        tomllib.TOMLDecodeError: If the file is not valid TOML.
    """
    with open(filepath, "rb") as f:
        return tomllib.load(f)


def parse_env_file(env_path: str) -> dict[str, str]:
    """Parse a .env file and return a dict of KEY=VALUE pairs.

    Format is KEY=VALUE, supports double/single-quoted values and trailing comments.
    Silently returns an empty dict if the file does not exist.

    Args:
        env_path: Path to the .env file.

    Returns:
        A dictionary mapping variable names to their values.
    """
    env: dict[str, str] = {}
    if not os.path.isfile(env_path):
        return env

    loaded = 0
    with open(env_path, encoding="utf-8") as f:
        for lineno, line in enumerate(f, start=1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                warn(f".env:{lineno}: 忽略无效行: {line}")
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            if not key:
                warn(f".env:{lineno}: 忽略空键名")
                continue
            value = value.strip()
            if (
                len(value) >= 2
                and value[0] == value[-1]
                and value[0] in ('"', "'")
            ):
                value = value[1:-1]
            if key not in env:
                env[key] = value
                loaded += 1

    if loaded:
        info(f"✓ 已从 .env 加载 {loaded} 个变量")
    return env


_ENV_REF_RE = re.compile(r"^\{env:([^}]+)\}$")
_ENV_REF_SEARCH_RE = re.compile(r"\{env:([^}]+)\}")


def resolve_env_refs_deep(obj, env: dict[str, str]):
    """Recursively resolve all {env:VAR} placeholders in dict/list using the env dict.

    If a referenced variable is not present in *env*, prints an error and exits.

    Args:
        obj: A dict/list/primitive value that may contain {env:VAR} placeholders.
        env: The environment variable dictionary (from parse_env_file).

    Returns:
        A copy of the object with all {env:VAR} placeholders replaced by their string values.

    Raises:
        SystemExit: When a referenced environment variable is not set.
    """
    if isinstance(obj, dict):
        return {k: resolve_env_refs_deep(v, env) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [resolve_env_refs_deep(item, env) for item in obj]
    elif isinstance(obj, str):
        m = _ENV_REF_RE.match(obj.strip())
        if m:
            var_name = m.group(1)
            resolved = env.get(var_name)
            if resolved is None:
                error(
                    f"变量 {var_name} 未在 .env 中设置！"
                    f'请在 .env 文件中添加 {var_name}="..."（参考 .env.example）'
                )
                sys.exit(1)
            return resolved

        # Check for embedded {env:VAR} references (e.g. "Token {env:JIRA_ACCESS_TOKEN}")
        refs = _ENV_REF_SEARCH_RE.findall(obj)
        if not refs:
            return obj

        result = obj
        for var_name in refs:
            resolved = env.get(var_name)
            if resolved is None:
                error(
                    f"变量 {var_name} 未在 .env 中设置！"
                    f'请在 .env 文件中添加 {var_name}="..."（参考 .env.example）'
                )
                sys.exit(1)
            result = result.replace(f"{{env:{var_name}}}", resolved)
        return result
    return obj


def _gather_env_vars(obj) -> set[str]:
    """Recursively collect all {env:VAR} variable names from nested structures.

    Walks dicts, lists, and string values to find every ``{env:VAR}``
    reference that ``_ENV_REF_RE`` can match.

    Args:
        obj: A dict, list, string, or primitive value.

    Returns:
        A set of environment variable names referenced in the object.
    """
    vars_set: set[str] = set()
    if isinstance(obj, dict):
        for v in obj.values():
            vars_set |= _gather_env_vars(v)
    elif isinstance(obj, list):
        for item in obj:
            vars_set |= _gather_env_vars(item)
    elif isinstance(obj, str):
        vars_set.update(_ENV_REF_SEARCH_RE.findall(obj))
    return vars_set


def _filter_missing_entries(
    toml_data: dict,
    section_key: str,
    label: str,
    env: dict[str, str],
    scope_key: str | None = None,
) -> None:
    """Remove entries whose credential env vars are not set.

    Scans each entry in ``toml_data[section_key]`` for ``{env:VAR}``
    references.  If ``scope_key`` is provided, only the sub-dict at
    ``entry[scope_key]`` is scanned (e.g. ``"options"`` for providers);
    otherwise the entire entry dict is scanned.  Entries with missing
    variables are removed from *toml_data* with a Chinese warning.

    Args:
        toml_data: The parsed TOML dictionary (mutated in-place).
        section_key: Top-level key in toml_data (e.g. ``"provider"`` or ``"mcp"``).
        label: Chinese label for warning messages (e.g. ``"provider"``
            or ``"MCP 服务器"``).
        env: The environment variable dictionary (from ``parse_env_file``).
        scope_key: Optional sub-key within each entry to restrict scanning.
    """
    section = toml_data.get(section_key)
    if not isinstance(section, dict):
        return

    to_remove: list[str] = []
    for name, entry in section.items():
        if not isinstance(entry, dict):
            continue

        if scope_key is not None:
            target = entry.get(scope_key)
            if not isinstance(target, dict):
                continue
        else:
            target = entry

        refs = _gather_env_vars(target)
        missing = [v for v in refs if v not in env]
        if missing:
            warn(
                f"{label} {name} 的环境变量未配置"
                f"（{', '.join(sorted(missing))}），跳过"
            )
            to_remove.append(name)

    for name in to_remove:
        del section[name]
