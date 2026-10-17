param(
  [Parameter(Mandatory = $true)]
  [string]$InputFile,

  [string]$OutputFile = ""
)

$ErrorActionPreference = "Stop"

$source = (Resolve-Path -LiteralPath $InputFile).Path
if (-not $OutputFile) {
  $OutputFile = [System.IO.Path]::ChangeExtension($source, ".mp4")
}

$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ffmpeg) {
  throw "没有找到 ffmpeg。请先安装 FFmpeg，并把 ffmpeg.exe 加入 PATH。"
}

& $ffmpeg.Source -y -i $source -map 0:v:0? -map 0:a:0? -c copy -movflags +faststart $OutputFile
if ($LASTEXITCODE -ne 0) {
  throw "FFmpeg 转换失败，退出码：$LASTEXITCODE"
}

Write-Host "已保存：$OutputFile"
