<#
.SYNOPSIS
    Installs rhwpp (HWP/HWPX word processor) on Windows with one command.

.DESCRIPTION
    Open PowerShell and run:

        irm https://github.com/woo202/rhwpp/releases/latest/download/install.ps1 | iex

    To pass options, run it as a script block:

        & ([scriptblock]::Create((irm https://github.com/woo202/rhwpp/releases/latest/download/install.ps1))) -AllUsers

    The script downloads the installer from the GitHub release, checks it against the
    release's SHA256SUMS.txt and runs it silently. No administrator rights are needed
    unless -AllUsers is given. Running it again updates rhwpp to the latest release.

    This file is kept ASCII-only: `irm` may decode it without a charset.

.PARAMETER AllUsers
    Install for every user of this PC into Program Files (asks for administrator rights).

.PARAMETER Version
    Install this release (for example 0.1.0) instead of the latest one.

.PARAMETER Launch
    Start rhwpp when the installation finishes.

.PARAMETER Force
    Reinstall even if the same version is already installed, and let the installer close
    a running rhwpp without asking (unsaved changes are lost).

.PARAMETER Uninstall
    Remove rhwpp. Documents and settings are kept.

.PARAMETER ReleaseUrl
    Download from this directory instead of the GitHub release (a mirror, or a local
    test server). It must contain SHA256SUMS.txt and the rhwpp_<version>_x64-setup.exe it lists.
#>
param(
    [switch]$AllUsers,
    [string]$Version,
    [switch]$Launch,
    [switch]$Force,
    [switch]$Uninstall,
    [string]$ReleaseUrl
)

# Run in a child scope so `irm | iex` does not leave helper functions or preference
# changes behind in the user's session.
& {
    $ErrorActionPreference = 'Stop'
    # Windows PowerShell 5.1 downloads very slowly while drawing a progress bar.
    $ProgressPreference = 'SilentlyContinue'

    $Repo = 'https://github.com/woo202/rhwpp'
    $AppName = 'rhwpp'
    $ExeName = 'rhwpp.exe'
    $UninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\rhwpp'
    $SetupPattern = '^rhwpp_([0-9A-Za-z.+-]+)_x64-setup\.exe$'

    function Write-Step([string]$Message) {
        Write-Host "==> $Message" -ForegroundColor Cyan
    }

    function Assert-Platform {
        if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
            throw "$AppName runs on Windows only."
        }
        $os = [Environment]::OSVersion.Version
        if ($os.Major -lt 10) {
            throw "$AppName needs Windows 10 or 11."
        }
        if (-not [Environment]::Is64BitOperatingSystem) {
            throw "$AppName needs 64-bit Windows. This PC runs 32-bit Windows."
        }
        $arm = ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') -or ($env:PROCESSOR_ARCHITEW6432 -eq 'ARM64')
        if ($arm -and $os.Build -lt 22000) {
            throw "$AppName is an x64 app. Windows 10 on ARM cannot run x64 apps; Windows 11 is needed."
        }
    }

    function Initialize-Network {
        # Windows PowerShell 5.1 may still default to TLS 1.0, which GitHub refuses.
        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        } catch { }
        # Let an authenticating corporate proxy see the signed-in user's credentials.
        try {
            $proxy = [Net.WebRequest]::DefaultWebProxy
            if ($proxy) { $proxy.Credentials = [Net.CredentialCache]::DefaultNetworkCredentials }
        } catch { }
    }

    function Get-StatusCode($ErrorRecord) {
        $response = $null
        try { $response = $ErrorRecord.Exception.Response } catch { }
        if ($response) {
            try { return [int]$response.StatusCode } catch { }
        }
        return 0
    }

    function Save-Url([string]$Url, [string]$OutFile) {
        for ($attempt = 1; ; $attempt++) {
            try {
                Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing -UserAgent 'rhwpp-install'
                return
            } catch {
                $status = Get-StatusCode $_
                if (($status -ge 400 -and $status -lt 500) -or $attempt -ge 3) { throw }
                Start-Sleep -Seconds (2 * $attempt)
            }
        }
    }

    function Read-Checksums([string]$Path) {
        $map = @{}
        foreach ($line in [IO.File]::ReadAllLines($Path)) {
            if ($line -match '^\s*([0-9A-Fa-f]{64})\s+\*?(\S.*?)\s*$') {
                $map[$Matches[2]] = $Matches[1].ToLowerInvariant()
            }
        }
        return $map
    }

    function Get-InstalledApp {
        $views = @(
            @{ Scope = 'CurrentUser'; Hive = [Microsoft.Win32.RegistryHive]::CurrentUser; View = [Microsoft.Win32.RegistryView]::Default },
            @{ Scope = 'AllUsers'; Hive = [Microsoft.Win32.RegistryHive]::LocalMachine; View = [Microsoft.Win32.RegistryView]::Registry64 },
            @{ Scope = 'AllUsers'; Hive = [Microsoft.Win32.RegistryHive]::LocalMachine; View = [Microsoft.Win32.RegistryView]::Registry32 }
        )
        $found = @()
        foreach ($view in $views) {
            $base = $null
            $key = $null
            try {
                $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($view.Hive, $view.View)
                $key = $base.OpenSubKey($UninstallKey)
                if (-not $key) { continue }
                $uninstaller = ([string]$key.GetValue('UninstallString')).Trim().Trim('"')
                if (-not $uninstaller) { continue }
                if ($found | Where-Object { $_.Uninstaller -eq $uninstaller }) { continue }
                $location = ([string]$key.GetValue('InstallLocation')).Trim().Trim('"')
                if (-not $location) { $location = Split-Path -Parent $uninstaller }
                $found += [pscustomobject]@{
                    Scope       = $view.Scope
                    Version     = [string]$key.GetValue('DisplayVersion')
                    Location    = $location
                    Uninstaller = $uninstaller
                }
            } finally {
                if ($key) { $key.Close() }
                if ($base) { $base.Close() }
            }
        }
        return $found
    }

    # The installer closes a running rhwpp by force, so give the user a chance to save first.
    function Wait-AppClosed {
        while ($true) {
            $running = @(Get-Process -Name $AppName -ErrorAction SilentlyContinue)
            if ($running.Count -eq 0 -or $Force) { return }
            Write-Host "$AppName is running. Save your documents and close every $AppName window." -ForegroundColor Yellow
            try {
                $answer = Read-Host "Press Enter when done, type F to close $AppName now (unsaved changes are lost), or Q to cancel"
            } catch {
                throw "$AppName is running. Close it and try again, or add -Force to close it without saving."
            }
            if ($answer -match '^\s*q') { throw 'Cancelled.' }
            if ($answer -match '^\s*f') { return }
        }
    }

    # Runs an NSIS installer or uninstaller and returns its exit code.
    function Invoke-Setup([string]$Path, [string[]]$Arguments, [bool]$Elevate) {
        $savedCompat = $env:__COMPAT_LAYER
        $start = @{ FilePath = $Path; ArgumentList = $Arguments; Wait = $true; PassThru = $true }
        if ($Elevate) {
            $start.Verb = 'RunAs'
        } else {
            # The installer asks for the highest available rights so it can offer an
            # all-users install. A per-user install does not need them: skip the UAC prompt.
            $env:__COMPAT_LAYER = 'RunAsInvoker'
        }
        try {
            $process = Start-Process @start
        } catch {
            if ($Elevate) { throw 'Administrator permission was not granted.' }
            throw "Could not start $(Split-Path -Leaf $Path): $($_.Exception.Message)"
        } finally {
            $env:__COMPAT_LAYER = $savedCompat
        }
        return $process.ExitCode
    }

    function Assert-SetupExitCode([int]$Code, [string]$What) {
        switch ($Code) {
            0 { return }
            1 { throw "The $What was cancelled." }
            2 { throw "The $What stopped (exit code 2). $AppName may still be running, or administrator permission was refused." }
            default { throw "The $What failed (exit code $Code)." }
        }
    }

    function Start-App([string]$Location) {
        $exe = Join-Path $Location $ExeName
        if (Test-Path -LiteralPath $exe) { Start-Process -FilePath $exe }
    }

    function Install-App {
        $requested = ([string]$Version).Trim()
        if ($requested.StartsWith('v')) { $requested = $requested.Substring(1) }
        if ($requested -and $requested -notmatch '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$') {
            throw "'$Version' is not a version number like 0.1.0."
        }

        if ($ReleaseUrl) {
            $sumsUrl = $ReleaseUrl.TrimEnd('/') + '/SHA256SUMS.txt'
        } elseif ($requested) {
            $sumsUrl = "$Repo/releases/download/v$requested/SHA256SUMS.txt"
        } else {
            $sumsUrl = "$Repo/releases/latest/download/SHA256SUMS.txt"
        }

        $work = Join-Path ([IO.Path]::GetTempPath()) ('rhwpp-install-' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $work | Out-Null
        try {
            Write-Step 'Looking up the release...'
            $sumsFile = Join-Path $work 'SHA256SUMS.txt'
            try {
                Save-Url $sumsUrl $sumsFile
            } catch {
                if ((Get-StatusCode $_) -eq 404) {
                    if ($ReleaseUrl) { throw "SHA256SUMS.txt was not found at $ReleaseUrl." }
                    if ($requested) { throw "Release v$requested was not found. See $Repo/releases" }
                    throw "No $AppName release has been published yet. See $Repo/releases"
                }
                throw "Could not reach the download server: $($_.Exception.Message)"
            }

            $sums = Read-Checksums $sumsFile
            $setupName = $null
            $target = $null
            foreach ($name in $sums.Keys) {
                if ($name -match $SetupPattern) {
                    $setupName = $name
                    $target = $Matches[1]
                }
            }
            if (-not $setupName) { throw 'The release does not list an x64 installer in SHA256SUMS.txt.' }
            if ($requested -and $target -ne $requested) {
                throw "The release lists version $target, not $requested."
            }

            $installed = @(Get-InstalledApp)
            $machine = @($installed | Where-Object { $_.Scope -eq 'AllUsers' })
            $user = @($installed | Where-Object { $_.Scope -eq 'CurrentUser' })
            $scope = 'CurrentUser'
            if ($AllUsers) {
                $scope = 'AllUsers'
            } elseif ($machine.Count -gt 0 -and $user.Count -eq 0) {
                Write-Host "$AppName is installed for all users; updating that installation (administrator permission needed)."
                $scope = 'AllUsers'
            }
            $existing = @($installed | Where-Object { $_.Scope -eq $scope }) | Select-Object -First 1
            if ($existing -and $existing.Version -eq $target -and -not $Force) {
                Write-Host "$AppName $target is already installed in $($existing.Location). Add -Force to reinstall." -ForegroundColor Green
                if ($Launch) { Start-App $existing.Location }
                return
            }

            Wait-AppClosed

            # Download the installer from the same release as the checksums.
            if ($ReleaseUrl) {
                $setupUrl = $ReleaseUrl.TrimEnd('/') + "/$setupName"
            } else {
                $setupUrl = "$Repo/releases/download/v$target/$setupName"
            }
            Write-Step "Downloading $AppName $target..."
            $setupFile = Join-Path $work $setupName
            try {
                Save-Url $setupUrl $setupFile
            } catch {
                throw "Could not download ${setupUrl}: $($_.Exception.Message)"
            }

            Write-Step 'Checking the SHA-256 checksum...'
            $actual = (Get-FileHash -LiteralPath $setupFile -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($actual -ne $sums[$setupName]) {
                throw "The downloaded installer is damaged or was altered (SHA-256 $actual, expected $($sums[$setupName])). Nothing was installed."
            }

            if ($scope -eq 'AllUsers') {
                Write-Step 'Installing for all users (administrator permission needed)...'
                $arguments = @('/S', '/AllUsers')
            } else {
                Write-Step 'Installing for the current user...'
                $arguments = @('/S', '/CurrentUser')
            }
            $code = Invoke-Setup $setupFile $arguments ($scope -eq 'AllUsers')
            Assert-SetupExitCode $code 'installation'

            $result = @(Get-InstalledApp | Where-Object { $_.Scope -eq $scope }) | Select-Object -First 1
            if (-not $result -or $result.Version -ne $target -or -not (Test-Path -LiteralPath (Join-Path $result.Location $ExeName))) {
                throw "The installer finished, but $AppName $target was not found afterwards."
            }

            Write-Host ''
            Write-Host "$AppName $target is installed in $($result.Location)." -ForegroundColor Green
            Write-Host 'Start it from the Start menu or the desktop shortcut, or double-click an HWP/HWPX file.'
            if ($Launch) { Start-App $result.Location }
        } finally {
            Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    function Uninstall-App {
        $installed = @(Get-InstalledApp)
        if ($installed.Count -eq 0) {
            Write-Host "$AppName is not installed." -ForegroundColor Green
            return
        }
        Wait-AppClosed
        foreach ($item in $installed) {
            if (-not (Test-Path -LiteralPath $item.Uninstaller)) {
                throw "The uninstaller is missing: $($item.Uninstaller). Remove $AppName from Settings > Apps."
            }
            Write-Step "Removing $AppName $($item.Version) ($($item.Location))..."
            $code = Invoke-Setup $item.Uninstaller @('/S') ($item.Scope -eq 'AllUsers')
            Assert-SetupExitCode $code 'uninstallation'
            # An NSIS uninstaller copies itself to %TEMP% and exits at once; the copy does
            # the work. Wait until it has removed the registration.
            $deadline = (Get-Date).AddMinutes(2)
            while (@(Get-InstalledApp | Where-Object { $_.Uninstaller -eq $item.Uninstaller }).Count -gt 0) {
                if ((Get-Date) -gt $deadline) { throw "The uninstaller did not finish. Remove $AppName from Settings > Apps." }
                Start-Sleep -Milliseconds 500
            }
        }
        Write-Host ''
        Write-Host "$AppName has been removed. Your documents and settings were kept." -ForegroundColor Green
    }

    try {
        Assert-Platform
        Initialize-Network
        if ($Uninstall) { Uninstall-App } else { Install-App }
    } catch {
        Write-Host ''
        Write-Host "$AppName setup failed: $($_.Exception.Message)" -ForegroundColor Red
        # Exit with an error code when run as a file; never close the window of `irm | iex`.
        if ($PSCommandPath) { exit 1 }
    }
}
