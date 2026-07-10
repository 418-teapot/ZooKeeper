#!/usr/bin/env python3
"""
ZooKeeper — Read config.toml → Generate ~/.config/opencode/opencode.json

{env:VAR} placeholders pass through as-is for opencode to resolve at runtime from the
process environment. Ensure your env vars are exported before running opencode.

Usage:
    python3 install.py               # Use config.toml
    python3 install.py /path/to.toml # Specify a TOML file

Only depends on Python standard library.
"""

import json
import os
import shutil
import sys

try:
    import tomllib
except ModuleNotFoundError:
    import tomli as tomllib  # Python < 3.11
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


def build_config(toml_data: dict, project_dir: str) -> dict:
    """Convert parsed TOML data into the OpenCode JSON configuration.

    Fields in the [defaults] section are promoted to the top-level of the config.
    {env:VAR} placeholders pass through as-is for opencode to resolve at runtime.

    Args:
        toml_data: The dictionary returned by parse_toml().
        project_dir: The project root directory path, used to locate plugin files.

    Returns:
        A configuration dictionary ready to be serialized as opencode.json.
    """
    project_dir = os.path.abspath(project_dir)

    plugin_rel = os.path.join("src", "index.ts")
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

    return config


def main() -> None:
    """Main entry point: load configuration, back up old file, generate new config, and validate."""
    SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

    toml_path = os.path.abspath(
        sys.argv[1]
        if len(sys.argv) > 1
        else os.path.join(SCRIPT_DIR, "config.toml")
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
        backup_path = (
            f"{opencode_json}.bak.{datetime.now().strftime('%Y%m%d%H%M%S')}"
        )
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

    # ── Wiki bundle install ─────────────────────────────────────────
    header("Wiki Bundle 安装")
    zoo_dir = os.path.join(os.path.expanduser("~"), ".zoo")
    wiki_root = os.path.join(zoo_dir, "wiki")

    # Pre-create wiki directory structure
    for subdir in [
        wiki_root,
        os.path.join(wiki_root, ".upstream"),
        os.path.join(wiki_root, ".teams"),
        os.path.join(wiki_root, ".org"),
        os.path.join(wiki_root, "personal"),
    ]:
        os.makedirs(subdir, exist_ok=True)

    source_wiki = os.path.join(SCRIPT_DIR, "wiki")
    zwiki_bin = os.path.join(SCRIPT_DIR, "tools", "bin", "zwiki")

    if not os.path.isdir(source_wiki):
        warn(f"Wiki 源目录不存在，跳过: {source_wiki}")
    elif not os.path.isfile(zwiki_bin):
        warn(
            "zwiki 未编译，跳过 bundle 安装（运行 ./build.sh 后重新执行 install.py）"
        )
    else:
        import subprocess

        result = subprocess.run(
            [zwiki_bin, "bundle", "install", source_wiki, "--force"],
            capture_output=True,
            text=True,
        )
        if result.returncode == 0:
            info(f"✓ Wiki bundle 已安装: {wiki_root}")
            # Derive team-bundle directory from zwiki.lock instead of hardcoding
            lock_path = os.path.join(wiki_root, "zwiki.lock")
            core_dir = None
            if not os.path.isfile(lock_path):
                warn("zwiki.lock 不存在，跳过 SCHEMA.md/templates 软链接")
            else:
                try:
                    lock_data = parse_toml(lock_path)
                    for entry in lock_data.get("bundles", []):
                        target = entry.get("target", "")
                        if target.startswith(".teams/"):
                            core_dir = os.path.join(wiki_root, target.rstrip("/"))
                            break
                    if core_dir is None:
                        warn("zwiki.lock 中未找到团队 bundle 条目，跳过软链接")
                except (tomllib.TOMLDecodeError, KeyError, TypeError) as e:
                    warn(f"zwiki.lock 解析失败，跳过软链接: {e}")
            if core_dir is not None:
                for name in ["SCHEMA.md", "templates"]:
                    src = os.path.join(core_dir, name)
                    dst = os.path.join(wiki_root, name)
                    if os.path.islink(dst) or os.path.exists(dst):
                        if os.path.isdir(dst) and not os.path.islink(dst):
                            shutil.rmtree(dst)
                        else:
                            os.remove(dst)
                    os.symlink(src, dst)
        else:
            warn(
                f"Wiki bundle 安装失败: {result.stderr.strip() or result.stdout.strip()}"
            )

    # ── Tools symlink ───────────────────────────────────────────────
    header("Tools 软链接")
    source_tools_bin = os.path.join(SCRIPT_DIR, "tools", "bin")
    zoo_tools_dir = os.path.join(zoo_dir, "tools")
    target_tools_link = os.path.join(zoo_tools_dir, "bin")

    if not os.path.isdir(source_tools_bin):
        warn(f"tools/bin 目录不存在，跳过软链接: {source_tools_bin}")
    else:
        os.makedirs(zoo_tools_dir, exist_ok=True)
        if os.path.islink(target_tools_link):
            os.unlink(target_tools_link)
        elif os.path.exists(target_tools_link):
            warn(f"路径已存在，将覆盖: {target_tools_link}")
            if os.path.isdir(target_tools_link):
                shutil.rmtree(target_tools_link)
            else:
                os.remove(target_tools_link)
        os.symlink(source_tools_bin, target_tools_link)
        info(f"✓ Tools 软链接: {target_tools_link} → {source_tools_bin}")

    print("")
    print(f"  {bold('查看:')}  opencode config --path")
    print(f"  {bold('验证:')}  opencode config --json")
    print(
        f"  {bold('环境变量:')}  运行 opencode 前请确保所需变量已 export（参考 {os.path.join(SCRIPT_DIR, '.env.example')}）"
    )
    print("")


if __name__ == "__main__":
    main()
