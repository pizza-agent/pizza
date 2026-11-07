# 统一命令表（Unified Command Table）改造设计

> 状态：**已实现**（branch `feat/unified-command-table`）。**不考虑向后兼容**：旧的 `tools` 取值、独立 native 工具、相关 SDK 导出直接删除。
>
> 面向：pizza 核心开发者。

---

## 1. 目标与范围

**目标**：模型侧只有一个 `cli` function tool，内部是一张 **命令表**：

- 内置命令（`_read`、`_write`、`_edit`、`_skill`…）与扩展/SDK 注册的 `_xxx` 命令，进程内执行；
- **shell 是命令表的兜底项**：首词不在表中才交给环境 shell 执行，可关闭；
- 调用方用 `tools` 按命令名选择：`["_read", "_write", "shell"]`。

**直接删除**：

- 独立 native function tool：`read`/`write`/`edit`/`grep`/`find`/`ls`，以及 `"cli"`/`"bash"` 这两个 `tools` 取值；
- `ToolName`、`allToolNames`、`DEFAULT_LLM_TOOLS`、`createToolDefinition`/`createTool`/`createAll*`/`createCodingTools`/`createReadOnlyTools`、`create{Read,Write,Edit,Grep,Find,Ls}Tool` 等 SDK 导出；
- `grep.ts`/`find.ts`/`ls.ts`（cli 内不使用；shell 缺命令时由 `compat-commands.ts` 的 shim 兜底，与这三个文件无关）。

**不在范围**：`customTools` / `ExtensionAPI.registerTool`（独立 function tool）保持现状；SDK 入口继续用 `createSessionFacade`。

## 2. 现状

### 2.1 tools 的生效路径

- `CreateSessionFacadeOptions.tools?: string[]` 只决定暴露哪些 function tool（默认 `["cli"]`，`"bash"` 是别名；`read`/`grep` 等可作为独立工具暴露）。本地 CLI `--tools` / `--no-tools` 写入同一字段。
- cli 内开哪些内置命令由 `session-facade-factory.ts` 按环境决定（`skill` 需有 skill，`tell` 需 `agentDir`，`cron` 需 scheduler），调用方无法选择。
- shell 没有开关：cli 中任何非 `_xxx` 命令都会 spawn 子进程。

### 2.2 一条 cli 命令的分发路径

1. `reactor.ts`：`classifier.classify("cli", args)` → `beforeToolCall`（扩展 `tool_call` 钩子）→ 执行。
2. `bash.ts` `execute`：`parseBuiltinCommand` 拆词，按首词分流：扩展动态命令优先（`details.builtin.name` 如 `"_computer_use"`）→ `BUILTIN_COMMANDS` 静态内置（`details.builtin.name` 为不带下划线的 `"read"`…）→ 其余交给 `BashOperations.exec`。
3. 渲染：`renderCall` 只拿到原始 `args`，用 `parseBashBuiltinCommand` 再解析一次；`renderResult` 读 `details.builtin`。

### 2.3 问题清单

| # | 问题 | 位置 |
|---|------|------|
| P1 | 调用方无法选择 cli 里开哪些命令；shell 关不掉；`tools` 同时承载 function tool 与命令两层概念 | `session-facade-factory.ts`、`tool-assembly.ts`、`bash.ts` |
| P2 | read/write/edit 有三套入口：独立 function tool、cli 内 `_xxx`、`pizza builtin` 的简化 `executeRead/Write/Edit` | `tools/index.ts`、`builtin-commands.ts`、`cli-main.ts` |
| P3 | 同一命令多处各自解析：classifier `parseBuiltinInvocation`（只看第一行、只认 `_read/_write/_edit`）、`execute`、`renderCall` | `classifier.ts`、`bash.ts` |
| P4 | `_skill/_cron/_tell/_session_split/_history_tree`/动态命令无专门分类，落入 shell 正则 | `classifier.ts` |
| P5 | 内置命令不接收 `timeout` | `bash.ts` |
| P6 | 内置命令参数错误/操作符拒绝以普通文本返回，不标错误 | `bash.ts` |
| P7 | `tool_call` 钩子只看到 `cli` + 原始字符串 | `reactor.ts`、`extensions/types.ts` |
| P8 | 命令说明硬编码，与实际开启的命令不一致；自定义 system prompt 时命令说明丢失 | `system-prompt.ts`、`prompt-builder.ts` |
| P9 | `details.builtin.name` 静态内置不带下划线、动态命令带下划线，不统一 | `bash.ts` |

## 3. 目标架构

```mermaid
flowchart LR
  M[模型] -->|cli(command)| RS[cli.resolve: parse + 查表]
  RS --> RC[ResolvedCommand]
  RC --> CL[classifier 审批]
  RC --> HK[tool_call 钩子]
  RC --> EX{execute}
  EX -->|command| IP[handler 进程内]
  EX -->|shell| SH[BashOperations.exec]
  EX -->|unavailable| ER[错误 + 可用命令列表]
```

### 3.1 命令表（CommandRegistry）

一个会话一张表，三类来源统一注册：

| 来源 | 注册方式 |
|------|----------|
| 内置 | `tools` 中的 `_read` 等名字 |
| 扩展 | `ExtensionAPI.registerCliCommand`（`registerCommand` 已被 slash 命令占用，故 cli 命令用区分名） |
| SDK | `tools` 中的 `defineCliCommand(...)` 对象 |

- 名字规则：`^_[a-z][a-z0-9_-]*$`。
- 冲突：内置不可覆盖；扩展与 SDK 同名时后注册者失败并告警（扩展异步加载，表现为该命令加载失败，会话继续）。
- 兜底：开启 `shell` 时，首词未命中表的命令交给 shell；否则返回 `unavailable`，附可用命令列表。

### 3.2 命令接口

```ts
export interface CliCommandDefinition<P = any> {
  /** 带下划线前缀，如 "_read"、"_query_order" */
  name: string;
  /** 一行摘要：用于 cli description 与 system prompt 命令表 */
  description: string;
  /** 用法行，如 "_read <path> [offset] [limit]" */
  usage?: string;
  /** `<name> -h/--help/help` 的完整帮助；省略时由 description/usage/parameters 生成 */
  help?: string;
  promptGuidelines?: string[];
  /** 参数解析二选一：parseArguments 手写，或 parameters 由框架生成 --flag 解析（另支持 --json '<obj>'） */
  parseArguments?: (args: string[], heredoc: string | undefined, meta: CliCommandParseMeta) => P;
  parameters?: TSchema;
  /** 环境检查：返回 false 时命令不进 prompt，调用返回 unavailable */
  isAvailable?: () => boolean;
  /** isAvailable 为 false 时的返回文案 */
  unavailableReason?: string;
  /** 审批分类：只给类别与受影响文件，是否审批由 classifier 按配置决定；省略为 unknown */
  classify?: (params: P) => ToolCallIntent;
  execute(
    toolCallId: string, params: P, signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<any> | undefined, ctx: ExtensionContext,
  ): Promise<AgentToolResult<any>>;
  renderCall?: (args: P, theme: Theme, context: ToolRenderContext<any, P>) => Component;
  renderResult?: (result, options, theme, context) => Component;
}

export type ResolvedCliCommand =
  | { kind: "command"; source: CliCommandSource; name: string; params: unknown; spec: CliCommandDefinition; raw: string }
  | { kind: "help"; source: CliCommandSource; name: string; text: string; raw: string }
  | { kind: "shell"; raw: string }
  | { kind: "unavailable"; name?: string; raw: string; reason: string };
```

- 内置命令在 `builtin-cli-commands.ts` 中改写为 `CliCommandDefinition` 条目（底层实现复用 `read.ts`/`write.ts`/`edit.ts` 的 `createXToolDefinition`），`builtin-commands.ts` 的参数解析器作为各自的 `parseArguments`。
- 每个命令自带 `renderCall`/`renderResult`，cli 渲染时按 `ResolvedCliCommand` 委托，取代 `builtinDefinitions` 映射与 `createAllToolDefinitions`。
- 参数解析错误在 resolve 阶段产出 `unavailable`，不进入审批。

### 3.3 内置命令分类（修 P4）

| 命令 | category | affectedFiles |
|------|----------|---------------|
| `_read`、`_skill` | `file_read` | 路径 |
| `_write`、`_edit` | `file_write` | 路径 |
| `_session_split`、`_history_tree` | `shell_safe` | — |
| `_cron` list,show / 其它 | `shell_safe` / `shell_moderate` | — |
| `_tell` list / 其它 | `shell_safe` / `shell_moderate` | — |

shell 分支沿用现有正则；`safe_mode` 与 `require_approval_*` 语义不变。classifier 中 `read`/`write`/`edit`/`grep`/`find`/`ls`/`truncate`/`builtin` 等旧工具名 case 删除。

### 3.4 只解析一次（修 P3、P7）

- `ToolDefinition` 新增可选 `resolve?(args) => unknown`；cli 实现为 `parseBuiltinCommand` 拆词 → 查表 → `ResolvedCommand`。
- `reactor.ts` 在审批前调用 `resolve`，结果挂在本次 tool call 上，依次传给：
  - `classifier.classify(toolName, args, resolved)`；
  - `beforeToolCall` / 扩展 `tool_call` 事件（新增 `resolved`）；
  - `execute`（经 ctx）。
- **防 TOCTOU**：审批期间命令表可能因 `refreshTools` 变化；`execute` 只使用审批时的 `resolved`，若 `registry.get(name)?.spec !== resolved.spec`（定义被替换或摘除）则拒绝执行。
- 渲染：`renderCall` 只有原始 `args`，调用同一个 `resolve`。删除 `parseBashBuiltinCommand` 与 `parseBuiltinInvocation`。

### 3.5 执行语义

- **timeout（修 P5）**：`timeout` 合成进传给 handler 的 `AbortSignal`；超时立即返回错误，未响应 signal 的副作用可能仍会完成（接口注释说明）。
- **错误语义（修 P6）**：`unavailable`、操作符拒绝、参数错误、handler 抛错均标 `is_error`；`help` 不标。
- **shell 操作符**：命令仍拒绝 `|`、`>`、`;`、`&&` 等，保持现有提示文本。
- **结果结构（修 P9）**：`details = { command: { source, name, args, details } }`，`name` 一律带下划线；替换原 `details.builtin`，`tool-adapter.ts`、computer-use 会话恢复、渲染同步改读新字段。

### 3.6 shell 兜底项

```ts
export interface ShellOptions {
  operations?: BashOperations;   // 远程/沙箱执行
  commandPrefix?: string;        // 默认来自 settings
  spawnHook?: BashSpawnHook;
  /** 策略，不是安全边界：可被 sh -c / env / xargs 等绕过；隔离请用 operations */
  policy?: { allow?: (string | RegExp)[]; deny?: (string | RegExp)[] };
}
```

- `policy` 对 `$(...)`、反引号、`|`、`&&`、`;`、换行拆出的每一段检查首词；检查对象是拼 `commandPrefix`、`spawnHook` 改写之前的模型原始命令。

## 4. `tools` 取值

```ts
type ToolsOptionEntry = BuiltinCommand | "shell" | CliCommandDefinition;
// BuiltinCommand = "_read" | "_write" | "_edit" | "_session_split" | "_history_tree" | "_skill" | "_cron" | "_tell"
```

| 取值 | 含义 |
|------|------|
| 不传 | `DEFAULT_TOOLS` = 全部内置命令 + `"shell"` |
| `"_read"` 等 | 把该内置命令加入命令表 |
| `"shell"` | 开启 shell 兜底 |
| `defineCliCommand(...)` | 注册 SDK 自定义命令 |
| `[]` | 命令表为空（扩展命令仍可注册）；表为空且无 shell 时不暴露 `cli` |

- 其它字符串（含 `read`、`grep`、`cli`、`bash`）启动时报错。
- 依赖环境的命令（`_skill`/`_tell`/`_cron`）统一走 `isAvailable`：不可用时不进 prompt，调用返回 `unavailable`（沿用 “not available in this session” 文案）。默认值与显式列名行为一致。
- 本地 CLI：`--tools _read,_write,_edit,shell`；`--no-tools` 等价 `[]`。

### 示例

```ts
import { createSessionFacade, defineCliCommand, DEFAULT_TOOLS, Type } from "@tomsun28/pizza";

// 默认：全部内置 + shell
await createSessionFacade({ model });

// 只读：不能写文件、不能跑 shell
await createSessionFacade({ model, tools: ["_read", "_skill"] });

// 纯服务端：内置 + 自定义命令，不 spawn 任何子进程
const queryOrder = defineCliCommand({
  name: "_query_order",
  description: "Query an order by id",
  usage: "_query_order --id <orderId>",
  parameters: Type.Object({ id: Type.String() }),
  classify: () => ({ category: "file_read" }),
  async execute(_id, { id }) {
    const order = await db.orders.find(id);
    return { content: [{ type: "text", text: JSON.stringify(order) }], details: undefined };
  },
});
await createSessionFacade({ model, tools: ["_read", "_skill", queryOrder] });

// shell 走沙箱
await createSessionFacade({ model, tools: DEFAULT_TOOLS, shell: { operations: mySandboxOps } });
```

## 5. System prompt（修 P8）

- “Underscore Commands” 段与 cli `description`/`promptSnippet` 从 `registry.available()` 生成（名字 + `description`，仅 `isAvailable` 为真者）；`promptGuidelines` 遍历命令表收集。
- shell 关闭时不输出 “Bash Commands” 段；`policy.allow` 存在时列出允许的命令。
- 自定义 system prompt 同样追加精简命令表（命令说明是工具契约的一部分，不应随 prompt 定制丢失）。
- 命令多时只列名字 + 摘要，详细用法靠 `<name> --help`。

## 6. 源码改造清单

| 文件 | 改动 |
|------|------|
| `src/core/tools/command-registry.ts`（新增） | 注册/查找/列举/冲突校验/`getCatalog()` |
| `src/core/tools/command-resolve.ts`（新增） | `resolve(raw, registry) → ResolvedCommand`；TypeBox → `--flag` 解析 |
| `src/core/tools/shell.ts`（新增，自 `bash.ts` 拆出） | `createLocalBashOperations`、输出截断/临时文件、`detectChainedBuiltin`、`policy` |
| `src/core/tools/bash.ts` → `cli.ts` | cli 外壳：schema、`resolve`、分发、timeout/错误语义、description 从注册表生成、渲染委托；`BashToolOptions` → `CliToolOptions` |
| `read.ts`/`write.ts`/`edit.ts`/`skill.ts`/`cron.ts`/`tell.ts`/`session-split.ts`/`history-tree.ts` | 改为导出 `CommandSpec`；`parseArguments` 从 `builtin-commands.ts` 迁入 |
| `grep.ts`/`find.ts`/`ls.ts` | 删除 |
| `src/core/tools/builtin-commands.ts` | 删除 `executeRead/Write/Edit` 与 `BUILTIN_COMMANDS` 硬编码表；仅保留通用拆词（`parseBuiltinCommand`、heredoc、`hasShellControlSyntax`） |
| `src/core/tools/index.ts` | 删除 `ToolName`/`allToolNames`/`DEFAULT_LLM_TOOLS`/`createToolDefinition`/`createTool`/`createAll*`/`createCodingTools`/`createReadOnlyTools`；导出 `DEFAULT_TOOLS`、`BUILTIN_COMMANDS` 注册表 |
| `src/cli-main.ts` | `pizza builtin _xxx` 通过命令表执行（需会话上下文的命令照旧报错） |
| `src/core/session/session-facade-factory.ts` | 解析新 `tools`；`shell` 选项；构建命令表与 cli |
| `src/core/facade/tool-assembly.ts` | 删除 native 工具与 `_include` 白名单逻辑；只组装 cli + 扩展/自定义 function tool；`refreshTools` 刷新命令表与 cli description |
| `src/core/extensions/types.ts`、`loader.ts` | `ToolDefinition.resolve?`；`tool_call` 事件增加 `command`；`registerCliCommand(CliCommandDefinition)` |
| `src/core/runtime/reactor.ts` | 审批前调用 `resolve`，贯穿 classifier / 钩子 / execute |
| `src/core/intent/classifier.ts` | `classify(toolName, args, resolved?)`；删除旧工具名 case 与 `parseBuiltinInvocation` |
| `src/core/context/system-prompt.ts`、`src/core/facade/prompt-builder.ts` | 命令说明从注册表生成 |
| `src/core/intent/tool-adapter.ts`、`src/builtin-extensions/computer-use/backend/bridge.ts` | 改读 `details.command` |
| `packages/tui/components/tool-execution.ts` | 删除 `createAllToolDefinitions` 兜底，cli 渲染委托命令自身渲染器 |
| `packages/cli/args.ts`、`src/main.ts` | `--tools` 接受新取值并校验；更新帮助与示例 |
| `src/core/sdk.ts`、`src/index.ts` | 删除旧工具工厂导出；导出 `defineCliCommand`、`DEFAULT_TOOLS`、`CliCommandDefinition`、`ShellOptions` 等 |
| `test/` | 删除 `tools.test.ts`、`3302-find-path-glob`、`3303-find-nested-gitignore` 等 native 工具测试；`block-images`、`image-resize-callers`、`file-mutation-queue`、`tool-execution-component`、`args.test.ts` 改为通过 cli/命令表测试 |

## 7. 实施与测试

1. **命令表与解析**：registry / resolve / shell 拆分；内置命令改写为 `CommandSpec`；`bash.ts` → `cli.ts`；classifier、渲染改用同一 `resolve`；删除 native 工具与旧导出。
   - 测试：`builtin-*`、`chained-builtin-*`、`edit-tool-arguments`、`cron-tool` 迁移后全绿；“classifier / execute / renderCall 解析结果一致”。
2. **执行语义**：timeout、`is_error`、内置分类、`tool_call` 带 `resolved`、TOCTOU 校验、`details.command`。
   - 测试：timeout/abort；help 不报错；分类表逐行；钩子按 `_write` 拦截；审批期间刷新命令表后执行被拒。
3. **`tools` 与 shell**：新取值校验、`defineCommand`、`ShellOptions`、`isAvailable`。
   - 测试：第 4 节规则逐行；非法取值报错；无 `"shell"` 时非 `_` 命令不 spawn（mock `BashOperations` 断言未调用）；`policy` 每段生效。
4. **prompt 生成**：快照（默认、无 shell、部分内置、含自定义命令、自定义 system prompt）。

## 8. 待决问题

1. TypeBox → `--flag` 自动解析的边界：嵌套对象、数组、带引号值；`--json '<obj>'` 是否作为统一兜底。
2. `_cron` 分类是否按子命令细分（3.3 建议）。
3. 远程 SSH 工作区：pizza 进程在远端运行，进程内命令自然落在远端；确认与 `shell.operations` 组合不冲突。
4. ~~旧会话（含 `toolName: "read"` 或 `details.builtin`）回放时退化为通用渲染~~ —— 已决定接受。
