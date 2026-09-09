"""Validate and translate the model-level ``thinking`` semantic field.

``config.toml`` model entries may declare ``thinking = "high" | "max" |
"none"`` to ask for extended thinking on a model.  The field is host
agnostic: each host generator translates it into its own dialect (see
``installer.opencode`` and ``installer.pi``).  An absent field is
equivalent to ``"none"`` and produces no host-side configuration.
"""

from typing import Optional

from installer.output import warn

THINKING_LEVELS = ("high", "max", "none")

# Levels that request thinking (``none`` and invalid values inject nothing).
_THINKING_ON = ("high", "max")


def validate_thinking(toml_data: dict) -> None:
    """Warn about every model entry with an invalid ``thinking`` value.

    Collects problems the same way ``installer.variants`` does: each
    offending entry produces a Chinese warning naming the entry and the
    accepted values, and the run continues.  Called once by the install
    script before any host generator runs, so a bad value is reported
    exactly no matter how many hosts are installed.

    Args:
        toml_data: The parsed TOML dictionary (providers already filtered).
    """
    providers = toml_data.get("provider")
    if not isinstance(providers, dict):
        return
    for prov_name, prov_data in providers.items():
        if not isinstance(prov_data, dict):
            continue
        models = prov_data.get("models")
        if not isinstance(models, dict):
            continue
        for model_id, model_data in models.items():
            if not isinstance(model_data, dict):
                continue
            if "thinking" not in model_data:
                continue
            label = f"provider.{prov_name}.models.{model_id}"
            level = model_data["thinking"]
            if not isinstance(level, str):
                warn(
                    f"{label} 的 thinking 必须为字符串"
                    f"（{'/'.join(THINKING_LEVELS)}），已忽略"
                )
                continue
            if level not in THINKING_LEVELS:
                warn(
                    f"{label} 的 thinking 取值无效: {level}"
                    f"（可选 {'/'.join(THINKING_LEVELS)}），已忽略"
                )


def thinking_level(model_data: dict) -> Optional[str]:
    """Read a model entry's ``thinking`` level, dropping invalid values.

    Invalid values never reach a host generator: they are reported by
    ``validate_thinking`` and treated here like ``"none"``.

    Args:
        model_data: A parsed ``[provider.*.models.*]`` table.

    Returns:
        ``"high"`` or ``"max"`` when thinking is requested, otherwise
        ``None`` (absent, ``"none"``, or invalid).
    """
    level = model_data.get("thinking")
    return level if level in _THINKING_ON else None
