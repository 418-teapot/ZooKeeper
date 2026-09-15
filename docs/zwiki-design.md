# zwiki 设计

zwiki 是一个由 LLM 与 human 共同维护的持久知识库工具。知识以页面为单位被
创作、修改、废弃；以 bundle 为单位打包分发；在对话中被检索；并持续接受
质量检查。

## 不变量

1. 每条知识恰好有一个可写的权威位置，任何副本不可被静默改写。
2. 凡可从内容计算出的数据（索引、关联、反向链接）绝不手工维护——边只
   创作一次。
3. 读者看到其可用的全部知识，无需知道知识来自哪里。
4. 共享知识只有一份可评审、可分发、有历史的源；私有知识不进入共享分发
   物。
5. 写入时不存在需要猜测的决策。
6. 操作者是 LLM：默认值必须安全，破坏性行为必须显式，错误必须响亮。

## 模型

只有两种目录：

- **bundle 源**：包含 `bundle.toml` 的目录，知识的唯一可写形态。位置任意
  （团队的 git 仓库、个人笔记目录），内含 `<域>/<类型>/<页>.md` 页面、
  `raw/` 原始材料、`logs/` 变更日志。页面模板与 SCHEMA 内嵌于 zwiki
  （`zwiki template <type>` / `zwiki schema` 查看），bundle 不携带。
- **store**：包含 `zwiki.lock` 的目录（约定为 `~/.zoo/wiki`），是已安装
  bundle 的只读聚合视图。内容由 `bundle install` / `uninstall` / `update`
  复制进 `<name>/`，除此之外不接受任何写入。

**可写 ⟺ 有 `bundle.toml`**。所有内容写命令必须显式传 `--root` 指向
bundle 源；root 含 `zwiki.lock`（store）或缺 `bundle.toml` 一律拒写。
写入位置因此永远显式（不变量 1、5），store 整体只读（不变量 1、3）。

个人知识就是一个普通 bundle（源目录位置自定），写完跑
`zwiki bundle install` 同步到 store。没有任何特殊路径或特殊类型。

## 派生数据

工具生成，不手工维护（不变量 2）：

- **索引**：各级 `index.md` 的 frontmatter 手工维护（`title`、可选
  `description`），正文自动生成——域索引按类型分节列出本域页面（条目附
  页面 `description`），bundle 根索引列出所有域与根级页面，store 根索引
  列出所有已安装 bundle（附 manifest `description`）。`page create` /
  `page move` / `domain create` 即时重建受影响的索引；`check` 全量重建。
- **页面关联**：通过在正文写内联链接表达；zwiki 在需要时（反向索
  引、健康检查、链接检查）从正文按需派生。
- **反向链接**：页面 `## Backlinks` 区由 `check` 整体重建；`page move`
  后即时重建受影响的页面。
- **日志**：`logs/YYYY-MM.md` 条目由写命令（`page create`/`set`/`unset`/
  `move`、`supersede`、`domain create` 等）自动追加；需要说明时在命令上
  加 `--note`。不存在手工记日志的命令。

## 检查器

`zwiki check` 在 bundle 源上做两件事：同步全部派生数据（幂等），并报告
健康问题——结构完整性（frontmatter/命名/路径）、索引同步（磁盘与索引的
双向一致性，页面列在任一 index 即视为已收录）、死链与孤立页、内联链接
覆盖（术语首次出现应有链接；出现在既有链接文本内的不算未链接）、时效性
（`timeliness`/`last_validated`/`freshness_days`）、生命周期一致性
（supersedes/contradictions 对端与状态）、日志覆盖（绕过工具手工落盘的
页面没有日志条目，会被标记）。

在 store（只读根）上 `check` 只报告不同步；写入发生在源上，经
`bundle install` 到达 store。

## 分发

bundle 源是可评审、可分发、有历史的单元（git 仓库或 tarball）。
`zwiki bundle install <源>` 复制到 store 的 `<name>/` 并登记
`zwiki.lock`（name/version/target/integrity）；`update`/`uninstall` 对称。
共享分发物只包含团队选择发布的 bundle；私有 bundle 不发布即满足
不变量 4。
