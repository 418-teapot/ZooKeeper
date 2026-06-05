#!/usr/bin/env python3
"""
ZooKeeper — Read config.toml + .env → Generate ~/.config/opencode/opencode.json

Usage:
    python3 install.py               # Use config.toml + .env
    python3 install.py /path/to.toml # Specify a TOML file

Only depends on Python standard library.
"""

import json
import os
import re
import shutil
import sys
from datetime import datetime


class Colors:
    """Collection of ANSI escape codes for terminal output colors."""

    BOLD = "\033[1m"
    RED = "\033[0;31m"
    YELLOW = "\033[0;33m"
    GREEN = "\033[0;32m"
    CYAN = "\033[0;36m"
    NC = "\033[0m"


def info(msg: str) -> None:
    """Print an informational message in green text.

    Args:
        msg: The message content to print.
    """
    print(f"{Colors.GREEN}{msg}{Colors.NC}")


def warn(msg: str) -> None:
    """Print a warning message in yellow text (prefixed with ⚠).

    Args:
        msg: The message content to print.
    """
    print(f"{Colors.YELLOW}⚠ {msg}{Colors.NC}")


def error(msg: str) -> None:
    """Print an error message in red text to stderr (prefixed with ✖).

    Args:
        msg: The message content to print.
    """
    print(f"{Colors.RED}✖ {msg}{Colors.NC}", file=sys.stderr)


def bold(msg: str) -> str:
    """Wrap text with ANSI bold escape codes.

    Args:
        msg: The text to bolden.

    Returns:
        The string wrapped with bold escape codes.
    """
    return f"{Colors.BOLD}{msg}{Colors.NC}"


def header(title: str) -> None:
    """Print a section title with separator lines.

    Args:
        title: The title text.
    """
    print(f"\n{Colors.CYAN}━━━ {title} ━━━{Colors.NC}")


def parse_toml(filepath: str) -> dict:
    """Parse a TOML file into a Python dictionary.

    Supports sections, key=value pairs, and comment syntax.
    Does NOT support arrays, inline tables, or multi-line strings.

    Args:
        filepath: Path to the TOML file.

    Returns:
        The parsed dictionary structure.

    Raises:
        FileNotFoundError: Raised by open() when the file does not exist.
    """
    result: dict = {}
    current: dict = result

    with open(filepath, encoding="utf-8") as f:
        for line in f:
            if "#" in line:
                line = line.split("#", 1)[0]
            line = line.strip()
            if not line:
                continue

            if line.startswith("[") and line.endswith("]"):
                # Section: [foo.bar.baz] — supports quoted keys (e.g. [provider.Cambricon.models."glm-5.1"])
                path = line[1:-1].strip()
                parts = []
                buf = []
                in_quote = None
                for ch in path:
                    if ch in ('"', "'"):
                        if in_quote is None:
                            in_quote = ch
                        elif ch == in_quote:
                            in_quote = None
                            continue
                        else:
                            buf.append(ch)
                    elif ch == "." and in_quote is None:
                        part = "".join(buf).strip().strip('"').strip("'")
                        if part:
                            parts.append(part)
                        buf = []
                    else:
                        buf.append(ch)
                part = "".join(buf).strip().strip('"').strip("'")
                if part:
                    parts.append(part)
                current = result
                for part in parts:
                    if part not in current:
                        current[part] = {}
                    current = current[part]

            elif "=" in line:
                key, _, value = line.partition("=")
                key = key.strip().strip('"').strip("'")
                value = value.strip()

                if len(value) >= 2 and value[0] == '"' and value[-1] == '"':
                    value = value[1:-1]
                elif len(value) >= 2 and value[0] == "'" and value[-1] == "'":
                    value = value[1:-1]
                else:
                    try:
                        value = (
                            float(value)
                            if ("." in value or "e" in value.lower())
                            else int(value)
                        )
                    except ValueError:
                        pass
                current[key] = value

    return result


def load_env_file(env_path: str) -> None:
    """Read a .env file and inject variables into os.environ.

    Format is KEY=VALUE, supports double/single-quoted values and trailing comments.
    Does NOT overwrite variables already present in os.environ.

    Args:
        env_path: Path to the .env file. Silently returns if the file does not exist.
    """
    if not os.path.isfile(env_path):
        return

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
            if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
                value = value[1:-1]
            if key not in os.environ:
                os.environ[key] = value
                loaded += 1

    if loaded:
        info(f"✓ 已从 .env 加载 {loaded} 个变量")


_ENV_REF_RE = re.compile(r"^\{env:([^}]+)\}$")


def resolve_env_refs_deep(obj):
    """Recursively resolve all {env:VAR} placeholders in dict/list to actual environment variable values.

    If a referenced environment variable is not set, prints an error and exits.

    Args:
        obj: A dict/list/primitive value that may contain {env:VAR} placeholders.

    Returns:
        A copy of the object with all {env:VAR} placeholders replaced by their string values.

    Raises:
        SystemExit: When a referenced environment variable is not set.
    """
    if isinstance(obj, dict):
        return {k: resolve_env_refs_deep(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [resolve_env_refs_deep(item) for item in obj]
    elif isinstance(obj, str):
        m = _ENV_REF_RE.match(obj.strip())
        if not m:
            return obj
        var_name = m.group(1)
        resolved = os.environ.get(var_name)
        if resolved is None:
            error(f"环境变量 {var_name} 未设置！请创建 .env 文件（参考 .env.example）")
            error(f'或 export {var_name}="..." 后再运行 install.py')
            sys.exit(1)
        return resolved
    return obj


def build_config(toml_data: dict, project_dir: str) -> dict:
    """Convert parsed TOML data into the OpenCode JSON configuration.

    Fields in the [defaults] section are promoted to the top-level of the config.
    All {env:} placeholders are resolved to actual environment variable values.

    Args:
        toml_data: The dictionary returned by parse_toml().
        project_dir: The project root directory path, used to locate plugin files.

    Returns:
        A configuration dictionary ready to be serialized as opencode.json.
    """
    project_dir = os.path.abspath(project_dir)

    plugin_rel = os.path.join("adapters", "opencode", "src", "index.ts")
    plugin_abs = os.path.join(project_dir, plugin_rel)
    plugin_uri = "file://" + plugin_abs

    if not os.path.exists(plugin_abs):
        warn(f"插件文件不存在 → {plugin_abs}")
        warn(f"项目目录检测为: {project_dir}")
    else:
        info(f"✓ 插件: {plugin_uri}")

    config: dict = {}

    if "$schema" in toml_data:
        config["$schema"] = toml_data["$schema"]
    config["plugin"] = [plugin_uri]
    if "provider" in toml_data:
        config["provider"] = toml_data["provider"]
    if "agent" in toml_data:
        config["agent"] = toml_data["agent"]
    if "defaults" in toml_data:
        for k, v in toml_data["defaults"].items():
            config[k] = v

    return resolve_env_refs_deep(config)


def main() -> None:
    """Main entry point: load configuration, back up old file, generate new config, and validate."""
    SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

    # Load .env (must happen before {env:} resolution)
    load_env_file(os.path.join(SCRIPT_DIR, ".env"))

    toml_path = os.path.abspath(
        sys.argv[1] if len(sys.argv) > 1 else os.path.join(SCRIPT_DIR, "config.toml")
    )
    opencode_dir = os.path.join(os.path.expanduser("~"), ".config", "opencode")
    opencode_json = os.path.join(opencode_dir, "opencode.json")

    header("检查环境")
    if not os.path.isfile(toml_path):
        error(f"配置文件未找到: {toml_path}")
        sys.exit(1)
    info(f"✓ 配置: {toml_path}")

    header("备份已有配置")
    if os.path.isfile(opencode_json):
        backup_path = f"{opencode_json}.bak.{datetime.now().strftime('%Y%m%d%H%M%S')}"
        shutil.copy2(opencode_json, backup_path)
        info(f"✓ 已备份: {backup_path}")
    else:
        info("✓ 无已有配置")

    os.makedirs(opencode_dir, exist_ok=True)

    header("生成配置")
    toml_data = parse_toml(toml_path)
    config = build_config(toml_data, SCRIPT_DIR)
    with open(opencode_json, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2, ensure_ascii=False)
        f.write("\n")

    header("验证配置")
    try:
        with open(opencode_json, encoding="utf-8") as f:
            json.load(f)
        info("✓ JSON 格式校验通过")
    except json.JSONDecodeError as e:
        error(f"JSON 格式无效: {e}")
        sys.exit(1)

    header("安装完成")
    info(f"✅ 配置已写入: {opencode_json}")
    print("")
    print(f"  {bold('查看:')}  opencode config --path")
    print(f"  {bold('验证:')}  opencode config --json")
    print(f"  {bold('.env:')}  参考 {os.path.join(SCRIPT_DIR, '.env.example')}")
    print("")


if __name__ == "__main__":
    main()
