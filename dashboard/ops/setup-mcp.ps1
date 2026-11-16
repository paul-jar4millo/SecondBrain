param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-zA-Z0-9._-]+$')][string]$SshHostName,
    [Parameter(Mandatory = $true)][ValidatePattern('^[1-9][0-9]{2,8}$')][string]$ContainerId
)
$ErrorActionPreference = 'Stop'
$sshArgs = @('-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', $SshHostName, 'pct', 'exec', $ContainerId, '--', 'runuser', '-u', 'secondbrain', '--', '/usr/local/bin/secondbrain-mcp')
if (Get-Command codex -ErrorAction SilentlyContinue) {
    & codex mcp add secondbrain -- ssh @sshArgs
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo configurar MCP en Codex.' }
}
if (Get-Command claude -ErrorAction SilentlyContinue) {
    & claude mcp add --transport stdio --scope user secondbrain -- ssh @sshArgs
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo configurar MCP en Claude Code.' }
}
Write-Host 'MCP configurado. Los clientes abiertos pueden requerir reiniciar el chat para cargar herramientas nuevas.'
