# Run from the server folder:  .\2-update-reminder-schema.ps1
# Adds pill-tracking fields to MedicationReminder and ReminderDose in prisma\schema.prisma (backup first).
$ErrorActionPreference = 'Stop'
$path = 'prisma\schema.prisma'
if (-not (Test-Path $path)) { throw "Cannot find $path - run this from the server folder." }

$raw = [IO.File]::ReadAllText($path)
if ($raw -match 'pillsRemaining') { Write-Host 'Pill fields are already in schema.prisma - nothing to do.'; exit 0 }

$crlf = $raw.Contains("`r`n")
$text = $raw -replace "`r`n", "`n"

# 1) MedicationReminder: after its deletedAt line
$rx1 = [regex]'(?m)^model MedicationReminder \{[\s\S]*?^([ \t]*)deletedAt[ \t]+DateTime\?[^\n]*$'
$f1 = $rx1.Matches($text)
if ($f1.Count -ne 1) { throw "Expected MedicationReminder once, found $($f1.Count). No changes made." }
$ind = $f1[0].Groups[1].Value
$add1 = "`n`n" + $ind + 'pillsRemaining  Int?      // estimated pills left (null = not tracked)' +
        "`n" + $ind + 'pillsPerDose    Int       @default(1)' +
        "`n" + $ind + 'refillAlertDays Int       @default(7)'
$text = $text.Insert($f1[0].Index + $f1[0].Length, $add1)

# 2) ReminderDose: after its snoozedUntil line
$rx2 = [regex]'(?m)^model ReminderDose \{[\s\S]*?^([ \t]*)snoozedUntil[ \t]+DateTime\?[^\n]*$'
$f2 = $rx2.Matches($text)
if ($f2.Count -ne 1) { throw "Expected ReminderDose once, found $($f2.Count). No changes made." }
$ind2 = $f2[0].Groups[1].Value
$add2 = "`n" + $ind2 + 'pillsDeducted Boolean            @default(false)'
$text = $text.Insert($f2[0].Index + $f2[0].Length, $add2)

# 3) Index for slot lookups
$rx3 = [regex]'(?m)^model ReminderDose \{[\s\S]*?^([ \t]*)@@index\(\[scheduledAt\]\)[^\n]*$'
$f3 = $rx3.Matches($text)
if ($f3.Count -ne 1) { throw "Expected the ReminderDose index once, found $($f3.Count). No changes made." }
$text = $text.Insert($f3[0].Index + $f3[0].Length, "`n" + $f3[0].Groups[1].Value + '@@index([reminderId, scheduledAt])')

if ($crlf) { $text = $text -replace "`n", "`r`n" }
Copy-Item $path "$path.bak-pills" -Force
[IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding $false))
Write-Host "Edited $path (backup: $path.bak-pills)"
