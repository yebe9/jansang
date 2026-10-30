param([switch]$WithoutMotionGPT)
$ErrorActionPreference='Stop'
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $projectRoot
$pythonCandidates=@((Join-Path $projectRoot '.venv-motion\Scripts\python.exe'),(Join-Path $projectRoot '.venv\Scripts\python.exe'))
$pythonExecutable=$pythonCandidates | Where-Object {Test-Path -LiteralPath $_} | Select-Object -First 1
$cpuProcess=$null
$previousMotionURL=$env:MOTIONGPT_URL
try{
  if(-not $WithoutMotionGPT){
    if(-not $pythonExecutable){throw 'Create .venv-motion and install motion_service/requirements.txt first.'}
    if(-not (Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue)){
      $previewDirectory=Join-Path $projectRoot '.codex-preview'
      New-Item -ItemType Directory -Path $previewDirectory -Force | Out-Null
      $cpuProcess=Start-Process -FilePath $pythonExecutable -ArgumentList '-m','motion_service.server','--port','8765' -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $previewDirectory 'motion-cpu.stdout.log') -RedirectStandardError (Join-Path $previewDirectory 'motion-cpu.stderr.log')
    }
    $env:MOTIONGPT_URL='http://127.0.0.1:8765'
  }
  if(Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue){throw 'Port 4173 is already in use. Use the running local site or stop its server first.'}
  Write-Output 'Open http://127.0.0.1:4173/ ; Ctrl+C stops this local web server.'
  if(Test-Path -LiteralPath (Join-Path $projectRoot '.env')){& node --env-file=.env server.cjs}else{& node server.cjs}
}finally{
  $env:MOTIONGPT_URL=$previousMotionURL
  if($cpuProcess -and -not $cpuProcess.HasExited){Stop-Process -Id $cpuProcess.Id}
}
