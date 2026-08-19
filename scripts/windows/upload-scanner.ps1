# Windows Defender scan pass for Langlois-mode uploads.
# Meant to run every few minutes via a Windows Scheduled Task, same pattern
# as docker-watchdog.ps1 (C:\Users\Dell\docker-watchdog\) — deliberately
# lives outside the jellyfin-gate repo checkout for the same reason that
# script does: connected to a public GitHub PR, no business being committed
# there. This one has to live OUTSIDE Docker entirely for a different
# reason: Windows Defender cannot be invoked from inside a Linux container,
# so the scan has to happen from the host side, against the real host path
# behind the gate's MEDIA_QUARANTINE mount.
#
# What it does, once per run:
#   1. List every file directly inside the quarantine folder that doesn't
#      already have a "<file>.scan-result.json" marker next to it.
#   2. Run MpCmdRun.exe -Scan -ScanType 3 -File <path> against it.
#   3. Check Get-MpThreatDetection for anything matching that path, rather
#      than trusting MpCmdRun's own exit code/text output — that command's
#      exit code means "the scan ran," not "nothing was found," and its
#      console output is locale-dependent. The detection log is the
#      authoritative, English-cmdlet-stable source for "was this file
#      actually flagged."
#   4. Write the marker file the gate app's reconcileScanResults()
#      (src/lib/uploads.ts) reads back: {"status": "clean"|"infected",
#      "detail": "..."}.
#
# NOT YET DONE, and worth doing together before relying on this in
# production: a real test with an EICAR test file (the standard, harmless
# antivirus-test string every AV vendor recognises) to confirm the
# Get-MpThreatDetection matching logic below actually catches a real
# detection on this specific Windows/Defender version, rather than trusting
# it by inspection alone.

$ErrorActionPreference = "Stop"
$logPath = "C:\Users\Dell\docker-watchdog\upload-scanner.log"

# Must match docker-compose.yml's MEDIA_QUARANTINE_PATH default (or
# whatever it's actually set to in .env) — this is the real Windows path
# behind the gate/worker containers' /quarantine mount.
$quarantinePath = $env:JELLYFIN_GATE_QUARANTINE_PATH
if (-not $quarantinePath) {
    $quarantinePath = "C:\Users\Dell\Downloads\jellyfin-gate\media-quarantine"
}

$mpCmdRun = "${env:ProgramFiles}\Windows Defender\MpCmdRun.exe"
if (-not (Test-Path $mpCmdRun)) {
    # Newer Windows versions moved this under ProgramData with a version
    # subfolder that changes per update — resolve it dynamically rather
    # than hardcoding a path that will go stale.
    $found = Get-ChildItem "$env:ProgramData\Microsoft\Windows Defender\Platform" -Filter "MpCmdRun.exe" -Recurse -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | Select-Object -First 1
    if ($found) { $mpCmdRun = $found.FullName }
}

function Write-Log($msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
    Add-Content -Path $logPath -Value $line
}

Write-Log "check starting"

if (-not (Test-Path $mpCmdRun)) {
    Write-Log "MpCmdRun.exe not found — is Windows Defender installed/enabled? Checked: $mpCmdRun"
    exit 1
}

if (-not (Test-Path $quarantinePath)) {
    Write-Log "quarantine path does not exist yet, nothing to do: $quarantinePath"
    exit 0
}

$candidates = Get-ChildItem -Path $quarantinePath -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -ne ".json" -and -not (Test-Path "$($_.FullName).scan-result.json") }

if (-not $candidates -or $candidates.Count -eq 0) {
    Write-Log "nothing new to scan"
    exit 0
}

foreach ($file in $candidates) {
    Write-Log "scanning: $($file.Name)"
    $scanStarted = Get-Date

    try {
        & $mpCmdRun -Scan -ScanType 3 -File $file.FullName | Out-Null
    } catch {
        Write-Log "MpCmdRun invocation failed for $($file.Name): $_"
        continue
    }

    # Give Defender a moment to write the detection event before checking —
    # observed to occasionally lag a second or two behind MpCmdRun exiting.
    Start-Sleep -Seconds 2

    $threat = $null
    try {
        $threat = Get-MpThreatDetection -ErrorAction SilentlyContinue |
            Where-Object {
                $_.InitialDetectionTime -ge $scanStarted.AddSeconds(-5) -and
                ($_.Resources -join ";") -like "*$($file.Name)*"
            } |
            Select-Object -First 1
    } catch {
        Write-Log "Get-MpThreatDetection failed (Defender module unavailable?): $_"
    }

    $markerPath = "$($file.FullName).scan-result.json"
    # Written to a temp file then renamed — an atomic rename means the gate
    # app's reader (readScanMarker in src/lib/uploads.ts) never sees a
    # half-written marker, no matter when it happens to poll.
    $tempMarker = "$markerPath.tmp"

    if ($threat) {
        $detail = $threat.ThreatName
        Write-Log "INFECTED: $($file.Name) — $detail"
        @{ status = "infected"; detail = $detail } | ConvertTo-Json -Compress | Set-Content -Path $tempMarker -Encoding utf8
    } else {
        Write-Log "clean: $($file.Name)"
        @{ status = "clean"; detail = "No threats detected." } | ConvertTo-Json -Compress | Set-Content -Path $tempMarker -Encoding utf8
    }
    Move-Item -Path $tempMarker -Destination $markerPath -Force
}

Write-Log "check complete — $($candidates.Count) file(s) scanned"
