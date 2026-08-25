# Logos 多缓冲区与多文件 Diff 架构探索

## 结论

可以实现接近 Zed 的多缓冲区体验，但 Monaco 没有公开的“一个编辑器挂载多个 `ITextModel`”能力，不能靠一个选项直接开启。推荐路线是：

1. 以现有、真实的文件 `ITextModel` 作为唯一事实来源；
2. 在一个滚动表面中呈现多个 excerpt，每个 excerpt 仍绑定原文件模型；
3. 在 Logos 层实现 excerpt 坐标、跨模型命令和事务；
4. Diff、搜索、诊断、引用只负责生产 excerpt，复用同一套表面。

当前已落地第一块可运行切片：Git 面板可打开“未提交的更改”多文件 Diff。它用多个真实 Monaco Diff Editor 组成统一滚动表面，支持分段、折叠、自动刷新和打开源文件。它是验证 UI 与生命周期的 MVP，**还不具备 Zed 的统一光标、跨文件撤销和 excerpt 级暂存语义**。

## 参照语义

Zed 的公开文档和源码给出了需要保持的核心行为：

- 多缓冲区中的编辑会同步到其他地方打开的同一源文件；保存操作保存涉及的全部文件。
- excerpt 分隔线和 `open excerpts` 可以返回源文件的准确位置。
- 项目搜索、诊断、查找引用和多目标定义都是 excerpt 的生产者。
- Project Diff 也是普通多缓冲区；其中 excerpt 可编辑，并能按 hunk 或文件暂存。
- 多缓冲区事务在内部记录各源 buffer 的事务，再提供统一的 edited range 与 undo/redo。

相关上游资料：

- [Zed Multibuffers](https://zed.dev/docs/multibuffers)
- [Zed 开发术语中的 Buffer / Multibuffer](https://github.com/zed-industries/zed/blob/main/docs/src/development/glossary.md)
- [Zed 多缓冲区事务实现](https://github.com/zed-industries/zed/blob/main/crates/multi_buffer/src/transaction.rs)
- [Zed Project Diff 文档](https://zed.dev/docs/git#project-diff)

## Logos 当前边界

当前编辑链路围绕单文件设计：

- `MonacoEditor` 为文件 URI 创建一个 `ITextModel`，并在模型上维护 dirty baseline、磁盘 revision、文件监听和 LSP 文档生命周期。
- `GitDiffEditor` 一次加载一个文件，创建 original / modified 两个临时模型。
- `EditorTab` 只表达单文件或单文件 Diff，没有 excerpt、来源或坐标映射。
- LSP provider 依赖真实文件 URI；Monaco 的补全、hover、schema 与 TypeScript import resolution 都以模型和 URI 为边界。

Monaco 的公开 Diff Editor 接受一对模型；view zone 只能在一个模型的行间插入 UI，不能把多个模型合成一个可编辑模型。因此，把多个文件拼成一个 synthetic string 会立刻失去正确的语言、URI、LSP、undo 和外部变更语义。

## 方案比较

| 方案 | 优点 | 主要问题 | 决策 |
| --- | --- | --- | --- |
| 一个 synthetic `ITextModel` 拼接所有 excerpt | 原生单滚动区、原生跨全文选择 | 单语言/单 URI；LSP、编辑映射、撤销和外部变更都要重写 | 不作为主路线 |
| 一个滚动表面 + 多个真实模型/编辑器 | 保留语法、URI、LSP、源模型与文件同步；可增量交付 | 跨 excerpt 光标、命令与撤销需由 Logos 协调；要做虚拟化 | 推荐 |
| Fork Monaco/VS Code 内部 ViewModel | 理论上可做真正 composite view model | 内部 API 不稳定，升级和维护成本不可控 | 不采用 |

## 目标数据模型

```ts
interface ExcerptAnchor {
  path: string;
  start: { line: number; column: number };
  end: { line: number; column: number };
  contextBefore: number;
  contextAfter: number;
}

interface MultiBufferExcerpt {
  id: string;
  source: ExcerptAnchor;
  kind: "search" | "reference" | "diagnostic" | "diff" | "manual";
  collapsed: boolean;
  metadata?: { matchId?: string; diagnosticId?: string; hunkId?: string };
}

interface MultiBufferDocument {
  id: string;
  title: string;
  excerpts: MultiBufferExcerpt[];
  activeExcerptId: string | null;
}
```

excerpt 的行范围不能只存裸行号。源模型被编辑后，范围必须跟随文本移动。第一版可用 Monaco decoration 的 stickiness 作为 anchor；稳定后将 anchor 抽成独立接口，避免把数据模型绑定到 Monaco DOM 生命周期。

## 推荐分层

### 1. BufferRegistry

把目前散落在 `MonacoEditor` 模块级 Map 中的模型、baseline、revision、watch 与 LSP open/close 引用计数收拢到 workspace 级 registry。普通编辑器和多缓冲区 excerpt 共享同一模型，最后一个 consumer 关闭时才 dispose。

### 2. ExcerptController

负责：

- anchor 到实时源范围的解析；
- 展开/收缩上下文；
- excerpt 排序、折叠、合并重叠范围；
- 多缓冲区位置与 `{ path, line, column }` 的双向映射；
- 打开源文件并恢复准确选择。

### 3. MultiBufferSurface

使用单一外层滚动容器。每个可见 excerpt 挂载一个无内部纵向滚动条的 Monaco Editor，并直接绑定 BufferRegistry 中的源模型；编辑器用 hidden areas 只显示 excerpt 行段。大结果集必须按 viewport 虚拟化，保留模型和 selection 状态但卸载离屏 editor view。

### 4. CommandCoordinator

键盘焦点仍位于一个 Monaco 实例，因此以下命令需要提升到表面层：

- 上/下一个 excerpt、打开 excerpt；
- 跨 excerpt 的 select all matches / 多光标输入；
- save all；
- 跨文件 workspace edit；
- undo/redo 多模型事务。

普通输入先只作用于当前 excerpt。跨 excerpt 多光标需要捕获编辑意图，按源模型分组执行 `executeEdits`，然后记录一个 Logos transaction，其中保存每个源模型对应的 undo 边界。

## 多文件 Diff

### 当前 MVP

- Git 面板工具栏的“查看所有更改”打开一个 `multi-diff` tab。
- 同一文件同时存在 staged 与 working-tree 变化时，分别生成两个 excerpt，避免混淆比较基线。
- 每个 excerpt 使用真实语言模式和 inline Monaco Diff Editor。
- 文件头可折叠；文件名可打开源文件；Git 状态刷新后重新加载。
- 单 excerpt 高度上限为 4000 px，超出后保留局部滚动，避免异常大文件撑爆页面。

### MVP 限制

- 这是多编辑器组合表面，不是统一可编辑 multibuffer。
- 每个 excerpt 当前会单独请求 `fileDiff`，而该调用还会读取一次 Git status；大 changeset 需要批量 IPC。
- 当前显示完整文件 diff，不会只截取 hunk 与上下文行。
- 没有 word diff、hunk stage/unstage、restore、统一 additions/deletions 统计和键盘 next/previous hunk。
- staged 与 working-tree 是两个 excerpt；Zed Project Diff 的最终形态应允许明确切换 base，同时保留统一文件级操作。

### 生产化步骤

1. 新增一次性 `projectDiff(root, base)` IPC，返回稳定 snapshot id、文件状态与 hunks，消除 N+1 Git 调用。
2. 用 hunk 范围生成 excerpt，仅保留可配置的上下文行；相邻 hunk 自动合并。
3. modified 侧绑定 BufferRegistry 中的工作区模型，使工作区 Diff 可编辑。
4. 把 patch/hunk id 保存在 metadata 中，支持 stage、unstage、restore 与 stage-and-next。
5. 增加 viewport 虚拟化、统一 minimap/scrollbar 标记和 changeset 级统计。

## 分阶段交付

### Phase 0：已完成的探索切片

- 可点击并定位资源管理器的面包屑。
- 多文件 Diff tab、折叠分段、打开源文件、状态刷新。
- 路径映射单元测试。

### Phase 1：模型基础

- BufferRegistry 与引用计数。
- excerpt/anchor/position map 的纯数据实现和测试。
- 只读 MultiBufferSurface，先接入搜索结果。

### Phase 2：导航消费者

- 项目搜索、诊断、引用、多个定义统一产出 excerpt。
- excerpt 展开上下文、合并、跳转源文件、next/previous。
- 大结果集虚拟化与性能预算。

### Phase 3：可编辑语义

- excerpt 绑定源模型并实时双向同步。
- save all、外部变更冲突、跨 excerpt 多光标。
- 多模型事务、undo/redo、workspace edit 与 LSP 重映射。

### Phase 4：完整 Project Diff

- hunk excerpt、word diff、stage/unstage/restore。
- editable project diff、统计、过滤与 base 切换。
- 与普通多缓冲区共享命令和视觉组件。

## 验收标准

- 同一文件在普通 tab 与多缓冲区中始终共用一个源模型，不发生内容分叉。
- 编辑任意 excerpt 后，普通 tab、dirty 状态、LSP 与磁盘保存结果一致。
- 一个跨文件操作可作为单个 Logos transaction 撤销和重做。
- excerpt 边界不可被普通输入删除；跨边界选择有确定行为。
- 10,000 个搜索结果不同时挂载 10,000 个 Monaco view；滚动保持可用。
- Project Diff 能按 hunk 和文件操作，任何操作后 excerpt 与 Git 状态一致。

## 最终建议

保留当前多文件 Diff 作为产品可用的短期能力，但不要基于它继续堆叠跨文件编辑逻辑。下一步应先抽 BufferRegistry 和 excerpt anchor；这是搜索、诊断、引用、Diff 最终复用同一多缓冲区能力的共同地基。
