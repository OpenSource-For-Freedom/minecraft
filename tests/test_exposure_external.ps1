# External exposure check: what the internet can actually reach on the droplet.
#   powershell -File tests\test_exposure_external.ps1 [-Ip 159.65.25.218] [-AdminVantage]
# Run WITHOUT -AdminVantage from a stranger's vantage (phone hotspot) for the real
# verdict: from the admin IP the firewall deliberately allows 22 and 8100.
# Exits 0 if reality matches expectations, 1 otherwise.

param(
    [string]$Ip = "159.65.25.218",
    [switch]$AdminVantage
)

$fail = 0

function Test-Port($port, $timeoutMs = 3000) {
    $c = New-Object Net.Sockets.TcpClient
    try {
        $r = $c.BeginConnect($Ip, $port, $null, $null)
        $ok = $r.AsyncWaitHandle.WaitOne($timeoutMs) -and $c.Connected
    } catch { $ok = $false } finally { $c.Close() }
    return $ok
}

function Expect($port, $label, $shouldBeOpen, $why) {
    $open = Test-Port $port
    $state = if ($open) { "OPEN" } else { "closed" }
    if ($open -eq $shouldBeOpen) {
        "PASS  $port/tcp $label is $state"
    } else {
        $want = if ($shouldBeOpen) { "OPEN" } else { "closed" }
        "FAIL  $port/tcp $label is $state, expected $want - $why"
        $script:fail++
    }
}

"target $Ip  (vantage: $(if ($AdminVantage) { 'admin IP' } else { 'stranger' }))"
""
Expect 25565 "Minecraft"      $true  "players cannot join"
Expect 25575 "RCON"           $false "remote console must never be internet-facing"
Expect 2375  "Docker API"      $false "unauthenticated Docker API equals host root"
Expect 2376  "Docker API TLS"  $false "do not expose the Docker daemon at all"
Expect 80    "HTTP"            $false "nothing should serve plain HTTP here"
Expect 443   "HTTPS"           $false "no web service is expected on the droplet"

# Firewall pins these to the admin IP: open from home, invisible to strangers.
Expect 22    "SSH"             $AdminVantage.IsPresent "SSH must be reachable only from the admin IP"
Expect 8100  "BlueMap"         $AdminVantage.IsPresent "the live map must not be public on a kids server"

"`n---"
if ($fail -eq 0) { "EXPOSURE AS EXPECTED"; exit 0 } else { "$fail EXPOSURE FINDING(S)"; exit 1 }
