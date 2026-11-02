# VS Code Crash 崩溃处理链路梳理

从异常上下文、进程/模块标识到 Native Dump API、上报和符号化边界的源码分析

**调查尺度：** `complex`

## 范围

对象是当前仓库中的 VS Code Desktop/Electron 崩溃处理器。本文跟踪 JavaScript 未捕获异常、渲染器/Utility/GPU 子进程崩溃和 Native Crashpad Dump 的连接，重点回答异常上下文如何进入 Dump、模块名和符号在哪里产生、以及 `crashReporter.start()` 如何决定落盘和上报。证据边界是当前仓库源码与配置；Electron/Crashpad 内部实现和 App Center 服务端实现未在仓库内展开。

## 一句话本质

VS Code 只负责按启动配置调用 Electron `crashReporter.start()`、设置 Dump 目录和进程元数据；Native 异常上下文、模块列表、地址栈和符号化主要由 Electron/Crashpad 及服务端完成，仓库内没有独立的符号解析或 Dump 编码器。

## 全局与上下文地图

**范围**

主范围：`src/mainImpl.ts` 的 Electron 主进程 Crash Reporter，以及 `src/bootstrap-fork.ts`、窗口/Utility/GPU 进程的崩溃观测。非范围：普通业务错误遥测、content tracing 的 memory dump、TypeScript 语言服务 symbol API。

**组件**

- `src/mainImpl.ts`: 解析参数，选择 `crashDumps` 目录和 App Center URL，调用 `crashReporter.start()`。
- `src/vs/code/electron-main/app.ts`: 根据 `telemetry.enableCrashReporter` 初始化/更新 `argv.json` 中的开关和 UUID。
- `src/bootstrap-fork.ts`: 子进程记录 Node `uncaughtException`/`unhandledRejection`，并向 Electron Crash Reporter 附加 `processType`。
- `src/vs/platform/windows/electron-main/windowImpl.ts`: 监听 WebContents `render-process-gone`，转成窗口错误状态。
- `src/vs/platform/utilityProcess/electron-main/utilityProcess.ts` 与 GPU 服务：监听 `child-process-gone`/退出原因并发送受限遥测。
- Electron Crashpad: 仓库通过 API 接入，负责 Native 异常捕获、Dump 文件和上传；不在仓库源码中实现。

**参与者/所有者**

- 用户设置和 `argv.json` 决定是否启用 Crash Reporter。
- Electron 主进程启动器负责在 `app` ready 前配置 Crash Reporter。
- Electron/Crashpad Handler 负责进程级 Native 崩溃收集。
- App Center 接收上传后的崩溃数据；符号服务/处理流水线属于外部系统。

**输入输出与流程**

- `telemetry.enableCrashReporter` -> `app.ts:updateCrashReporterEnablement()` -> `argv.json` 的 `enable-crash-reporter`/`crash-reporter-id`。
- 启动参数/argv.json -> `mainImpl.ts` 条件判断 -> `configureCrashReporter()`。
- Native 异常 -> Electron/Crashpad -> minidump（异常上下文、线程栈、模块信息）-> 本地 `crashDumps` 或 App Center。
- Utility 子进程配置 -> `VSCODE_CRASH_REPORTER_PROCESS_TYPE` -> `bootstrap-fork.ts` -> Crash Reporter extra parameter `processType`。
- Dump 中的模块地址/偏移 -> 外部符号服务器或 Crashpad 处理服务 -> 函数名/文件行号（仓库外）。

**依赖**

- Electron `crashReporter` API 和其内置 Crashpad。
- Electron 的 `app.setPath('crashDumps', ...)` 路径语义。
- 平台架构和 `product.appCenter` 的平台 URL。
- 构建产物及对应的 native/JavaScript 符号文件；仓库未定义消费符号的接口。

**生命周期**

- 首次启动：主进程启动前读取 argv 配置，Workbench 后续根据 telemetry 设置写入 crash 开关和 UUID。
- 启动：满足目录参数，或满足 enable 开关且未禁用时调用 `crashReporter.start()`。
- 运行：Crashpad Handler 监视 Native 崩溃；子进程额外携带 process type。
- 结束：按 `uploadToServer` 选择上传，或保留在 `crashDumps` 目录。

**失效面**

- 未启用 Crash Reporter、开发模式、无合法 UUID 或无匹配平台 URL 时不会上传到 App Center。
- `--crash-reporter-directory` 非绝对路径或无法创建时主进程退出。
- JS 未捕获异常仅被记录到 stderr，不等价于 Native Crash Dump。
- 渲染器/Utility/GPU 的退出遥测能说明进程为何结束，但不提供符号化栈。


## 关键机制

### 1. 启动门控与 Dump 路径
**为何关键：** 这是从 VS Code 配置进入 Electron Native Crash Reporter 的唯一主入口，决定是否收集以及 Dump 的去向。

**因果链：** ``--crash-reporter-directory` 或 `enable-crash-reporter=true` 且未 `--disable-crash-reporter` -> `configureCrashReporter()` -> 设置 `crashDumps`/上传策略 -> `crashReporter.start()``

- **事实**（置信度：高）：`src/mainImpl.ts:86-101` 在 `app.ready` 前配置 Crash Reporter；只有目录参数存在，或 argv 中启用且没有 disable 参数时才调用配置函数。
- **事实**（置信度：高）：指定 `--crash-reporter-directory` 时路径必须是绝对路径，目录按需创建，并通过 `app.setPath('crashDumps', directory)` 改写 Electron 默认落盘位置。
- **事实**（置信度：高）：存在 App Center 配置时按 OS/架构选择 URL；开发模式或指定本地目录时 `uploadToServer` 为 false，`compress` 为 true，且 `ignoreSystemCrashHandler` 为 true。

### 2. 异常上下文与进程元数据
**为何关键：** 解释“异常上下文”如何与模块归属关联，并区分 Native Dump 与 Node 错误日志。

**因果链：** `Native/子进程异常 -> Electron/Crashpad 捕获上下文；VS Code 侧补充 UUID 和 process type -> Dump/上报记录可按实例和进程归因`

- **事实**（置信度：高）：`app.ts:1831-1867` 根据 `telemetry.enableCrashReporter` 写入 `argv.json` 的 `enable-crash-reporter`，首次启动生成 UUID 作为 `crash-reporter-id`。
- **事实**（置信度：高）：`mainImpl.ts:520-560` 校验 UUID，并将 `--crash-reporter-id` 注入子进程可继承的 argv；URL 同时追加 `uid/iid/sid`。
- **事实**（置信度：高）：`utilityProcess.ts:276-285` 将 Utility 类型写入 `VSCODE_CRASH_REPORTER_PROCESS_TYPE`；`bootstrap-fork.ts:190-202` 通过 Electron 的 `process.crashReporter.addExtraParameter('processType', ...)` 附加它。
- **事实**（置信度：高）：`bootstrap-fork.ts:163-173` 的 `uncaughtException` 和 `unhandledRejection` 处理器只输出日志；从该代码看，它们不会调用 `crashReporter.start()` 或主动生成 Dump。

### 3. 模块名、地址栈与符号化
**为何关键：** 直接回答模块名和符号的来源，避免把 VS Code 的 TypeScript symbol 服务误认为 Native Crash 符号器。

**因果链：** `Crashpad 取得崩溃线程寄存器/栈地址和进程模块快照 -> Dump 保存模块标识与地址/偏移 -> 外部处理流水线用匹配构建符号解析函数名/源文件行号`

- **事实**（置信度：高）：仓库中调用的唯一 Native Crash API 是 Electron `crashReporter.start()`；未发现 Breakpad/Crashpad minidump writer、stack walker 或 symbol server 客户端实现。
- **推断**（置信度：高）：因此模块名、加载基址、指令地址和偏移应由 Electron/Crashpad 在生成 Dump 时采集；函数名、源码文件和行号需要外部符号文件/服务按构建版本还原。
- **事实**（置信度：高）：`build` 目录中未发现与 Crashpad 符号上传/解析相连的实现；当前仓库无法单独证明 App Center 服务端的具体 symbol storage、匹配键或保留策略。

### 4. 进程崩溃观测与 Dump 的分工
**为何关键：** 避免把进程退出事件、错误遥测和 Dump API 混成同一条链。

**因果链：** `renderer/Utility/GPU 进程退出 -> VS Code 监听 Electron 事件 -> 窗口状态或遥测 -> Native Dump 仍由 Crashpad 独立处理`

- **事实**（置信度：高）：`windowImpl.ts:898-904` 将 WebContents `render-process-gone` 转换为窗口错误；它没有创建 Dump 或解析符号。
- **事实**（置信度：高）：`utilityProcess.ts:344-366` 监听 `child-process-gone`，记录 type/reason/code 并发送 `utilityprocesscrash` 遥测。
- **事实**（置信度：高）：GPU 崩溃由 GPU 服务/遥测组件观察并可能记录回退信息；这类事件是诊断补充，不替代 Crashpad Dump。

## 反常点与历史追溯

### 1. 代码中看不到显式的 `minidump`、模块枚举或符号解析调用，但需求链路包含这些信息。
**证据：**
- `src/mainImpl.ts:565-576` 只调用 Electron `crashReporter.start()`。
- 仓库检索未找到 Crashpad symbol/stack-walk 实现。

**历史解释：** 已确认：这些能力位于 Electron/Crashpad 和外部崩溃服务边界，VS Code 只做配置和元数据补充；仓库没有更具体的服务端实现。

**待证假设：**
- 构建或发布流水线可能在仓库外上传符号文件，供 App Center 后处理。

**当前约束：** 仍存在；若要核对符号上传、模块匹配或服务端字段，需要访问 Electron 构建产物和 App Center/Crashpad 服务配置。

### 2. `mainImpl.ts` 中也配置了 `memory_dump_config`，容易与 Crash Reporter Dump 混淆。
**证据：**
- `src/mainImpl.ts:177-203` 和 `nativeHostMainService.ts:1381-1403` 将其传给 `contentTracing.startRecording()`。

**历史解释：** 已确认：这是 tracing/heap profiling 的 memory-infra dump 配置，不是 Native Crash Reporter 的崩溃 Dump 路径。

**当前约束：** 仍存在；排障时必须根据 API（`contentTracing` vs `crashReporter`）区分两种 Dump。

## 边界与代价

- **事实**（置信度：高）：JavaScript `uncaughtException`/`unhandledRejection` 只保证日志输出；它们不提供 Native 异常上下文，也不自动生成 `.dmp`。
- **事实**（置信度：高）：只有在 Crash Reporter 已启动且平台/配置满足条件时，Native 崩溃才进入 Electron/Crashpad 收集链；`VSCODE_DEV` 会阻止上传。
- **事实**（置信度：高）：本地 `--crash-reporter-directory` 模式便于保留 Dump，但代码显式将 `submitURL` 留空且 `uploadToServer=false`，不会自动上报。
- **推断**（置信度：高）：没有与崩溃版本严格匹配的 native/JavaScript 符号时，Dump 仍可含模块和地址，但函数名/源码行号可能无法还原。
- **推断**（置信度：高）：Renderer/Utility/GPU 进程的退出 reason、exit code 和窗口错误状态是应用层诊断信号，不能替代完整的寄存器、线程栈和模块快照。

## 实践验证

### 1. 静态检查 `src/mainImpl.ts` 的启动条件、`configureCrashReporter()` 和 `crashReporter.start()` 参数。
**预期：** 能从参数/argv.json 推导启用、目录、URL、上传和进程标识。
**结果：** 已确认：行 86-101 做门控，487-576 完成目录、URL、UUID、进程参数和 start 配置。
**限制：** 不能证明 Electron/Crashpad 在各平台的内部 Dump 字段或服务端行为。

### 2. 沿 `VSCODE_CRASH_REPORTER_PROCESS_TYPE` 搜索赋值与读取位置。
**预期：** Utility 进程创建时设置，fork bootstrap 读取并附加 `processType`。
**结果：** 已确认：`utilityProcess.ts:276-285` -> `bootstrap-fork.ts:190-198`。
**限制：** 只验证了 VS Code 的元数据通路，不能验证 Crashpad 最终如何序列化该字段。

### 3. 沿 `symbol`/`breakpad`/`crashpad`/`minidump` 检索仓库实现，并排除 TypeScript 语言 symbol 和 tracing dump。
**预期：** 若仓库有符号化器或 Dump writer，应能找到对应 API/依赖。
**结果：** 未发现独立实现；可见接入点是 Electron `crashReporter`，因此模块/符号处理属于外部边界。
**限制：** 静态检索不能排除发布系统、依赖二进制或服务端私有配置中的符号处理。

### 4. 场景推演：分别设置本地目录、开发模式、禁用开关和合法 UUID。
**预期：** 本地目录只落盘；开发模式不上传；禁用开关不启动；合法 UUID 才拼接平台 URL。
**结果：** 与 `mainImpl.ts:488-576` 的分支逻辑一致。
**限制：** 未实际启动 Electron 或触发崩溃，未生成真实 `.dmp`。

## 分析透镜

### 1. 排障入口
先确认进程类型和 Crash Reporter 启动条件，再判断是 JS 日志、进程退出遥测还是 Native Dump。

- **事实**（置信度：高）：主进程入口：`src/mainImpl.ts:86-101`、`487-576`。
- **事实**（置信度：高）：子进程上下文：`src/bootstrap-fork.ts:163-208` 和 `src/vs/platform/utilityProcess/electron-main/utilityProcess.ts:276-285`。

### 2. 符号化缺口
源码能解释模块/地址数据的采集边界，但不能从当前仓库确认最终的函数名和源码行号。

- **推断**（置信度：中）：需要补查发布流水线中的符号产物、Electron 版本对应的 Crashpad 格式和 App Center 符号匹配配置。

## 综合结论

**建议立场：** 排查 Native 崩溃时把 `crashReporter.start()` 作为收集链入口，把 Crashpad Dump 作为模块/地址事实源，把外部符号服务作为函数名/源码行号来源；不要把 JS exception 日志或进程退出遥测当成 Dump。

**主要风险：**
- 本地目录、开发模式和用户隐私设置会让 Dump 只落盘或完全不收集。
- 平台 URL、UUID、构建版本和符号文件不匹配会导致上报或符号化缺失。
- 当前仓库缺少服务端符号流水线证据，无法确认最终符号解析 SLA、保留期和访问权限。

**待验证问题：**
- 正式构建产物的 `.pdb`/DWARF/Breakpad symbol 是否由 CI 上传到 App Center 或其他服务？
- App Center 接收的 Dump 是否包含 `processType` extra parameter，以及服务端如何展示它？
- 各平台 Electron 版本的 Crashpad Dump 是否统一包含 JavaScript call stack；启用的 Chromium feature 只在 `mainImpl.ts:350-356` 被声明，未在仓库验证最终报告。

## 参考来源

- `src/mainImpl.ts:86-101`, `src/mainImpl.ts:177-203`, `src/mainImpl.ts:487-576`
- `src/vs/code/electron-main/app.ts:1831-1872`
- `src/bootstrap-fork.ts:163-208`
- `src/vs/platform/utilityProcess/electron-main/utilityProcess.ts:241-301`, `344-366`
- `src/vs/platform/windows/electron-main/windowImpl.ts:898-904`
- `src/vs/platform/gpu/electron-main/gpuProcessTelemetry.ts:13-47`
- `src/vs/platform/agentHost/common/agentHostProcessTelemetry.ts:36-56`
- `src/vs/workbench/electron-browser/desktop.contribution.ts:433-440`
- `src/vs/platform/telemetry/common/telemetryUtils.ts:132-155`
- `src/vs/base/common/product.ts:202-205`, `248-250`

## Renderer 崩溃验证

开发构建中可通过命令面板执行 `Developer: Crash Renderer`。该命令调用 Electron 在原生层实现的 `webContents.forcefullyCrashRenderer()`，不是 JavaScript 异常模拟。

建议使用独立目录启动：

```powershell
scripts\code.bat --crash-reporter-directory C:\temp\vscode-crash-test
```

执行命令后观察：

1. 主进程日志中的 `[CrashTest] Requesting native renderer crash`。
2. 窗口重新加载或进入崩溃状态，并触发 `render-process-gone`。
3. 消息框显示最终 `.dmp` 路径；主进程日志也会输出 `dump=...`。
4. 若未生成 Dump，消息框会显示 Crashpad 目录、退出原因和退出码。

该验证入口只注册在 Electron Desktop 的开发者动作中；它不会自动触发，也不会修改正式运行的普通窗口流程。
