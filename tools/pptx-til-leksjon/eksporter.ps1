# Exports a .pptx into the pieces a Rentlogg lesson is made of: one image per slide, plus the
# raw narration text for each (speaker notes if the slide has any, otherwise the slide's own text).
#
# Uses the PowerPoint that is already installed on this machine through COM - the same approach
# parse_renholdsplan.ps1 takes to Excel. That is deliberate: it renders the slides exactly as
# PowerPoint does, with the real fonts, layout and images, and it needs nothing installed on the
# server (Render has neither PowerPoint nor LibreOffice).
#
# Output:
#   <OutDir>/bilder/slide-01.png ...
#   <OutDir>/manus.json          { title, slides: [ { index, image, title, body, notes, raw } ] }
#
# Read manus.json before going on to manus.js - the "raw" field is what the model will be asked
# to turn into spoken narration, and a slide whose text came out empty needs a human to say what
# it is actually about.
param(
    [Parameter(Mandatory=$true)][string]$Path,
    [string]$OutDir = "leksjon",
    [int]$Width = 1600,
    [int]$Height = 900
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $Path)) {
    Write-Error "Fant ikke filen: $Path"
    exit 1
}

$Path = (Resolve-Path -LiteralPath $Path).Path
$imageDir = Join-Path $OutDir "bilder"
New-Item -ItemType Directory -Force -Path $imageDir | Out-Null
$imageDir = (Resolve-Path -LiteralPath $imageDir).Path

# ppPlaceholderBody - the notes placeholder on a notes page, as opposed to the slide-number and
# slide-image placeholders that sit on the same page and would otherwise be read as narration.
$ppPlaceholderBody = 2
$msoTrue = -1

$ppt = New-Object -ComObject PowerPoint.Application
# PowerPoint cannot be made fully invisible the way Excel can (setting Visible = $false throws).
# Opening the presentation WithWindow = $false is the supported way to keep it off screen.
try {
    $pres = $ppt.Presentations.Open($Path, $true, $false, $false)
} catch {
    $ppt.Quit()
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($ppt) | Out-Null
    throw
}

function Get-ShapeText($shape) {
    try {
        if ($shape.HasTextFrame -ne $msoTrue) { return "" }
        if ($shape.TextFrame.HasText -ne $msoTrue) { return "" }
        return $shape.TextFrame.TextRange.Text
    } catch {
        return ""
    }
}

$slides = New-Object System.Collections.ArrayList

try {
    for ($i = 1; $i -le $pres.Slides.Count; $i++) {
        $slide = $pres.Slides.Item($i)
        $name = "slide-{0:d2}.png" -f $i
        $imagePath = Join-Path $imageDir $name
        $slide.Export($imagePath, "PNG", $Width, $Height)

        # The first title-ish shape becomes the slide title; everything else is body text. Both are
        # kept separately so manus.js can tell a heading from the points under it.
        $title = ""
        $bodyParts = New-Object System.Collections.ArrayList
        foreach ($shape in $slide.Shapes) {
            $text = (Get-ShapeText $shape).Trim()
            if ($text -eq "") { continue }
            $isTitle = $false
            try {
                # ppPlaceholderTitle = 1, ppPlaceholderCenterTitle = 3
                if ($shape.Type -eq 14 -and ($shape.PlaceholderFormat.Type -eq 1 -or $shape.PlaceholderFormat.Type -eq 3)) {
                    $isTitle = $true
                }
            } catch { }
            if ($isTitle -and $title -eq "") { $title = $text } else { [void]$bodyParts.Add($text) }
        }

        $notes = ""
        try {
            foreach ($shape in $slide.NotesPage.Shapes) {
                try {
                    if ($shape.PlaceholderFormat.Type -ne $ppPlaceholderBody) { continue }
                } catch { continue }
                $text = (Get-ShapeText $shape).Trim()
                if ($text -ne "") { $notes = $text }
            }
        } catch { }

        $body = ($bodyParts -join "`n").Trim()
        # What the narration is built from: the speaker notes when the deck has them (that is
        # someone having already written out what to say), otherwise whatever is on the slide.
        $raw = if ($notes -ne "") { $notes } else { (($title + "`n" + $body)).Trim() }

        [void]$slides.Add([pscustomobject]@{
            index = $i
            image = "bilder/$name"
            title = $title
            body  = $body
            notes = $notes
            raw   = $raw
        })

        if ($raw -eq "") {
            Write-Warning "Lysbilde $i har ingen tekst i det hele tatt - skriv manus for det for hand i manus.json."
        }
    }

    $result = [pscustomobject]@{
        title  = [System.IO.Path]::GetFileNameWithoutExtension($Path)
        source = $Path
        slides = $slides
    }
    $jsonPath = Join-Path $OutDir "manus.json"
    # WriteAllText with a BOM-less encoder, not Out-File -Encoding utf8: Windows PowerShell 5.1's
    # utf8 writes a byte-order mark, and JSON.parse in the next step rejects the file outright
    # ("Unexpected token"). ConvertTo-Json escapes non-ASCII as \uXXXX anyway, so the bytes here
    # are plain ASCII either way - the BOM is the whole problem.
    $json = $result | ConvertTo-Json -Depth 6
    [System.IO.File]::WriteAllText($jsonPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "Eksporterte $($slides.Count) lysbilder til $imageDir"
    Write-Host "Manus: $jsonPath"
} finally {
    $pres.Close()
    $ppt.Quit()
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($ppt) | Out-Null
}
