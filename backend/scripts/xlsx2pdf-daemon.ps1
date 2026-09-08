$ErrorActionPreference = 'Stop'
$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false
$excel.AutomationSecurity = 3
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line -eq 'QUIT') { break }
  $parts = $line -split '\|'
  if ($parts.Count -lt 4) { [Console]::Out.WriteLine('ERR bad-args'); [Console]::Out.Flush(); continue }
  $src = $parts[0]
  $dst = $parts[1]
  $orient = [int]$parts[2]
  $area = $parts[3]
  try {
    if (-not (Test-Path $src)) { [Console]::Out.WriteLine('ERR src-not-found'); [Console]::Out.Flush(); continue }
    $wb = $excel.Workbooks.Open($src, 0, $true)
    try {
      $ws = $wb.Worksheets.Item(1)
      $ps = $ws.PageSetup
      $ps.Zoom = $false
      $ps.Orientation = $orient
      $ps.PaperSize = 9
      $ps.FitToPagesWide = 1
      $ps.FitToPagesTall = 1
      if ($area -ne '') {
        $ps.PrintArea = $area
      } else {
        $existing = $ps.PrintArea
        if (-not $existing -or [string]::IsNullOrWhiteSpace([string]$existing)) { $ps.PrintArea = $ws.UsedRange.Address() }
      }
      $wb.ExportAsFixedFormat(0, $dst, 0, $false, $false, 1, 1, $false)
      [Console]::Out.WriteLine('OK ' + $dst)
      [Console]::Out.Flush()
    } finally {
      $wb.Close($false)
    }
  } catch {
    $msg = $_.Exception.Message -replace '[\r\n]+', ' '
    [Console]::Out.WriteLine('ERR ' + $msg)
    [Console]::Out.Flush()
  }
}
$excel.Quit()
