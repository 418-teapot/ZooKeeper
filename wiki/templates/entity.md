---
title: <实体名称>
description: <一句话摘要>。
type: entity
timestamp: YYYY-MM-DDTHH:mm:ssZ
tags: [tag1, tag2]
relations:
  - "[示例概念](shared/concepts/foo.md)"
status: draft|review|stable|deprecated
last_validated: YYYY-MM-DDTHH:mm:ssZ
timeliness: current
# 可选生命周期字段（按需取消注释填写，详见 SCHEMA.md）：
# supersedes:
#   - path: <domain>/concepts/old.md
#     reason: "新来源确认此结论已被推翻"
# superseded_by:
#   - path: <domain>/concepts/new.md
#     reason: "被新结论取代"
# contradictions:
#   - path: <domain>/concepts/other.md
#     claims: ["声明 A", "声明 B"]
#     detected: YYYY-MM-DD
#     resolution: unresolved
# freshness_days: 90
---

# <实体名称>

> 一句话概括该实体是什么，在项目中的位置。

## Overview

该实体的简要描述：位置、职责、创建原因。

## Role

该实体在系统中扮演的角色，主要的职责范围。

## Behavior

关键行为描述：输入、输出、副作用、异常处理。

## Permissions（如适用）

如果该实体涉及权限（如插件、agent），列出其权限范围。

## Backlinks

> 此节由 zwiki 自动维护，请勿手动编辑。

## References

- 外部链接
- 代码路径引用

## Notes

- 依赖关系
- 配置要求
- 已知限制
