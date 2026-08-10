"""Persistent mode-selection state file helpers (~/.zoo/mode.json).

The installer records the selected ``[zoo.mode.*]`` profile name in a
small JSON state file.  The file is write-only for the installer: it is
consumed by the TS runtime (OpenCode / pi plugins) to pick the active
profile when config.toml declares more than one.
"""

import json
import os
from typing import Optional

from installer.output import warn


def mode_state_path() -> str:
    """Return the default mode-state file path (``~/.zoo/mode.json``).

    Returns:
        The absolute path of the mode-state file under the user's home.
    """
    return os.path.join(os.path.expanduser("~"), ".zoo", "mode.json")


def write_mode_state(mode: str, path: Optional[str] = None) -> bool:
    """Persist *mode* as ``{"mode": mode}`` into the mode-state file.

    Creates the parent directory when needed.  A write failure prints a
    Chinese warning and returns ``False`` so the caller can continue.

    Args:
        mode: The mode name to store.
        path: Mode-state file path; defaults to ``~/.zoo/mode.json``.

    Returns:
        ``True`` when the write succeeded, ``False`` otherwise.
    """
    state_path = path or mode_state_path()
    try:
        os.makedirs(os.path.dirname(state_path), exist_ok=True)
        with open(state_path, "w", encoding="utf-8") as f:
            json.dump({"mode": mode}, f, indent=2, ensure_ascii=False)
            f.write("\n")
    except OSError as e:
        warn(f"写入模式状态文件失败: {state_path}: {e}")
        return False
    return True
