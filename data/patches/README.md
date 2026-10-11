# Startup config patches

Files here are applied by `mc-image-helper patch` at every container start, wired
through `PATCH_DEFINITIONS: "/data/patches"` in `docker-compose.yml`.

## Two format rules, both learned the hard way

Both of these fail **silently in effect**: the patch is rejected at startup, the
server boots with stock config, and CI stays green. Local testing against the
pinned image caught both before they reached the droplet.

1. **A file in this directory must be a PatchDefinition, not a PatchSet.**
   PatchDefinition is `{"file": ..., "ops": [...]}`. The `{"patches": [...]}`
   wrapper is a PatchSet and is only valid when `PATCH_DEFINITIONS` points at a
   single file rather than a directory. Getting it wrong produces
   `Unrecognized field "patches"`.

2. **No comments. Not even `//`.** `mc-image-helper patch --help` advertises
   `--json-allow-comments` defaulting to true, but that applies to the files
   being *patched*, not to the definition read from this directory. A `//` line
   here produces `ALLOW_COMMENTS not enabled for parser`. That is why this
   README exists instead of comments in the JSON.

Verify a change applied by re-reading the effective file inside the container,
which is what `tools/verify_cc_http.sh` does. Never assume a patch landed.

## computercraft-http.json

Locks CC:Tweaked's HTTP API down to deny-by-default.

**What it closes.** Children write and run arbitrary Lua on this server.
CC:Tweaked's stock rules are `deny $private` then `allow *`, so any whitelisted
player could make the SERVER issue outbound HTTP to any host on the internet.
That is server-side request forgery with a child at the keyboard.

**Why a patch and not a committed config file.** CC:Tweaked's HTTP rules are
Forge SERVER config, stored per-world at
`world/serverconfig/computercraft-server.toml`. Both `data/config/` and
`data/world/` are gitignored deliberately: tracking files the server rewrites
leaves the droplet worktree permanently dirty and makes `git pull --ff-only` in
`gitops/deploy.sh` abort every run. So the rules cannot be committed. Patching at
startup also re-asserts them after any manual edit on the box.

**Rule order matters.** CC:Tweaked evaluates `http.rules` top to bottom, first
match wins. The private-range denies come first, then the catch-all deny.
`$private` already covers loopback, RFC1918 and link-local; the explicit CIDRs
are belt-and-braces in case `$private` is unsupported on a future version, and
because `169.254.169.254` is the cloud metadata endpoint on this DigitalOcean
droplet and deserves to be named.

**`http.enabled` stays true on purpose**, so a denied request returns a readable
"domain not permitted" instead of the confusing "http is disabled".

**Functional tradeoff, accepted deliberately.** The built-in `pastebin` and
`wget` programs now fail for every host. To allow one host back, insert a single
`{host, action: allow}` entry **above** the catch-all deny. That is also how the
Instructor Terminal gets its one allowed origin.
