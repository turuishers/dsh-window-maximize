/**
 * dsh-window-maximize —— 宿主半边。
 *
 * DSH 桌面版的主进程把窗口写死成 1280×820（`app.asar` 里 `createWindow()` 的
 * `width: 1280, height: 820`），既不保存窗口状态，也没有"启动时最大化"的配置项。
 * 宿主进程拿不到 Electron 的 BrowserWindow，所以这里用一条最稳的路子：
 *
 *   apply() 时 spawn 一个**一次性的 PowerShell 窗口监视器**（runtime/maximize.ps1），
 *   它按进程名轮询顶层窗口，主窗口一出现就 ShowWindowAsync(SW_MAXIMIZE)，
 *   然后自己退出。宿主只负责点火，不等待、不阻塞启动。
 *
 * 刻意约束（和 dsh-video-skin 同一套理由）：
 *   - 只用 `node:` 内建，不 import 任何 DSH 包 —— 依赖解析不到不会连累宿主启动；
 *   - 整个 apply 包在 try/catch 里 —— 插件出问题最多是"没最大化"，绝不能让 DSH 起不来；
 *   - 只在桌面壳里动作。桌面宿主是 Electron 以 Node 模式跑起来的子进程，特征是
 *     `process.versions.electron` 存在；**不能**用 `DSH_DESKTOP_NODE_EXECUTABLE` 判断：
 *     那个变量只在 Electron 拉起带 `bin` 的子进程（装插件）时注入，宿主自身那一路
 *     传的是 `bin === undefined`，环境里没有它；
 *   - 监视器 `unref()`，宿主退出/重启不会被它拖住。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Cordis 诊断用的插件名。 */
export const name = 'window-maximize'

/** 没有必需服务。 */
export const inject = []

/** 用户级配置文件名（放在 $DSH_HOME 下）。 */
export const CONFIG_FILE = 'dsh-window-maximize.json'

/** 缺省值；配置文件里能覆盖。 */
export const DEFAULT_CONFIG = Object.freeze({
  /** 设为 false 就完全不做任何事。 */
  enabled: true,
  /** 桌面包的进程名；窗口监视器按它找顶层窗口。 */
  processName: 'DeepSeek Harness',
  /** 等窗口出现的最长时间（毫秒），超时就放弃。 */
  timeoutMs: 120000,
})

/** 同一个宿主进程里只点火一次（apply 可能因插件树重载被再次调用）。 */
let started = false

function readConfig(homeDir) {
  const config = { ...DEFAULT_CONFIG }
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(homeDir, CONFIG_FILE), 'utf8'))
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return config
    if (typeof raw.enabled === 'boolean') config.enabled = raw.enabled
    if (typeof raw.processName === 'string' && raw.processName.trim() !== '') config.processName = raw.processName.trim()
    if (Number.isFinite(raw.timeoutMs)) config.timeoutMs = Math.min(Math.max(Math.trunc(raw.timeoutMs), 5000), 600000)
  } catch {
    /* 文件不存在/写坏了都退回缺省值 —— 这不是错误。 */
  }
  return config
}

function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  try {
    return path.join(os.homedir(), '.dsh')
  } catch {
    return undefined
  }
}

function powershellPath() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/** 桌面壳判定：Electron 的 Node 模式（`dsh web` 跑在纯 node 里，不会有这个字段）。 */
function isDesktopShell() {
  if (process.env.DSH_WINDOW_MAXIMIZE === '1') return true
  if (typeof process.versions?.electron === 'string' && process.versions.electron !== '') return true
  const executable = process.env.DSH_DESKTOP_NODE_EXECUTABLE
  return typeof executable === 'string' && executable !== ''
}

/** 决策日志：为什么点火 / 为什么没点火，各留一行，排查时不用猜。 */
function appendLog(message) {
  try {
    const base = process.env.LOCALAPPDATA || process.env.TEMP || os.tmpdir()
    const dir = path.join(base, 'dsh-window-maximize')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, 'plugin.log'), `${new Date().toISOString()} ${message}\n`, 'utf8')
  } catch {
    /* 日志写不进去也不影响功能 */
  }
}

/**
 * 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文（只用来记日志）。
 */
export function apply(ctx) {
  let decision = 'unknown'
  try {
    if (process.platform !== 'win32') {
      decision = 'skip not-win32'
      return
    }
    if (started) {
      decision = 'skip already-started'
      return
    }
    if (process.env.DSH_WINDOW_MAXIMIZE === '0') {
      decision = 'skip disabled-by-env'
      return
    }
    if (!isDesktopShell()) {
      decision = 'skip not-desktop-shell'
      return
    }

    const homeDir = resolveDshHome()
    if (homeDir === undefined) {
      decision = 'skip no-dsh-home'
      return
    }
    const config = readConfig(homeDir)
    if (!config.enabled) {
      decision = 'skip disabled-by-config'
      return
    }

    const here = path.dirname(fileURLToPath(import.meta.url))
    const script = path.join(here, 'runtime', 'maximize.ps1')
    if (!fs.existsSync(script)) {
      decision = 'skip missing-script'
      ctx?.logger?.warn?.(`[${name}] runtime/maximize.ps1 不存在，跳过`)
      return
    }

    const child = spawn(
      powershellPath(),
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-WindowStyle',
        'Hidden',
        '-File',
        script,
        '-ProcessName',
        config.processName,
        '-TimeoutMs',
        String(config.timeoutMs),
      ],
      // 刻意**不用** detached：Windows 上 CREATE_DETACHED_PROCESS 会让 powershell.exe
      // 起不来（实测子进程直接以 0 退出、脚本一行都没执行）。宿主本来就活到用户关掉 DSH。
      { stdio: 'ignore', windowsHide: true },
    )
    child.on('error', (error) => {
      const message = error instanceof Error ? error.message : String(error)
      appendLog(`watcher-spawn-error ${message}`)
      ctx?.logger?.warn?.(`[${name}] 窗口监视器启动失败：${message}`)
    })
    child.unref()
    started = true
    decision = `spawned pid=${String(child.pid)}`
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    decision = `error ${message}`
    try {
      ctx?.logger?.warn?.(`[${name}] ${message}`)
    } catch {
      /* 日志失败也不能成为失败原因 */
    }
  } finally {
    appendLog(`apply ${decision} electron=${process.versions?.electron ?? '-'} execPath=${process.execPath}`)
  }
}
