"""Collect and validate [zoo.variants] model variant mappings."""

from installer.output import warn


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
        valid[key] = variant_name
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
