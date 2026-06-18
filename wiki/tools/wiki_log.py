#!/usr/bin/env python3
"""
wiki_log.py — Prepend a structured log entry to the top of ``wiki/log.md``.

Called by agents (LLM tool calls) whenever a wiki mutation happens.
Prepends a heading-line log entry at the top of log.md, immediately after
the ``---`` separator.

Entry format::

    ## [YYYY-MM-DD] <op> | <path> | <action> — <note>

Valid ``--op`` values: ingest, update, delete, query, health, lint, heal,
refresh, tool.
Valid ``--action`` values: create, edit, delete, pass, fail.

Usage::

    python3 wiki/tools/wiki_log.py \\
        --op ingest --path "concepts/test.md" --action create --note "test note"
"""

from __future__ import annotations

import argparse
import sys
from datetime import date
from pathlib import Path

# ZooKeeper: wiki_log.py is at wiki/tools/wiki_log.py
# 3 levels up: tools/ -> wiki/ -> repo root
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
# Wiki is accessed via the user-global ~/.zoo/wiki symlink.
WIKI_DIR = (Path.home() / ".zoo" / "wiki").resolve()
LOG_FILE = WIKI_DIR / "log.md"

LOG_HEADER = """\
# Wiki Change Log

> Heading-line 格式日志，每条记录是一个 Markdown 二级标题。
> Grep-parseable: grep "^## \\[" wiki/log.md | head -5
> 按时间倒序排列（最新在最上）。

---
"""

VALID_OPS = [
    "ingest",
    "update",
    "delete",
    "query",
    "health",
    "lint",
    "heal",
    "refresh",
    "tool",
]
VALID_ACTIONS = ["create", "edit", "delete", "pass", "fail"]


def _normalize_path(path: str) -> str:
    """Strip the ``wiki/`` prefix if present.

    Returns a wiki-root-relative path (consistent with how ``health.py``
    parses log entries via ``_parse_log_entries``).

    Args:
        path: The raw path string, possibly starting with ``wiki/``.

    Returns:
        The path with ``wiki/`` prefix stripped if it was present.
    """
    if path.startswith("wiki/"):
        return path[5:]
    return path


def _truncate_note(note: str, max_len: int = 60) -> str:
    """Truncate *note* to *max_len* characters if it exceeds the limit.

    If truncation occurs, the last character is replaced with ``…``,
    resulting in a string of exactly *max_len* characters.

    Args:
        note: The note string to truncate.
        max_len: Maximum allowed length (default 60).

    Returns:
        The original note if within limit, or a truncated version ending
        with ``…``.
    """
    if len(note) <= max_len:
        return note
    return note[: max_len - 1] + "…"


def _format_entry(op: str, path: str, action: str, note: str) -> str:
    """Format a single log entry line.

    Format::

        ## [YYYY-MM-DD] <op> | <path> | <action> — <note>

    Args:
        op: The upstream operation that triggered the change.
        path: Wiki-root-relative path (or ``—`` for non-page events).
        action: The mutation performed.
        note: Free-text explanation.

    Returns:
        The formatted entry line (without trailing newline).
    """
    today = date.today().isoformat()
    return f"## [{today}] {op} | {path} | {action} — {note}"


def add_entry(op: str, path: str, action: str, note: str) -> str:
    """Prepend a structured log entry to the top of ``wiki/log.md``.

    The entry is inserted immediately after the ``---`` separator line.
    If ``log.md`` does not exist or has no ``---``, the header is created
    first.  Existing entries are preserved — the new entry appears at the
    top (most recent first).

    Args:
        op: The triggering upstream operation (must be in ``VALID_OPS``).
        path: Wiki-root-relative path (or ``—`` for non-page events).
        action: The mutation performed (must be in ``VALID_ACTIONS``).
        note: Free-text explanation (will be truncated to 60 chars).

    Returns:
        The formatted entry line that was prepended.
    """
    path = _normalize_path(path)
    note = _truncate_note(note)
    entry = _format_entry(op, path, action, note)

    content = LOG_FILE.read_text(encoding="utf-8") if LOG_FILE.exists() else ""

    if not content:
        # File doesn't exist or is empty — create header with entry
        new_content = LOG_HEADER + entry + "\n"
    else:
        lines = content.splitlines(keepends=True)
        sep_idx: int | None = None
        for i, line in enumerate(lines):
            if line.strip() == "---":
                sep_idx = i
                break

        if sep_idx is None:
            # No --- separator found — prepend header + entry
            new_content = LOG_HEADER + entry + "\n" + content
        else:
            # Everything up to and including the separator line
            prefix = "".join(lines[: sep_idx + 1])
            # Everything after the separator
            suffix = "".join(lines[sep_idx + 1 :])
            # Ensure prefix ends with a newline
            if not prefix.endswith("\n"):
                prefix += "\n"
            new_content = prefix + entry + "\n" + suffix

    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    LOG_FILE.write_text(new_content, encoding="utf-8")
    return entry


def main() -> None:
    """Parse CLI arguments and prepend a log entry."""
    parser = argparse.ArgumentParser(
        description="在 wiki/log.md 顶部添加一条结构化日志记录",
    )
    parser.add_argument(
        "--op",
        required=True,
        choices=VALID_OPS,
        help="触发操作类型（ingest/update/delete/query/health/lint/heal/refresh/tool）",
    )
    parser.add_argument(
        "--path",
        required=True,
        help="wiki 根相对路径（如 concepts/test.md），非页面事件用 —",
    )
    parser.add_argument(
        "--action",
        required=True,
        choices=VALID_ACTIONS,
        help="执行的操作（create/edit/delete/pass/fail）",
    )
    parser.add_argument(
        "--note",
        required=True,
        help="说明文字（最多 60 字符，超出自动截断）",
    )
    args = parser.parse_args()

    try:
        add_entry(args.op, args.path, args.action, args.note)
    except OSError as e:
        print(f"错误：写入日志失败 — {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
