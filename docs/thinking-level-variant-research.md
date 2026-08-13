# pi 与 OpenCode 模型推理强度配置机制对比调研（thinking level / variant）

> 调研范围：pi 0.83.0（nix store 安装）与 OpenCode v1.18.18（源码 checkout `/home/cambricon/Code/Agent/opencode`）
> 对比对象：ZooKeeper 双宿主配置生成（`install.py`）
> 日期：2026-08-13

## 一、背景

用户问题：**"pi 要怎么设置模型的 variant 或者 effort"**。

ZooKeeper 的 `install.py` 生成双宿主配置：OpenCode（`~/.config/opencode/opencode.json` + `~/.local/state/opencode/model.json`）和 pi（`~/.pi/agent/settings.json` + `~/.pi/agent/models.json`）。其中 OpenCode 侧已经具备成熟的 variant（档位）配置通道，而 pi 侧完全没有对应支持。

术语澄清：**pi 没有 "variant" 概念**，其对应物是 **thinking level**（推理强度等级）；OpenCode 的 **variant** 则是"名字 → 任意 options 对象"的映射表。两者在概念模型、内置档位、持久化方式上差异很大，ZooKeeper 的 `[zoo.variants]` 配置目前只能落到 OpenCode 侧。本文档梳理两套机制的完整链路，说明 ZooKeeper 现状与差距，并给出可选改进方向。

---

## 二、pi 侧机制（pi 0.83.0）

### 2.1 thinking level：固定 7 级枚举

pi 用 thinking level 表示模型推理强度，等级固定为 7 级：

```
off | minimal | low | medium | high | xhigh | max
```

类型定义（`@earendil-works/pi-ai/dist/types.d.ts:22-24`）：

```typescript
type ThinkingLevel =
  | "minimal" | "low" | "medium"
  | "high" | "xhigh" | "max";

type ModelThinkingLevel = "off" | ThinkingLevel;

type ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;
```

### 2.2 models.json 模型条目 schema

pi `models.json` 中每个模型条目的 schema（`dist/core/model-config.d.ts:3-113`）字段为：

`id` / `name` / `api` / `baseUrl` / `reasoning` / `thinkingLevelMap` / `input` / `cost` / `contextWindow` / `maxTokens` / `headers` / `compat` / `samplingParams`

**没有 variant / effort 字段**。与推理强度相关的字段只有 `reasoning`（布尔）和 `thinkingLevelMap`（等级 → provider 参数的映射表）。

### 2.3 thinkingLevelMap 三态语义

`thinkingLevelMap` 是"模型支持的等级 → 发给 provider 的字符串"的映射，值的三种形态语义不同：

| 值 | 语义 |
|----|------|
| 字符串（如 `"high"`） | 该等级受支持，且**原样**作为参数发给 provider |
| `null` | 该等级**不受支持**（UI 隐藏、请求时 clamp 到最近支持等级） |
| 省略（不声明该键） | 标准等级走 provider 默认映射；**`xhigh` / `max` 必须显式声明才支持** |

### 2.4 消费逻辑：thinkingLevel → provider 参数

运行时把选中的 level 翻译成各 provider 的具体参数：

- **OpenAI 兼容协议**（`openai-completions.js:638-645`）：直接映射到 `reasoning_effort`：

```javascript
params.reasoning_effort = model.thinkingLevelMap?.[level] ?? level;
```

- **Anthropic Messages 协议**（`anthropic-messages.js:597-612`）：经 `mapThinkingLevelToEffort` 归并（`minimal`/`low` → `low`、`medium` → `medium`、其余 → `high`），adaptive 模式发 `thinking: { type: "adaptive", effort }`。
- **compat 相关字段**：`supportsReasoningEffort`（布尔）、`thinkingFormat`（`openai` / `openrouter` / `deepseek` / `zai` / `qwen` 等）、`forceAdaptiveThinking`。

### 2.5 运行时选等级入口

| 入口 | 作用域 | 说明 |
|------|--------|------|
| `settings.json` 的 `defaultThinkingLevel` | 全局 | 全局默认等级（`settings-manager.d.ts:65`），另有 `thinkingBudgets` |
| CLI `--thinking <level>` | 会话 | 启动时指定等级 |
| CLI `--model <pattern>:<level>` | 会话 | 按模型 pattern 指定等级 |
| CLI `--models sonnet:high,haiku:low` | 会话 | Ctrl+P 循环列表 `scopedModels`，每个条目各带 `thinkingLevel`（`cli/args.js:228,242,250`，帮助示例 `:315`） |
| 交互 `/settings`、Shift+Tab | 会话 | TUI 内切换 |

### 2.6 无 per-model 持久默认

pi **没有** per-model 的持久等级默认机制：

- `settings.json` 的 `defaultModel` 不解析 `:level` 后缀——`model-resolver.js:469` 仅 `getModel(provider, modelId)` 精确查找；
- `models.json` 无默认 level 字段；
- `defaultThinkingLevel` 全局生效，无法按模型区分。

最接近 per-model 持久化的手段是 **shell alias**（如 `alias pi="pi --thinking high"`），不落入任何配置文件。

### 2.7 ZooKeeper 生成的 pi models.json 现状

`installer/pi.py` 的 `_convert_provider_to_pi` 只输出 `id` / `name` / `reasoning` / `contextWindow` / `maxTokens` / `cost`。因此 ZooKeeper 生成的 `~/.pi/agent/models.json` 模型条目中 `reasoning` 为布尔 `true`，**无 `thinkingLevelMap`**——走 pi 的 provider 默认映射（标准等级有默认档、`xhigh`/`max` 不声明即不支持）。

---

## 三、OpenCode 侧机制（v1.18.18）

### 3.1 variant 概念：per-model 档位映射表

variant 是「**名字 → 任意 options 对象**」的映射表，per-model 定义。schema（`packages/core/src/v1/config/provider.ts:63-73`）：

```typescript
// provider.<id>.models.<id>.variants
variants?: {
  [name: string]: {
    disabled?: boolean;          // 可剔除内置档位
    reasoningEffort?: string;    // 任意 options，最终 merge 进请求参数
    textVerbosity?: string;
    [key: string]: unknown;
  };
};
```

另有 agent 级入口 `agent.<name>.variant`（`packages/core/src/v1/config/agent.ts:15-17`），指定该 agent 默认选中的档位名。

### 3.2 档位三层来源（deep-merge 合并）

1. **内置启发式**（`packages/opencode/src/provider/transform.ts`）：`WIDELY_SUPPORTED_EFFORTS`、`OPENAI_EFFORTS` 硬编码档位名，按 provider 的 `api.npm` 分派——OpenAI → `reasoningEffort`、Anthropic → `thinking: { type: "adaptive", effort }`、Google → `thinkingConfig.thinkingLevel` 等；
2. **models.dev 数据**：`reasoning_options` 字段（`effort` / `toggle` / `budget_tokens`）经 `reasoningVariants()` 合成档位；
3. **用户 `opencode.json` 配置**：与内置档 deep-merge（`provider.ts:1633-1644`），用户表覆盖内置档。

### 3.3 应用点：请求参数最后 merge

选中的 variant 的 options 在请求组装时**最后 merge**（优先级最高，`session/llm/request.ts:80-91`），最终由 AI SDK 转成 wire 参数。

### 3.4 选档入口与优先级

```
CLI --variant  >  ~/.local/state/opencode/model.json 的 "variant" 键  >  会话历史
```

- TUI：`ctrl+t` 切换；
- `agent.<name>.variant` 仅当该 agent 配置的模型与 variant 表匹配时生效。

### 3.5 官方自定义示例与本机实际状态

官方示例（`opencode.json`）：

```json
{
  "provider": {
    "openai": {
      "models": {
        "gpt-5": {
          "variants": {
            "thinking": { "reasoningEffort": "high", "textVerbosity": "low" },
            "fast": { "disabled": true }
          }
        }
      }
    }
  }
}
```

本机 `~/.local/state/opencode/model.json` 实际内容（ZooKeeper 安装写入）：

```json
{
  "variant": {
    "Cambricon/glm-5.2": "high",
    "OpenCodeGo/deepseek-v4-flash": "max",
    "OpenAI/gpt-5.5": "high",
    "MoonShot/k3-256k": "default"
  }
}
```

---

## 四、ZooKeeper 现状与差距

### 4.1 配置声明：`config.toml` 的 `[zoo.variants]`

`config.toml:507-515`：

```toml
# ── Variants ──────────────────────────────────────────────────────────────────

[zoo.variants]
"Cambricon/glm-5.2"            = "high"
"OpenCodeGo/deepseek-v4-flash" = "max"
"OpenAI/gpt-5.5"               = "high"

[zoo.variants.beaver]
"OpenAI/gpt-5.5" = "low"
```

- 全局通道：`[zoo.variants]` 下 `"Provider/model" = "档位名"`；
- 按 agent 通道：`[zoo.variants.<agent>]` 子表，按 agent 覆写。

### 4.2 只写 OpenCode：两条落地路径

| 通道 | 落点 | 实现位置 |
|------|------|----------|
| 全局 | `~/.local/state/opencode/model.json` 的 `"variant"` 键（清缓存后重建） | `install.py:156-168`（`collect_variants` → `write_json`） |
| 按 agent | `opencode.json` 的 `agent.<name>.variant` 字段 | `installer/opencode.py:153-174`（`collect_agent_variants` → 注入） |

校验逻辑集中在 `installer/variants.py`：`collect_variants`（全局）与 `collect_agent_variants`（按 agent），两者共用 `_validate_variant_key` 校验 `"Provider/model"` 键格式、provider/模型存在性、variant 值非空。

### 4.3 pi 侧零支持

- `installer/pi.py` 全文无 variant / effort 引用；`_convert_provider_to_pi` 只输出 `id` / `name` / `reasoning`（布尔）/ `contextWindow` / `maxTokens` / `cost`；
- `install.py` 的 `has_pi` 分支（`:207-266`）从不调用 variants 相关函数——pi 的 `settings.json` / `models.json` 生成完全不感知 `[zoo.variants]`。

### 4.4 差距总结

1. **配置声明无法透传**：`config.toml` 中声明的档位只对 OpenCode 生效，pi 侧 `models.json` 没有任何对应字段（无 `thinkingLevelMap`，`reasoning` 仅布尔）。
2. **概念不匹配**：OpenCode variant 是任意命名档（`high`/`max`/`default`…），pi 的对应物是**固定 7 级** thinking level，且 pi **无 per-model 持久选择机制**（无 per-model 默认字段，`defaultModel` 不解析 `:level`）——`[zoo.variants]` 的 per-model 语义无法直接映射到 pi 的持久化模型。

---

## 五、对比表

| 维度 | pi（thinking level） | OpenCode（variant） |
|------|----------------------|---------------------|
| **概念模型** | 固定枚举等级（`off \| minimal \| low \| medium \| high \| xhigh \| max`） | 「名字 → 任意 options 对象」映射表，名字任意 |
| **键集合** | 固定 7 级键（`types.d.ts:22-24`） | 任意命名档，无固定集合 |
| **值语义** | 字符串（原样发 provider）/ `null`（不支持，clamp）/ 省略（走默认映射，`xhigh`/`max` 须显式声明） | 任意 options 对象（`reasoningEffort`、`textVerbosity`、`disabled`…），最终 merge 进请求 |
| **内置档位** | 无（靠 provider 默认映射） | 有：内置启发式（`transform.ts` 的 `WIDELY_SUPPORTED_EFFORTS`/`OPENAI_EFFORTS`）+ models.dev `reasoning_options` |
| **用户覆盖** | `thinkingLevelMap` 声明即原样发 | 用户表与内置档 deep-merge 覆盖（`provider.ts:1633-1644`） |
| **参数翻译** | `reasoning_effort`（openai-completions.js:638-645）/ `mapThinkingLevelToEffort` + adaptive（anthropic-messages.js:597-612） | 按 `api.npm` 分派：`reasoningEffort` / `thinking: {type:"adaptive",effort}` / `thinkingConfig.thinkingLevel` 等（`transform.ts`） |
| **per-model 持久化** | ❌ 无：`defaultThinkingLevel` 全局生效；`defaultModel` 不解析 `:level`（model-resolver.js:469）；最接近的是 shell alias | ✅ `model.json` 的 `"variant"` 键 per-model 持久 |
| **选档入口** | `settings.json defaultThinkingLevel`、CLI `--thinking` / `--model <pattern>:<level>` / `--models`（Ctrl+P `scopedModels`）、`/settings`、Shift+Tab | CLI `--variant`、TUI `ctrl+t`、`agent.<name>.variant`（agent 级） |
| **优先级** | 会话级 CLI > 全局 `defaultThinkingLevel` | CLI `--variant` > `model.json` `"variant"` 键 > 会话历史；agent 级 variant 仅当模型匹配生效 |
| **ZooKeeper 支持** | ❌ 零支持（`installer/pi.py` 无引用，`install.py:207-266` 不调用 variants 函数） | ✅ `[zoo.variants]` → `model.json`（`install.py:156-168`）+ `agent.<name>.variant`（`installer/opencode.py:153-174`） |

---

## 六、结论与可选改进方向

### 6.1 结论

- 用户问"pi 怎么设置 variant / effort"的答案：**pi 没有 variant 概念**，对应物是 thinking level；运行时可用 `pi --thinking <level>` 或 `/settings` 切换，持久化只有全局的 `defaultThinkingLevel`，没有 per-model 默认。
- ZooKeeper 的 `[zoo.variants]` 目前是 **OpenCode 专属配置**：只写入 `model.json` 与 `opencode.json` 的 agent 块，pi 侧完全不可见。

### 6.2 可选改进方向

**① `installer/pi.py` 透传 `thinkingLevelMap`**

在 `_convert_provider_to_pi` 中把 `config.toml` 声明的档位翻译成 pi 的 `thinkingLevelMap` 写入 `models.json`。难点在于两套值域不同（任意档名 vs 固定 7 级键 + 三态值），需要一个声明语义的映射约定（如把档名对齐到 7 级枚举，或引入新的 TOML 字段）。

**② 弥补 pi 无 per-model 持久选择的机制缺口**

`[zoo.variants]` 的 per-model 语义无法直接映射到 pi：pi 无 per-model 默认等级字段、`defaultModel` 不解析 `:level`。若要让 pi 侧也支持 per-model 持久档位，只能依赖 shell alias / 启动包装（不入配置文件），或等待 pi 上游提供 per-model 默认能力。这是**上游机制限制**，ZooKeeper 侧只能做 best-effort 透传（`thinkingLevelMap`），无法完整复刻 OpenCode 的持久化选档体验。
