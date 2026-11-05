# Agent Console — UI fallback sender for agents with no official CLI.
#
# Focuses the app's main window, pastes the prompt from the clipboard and presses
# Enter. Used only for Grok Bot and Marvis, whose private IPC is not a supported
# channel. Requires the app to be open with the target conversation focused.
#
# -Probe returns the window that would receive the text instead of sending.
param(
  [Parameter(Mandatory = $true)][ValidateSet('grokbot', 'marvis')][string]$App,
  [string]$TextBase64,
  [switch]$Probe
)

$ErrorActionPreference = 'Stop'

$processNames = @{ grokbot = 'Grok Bot'; marvis = 'Marvis' }
$processName = $processNames[$App]

function Out-Json($value) {
  Write-Output ($value | ConvertTo-Json -Compress)
}

$target = Get-Process -Name $processName -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } |
  Select-Object -First 1

if (-not $target) {
  Out-Json @{ ok = $false; error = 'window-not-found'; app = $App }
  exit 0
}

if ($Probe) {
  Out-Json @{ ok = $true; app = $App; pid = $target.Id; title = $target.MainWindowTitle }
  exit 0
}

if (-not $TextBase64) {
  Out-Json @{ ok = $false; error = 'empty-text'; app = $App }
  exit 0
}

Add-Type -Namespace AgentConsole -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
'@

$handle = $target.MainWindowHandle
[void][AgentConsole.Win]::ShowWindow($handle, 9)         # SW_RESTORE
[AgentConsole.Win]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero) | Out-Null   # tap Alt to allow foreground
[void][AgentConsole.Win]::SetForegroundWindow($handle)
[AgentConsole.Win]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero) | Out-Null
Start-Sleep -Milliseconds 350

$text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($TextBase64))
Set-Clipboard -Value $text
Start-Sleep -Milliseconds 200

Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')

Out-Json @{ ok = $true; app = $App; pid = $target.Id; title = $target.MainWindowTitle }
