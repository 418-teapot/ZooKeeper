#!/usr/bin/env python3
"""
Write-time inline-link checker for the ZooKeeper wiki.

After each wiki edit, scan *only the newly added lines* (via ``git diff``)
for anchor terms that lack inline links.  This is the **incremental diff**
counterpart to health.py's full-wiki anchor text mining check.

Usage:
    python3 wiki/tools/diff_check.py              # unstaged changes
    python3 wiki/tools/diff_check.py --cached     # staged changes
    python3 wiki/tools/diff_check.py HEAD~1       # diff against a specific commit

Exit codes:
    0 — no missing links in new text
    1 — one or more missing links found
    2 — error (e.g. wiki is not a git repo, no changes to check)
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

# ZooKeeper: diff_check.py lives at wiki/tools/diff_check.py.
# Import shared utilities from health.py (same directory).
_TOOLS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(_TOOLS_DIR))

from health import (  # noqa: E402
    WIKI_DIR,
    _check_body_for_missing_links,
    _deduplicate_prefix_matches,
    _expand_anchor_prefixes,
    _extract_anchor_map,
    _wiki_rel,
    all_wiki_pages,
    read_file,
)

# Matches a diff hunk header:  @@ -old,count +new,count @@
_HUNK_HEADER = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@")


# Meta files and directories that are not prose wiki pages —
# checking these for missing inline links produces noise.
_SKIP_DIFF_FILES = {
    "index.md",
    "log.md",
    "overview.md",
    "SCHEMA.md",
    "health-report.md",
    "lint-report.md",
}
_SKIP_DIFF_DIRS = {"raw", "templates", "tools"}


def _is_prose_page(file_path: str) -> bool:
    """Return True if the file is a prose wiki page worth link-checking."""
    if (
        file_path in _SKIP_DIFF_FILES
        or Path(file_path).name in _SKIP_DIFF_FILES
    ):
        return False
    parts = Path(file_path).parts
    for d in _SKIP_DIFF_DIRS:
        if d in parts:
            return False
    return True


def _parse_added_lines(diff_text: str) -> dict[str, str]:
    """Parse unified diff output, extracting only added lines per file.

    Returns a dict mapping wiki-relative file paths to the concatenated
    text of their newly added lines (without the ``+`` prefix).
    """
    added: dict[str, list[str]] = {}
    current_file: str | None = None

    for line in diff_text.split("\n"):
        # File header:  diff --git a/wiki/path b/wiki/path
        if line.startswith("diff --git "):
            parts = line.split()
            if len(parts) >= 4:
                b_path = parts[3]  # "b/wiki/concepts/foo.md"
                if b_path.startswith("b/"):
                    b_path = b_path[2:]
                current_file = b_path
            continue

        # Only collect added lines (starting with '+', but not '+++')
        if line.startswith("+") and not line.startswith("+++"):
            if current_file and current_file.endswith(".md"):
                if current_file not in added:
                    added[current_file] = []
                added[current_file].append(line[1:])  # strip leading '+'

    return {f: "\n".join(lines) for f, lines in added.items()}


def _git_root() -> Path | None:
    """Find the git repository root that contains WIKI_DIR."""
    try:
        result = subprocess.run(
            ["git", "-C", str(WIKI_DIR), "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
        )
        if result.returncode == 0:
            return Path(result.stdout.strip())
    except FileNotFoundError:
        pass
    return None


def run_diff(args: argparse.Namespace) -> int:
    """Run the incremental diff check, return exit code."""
    wiki_dir = WIKI_DIR.resolve()
    git_root = _git_root()
    if git_root is None:
        print("diff_check: wiki is not in a git repository", file=sys.stderr)
        return 2

    # Compute the wiki path relative to git root for scoped diff.
    try:
        wiki_rel = str(wiki_dir.relative_to(git_root))
    except ValueError:
        wiki_rel = str(wiki_dir)

    # Build the git diff command, scoped to the wiki directory.
    cmd = ["git", "-C", str(git_root), "diff", "--unified=0"]
    if args.cached:
        cmd.append("--cached")
    if args.commit:
        cmd.append(args.commit)
    cmd.extend(["--", wiki_rel])

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(
            f"diff_check: git diff failed: {result.stderr.strip()}",
            file=sys.stderr,
        )
        return 2

    diff_text = result.stdout
    if not diff_text.strip():
        if args.commit:
            print(f"diff_check: no changes between HEAD and {args.commit}")
        else:
            print("diff_check: no unstaged changes in wiki")
        return 0

    # Build the anchor map from ALL wiki pages.
    pages = all_wiki_pages()
    anchor_map = _extract_anchor_map(pages)
    for page in pages:
        content = read_file(page)
        from health import _parse_frontmatter  # noqa: E402

        fm = _parse_frontmatter(content)
        title = fm.get("title", "")
        if title and len(title) >= 3:
            if title not in anchor_map:
                anchor_map[title] = set()
            anchor_map[title].add(_wiki_rel(page))

    _expand_anchor_prefixes(anchor_map)

    # Parse added lines per file and check each.
    added_by_file = _parse_added_lines(diff_text)
    if not added_by_file:
        print("diff_check: no markdown files changed")
        return 0

    # Compute prefix to strip from diff paths (e.g. "wiki/" → "").
    wiki_prefix = wiki_rel.rstrip("/") + "/"

    all_issues: list[dict] = []
    for file_path, added_text in added_by_file.items():
        # Strip the git-root-relative prefix to get wiki-relative paths.
        if file_path.startswith(wiki_prefix):
            rel_page = file_path[len(wiki_prefix) :]
        else:
            rel_page = file_path

        if not _is_prose_page(rel_page):
            continue

        page_dir = WIKI_DIR / rel_page
        page_dir = page_dir.parent

        issues = _check_body_for_missing_links(
            added_text, rel_page, anchor_map, page_dir
        )
        all_issues.extend(issues)

    all_issues = _deduplicate_prefix_matches(all_issues)

    if not all_issues:
        print("diff_check: no missing inline links in new text ✅")
        return 0

    print(
        f"diff_check: {len(all_issues)} missing inline link(s) in new text:\n"
    )
    for issue in all_issues:
        targets = ", ".join(f"`{t}`" for t in issue["suggested_targets"])
        print(f"  {issue['page']}")
        print(f'    "{issue["term"]}" → should link to {targets}')
        print(f"    {issue['snippet']}")
        print()

    return 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Incremental inline-link checker — scan newly added wiki text"
    )
    parser.add_argument(
        "--cached",
        action="store_true",
        help="check staged changes instead of unstaged",
    )
    parser.add_argument(
        "commit",
        nargs="?",
        default=None,
        help="diff against a specific commit (default: unstaged changes)",
    )
    args = parser.parse_args()
    sys.exit(run_diff(args))
