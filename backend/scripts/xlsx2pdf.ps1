param([string]$Src, [string]$Dst, [int]$Orient = 1, [string]$PrintArea = '')
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $Src)) { Write-Error 'SRC_NOT_FOUND'; exit 2 }
$excel = New-Object -ComObject Excel.Application
try {
  $excel.Visible = $false
  $excel.DisplayAlerts = $false
  $excel.AutomationSecurity = 3
  $wb = $excel.Workbooks.Open($Src, 0, $true)
  try {
    $ws = $wb.Worksheets.Item(1)
    $ps = $ws.PageSetup
    $ps.Zoom = $false
    $ps.Orientation = $Orient
    $ps.PaperSize = 9
    $ps.FitToPagesWide = 1
    $ps.FitToPagesTall = 1
    if ($PrintArea -ne '') { $ps.PrintArea = $PrintArea } else { $existing = $ps.PrintArea; if (-not $existing -or [string]::IsNullOrWhiteSpace([string]$existing)) { $ps.PrintArea = $ws.UsedRange.Address() } }
    $wb.ExportAsFixedFormat(0, $Dst, 0, $false, $false, 1, 1, $false)
    Write-Output 'PDF_OK'
  } finally {
    $wb.Close($false)
  }
} finally {
  $excel.Quit()
  [System.Runtime.Interopservices.Marshal]::ReleaseComObject($excel) | Out-Null
}
