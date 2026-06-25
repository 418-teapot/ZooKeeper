"""Scaffold a mola-plan plan file.

Usage:
    python scaffold-plan.py <slug> <project-dir> [--force]

Generates a plan file under ~/.zoo/plans/<project-id>/<slug>-<YYYYMMDD>.md
with YAML frontmatter. Idempotent — re-run without --force is a no-op.
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
    slug: str, date_str: str, project_root: str, now: datetime
) -> str:
    """Build the YAML frontmatter block."""
    iso_now = now.isoformat()
    return (
        "---\n"
        f"status: planning\n"
        f'slug: "{slug}-{date_str}"\n'
        f'project_root: "{project_root}"\n'
        f'created_at: "{iso_now}"\n'
        f'updated_at: "{iso_now}"\n'
        "active_sessions: []\n"
        "---\n"
    )


def build_body(slug: str, date_str: str, project_root: str) -> str:
    """Build the markdown body of the plan file."""
    title = make_title(slug)
    return (
        f"\n# {title}\n"
        "\n"
        "## Scope\n"
        "\n"
        "### Must have\n"
        "\n"
        '<!-- 3-5 个具体交付物。每个用 "- [ ]" 开头。\n'
        "     例：\n"
        "     - [ ] 在 src/middleware/auth.ts 实现 JWT 验证函数\n"
        "     - [ ] 添加 /api/auth/verify 端点\n"
        "     - [ ] 集成测试覆盖 3 种 token 状态 -->\n"
        "\n"
        "### Must NOT have\n"
        "\n"
        '<!-- 明确不需要做的事情，防止 scope 扩张。每个用 "- [ ]" 开头。\n'
        "     例：\n"
        "     - [ ] 不实现 refresh token 轮换\n"
        "     - [ ] 不改动现有 user 表结构 -->\n"
        "\n"
        "## Context\n"
        "\n"
        "<!-- 2-4 句话：什么触发了这个 plan，涉及哪些关键文件，用户需求是什么。\n"
        "     例：用户报告 auth token 在 15 分钟后过期但前端无刷新提示。\n"
        "     涉及 src/middleware/auth.ts、src/api/auth.ts、src/components/Layout.tsx。 -->\n"
        "\n"
        "## Approach\n"
        "\n"
        "<!-- 编号步骤，每步包含具体做法 + rationale。\n"
        "     例：\n"
        "     1. 在 auth.ts 添加 token 过期检测函数（复用现有 verify 逻辑）\n"
        "     2. 在 auth 端点新增 /api/auth/refresh 接口（分离刷新逻辑）\n"
        "     3. 前端 Layout 组件监听 401 并自动调用刷新（用户体验无感） -->\n"
        "\n"
        "## Critical Files\n"
        "\n"
        "<!-- ≤5 个文件，每个带原因。格式：`path` (原因)\n"
        "     例：\n"
        "     - `src/middleware/auth.ts` (核心验证逻辑，主要修改点)\n"
        "     - `src/api/auth.ts` (新增 refresh 端点)\n"
        "     - `src/components/Layout.tsx` (401 处理) -->\n"
        "\n"
        "## Execution strategy\n"
        "\n"
        "<!-- 依赖矩阵 + 并行波次。\n"
        "     例：Wave 1: auth.ts || types.ts → Wave 2: routes.ts → Wave 3: tests\n"
        '     用 "→" 表示依赖，"||" 表示可并行 -->\n'
        "\n"
        "## Verification\n"
        "\n"
        "<!-- 精确命令 + 期望输出。\n"
        "     格式：`命令` → 期望: <输出模式>\n"
        "     例：\n"
        '     - `curl -X POST /api/auth/verify -H "Authorization: Bearer <token>"` → 期望: HTTP 200 + { valid: true }\n'
        '     - `curl -X POST /api/auth/verify -H "Authorization: Bearer <expired-token>"` → 期望: HTTP 401 + { error: "token_expired" }\n'
        '     - `npm test -- --grep "auth"` → 期望: 5 passing, 0 failing -->\n'
        "\n"
        "## TODOs\n"
        "\n"
        "<!-- 每个 todo 包含：做什么 + 不做什么 + 验收标准。\n"
        "     格式：\n"
        "     - [ ] N. <标题>\n"
        "           What to do: <具体步骤>\n"
        "           Must NOT do: <排除项>\n"
        "           Acceptance criteria:\n"
        "           - [ ] <可验证的条件，必须 agent 可执行> -->\n"
        "\n"
        "## Final verification wave\n"
        "\n"
        "- [ ] F1. Plan compliance audit\n"
        "- [ ] F2. Code quality review\n"
        "- [ ] F3. Manual QA (agent-executable)\n"
        "- [ ] F4. Scope fidelity\n"
        "\n"
        "## Commit strategy\n"
        "\n"
        "<!-- 哪些 task 合并在一个 commit；每个 squash 的 commit type + scope + summary。\n"
        "     例：\n"
        "     - squash N1-N2: feat(auth): add JWT verification middleware\n"
        "     - squash N3: test(auth): add expired/revoked/invalid token tests -->\n"
        "\n"
        "## Success criteria\n"
        "\n"
        "<!-- 所有 TODO 完成 + F1-F4 全部通过 + 用户确认 scope 匹配。\n"
        "     例：\n"
        "     - [ ] 所有 TODO checkbox 已勾选\n"
        "     - [ ] F1-F4 全部通过\n"
        "     - [ ] 用户确认交付物符合预期 -->\n"
        "\n"
        "## Risks\n"
        "\n"
        "<!-- 已知风险 + 具体缓解措施。格式：R<序号>: <风险> → Mitigation: <缓解动作>\n"
        "     例：\n"
        "     - R1: 刷新 token 并发竞态 → Mitigation: 加 mutex 锁，同一时间只允许一个刷新请求\n"
        "     - R2: 现有测试可能因 mock 变化失败 → Mitigation: 运行全量测试确认回归 -->\n"
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Scaffold a mola-plan plan file."
    )
    parser.add_argument("slug", help="Plan slug (alphanumeric + hyphens only)")
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
    filename = f"{args.slug}-{date_str}.md"
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
    frontmatter = build_frontmatter(args.slug, date_str, project_dir, now)
    body = build_body(args.slug, date_str, project_dir)
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
