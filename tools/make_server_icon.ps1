# Generates data/server-icon.png: the 64x64 image Minecraft shows beside the
# server in the multiplayer list. Original pixel art, no Mojang assets.
#
# Drawn on a 16x16 logical grid at 4px per cell so it stays crisp pixel art
# rather than a resized photo, and reads at the ~32px the launcher renders it.
# Palette is the EduCraft house style already in the website's styles.css, so
# the icon, the site and the guide book all look like one thing.
Add-Type -AssemblyName System.Drawing

$palette = @{
  '.' = '#FBF7EF'   # cream-1, sky
  'c' = '#F6EFE0'   # cream-2, soft cloud band
  'h' = '#C96B62'   # rose highlight
  '#' = '#B0524A'   # rose-1, heart body
  '@' = '#8E3F39'   # rose-0, heart shadow
  # PowerShell hashtable keys are case-insensitive, so g/G would collide.
  'g' = '#7A8A5E'   # olive-2, grass top
  '+' = '#5D6B47'   # olive-1, grass
  'd' = '#465236'   # olive-0, soil
  'o' = '#A9772E'   # ochre-1, lantern glow
}

# 16 rows of 16 characters.
# Heart is a symmetric 12-wide form centred in the 16 grid, with a highlight on
# the upper-left lobe and a one-pixel shadow down the lower-right edge, so it
# reads as a lit object rather than a flat silhouette at launcher size.
$grid = @(
  '................'
  '.....c......c...'
  '....hh#..###....'
  '...hh########...'
  '..hh##########..'
  '..############..'
  '...#########@...'
  '....#######@....'
  '.....#####@.....'
  '......###@......'
  '.......#@.......'
  '................'
  '................'
  '................'
  'ggggoggggggoggg.'
  '++dd++dd++dd++dd'
)

$cell = 4
$size = 64
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'None'
$g.InterpolationMode = 'NearestNeighbor'

for ($row = 0; $row -lt 16; $row++) {
  $line = $grid[$row]
  for ($col = 0; $col -lt 16; $col++) {
    $ch = $line[$col]
    $hex = $palette["$ch"]
    if (-not $hex) { $hex = $palette['.'] }
    $color = [System.Drawing.ColorTranslator]::FromHtml($hex)
    $brush = New-Object System.Drawing.SolidBrush($color)
    $g.FillRectangle($brush, $col * $cell, $row * $cell, $cell, $cell)
    $brush.Dispose()
  }
}

$g.Dispose()
$out = 'F:\minecraft\data\server-icon.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

$f = Get-Item $out
$check = [System.Drawing.Image]::FromFile($out)
"wrote $out"
"  dimensions: $($check.Width)x$($check.Height)  (Minecraft requires exactly 64x64)"
"  size: $($f.Length) bytes"
"  format: $($check.RawFormat)"
$check.Dispose()
