// Windows app tracking for profiles: which app is in front, and which apps have windows.
const { spawn, execFile } = require("child_process");

// One long-lived PowerShell process polls the foreground window and prints its
// process name when it changes — far cheaper than spawning a process every second.
const WATCH_SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class FG {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
$last = ""
while ($true) {
  $p = 0
  [void][FG]::GetWindowThreadProcessId([FG]::GetForegroundWindow(), [ref]$p)
  $name = ""
  try { $name = (Get-Process -Id $p -ErrorAction Stop).ProcessName } catch {}
  if ($name -ne $last) { [Console]::Out.WriteLine($name); [Console]::Out.Flush(); $last = $name }
  Start-Sleep -Milliseconds 700
}
`;

const encode = (script) => Buffer.from(script, "utf16le").toString("base64");
const exeName = (name) => (name ? name.toLowerCase() + ".exe" : "");

function watchForeground(onChange) {
  let child = null;
  let stopped = false;
  const start = () => {
    child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encode(WATCH_SCRIPT)], {
      windowsHide: true,
    });
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        onChange(exeName(buf.slice(0, nl).trim()));
        buf = buf.slice(nl + 1);
      }
    });
    child.on("exit", () => !stopped && setTimeout(start, 3000));
  };
  start();
  return () => {
    stopped = true;
    if (child) child.kill();
  };
}

// Apps that currently have a visible window: [{ exe, title }].
function listWindowApps() {
  const script =
    "Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object ProcessName, MainWindowTitle | ConvertTo-Json -Compress";
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encode(script)], { windowsHide: true }, (err, out) => {
      if (err) return resolve([]);
      try {
        const data = [].concat(JSON.parse(out || "[]"));
        const seen = new Set();
        resolve(
          data
            .map((p) => ({ exe: exeName(p.ProcessName), title: p.MainWindowTitle }))
            .filter((p) => !seen.has(p.exe) && seen.add(p.exe))
            .sort((a, b) => a.exe.localeCompare(b.exe))
        );
      } catch {
        resolve([]);
      }
    });
  });
}

module.exports = { watchForeground, listWindowApps };
