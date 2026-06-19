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


def _compute_output_path(
    args_type: str,
    args_title: str,
    args_slug: str | None = None,
    args_source_type: str | None = None,
) -> Path:
    """Compute the output file path for a new wiki page.

    Args:
        args_type: Page type (concept/entity/source/analysis/synthesis).
        args_title: Page title (used to derive slug if ``args_slug`` is not given).
        args_slug: Optional explicit slug override.
        args_source_type: Source sub-type (adr/rfc/notes), required when
            ``args_type == "source"``.

    Returns:
        Resolved absolute ``Path`` to the output file.

    Raises:
        SystemExit: If the slug is invalid or the resolved path is outside
            ``WIKI_DIR`` (exit code 1 or 2).
    """
    if args_slug:
        slug = args_slug
    else:
        slug = to_kebab_case(args_title)

    # Validate slug — reject path traversal characters
    if not slug or ".." in slug or "/" in slug or "\\" in slug:
        print(
            "错误：无效的文件名 slug — 不能包含 .. / \\ 等路径分隔符。"
            "请使用 --slug 参数指定有效的英文文件名。",
            file=sys.stderr,
        )
        sys.exit(2)

    if args_type == "source":
        assert args_source_type is not None  # caller must validate
        rel_path = Path("sources") / args_source_type / f"{slug}.md"
    else:
        rel_path = Path(TYPE_DIR_MAP[args_type]) / f"{slug}.md"

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

    return resolved


def _apply_template(content: str, title: str, today: str) -> str:
    """Replace placeholders in template content with actual values.

    Performs three substitutions:
      1. ``created`` / ``updated`` date fields → *today*
      2. ``status: draft|review|stable|deprecated`` → ``status: draft``
      3. ``title: <...>`` and ``# <...>`` → actual *title*

    Args:
        content: Raw template content.
        title: Page title to substitute.
        today: ISO-formatted date string (``YYYY-MM-DD``).

    Returns:
        Processed content with all placeholders replaced.
    """
    # 1. Date placeholders in created / updated fields
    content = re.sub(
        r"^(created|updated): YYYY-MM-DD$",
        lambda m: f"{m.group(1)}: {today}",
        content,
        flags=re.MULTILINE,
    )

    # 2. Default status to "draft"
    content = re.sub(
        r"^status: draft\|review\|stable\|deprecated$",
        "status: draft",
        content,
        flags=re.MULTILINE,
    )

    # 3. Title placeholders in frontmatter title field and body heading.
    content = re.sub(
        r"^title: <[^>]+>$",
        lambda m: f"title: {title}",
        content,
        flags=re.MULTILINE,
    )
    content = re.sub(
        r"^# <[^>]+>$",
        lambda m: f"# {title}",
        content,
        flags=re.MULTILINE,
    )

    return content


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

    resolved = _compute_output_path(
        args_type=args.type,
        args_title=args.title,
        args_slug=args.slug,
        args_source_type=args.source_type,
    )

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
    content = _apply_template(content, args.title, today)

    # ------------------------------------------------------------------
    # Write output
    # ------------------------------------------------------------------

    resolved.parent.mkdir(parents=True, exist_ok=True)
    resolved.write_text(content, encoding="utf-8")

    rel_path = resolved.relative_to(REPO_ROOT)
    print(f"已创建页面：{rel_path}")


if __name__ == "__main__":
    main()
