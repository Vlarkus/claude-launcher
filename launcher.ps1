# Claude Code TUI Launcher
# Pure PowerShell, no external dependencies

$settingsPath  = "$env:USERPROFILE\.claude\settings.json"
$presetsPath   = "$env:USERPROFILE\.claude\launcher\presets.json"
$backupPath    = "$env:USERPROFILE\.claude\launcher\settings.backup.json"
$bookmarksPath = "$env:USERPROFILE\.claude\launcher\bookmarks.json"

# ── Key reading ──────────────────────────────────────────────────────
function Read-Key {
    $k = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    return $k
}

# ── Presets bootstrap ────────────────────────────────────────────────
function Initialize-Presets {
    if (Test-Path $presetsPath) {
        return (Get-Content $presetsPath -Raw | ConvertFrom-Json)
    }
    $settings = Get-Content $settingsPath -Raw | ConvertFrom-Json
    $hooksRaw = Get-Content $settingsPath -Raw | ConvertFrom-Json | Select-Object -ExpandProperty hooks
    $pluginNames = @()
    if ($settings.enabledPlugins) {
        $settings.enabledPlugins.PSObject.Properties | ForEach-Object { $pluginNames += $_.Name }
    }
    $presets = @{
        profiles = @{
            Default = @{
                hooks   = "Simple Beeps"
                model   = "Default"
                effort  = "high"
                plugins = $pluginNames
                flags   = @()
            }
        }
        hookTemplates = @{
            "Simple Beeps" = $hooksRaw
            Silent         = @{}
        }
    }
    $presets | ConvertTo-Json -Depth 20 | Set-Content $presetsPath -Encoding UTF8
    return (Get-Content $presetsPath -Raw | ConvertFrom-Json)
}

# ── Section definitions ──────────────────────────────────────────────
$allPlugins = @(
    "context7@claude-plugins-official",
    "superpowers@claude-plugins-official",
    "playwright@claude-plugins-official",
    "typescript-lsp@claude-plugins-official",
    "frontend-design@claude-plugins-official",
    "vercel@claude-plugins-official"
)
$pluginLabels = @{
    "context7@claude-plugins-official"       = "context7"
    "superpowers@claude-plugins-official"    = "superpowers"
    "playwright@claude-plugins-official"     = "playwright"
    "typescript-lsp@claude-plugins-official" = "typescript-lsp"
    "frontend-design@claude-plugins-official"= "frontend-design"
    "vercel@claude-plugins-official"         = "vercel"
}

$modelOptions  = @("Default", "Opus", "Sonnet", "Haiku")
$effortOptions = @("low", "medium", "high", "xhigh", "max")
$flagOptions   = @("--verbose", "--bare", "--worktree", "--chrome", "--debug")

# ── Descriptions ─────────────────────────────────────────────────────
$modelDesc = @{
    "Default" = "Uses model from settings (currently configured)"
    "Opus"    = "Most capable. Deep reasoning, complex tasks"
    "Sonnet"  = "Balanced speed and intelligence. Good default"
    "Haiku"   = "Fastest and cheapest. Simple tasks only"
}
$effortDesc = @{
    "low"    = "Minimal reasoning. Quick, short answers"
    "medium" = "Balanced. Good for routine tasks"
    "high"   = "Thorough. Multi-step planning, testing"
    "xhigh"  = "Extended reasoning. Complex architecture"
    "max"    = "Maximum depth. Exhaustive analysis"
}
$pluginDesc = @{
    "context7@claude-plugins-official"       = "Fetches up-to-date docs for libraries"
    "superpowers@claude-plugins-official"    = "Extended capabilities and tool access"
    "playwright@claude-plugins-official"     = "Browser automation and testing"
    "typescript-lsp@claude-plugins-official" = "TypeScript language server intelligence"
    "frontend-design@claude-plugins-official"= "UI/UX design assistance"
    "vercel@claude-plugins-official"         = "Vercel deployment integration"
}
$flagDesc = @{
    "--verbose"   = "Show full turn-by-turn output and logs"
    "--bare"      = "Skip hooks, plugins, MCP, skills discovery"
    "--worktree"  = "Run in isolated git worktree copy"
    "--chrome"    = "Enable Chrome browser integration"
    "--debug"     = "Enable debug mode with detailed logging"
}

# ── State ────────────────────────────────────────────────────────────
$script:sections = @("PROFILES","MODEL","EFFORT","PLUGINS","FLAGS")
$script:activeSection = 0
$script:activeItem    = @{}
$script:selectedModel  = "Default"
$script:selectedEffort = "high"
$script:pluginEnabled  = @{}
$script:flagEnabled    = @{}
$script:profileNames   = @()
$script:selectedProfile = 0
$script:presets = $null
$script:offX = 0
$script:offY = 0
$script:lastLineCount = 0
$script:lastInputEscaped = $false

function Reset-State {
    foreach ($p in $allPlugins) { $script:pluginEnabled[$p] = $true }
    foreach ($f in $flagOptions) { $script:flagEnabled[$f] = $false }
    $script:selectedModel  = "Default"
    $script:selectedEffort = "high"
    foreach ($s in $script:sections) { $script:activeItem[$s] = 0 }
}

function Load-Profile($name) {
    $p = $script:presets.profiles.$name
    if (-not $p) { return }
    $script:selectedModel  = $p.model
    $script:selectedEffort = $p.effort
    foreach ($pl in $allPlugins) { $script:pluginEnabled[$pl] = $false }
    foreach ($pl in $p.plugins) { $script:pluginEnabled[$pl] = $true }
    foreach ($f in $flagOptions) { $script:flagEnabled[$f] = $false }
    if ($p.flags) { foreach ($f in $p.flags) { $script:flagEnabled[$f] = $true } }
}

function Get-SectionItems($section) {
    switch ($section) {
        "PROFILES" { return $script:profileNames }
        "MODEL"    { return $modelOptions }
        "EFFORT"   { return $effortOptions }
        "PLUGINS"  { return $allPlugins }
        "FLAGS"    { return $flagOptions }
    }
}

# Get current selection summary for a section (for tab bar)
function Get-SectionSummary($section) {
    switch ($section) {
        "PROFILES" { return $script:profileNames[$script:selectedProfile] }
        "MODEL"    { return $script:selectedModel }
        "EFFORT"   { return $script:selectedEffort }
        "PLUGINS"  {
            $on = @($allPlugins | Where-Object { $script:pluginEnabled[$_] }).Count
            return "$on/$($allPlugins.Count)"
        }
        "FLAGS" {
            $on = @($flagOptions | Where-Object { $script:flagEnabled[$_] })
            if ($on.Count -eq 0) { return "none" }
            return $on -join " "
        }
    }
}

# ── Drawing helpers ──────────────────────────────────────────────────
function Get-TermSize {
    $tw = [Console]::WindowWidth
    $th = [Console]::WindowHeight
    if ($tw -lt 1) { $tw = 80 }
    if ($th -lt 1) { $th = 30 }
    return @($tw, $th)
}

function Write-BoxLine($x, $y, $innerW, $content, $color) {
    $bufH = [Console]::BufferHeight
    if ($y -lt 0 -or $y -ge $bufH) { return }
    [Console]::SetCursorPosition($x, $y)
    [Console]::ForegroundColor = [ConsoleColor]::DarkCyan
    [Console]::Write([char]0x2551)
    [Console]::ForegroundColor = $color
    [Console]::Write($content.PadRight($innerW))
    [Console]::ForegroundColor = [ConsoleColor]::DarkCyan
    [Console]::Write([char]0x2551)
}

function Write-BorderLine($x, $y, $innerW, $left, $fill, $right) {
    $bufH = [Console]::BufferHeight
    if ($y -lt 0 -or $y -ge $bufH) { return }
    [Console]::SetCursorPosition($x, $y)
    [Console]::ForegroundColor = [ConsoleColor]::DarkCyan
    [Console]::Write([string]$left + ([string]::new($fill, $innerW)) + [string]$right)
}

# ── Render single section (full screen) ──────────────────────────────
function Render-Screen {
    $sz = Get-TermSize
    $tw = $sz[0]; $th = $sz[1]
    $boxW = [Math]::Min(60, $tw - 4)
    $iW = $boxW - 2

    $sect = $script:sections[$script:activeSection]
    $ai = $script:activeItem
    $items = @(Get-SectionItems $sect)

    # Build rows
    $rows = [System.Collections.Generic.List[object]]::new()

    # Title
    $rows.Add(@{ type="border-top" })
    $title = "Claude Code Launcher"
    $tpad = [int](($iW - $title.Length) / 2)
    $rows.Add(@{ type="content"; text=(' ' * $tpad) + $title; color=[ConsoleColor]::White })
    $rows.Add(@{ type="border-mid" })

    # Tab bar showing all sections, current one highlighted
    $rows.Add(@{ type="content"; text=""; color=[ConsoleColor]::Gray })
    $tabLine = " "
    for ($i = 0; $i -lt $script:sections.Count; $i++) {
        $s = $script:sections[$i]
        $short = switch ($s) { "PROFILES" {"PRO"} "MODEL" {"MDL"} "EFFORT" {"EFF"} "PLUGINS" {"PLG"} "FLAGS" {"FLG"} }
        if ($i -eq $script:activeSection) { $tabLine += "[$short]" }
        else { $tabLine += " $short " }
        if ($i -lt $script:sections.Count - 1) { $tabLine += " " }
    }
    $rows.Add(@{ type="content"; text=$tabLine; color=[ConsoleColor]::DarkGray })
    $rows.Add(@{ type="content"; text=""; color=[ConsoleColor]::Gray })
    $rows.Add(@{ type="border-mid" })

    # Section header
    $rows.Add(@{ type="content"; text="  $sect"; color=[ConsoleColor]::White })
    $rows.Add(@{ type="content"; text=""; color=[ConsoleColor]::Gray })

    # Section items (one per line)
    for ($i = 0; $i -lt $items.Count; $i++) {
        $item = $items[$i]
        $isCursor = ($ai[$sect] -eq $i)
        $marker = if ($isCursor) { " > " } else { "   " }

        switch ($sect) {
            "PROFILES" {
                $isSel = ($script:selectedProfile -eq $i)
                $label = $item
                $ind = if ($isSel) { " (*)" } else { "" }
                $c = if ($isCursor) { [ConsoleColor]::Cyan } elseif ($isSel) { [ConsoleColor]::Green } else { [ConsoleColor]::Gray }
                $rows.Add(@{ type="content"; text="$marker$label$ind"; color=$c })
            }
            "MODEL" {
                $isSel = ($script:selectedModel -eq $item)
                $ind = if ($isSel) { " (*)" } else { "" }
                $c = if ($isCursor) { [ConsoleColor]::Cyan } elseif ($isSel) { [ConsoleColor]::Green } else { [ConsoleColor]::Gray }
                $rows.Add(@{ type="content"; text="$marker$item$ind"; color=$c })
            }
            "EFFORT" {
                $isSel = ($script:selectedEffort -eq $item)
                $ind = if ($isSel) { " (*)" } else { "" }
                $c = if ($isCursor) { [ConsoleColor]::Cyan } elseif ($isSel) { [ConsoleColor]::Green } else { [ConsoleColor]::Gray }
                $rows.Add(@{ type="content"; text="$marker$item$ind"; color=$c })
            }
            "PLUGINS" {
                $label = $pluginLabels[$item]
                $chk = if ($script:pluginEnabled[$item]) { "[x]" } else { "[ ]" }
                $c = if ($isCursor) { [ConsoleColor]::Cyan } else { [ConsoleColor]::Gray }
                $rows.Add(@{ type="content"; text="$marker$chk $label"; color=$c })
            }
            "FLAGS" {
                $chk = if ($script:flagEnabled[$item]) { "[x]" } else { "[ ]" }
                $c = if ($isCursor) { [ConsoleColor]::Cyan } else { [ConsoleColor]::Gray }
                $rows.Add(@{ type="content"; text="$marker$chk $item"; color=$c })
            }
        }
    }

    # Extra actions for profiles
    if ($sect -eq "PROFILES") {
        $rows.Add(@{ type="content"; text=""; color=[ConsoleColor]::Gray })
        $rows.Add(@{ type="content"; text="   [S] Save current  [X] Delete"; color=[ConsoleColor]::DarkYellow })
    }

    # Description of highlighted item
    $desc = $null
    $curIdx = $ai[$sect]
    if ($curIdx -lt $items.Count) {
        $curItem = $items[$curIdx]
        switch ($sect) {
            "MODEL"   { $desc = $modelDesc[$curItem] }
            "EFFORT"  { $desc = $effortDesc[$curItem] }
            "PLUGINS" { $desc = $pluginDesc[$curItem] }
            "FLAGS"   { $desc = $flagDesc[$curItem] }
        }
    }
    $rows.Add(@{ type="content"; text=""; color=[ConsoleColor]::Gray })
    if ($desc) {
        $rows.Add(@{ type="content"; text="  $desc"; color=[ConsoleColor]::DarkYellow })
    }

    # Footer
    $rows.Add(@{ type="border-mid" })
    $rows.Add(@{ type="content"; text="  Tab/Shift-Tab = Switch section"; color=[ConsoleColor]::DarkGray })
    $rows.Add(@{ type="content"; text="  Up/Dn = Move   Space = Select/Toggle"; color=[ConsoleColor]::DarkGray })
    $rows.Add(@{ type="content"; text="  Enter = Review & Launch   Esc = Quit"; color=[ConsoleColor]::DarkGray })
    $rows.Add(@{ type="border-bot" })

    # Center and draw
    $totalH = $rows.Count
    $offX = [Math]::Max(0, [int](($tw - $boxW) / 2))
    $offY = [Math]::Max(0, [int](($th - $totalH) / 2))

    [Console]::Clear()
    for ($i = 0; $i -lt $rows.Count; $i++) {
        $row = $rows[$i]
        $y = $offY + $i
        switch ($row.type) {
            "border-top" { Write-BorderLine $offX $y $iW ([char]0x2554) ([char]0x2550) ([char]0x2557) }
            "border-mid" { Write-BorderLine $offX $y $iW ([char]0x2560) ([char]0x2550) ([char]0x2563) }
            "border-bot" { Write-BorderLine $offX $y $iW ([char]0x255A) ([char]0x2550) ([char]0x255D) }
            "content"    { Write-BoxLine $offX $y $iW $row.text $row.color }
        }
    }
    [Console]::ForegroundColor = [ConsoleColor]::Gray
    $script:lastLineCount = $totalH
    $script:offX = $offX
    $script:offY = $offY
}

# ── Confirmation screen ──────────────────────────────────────────────
function Show-Confirmation {
    $sz = Get-TermSize
    $tw = $sz[0]; $th = $sz[1]
    $boxW = [Math]::Min(60, $tw - 4)
    $iW = $boxW - 2

    $ep = ($allPlugins | Where-Object { $script:pluginEnabled[$_] } | ForEach-Object { $pluginLabels[$_] })
    $ef = @($flagOptions | Where-Object { $script:flagEnabled[$_] })

    $rows = [System.Collections.Generic.List[object]]::new()
    $rows.Add(@{ type="border-top" })
    $title = "Confirm & Launch"
    $tpad = [int](($iW - $title.Length) / 2)
    $rows.Add(@{ type="content"; text=(' ' * $tpad) + $title; color=[ConsoleColor]::White })
    $rows.Add(@{ type="border-mid" })
    $rows.Add(@{ type="content"; text=""; color=[ConsoleColor]::Gray })

    $rows.Add(@{ type="content"; text="  Profile:  $($script:profileNames[$script:selectedProfile])"; color=[ConsoleColor]::Cyan })
    $rows.Add(@{ type="content"; text="  Model:    $($script:selectedModel)"; color=[ConsoleColor]::Gray })
    $rows.Add(@{ type="content"; text="  Effort:   $($script:selectedEffort)"; color=[ConsoleColor]::Gray })
    $rows.Add(@{ type="content"; text=""; color=[ConsoleColor]::Gray })

    $rows.Add(@{ type="content"; text="  Plugins:"; color=[ConsoleColor]::Gray })
    foreach ($p in $ep) {
        $rows.Add(@{ type="content"; text="    [x] $p"; color=[ConsoleColor]::Green })
    }
    $disabled = @($allPlugins | Where-Object { -not $script:pluginEnabled[$_] } | ForEach-Object { $pluginLabels[$_] })
    foreach ($p in $disabled) {
        $rows.Add(@{ type="content"; text="    [ ] $p"; color=[ConsoleColor]::DarkGray })
    }

    if ($ef.Count -gt 0) {
        $rows.Add(@{ type="content"; text=""; color=[ConsoleColor]::Gray })
        $rows.Add(@{ type="content"; text="  Flags:  $($ef -join '  ')"; color=[ConsoleColor]::Gray })
    }

    $rows.Add(@{ type="content"; text=""; color=[ConsoleColor]::Gray })

    # Build CLI args preview
    $cliArgs = @("--dangerously-skip-permissions")
    if ($script:selectedModel -ne "Default") { $cliArgs += "--model"; $cliArgs += $script:selectedModel.ToLower() }
    $cliArgs += "--effort"; $cliArgs += $script:selectedEffort
    foreach ($f in $ef) { $cliArgs += $f }
    $rows.Add(@{ type="content"; text="  claude $($cliArgs -join ' ')"; color=[ConsoleColor]::DarkGray })

    $rows.Add(@{ type="content"; text=""; color=[ConsoleColor]::Gray })
    $rows.Add(@{ type="border-mid" })
    $rows.Add(@{ type="content"; text="  Enter = Launch    Esc = Go back"; color=[ConsoleColor]::DarkGray })
    $rows.Add(@{ type="border-bot" })

    $totalH = $rows.Count
    $offX = [Math]::Max(0, [int](($tw - $boxW) / 2))
    $offY = [Math]::Max(0, [int](($th - $totalH) / 2))

    [Console]::Clear()
    for ($i = 0; $i -lt $rows.Count; $i++) {
        $row = $rows[$i]
        $y = $offY + $i
        switch ($row.type) {
            "border-top" { Write-BorderLine $offX $y $iW ([char]0x2554) ([char]0x2550) ([char]0x2557) }
            "border-mid" { Write-BorderLine $offX $y $iW ([char]0x2560) ([char]0x2550) ([char]0x2563) }
            "border-bot" { Write-BorderLine $offX $y $iW ([char]0x255A) ([char]0x2550) ([char]0x255D) }
            "content"    { Write-BoxLine $offX $y $iW $row.text $row.color }
        }
    }
    [Console]::ForegroundColor = [ConsoleColor]::Gray

    while ($true) {
        $k = Read-Key
        if ($k.VirtualKeyCode -eq 13) { return $true }   # Enter = launch
        if ($k.VirtualKeyCode -eq 27) { return $false }  # Esc = go back
    }
}

# ── First Screen ─────────────────────────────────────────────────────
function Show-FirstScreen {
    [Console]::Clear()
    [Console]::CursorVisible = $false

    $boxW = 46
    $iW = $boxW - 2
    $title = "Claude Code Launcher"
    $tpad = [int](($iW - $title.Length) / 2)

    $options = @(
        @{ label = "Resume a session"; key = "R"; action = "resume" },
        @{ label = "New session";      key = "N"; action = "new" },
        @{ label = "Saved chats";      key = "S"; action = "saved" },
        @{ label = "Quit";             key = "Q"; action = "quit" }
    )
    $sel = 0

    while ($true) {
        $sz = Get-TermSize
        $tw = $sz[0]; $th = $sz[1]
        $totalH = 4 + $options.Count + 3
        $offX = [Math]::Max(0, [int](($tw - $boxW) / 2))
        $offY = [Math]::Max(0, [int](($th - $totalH) / 2))

        [Console]::Clear()
        $y = $offY
        Write-BorderLine $offX $y $iW ([char]0x2554) ([char]0x2550) ([char]0x2557); $y++
        Write-BoxLine $offX $y $iW ((' ' * $tpad) + $title + (' ' * ($iW - $tpad - $title.Length))) ([ConsoleColor]::White); $y++
        Write-BorderLine $offX $y $iW ([char]0x2560) ([char]0x2550) ([char]0x2563); $y++
        Write-BoxLine $offX $y $iW "" ([ConsoleColor]::Gray); $y++

        for ($i = 0; $i -lt $options.Count; $i++) {
            $o = $options[$i]
            $marker = if ($i -eq $sel) { " > " } else { "   " }
            $text = "$marker[$($o.key)]  $($o.label)"
            $c = if ($i -eq $sel) { [ConsoleColor]::Cyan } elseif ($o.action -eq "quit") { [ConsoleColor]::DarkGray } else { [ConsoleColor]::Gray }
            Write-BoxLine $offX $y $iW $text $c; $y++
        }

        Write-BoxLine $offX $y $iW "" ([ConsoleColor]::Gray); $y++
        Write-BoxLine $offX $y $iW "  Up/Dn + Enter  or  press shortcut key" ([ConsoleColor]::DarkGray); $y++
        Write-BorderLine $offX $y $iW ([char]0x255A) ([char]0x2550) ([char]0x255D)

        $k = Read-Key
        $vk = $k.VirtualKeyCode
        switch ($vk) {
            38 { $sel = ($sel - 1 + $options.Count) % $options.Count }
            40 { $sel = ($sel + 1) % $options.Count }
            13 { return $options[$sel].action }
            27 { return "quit" }
            default {
                $ch = [char]::ToUpper($k.Character)
                switch ($ch) {
                    'R' { return "resume" }
                    'N' { return "new" }
                    'S' { return "saved" }
                    'Q' { return "quit" }
                }
            }
        }
    }
}

# ── Read string with Escape support ──────────────────────────────────
function Read-StringWithEscape($prompt, $x, $y) {
    [Console]::CursorVisible = $true
    [Console]::SetCursorPosition($x, $y)
    [Console]::ForegroundColor = [ConsoleColor]::Yellow
    [Console]::Write($prompt)
    [Console]::ForegroundColor = [ConsoleColor]::White
    $buf = ""
    $startX = $x + $prompt.Length
    $script:lastInputEscaped = $false
    while ($true) {
        $k = Read-Key
        $vk = $k.VirtualKeyCode
        if ($vk -eq 27) { [Console]::CursorVisible = $false; $script:lastInputEscaped = $true; return $null }
        if ($vk -eq 13) { [Console]::CursorVisible = $false; if ($buf.Trim() -eq "") { return $null }; return $buf.Trim() }
        if ($vk -eq 8) {
            if ($buf.Length -gt 0) {
                $buf = $buf.Substring(0, $buf.Length - 1)
                [Console]::SetCursorPosition($startX, $y)
                [Console]::Write($buf + " ")
                [Console]::SetCursorPosition($startX + $buf.Length, $y)
            }
        } else {
            $ch = $k.Character
            if ([int]$ch -ge 32 -and [int]$ch -le 126) {
                $buf += $ch
                [Console]::SetCursorPosition($startX, $y)
                [Console]::Write($buf)
            }
        }
    }
}

# ── Save / Delete profiles ──────────────────────────────────────────
function Save-Profile {
    $promptY = $script:offY + $script:lastLineCount + 1
    $name = Read-StringWithEscape "  Profile name (Esc=cancel): " $script:offX $promptY
    [Console]::SetCursorPosition($script:offX, $promptY)
    [Console]::Write((' ' * 60))
    if (-not $name) { return }

    $enabledFlags = @(); foreach ($f in $flagOptions) { if ($script:flagEnabled[$f]) { $enabledFlags += $f } }
    $enabledPlugins = @(); foreach ($p in $allPlugins) { if ($script:pluginEnabled[$p]) { $enabledPlugins += $p } }

    $profile = @{ model = $script:selectedModel; effort = $script:selectedEffort; plugins = $enabledPlugins; flags = $enabledFlags }
    $raw = Get-Content $presetsPath -Raw | ConvertFrom-Json
    $raw.profiles | Add-Member -NotePropertyName $name -NotePropertyValue $profile -Force
    $raw | ConvertTo-Json -Depth 20 | Set-Content $presetsPath -Encoding UTF8
    $script:presets = Get-Content $presetsPath -Raw | ConvertFrom-Json
    $script:profileNames = @($script:presets.profiles.PSObject.Properties.Name)
}

function Delete-Profile {
    if ($script:profileNames.Count -le 1) { return }
    $name = $script:profileNames[$script:activeItem["PROFILES"]]
    if ($name -eq "Default") { return }

    $promptY = $script:offY + $script:lastLineCount + 1
    [Console]::SetCursorPosition($script:offX, $promptY)
    [Console]::ForegroundColor = [ConsoleColor]::Red
    [Console]::Write("  Delete '$name'? [Y/N/Esc] ")
    [Console]::ForegroundColor = [ConsoleColor]::Gray

    while ($true) {
        $k = Read-Key
        if ($k.VirtualKeyCode -eq 27 -or [char]::ToUpper($k.Character) -eq 'N') {
            [Console]::SetCursorPosition($script:offX, $promptY)
            [Console]::Write((' ' * 60))
            return
        }
        if ([char]::ToUpper($k.Character) -eq 'Y') { break }
    }
    [Console]::SetCursorPosition($script:offX, $promptY)
    [Console]::Write((' ' * 60))

    $raw = Get-Content $presetsPath -Raw | ConvertFrom-Json
    $newProfiles = @{}
    $raw.profiles.PSObject.Properties | Where-Object { $_.Name -ne $name } | ForEach-Object { $newProfiles[$_.Name] = $_.Value }
    $raw.profiles = [PSCustomObject]$newProfiles
    $raw | ConvertTo-Json -Depth 20 | Set-Content $presetsPath -Encoding UTF8
    $script:presets = Get-Content $presetsPath -Raw | ConvertFrom-Json
    $script:profileNames = @($script:presets.profiles.PSObject.Properties.Name)
    if ($script:activeItem["PROFILES"] -ge $script:profileNames.Count) { $script:activeItem["PROFILES"] = $script:profileNames.Count - 1 }
    $script:selectedProfile = [Math]::Min($script:selectedProfile, $script:profileNames.Count - 1)
}

# ── Settings modification & launch ───────────────────────────────────
function Launch-Claude($name) {
    $cliArgs = @("--dangerously-skip-permissions")

    # If named, pin a session ID and save it as a bookmark for later
    if ($name) {
        $sessionId = [guid]::NewGuid().ToString()
        $cliArgs += "--session-id"; $cliArgs += $sessionId
        $cliArgs += "-n"; $cliArgs += $name
        Add-Bookmark $name ((Get-Location).Path) $sessionId
    }

    if ($script:selectedModel -ne "Default") { $cliArgs += "--model"; $cliArgs += $script:selectedModel.ToLower() }
    $cliArgs += "--effort"; $cliArgs += $script:selectedEffort
    foreach ($f in $flagOptions) { if ($script:flagEnabled[$f]) { $cliArgs += $f } }

    [Console]::Clear()
    [Console]::CursorVisible = $true
    [Console]::ResetColor()

    & claude @cliArgs
}

# ── Bookmarks (saved chats) ──────────────────────────────────────────
function Get-Bookmarks {
    if (-not (Test-Path $bookmarksPath)) { return @() }
    try { $j = Get-Content $bookmarksPath -Raw | ConvertFrom-Json } catch { return @() }
    if ($null -eq $j) { return @() }
    return @($j)
}

function Save-Bookmarks($list) {
    $arr = @($list)
    if ($arr.Count -eq 0) {
        Set-Content $bookmarksPath "[]" -Encoding UTF8
    } else {
        ($arr | ConvertTo-Json -Depth 6) | Set-Content $bookmarksPath -Encoding UTF8
    }
}

function Add-Bookmark($name, $path, $sessionId) {
    $bm = @(Get-Bookmarks)
    $bm += [PSCustomObject]@{ name = $name; path = $path; sessionId = $sessionId }
    Save-Bookmarks $bm
}

function Remove-BookmarkAt($index) {
    $bm = @(Get-Bookmarks)
    if ($index -lt 0 -or $index -ge $bm.Count) { return }
    $new = @(); for ($i = 0; $i -lt $bm.Count; $i++) { if ($i -ne $index) { $new += $bm[$i] } }
    Save-Bookmarks $new
}

function Fit($s, $w) {
    if ($null -eq $s) { return "" }
    if ($s.Length -le $w) { return $s }
    if ($w -le 1) { return $s.Substring(0, [Math]::Max(0, $w)) }
    return $s.Substring(0, $w - 1) + "~"
}

# Draw a list of rows centered, same style as the other screens
function Draw-Rows($rows, $boxW) {
    $sz = Get-TermSize; $tw = $sz[0]; $th = $sz[1]
    $iW = $boxW - 2
    $totalH = $rows.Count
    $offX = [Math]::Max(0, [int](($tw - $boxW) / 2))
    $offY = [Math]::Max(0, [int](($th - $totalH) / 2))
    [Console]::Clear()
    for ($i = 0; $i -lt $rows.Count; $i++) {
        $row = $rows[$i]; $y = $offY + $i
        switch ($row.type) {
            "border-top" { Write-BorderLine $offX $y $iW ([char]0x2554) ([char]0x2550) ([char]0x2557) }
            "border-mid" { Write-BorderLine $offX $y $iW ([char]0x2560) ([char]0x2550) ([char]0x2563) }
            "border-bot" { Write-BorderLine $offX $y $iW ([char]0x255A) ([char]0x2550) ([char]0x255D) }
            "content"    { Write-BoxLine $offX $y $iW $row.text $row.color }
        }
    }
    [Console]::ForegroundColor = [ConsoleColor]::Gray
}

# Returns a bookmark object to open, or $null to go back
function Show-SavedChats {
    [Console]::CursorVisible = $false
    $sel = 0
    $pendingDelete = $false
    while ($true) {
        $bm = @(Get-Bookmarks)
        if ($bm.Count -eq 0) { $sel = 0 } elseif ($sel -ge $bm.Count) { $sel = $bm.Count - 1 }

        $sz = Get-TermSize; $tw = $sz[0]
        $boxW = [Math]::Min(74, $tw - 4); $iW = $boxW - 2

        $rows = [System.Collections.Generic.List[object]]::new()
        $rows.Add(@{ type = "border-top" })
        $title = "Saved Chats"
        $tpad = [int](($iW - $title.Length) / 2)
        $rows.Add(@{ type = "content"; text = (' ' * $tpad) + $title; color = [ConsoleColor]::White })
        $rows.Add(@{ type = "border-mid" })
        $rows.Add(@{ type = "content"; text = ""; color = [ConsoleColor]::Gray })

        if ($bm.Count -eq 0) {
            $rows.Add(@{ type = "content"; text = "  No saved chats yet."; color = [ConsoleColor]::DarkGray })
            $rows.Add(@{ type = "content"; text = "  Start a New session and name it to save one."; color = [ConsoleColor]::DarkGray })
        } else {
            for ($i = 0; $i -lt $bm.Count; $i++) {
                $b = $bm[$i]
                $isCur = ($i -eq $sel)
                $marker = if ($isCur) { " > " } else { "   " }
                $nameC = if ($isCur) { [ConsoleColor]::Cyan } else { [ConsoleColor]::Gray }
                $rows.Add(@{ type = "content"; text = (Fit "$marker$($b.name)" $iW); color = $nameC })
                $rows.Add(@{ type = "content"; text = (Fit "       $($b.path)" $iW); color = [ConsoleColor]::DarkGray })
            }
        }

        $rows.Add(@{ type = "content"; text = ""; color = [ConsoleColor]::Gray })
        $rows.Add(@{ type = "border-mid" })
        if ($pendingDelete -and $bm.Count -gt 0) {
            $rows.Add(@{ type = "content"; text = (Fit "  Remove '$($bm[$sel].name)' from list? [Y/N]" $iW); color = [ConsoleColor]::Red })
        } elseif ($bm.Count -gt 0) {
            $rows.Add(@{ type = "content"; text = "  Up/Dn = Move   Enter = Open   D = Remove   Esc = Back"; color = [ConsoleColor]::DarkGray })
        } else {
            $rows.Add(@{ type = "content"; text = "  Esc = Back"; color = [ConsoleColor]::DarkGray })
        }
        $rows.Add(@{ type = "border-bot" })

        Draw-Rows $rows $boxW

        $k = Read-Key; $vk = $k.VirtualKeyCode; $ch = [char]::ToUpper($k.Character)

        if ($pendingDelete) {
            if ($ch -eq 'Y') { Remove-BookmarkAt $sel; $pendingDelete = $false }
            elseif ($ch -eq 'N' -or $vk -eq 27) { $pendingDelete = $false }
            continue
        }

        if ($vk -eq 27) { return $null }
        if ($bm.Count -gt 0) {
            if ($vk -eq 38) { $sel = ($sel - 1 + $bm.Count) % $bm.Count }
            elseif ($vk -eq 40) { $sel = ($sel + 1) % $bm.Count }
            elseif ($vk -eq 13) { return $bm[$sel] }
            elseif ($ch -eq 'D') { $pendingDelete = $true }
        }
    }
}

# Ask for a name to save this new chat. Returns name, or $null to skip saving.
function Prompt-NewChatName {
    $sz = Get-TermSize; $tw = $sz[0]; $th = $sz[1]
    $boxW = [Math]::Min(60, $tw - 4); $iW = $boxW - 2

    $rows = [System.Collections.Generic.List[object]]::new()
    $rows.Add(@{ type = "border-top" })
    $title = "Save this chat?"
    $tpad = [int](($iW - $title.Length) / 2)
    $rows.Add(@{ type = "content"; text = (' ' * $tpad) + $title; color = [ConsoleColor]::White })
    $rows.Add(@{ type = "border-mid" })
    $rows.Add(@{ type = "content"; text = ""; color = [ConsoleColor]::Gray })
    $rows.Add(@{ type = "content"; text = "  Name it to find it under Saved chats later."; color = [ConsoleColor]::Gray })
    $rows.Add(@{ type = "content"; text = "  Leave blank (Enter) to launch without saving."; color = [ConsoleColor]::DarkGray })
    $rows.Add(@{ type = "content"; text = ""; color = [ConsoleColor]::Gray })
    $rows.Add(@{ type = "content"; text = ""; color = [ConsoleColor]::Gray })   # input line lives here
    $rows.Add(@{ type = "border-bot" })

    Draw-Rows $rows $boxW
    $offX = [Math]::Max(0, [int](($tw - $boxW) / 2))
    $offY = [Math]::Max(0, [int](($th - $rows.Count) / 2))
    $inputY = $offY + 7
    return (Read-StringWithEscape "  Name: " ($offX + 1) $inputY)
}

# ── Config screen (New session) ──────────────────────────────────────
# Returns "launched" (claude ran), "back" (Esc -> first screen), or "quit".
function Show-ConfigScreen {
    $script:presets = Initialize-Presets
    $script:profileNames = @($script:presets.profiles.PSObject.Properties.Name)
    Reset-State
    if ($script:profileNames.Count -gt 0) { Load-Profile $script:profileNames[0] }

    [Console]::Clear()
    [Console]::CursorVisible = $false

    try {
        Render-Screen

        while ($true) {
            $k = Read-Key
            $vk = $k.VirtualKeyCode
            $sect = $script:sections[$script:activeSection]
            $items = @(Get-SectionItems $sect)
            $itemCount = $items.Count

            switch ($vk) {
                9 {   # Tab
                    if ($k.ControlKeyState -band 0x0010) {
                        $script:activeSection = ($script:activeSection - 1 + $script:sections.Count) % $script:sections.Count
                    } else {
                        $script:activeSection = ($script:activeSection + 1) % $script:sections.Count
                    }
                }
                37 {  # Left arrow = prev section
                    $script:activeSection = ($script:activeSection - 1 + $script:sections.Count) % $script:sections.Count
                }
                39 {  # Right arrow = next section
                    $script:activeSection = ($script:activeSection + 1) % $script:sections.Count
                }
                38 {  # Up
                    if ($itemCount -gt 0) { $script:activeItem[$sect] = ($script:activeItem[$sect] - 1 + $itemCount) % $itemCount }
                }
                40 {  # Down
                    if ($itemCount -gt 0) { $script:activeItem[$sect] = ($script:activeItem[$sect] + 1) % $itemCount }
                }
                32 {  # Space
                    $ci = $script:activeItem[$sect]
                    switch ($sect) {
                        "PROFILES" { $script:selectedProfile = $ci; Load-Profile $script:profileNames[$ci] }
                        "MODEL"    { $script:selectedModel  = $modelOptions[$ci] }
                        "EFFORT"   { $script:selectedEffort = $effortOptions[$ci] }
                        "PLUGINS"  { $p = $allPlugins[$ci]; $script:pluginEnabled[$p] = -not $script:pluginEnabled[$p] }
                        "FLAGS"    { $f = $flagOptions[$ci]; $script:flagEnabled[$f] = -not $script:flagEnabled[$f] }
                    }
                }
                13 {  # Enter = show confirmation
                    $confirmed = Show-Confirmation
                    if ($confirmed) {
                        $name = Prompt-NewChatName
                        if (-not $script:lastInputEscaped) {
                            Launch-Claude $name
                            return "launched"
                        }
                        # Esc at the name prompt -> back to the config screen
                    }
                }
                27 {  # Escape = back to first screen
                    return "back"
                }
                default {
                    $ch = [char]::ToUpper($k.Character)
                    switch ($ch) {
                        'S' { Save-Profile }
                        'X' { Delete-Profile }
                        'Q' { return "quit" }
                    }
                }
            }

            Render-Screen
        }
    }
    finally {
        [Console]::CursorVisible = $true
        [Console]::ResetColor()
    }
}

# ── Main ─────────────────────────────────────────────────────────────
function Main {
    while ($true) {
        $choice = Show-FirstScreen

        if ($choice -eq "quit") {
            [Console]::Clear(); [Console]::CursorVisible = $true; [Console]::ResetColor(); return
        }
        if ($choice -eq "resume") {
            [Console]::Clear(); [Console]::CursorVisible = $true; [Console]::ResetColor()
            & claude --resume --dangerously-skip-permissions
            return
        }
        if ($choice -eq "saved") {
            $entry = Show-SavedChats
            if ($entry) {
                [Console]::Clear(); [Console]::CursorVisible = $true; [Console]::ResetColor()
                if (Test-Path -LiteralPath $entry.path) { Set-Location -LiteralPath $entry.path }
                else { Write-Host "Folder not found: $($entry.path)" -ForegroundColor Yellow }
                & claude --resume $entry.sessionId --dangerously-skip-permissions
                return
            }
            continue   # Esc in Saved chats -> back to first screen
        }
        if ($choice -eq "new") {
            $result = Show-ConfigScreen
            if ($result -eq "launched") { return }
            if ($result -eq "quit") {
                [Console]::Clear(); [Console]::CursorVisible = $true; [Console]::ResetColor(); return
            }
            continue   # "back" -> first screen
        }
    }
}

try {
    Main
}
catch {
    [Console]::CursorVisible = $true
    [Console]::ResetColor()
    Write-Host ""
    Write-Host "  Launcher error:" -ForegroundColor Red
    Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    Write-Host "  $($_.ScriptStackTrace)" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  Press any key to exit..." -ForegroundColor DarkGray
    [void]$Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
}
