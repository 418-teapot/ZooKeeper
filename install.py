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
from typing import Optional

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
        if not m:
            return obj
        var_name = m.group(1)
        resolved = env.get(var_name)
        if resolved is None:
            error(
                f"变量 {var_name} 未在 .env 中设置！"
                f'请在 .env 文件中添加 {var_name}="..."（参考 .env.example）'
            )
            sys.exit(1)
        return resolved
    return obj


def _filter_missing_providers(toml_data: dict, env: dict[str, str]) -> None:
    """Remove provider entries whose credential env vars are not set.

    Scans each ``provider.<name>.options`` sub-dict for ``{env:VAR}``
    references.  If any referenced variable is missing from *env*,
    the entire provider entry is removed from *toml_data* and a warning is
    printed to stderr.

    Args:
        toml_data: The parsed TOML dictionary (mutated in-place).
        env: The environment variable dictionary (from parse_env_file).
    """
    providers = toml_data.get("provider")
    if not isinstance(providers, dict):
        return

    to_remove: list[str] = []
    for prov_name, prov_data in providers.items():
        if not isinstance(prov_data, dict):
            continue
        options = prov_data.get("options")
        if not isinstance(options, dict):
            continue
        missing: list[str] = []
        for value in options.values():
            if not isinstance(value, str):
                continue
            m = _ENV_REF_RE.match(value.strip())
            if m is not None and m.group(1) not in env:
                missing.append(m.group(1))
        if missing:
            warn(f"provider.{prov_name} 的环境变量未配置，跳过")
            to_remove.append(prov_name)

    for prov_name in to_remove:
        del providers[prov_name]


def build_config(
    toml_data: dict, project_dir: str, env: dict[str, str]
) -> dict:
    """Convert parsed TOML data into the OpenCode JSON configuration.

    Fields in the [defaults] section are promoted to the top-level of the config.
    All {env:} placeholders are resolved to actual values from the env dict.
    Providers with missing credentials are already filtered out by the caller.

    Args:
        toml_data: The dictionary returned by parse_toml() (providers already filtered).
        project_dir: The project root directory path, used to locate plugin files.
        env: The environment variable dictionary (from parse_env_file).

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
    if "agent" in toml_data:
        config["agent"] = toml_data["agent"]
    if "defaults" in toml_data:
        for k, v in toml_data["defaults"].items():
            config[k] = v

    return resolve_env_refs_deep(config, env)


def _npm_to_api_type(npm: str) -> Optional[str]:
    """Infer pi ``api`` type from the ``@ai-sdk/*`` npm package name.

    All ZooKeeper providers use ``@ai-sdk/*`` packages.  The mapping is:

    * ``@ai-sdk/anthropic`` → ``anthropic-messages``
    * ``@ai-sdk/openai-compatible`` → ``openai-completions``

    .. note::
       This inference assumes the endpoint protocol matches the SDK.
       If a provider actually uses a different protocol, the user can
       override ``api`` manually in the resulting ``models.json``.

    Args:
        npm: The npm package name from ``[provider.*].npm``.

    Returns:
        The pi ``api`` type string, or ``None`` if unrecognised.
    """
    npm_lower = npm.lower()
    if "anthropic" in npm_lower:
        return "anthropic-messages"
    if "openai" in npm_lower:
        return "openai-completions"
    return None


def _convert_provider_to_pi(prov_name: str, prov_data: dict) -> Optional[dict]:
    """Convert a single ZooKeeper provider entry to pi ``models.json`` format.

    Args:
        prov_name: The provider name (key under ``[provider]``).
        prov_data: The parsed TOML dictionary for this provider.

    Returns:
        A dictionary in pi ``models.json`` ``providers`` entry format, or
        ``None`` if the provider should be skipped (e.g. unrecognised
        ``npm`` type).
    """
    npm = prov_data.get("npm", "")
    if not isinstance(npm, str):
        warn(f"provider.{prov_name} 缺少 npm 字段，跳过")
        return None

    api_type = _npm_to_api_type(npm)
    if api_type is None:
        warn(f"provider.{prov_name} 的 npm 类型无法识别 ('{npm}')，跳过")
        return None

    options = prov_data.get("options", {})
    if not isinstance(options, dict):
        options = {}

    base_url = options.get("baseURL", "")

    # Strip trailing /v1 for anthropic-messages providers.
    #
    # pi's anthropic-messages API expects the baseUrl without the /v1
    # suffix (pi appends the path itself), while OpenCode's
    # @ai-sdk/anthropic can handle the /v1 suffix.
    # OpenAI-compatible endpoints (openai-completions) expect the /v1
    # suffix, so they are left unchanged.
    if api_type == "anthropic-messages":
        base_url = base_url.rstrip("/")
        if base_url.endswith("/v1"):
            base_url = base_url[:-3]

    api_key = options.get("apiKey", "")

    headers = options.get("headers", {})
    if not isinstance(headers, dict):
        headers = {}

    # Convert models
    models_raw = prov_data.get("models", {})
    if not isinstance(models_raw, dict):
        models_raw = {}

    models_list: list[dict] = []
    for model_id, model_data in models_raw.items():
        if not isinstance(model_data, dict):
            continue

        entry: dict[str, object] = {
            "id": model_data.get("id", model_id),
            "name": model_data.get("name", model_id),
        }

        # Reasoning — only emit when explicitly true; pi defaults to false
        if model_data.get("reasoning") is True:
            entry["reasoning"] = True

        # Limit → contextWindow / maxTokens
        limit = model_data.get("limit")
        if isinstance(limit, dict):
            if "context" in limit:
                entry["contextWindow"] = limit["context"]
            if "output" in limit:
                entry["maxTokens"] = limit["output"]

        # Cost (with snake_case → camelCase rename)
        cost = model_data.get("cost")
        if isinstance(cost, dict):
            # pi's models.json schema requires all four cost fields present.
            # Missing fields default to 0 so config.toml entries that only
            # declare input/output still produce a schema-valid cost object.
            cost_entry: dict[str, object] = {
                "input": cost.get("input", 0),
                "output": cost.get("output", 0),
                "cacheRead": cost.get("cache_read", 0),
                "cacheWrite": cost.get("cache_write", 0),
            }
            entry["cost"] = cost_entry

        models_list.append(entry)

    return {
        "baseUrl": base_url,
        "api": api_type,
        "apiKey": api_key,
        "headers": headers,
        "models": models_list,
    }


def build_pi_models_config(toml_data: dict, env: dict[str, str]) -> dict:
    """Build the pi ``models.json`` configuration from ZooKeeper provider definitions.

    Providers whose credential env vars are not set are already filtered out
    by ``_filter_missing_providers``.  Any remaining ``{env:VAR}`` placeholders
    are resolved to plaintext values from *env*.

    Args:
        toml_data: The parsed TOML dictionary (providers already filtered).
        env: The environment variable dictionary (from ``parse_env_file``).

    Returns:
        A dictionary with a ``providers`` key, ready to be merged into
        ``~/.pi/agent/models.json``, with all ``{env:VAR}`` references resolved.
    """
    providers = toml_data.get("provider", {})
    if not isinstance(providers, dict):
        return {"providers": {}}

    pi_providers: dict[str, dict] = {}
    for prov_name, prov_data in providers.items():
        if not isinstance(prov_data, dict):
            continue
        # Resolve {env:...} references first so that _convert_provider_to_pi
        # sees the actual base URLs and can apply anthropic-messages /v1
        # stripping correctly.
        prov_data_resolved = resolve_env_refs_deep(prov_data, env)
        converted = _convert_provider_to_pi(prov_name, prov_data_resolved)
        if converted is not None:
            pi_providers[prov_name] = converted

    return {"providers": pi_providers}


def main() -> None:
    """Main entry point: load configuration, back up existing files, generate configs, validate, and install."""
    SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

    # Parse .env (must happen before {env:} resolution)
    env = parse_env_file(os.path.join(SCRIPT_DIR, ".env"))

    toml_path = os.path.abspath(
        sys.argv[1]
        if len(sys.argv) > 1
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
    # _filter_missing_providers mutates toml_data (called below in the
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
            if os.path.isfile(cfg_path):
                backup_path = (
                    f"{cfg_path}.bak.{datetime.now().strftime('%Y%m%d%H%M%S')}"
                )
                shutil.copy2(cfg_path, backup_path)
                info(f"✓ 已备份: {label} → {backup_path}")
            else:
                info(f"✓ 无已有 {label}")

    if has_pi:
        any_backup = False
        for pi_path in [pi_settings_path, pi_models_path]:
            if os.path.isfile(pi_path):
                backup_path = (
                    f"{pi_path}.bak.{datetime.now().strftime('%Y%m%d%H%M%S')}"
                )
                shutil.copy2(pi_path, backup_path)
                info(f"✓ 已备份: {backup_path}")
                any_backup = True
        if not any_backup:
            info("✓ 无已有配置")

    # ── Generate configs ─────────────────────────────────────────────
    header("生成配置")

    # Filter providers once at top level (before any config generation),
    # regardless of which host tools are available.  warn messages
    # appear inside this section; both OpenCode and Pi use the filtered
    # toml_data.
    _filter_missing_providers(toml_data, env)

    if has_opencode:
        os.makedirs(opencode_dir, exist_ok=True)
        config = build_config(toml_data, SCRIPT_DIR, env)
        with open(opencode_json, "w", encoding="utf-8") as f:
            json.dump(config, f, indent=2, ensure_ascii=False)
            f.write("\n")

        # ── TUI plugin — tui.jsonc (overwrite; ZooKeeper is the only
        # TUI plugin in this setup) ─────────────────────────────────
        tui_plugin_entry = "file://" + os.path.abspath(
            os.path.join(SCRIPT_DIR, "src", "opencode-tui.tsx")
        )
        tui_data = {"plugin": [tui_plugin_entry]}
        with open(tui_jsonc, "w", encoding="utf-8") as f:
            json.dump(tui_data, f, indent=2, ensure_ascii=False)
            f.write("\n")
        info("✓ TUI 扩展: src/opencode-tui.tsx")

    if has_pi:
        # ── Pi extension — settings.json extensions array ────────────
        pi_extension_path = os.path.abspath(
            os.path.join(SCRIPT_DIR, "src", "pi.ts")
        )

        # Read existing settings.json (treat missing/invalid as empty dict)
        pi_settings: dict = {}
        if os.path.isfile(pi_settings_path):
            try:
                with open(pi_settings_path, encoding="utf-8") as f:
                    pi_settings = json.load(f)
            except (json.JSONDecodeError, OSError) as e:
                warn(f"读取 Pi 设置失败: {e}")
                pi_settings = {}

        # Overwrite extensions array with the single ZK extension path.
        # This is a full replacement (not append/merge) to ensure a
        # single canonical entry.  Other settings fields are preserved.
        pi_settings["extensions"] = [pi_extension_path]
        os.makedirs(os.path.dirname(pi_settings_path), exist_ok=True)
        try:
            with open(pi_settings_path, "w", encoding="utf-8") as f:
                json.dump(pi_settings, f, indent=2, ensure_ascii=False)
                f.write("\n")
            info("✓ Pi 扩展: src/pi.ts")
        except OSError as e:
            warn(f"写入 Pi 设置失败: {e}")

        # ── Pi provider — models.json (silent generation, no success message) ─
        zk_providers = build_pi_models_config(toml_data, env).get(
            "providers", {}
        )

        # Read existing models.json (treat missing/invalid as empty dict)
        pi_models: dict = {}
        if os.path.isfile(pi_models_path):
            try:
                with open(pi_models_path, encoding="utf-8") as f:
                    pi_models = json.load(f)
            except (json.JSONDecodeError, OSError) as e:
                warn(f"读取 Pi models.json 失败: {e}")
                pi_models = {}

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
            with open(pi_models_path, "w", encoding="utf-8") as f:
                json.dump(pi_models, f, indent=2, ensure_ascii=False)
                f.write("\n")
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
    if has_opencode:
        info(f"✅ 配置已写入: {opencode_json}")
        info(f"✅ TUI 配置已写入: {tui_jsonc}")
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
    if has_pi:
        print(f"  {bold('验证:')}  pi --list-models")
    print(
        f"  {bold('.env:')}  参考 {os.path.join(SCRIPT_DIR, '.env.example')}"
    )
    if has_opencode or has_pi:
        print("")


if __name__ == "__main__":
    main()
