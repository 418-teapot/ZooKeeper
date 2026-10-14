"""pi host configuration generation from parsed TOML data."""

from typing import Optional

from installer.envfile import (
    _ENV_REF_RE,
    _ENV_REF_SEARCH_RE,
    resolve_env_refs_deep,
)
from installer.output import warn
from installer.thinking import thinking_level


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
        ``None`` if the provider should be skipped (builtin providers,
        unrecognised ``npm`` types, and providers missing ``baseURL`` or
        ``apiKey``).
    """
    # Builtin providers resolve through the host's own auth and model
    # catalog, so ZooKeeper emits no models.json entry for them.
    if prov_data.get("builtin") is True:
        return None

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

    base_url = options.get("baseURL")
    if not isinstance(base_url, str) or not base_url:
        warn(f"provider.{prov_name} 的 baseURL 缺失或无效，跳过")
        return None

    api_key = options.get("apiKey")
    if not isinstance(api_key, str) or not api_key:
        warn(f"provider.{prov_name} 的 apiKey 缺失或无效，跳过")
        return None

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
        if cost is not None and not isinstance(cost, dict):
            warn(
                f"provider.{prov_name} 的模型 {model_id} 的 cost 需为表，跳过 cost"
            )
        elif isinstance(cost, dict):
            # pi's models.json schema requires all four cost fields present.
            # A partial or non-numeric table is skipped with a warning
            # instead of guessing defaults, so config.toml stays the single
            # source of truth for pricing.  The warning names every
            # offending field so the user knows what to fix.
            cost_fields = {
                "input": cost.get("input"),
                "output": cost.get("output"),
                "cache_read": cost.get("cache_read"),
                "cache_write": cost.get("cache_write"),
            }
            invalid = [
                name
                for name, value in cost_fields.items()
                if not isinstance(value, (int, float))
                or isinstance(value, bool)
            ]
            if invalid:
                warn(
                    f"provider.{prov_name} 的模型 {model_id} 的 cost 字段 "
                    f"{'、'.join(invalid)} 缺失或不是数字，跳过 cost"
                )
            else:
                entry["cost"] = {
                    "input": cost_fields["input"],
                    "output": cost_fields["output"],
                    "cacheRead": cost_fields["cache_read"],
                    "cacheWrite": cost_fields["cache_write"],
                }

        # Thinking — pi enables it per model through compat
        # forceAdaptiveThinking (pi then sends thinking.type "adaptive"
        # plus output_config.effort, using the settings.json default
        # thinking level).  ``thinking = "none"``/absent adds nothing.
        if thinking_level(model_data) is not None:
            entry["compat"] = {"forceAdaptiveThinking": True}

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
    by ``_filter_missing_entries``.  Any remaining ``{env:VAR}`` placeholders
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


def _resolve_default_model(raw: object, env: dict[str, str]) -> Optional[str]:
    """Resolve a config.toml default-model value against the env dict.

    Handles a bare ``{env:VAR}`` placeholder (e.g.
    ``{env:ZOO_WHALE_MODEL}``), embedded references, and plain strings.
    A missing referenced variable or an empty resolved value degrades to
    ``None`` instead of aborting the install, so the caller can fall back
    to extensions-only output.

    Args:
        raw: The raw ``[defaults].model`` value from the parsed TOML.
        env: The environment variable dictionary (from ``parse_env_file``).

    Returns:
        The resolved model string, or ``None`` when the value is not a
        string, resolves to an empty/blank string, or a referenced
        variable is not set.
    """
    if not isinstance(raw, str):
        return None
    m = _ENV_REF_RE.match(raw.strip())
    if m:
        resolved = env.get(m.group(1))
    else:
        resolved = raw
        for var_name in _ENV_REF_SEARCH_RE.findall(raw):
            value = env.get(var_name)
            if value is None:
                return None
            resolved = resolved.replace(f"{{env:{var_name}}}", value)
    if resolved is None or not resolved.strip():
        return None
    return resolved


def _split_model_reference(model: str) -> Optional[tuple[str, str]]:
    """Split a ``Provider/model`` string on the first ``/``.

    Args:
        model: The resolved default-model string (e.g. ``Cambricon/glm-5.1``).

    Returns:
        A ``(provider, model_id)`` tuple with both parts stripped and
        non-empty, or ``None`` when the string is empty or lacks a
        ``/`` separator with non-empty halves.
    """
    if not model or "/" not in model:
        return None
    provider, _, model_id = model.partition("/")
    provider = provider.strip()
    model_id = model_id.strip()
    if not provider or not model_id:
        return None
    return (provider, model_id)


# Keys the installer derives itself; a value for them under [pi] is
# ignored so the installer stays the single writer of these keys.
_PI_RESERVED_KEYS = ("extensions", "defaultProvider", "defaultModel")


def build_pi_settings(
    extension_path: str,
    defaults_model: object,
    env: dict[str, str],
    pi_provider_names: Optional[list[str]] = None,
    builtin_providers: Optional[dict[str, object]] = None,
    pi_section: object = None,
    providers: Optional[dict[str, object]] = None,
) -> dict:
    """Build the pi ``settings.json`` dictionary from scratch.

    The settings file is fully rebuilt on every install: the previous file
    is never read or merged, so only the ``[pi]`` table (passed through
    verbatim), the ``extensions`` array, and the derived
    ``defaultProvider``/``defaultModel`` keys are written.  Keys pi writes
    back at runtime (theme, lastChangelogVersion, ...) are intentionally
    not preserved.

    The default provider/model derive from ``[defaults].model`` in
    config.toml (format ``Provider/model``), resolved against *env*.
    When the value is missing, unresolved, empty, or lacks a valid ``/``
    separator, a Chinese warning is printed and only the ``extensions``
    array plus the merged ``[pi]`` table are written — the install
    continues.  A provider that is absent from this run's pi providers
    (e.g. pruned for missing credentials) still gets written, with a
    warning.

    Args:
        extension_path: Absolute path to the pi extension (``src/pi.ts``).
        defaults_model: Raw value of ``[defaults].model`` from the parsed
            TOML (typically ``{env:ZOO_WHALE_MODEL}``).
        env: The environment variable dictionary (from ``parse_env_file``).
        pi_provider_names: Names of providers emitted in this run's
            ``models.json``; used to warn when the default provider was
            filtered out.
        builtin_providers: Mapping of builtin provider names to their raw
            ``pi_id`` value.  When the default provider is builtin with a
            non-empty string ``pi_id``, that id is written and no
            pruned-provider warning is emitted; a builtin provider whose
            ``pi_id`` is missing or empty is skipped with a warning.
        pi_section: The whole ``[pi]`` table from the parsed TOML.  A
            dict is merged verbatim into the settings so new pi options
            need no code change here; a missing value merges nothing;
            any other value is skipped with a warning (fail-closed).
            Values for the installer-managed keys (``extensions``,
            ``defaultProvider``, ``defaultModel``) are ignored with a
            warning so the derived values always win.
        providers: The raw ``[provider]`` table from the parsed TOML.
            When given and the default provider is present, the model
            half of the ``Provider/model`` reference is resolved through
            that provider's ``models`` table to the registry ``id`` (the
            key pi's ``models.json`` uses), falling back to the table
            key when no ``id`` field is present.  A provider present but
            missing the model key, or a non-string ``id``, skips the
            default fields with a warning (fail-closed).

    Returns:
        The settings dictionary.  Always contains ``extensions``; every
        non-reserved key of ``pi_section`` is merged verbatim;
        ``defaultProvider``/``defaultModel`` are added only when the
        default model resolves and splits cleanly.
    """
    settings: dict[str, object] = {"extensions": [extension_path]}

    # The [pi] table is independent of the default model, so it is merged
    # before the early returns below.  It is passed through verbatim:
    # interpreting individual keys here would force a code change
    # whenever a new pi option is added to config.toml.
    if isinstance(pi_section, dict):
        for reserved in _PI_RESERVED_KEYS:
            if reserved in pi_section:
                warn(f"pi.{reserved} 由安装器管理，配置值被忽略")
        settings.update(
            {
                key: value
                for key, value in pi_section.items()
                if key not in _PI_RESERVED_KEYS
            }
        )
    elif pi_section is not None:
        warn(f"pi 节值 {pi_section!r} 无效（需为表），跳过")

    resolved = _resolve_default_model(defaults_model, env)
    if resolved is None:
        warn(
            "defaults.model 缺失、不是字符串、解析后为空"
            "或引用的环境变量未设置，跳过 defaultProvider/defaultModel"
        )
        return settings

    split = _split_model_reference(resolved)
    if split is None:
        warn(
            f"defaults.model 值 '{resolved}' 无效"
            "（空或缺少 '/' 分隔），跳过 defaultProvider/defaultModel"
        )
        return settings

    provider, model_key = split
    model_id = model_key

    # Resolve the registry model id through the provider's models table:
    # models.json registers models by their ``id`` field, which may
    # differ from the table key used in the ``Provider/model`` reference
    # (e.g. key ``qwen3.8-max`` → id ``aliyun/qwen3.8-max``).
    prov_table = (
        providers.get(provider) if isinstance(providers, dict) else None
    )
    if isinstance(prov_table, dict):
        models = prov_table.get("models")
        model_data = (
            models.get(model_key) if isinstance(models, dict) else None
        )
        if not isinstance(model_data, dict):
            warn(
                f"默认模型 key '{model_key}' 不在 provider '{provider}'"
                " 的 models 下，跳过 defaultProvider/defaultModel"
            )
            return settings
        registry_id = model_data.get("id", model_key)
        if not isinstance(registry_id, str) or not registry_id:
            warn(
                f"默认模型 '{provider}/{model_key}' 的 id 字段不是字符串"
                "，跳过 defaultProvider/defaultModel"
            )
            return settings
        model_id = registry_id

    builtin_map = builtin_providers or {}
    if provider in builtin_map:
        pi_id = builtin_map[provider]
        if not isinstance(pi_id, str) or not pi_id:
            warn(
                f"默认模型 provider '{provider}' 是内置 provider"
                "但缺少 pi_id 字段，跳过 defaultProvider/defaultModel"
            )
            return settings
        provider = pi_id
    elif pi_provider_names is not None and provider not in pi_provider_names:
        warn(
            f"默认模型 provider '{provider}' 不在本次生成的 pi providers 中"
            "（可能因凭据缺失被跳过），仍写入 defaultProvider/defaultModel"
        )
    settings["defaultProvider"] = provider
    settings["defaultModel"] = model_id
    return settings


def build_pi_agents_config(toml_data: dict, env: dict[str, str]) -> dict:
    """Build the pi ``agents.json`` per-agent resolved configuration.

    Each ``[agent.<name>].model`` value is resolved against *env*: a bare
    ``{env:VAR}`` placeholder or a plain literal is turned into a
    ``Provider/model`` reference, then split on the first ``/``.  The
    provider half names a ``[provider.*]`` table; the model half names a
    key inside that provider's ``models`` table.  The registry id comes
    from that model table's ``id`` field (the key pi's ``models.json``
    uses), falling back to the model table key itself when no ``id``
    field is present.  Each entry is emitted as a ``{"provider",
    "model"}`` pair.

    Semantics match the other pi artifacts (fail-closed): an agent is
    omitted when its ``model`` field is absent, the resolved value is
    empty/blank, the referenced environment variable is not set, the
    provider is absent from ``[provider]``, the model key is absent from
    that provider's ``models``, or the ``id`` field is not a string.
    Omitted agents are reported with a Chinese warning.

    Args:
        toml_data: The parsed TOML dictionary.
        env: The environment variable dictionary (from ``parse_env_file``).

    Returns:
        A dictionary with an ``agents`` key mapping each resolvable agent
        name to ``{"provider": "<provider>", "model": "<registry-id>"}``.
    """
    agents = toml_data.get("agent")
    if not isinstance(agents, dict):
        return {"agents": {}}

    providers = toml_data.get("provider")
    if not isinstance(providers, dict):
        providers = {}

    resolved_agents: dict[str, dict[str, str]] = {}
    for name, agent_data in agents.items():
        if not isinstance(agent_data, dict):
            continue
        raw_model = agent_data.get("model")
        if not isinstance(raw_model, str):
            continue
        resolved = _resolve_default_model(raw_model, env)
        if resolved is None:
            warn(f"agent.{name} 的 model 缺失或解析后为空，跳过")
            continue
        split = _split_model_reference(resolved)
        if split is None:
            warn(
                f"agent.{name} 的 model 值 '{resolved}' 无效"
                "（空或缺少 '/' 分隔），跳过"
            )
            continue

        provider, model_key = split
        provider_data = providers.get(provider)
        if not isinstance(provider_data, dict):
            warn(
                f"agent.{name} 的 provider '{provider}' 不在 [provider] 中"
                f"（来自 model 值 '{resolved}'），跳过"
            )
            continue
        models = provider_data.get("models")
        if not isinstance(models, dict):
            warn(
                f"agent.{name} 的 provider '{provider}' 没有 models 表"
                f"（来自 model 值 '{resolved}'），跳过"
            )
            continue
        model_data = models.get(model_key)
        if not isinstance(model_data, dict):
            warn(
                f"agent.{name} 的模型 key '{model_key}' 不在 provider"
                f" '{provider}' 的 models 下（来自 model 值 '{resolved}'），跳过"
            )
            continue

        model_id = model_data.get("id", model_key)
        if not isinstance(model_id, str):
            warn(
                f"agent.{name} 的模型 '{provider}/{model_key}' id 字段不是字符串，跳过"
            )
            continue

        # Builtin providers are referenced by their pi provider id; the
        # validation above still applies so agent references are checked.
        resolved_provider = provider
        if provider_data.get("builtin") is True:
            pi_id = provider_data.get("pi_id")
            if not isinstance(pi_id, str) or not pi_id:
                warn(
                    f"agent.{name} 的 provider '{provider}' 是内置 provider"
                    "但缺少 pi_id 字段，跳过"
                )
                continue
            resolved_provider = pi_id

        resolved_agents[name] = {
            "provider": resolved_provider,
            "model": model_id,
        }

    return {"agents": resolved_agents}
