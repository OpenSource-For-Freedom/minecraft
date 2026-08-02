# Local hardening assertions for the game container: run on the build machine.
#   powershell -File tests\test_docker_hardening.ps1
# Exits 0 if every check passes, 1 otherwise. Reads files and image metadata only;
# it never starts the server, touches the droplet, or reads secrets.

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$fail = 0

function Check($name, $ok, $detail) {
    if ($ok) { "PASS  $name" }
    else { "FAIL  $name" + $(if ($detail) { " - $detail" } else { "" }); $script:fail++ }
}

$dockerfile = Get-Content "$repo\Dockerfile" -Raw
$compose    = Get-Content "$repo\docker-compose.yml" -Raw
$gitignore  = Get-Content "$repo\.gitignore" -Raw

"== Dockerfile =="
Check "base image pinned by digest" ($dockerfile -match 'FROM\s+\S+@sha256:[0-9a-f]{64}') "a moving tag lets a repointed base into the build"
Check "downloaded artifact checksum-gated" ($dockerfile -match 'sha256sum\s+-c') "unverified native code would ship in the image"
Check "image declares non-root USER" ($dockerfile -match '(?m)^\s*USER\s+1000') "root by default if compose omits user:"
Check "no curl-pipe-to-shell in build" ($dockerfile -notmatch 'curl[^\n]*\|\s*(ba)?sh') "pipe-to-shell installs are unverifiable"

"`n== docker-compose.yml =="
Check "runs as uid 1000" ($compose -match '(?m)^\s*user:\s*"?1000') $null
Check "all capabilities dropped" ($compose -match '(?ms)cap_drop:\s*\r?\n\s*-\s*ALL') $null
Check "no-new-privileges set" ($compose -match 'no-new-privileges:\s*true') $null
Check "root filesystem read-only" ($compose -match '(?m)^\s*read_only:\s*true') $null
Check "process count capped" ($compose -match '(?m)^\s*pids_limit:\s*\d+') "fork-bomb guard"
Check "memory capped" ($compose -match '(?m)^\s*mem_limit:') $null
Check "log rotation bounded" ($compose -match 'max-size:') "unbounded logs fill the disk"
Check "no privileged flag" ($compose -notmatch '(?m)^\s*privileged:\s*true') $null
Check "docker socket not mounted" ($compose -notmatch 'docker\.sock') "socket mount equals host root"
Check "BlueMap 8100 bound to localhost only" ($compose -match '127\.0\.0\.1:8100:8100') "world-readable live map of a kids server"
Check "RCON 25575 not published" ($compose -notmatch '25575:') "RCON must stay container-internal"
Check "online-mode enforced (Microsoft auth)" ($compose -match 'ONLINE_MODE:\s*"TRUE"') $null
Check "whitelist enforced" (($compose -match 'ENABLE_WHITELIST:\s*"TRUE"') -and ($compose -match 'ENFORCE_WHITELIST:\s*"TRUE"')) $null
Check "command blocks disabled" ($compose -match 'ENABLE_COMMAND_BLOCK:\s*"false"') $null

"`n== repo hygiene =="
Check ".env gitignored" ($gitignore -match '(?m)^\.env') "public repo must never receive the DO token"
Check "no dop_v1 token in tracked files" (-not (Select-String -Path "$repo\*.yml","$repo\*.md","$repo\*.sh","$repo\*.ps1" -Pattern 'dop_v1_' -SimpleMatch -Quiet)) "DigitalOcean token leaked into the repo"

"`n== built image (skipped if image absent) =="
$imageUser = $null
try { $imageUser = (docker image inspect minecraft-java:secure --format "{{.Config.User}}" 2>$null) } catch { }
if ($imageUser) {
    Check "image metadata User is 1000" ($imageUser -match '^1000') "got '$imageUser'"
} else {
    "SKIP  image minecraft-java:secure not built here"
}

"`n---"
if ($fail -eq 0) { "ALL CHECKS PASSED"; exit 0 } else { "$fail CHECK(S) FAILED"; exit 1 }
