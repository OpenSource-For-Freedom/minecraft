# Rebuilds EduCraftClient.mrpack's bundled guide book so client packs stay in
# sync with data/patchouli_books/. Patchouli's server can only tell a client
# WHICH book to open (by ID) - the client must already have that book's
# category/entry JSON locally, so forgetting this step is why /guide can
# silently do nothing for players stuck on a stale pack (see commit 631b8d7).
#
# Run this after editing anything under data/patchouli_books/, then commit
# the updated .mrpack and tell players to reimport/update their pack.

$ServerDir = $PSScriptRoot
$MrpackPath = Join-Path $ServerDir "data\EduCraftClient.mrpack"
$BookSource = Join-Path $ServerDir "data\patchouli_books"
$WorkDir = Join-Path $env:TEMP "educraft_mrpack_sync"

if (-not (Test-Path $MrpackPath)) {
    Write-Error "Can't find $MrpackPath"
    exit 1
}
if (-not (Test-Path $BookSource)) {
    Write-Error "Can't find $BookSource"
    exit 1
}

Write-Host "=== Syncing guide book into EduCraftClient.mrpack ==="

if (Test-Path $WorkDir) { Remove-Item $WorkDir -Recurse -Force }
New-Item -ItemType Directory -Path $WorkDir | Out-Null

$ZipCopy = Join-Path $WorkDir "pack.zip"
Copy-Item $MrpackPath $ZipCopy

$ExtractDir = Join-Path $WorkDir "extracted"
Expand-Archive -Path $ZipCopy -DestinationPath $ExtractDir -Force
Remove-Item $ZipCopy

$OverridesBooks = Join-Path $ExtractDir "overrides\patchouli_books"
if (Test-Path $OverridesBooks) { Remove-Item $OverridesBooks -Recurse -Force }
Copy-Item $BookSource $OverridesBooks -Recurse

$RebuiltZip = Join-Path $WorkDir "rebuilt.zip"
Compress-Archive -Path (Join-Path $ExtractDir "*") -DestinationPath $RebuiltZip

Copy-Item $RebuiltZip $MrpackPath -Force
Remove-Item $WorkDir -Recurse -Force

Write-Host "Done. $MrpackPath now includes the current guide book."
Write-Host "Remember to commit the updated .mrpack, and bump the (vN) marker in book.json's subtitle so players can tell their copy is current."
