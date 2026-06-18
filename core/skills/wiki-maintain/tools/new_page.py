#!/usr/bin/env python3
"""
new_page.py — Scaffold a new wiki page from a template.

Reads the template from wiki/templates/{type}.md, replaces title and date
placeholders, and writes the result to --output under wiki/.
"""

from __future__ import annotations

import argparse
import re
import sys
from datetime import date
from pathlib import Path

# REPO_ROOT: 5 levels up from this file
# core/skills/wiki-maintain/tools/new_page.py
#   -> tools/ -> wiki-maintain/ -> skills/ -> core/ -> repo root
REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent.parent
# Wiki is accessed via the user-global ~/.zoo/wiki symlink.
# Resolve to the real path so template files can be found.
WIKI_DIR = (Path.home() / ".zoo" / "wiki").resolve()
TEMPLATES_DIR = WIKI_DIR / "templates"
VALID_TYPES = {"concept", "entity", "source", "analysis", "synthesis"}


def main() -> None:
    parser = argparse.ArgumentParser(
        description="从模板创建新的 wiki 页面",
    )
    parser.add_argument(
        "--type",
        required=True,
        choices=sorted(VALID_TYPES),
        help="页面类型",
    )
    parser.add_argument(
        "--title",
        required=True,
        help="页面标题",
    )
    parser.add_argument(
        "--output",
        required=True,
        help="输出路径（相对于项目根，须在 wiki/ 下）",
    )
    args = parser.parse_args()

    output_path = Path(args.output)

    # ------------------------------------------------------------------
    # Path traversal guard
    # ------------------------------------------------------------------

    # Reject absolute paths (e.g. /etc/passwd)
    if output_path.is_absolute():
        print("错误：输出路径不能为绝对路径。", file=sys.stderr)
        sys.exit(1)

    # Reject paths starting with ../ (obvious traversal attempt)
    if args.output.startswith("../"):
        print("错误：输出路径不能以 '../' 开头。", file=sys.stderr)
        sys.exit(1)

    # Resolve and verify the final path is under wiki/
    try:
        resolved = (REPO_ROOT / output_path).resolve()
    except (ValueError, OSError):
        print("错误：无效的输出路径。", file=sys.stderr)
        sys.exit(1)

    wiki_dir = WIKI_DIR
    try:
        resolved.relative_to(wiki_dir)
    except ValueError:
        print("错误：输出路径必须在 wiki/ 目录下。", file=sys.stderr)
        sys.exit(1)

    # ------------------------------------------------------------------
    # Read template
    # ------------------------------------------------------------------

    template_path = TEMPLATES_DIR / f"{args.type}.md"
    if not template_path.exists():
        print(
            f"错误：未找到模板 {template_path.relative_to(REPO_ROOT)}。",
            file=sys.stderr,
        )
        sys.exit(1)

    content = template_path.read_text(encoding="utf-8")

    # ------------------------------------------------------------------
    # Replace placeholders
    # ------------------------------------------------------------------

    today = date.today().isoformat()  # YYYY-MM-DD

    # 1. Date placeholders in created / updated fields
    content = content.replace("YYYY-MM-DD", today)

    # 2. Default status to "draft" (templates use "draft|review|stable|deprecated"
    #    as documentation of valid values, not an actual status)
    content = content.replace("draft|review|stable|deprecated", "draft")

    # 3. Title placeholders in frontmatter title field and body heading.
    #    Only target exact lines like "title: <...>" and "# <...>",
    #    NOT other angle-bracket placeholders (e.g. <方案名称>, <source-id>).
    content = re.sub(
        r"^title: <[^>]+>$",
        lambda m: f"title: {args.title}",
        content,
        flags=re.MULTILINE,
    )
    content = re.sub(
        r"^# <[^>]+>$",
        lambda m: f"# {args.title}",
        content,
        flags=re.MULTILINE,
    )

    # ------------------------------------------------------------------
    # Write output
    # ------------------------------------------------------------------

    resolved.parent.mkdir(parents=True, exist_ok=True)
    resolved.write_text(content, encoding="utf-8")

    rel_path = resolved.relative_to(REPO_ROOT)
    print(f"已创建页面：{rel_path}")


if __name__ == "__main__":
    main()
