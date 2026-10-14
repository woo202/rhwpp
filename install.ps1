<#
.SYNOPSIS
    Installs rhwpp (HWP/HWPX word processor) on Windows with one command.

.DESCRIPTION
    Open PowerShell and run:

        [Net.ServicePointManager]::SecurityProtocol = 'Tls12'; irm https://github.com/woo202/rhwpp/releases/latest/download/install.ps1 | iex

    (The first statement lets older Windows PowerShell 5.1 setups reach GitHub at all.)
    To pass options, run it as a script block:

        [Net.ServicePointManager]::SecurityProtocol = 'Tls12'; & ([scriptblock]::Create((irm https://github.com/woo202/rhwpp/releases/latest/download/install.ps1))) -AllUsers

    The script downloads the installer from the GitHub release, checks it against the
    release's SHA256SUMS.txt and runs it silently. A new install goes to
    %LOCALAPPDATA%\Programs\rhwpp and needs no administrator rights; -AllUsers, or
    updating an existing all-users install, asks for them. Running it again updates
    rhwpp to the latest release.

    This file is kept ASCII-only: `irm` may decode it without a charset.

.PARAMETER AllUsers
    Install for every user of this PC into Program Files (asks for administrator rights).
    An existing per-user install is removed afterwards so only one copy remains.

.PARAMETER Version
    Install this release (for example 0.1.0) instead of the latest one.

.PARAMETER Launch
    Start rhwpp when the installation finishes.

.PARAMETER Force
    Reinstall even if the same or a newer version is installed, and let the installer
    close a running rhwpp without asking (unsaved changes are lost).

.PARAMETER Uninstall
    Remove rhwpp, including a copy installed from the MSI package. Documents and
    settings are kept.

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
# changes behind in the user's session (the parameters above do become variables there).
& {
    $ErrorActionPreference = 'Stop'
    # Windows PowerShell 5.1 downloads very slowly while drawing a progress bar.
    $ProgressPreference = 'SilentlyContinue'

    $Repo = 'https://github.com/woo202/rhwpp'
    $AppName = 'rhwpp'
    $ExeName = 'rhwpp.exe'
    $UninstallRoot = 'Software\Microsoft\Windows\CurrentVersion\Uninstall'
    $UninstallKey = "$UninstallRoot\rhwpp"
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

    # True when this PowerShell runs with an elevated (administrator) token.
    function Test-Elevated {
        try {
            $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
            return ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        } catch {
            return $false
        }
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

    # Splits x.y.z[-pre] into a comparable list, or returns $null.
    function Get-VersionKey([string]$Text) {
        if ($Text -notmatch '^\s*v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z.-]+))?') { return $null }
        return @([int]$Matches[1], [int]$Matches[2], [int]$Matches[3], [string]$Matches[4])
    }

    # Compares two pre-release tags by the semver rules: dot-separated identifiers, numeric
    # ones by value and below alphanumeric ones, a longer list above its prefix.
    function Compare-PreRelease([string]$A, [string]$B) {
        $x = $A.Split('.')
        $y = $B.Split('.')
        for ($i = 0; $i -lt [Math]::Min($x.Count, $y.Count); $i++) {
            $xNumeric = $x[$i] -match '^\d+$'
            $yNumeric = $y[$i] -match '^\d+$'
            if ($xNumeric -and $yNumeric) {
                # Numeric identifiers have no leading zeros, so length decides first.
                $c = $x[$i].Length.CompareTo($y[$i].Length)
                if ($c -eq 0) { $c = [Math]::Sign([string]::CompareOrdinal($x[$i], $y[$i])) }
            } elseif ($xNumeric) {
                $c = -1
            } elseif ($yNumeric) {
                $c = 1
            } else {
                $c = [Math]::Sign([string]::CompareOrdinal($x[$i], $y[$i]))
            }
            if ($c -ne 0) { return $c }
        }
        return $x.Count.CompareTo($y.Count)
    }

    # True only when both versions parse and $Installed is newer than $Target.
    function Test-NewerVersion([string]$Installed, [string]$Target) {
        $a = Get-VersionKey $Installed
        $b = Get-VersionKey $Target
        if ($null -eq $a -or $null -eq $b) { return $false }
        for ($i = 0; $i -lt 3; $i++) {
            if ($a[$i] -ne $b[$i]) { return ($a[$i] -gt $b[$i]) }
        }
        if ($a[3] -eq $b[3]) { return $false }
        if (-not $a[3]) { return $true }    # 1.0.0 is newer than 1.0.0-beta
        if (-not $b[3]) { return $false }
        return ((Compare-PreRelease $a[3] $b[3]) -gt 0)
    }

    # Installs made by the NSIS installer (this script, or setup.exe run by hand).
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

    # Installs made from the MSI package, which registers under its product code.
    function Get-MsiInstall {
        $found = @()
        foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
            $base = $null
            $root = $null
            try {
                $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, $view)
                $root = $base.OpenSubKey($UninstallRoot)
                if (-not $root) { continue }
                foreach ($name in $root.GetSubKeyNames()) {
                    if ($name -notmatch '^\{[0-9A-Fa-f-]{36}\}$') { continue }
                    $key = $root.OpenSubKey($name)
                    if (-not $key) { continue }
                    try {
                        $isApp = ([string]$key.GetValue('DisplayName') -eq $AppName) -and
                            ([string]$key.GetValue('Publisher') -eq $AppName) -and
                            ([string]$key.GetValue('UninstallString') -match 'msiexec')
                        if ($isApp -and -not ($found | Where-Object { $_.ProductCode -eq $name })) {
                            $found += [pscustomobject]@{
                                ProductCode = $name
                                Version     = [string]$key.GetValue('DisplayVersion')
                                Location    = ([string]$key.GetValue('InstallLocation')).Trim().Trim('"')
                            }
                        }
                    } finally {
                        $key.Close()
                    }
                }
            } finally {
                if ($root) { $root.Close() }
                if ($base) { $base.Close() }
            }
        }
        return $found
    }

    # rhwpp processes in this logon session that run from one of the given install folders.
    # The installer only closes the copy it replaces, so other copies do not matter. A path
    # that cannot be read (32-bit PowerShell, elevated rhwpp) counts as a match to be safe.
    function Get-RunningApp([string[]]$Locations) {
        $exes = @($Locations | Where-Object { $_ } | ForEach-Object { Join-Path $_ $ExeName })
        if ($exes.Count -eq 0) { return @() }
        $session = [Diagnostics.Process]::GetCurrentProcess().SessionId
        return @(Get-Process -Name $AppName -ErrorAction SilentlyContinue | Where-Object {
            $path = $null
            try { $path = $_.Path } catch { }
            ($_.SessionId -eq $session) -and ((-not $path) -or ($exes -contains $path))
        })
    }

    # rhwpp installs a downloaded update when it is closed (as rhwpp-update-setup.exe). If the
    # user has just closed it, let that installer finish so two installers never overlap.
    function Wait-PendingUpdate {
        $deadline = (Get-Date).AddMinutes(2)
        $announced = $false
        while (@(Get-Process -Name 'rhwpp-update-setup' -ErrorAction SilentlyContinue).Count -gt 0) {
            if (-not $announced) {
                Write-Step "Waiting for $AppName's own update to finish..."
                $announced = $true
            }
            if ((Get-Date) -gt $deadline) { throw "$AppName's own update is still running. Try again in a minute." }
            Start-Sleep -Milliseconds 500
        }
    }

    # The installer closes a running rhwpp by force, so give the user a chance to save first.
    function Wait-AppClosed([string[]]$Locations) {
        Wait-AskAppClosed $Locations
        Wait-PendingUpdate
    }

    function Wait-AskAppClosed([string[]]$Locations) {
        while ($true) {
            $running = @(Get-RunningApp $Locations)
            if ($running.Count -eq 0 -or $Force) { return }
            Write-Host "$AppName is running. Save your documents and close every $AppName window." -ForegroundColor Yellow
            $answer = $null
            try {
                $answer = Read-Host "Press Enter when done, type F to close $AppName now (unsaved changes are lost), or Q to cancel"
            } catch { }
            # Read-Host throws in a non-interactive host and returns $null when input is redirected.
            if ($null -eq $answer) {
                throw "$AppName is running. Close it and try again, or add -Force to close it without saving."
            }
            if ($answer -match '^\s*q') { throw 'Cancelled.' }
            if ($answer -match '^\s*f') { return }
        }
    }

    # Runs an installer or uninstaller and returns its exit code.
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

    function Remove-Installation($Item) {
        if (-not (Test-Path -LiteralPath $Item.Uninstaller)) {
            throw "The uninstaller is missing: $($Item.Uninstaller). Remove $AppName from Settings > Apps."
        }
        Write-Step "Removing $AppName $($Item.Version) from $($Item.Location)..."
        $code = Invoke-Setup $Item.Uninstaller @('/S') ($Item.Scope -eq 'AllUsers')
        Assert-SetupExitCode $code 'uninstallation'
        # An NSIS uninstaller copies itself to %TEMP% and exits at once; the copy does
        # the work. Wait until it has removed the registration.
        $deadline = (Get-Date).AddMinutes(2)
        while (@(Get-InstalledApp | Where-Object { $_.Uninstaller -eq $Item.Uninstaller }).Count -gt 0) {
            if ((Get-Date) -gt $deadline) { throw "The uninstaller did not finish. Remove $AppName from Settings > Apps." }
            Start-Sleep -Milliseconds 500
        }
        if ($Item.Scope -eq 'CurrentUser') { Clear-UserFileTypes }
    }

    function Remove-UserCopy($Item) {
        Write-Host "Removing the per-user installation so only the all-users copy remains."
        Remove-Installation $Item
    }

    # The NSIS uninstaller puts back the file type .hwp/.hwpx/.hml had before it was
    # installed: an empty string when there was none, or rhwpp's own (now deleted) type
    # after an update or reinstall. Either per-user value hides the association of an
    # all-users install (rhwpp's or another HWP program's), so remove such leftovers.
    function Clear-UserFileTypes {
        foreach ($ext in @('hwp', 'hwpx', 'hml')) {
            $path = "Software\Classes\.$ext"
            $empty = $false
            $key = $null
            try {
                $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($path, $true)
                if (-not $key) { continue }
                $key.DeleteValue("rhwpp.${ext}_backup", $false)
                $default = $key.GetValue('')
                if ($null -ne $default -and ([string]$default -eq '' -or [string]$default -eq "rhwpp.$ext")) {
                    $key.DeleteValue('', $false)
                }
                $empty = ($key.ValueCount -eq 0 -and $key.SubKeyCount -eq 0)
            } catch {
                continue
            } finally {
                if ($key) { $key.Close() }
            }
            if ($empty) {
                try { [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey($path, $false) } catch { }
            }
        }
    }

    # A per-user copy removed earlier from Settings > Apps leaves the same values behind.
    function Clear-OrphanedUserFileTypes {
        if (@(Get-InstalledApp | Where-Object { $_.Scope -eq 'CurrentUser' }).Count -eq 0) { Clear-UserFileTypes }
    }

    function Remove-MsiInstallation($Item) {
        Write-Step "Removing $AppName $($Item.Version) installed from the MSI package (administrator permission needed)..."
        $msiexec = Join-Path $env:SystemRoot 'System32\msiexec.exe'
        $code = Invoke-Setup $msiexec @('/x', $Item.ProductCode, '/qn', '/norestart') $true
        # 3010: removed, restart required. 1605: already gone.
        if ($code -eq 0 -or $code -eq 3010 -or $code -eq 1605) { return }
        if ($code -eq 1602) { throw 'The uninstallation was cancelled.' }
        throw "Removing the MSI package failed (msiexec exit code $code)."
    }

    function Start-App([string]$Location) {
        $exe = Join-Path $Location $ExeName
        if (-not (Test-Path -LiteralPath $exe)) { return }
        if (Test-Elevated) {
            # Do not run a document editor as administrator: let Explorer start it normally.
            Start-Process -FilePath (Join-Path $env:SystemRoot 'explorer.exe') -ArgumentList ('"' + $exe + '"')
        } else {
            Start-Process -FilePath $exe
        }
    }

    function Install-App {
        $requested = ([string]$Version).Trim()
        if ($requested.StartsWith('v')) { $requested = $requested.Substring(1) }
        if ($requested -and $requested -notmatch '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$') {
            throw "'$Version' is not a version number like 0.1.0."
        }

        $msi = @(Get-MsiInstall)
        if ($msi.Count -gt 0) {
            throw "$AppName $($msi[0].Version) is installed from the MSI package. Remove it first (run this command with -Uninstall, or use Settings > Apps), then run this command again."
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
            # Moving to an all-users install: the per-user copy is removed once the
            # all-users copy is in place, so only one remains.
            $replaceUser = ($scope -eq 'AllUsers' -and $user.Count -gt 0)
            $existing = @($installed | Where-Object { $_.Scope -eq $scope }) | Select-Object -First 1
            if ($existing -and -not $Force) {
                $skip = $null
                if ($existing.Version -eq $target) {
                    $skip = "$AppName $target is already installed in $($existing.Location). Add -Force to reinstall."
                } elseif (-not $requested -and (Test-NewerVersion $existing.Version $target)) {
                    $skip = "$AppName $($existing.Version) is newer than the latest release ($target); nothing to do. Add -Version $target -Force to go back to it."
                }
                if ($skip) {
                    Write-Host $skip -ForegroundColor Green
                    if ($replaceUser) {
                        Wait-AppClosed @($user[0].Location)
                        Remove-UserCopy $user[0]
                    }
                    if ($scope -eq 'AllUsers') { Clear-OrphanedUserFileTypes }
                    if ($Launch) { Start-App $existing.Location }
                    return
                }
            }
            if ($scope -eq 'CurrentUser' -and (Test-Elevated)) {
                Write-Host "PowerShell is running as administrator, so $AppName is installed for the account '$env:USERNAME' only. To install it for another account, run the command in a normal PowerShell window signed in as that account." -ForegroundColor Yellow
            }

            $closeFirst = @()
            if ($existing) { $closeFirst += $existing.Location }
            if ($replaceUser) { $closeFirst += $user[0].Location }
            Wait-AppClosed $closeFirst

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
            # An update keeps the shortcuts the user removed; a new install or -Force creates them.
            if ($existing -and -not $Force) { $arguments += '/UPDATE' }
            $code = Invoke-Setup $setupFile $arguments ($scope -eq 'AllUsers')
            Assert-SetupExitCode $code 'installation'

            $result = @(Get-InstalledApp | Where-Object { $_.Scope -eq $scope }) | Select-Object -First 1
            if (-not $result -or $result.Version -ne $target -or -not (Test-Path -LiteralPath (Join-Path $result.Location $ExeName))) {
                throw "The installer finished, but $AppName $target was not found afterwards."
            }
            # Only now that the all-users copy works (a refused UAC prompt stops earlier).
            if ($replaceUser) { Remove-UserCopy $user[0] }
            if ($scope -eq 'AllUsers') { Clear-OrphanedUserFileTypes }

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
        $msi = @(Get-MsiInstall)
        if ($installed.Count -eq 0 -and $msi.Count -eq 0) {
            Write-Host "$AppName is not installed." -ForegroundColor Green
            return
        }
        Wait-AppClosed @(@($installed) + @($msi) | ForEach-Object { $_.Location })
        foreach ($item in $installed) { Remove-Installation $item }
        foreach ($item in $msi) { Remove-MsiInstallation $item }
        # Updates rhwpp downloaded for itself.
        if ($env:LOCALAPPDATA) {
            Remove-Item -LiteralPath (Join-Path $env:LOCALAPPDATA 'io.github.woo202.rhwpp\updates') -Recurse -Force -ErrorAction SilentlyContinue
        }
        Write-Host ''
        Write-Host "$AppName has been removed. Your documents and settings were kept." -ForegroundColor Green
    }

    try {
        Assert-Platform
        Initialize-Network
        if ($Uninstall) { Uninstall-App } else { Install-App }
    } catch {
        $message = "$AppName setup failed: $($_.Exception.Message)"
        if ($PSCommandPath) {
            # Run as a file: print the reason and exit with an error code.
            Write-Host ''
            Write-Host $message -ForegroundColor Red
            exit 1
        }
        # Under `irm | iex` (or a script block) never call exit, which would close the
        # window. A terminating error keeps it open and still tells a calling script, or
        # `powershell -Command`, that the installation failed.
        throw $message
    }
}
