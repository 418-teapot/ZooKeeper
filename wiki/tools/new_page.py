#!/usr/bin/env python3
"""
new_page.py — Scaffold a new wiki page from a template.

Reads the template from wiki/templates/{type}.md, replaces title and date
placeholders, and writes the result to an auto-derived path under wiki/.
The path is computed from --type, --title, and (for sources) --source-type.
"""

from __future__ import annotations

import argparse
import re
import sys
from datetime import date
from pathlib import Path

# REPO_ROOT: 3 levels up from this file
# wiki/tools/new_page.py
#   -> tools/ -> wiki/ -> repo root
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
# Wiki is accessed via the user-global ~/.zoo/wiki symlink.
# Resolve to the real path so template files can be found.
WIKI_DIR = (Path.home() / ".zoo" / "wiki").resolve()
TEMPLATES_DIR = WIKI_DIR / "templates"
VALID_TYPES = {"concept", "entity", "source", "analysis", "synthesis"}

# Maps page type to subdirectory under wiki/
TYPE_DIR_MAP: dict[str, str] = {
    "concept": "concepts",
    "entity": "entities",
    "source": "sources",
    "analysis": "analysis",
    "synthesis": "syntheses",
}


def to_kebab_case(title: str) -> str:
    """Convert a title string to a kebab-case filename (no extension).

    Rules:
      - All lowercase
      - Spaces, underscores -> hyphens
      - Non-alphanumeric (excluding hyphens) stripped
      - Multiple consecutive hyphens collapsed
      - Leading/trailing hyphens stripped

    Args:
        title: The page title to convert.

    Returns:
        Kebab-case string safe for use as a filename.
    """
    name = title.lower()
    name = name.replace("_", "-")
    name = re.sub(r"\s+", "-", name)
    name = re.sub(r"[^a-z0-9-]", "", name)
    name = re.sub(r"-{2,}", "-", name)
    name = name.strip("-")
    return name


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
        "--source-type",
        choices=["adr", "rfc", "notes"],
        help="源类型（仅 type=source 时需要：adr/rfc/notes）",
    )
    parser.add_argument(
        "--slug",
        help="自定义文件名 slug（覆盖自动推导）。中文标题时必需，否则自动推导会得到空字符串。",
    )
    args = parser.parse_args()

    # --source-type is required when type == "source"
    if args.type == "source" and args.source_type is None:
        print(
            "错误：type=source 时必须指定 --source-type (adr/rfc/notes)。",
            file=sys.stderr,
        )
        sys.exit(2)

    # ------------------------------------------------------------------
    # Compute output path from type + title (+ source-type for sources)
    # ------------------------------------------------------------------

    if args.slug:
        slug = args.slug
    else:
        slug = to_kebab_case(args.title)

    if not slug:
        print(
            "错误：无法从标题推导出有效的文件名 slug。"
            "请使用 --slug 参数指定英文文件名。",
            file=sys.stderr,
        )
        sys.exit(2)

    if args.type == "source":
        assert args.source_type is not None  # validated above
        rel_path = Path("sources") / args.source_type / f"{slug}.md"
    else:
        rel_path = Path(TYPE_DIR_MAP[args.type]) / f"{slug}.md"

    # Resolve and verify the final path is under wiki/
    try:
        resolved = (WIKI_DIR / rel_path).resolve()
    except (ValueError, OSError):
        print("错误：无效的输出路径。", file=sys.stderr)
        sys.exit(1)

    try:
        resolved.relative_to(WIKI_DIR)
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
