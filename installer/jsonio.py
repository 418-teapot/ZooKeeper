"""JSON file read/write helpers shared across the installer."""

import json
import os
from typing import Any

from installer.output import warn


def write_json(path: str, data: Any) -> None:
    """Serialize *data* as pretty-printed JSON into *path*.

    Uses a 2-space indent, keeps non-ASCII characters unescaped, and
    ends the file with a trailing newline.

    Args:
        path: Destination file path.
        data: The object to serialize.
    """
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


def load_json_or_empty(path: str, fail_label: str) -> dict[str, Any]:
    """Load JSON from *path*, falling back to an empty dict on any error.

    Args:
        path: Path to the JSON file.
        fail_label: Chinese failure-message prefix; the error detail is
            appended after ``": "`` when the file cannot be parsed.

    Returns:
        The parsed dictionary, or ``{}`` when the file is missing or invalid.
    """
    data: dict[str, Any] = {}
    if os.path.isfile(path):
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            warn(f"{fail_label}: {e}")
            data = {}
    return data
