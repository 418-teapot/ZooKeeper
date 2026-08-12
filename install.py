#!/usr/bin/env python3
"""
ZooKeeper — Read config.toml + .env → Generate ~/.config/opencode/opencode.json

Usage:
    python3 install.py                    # Use config.toml + .env
    python3 install.py /path/to.toml      # Specify a TOML file
    python3 install.py --mono             # Select the mono mode profile
    python3 install.py --poly             # Select the poly mode profile

Only depends on Python standard library.
"""

import argparse
import json
import os
import shutil
import sys

from installer.backup import backup_file, prune_backups
from installer.envfile import (
    _filter_missing_entries,
    parse_env_file,
    parse_toml,
    tomllib,
)
from installer.jsonio import load_json_or_empty, write_json
from installer.mode import mode_state_path, write_mode_state
from installer.opencode import build_config, parse_mode_profile
from installer.output import bold, error, header, info, warn
from installer.pi import build_pi_models_config, build_pi_settings
from installer.variants import collect_variants


def main() -> None:
    """Main entry point: load configuration, back up existing files, generate configs, validate, and install."""
    parser = argparse.ArgumentParser(
        description="ZooKeeper 安装脚本：读取 config.toml + .env，生成 OpenCode/pi 配置"
    )
    parser.add_argument(
        "toml_path",
        nargs="?",
        default=None,
        help="配置文件路径（默认: 仓库根目录 config.toml）",
    )
    mode_group = parser.add_mutually_exclusive_group()
    mode_group.add_argument(
        "--mono",
        action="store_true",
        help="使用 mono 模式 profile（单 agent）",
    )
    mode_group.add_argument(
        "--poly",
        action="store_true",
        help="使用 poly 模式 profile（多 agent）",
    )
    args = parser.parse_args()

    SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

    # Resolve the requested mode before anything else: --mono selects
    # the mono profile; everything else (including no flag) selects
    # poly.  The mode state file is write-only for the installer —
    # only the TS runtime reads it.
    requested_mode = "mono" if args.mono else "poly"

    # Parse .env (must happen before {env:} resolution)
    env = parse_env_file(os.path.join(SCRIPT_DIR, ".env"))

    toml_path = os.path.abspath(
        args.toml_path
        if args.toml_path
        else os.path.join(SCRIPT_DIR, "config.toml")
    )
    header("检查环境")
    if not os.path.isfile(toml_path):
        error(f"配置文件未找到: {toml_path}")
        sys.exit(1)
    info(f"✓ 配置: {toml_path}")

    # Detect available binaries
    has_opencode = shutil.which("opencode") is not None
    has_pi = shutil.which("pi") is not None

    if has_opencode:
        info("✓ 检测到 opencode")
    else:
        warn("未检测到 opencode，跳过 OpenCode 配置")

    if has_pi:
        info("✓ 检测到 pi")
    else:
        warn("未检测到 pi，跳过 Pi 扩展注册和 provider 配置")

    # Parse TOML (needed for both OpenCode and Pi configs)
    try:
        toml_data = parse_toml(toml_path)
    except Exception as e:
        error(f"无法解析 {toml_path}: {e}")
        sys.exit(1)
    # Snapshot the full set of provider names from config.toml before
    # _filter_missing_entries mutates toml_data (called below in the
    # 生成配置 section).  Used later for idempotent prune of Pi models.
    all_provider_names = list(toml_data.get("provider", {}).keys())

    # ── Backup existing configs ──────────────────────────────────────
    header("备份已有配置")

    opencode_dir = os.path.join(os.path.expanduser("~"), ".config", "opencode")
    opencode_json = os.path.join(opencode_dir, "opencode.json")
    tui_jsonc = os.path.join(opencode_dir, "tui.jsonc")
    pi_settings_path = os.path.join(
        os.path.expanduser("~"), ".pi", "agent", "settings.json"
    )
    pi_models_path = os.path.join(
        os.path.expanduser("~"), ".pi", "agent", "models.json"
    )

    if has_opencode:
        for cfg_path, label in [
            (opencode_json, "opencode.json"),
            (tui_jsonc, "tui.jsonc"),
        ]:
            dest = backup_file(cfg_path, "opencode")
            if dest is not None:
                prune_backups(cfg_path, "opencode")
                info(f"✓ 已备份: {label} → {dest}")
            else:
                info(f"✓ 无已有 {label}")

    if has_pi:
        any_backup = False
        for pi_path in [pi_settings_path, pi_models_path]:
            dest = backup_file(pi_path, "pi")
            if dest is not None:
                prune_backups(pi_path, "pi")
                info(f"✓ 已备份: {dest}")
                any_backup = True
        if not any_backup:
            info("✓ 无已有配置")

    # ── Clean OpenCode state cache ───────────────────────────────────
    header("清理 OpenCode 状态缓存")

    variant_model_json: str | None = None
    if has_opencode:
        opencode_state_dir = os.path.join(
            os.path.expanduser("~"), ".local", "state", "opencode"
        )
        if os.path.isdir(opencode_state_dir):
            shutil.rmtree(opencode_state_dir)
            info(f"✓ 已删除状态缓存: {opencode_state_dir}")
        else:
            info("✓ 无已有状态缓存")

        # Recreate the state dir and write model.json with the variants
        # declared in [zoo.variants], so the TUI/CLI restores the default
        # model variant after the cache wipe.
        variants = collect_variants(toml_data)
        if variants:
            os.makedirs(opencode_state_dir, exist_ok=True)
            variant_model_json = os.path.join(opencode_state_dir, "model.json")
            model_data = {
                "recent": [],
                "favorite": [],
                "variant": variants,
            }
            write_json(variant_model_json, model_data)

    # ── Generate configs ─────────────────────────────────────────────
    header("生成配置")

    # Filter providers once at top level (before any config generation),
    # regardless of which host tools are available.  warn messages
    # appear inside this section; both OpenCode and Pi use the filtered
    # toml_data.
    _filter_missing_entries(
        toml_data, "provider", "provider", env, scope_key="options"
    )
    _filter_missing_entries(toml_data, "mcp", "MCP 服务器", env)

    # Parse the mode profile once, regardless of which hosts are present,
    # so the selected mode is reported and persisted even when opencode
    # or pi is not installed.
    profile = parse_mode_profile(toml_data, selected=requested_mode)
    if profile is not None:
        info(
            f"✓ 模式 profile: {profile['name']}"
            f"（{len(profile['agents'])} 个 agent）"
        )
    profile_agents = profile["agents"] if profile is not None else None

    if has_opencode:
        os.makedirs(opencode_dir, exist_ok=True)
        config = build_config(toml_data, SCRIPT_DIR, env, profile_agents)
        write_json(opencode_json, config)

        # ── TUI plugin — tui.jsonc (overwrite; ZooKeeper is the only
        # TUI plugin in this setup) ─────────────────────────────────
        tui_plugin_entry = "file://" + os.path.abspath(
            os.path.join(SCRIPT_DIR, "src", "tui", "index.tsx")
        )
        tui_data = {"plugin": [tui_plugin_entry]}
        write_json(tui_jsonc, tui_data)
        info("✓ TUI 扩展: src/tui/index.tsx")

    if has_pi:
        # ── Pi extension — settings.json (full rebuild) ──────────────
        pi_extension_path = os.path.abspath(
            os.path.join(SCRIPT_DIR, "src", "pi.ts")
        )

        # Build the pi models config once; the provider names are reused
        # to warn when the default provider was pruned, and the result is
        # merged into models.json below.
        zk_providers = build_pi_models_config(toml_data, env).get(
            "providers", {}
        )

        # Rebuild settings.json from scratch on every install: the old
        # file is never read or merged, so runtime keys pi wrote back
        # (theme, lastChangelogVersion, ...) are intentionally dropped.
        # defaultProvider/defaultModel derive from [defaults].model
        # ("Provider/model" format, typically {env:ZOO_WHALE_MODEL}).
        defaults_model = None
        defaults = toml_data.get("defaults")
        if isinstance(defaults, dict):
            defaults_model = defaults.get("model")
        pi_settings = build_pi_settings(
            pi_extension_path,
            defaults_model,
            env,
            pi_provider_names=list(zk_providers),
        )
        os.makedirs(os.path.dirname(pi_settings_path), exist_ok=True)
        try:
            write_json(pi_settings_path, pi_settings)
            info("✓ Pi 扩展: src/pi.ts")
        except OSError as e:
            warn(f"写入 Pi 设置失败: {e}")

        # ── Pi provider — models.json (silent generation, no success message) ─
        # Read existing models.json (treat missing/invalid as empty dict)
        pi_models = load_json_or_empty(
            pi_models_path, "读取 Pi models.json 失败"
        )

        pi_models.setdefault("providers", {})

        # Prune: remove ZooKeeper-managed providers that appear in config.toml
        # but were filtered out this run (e.g. env vars missing).  User-defined
        # providers (not in all_provider_names) are preserved.
        for name in list(pi_models["providers"]):
            if name in all_provider_names and name not in zk_providers:
                del pi_models["providers"][name]

        # Merge: ZooKeeper providers overwrite by name, preserve others
        merged_providers = {**pi_models["providers"], **zk_providers}
        pi_models["providers"] = merged_providers
        os.makedirs(os.path.dirname(pi_models_path), exist_ok=True)
        try:
            write_json(pi_models_path, pi_models)
            if not zk_providers:
                warn("未找到可用的 provider 配置（已清理残留条目）")
        except OSError as e:
            warn(f"写入 Pi models.json 失败: {e}")

    # ── Validate configs ─────────────────────────────────────────────
    header("验证配置")
    if has_opencode:
        for cfg_path, label in [
            (opencode_json, "opencode.json"),
            (tui_jsonc, "tui.jsonc"),
        ]:
            try:
                with open(cfg_path, encoding="utf-8") as f:
                    json.load(f)
                info(f"✓ {label} 格式校验通过")
            except json.JSONDecodeError as e:
                error(f"{label} 格式无效: {e}")
                sys.exit(1)

    if has_pi:
        for label, pi_path in [
            ("settings.json", pi_settings_path),
            ("models.json", pi_models_path),
        ]:
            try:
                with open(pi_path, encoding="utf-8") as f:
                    json.load(f)
                info(f"✓ {label} 格式校验通过")
            except json.JSONDecodeError as e:
                error(f"{label} 格式无效: {e}")
                sys.exit(1)

    # ── Installation complete ────────────────────────────────────────
    header("安装完成")
    # Persist the final selected mode so the next flag-less run reuses
    # it; a write failure warns but must not abort the installation.
    if profile is not None and write_mode_state(profile["name"]):
        info(f"✓ 模式状态已保存: {mode_state_path()} → {profile['name']}")
    if has_opencode:
        info(f"✅ 配置已写入: {opencode_json}")
        info(f"✅ TUI 配置已写入: {tui_jsonc}")
        if variant_model_json:
            info(f"✅ 模型 variants 已写入: {variant_model_json}")
    if has_pi:
        info(f"✅ 配置已写入: {pi_settings_path}, {pi_models_path}")

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
                            core_dir = os.path.join(
                                wiki_root, target.rstrip("/")
                            )
                            break
                    if core_dir is None:
                        warn("zwiki.lock 中未找到团队 bundle 条目，跳过软链接")
                except (tomllib.TOMLDecodeError, KeyError, TypeError) as e:
                    warn(f"zwiki.lock 解析失败，跳过软链接: {e}")
            if core_dir is not None:
                for name in ["SCHEMA.md", "templates"]:
                    src = os.path.join(core_dir, name)
                    dst = os.path.join(wiki_root, name)
                    if not os.path.exists(src):
                        warn(f"源路径不存在，跳过: {src}")
                        continue
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

    # ── Tail tips ────────────────────────────────────────────────────
    if has_opencode or has_pi:
        print("")
    if has_opencode:
        print(f"  {bold('查看:')}  opencode config --path")
        print(f"  {bold('验证:')}  opencode config --json")
        print(f"  {bold('状态:')}  状态缓存已清理，需重启 opencode")
    if has_pi:
        print(f"  {bold('验证:')}  pi --list-models")
    print(
        f"  {bold('.env:')}  参考 {os.path.join(SCRIPT_DIR, '.env.example')}"
    )
    if has_opencode or has_pi:
        print("")


if __name__ == "__main__":
    main()
