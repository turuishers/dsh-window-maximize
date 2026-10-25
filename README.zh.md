# dsh-window-maximize

[English](README.md) | 中文

一个 [DSH](https://github.com/deepseek-ai/deepseek-harness) 宿主插件：**每次启动都把桌面版主窗口最大化**（仅 Windows）。

## 为什么需要它

桌面版主进程把主窗口尺寸写死在 `app.asar` 的 `lib/main.js` 里：

```js
new BrowserWindow({ width: 1280, height: 820, minWidth: 520, minHeight: 600, show })
```

它既不保存窗口大小/位置，也没有"启动时最大化"的配置项（`desktop/settings.json` 只认
`updates.allowTestAuthPopupWindow`）。插件跑在宿主进程里，拿不到 Electron 的 `BrowserWindow`，
于是走了最短的一条可靠路径：`apply()` 时拉起一个**一次性的 PowerShell 窗口监视器**，它轮询应用
的顶层窗口，主窗口一出现就 `ShowWindowAsync(SW_MAXIMIZE)`，随后自己退出。

因为它是宿主插件，**不管从哪儿启动**（开始菜单、任务栏固定、直接双击 exe）都生效——不用改快捷
方式，也不会被应用更新冲掉。

## 行为

| 场景 | 结果 |
| --- | --- |
| 冷启动 | 主窗口一出现就最大化 |
| 窗口藏在托盘里再唤起 | 一出现就最大化 |
| 宿主重启（不是应用重启） | 再次 apply；已经最大化就什么都不做 |
| 纯浏览器宿主 `dsh web` | 不动作 |
| 非 Windows | 不动作 |

监视器最多等 120 秒，等不到窗口就放弃——不会留下常驻进程。

## 安装

1. 在你要运行的 profile 里加依赖：

   ```sh
   cd "$DSH_HOME/profiles/<name>"          # 例如 web
   pnpm add "dsh-window-maximize@git+https://github.com/<user>/dsh-window-maximize.git"
   ```

2. 在该 profile 的 `package.json` 里把 `dsh-window-maximize` 加进 `dsh.profile.bundles`。
   **这一条**（而不是依赖项）才决定 bundle 会不会被挂载。

3. 重启 DSH。插件在宿主启动时加载。

> 官方桌面版独占管理自己的 `desktop` profile，应用运行时 `dsh` CLI 会拒绝改动它。请在关闭应用
> 的情况下改 profile，或等插件发布后在应用的插件管理里安装。

需要 Windows 和支持插件宿主的 DSH（在 desktop `0.2.1-rc.2` 上验证）。

## 配置

可选，放在 `$DSH_HOME/dsh-window-maximize.json`：

```json
{
  "enabled": true,
  "processName": "DeepSeek Harness",
  "timeoutMs": 120000
}
```

- `enabled: false` 或环境变量 `DSH_WINDOW_MAXIMIZE=0` —— 完全关掉；
- `processName` —— 桌面进程名，只有改过 exe 名字才需要动；
- `timeoutMs` —— 等窗口的上限（5000–600000）。

配置是**启动快照**：每次宿主启动读一次。`DSH_WINDOW_MAXIMIZE=1` 可强制打开（自定义壳看起来不像
Electron 时用得上）。

## 日志

都在 `%LOCALAPPDATA%\dsh-window-maximize\`：

**`plugin.log`** —— 宿主每次 apply 的决策：

```
2026-10-23T16:14:17.365Z apply spawned pid=17972 electron=44.7.0 execPath=D:\dsh\DeepSeek Harness.exe
2026-10-23T16:20:01.002Z apply skip not-desktop-shell electron=- execPath=C:\...\node.exe
```

可能的 skip：`not-win32`、`already-started`、`disabled-by-env`、`not-desktop-shell`、
`disabled-by-config`、`missing-script`。

**`maximize.log`** —— 监视器干了什么：

```
2026-10-24 00:16:13 start pid=15768 process=DeepSeek Harness timeoutMs=120000
2026-10-24 00:16:15 maximized hwnd=1115802 atMs=5
2026-10-24 00:16:15 done afterMs=2091 handled=1 lastProcessCount=7
```

没有 `start` 行 = 监视器没起来（看 `plugin.log` 的 skip 原因）；有 `start` 但没有 `maximized` =
超时内没找到窗口（看 `processName` 对不对）。

## 实现约束（为什么这么写）

- **零依赖**：只用 `node:` 内建，不 import 任何 DSH 包——依赖解析不到也不会连累宿主启动。
- **`apply()` 永不抛错**：最坏情况是"没最大化"，绝不能让宿主起不来。
- **桌面壳判定用 `process.versions.electron`**：桌面宿主是 Electron 的 Node 模式；纯 node 的
  `dsh web` 没有这个字段。不能用 `DSH_DESKTOP_NODE_EXECUTABLE`——桌面壳只在带 `bin` 的子进程
  （装插件）里注入它，宿主自身那一路没有。
- **故意不用 `detached`**：Windows 上 `CREATE_DETACHED_PROCESS` 会让 `powershell.exe` 立刻以 0
  退出、脚本一行都不执行（实测）。宿主本来就活得比监视器久。
- **监视器 `unref()`**：宿主退出流程不会等它。

## 已知限制

- 只做**最大化**，不是 F11 那种真全屏（要盖住任务栏得用 `SetWindowLong`/`SetWindowPos` 去边框）。
- 宿主每次启动都会 apply；宿主重启后你特意调小的窗口会被再最大化一次。
- 监视器只按窗口形状过滤（可见、有标题栏、非工具窗、非 `#32770` 对话框、至少 480×320），所以首次
  运行的欢迎窗口也会被最大化。

## License

MIT
