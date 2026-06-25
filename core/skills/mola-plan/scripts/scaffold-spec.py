"""Scaffold a mola-plan design spec file.

Usage:
    python scaffold-spec.py <slug> <project-dir> [--force]

Generates a spec file under ~/.zoo/plans/<project-id>/<slug>-spec-<YYYYMMDD>.md
with YAML-style frontmatter. Idempotent — re-run without --force is a no-op.
"""

import argparse
import os
import re
import subprocess
import sys
import tempfile
from datetime import date, datetime, timezone


def derive_project_id(project_dir: str) -> str:
    """Derive a kebab-case project ID from git remote or directory name."""
    try:
        result = subprocess.run(
            ["git", "-C", project_dir, "remote", "get-url", "origin"],
            capture_output=True,
            text=True,
            check=True,
            timeout=10,
        )
        url = result.stdout.strip()
        # Extract repo name from common git URL formats
        # git@github.com:owner/repo.git  → repo
        # https://github.com/owner/repo.git → repo
        match = re.search(r"/([^/]+?)(?:\.git)?$", url.replace(":", "/"))
        if match:
            name = match.group(1)
            return name.lower()
    except (
        subprocess.CalledProcessError,
        FileNotFoundError,
        subprocess.TimeoutExpired,
    ):
        pass
    return os.path.basename(os.path.abspath(project_dir)).lower()


def validate_slug(slug: str) -> bool:
    """Return True if slug contains only alphanumeric chars and hyphens."""
    return bool(re.fullmatch(r"[a-zA-Z0-9-]+", slug))


def make_title(slug: str) -> str:
    """Convert a kebab-case slug to a title (e.g. 'fix-auth' → 'Fix Auth')."""
    return slug.replace("-", " ").title()


def build_frontmatter(
    slug: str, date_str: str, project_id: str, now: datetime
) -> str:
    """Build the YAML-style frontmatter block."""
    iso_now = now.isoformat()
    title = make_title(slug)
    return (
        "---\n"
        f'title: "{title}"\n'
        f'slug: "{slug}-spec-{date_str}"\n'
        f'project: "{project_id}"\n'
        f'created: "{iso_now}"\n'
        f'updated: "{iso_now}"\n'
        "status: awaiting-approval\n"
        "---\n"
    )


def build_body(slug: str) -> str:
    """Build the markdown body of the spec file."""
    title = make_title(slug)
    return (
        f"\n# {title} — Design Spec\n"
        "\n"
        "## Context\n"
        "\n"
        "<!-- 2-4 句话：什么触发了这个 spec，涉及哪些现有代码，解决什么用户需求。\n"
        "     例：需要引入 JWT 认证方案，现有代码使用 session-based auth，\n"
        "     新需求要求无状态 token 以支持移动端。 -->\n"
        "\n"
        "## Design Goals\n"
        "\n"
        "<!-- 每个 goal 必须是独立可验证的。格式：G<序号>: <specific, measurable goal>\n"
        "     例：\n"
        "     - G1: 实现无状态 JWT 认证，token 过期时间 < 1 小时\n"
        "     - G2: 支持 token refresh，无需用户重新登录 -->\n"
        "\n"
        "## Architecture Decision\n"
        "\n"
        "<!-- 高层方案选择 + WHY 选这个而非其他。不要写实现步骤。\n"
        "     例：选择 access/refresh token 双 token 方案，因为：\n"
        "     1) 减少 access token 泄露风险；2) 支持移动端离线刷新 -->\n"
        "\n"
        "## Key Design Decisions\n"
        "\n"
        "<!-- 每个 decision 需要三件套：Chosen + Alternatives considered + Scenarios tested\n"
        "     每个决策应回答：为什么选这个、不选其他的、stress test 通过了吗 -->\n"
        "\n"
        "### Decision 1: <decision name>\n"
        "\n"
        "- **Chosen:** <做出的决定 + rationale>\n"
        "- **Alternatives considered:** <其他选项 + 拒绝原因>\n"
        "- **Scenarios tested:** <具体场景验证了这个决定>\n"
        "\n"
        "## Non-Goals\n"
        "\n"
        '<!-- 防止 scope 扩张，每条说清楚"不做什么 + 为什么"。\n'
        "     例：\n"
        "     - NG1: 不实现 refresh token 轮换（因为 MVP 阶段不需要）\n"
        "     - NG2: 不改动现有 user 表（因为 auth 层解耦设计） -->\n"
        "\n"
        "## Constraints and Assumptions\n"
        "\n"
        "<!-- 影响设计的技术/组织/时间约束。\n"
        "     例：\n"
        "     - C1: 必须兼容现有 session-based 中间件（不能破坏现有功能）\n"
        "     - A1: 假设 API 网关层已处理 SSL 终止（如果不对则需在应用层加 TLS） -->\n"
        "\n"
        "## Risks and Mitigations\n"
        "\n"
        '<!-- 已知风险 + 具体缓解措施（不是"遇到了再处理"）。\n'
        "     例：\n"
        "     - R1: token 泄露风险 → Mitigation: access token 有效期 15 分钟 + refresh token 加 scope 限制 -->\n"
        "\n"
        "## Open Questions\n"
        "\n"
        "<!-- 延迟决策的待定项，包含 rationale 和触发解决的条件。\n"
        "     例：\n"
        "     - Q1: token 存储方式（localStorage vs httpOnly cookie）→ 暂缓因为：依赖前端架构决策 → 解决条件：确定前端部署方案后 -->\n"
        "\n"
        "## Success Criteria\n"
        "\n"
        "<!-- 每个 criterion 必须 observable + verifiable，1:1 映射到 Design Goal。\n"
        "     例：\n"
        "     - SC1: access token 过期后返回 401，refresh token 可获取新 token\n"
        "     - SC2: 移动端 token refresh 流程延时 < 200ms -->\n"
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Scaffold a mola-plan design spec file."
    )
    parser.add_argument("slug", help="Spec slug (alphanumeric + hyphens only)")
    parser.add_argument(
        "project_dir", help="Path to the project root directory"
    )
    parser.add_argument(
        "--force", action="store_true", help="Overwrite existing file"
    )
    args = parser.parse_args()

    # -- Validate slug
    if not validate_slug(args.slug):
        print(
            f"Error: Invalid slug '{args.slug}'. "
            "Slug must contain only alphanumeric characters and hyphens.",
            file=sys.stderr,
        )
        sys.exit(2)

    # -- Validate project-dir exists
    project_dir = os.path.abspath(args.project_dir)
    if not os.path.isdir(project_dir):
        print(
            f"Error: Project directory does not exist: {project_dir}",
            file=sys.stderr,
        )
        sys.exit(2)

    # -- Derive project ID
    project_id = derive_project_id(project_dir)

    # -- Determine plans directory
    home = os.path.expanduser("~")
    plans_dir = os.path.join(home, ".zoo", "plans", project_id)

    # -- Determine filename
    today = date.today()
    date_str = today.strftime("%Y%m%d")
    filename = f"{args.slug}-spec-{date_str}.md"
    filepath = os.path.join(plans_dir, filename)

    # -- Idempotency check
    if os.path.exists(filepath) and not args.force:
        print(f"Already exists: {filepath}")
        sys.exit(0)

    # -- Create directory
    try:
        os.makedirs(plans_dir, exist_ok=True)
    except PermissionError as e:
        print(
            f"Error: Permission denied creating directory {plans_dir}: {e}",
            file=sys.stderr,
        )
        sys.exit(2)

    # -- Build content
    now = datetime.now(timezone.utc)
    frontmatter = build_frontmatter(args.slug, date_str, project_id, now)
    body = build_body(args.slug)
    content = frontmatter + body

    # -- Force warning
    if args.force and os.path.exists(filepath):
        print(f"Overwriting existing file: {filepath}")

    # -- Write atomically
    try:
        fd, tmp_path = tempfile.mkstemp(dir=plans_dir, suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(content)
            os.replace(tmp_path, filepath)
        except BaseException:
            os.unlink(tmp_path)
            raise
    except PermissionError as e:
        print(
            f"Error: Permission denied writing to {filepath}: {e}",
            file=sys.stderr,
        )
        sys.exit(2)
    except OSError as e:
        print(f"Error: Failed to write {filepath}: {e}", file=sys.stderr)
        sys.exit(2)

    print(filepath)


if __name__ == "__main__":
    main()
