"""Centralized config backups with per-source rotation (~/.zoo/backups).

All host configuration backups are stored under ``~/.zoo/backups/<host>/``
and named ``<basename>.bak.<YYYYmmddHHMMSS>``.  Each source file keeps at
most ``BACKUP_KEEP`` backups: after writing a new one, older copies are
pruned.  No ``.bak`` files are ever written next to the source files.
"""

import glob
import os
import shutil
from datetime import datetime
from typing import Optional

from installer.output import warn

BACKUP_KEEP = 10


def backups_root() -> str:
    """Return the default backup root directory (``~/.zoo/backups``).

    Returns:
        The absolute path of the backup root under the user's home.
    """
    return os.path.join(os.path.expanduser("~"), ".zoo", "backups")


def _host_backup_dir(host: str, root: Optional[str] = None) -> str:
    """Return the backup directory for *host* under the backup root.

    Args:
        host: Host name, e.g. ``"opencode"`` or ``"pi"``.
        root: Backup root directory; defaults to ``~/.zoo/backups``.

    Returns:
        The per-host backup directory path (``<root>/<host>``).
    """
    return os.path.join(root or backups_root(), host)


def backup_file(
    src_path: str,
    host: str,
    root: Optional[str] = None,
    timestamp: Optional[str] = None,
) -> Optional[str]:
    """Back up *src_path* into the centralized per-host backup directory.

    Only existing source files are backed up; a missing source file
    returns ``None`` without creating anything.  The backup is stored as
    ``<root>/<host>/<basename>.bak.<timestamp>``.

    Args:
        src_path: Path of the source file to back up.
        host: Host name used for the subdirectory, e.g. ``"opencode"``.
        root: Backup root directory; defaults to ``~/.zoo/backups``.
        timestamp: Backup timestamp suffix; defaults to the current time
            formatted as ``%Y%m%d%H%M%S``.

    Returns:
        The path of the created backup, or ``None`` when the source file
        does not exist.
    """
    if not os.path.isfile(src_path):
        return None
    stamp = timestamp or datetime.now().strftime("%Y%m%d%H%M%S")
    dest_dir = _host_backup_dir(host, root=root)
    os.makedirs(dest_dir, exist_ok=True)
    dest_path = os.path.join(
        dest_dir, f"{os.path.basename(src_path)}.bak.{stamp}"
    )
    shutil.copy2(src_path, dest_path)
    return dest_path


def prune_backups(
    src_path: str,
    host: str,
    root: Optional[str] = None,
    keep: int = BACKUP_KEEP,
) -> int:
    """Delete the oldest backups of *src_path* beyond the newest *keep*.

    Backups are matched as ``<basename>.bak.*`` inside the per-host backup
    directory; the timestamp suffix makes string order equal to time order,
    so the newest *keep* files are retained and older ones are removed.
    A failed removal prints a Chinese warning and does not abort.

    Args:
        src_path: Path of the source file whose backups are pruned.
        host: Host name used for the subdirectory, e.g. ``"opencode"``.
        root: Backup root directory; defaults to ``~/.zoo/backups``.
        keep: Maximum number of backups to retain.

    Returns:
        The number of backup files removed.
    """
    pattern = os.path.join(
        _host_backup_dir(host, root=root),
        f"{os.path.basename(src_path)}.bak.*",
    )
    backups = sorted(glob.glob(pattern))
    if len(backups) <= keep:
        return 0
    stale = backups[: len(backups) - keep]
    removed = 0
    for path in stale:
        try:
            os.remove(path)
            removed += 1
        except OSError as e:
            warn(f"删除旧备份失败: {path}: {e}")
    return removed
