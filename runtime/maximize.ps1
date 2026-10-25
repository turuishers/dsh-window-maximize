# maximize.ps1 - one-shot watcher: wait for the DSH desktop main window, maximize it, exit.
#
# Started by the dsh-window-maximize plugin (index.js) from the Host process, so the
# app is already running - this script never launches anything. It only polls the
# app's top-level windows and calls ShowWindowAsync(SW_MAXIMIZE) on the first one
# that looks like the main window. Windows PowerShell 5.1 reads this file as ASCII.

param(
    [string]$ProcessName = 'DeepSeek Harness',
    [int]$TimeoutMs = 120000,
    [int]$QuietAfterMs = 15000,
    [string]$LogPath = ''
)

$ErrorActionPreference = 'Stop'

if ($LogPath -eq '') {
    $LogPath = Join-Path $env:LOCALAPPDATA 'dsh-window-maximize\maximize.log'
}

function Write-Log {
    param([string]$Message)
    try {
        $dir = Split-Path -Parent $LogPath
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        Add-Content -Path $LogPath -Value ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message) -Encoding UTF8
    } catch { }
}

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class DshWindowMaximizer
{
    private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr hWnd, uint command);
    [DllImport("user32.dll")]
    private static extern int GetWindowLong(IntPtr hWnd, int index);
    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out Rect rect);
    [DllImport("user32.dll")]
    private static extern bool GetWindowPlacement(IntPtr hWnd, ref WindowPlacement placement);
    [DllImport("user32.dll")]
    private static extern bool ShowWindowAsync(IntPtr hWnd, int command);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder name, int maxCount);

    private const int GwlStyle = -16;
    private const int GwlExStyle = -20;
    private const uint WsCaption = 0x00C00000;
    private const uint WsExToolWindow = 0x00000080;
    private const uint GwOwner = 4;
    private const int SwMaximize = 3;
    private const int SwShowMaximized = 3;

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    private struct Point { public int X, Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct WindowPlacement
    {
        public int Length;
        public int Flags;
        public int ShowCmd;
        public Point MinPosition;
        public Point MaxPosition;
        public Rect NormalPosition;
    }

    public static string Watch(string processName, int timeoutMs, int quietAfterMs)
    {
        var handled = new HashSet<IntPtr>();
        var log = new StringBuilder();
        var stopwatch = Stopwatch.StartNew();
        long lastSeenMs = -1;
        int lastProcessCount = 0;

        while (stopwatch.ElapsedMilliseconds < timeoutMs)
        {
            var pids = new HashSet<uint>();
            Process[] processes;
            try { processes = Process.GetProcessesByName(processName); }
            catch { processes = new Process[0]; }
            foreach (var process in processes)
            {
                try { pids.Add((uint)process.Id); }
                catch { }
                process.Dispose();
            }
            lastProcessCount = pids.Count;

            if (pids.Count > 0)
            {
                var targets = new List<IntPtr>();
                EnumWindows((hWnd, lParam) =>
                {
                    uint pid;
                    GetWindowThreadProcessId(hWnd, out pid);
                    if (!pids.Contains(pid)) return true;
                    if (!IsWindowVisible(hWnd)) return true;
                    if (handled.Contains(hWnd)) return true;
                    if (GetWindow(hWnd, GwOwner) != IntPtr.Zero) return true;

                    var exStyle = (uint)GetWindowLong(hWnd, GwlExStyle);
                    if ((exStyle & WsExToolWindow) != 0) return true;

                    var style = (uint)GetWindowLong(hWnd, GwlStyle);
                    if ((style & WsCaption) == 0) return true;

                    var className = new StringBuilder(256);
                    GetClassName(hWnd, className, className.Capacity);
                    if (className.ToString() == "#32770") return true;

                    Rect rect;
                    if (!GetWindowRect(hWnd, out rect)) return true;
                    if (rect.Right - rect.Left < 480 || rect.Bottom - rect.Top < 320) return true;

                    lastSeenMs = stopwatch.ElapsedMilliseconds;

                    var placement = new WindowPlacement();
                    placement.Length = Marshal.SizeOf(typeof(WindowPlacement));
                    if (GetWindowPlacement(hWnd, ref placement) && placement.ShowCmd == SwShowMaximized)
                    {
                        handled.Add(hWnd);
                        return true;
                    }

                    targets.Add(hWnd);
                    return true;
                }, IntPtr.Zero);

                foreach (var hWnd in targets)
                {
                    if (ShowWindowAsync(hWnd, SwMaximize))
                    {
                        handled.Add(hWnd);
                        log.Append("maximized hwnd=").Append(hWnd.ToInt64())
                           .Append(" atMs=").Append(stopwatch.ElapsedMilliseconds).AppendLine();
                    }
                }
            }

            if (lastSeenMs >= 0 && stopwatch.ElapsedMilliseconds - lastSeenMs >= quietAfterMs) break;
            if (pids.Count == 0 && stopwatch.ElapsedMilliseconds > 20000) break;

            Thread.Sleep(250);
        }

        log.Append("done afterMs=").Append(stopwatch.ElapsedMilliseconds)
           .Append(" handled=").Append(handled.Count)
           .Append(" lastProcessCount=").Append(lastProcessCount).AppendLine();
        return log.ToString();
    }
}
'@ -Language CSharp

Write-Log ("start pid={0} process={1} timeoutMs={2}" -f $PID, $ProcessName, $TimeoutMs)

$result = [DshWindowMaximizer]::Watch($ProcessName, $TimeoutMs, $QuietAfterMs)

Write-Log $result
