# Parses an OKV "Renholdsplan - periodisk renhold" xlsx (RB04, sheets named "Peri N") into
# normalized room/task/months JSON — the sibling of parse_renholdsplan.ps1 for the structurally
# different periodic template. Rule: a sheet counts as periodic room data only if it has a header
# row containing both "Lokale" and "Inv/Objekt", AND the 12 columns right after "Merknader" are
# literally "1".."12" (month numbers), not the weekday letters M T O T F L S that mark an RB01
# sheet, and not the week-of-month numbers 1-5 that mark an RB03 (Lørdag) sheet. Sheets that don't
# match (kart/kjemi/EK/Historikk/Endring/Kommentarer/RB01/RB03) are skipped and reported by name.
param(
    [Parameter(Mandatory=$true)][string]$Path
)

if (-not (Test-Path -LiteralPath $Path)) {
    Write-Error "File not found: $Path"
    exit 1
}

# See parse_renholdsplan.ps1's own comment on this: this file has no UTF-8 BOM, and Windows
# PowerShell 5.1 misreads a non-ASCII literal typed directly into a BOM-less source file via the
# legacy codepage. Built from Unicode escapes instead.
$omradeLabel = "Omr" + [char]0x00E5 + "de"

$ErrorActionPreference = "Stop"
$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false
try {
    $wb = $excel.Workbooks.Open($Path, 0, $true)
} catch {
    $excel.Quit()
    [System.Runtime.Interopservices.Marshal]::ReleaseComObject($excel) | Out-Null
    throw
}

$allRooms = New-Object System.Collections.ArrayList
$skippedSheets = New-Object System.Collections.ArrayList

function Esc($s) {
    if ($null -eq $s) { return "" }
    return ($s -replace '\\','\\\\' -replace '"','\"' -replace "`r`n","\n" -replace "`n","\n" -replace "`t"," ")
}

foreach ($ws in $wb.Worksheets) {
  try {
    # Same rule as parse_renholdsplan.ps1: a hidden sheet is never active plan data.
    if ($ws.Visible -ne -1) {
        $skippedSheets.Add("$($ws.Name) (hidden sheet - not part of the active plan)") | Out-Null
        continue
    }
    $used = $ws.UsedRange
    $rows = $used.Rows.Count
    $cols = $used.Columns.Count
    $startRow = $used.Row
    $startCol = $used.Column

    $headerRow = -1
    $lokaleCol = -1; $invCol = -1; $frekCol = -1; $merknaderCol = -1
    for ($r = 1; $r -le [Math]::Min($rows, 20); $r++) {
        $hasLokale = $false; $hasInv = $false
        for ($c = 1; $c -le $cols; $c++) {
            $t = $ws.Cells.Item($startRow + $r - 1, $startCol + $c - 1).Text
            if ($t -eq "Lokale" -or $t -eq $omradeLabel) { $hasLokale = $true; $lokaleCol = $c }
            if ($t -eq "Inv/Objekt" -or $t -eq "Rom / Objekt" -or $t -eq "Rom/Objekt") { $hasInv = $true; $invCol = $c }
            if ($t -eq "Frek.") { $frekCol = $c }
            if ($t -eq "Merknader") { $merknaderCol = $c }
        }
        if ($hasLokale -and $hasInv) { $headerRow = $r; break }
    }

    if ($headerRow -eq -1 -or $merknaderCol -eq -1) {
        $skippedSheets.Add("$($ws.Name) (no Lokale/Inv-Objekt/Merknader header found)") | Out-Null
        continue
    }

    # The 12 columns right after Merknader must read literally "1".."12" - this is what
    # distinguishes an RB04 periodic sheet from an RB01 weekday-grid or RB03 week-of-month sheet,
    # both of which have a different (7- or 5-column) grid in this same position.
    $mStart = $merknaderCol + 1
    $monthHeader = @()
    for ($i = 0; $i -lt 12; $i++) {
        $monthHeader += $ws.Cells.Item($startRow + $headerRow - 1, $startCol + $mStart + $i - 1).Text.Trim()
    }
    $isMonthGrid = $true
    for ($i = 0; $i -lt 12; $i++) {
        if ($monthHeader[$i] -ne [string]($i + 1)) { $isMonthGrid = $false; break }
    }
    if (-not $isMonthGrid) {
        $skippedSheets.Add("$($ws.Name) (header after Merknader = [$($monthHeader -join ',')], not 1..12)") | Out-Null
        continue
    }
    # One column past the 12 month columns: the responsibility flag, same x/p-means-the-customer's
    # convention as RB01 (see tools/README.md) - just at Merknader+13 here instead of Merknader+8.
    $flagCol = $mStart + 12

    $areaName = ""
    for ($r = 1; $r -lt $headerRow; $r++) {
        for ($c = 1; $c -le $cols; $c++) {
            $labelText = $ws.Cells.Item($startRow + $r - 1, $startCol + $c - 1).Text
            if ($labelText -eq $omradeLabel) {
                $areaName = $ws.Cells.Item($startRow + $r, $startCol + $c - 1).Text
            }
        }
    }

    $currentLokale = ""
    $roomsBySheet = @{}
    $order = New-Object System.Collections.ArrayList

    for ($r = $headerRow + 1; $r -le $rows; $r++) {
        $lokaleVal = $ws.Cells.Item($startRow + $r - 1, $startCol + $lokaleCol - 1).Text.Trim()
        $invVal = $ws.Cells.Item($startRow + $r - 1, $startCol + $invCol - 1).Text.Trim()
        if ($lokaleVal -ne "") { $currentLokale = $lokaleVal }
        if ($currentLokale -eq "" -or $invVal -eq "") { continue }
        # Same footer-date-leak guard as parse_renholdsplan.ps1.
        if ($invVal -match "^\d{1,2}\.\d{1,2}\.\d{2,4}$") { continue }

        $freqCount = $ws.Cells.Item($startRow + $r - 1, $startCol + $frekCol - 1).Text.Trim()
        $freqUnit = $ws.Cells.Item($startRow + $r - 1, $startCol + $frekCol + 2 - 1).Text.Trim()  # "/" is frekCol+1

        $months = @()
        for ($i = 0; $i -lt 12; $i++) {
            $mark = $ws.Cells.Item($startRow + $r - 1, $startCol + $mStart + $i - 1).Text.Trim()
            if ($mark -ne "") { $months += ($i + 1) }
        }

        if (-not $roomsBySheet.ContainsKey($currentLokale)) {
            $roomsBySheet[$currentLokale] = New-Object System.Collections.ArrayList
            $order.Add($currentLokale) | Out-Null
        }
        $flagVal = $ws.Cells.Item($startRow + $r - 1, $startCol + $flagCol - 1).Text.Trim()

        $roomsBySheet[$currentLokale].Add(@{ task = $invVal; freqCount = $freqCount; freqUnit = $freqUnit; months = $months; flag = $flagVal }) | Out-Null
    }

    if ($order.Count -eq 0) {
        $skippedSheets.Add("$($ws.Name) (header matched but 0 data rows - Lokale/Inv-Objekt columns empty, check sheet manually)") | Out-Null
    }
    foreach ($lokale in $order) {
        $allRooms.Add(@{ sheet = $ws.Name; area = $areaName; lokale = $lokale; tasks = $roomsBySheet[$lokale] }) | Out-Null
    }
  } catch {
    $skippedSheets.Add("$($ws.Name) (ERROR: $($_.Exception.Message))") | Out-Null
  }
}

$wb.Close($false)
$excel.Quit()
[System.Runtime.Interopservices.Marshal]::ReleaseComObject($wb) | Out-Null
[System.Runtime.Interopservices.Marshal]::ReleaseComObject($excel) | Out-Null

# --- Emit JSON manually (no ConvertTo-Json dependency issues with nested hashtables) ---
$sb = New-Object System.Text.StringBuilder
[void]$sb.Append("{`"skipped`":[")
for ($i = 0; $i -lt $skippedSheets.Count; $i++) {
    if ($i -gt 0) { [void]$sb.Append(",") }
    [void]$sb.Append("`"$(Esc($skippedSheets[$i]))`"")
}
[void]$sb.Append("],`"rooms`":[")
for ($i = 0; $i -lt $allRooms.Count; $i++) {
    $room = $allRooms[$i]
    if ($i -gt 0) { [void]$sb.Append(",") }
    [void]$sb.Append("{`"sheet`":`"$(Esc($room.sheet))`",`"area`":`"$(Esc($room.area))`",`"lokale`":`"$(Esc($room.lokale))`",`"tasks`":[")
    for ($j = 0; $j -lt $room.tasks.Count; $j++) {
        $t = $room.tasks[$j]
        if ($j -gt 0) { [void]$sb.Append(",") }
        $mo = ($t.months -join ",")
        [void]$sb.Append("{`"task`":`"$(Esc($t.task))`",`"freqCount`":`"$(Esc($t.freqCount))`",`"freqUnit`":`"$(Esc($t.freqUnit))`",`"months`":[$mo],`"flag`":`"$(Esc($t.flag))`"}")
    }
    [void]$sb.Append("]}")
}
[void]$sb.Append("]}")
Write-Output $sb.ToString()
