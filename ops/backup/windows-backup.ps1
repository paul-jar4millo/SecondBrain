param([Parameter(Mandatory=$true)][string]$ConfigPath,[switch]$Force,[switch]$Full)
$ErrorActionPreference='Stop'
$config=Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$env:RESTIC_PASSWORD_FILE=$config.PasswordFile
$repoArgs=@('-r',$config.Repository)
$remote='/usr/local/lib/secondbrain-backup/host-backup.sh'
$statePath=Join-Path (Split-Path -Parent $ConfigPath) 'last-run.json'
$previous=if(Test-Path -LiteralPath $statePath){Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json}else{$null}
if(-not $Force -and $previous.lastSuccess -and ([datetimeoffset]::Now-[datetimeoffset]$previous.lastSuccess).TotalHours -lt 20){exit 0}
function Run-Restic([string[]]$Arguments){
  & $config.Restic @repoArgs @Arguments
  if($LASTEXITCODE -ne 0){throw 'Encrypted backup operation failed'}
}
try{
  $capture=(& ssh.exe -o BatchMode=yes -o ConnectTimeout=10 $config.Host "bash $remote capture" | Out-String).Trim()
  if($LASTEXITCODE -ne 0 -or $capture -notmatch '^/var/lib/vz/secondbrain-backup/vzdump-lxc-[0-9]+-[0-9_:-]+\.tar\.zst$'){throw 'No valid consistent container capture'}
  Run-Restic -Arguments @('backup','--tag','secondbrain-data','--stdin-filename','secondbrain-durable.tar','--stdin-from-command','--','ssh.exe','-o','BatchMode=yes',$config.Host,"bash $remote durable $capture")
  $snapshots=(& $config.Restic @repoArgs snapshots --tag secondbrain-data --latest 1 --json | Out-String | ConvertFrom-Json)
  if($LASTEXITCODE -ne 0 -or -not $snapshots[0].id){throw 'Cannot identify completed snapshot'}
  $snapshot=$snapshots[0].id
  $fullAt=$previous.lastFull
  if($Full -or -not $fullAt -or ([datetimeoffset]::Now-[datetimeoffset]$fullAt).TotalDays -ge 7){
    Run-Restic -Arguments @('backup','--tag','secondbrain-system','--stdin-filename','secondbrain-system.tar.zst','--stdin-from-command','--','ssh.exe','-o','BatchMode=yes',$config.Host,"bash $remote full $capture")
    $fullAt=[datetimeoffset]::Now.ToString('o')
  }
  Run-Restic -Arguments @('check')
  & ssh.exe -o BatchMode=yes $config.Host "bash $remote success $snapshot"
  if($LASTEXITCODE -ne 0){throw 'Backup stored but remote status was not acknowledged'}
  @{lastSuccess=[datetimeoffset]::Now.ToString('o');lastFull=$fullAt;snapshot=$snapshot} | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8NoBOM
  if($config.EnablePrune){
    Run-Restic -Arguments @('forget','--tag','secondbrain-data','--keep-daily','7','--keep-weekly','4','--keep-monthly','3','--prune')
    Run-Restic -Arguments @('forget','--tag','secondbrain-system','--keep-last','2','--prune')
  }
}catch{
  & ssh.exe -o BatchMode=yes -o ConnectTimeout=10 $config.Host "bash $remote failure" 2>$null
  throw
}
