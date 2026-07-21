# Logos Extension Host 实现审计与交付规划

> 状态：实施规划
> 日期：2026-07-21
> Logos 基线：`f9f582f`
> VS Code 对照基线：本地仓库 `41fe30d01a19`
> 安全约束：以 [`sandbox-architecture.md`](./sandbox-architecture.md) 为准；本计划不能放宽其中的失败关闭与每扩展隔离原则

## 1. 结论

Logos **当前没有 Extension Host**。仓库已经完成的是扩展包与开发 registry 的安全基础，而不是扩展运行时：

- 有版本化 manifest 类型、严格 manifest/registry 解析、运行时分类和权限申请结构。
- 有仅限未打包构建的本地 registry、归档摘要校验、安全 ZIP 检查、只读内容寻址安装目录和安装指针。
- 只有 `declarative` 包可安装；`wasm-component`、`vscode-web`、`vscode-node` 明确失败关闭。
- 尚未把已安装的声明式贡献注册到工作台，也没有 Supervisor、runner、扩展 RPC、Capability Router、授权数据库、Workspace Trust、扩展 FS/Network/Process broker 或 OS sandbox launcher。

因此下一步不能直接“加载一个 Node 入口”来宣称 Host 可用。正确的最短路径是先建立不执行第三方代码的已安装扩展模型和 Supervisor 控制面，再以假 runner 固化协议与身份边界，最后接入默认无 WASI 权限的 Wasm sidecar。

## 2. 当前实现审计

| 能力层 | 当前状态 | 代码证据 | 进入可执行 Host 前的缺口 |
|---|---|---|---|
| 公共契约 | 已有基础 | `packages/extension-api/index.d.ts` | 只有包/manifest 类型；没有 Host ABI、WIT SDK、版本协商或 capability handle |
| Manifest IR | 已实现第一版 | `src/electron/services/extension-manifest.ts` | 仍需把解析结果保存为安装期规范化 IR，并生成权限 diff/兼容性报告 |
| 开发 Registry | 已实现 | `src/electron/services/extensions.ts` | 仅本地目录；没有仓库签名、新鲜度、吊销和生产源 |
| 包检查与安装 | 部分实现 | SHA-256、ZIP 条目/大小/类型检查、staging、内容寻址目录、只读权限、安装记录 | 仍在 Electron 主进程；没有独立 Installer、发布者签名、SBOM、原子版本指针和启动前全文件复核 |
| 声明式贡献 | 仅能描述/安装 | manifest 支持 languages/grammars/themes/commands/configuration | 没有 installed-extension scanner、贡献 IR registry、启停/更新事务或资源加载器 |
| 扩展管理 UI | 已有开发视图 | `src/components/ExtensionsView.tsx` | 没有权限授权、版本 diff、quarantine、运行状态和审计视图 |
| Extension Supervisor | 未实现 | 无对应模块 | 需要实例状态机、运行位置选择、启动/停止、退避、版本切换和连接身份 |
| Extension Host | 未实现 | executable runtime 安装被阻止 | 需要 Wasm/Web/Node 独立 runner；初始只交付 Wasm |
| 内部协议 | 未实现 | 当前只有 workbench IPC channel | 需要版本化 envelope、握手、deadline/cancel、流控、队列上限和重放防护 |
| 能力与授权 | 仅有 manifest 申请结构 | manifest 中的 permission union | 没有产品策略、用户授权、Workspace Trust、运行时能力的交集计算 |
| Broker | 未实现 | 当前工作台 `window.logos` 不是扩展 API | 需要独立 FS/Network/Process/Secret/WebView broker；禁止复用工作台 preload API |
| OS 隔离 | 未实现 | Electron renderer sandbox 只保护工作台 | 需要 macOS helper/App Sandbox、Linux namespace/seccomp/Landlock、Windows AppContainer/Job |
| Workspace Trust | 未实现 | 无 trust 状态或策略数据库 | 需要阻止不可信项目触发任务、调试、项目工具/SDK/插件和动态配置 |

### 2.1 本次工作区加固形成的前置条件

本次变更完成 Host 之前可独立落地的工作台边界：

- 主 frame 响应强制 CSP，继续拒绝导航、弹窗、页面权限和 `<webview>` attach；生产内联启动脚本按生成内容计算 SHA-256，开发态只为本地 Nasti bootstrap 放行内联脚本。
- 所有 renderer→main handler 必须在集中表中声明 schema；统一检查 main-frame sender、结构深度、对象键、消息大小和每 channel 速率。未声明的新 channel 无法注册。
- 文件服务只接受 canonical workspace 内路径或原生文件对话框创建的精确会话授权；工作区前缀混淆、外部 symlink 和任意 `workspace.setRoot` 被拒绝。
- Git、终端 cwd、Agent cwd、LSP root/资源操作和调试源路径与当前工作区绑定。
- 删除工作台中的页面内 `<webview>` 渲染路径；通用外部打开只允许规范化的 HTTPS/`mailto:` URL，并经过原生确认。

这套 `WorkspaceAccessController` 只服务受信工作台，不是未来扩展 FS Broker。Extension Host 不能获得绝对路径，也不能调用当前 `window.logos` API。

### 2.2 仍需单独处理的工作台风险

工作区文件边界完成后，工作台 renderer 仍能调用第一方终端、调试和 Agent 能力。这些能力有自己的用户交互，但 preload 本身无法提供不可伪造的 DOM user-gesture 证明。因此在加载任何第三方 Web 内容前，还需把高风险启动动作收口到主进程授权/Workspace Trust 状态；不能把 CSP 或 sender 校验描述为恶意 renderer 的完整进程沙箱。

## 3. 从 VS Code 参考实现提炼的结构

本地 VS Code `41fe30d01a19` 提供了可复用的控制面分层：

1. `extensionHostKind.ts` 将 `LocalProcess`、`LocalWebWorker`、`Remote` 作为运行位置选择结果，而不是在 API 调用时临时决定。
2. `abstractExtensionService.ts` 维护 running location、创建 Host manager、处理 responsive/crash/restart 和激活事件。
3. `localProcessExtensionHost.ts` 将 renderer 侧 Host 客户端、主进程 starter、初始化数据和消息协议分离；启动前清理危险环境变量，并使用专用连接完成握手。
4. `extensionHostStarter.ts` 集中创建、启动、检查、等待和终止 Host 进程，管理动态 stdout/stderr/message/exit 事件。
5. `extensionHostManager.ts` 在握手后创建受控 RPC customers，把扩展 API 实现留在 Host 边界两侧，而不是暴露 Electron IPC。
6. `webWorkerExtensionHost.ts` 展示了 Web Host 的独立 iframe/Worker 启动、消息端口和初始化超时。
7. extension management 链路把下载、签名状态、manifest 身份核对、提取和 profile 安装拆开。
8. Workspace Trust 通过 enablement/manifest properties 影响扩展启用状态，而不是信任扩展自报字段。

Logos 应保留这些职责分层和生命周期思想，但做以下关键改变：

- VS Code 的一个 Host 可承载多个扩展；Logos 的安全主体是**单个扩展实例**，初始不池化。
- VS Code LocalProcess 继承大量 Node/用户权限；Logos runner 使用允许列表环境、私有 cwd 和 OS sandbox，能力只走 broker。
- VS Code RPC 面向宽 VS Code API；Logos 内部协议先以窄的 capability method ID 为核心，兼容层只能位于外围 adapter。
- `utilityProcess`/Worker 只是生命周期工具，不自动视为恶意代码安全边界。
- Workspace Trust 只收缩项目诱导的能力；它不能替代发布者信任、用户授权或运行时隔离。

## 4. 目标模块边界

建议在实现时形成以下边界；目录名可随代码约定调整，但职责不可重新混合：

```text
ExtensionService（工作台投影）
  ├─ InstalledExtensionScanner（只读安装记录/manifest IR）
  ├─ DeclarativeContributionRegistry（无代码贡献）
  └─ ExtensionSupervisor（可信控制面）
       ├─ PolicyEngine（产品策略 ∩ 包申请 ∩ 用户授权 ∩ workspace trust ∩ runtime）
       ├─ InstanceRegistry（instanceId / digest / workspace / lifecycle）
       ├─ RunnerLauncher（每扩展一个 OS sandbox 进程）
       └─ CapabilityRouter（连接绑定身份、deadline、取消、流控）
            ├─ ExtensionFsBroker
            ├─ NetworkBroker
            ├─ ProcessBroker
            ├─ SecretBroker
            └─ WebViewController
```

建议新增独立协议包，而不是把协议类型放进 Electron service：

```text
packages/extension-protocol/   # envelope、method ID、错误码、版本协商；无 Electron/Node API
packages/extension-api/        # 面向扩展作者的 manifest + SDK 类型
crates/extension-runner/       # Wasmtime Component runner（规划）
src/electron/extensions/       # Supervisor、launcher、broker 客户端与工作台投影
```

连接建立时 Supervisor 生成的 init 数据至少包含：

```ts
type ExtensionInstanceIdentity = {
  protocol: 1;
  extensionId: string;
  packageDigest: `sha256:${string}`;
  instanceId: string;
  workspaceId: string;
  runtime: "wasm-component" | "vscode-web" | "vscode-node";
  effectiveCapabilitiesDigest: `sha256:${string}`;
  nonce: string;
};
```

此身份通过 Supervisor 创建的连接绑定。请求 body 中即使出现 `extensionId` 也不能影响授权主体。

## 5. 分阶段交付

### H0：工作台前置加固

本次 PR 交付 CSP、集中 IPC 防线、workspace/dialog file authority、外部 URL 策略和 `<webview>` 移除。后续在第三方 Web 内容前完成第一方 terminal/debug/agent 启动授权与 Workspace Trust 收口。

退出条件：第三方内容没有进入工作台 renderer；任意新 IPC handler 若无声明策略则启动时失败；renderer 文件路径不能越过 workspace/dialog grant。

### H1：已安装扩展模型与声明式激活

交付物：

- `InstalledExtensionScanner` 从安装指针解析 `{id, version, digest}`，复核内容目录 marker、manifest 和所有被引用资源。
- 安装期 manifest 生成排序、无歧义的内部 IR；运行时不重新解释外部 JSON。
- `DeclarativeContributionRegistry` 以事务方式注册/撤销 language、grammar、theme、command metadata 和 configuration schema。
- 更新切换为“构建新投影 → 校验 → 原子替换 → 撤销旧投影”，失败保留旧版本。
- 禁止声明式 command 绑定脚本、动态 import、URL 或任意表达式。

测试/退出条件：篡改内容目录、缺失资源、重复 contribution ID、恶意 selector/grammar/theme 都在注册前失败；启停和回滚不残留贡献。此阶段仍不执行第三方代码。

### H2：Supervisor 状态机与 Host 协议

交付物：

- 状态机：`discovered → policy-pending → starting → handshaking → running → stopping → stopped/quarantined`。
- 每次启动生成不可复用的 `instanceId`、nonce、连接和有效 capability digest。
- `extension-protocol` 定义固定 method ID、严格 envelope、最大消息、deadline、取消、错误码、credit/backpressure 和协议版本协商。
- Supervisor 为每条本地连接生成 256-bit 连接密钥，通过启动时预先打开的一次性继承 pipe/handle 传给 runner；密钥不得进入 argv、环境变量、日志或磁盘。双方以 HKDF 派生方向独立的 MAC key，并用 Supervisor nonce、runner nonce、完整 `ExtensionInstanceIdentity` 和协议版本组成规范化握手 transcript，runner 与 Supervisor 分别返回 HMAC-SHA-256 证明，任一方验证成功前不得收发能力请求。
- 握手成功后每个请求/响应都携带连接 epoch、方向单调递增 sequence 和 requestId，并对规范化 envelope（含 body）计算 MAC；Router 只接受当前连接 epoch 和未使用的 sequence/requestId。新连接一旦建立就原子吊销并关闭旧连接；握手认证失败、MAC 不匹配、重复/过期 sequence 或 requestId 重放均拒绝该消息、记录安全事件并立即断开对应实例。
- `RunnerLauncher` 先接假 runner，可注入崩溃、卡死、重放、乱序响应和超大消息。
- Supervisor 实现 shutdown grace period、强杀、指数退避、连续崩溃 quarantine 和工作区/版本切换。

测试/退出条件：伪造身份、握手 MAC 错误、请求 MAC 错误、跨实例响应、旧连接/旧版本重放、握手超时和 IPC 洪泛都只终止对应实例；重连后旧连接立即不可用，且没有第三方代码进入 Electron 主进程或工作台 renderer。

### H3：权限数据库、Workspace Trust 与最小 Broker

交付物：

- `PolicyEngine` 实现架构文档中的六项交集，输出稳定 canonical policy 和 digest。
- 授权记录绑定 publisher、extension、digest/major、workspace、capability、scope 和生命周期。
- Workspace Trust 状态独立存储；不可信工作区硬拒绝 process、terminal、debug、workspace executable/SDK/plugin 和危险动态设置。
- 首个 `ExtensionFsBroker` 使用虚拟 URI、逻辑 glob、敏感文件 denylist、字节/并发配额和不跟随 symlink 的 handle-relative 遍历。
- 本地结构化审计日志记录策略决定和 broker 元数据，不记录内容/密钥。

测试/退出条件：manifest 声明本身不能授权；运行时撤销立即取消请求；跨 workspace/digest/instance handle 无效；路径穿越、symlink swap 和存在性 oracle 失败关闭。

### H4：Wasm Component Host（第一个可执行 Host）

交付物：

- Rust/Wasmtime sidecar，每扩展一个进程、store、memory/table、fuel/epoch 和配额。
- 初始 WIT 只包含 lifecycle、日志、时钟/随机数、声明式注册和 `workspace-read`；不启用 WASI filesystem/network/process。
- runner 只加载已安装 digest 下复核过的入口；cwd 为私有空目录，环境为允许列表。
- macOS/Linux/Windows launcher 与 sandbox probe；缺少要求的 OS 隔离时拒绝执行。
- SDK 版本与 Host ABI 独立协商，支持一个向后兼容窗口并明确错误。

测试/退出条件：恶意 Wasm 无法读取 home、环境、网络或创建进程；fuel/OOM/死循环只结束该实例；runner escape probe 仍被 OS 层阻断。

### H5：Network/Process/Secret Broker 与工具沙箱

按架构文档实现目标规范化、DNS/IP 双检查、重定向复核、secret handle 注入和结构化 ToolLaunch。LSP/DAP/formatter 作为 Process Broker 创建的独立工具沙箱，不成为扩展 runner 子进程。

Network Broker 不得采用“预先解析检查、随后让通用客户端重新解析”的流程。每次初始连接及每个重定向目标都重新规范化 host 并解析全部 A/AAAA 记录，将 IPv4-mapped IPv6 先归一化为 IPv4，再拒绝 loopback、link-local、private、metadata、multicast 等禁止地址；broker 必须用本轮已验证的地址建立连接（TLS SNI/证书及 HTTP `Host` 仍绑定原 hostname），连接后再把实际 peer 地址归一化并确认其属于本轮已批准集合，否则立即关闭。重定向禁止自动跟随，逐跳重复上述授权、解析、拨号和 peer 校验，以消除 DNS rebinding/TOCTOU 窗口；代理/PAC 不得成为直连校验的例外：代理 endpoint 必须单独授权；CONNECT/SOCKS 目标按同一轮解析和地址策略校验，分别校验代理 peer 与目标绑定，禁止 PAC fallback 或透明代理绕过。

退出条件：所有 socket/spawn/secret 使用都能映射到精确 capability 和审计记录；测试覆盖初始连接与逐跳重定向、IPv4-mapped IPv6、loopback、link-local、private、metadata、DNS rebinding 和 peer 不匹配；工具进程不能继承用户 HOME、凭据、网络或未授权写路径。

### H6：VS Code Web Host 与受控 WebView

交付物：每扩展独立 sandboxed renderer、唯一协议 origin/临时 session、`vscode` facade 和受控资源协议；每面板独立 WebView renderer、宿主 CSP 与随机 origin。

退出条件：页面不能访问 default session、任意导航/弹窗/service worker/file URL 或 Host IPC；WebView 消息不能冒充 extension instance。

### H7：受限 VS Code Node 兼容层

只有 H4/H5 的平台 sandbox 和 probe 稳定后才开始。实现每扩展进程、允许列表 loader/shim、禁止 Electron/裸 fs/net/process/native addon，并用 OS sandbox 防御 loader 绕过。兼容性扫描器在安装前给出阻止原因。

退出条件：`require('fs'|'child_process'|'net'|'electron')`、动态 native addon、环境泄漏和跨扩展模块/storage 全部失败关闭。不能以“多数扩展能跑”为代价放宽基线。

### H8：远程 Host

远端复用同一 identity、policy digest、协议和吊销模型；通过设备身份/mTLS 证明远端策略。远端 workspace 权限不能自动转换为本机文件、剪贴板、secret 或 external-open 权限。

## 6. 推荐 PR 拆分

1. **Installed model**：安装指针 scanner、内容复核、声明式 IR 和 contribution registry。
2. **Supervisor core**：状态机、instance identity、fake runner、生命周期/退避测试。
3. **Protocol package**：握手、envelope、错误码、deadline/cancel、流控和 fuzz target。
4. **Policy/trust**：授权数据库、有效权限交集、Workspace Trust、权限 diff UI。
5. **FS broker**：虚拟 URI、scope/glob/sensitive policy、handle-relative traversal 和配额。
6. **Wasm runner**：WIT lifecycle + read-only workspace、Wasmtime 配额、进程 launcher。
7. **Platform sandbox**：三平台 probe 与发布门禁；可按平台拆 PR，但所有平台齐备前 executable runtime 保持 blocked。
8. **Broker expansion**：network/process/secret 分别独立 PR，不做全权限综合 broker。

每个 PR 都必须保持主分支失败关闭：尚未满足退出条件的 runtime 在 registry 中继续显示 `blocked`，不得通过 feature flag 静默回退到普通 Node 子进程。

## 7. 首批 API 范围

Wasm Host v1 只承诺：

- `activate` / `deactivate`
- namespaced log
- monotonic clock / bounded wall clock / CSPRNG
- 注册安装期已声明的 command handler、completion provider（先选择一种编辑器回调）
- `logos-workspace://` 的只读、分块、可取消文件读取

明确不进入 v1：私有 storage、任意 shell、terminal、debug adapter、网络、secret 明文、WebView、native addon、任意 VS Code Node API。storage 必须等独立 capability、命名空间/配额、运行时撤销和跨扩展/回滚测试契约落地后再加入后续 ABI；在此之前 SDK 不声明 storage API、初始 WIT 不导入 storage 接口、产品策略也不向 Wasm v1 实例授予 storage。先证明身份、取消、配额、撤销和沙箱探针，再扩大 API 面。

## 8. 验证与发布门禁

- TypeScript/Rust 编译和协议兼容 fixture。
- manifest/registry/protocol 的 property test 与 fuzz；ZIP 和 WIT import 单独 fuzz。
- fake runner 故障注入：退出、挂起、OOM、乱序、重放、洪泛、半开连接。
- 恶意扩展套件：home/SSH/env/loopback/metadata/process/storage/symlink/其他扩展访问。
- 三平台 sandbox probe 必须针对最终签名/打包产物运行，不只测试开发二进制。
- 发布包若任一 probe 成功，所有 executable runtime 标记 blocked；声明式贡献仍可使用。
- 安全相关 parser、policy、router、broker 和 launcher 设置独立 coverage 门槛与 review owner。

## 9. 关键决策记录

- 第一个可执行 Host 是 Wasm Component，不是 Node。
- 每扩展一个 runner 是初始不可协商边界；池化需要新的安全论证。
- 当前工作台 IPC/文件服务不能复用为 extension API。
- Supervisor/Router 信任连接绑定身份，不信任消息自报 `extensionId`。
- 安装成功不等于可激活；签名、策略、授权、Workspace Trust、runtime 和 sandbox probe 都可阻止启动。
- VS Code 兼容性是 adapter 层能力，不改变 Logos 内部协议和 broker 的最小权限模型。
