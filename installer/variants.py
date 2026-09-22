"""Collect and validate [zoo.variants] model variant mappings."""

from installer.output import warn


def builtin_providers(toml_data: dict) -> dict[str, dict]:
    """Return the ``[provider.*]`` tables marked ``builtin = true``.

    A builtin provider is served by the host's own catalog and login
    state, so the installer emits no definition for it.  Model
    references written with the config provider name must be rewritten
    to the host id when a host file is generated.

    Args:
        toml_data: The parsed TOML dictionary from ``parse_toml``.

    Returns:
        A dict mapping each builtin provider's config name to its table.
    """
    providers = toml_data.get("provider")
    if not isinstance(providers, dict):
        return {}
    return {
        name: data
        for name, data in providers.items()
        if isinstance(data, dict) and data.get("builtin") is True
    }


def rewrite_builtin_ref(model: object, builtin: dict[str, dict]) -> object:
    """Rewrite the provider segment of a host model reference.

    When *model* has the form ``"Provider/model"`` and *Provider* names
    a builtin provider, the segment is replaced by that provider's
    ``opencode_id`` so the host resolves its own builtin entry.  A
    builtin provider without a string ``opencode_id`` keeps the original
    reference and warns in Chinese.  Any other value passes through
    unchanged.

    Args:
        model: The model reference to rewrite (any type).
        builtin: The builtin provider tables from :func:`builtin_providers`.

    Returns:
        The rewritten reference, or *model* unchanged.
    """
    if not isinstance(model, str):
        return model
    provider, sep, rest = model.partition("/")
    if not sep or not provider or not rest:
        return model
    data = builtin.get(provider)
    if not isinstance(data, dict):
        return model
    opencode_id = data.get("opencode_id")
    if not isinstance(opencode_id, str) or not opencode_id:
        warn(
            f"builtin provider {provider} 缺少 opencode_id，"
            f"模型引用 {model} 保持原值"
        )
        return model
    return f"{opencode_id}/{rest}"


def _validate_variant_key(
    key: object,
    variant_name: object,
    providers: dict,
    context_label: str,
) -> bool:
    """Validate a ``"Provider/model"`` variant key and its value.

    Checks the key format, the provider existence, the model existence,
    and the variant value in order; each failing aspect produces a
    Chinese warning prefixed with *context_label*.  Used by both the
    global variant channel and the per-agent variant channel.

    Args:
        key: The variant key to validate.
        variant_name: The variant value to validate.
        providers: The ``[provider]`` section of the parsed TOML.
        context_label: Chinese label prefixing warning messages
            (e.g. ``"zoo.variants"`` or ``"zoo.variants.<agent>"``).

    Returns:
        ``True`` when the entry is valid, ``False`` otherwise.
    """
    parts = key.split("/") if isinstance(key, str) else []
    if len(parts) != 2 or not parts[0] or not parts[1]:
        warn(
            f'{context_label} 键格式无效（应为 "Provider/model"）: {key}，跳过'
        )
        return False
    provider, model = parts
    prov_data = providers.get(provider)
    if not isinstance(prov_data, dict):
        warn(f"{context_label} 中 provider 不存在: {provider}（{key}），跳过")
        return False
    models = prov_data.get("models")
    if not isinstance(models, dict) or model not in models:
        warn(f"{context_label} 中模型不存在: {model}（{key}），跳过")
        return False
    if not isinstance(variant_name, str) or not variant_name:
        warn(f"{context_label} 的 variant 名为空或非字符串（{key}），跳过")
        return False
    return True


def collect_variants(toml_data: dict) -> dict[str, str]:
    """Collect and validate the ``[zoo.variants]`` mapping for opencode model.json.

    Each key must have the form ``"Provider/model"`` where *Provider* matches
    a declared ``[provider.*]`` section and *model* matches one of that
    provider's declared models.  Invalid entries are skipped with a warning.

    Args:
        toml_data: The parsed TOML dictionary from ``parse_toml``.

    Returns:
        A dict of validated ``"Provider/model"`` → variant name mappings.
    """
    zoo = toml_data.get("zoo")
    if not isinstance(zoo, dict):
        return {}
    variants = zoo.get("variants")
    if not isinstance(variants, dict):
        return {}

    providers = toml_data.get("provider", {})
    if not isinstance(providers, dict):
        return {}

    valid: dict[str, str] = {}
    builtin = builtin_providers(toml_data)
    for key, variant_name in variants.items():
        if isinstance(variant_name, dict):
            # Per-agent subtable ([zoo.variants.<agent>]); collected
            # separately by collect_agent_variants for the per-agent channel.
            continue
        if not isinstance(variant_name, str):
            warn(f"zoo.variants 条目 {key} 的值既非字符串也非子表，跳过")
            continue
        if not _validate_variant_key(
            key, variant_name, providers, "zoo.variants"
        ):
            continue
        # The returned mapping is written to the host state cache, so its
        # keys must use the host reference format (builtin provider ids).
        valid[str(rewrite_builtin_ref(key, builtin))] = variant_name
    return valid


def collect_agent_variants(toml_data: dict) -> dict[str, dict[str, str]]:
    """Collect and validate per-agent ``[zoo.variants.<agent>]`` subtables.

    Each subtable name must match a declared ``[agent.*]`` section; an
    unknown agent name skips the whole subtable with a warning.  Within a
    subtable, every model key must have the form ``"Provider/model"`` where
    *Provider* matches a declared ``[provider.*]`` section and *model*
    matches one of that provider's declared models; the variant value must
    be a non-empty string.  Invalid entries are skipped with a warning.
    Flat ``"Provider/model" = variant`` entries belong to the global channel
    (``collect_variants``) and are ignored here.

    Args:
        toml_data: The parsed TOML dictionary from ``parse_toml``.

    Returns:
        A dict mapping agent name → validated ``"Provider/model"`` →
        variant name mappings.
    """
    zoo = toml_data.get("zoo")
    if not isinstance(zoo, dict):
        return {}
    variants = zoo.get("variants")
    if not isinstance(variants, dict):
        return {}
    agents = toml_data.get("agent")
    if not isinstance(agents, dict):
        return {}
    providers = toml_data.get("provider")
    if not isinstance(providers, dict):
        return {}

    valid: dict[str, dict[str, str]] = {}
    for agent_name, subtable in variants.items():
        if not isinstance(subtable, dict):
            continue
        if agent_name not in agents:
            warn(f"zoo.variants.{agent_name} 不是已声明的 agent，跳过整个子表")
            continue
        context_label = f"zoo.variants.{agent_name}"
        valid_sub: dict[str, str] = {}
        for key, variant_name in subtable.items():
            if not _validate_variant_key(
                key, variant_name, providers, context_label
            ):
                continue
            valid_sub[key] = variant_name
        valid[agent_name] = valid_sub
    return valid
