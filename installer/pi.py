"""pi host configuration generation from parsed TOML data."""

from typing import Optional

from installer.envfile import resolve_env_refs_deep
from installer.output import warn


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
