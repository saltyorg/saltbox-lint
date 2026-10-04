param([Parameter(Mandatory = $true)][string]$Payload)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
    if ($PSVersionTable.PSVersion.Major -lt 7) { throw "Owned launcher requires PowerShell 7 for in-process C# compilation" }
    $command = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json
    $executable = Get-Command -Name $command.command -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $executable) { throw "ENOENT: owned command $($command.command)" }
    Add-Type -TypeDefinition (Get-Content -Raw (Join-Path $PSScriptRoot 'owned-command-windows.cs'))
    exit [SaltboxOwnedCommand]::Run($executable.Source, [string[]]$command.args, $command.cwd)
} catch {
    [Console]::Error.WriteLine($_.Exception.ToString())
    exit 1
}
