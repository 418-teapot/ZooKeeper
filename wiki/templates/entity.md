---
title: <实体名称>
description: <一句话摘要>。
type: entity
timestamp: YYYY-MM-DDTHH:mm:ssZ
tags: [tag1, tag2]
related:
  - concepts/foo.md
status: draft|review|stable|deprecated
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

## Relations

- [概念](concepts/related-concept.md) — 实现的领域概念
- [源文档](sources/adr/some-adr.md) — 相关决策记录

## Backlinks

由 `backlinks.py` 自动维护。列出引用本页面的其他页面。

## References

- 外部链接
- 代码路径引用

## Notes

- 依赖关系
- 配置要求
- 已知限制
