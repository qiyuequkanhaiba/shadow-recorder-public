Get-Process |
  Where-Object { $_.MainWindowHandle -ne 0 -and -not [string]::IsNullOrWhiteSpace($_.MainWindowTitle) } |
  Sort-Object ProcessName, MainWindowTitle |
  Select-Object ProcessName, Id, MainWindowTitle |
  Format-Table -Wrap -AutoSize
