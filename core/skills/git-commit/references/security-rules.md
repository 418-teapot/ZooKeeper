# 安全规则 — 密钥检测与修复指南

## 12种密钥模式家族

| # | 模式家族 | 正则表达式 | 示例 |
|---|--------|--------------|---------|
| 1 | AWS 访问密钥ID | `A` + ``KIA[0-9A-Z]{16}` | `A` + ``KIAIOSFODNN7EXAMPLE` |
| 2 | AWS 秘密访问密钥 | `(?i)aws_secret_access_key\s*=\s*\S+` | `aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY` |
| 3 | GitHub 令牌 | `g` + ``h[pousr]_[A-Za-z0-9]{36}` | `g` + ``hp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` |
| 4 | Stripe 密钥 | `s` + ``k_(live|test)_[A-Za-z0-9]{24,}` | `s` + ``k_live_xxxxxxxxxxxxxxxxxxxxxxxx` |
| 5 | 通用 API 密钥 | `[Aa][Pp][Ii]_?[Kk][Ee][Yy]\s*[:=]\s*\S{16,}` | `API_KEY = sk-xxxxxxxxxxxxxxxx` |
| 6 | 密码 | `[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]\s*[:=]\s*\S{8,}` | `PASSWORD = superSecret123!` |
| 7 | 私钥 | `-----BEGIN (RSA\|EC\|OPENSSH\|DSA\|PGP) PRIVATE KEY-----` | `-----BEGIN RSA PRIVATE KEY-----` |
| 8 | Bearer 令牌 | `[Bb]earer\s+[A-Za-z0-9\-_]{20,}` | `Bearer eyJhbGciOiJIUzI1NiIs...` |
| 9 | MongoDB 连接字符串 | `mongodb://[^:]+:[^@]+@` | `mongodb://admin:password@cluster0.mongodb.net` |
| 10 | PostgreSQL 连接字符串 | `postgresql://[^:]+:[^@]+@` | `postgresql://user:pass@localhost:5432/db` |
| 11 | MySQL 连接字符串 | `mysql://[^:]+:[^@]+@` | `mysql://user:pass@localhost:3306/db` |
| 12 | .env / 凭证文件 | `\.env$`, `\.pem$`, `\.key$`, `credentials` | `.env.production`, `server.key`, `credentials.json` |

---

## 发现密钥时的处理方法

### 如果密钥已暂存但未推送：

```bash
# 1. Unstage the file
git reset HEAD config/credentials.yml

# 2. Replace the secret with an environment variable
# config/credentials.yml → config/credentials.yml.example (committed)
# Actual values go in .env (gitignored)

# 3. Add to .gitignore if needed
echo "config/credentials.yml" >> .gitignore

# 4. Add the safe version
git add config/credentials.yml.example .gitignore

# 5. Commit the fix
git commit -m "chore(config): externalize credentials to env vars"
```

### 如果密钥已推送（即使是到分支）：

```bash
# 1. ROTATE the credential immediately
#    - AWS: go to IAM → delete access key → create new one
#    - GitHub: go to Settings → Developer settings → revoke token
#    - Stripe: go to Dashboard → API keys → roll secret key

# 2. Remove from git history using git-filter-repo
#    Install: pip install git-filter-repo  or  brew install git-filter-repo

# 3. Force push the cleaned history
#    git push origin --force --all
```

---

## 从Git历史中清除密钥

使用 `git-filter-repo`（不要用 `git filter-branch` — 它已废弃且速度慢）：

```bash
# Remove a specific file from all of history
git filter-repo --path config/credentials.yml --invert-paths

# Replace a string pattern in all of history
git filter-repo --replace-text <(echo "AKIAI``OSFODNN7EXAMPLE==>REPLACED")

# After cleaning, force push
git push origin --force --all
git push origin --force --tags
```

**⚠️ 警告**：强制推送会重写共享历史。请与团队协调。
强制推送后所有人都需要重新克隆仓库。

---

## 误报处理指南

以下情况不是密钥——它们是测试夹具、示例值或占位符：

| 模式 | 何时安全 | 如何放行 |
|---------|---------------|--------------|
| `A` + ``KIA...` | 文档中的示例AWS密钥 | 使用前缀检查——仅标记格式和长度都正确的字符串 |
| `s` + ``k_test_...` | Stripe测试密钥（以s` + ``k_test开头） | 仅标记 `s` + ``k_live_`，允许 `s` + ``k_test_` |
| `password` in `password_hash` | 非明文密码 | 跳过包含 `hash`、`bcrypt`、`argon` 的行 |
| `Bearer` in `Authorization: Bearer` header | 测试客户端代码 | 如果上下文是模拟/示例，跳过测试文件 |
| `.env.example` | 模板文件，无真实值 | 跳过带有 `.example` 后缀的文件 |
| `id_rsa.pub` | 公钥（后缀是.pub） | 仅标记私钥（无.pub后缀） |
| `0xDEADBEEF` | 十六进制常量，非密钥 | 检查长度：API密钥模式必须16+字符 |

---

## 环境变量最佳实践

### Node.js
```bash
# .env (gitignored) — real values
DATABASE_URL=postgresql://user:realpassword@localhost:5432/db
STRIPE_KEY=<your-stripe-secret-key>

# .env.example (committed) — template with placeholders
DATABASE_URL=postgresql://user:password@localhost:5432/db
STRIPE_KEY=<your-stripe-secret-key>

# Access in code
const stripeKey = process.env.STRIPE_KEY;
if (!stripeKey) throw new Error("Missing STRIPE_KEY");
```

### Python
```python
# settings.py
import os
DATABASE_URL = os.environ["DATABASE_URL"]
STRIPE_KEY = os.environ.get("STRIPE_KEY")
```

### Go
```go
// config.go
import "os"
var DatabaseURL = os.Getenv("DATABASE_URL")
var StripeKey = os.Getenv("STRIPE_KEY")
```

### Rust
```rust
// config.rs
use std::env;
let database_url = env::var("DATABASE_URL").expect("DATABASE_URL must be set");
let stripe_key = env::var("STRIPE_KEY").expect("STRIPE_KEY must be set");
```

---

## 危险文件模式

永远不要提交这些文件类型——它们几乎总是包含凭证：

```
*.pem           # SSL/TLS certificates (private keys)
*.key           # SSH private keys
*.p12           # PKCS#12 certificate store
*.keystore      # Java keystore
*.cert          # Certificate files
id_rsa          # SSH private key
id_dsa          # SSH private key (legacy)
.env            # Environment variables
credentials     # Any file named "credentials"
secrets         # Any file named "secrets"
```

将它们添加到 `.gitignore`：
```bash
echo "*.pem" >> .gitignore
echo "*.key" >> .gitignore
echo "credentials" >> .gitignore
```
