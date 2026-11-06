# Run from the server folder:  .\1-update-schema.ps1
# Adds the WaterLog model to prisma\schema.prisma (backup is made first).
$ErrorActionPreference = 'Stop'
$path = 'prisma\schema.prisma'
if (-not (Test-Path $path)) { throw "Cannot find $path - run this from the server folder." }

$raw = [IO.File]::ReadAllText($path)
if ($raw -match 'model WaterLog') { Write-Host 'WaterLog is already in schema.prisma - nothing to do.'; exit 0 }

$crlf = $raw.Contains("`r`n")
$text = $raw -replace "`r`n", "`n"

$rx = [regex]'(?m)^model DietProfile \{[\s\S]*?^([ \t]*)foodLogs([ \t]+)FoodLog\[\][^\n]*$'
$found = $rx.Matches($text)
if ($found.Count -ne 1) { throw "Expected to find the DietProfile model once, found $($found.Count). No changes made." }
$m = $found[0]

$pad = [Math]::Max($m.Groups[2].Value.Length - 1, 1)
$insert = "`n" + $m.Groups[1].Value + 'waterLogs' + (' ' * $pad) + 'WaterLog[]'
$text = $text.Insert($m.Index + $m.Length, $insert)

$model = @'

// Water the patient has logged (one row per drink)
model WaterLog {
  id            String      @id @default(cuid())
  dietProfileId String
  dietProfile   DietProfile @relation(fields: [dietProfileId], references: [id], onDelete: Cascade)
  amountMl      Int
  date          String      // YYYY-MM-DD, the patient's local day
  loggedAt      DateTime    @default(now())

  @@index([dietProfileId, date])
}
'@
$text = $text.TrimEnd("`n") + "`n" + ($model -replace "`r`n", "`n")

if ($crlf) { $text = $text -replace "`n", "`r`n" }
Copy-Item $path "$path.bak-water" -Force
[IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding $false))
Write-Host "Edited $path (backup: $path.bak-water)"
