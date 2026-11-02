# VS Code 卡顿（Jank）检测与处理链路

## 1. 范围与结论

本文梳理当前仓库中与界面卡顿、输入延迟、渲染阻塞和窗口无响应相关的实现。仓库没有一个统一命名为 `Jank` 的检测器；当前是四条相互补充的链路：

1. **编辑器输入延迟采样**：测量键盘输入到编辑器渲染完成的时间，并按采样概率上报。
2. **渲染器长任务自动剖析**：以渲染性能基线为阈值，监听 renderer 的 `longtask`，必要时自动抓取 CPU profile。
3. **Electron 窗口无响应处理**：监听 BrowserWindow 的 `unresponsive`/`responsive`，采样 JS 调用栈、上报窗口错误并给用户恢复选项。
4. **扩展宿主与 PTY 独立无响应处理**：RPC 侧以 3 秒无应答判定扩展宿主无响应；终端侧显示 PTY 状态并允许重启。

**事实（高置信度）**：这些机制的触发条件、阈值和处理动作不同，不能把 `input latency`、`longtask`、Electron `unresponsive` 或 extension host `unresponsive` 直接当成同一个 Jank 指标。

## 2. 系统地图

```text
用户键盘输入
  -> 编辑器 EditContext / TextArea 输入事件
  -> inputLatency 状态机与 Performance marks
  -> Monaco View.prepareRenderText() 调用 onRenderStart()
  -> 下一任务确认 input/render 结束
  -> 累积 keydown/input/render/total 指标
  -> 60 秒节流 + 会话采样概率
  -> telemetry: performance.inputLatency

Renderer 主线程任务
  -> PerformanceObserver(entryTypes = ['longtask'])
  -> 与 timerService.perfBaseline 比较
  -> 命中阈值且开启 rendererProfiling
  -> nativeHostService.profileRenderer(sessionId, 5000)
  -> bottom-up 分析
  -> Interesting: 写入临时目录 .cpuprofile.json

Electron BrowserWindow
  -> 'unresponsive' / 'responsive'
  -> windowerror 遥测
  -> 1 秒间隔采集 JS 调用栈，最多 15 秒
  -> 频繁栈转为 UnresponsiveSampleError
  -> 日志 + 用户 Reopen/Close/Keep Waiting

Extension host RPC / PTY host
  -> 请求未收到应答 / 心跳失败
  -> 独立状态机进入 Unresponsive
  -> 扩展服务记录状态；PTY 在状态栏告警并支持手动重启
```

### 2.1 组件与职责

| 组件 | 职责 | 主要输出 |
| --- | --- | --- |
| `src/vs/base/browser/performance.ts` | 输入延迟测量状态机、累积和清理样本 | `IInputLatencyMeasurements` |
| `TextAreaEditContextInput` / `NativeEditContext` | 把编辑器输入事件接入测量器 | `onKeyDown`、`onBeforeInput`、`onInput`、`onKeyUp`、`onSelectionChange` |
| `src/vs/editor/browser/view.ts` | 在编辑器协调渲染开始处标记 render 起点 | `render` measurement |
| `InputLatencyContrib` | 按配置和节流周期上报输入延迟 | `performance.inputLatency` |
| `RendererProfiling` | 监听 renderer 长任务并触发 profiling | `.cpuprofile.json` |
| `CodeWindow` | 处理窗口级 unresponsive、采样栈、用户恢复 | `windowerror`、`UnresponsiveSampleError`、对话框 |
| `RPCProtocol` | 检测扩展宿主 RPC 请求长期无应答 | `ResponsiveState` |
| `BaseTerminalBackend` | 反映 PTY host 状态并提供重启入口 | 状态栏告警、重启命令 |

## 3. 关键检测链路

### 3.1 编辑器输入延迟：最接近用户感知的轻量 Jank 指标

**事实（高）**：`inputLatency` 在 `src/vs/base/browser/performance.ts` 中维护四类阶段：`keydown`、`input`、`render`、`inputlatency`。每次样本必须经历 `Before -> InProgress -> Finished`，避免事件乱序或缺失导致错误闭合。

链路如下：

```text
keydown
  -> mark inputlatency/start + keydown/start
beforeinput
  -> mark input/start
input
  -> microtask mark input/end
编辑器下一次协调渲染
  -> View._createCoordinatedRendering().prepareRenderText()
  -> inputLatency.onRenderStart()
  -> microtask mark render/end
setTimeout / keyup / selectionchange 的直接检查
  -> recordIfFinished()
  -> performance.measure()
  -> 累积 total/min/max
```

接入点：

- TextArea 路径在 `textAreaEditContextInput.ts:693-696` 注册四类输入事件；selection change 在同一输入控制器中补充。
- Native EditContext 路径在 `nativeEditContext.ts:150-158, 200, 396-402` 调用对应测量 API。
- 编辑器渲染在 `view.ts:603` 调用 `inputLatency.onRenderStart()`。

测量器使用两个 `setTimeout` 竞争窗口布局/绘制后的首个任务：输入开始时安排 Task A，渲染开始时安排 Task B；同时在后续 `keydown`、`keyup`、`selectionchange` 事件中直接检查。这是为了尽量把浏览器布局和绘制时间包含到总延迟中。

**事实（高）**：`getAndClearMeasurements()` 返回平均值、最小值、最大值和样本数，然后清空累计缓冲；未完成样本不会进入结果。

上报链路：

1. `InputLatencyContrib` 在 `LifecyclePhase.Eventually` 注册。
2. 配置 `telemetry.performance.inputLatencySamplingProbability` 决定会话是否上报，默认值为 `0`。
3. `sampleCount` 变化经 `throttledObservable(..., 60_000)` 节流。
4. 满足采样条件时通过 `telemetryService.publicLog2` 上报 `performance.inputLatency`。
5. 额外附带 GPU 加速状态、JS heap 使用量、heap limit 和使用率。

**边界（事实，高）**：该指标只覆盖编辑器输入到一次编辑器渲染的路径，不等价于所有鼠标交互、窗口拖动、终端输出或整个 renderer 的帧率。

### 3.2 Renderer 长任务：发现异常后自动取证

**事实（高）**：`RendererProfiling` 在 Electron 性能贡献中以 `LifecyclePhase.Eventually` 注册，等待 `timerService.perfBaseline` 后创建 `PerformanceObserver`，观察 `longtask`。

判定流程：

```text
perfBaseline < 0 -> 退出，不启用自动检测
否则 slowThreshold = perfBaseline * 10
longtask 批次 -> 取最大 duration
maxDuration < slowThreshold -> 忽略
配置 application.experimental.rendererProfiling = false -> 仅 debug 日志
配置开启 -> 断开 observer，启动 5 秒 renderer profile
```

profiling 最多尝试 3 次：调用 `nativeHostService.profileRenderer(sessionId, 5000)`，交给 `profileAnalysisService.analyseBottomUp(..., perfBaseline, true)` 分析；结果为 `ProfilingOutput.Interesting` 时写入临时目录 `renderer-<随机值>.cpuprofile.json`，否则等待 15 秒后重试。完成后恢复 `longtask` 观察。

**推断（中）**：`perfBaseline * 10` 是“明显异常长任务”阈值，而不是严格的单帧预算；注释以约 64 FPS 设备上 10 帧作直观解释，因此它适合做自动取证触发器，不适合直接作为用户体验分数。

### 3.3 Electron 窗口无响应：从检测到恢复操作

**事实（高）**：`CodeWindow` 监听 Electron `BrowserWindow` 的 `unresponsive` 和 `responsive` 事件，并统一进入 `onWindowError`。每次事件先写日志，再上报 `windowerror`，字段包括 `type`、`reason`、`code`。

无响应后的默认处理：

1. 开发者工具、扩展开发宿主、扩展测试宿主场景直接跳过用户处理，避免断点暂停被误判为故障。
2. 普通窗口通过 `webContents.mainFrame.collectJavaScriptCallStack()` 采集调用栈。
3. 默认采样间隔为 1000 ms，采样周期为 15000 ms；命令行参数可覆盖，非法值回退默认值。
4. 栈采样在窗口恢复、窗口销毁或周期结束时停止。
5. 栈出现比例超过有效采样数的 20% 时，构造 `UnresponsiveSampleError`，交给错误遥测处理。
6. 同时写入完整栈汇总日志，并提示使用 tracing CPU profile 做进一步分析。
7. 向用户显示 `Reopen`、`Close`、`Keep Waiting`；前两者会销毁窗口，重开时可选择不恢复编辑器。

测试分支：

- 扩展开发测试窗口无响应后，等待 60 秒仍未恢复则以退出码 1 结束。
- smoke test 场景直接销毁窗口并走正常退出。
- renderer process gone 走单独的进程终止对话框和重开/关闭流程。

**边界（事实，高）**：Electron `unresponsive` 反映的是窗口主线程无法及时响应，不提供具体卡顿原因；JS 栈采样是事后取证，不能证明所有阻塞都来自 JavaScript。

### 3.4 扩展宿主与 PTY：局部无响应，不是 renderer Jank

#### Extension host RPC

**事实（高）**：`RPCProtocol` 只有在存在未确认的 RPC 请求时才启动检查。首个请求开始计时，3 秒内没有应答则设置 `ResponsiveState.Unresponsive`；收到任一确认后刷新截止时间，所有请求确认后取消调度器。扩展服务通过 `onDidChangeResponsiveState` 记录并传播状态。

因此，扩展宿主检测的是“RPC 请求无应答”，不是 renderer 的帧耗时。扩展代码阻塞扩展宿主时可能同时造成用户感知卡顿，但两者的观测面不同。

#### PTY host

**事实（高）**：PTY host 无响应时，`BaseTerminalBackend` 在状态栏创建 warning entry，标明终端可能停止工作，并绑定 `DeveloperRestartPtyHost` 命令；恢复或重启后移除状态栏项并清除状态。该处理只影响终端后端，不会触发窗口级 `windowerror`。

## 4. 处理闭环与证据流

| 触发 | 自动处理 | 用户/运维可见证据 | 恢复动作 |
| --- | --- | --- | --- |
| 编辑器输入延迟样本 | 累积并按采样策略上报 | `performance.inputLatency` | 通过 telemetry 聚合定位高延迟阶段 |
| renderer `longtask` 超阈值 | 5 秒 CPU profile，最多 3 次 | debug/warn 日志、临时 `.cpuprofile.json` | 用 profile bottom-up 结果定位热点 |
| BrowserWindow `unresponsive` | JS 栈采样，窗口错误遥测 | `windowerror`、`UnresponsiveSampleError`、错误日志 | Reopen / Close / Keep Waiting |
| Extension host RPC 超过 3 秒无应答 | 设置扩展宿主无响应状态 | 扩展服务日志/状态事件 | 等待应答或按扩展宿主生命周期处理 |
| PTY host 无响应 | 状态栏 warning | PTY 状态栏入口 | 手动重启 PTY host |

## 5. 异常点、边界与代价

### 5.1 已确认的设计边界

- **采样概率默认关闭**：没有显式配置时，输入延迟不会形成遥测事件；本地仍会测量并清理样本。
- **输入测量只追踪第一帧**：`onRenderStart()` 只接受输入完成后的第一次 render，后续动画帧不计入同一输入样本。
- **长任务检测依赖浏览器能力和基线**：没有有效 `perfBaseline` 时自动剖析退出；长任务阈值随机器基线变化。
- **窗口对话框有误判豁免**：调试断点可能触发 Electron 无响应，因此开发/调试场景不弹恢复对话框。
- **多个检测器不会自动关联**：当前没有代码把输入延迟、longtask、windowerror、扩展宿主状态按同一 trace/session 关联起来。

### 5.2 成本与风险

- 输入测量会增加少量 `performance.mark/measure` 和定时器开销；采样数据按分钟级节流，但样本缓冲在内存中累计。
- 自动 profile 会暂停 `PerformanceObserver`，并可能产生最多 3 次、每次 5 秒的 profiling 成本；分析失败只记录错误，不会阻塞窗口恢复。
- 无响应时调用 `collectJavaScriptCallStack()` 依赖 renderer 仍可被 V8 中断；如果进程已崩溃，应走 `render-process-gone` 分支。
- `UnresponsiveSampleError` 的 20% 比例是归因线索，不是根因证明；需要结合 profile、日志和复现验证。

## 6. 最小验证方案

| 目标 | 检查 | 预期观察 | 不能证明 |
| --- | --- | --- | --- |
| 验证输入延迟闭环 | 在编辑器输入事件与 `view.ts:603` 断点/日志观察 marks | 每次完整输入最终出现 `keydown/input/render/inputlatency` 四类 measure，并递增 `sampleCount` | 不覆盖非编辑器交互 |
| 验证遥测采样 | 设置 `telemetry.performance.inputLatencySamplingProbability` 为 `1`，输入后等待 60 秒 | 出现 `performance.inputLatency`，包含阶段统计和 heap/GPU 字段 | 不代表服务端已成功接收 |
| 验证长任务分支 | 开启 `application.experimental.rendererProfiling`，制造超过阈值的 renderer 长任务 | 日志出现 `VERY LONG TASK`，随后产生 profile 或重试日志 | 不保证 profile 一定被判定为 `Interesting` |
| 验证窗口无响应取证 | 在可控测试窗口触发 renderer 阻塞 | 出现 `windowerror`、栈采样汇总和用户恢复对话框 | 调试窗口会被豁免 |
| 验证扩展宿主判定 | 发出 RPC 后让对端超过 3 秒不应答 | `ResponsiveState.Unresponsive` 事件 | 不会证明 renderer 发生 Jank |
| 验证 PTY 处理 | 使 PTY host 心跳超时 | 状态栏显示 Pty Host warning，点击可重启 | 不影响窗口级指标 |

## 7. 建议的后续处理方式

**建议（推断，中）**：排查用户报告的“卡顿”时按以下顺序取证：

1. 先区分是“输入延迟”“窗口完全无响应”“终端不可用”还是“扩展宿主无响应”。
2. 输入延迟优先看 `keydown`、`input`、`render` 三段的最大值，确认阻塞发生在哪个阶段。
3. renderer 长任务优先开启 `application.experimental.rendererProfiling` 并保留 `.cpuprofile.json`。
4. 窗口无响应优先保留 `windowerror`、`UnresponsiveSampleError` 栈汇总和恢复前后的时间线。
5. 若多个指标需要关联，当前代码证据不足以直接完成端到端归因，应增加统一 trace/session correlation，而不是仅凭单个指标下结论。

## 8. 代码证据索引

- [`src/vs/base/browser/performance.ts`](../src/vs/base/browser/performance.ts:8)
- [`src/vs/workbench/contrib/performance/browser/inputLatencyContrib.ts`](../src/vs/workbench/contrib/performance/browser/inputLatencyContrib.ts:14)
- [`src/vs/editor/browser/controller/editContext/textArea/textAreaEditContextInput.ts`](../src/vs/editor/browser/controller/editContext/textArea/textAreaEditContextInput.ts:693)
- [`src/vs/editor/browser/controller/editContext/native/nativeEditContext.ts`](../src/vs/editor/browser/controller/editContext/native/nativeEditContext.ts:150)
- [`src/vs/editor/browser/view.ts`](../src/vs/editor/browser/view.ts:603)
- [`src/vs/workbench/contrib/performance/electron-browser/rendererAutoProfiler.ts`](../src/vs/workbench/contrib/performance/electron-browser/rendererAutoProfiler.ts:20)
- [`src/vs/workbench/contrib/performance/electron-browser/performance.contribution.ts`](../src/vs/workbench/contrib/performance/electron-browser/performance.contribution.ts:15)
- [`src/vs/platform/windows/electron-main/windowImpl.ts`](../src/vs/platform/windows/electron-main/windowImpl.ts:901)
- [`src/vs/workbench/services/extensions/common/rpcProtocol.ts`](../src/vs/workbench/services/extensions/common/rpcProtocol.ts:119)
- [`src/vs/workbench/contrib/terminal/browser/baseTerminalBackend.ts`](../src/vs/workbench/contrib/terminal/browser/baseTerminalBackend.ts:18)

