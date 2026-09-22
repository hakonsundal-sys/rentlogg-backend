# Parses an OKV "Renholdsplan" xlsx into normalized room/task/schedule JSON.
# Rule: a sheet counts as room data only if it has a header row containing both "Lokale" and
# "Inv/Objekt", AND the 7 columns right after "Merknader" are the weekday letters M T O T F L S
# (not week-of-month numbers 1-5, which marks a Lørdag/rotating-Saturday sheet, and not some other
# layout, like the "EK ..." sign-off sheets). Sheets that don't match (kart/kjemi/EK/Historikk/
# Endring/Kommentarer/Lørdag/periodisk) are skipped and reported by name so nothing silently
# disappears.
param(
    [Parameter(Mandatory=$true)][string]$Path
)

if (-not (Test-Path -LiteralPath $Path)) {
    Write-Error "File not found: $Path"
    exit 1
}

# Built from a Unicode escape, not typed as a literal: this .ps1 has no UTF-8 BOM, and Windows
# PowerShell 5.1 misreads non-ASCII literals (e.g. "Omrade" with an a-ring) in a BOM-less source
# file via the legacy codepage, silently corrupting the comparison so it never matches. Building
# the string from [char] codepoints sidesteps the source-encoding problem entirely.
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

$weekdayLetters = @("M","T","O","T","F","L","S")
# English edition of the same template (first seen on Oslo Salmon Processing, 2026-09-20).
$weekdayLettersEn = @("Mo","Tu","We","Th","Fr","Sa","Su")
$allRooms = New-Object System.Collections.ArrayList
$skippedSheets = New-Object System.Collections.ArrayList

function Esc($s) {
    if ($null -eq $s) { return "" }
    return ($s -replace '\\','\\\\' -replace '"','\"' -replace "`r`n","\n" -replace "`n","\n" -replace "`t"," ")
}

foreach ($ws in $wb.Worksheets) {
  try {
    # A hidden (or very-hidden) sheet is, by Håkon's own rule, not an active part of the plan
    # regardless of what it structurally looks like - never extract rooms from it, even if it has
    # a perfectly normal Lokale/Inv-Objekt/weekday-grid shape. $ws.Visible is -1 (xlSheetVisible)
    # when shown; 0 (xlSheetHidden) or 2 (xlSheetVeryHidden) otherwise.
    if ($ws.Visible -ne -1) {
        $skippedSheets.Add("$($ws.Name) (hidden sheet - not part of the active plan)") | Out-Null
        continue
    }
    $used = $ws.UsedRange
    $rows = $used.Rows.Count
    $cols = $used.Columns.Count
    $startRow = $used.Row
    $startCol = $used.Column

    # Find the header row: one containing both "Lokale" and "Inv/Objekt"
    $headerRow = -1
    $lokaleCol = -1; $invCol = -1; $frekCol = -1; $merknaderCol = -1
    for ($r = 1; $r -le [Math]::Min($rows, 20); $r++) {
        $hasLokale = $false; $hasInv = $false
        for ($c = 1; $c -le $cols; $c++) {
            $t = $ws.Cells.Item($startRow + $r - 1, $startCol + $c - 1).Text
            if ($t -eq "Lokale" -or $t -eq $omradeLabel -or $t -eq "Location") { $hasLokale = $true; $lokaleCol = $c }
            # "Rom / Objekt" is the administration edition's name for the same column.
            if ($t -eq "Inv/Objekt" -or $t -eq "Inventory/Object" -or $t -eq "Rom / Objekt" -or $t -eq "Rom/Objekt") { $hasInv = $true; $invCol = $c }
            if ($t -eq "Frek." -or $t -eq "Freq.") { $frekCol = $c }
            if ($t -eq "Merknader" -or $t -eq "Remarks") { $merknaderCol = $c }
        }
        if ($hasLokale -and $hasInv) { $headerRow = $r; break }
    }

    if ($headerRow -eq -1 -or $merknaderCol -eq -1) {
        $skippedSheets.Add("$($ws.Name) (no Lokale/Inv-Objekt/Merknader header found)") | Out-Null
        continue
    }

    # weekday columns are the 7 columns right after Merknader
    $wdStart = $merknaderCol + 1
    # One column past the 7 weekday columns: the responsibility flag. "x" (daily/weekly task) or
    # "p" (periodic task) both mean the CUSTOMER does this one themselves; blank means it is ours.
    # This is what drives the blue/gray row highlight in the source file - that highlight is
    # conditional formatting, so reading .Interior.Color over COM finds nothing (see tools/README).
    $flagCol = $wdStart + 7
    $headerLetters = @()
    for ($i = 0; $i -lt 7; $i++) {
        $headerLetters += $ws.Cells.Item($startRow + $headerRow - 1, $startCol + $wdStart + $i - 1).Text
    }
    # Either edition is accepted, but the row must match ONE of them completely - a partial match
    # means some other layout (Lorda/periodisk sheets use 1-5 or 1-12 here) and must still skip.
    $isWeekdayGrid = $true
    for ($i = 0; $i -lt 7; $i++) {
        if ($headerLetters[$i] -ne $weekdayLetters[$i]) { $isWeekdayGrid = $false; break }
    }
    if (-not $isWeekdayGrid) {
        $isWeekdayGrid = $true
        for ($i = 0; $i -lt 7; $i++) {
            if ($headerLetters[$i] -ne $weekdayLettersEn[$i]) { $isWeekdayGrid = $false; break }
        }
    }
    if (-not $isWeekdayGrid) {
        $skippedSheets.Add("$($ws.Name) (header after Merknader/Remarks = [$($headerLetters -join ',')], not M/T/O/T/F/L/S or Mo/Tu/We/Th/Fr/Sa/Su)") | Out-Null
        continue
    }

    # area/"Omrade" name for room-name disambiguation - search rows above header for a label cell
    # equal to "Område" and read the value one row below it in the same column region (K5/J6-style
    # merged cell pattern seen in every one of these files: header at row 5, value at row 6)
    $areaName = ""
    for ($r = 1; $r -lt $headerRow; $r++) {
        for ($c = 1; $c -le $cols; $c++) {
            $labelText = $ws.Cells.Item($startRow + $r - 1, $startCol + $c - 1).Text
            if ($labelText -eq $omradeLabel -or $labelText -eq "Area") {
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
        # Skip the sheet's own footer row ("Endringsdato ... 15.10.2017 ... Signatur ...") which
        # otherwise leaks in as a phantom task under whichever Lokale was last seen, since its date
        # value happens to land in the Inv/Objekt column.
        if ($invVal -match "^\d{1,2}\.\d{1,2}\.\d{2,4}$") { continue }

        $freqCount = $ws.Cells.Item($startRow + $r - 1, $startCol + $frekCol - 1).Text.Trim()
        $freqUnit = $ws.Cells.Item($startRow + $r - 1, $startCol + $frekCol + 2 - 1).Text.Trim()  # "/" is frekCol+1

        $weekdays = @()
        for ($i = 0; $i -lt 7; $i++) {
            $mark = $ws.Cells.Item($startRow + $r - 1, $startCol + $wdStart + $i - 1).Text.Trim()
            if ($mark -ne "") { $weekdays += $i }
        }

        if (-not $roomsBySheet.ContainsKey($currentLokale)) {
            $roomsBySheet[$currentLokale] = New-Object System.Collections.ArrayList
            $order.Add($currentLokale) | Out-Null
        }
        $flagVal = $ws.Cells.Item($startRow + $r - 1, $startCol + $flagCol - 1).Text.Trim()

        $roomsBySheet[$currentLokale].Add(@{ task = $invVal; freqCount = $freqCount; freqUnit = $freqUnit; weekdays = $weekdays; flag = $flagVal }) | Out-Null
    }

    if ($order.Count -eq 0) {
        # Header matched (Lokale/Inv-Objekt/Merknader/weekday-grid all found) but zero data rows
        # actually had both a Lokale and Inv/Objekt value - seen on a sheet whose real content
        # turned out to be prose paragraphs under free-text category headers instead of the usual
        # itemized rows (Sinkaberg's "Kontor 1 av 1"). Report it instead of silently contributing
        # nothing to either bucket, so a sheet shaped like this is never lost again.
        $skippedSheets.Add("$($ws.Name) (header matched but 0 data rows - Lokale/Inv-Objekt columns empty, check sheet manually)") | Out-Null
    }
    foreach ($lokale in $order) {
        $allRooms.Add(@{ sheet = $ws.Name; area = $areaName; lokale = $lokale; tasks = $roomsBySheet[$lokale] }) | Out-Null
    }
  } catch {
    # A per-sheet error (e.g. an unexpected column layout) must never silently drop the whole
    # sheet from both buckets — record it in skipped with the real error so it's investigable,
    # instead of the sheet just vanishing from the output with no trace.
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
        $wd = ($t.weekdays -join ",")
        [void]$sb.Append("{`"task`":`"$(Esc($t.task))`",`"freqCount`":`"$(Esc($t.freqCount))`",`"freqUnit`":`"$(Esc($t.freqUnit))`",`"weekdays`":[$wd],`"flag`":`"$(Esc($t.flag))`"}")
    }
    [void]$sb.Append("]}")
}
[void]$sb.Append("]}")
Write-Output $sb.ToString()
