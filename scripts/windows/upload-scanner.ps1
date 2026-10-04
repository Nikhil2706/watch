# Plain hyphens only, deliberately - no em dashes anywhere in this file.
# Windows PowerShell 5.1 (not pwsh 7+) mis-tokenizes a double-quoted string
# that mixes a multi-byte UTF-8 character with a $(...) subexpression: it
# loses brace-nesting sync from that string onward and throws "Missing
# closing '}'" errors pointing at completely unrelated later lines. This
# is exactly what silently broke this script for its first five minutes of
# actually running as a Scheduled Task (2026-08-21) - proven by feeding
# both versions to [System.Management.Automation.Language.Parser]::ParseFile
# directly. Keep it ASCII-only.
#
# Windows Defender scan pass for Langlois-mode uploads.
# Meant to run every few minutes via a Windows Scheduled Task. It has to
# live OUTSIDE Docker entirely: Windows Defender cannot be invoked from
# inside a Linux container, so the scan has to happen from the host side,
# against the real host path behind the gate's MEDIA_QUARANTINE mount.
#
# What it does, once per run:
#   1. Write a heartbeat file into the quarantine folder, so the site's
#      Health tab can tell "nothing to scan" from "never set up here".
#   2. List every file directly inside the quarantine folder that doesn't
#      already have a "<file>.scan-result.json" marker next to it.
#   3. Run MpCmdRun.exe -Scan -ScanType 3 -File <path> against it.
#   4. Check Get-MpThreatDetection for anything matching that path. The
#      detection log is the authoritative, English-cmdlet-stable source
#      for "was this file actually flagged"; MpCmdRun's console output is
#      locale-dependent.
#   5. Write the marker file the gate app's reconcileScanResults()
#      (src/lib/uploads.ts) reads back: {"status": "clean"|"infected",
#      "detail": "..."} - but "clean" only when MpCmdRun itself exited 0.
#
# Three things changed on 2026-10-04, when this was found never to have been
# set up on the PC the site moved to:
#   - Nothing is hard-coded to one machine any more. The log sits beside
#     this script, and the quarantine folder comes from
#     JELLYFIN_GATE_QUARANTINE_PATH (see README.md for this PC's value).
#     With no folder to scan it says so and exits 1, instead of quietly
#     reporting that there was nothing to do.
#   - A scan that did not run is no longer "clean". MpCmdRun exits 2 both
#     for "threat found" and for "could not scan" (file locked, path it
#     cannot reach), and a native command's exit code never throws. With
#     no detection on record that was written up as clean. Now a non-zero
#     exit with no detection leaves the file unmarked, to be tried again.
#   - Markers are written without a byte-order mark. Set-Content -Encoding
#     utf8 puts one in front in Windows PowerShell 5.1, the site's
#     JSON.parse rejected it, and every verdict read as "not scanned yet".
#
# NOT YET DONE, and worth doing before relying on this: a real test with an
# EICAR test file (the standard, harmless antivirus-test string every AV
# vendor recognises) to confirm the Get-MpThreatDetection matching below
# catches a real detection on this Windows/Defender version.

$ErrorActionPreference = "Stop"
$logPath = Join-Path $PSScriptRoot "upload-scanner.log"

function Write-Log($msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
    Add-Content -Path $logPath -Value $line
}

# UTF-8 with no byte-order mark, via a temp file and a rename so the site
# never reads a half-written file.
function Write-JsonFile($path, $value) {
    $temp = "$path.tmp"
    $json = $value | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($temp, $json, (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -Path $temp -Destination $path -Force
}

# The real Windows path behind the gate container's /quarantine mount.
$quarantinePath = $env:JELLYFIN_GATE_QUARANTINE_PATH
if (-not $quarantinePath) {
    Write-Log "JELLYFIN_GATE_QUARANTINE_PATH is not set - see scripts\windows\README.md"
    exit 1
}
if (-not (Test-Path $quarantinePath)) {
    Write-Log "quarantine folder not found: $quarantinePath"
    exit 1
}

$mpCmdRun = "${env:ProgramFiles}\Windows Defender\MpCmdRun.exe"
if (-not (Test-Path $mpCmdRun)) {
    # Newer Windows versions moved this under ProgramData with a version
    # subfolder that changes per update - resolve it dynamically rather
    # than hardcoding a path that will go stale.
    $found = Get-ChildItem "$env:ProgramData\Microsoft\Windows Defender\Platform" -Filter "MpCmdRun.exe" -Recurse -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | Select-Object -First 1
    if ($found) { $mpCmdRun = $found.FullName }
}
if (-not (Test-Path $mpCmdRun)) {
    Write-Log "MpCmdRun.exe not found - is Windows Defender installed/enabled? Checked: $mpCmdRun"
    exit 1
}

# Only once everything a scan needs is in place: a heartbeat from a scanner
# that cannot scan would be the same false comfort the old "clean" was.
Write-JsonFile (Join-Path $quarantinePath ".scanner-heartbeat.json") @{ ranAt = (Get-Date).ToUniversalTime().ToString("o") }

$candidates = @(Get-ChildItem -Path $quarantinePath -File -ErrorAction SilentlyContinue |
    Where-Object {
        $_.Extension -ne ".json" -and $_.Extension -ne ".tmp" -and
        -not $_.Name.StartsWith(".") -and
        -not (Test-Path "$($_.FullName).scan-result.json")
    })

if ($candidates.Count -eq 0) {
    exit 0
}

$scanned = 0
foreach ($file in $candidates) {
    Write-Log "scanning: $($file.Name)"
    $scanStarted = Get-Date

    $exitCode = $null
    try {
        & $mpCmdRun -Scan -ScanType 3 -File $file.FullName | Out-Null
        $exitCode = $LASTEXITCODE
    } catch {
        Write-Log "MpCmdRun invocation failed for $($file.Name): $_"
        continue
    }

    # Give Defender a moment to write the detection event before checking -
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

    if ($threat) {
        $detail = "$($threat.ThreatName)"
        if (-not $detail) { $detail = "Threat id $($threat.ThreatID)" }
        Write-Log "INFECTED: $($file.Name) - $detail"
        Write-JsonFile $markerPath @{ status = "infected"; detail = $detail }
        $scanned += 1
    } elseif ($exitCode -eq 0) {
        Write-Log "clean: $($file.Name)"
        Write-JsonFile $markerPath @{ status = "clean"; detail = "No threats detected." }
        $scanned += 1
    } else {
        # Not a verdict. Left unmarked so the next run tries again, and so
        # the upload cannot be approved on the strength of a scan that
        # never happened.
        Write-Log "NOT SCANNED: $($file.Name) - MpCmdRun exited $exitCode with no detection on record"
    }
}

Write-Log "check complete - $scanned of $($candidates.Count) file(s) given a verdict"
