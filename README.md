# dsh-window-maximize

English | [中文](README.zh.md)

A [DSH](https://github.com/deepseek-ai/deepseek-harness) host plugin that **maximizes the desktop app's main window every time it starts** (Windows).

## Why

The DSH desktop shell creates its primary window with a hard-coded size:

```js
// app.asar → lib/main.js → createWindow()
new BrowserWindow({ width: 1280, height: 820, minWidth: 520, minHeight: 600, show })
```

It does not store window bounds, and it exposes no "start maximized" setting — `desktop/settings.json`
only accepts `updates.allowTestAuthPopupWindow`. Plugins run in the Host process, which has no access to
Electron's `BrowserWindow`, so this plugin takes the shortest reliable path: on `apply()` it spawns a
one-shot PowerShell watcher that polls the app's top-level windows and calls
`ShowWindowAsync(SW_MAXIMIZE)` as soon as the main window appears, then exits.

Because it is a Host plugin, it works no matter how the app was launched — Start menu, taskbar pin, or the
executable itself. No shortcut surgery, nothing to redo after an app update.

## Behavior

| Situation | Result |
| --- | --- |
| Cold start | main window is maximized as soon as it appears |
| Window hidden in the tray, then reopened | maximized as soon as it appears |
| Host restart (not app restart) | applies again; already maximized is a no-op |
| Plain `dsh web` (browser Host) | does nothing |
| Non-Windows | does nothing |

The watcher waits up to 120 seconds for the window and then gives up, so nothing stays resident.

## Install

1. Add the package to the profile you run:

   ```sh
   cd "$DSH_HOME/profiles/<name>"          # e.g. web
   pnpm add "dsh-window-maximize@git+https://github.com/turuishers/dsh-window-maximize.git"
   ```

2. Add `dsh-window-maximize` to `dsh.profile.bundles` in that profile's `package.json`. That list — not the
   dependency entry — is what decides whether a bundle mounts.

3. Restart DSH. Plugins load when the Host starts.

> The official Desktop app owns its `desktop` profile; the `dsh` CLI refuses to manage it while the app is
> running. Edit that profile with the app closed, or install through the app's plugin manager.

Requires Windows and a DSH build with a plugin Host (tested against desktop `0.2.1-rc.2`).

## Configuration

Optional, at `$DSH_HOME/dsh-window-maximize.json`:

```json
{
  "enabled": true,
  "processName": "DeepSeek Harness",
  "timeoutMs": 120000
}
```

- `enabled: false`, or the environment variable `DSH_WINDOW_MAXIMIZE=0` — turn the plugin off entirely.
- `processName` — the desktop app's process name; only relevant if the executable was renamed.
- `timeoutMs` — how long to wait for the window (5000–600000).

Configuration is a start-up snapshot: it is read once per Host start. `DSH_WINDOW_MAXIMIZE=1` forces the
plugin on (useful when a custom shell does not look like Electron).

## Logs

Under `%LOCALAPPDATA%\dsh-window-maximize\`:

**`plugin.log`** — the Host's decision on every apply:

```
2026-10-23T16:14:17.365Z apply spawned pid=17972 electron=44.7.0 execPath=D:\dsh\DeepSeek Harness.exe
2026-10-23T16:20:01.002Z apply skip not-desktop-shell electron=- execPath=C:\...\node.exe
```

Possible skips: `not-win32`, `already-started`, `disabled-by-env`, `not-desktop-shell`,
`disabled-by-config`, `missing-script`.

**`maximize.log`** — what the watcher did:

```
2026-10-24 00:16:13 start pid=15768 process=DeepSeek Harness timeoutMs=120000
2026-10-24 00:16:15 maximized hwnd=1115802 atMs=5
2026-10-24 00:16:15 done afterMs=2091 handled=1 lastProcessCount=7
```

No `start` line means the watcher never ran — check `plugin.log` for the skip reason. A `start` with no
`maximized` means no window was found within the timeout — check `processName`.

## How it works, and why it is written this way

- **Zero dependencies.** Only `node:` built-ins; no DSH package is imported, so a resolution failure cannot
  take the Host down with it.
- **`apply()` never throws.** The worst case is "no maximize", never a Host that fails to start.
- **Desktop detection uses `process.versions.electron`.** The Host of the desktop app runs Electron in Node
  mode, so that field exists there and is absent in a plain-node `dsh web` Host. Do not use
  `DSH_DESKTOP_NODE_EXECUTABLE`: the desktop shell only sets it for child processes that also get a `bin`
  directory (plugin installation), never for the Host itself.
- **Deliberately not `detached`.** On Windows, `CREATE_DETACHED_PROCESS` makes `powershell.exe` exit
  immediately without executing the script (measured). The Host outlives the watcher anyway.
- **The watcher is `unref()`ed**, so Host shutdown never waits for it.

## Limitations

- Maximizes only — it is not an F11-style fullscreen mode (covering the taskbar would need border removal
  through `SetWindowLong`/`SetWindowPos`).
- The plugin applies on every Host start, so a deliberate resize right after a Host restart will be
  maximized again.
- The watcher only filters by window shape (visible, captioned, not a tool window, not a `#32770` dialog,
  at least 480×320), so a first-run welcome window gets maximized as well.

## License

MIT
