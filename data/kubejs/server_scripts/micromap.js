// A huge live world map rendered as a STACK of holograms - no blocks placed.
//
// WHY A STACK, not one display: a single command carrying every cell hits
// Minecraft's command-length limit. At 41x21 it just fit; at 61x31 the
// command silently failed and the board went blank with no error anywhere.
// So each ROW is its own display entity and its own small command, which
// lifts that cap - the grid can be far wider and taller than before.
//
// Terrain is sampled once and written once, because it does not change.
// Only rows that currently hold a player get rewritten each cycle, so a
// 100-row board costs a couple of commands a second rather than a hundred.
//
//   /micromap here      (op) place it where you stand, facing you
//   /micromap centre    (op) re-aim the depicted area on where you stand
//   /micromap scale N   (op) world blocks per cell - this is what sets coverage
//   /micromap size N    (op) how physically big the hologram is
//   /micromap grid W H  (op) cells across and down - this is the detail knob
//   /micromap remove    (op) take it down
//
// A WORD ON LIMITS, because they are real and they bite silently:
// every cell costs a heightmap lookup at build time. A few thousand is
// instant; a few hundred thousand will lock the server up for minutes. Want
// to cover the whole world? Raise `scale`, which costs nothing. Want finer
// detail? Raise `grid`, which costs a lookup per cell. Roughly 300x150
// (45k cells) is a sane ceiling on this hardware.
//
// HAZARDS, all found the hard way here, not in docs:
//   1. No top-level declarations - server scripts share one scope and a
//      collision silently kills whichever loads second.
//   2. `var` not const/let inside try blocks - this Rhino throws
//      "redeclaration of var" on the FIRST call otherwise.
//   3. Math.PI is undefined; inline any constant or coords become NaN.
//   4. Display JSON rides in a SINGLE-QUOTED SNBT string: double the
//      backslashes, and never let an apostrophe into the text.

(function () {
    var CONFIG_PATH = 'kubejs/config/micromap.json'
    var TAG = 'educraft_micromap'
    var TICKS = 20
    var MAX_CELLS = 60000   // refuse past this rather than freeze the server

    var Heightmap = Java.loadClass('net.minecraft.world.level.levelgen.Heightmap$Types')
    var IntegerArgumentType = Java.loadClass('com.mojang.brigadier.arguments.IntegerArgumentType')

    function colourFor(id) {
        if (id.indexOf('water') !== -1) return '#2F5FD0'
        if (id.indexOf('lava') !== -1) return '#E25822'
        if (id.indexOf('ice') !== -1) return '#9FD8F0'
        if (id.indexOf('snow') !== -1) return '#F2F2F2'
        if (id.indexOf('sand') !== -1) return '#DBCB8A'
        if (id.indexOf('gravel') !== -1) return '#9A9A9A'
        if (id.indexOf('grass') !== -1 || id.indexOf('moss') !== -1) return '#4C8B3F'
        if (id.indexOf('leaves') !== -1) return '#2F6B2A'
        if (id.indexOf('log') !== -1 || id.indexOf('wood') !== -1 ||
            id.indexOf('plank') !== -1) return '#A0693B'
        if (id.indexOf('dirt') !== -1 || id.indexOf('podzol') !== -1 ||
            id.indexOf('mud') !== -1 || id.indexOf('farmland') !== -1) return '#7A5434'
        if (id.indexOf('stone') !== -1 || id.indexOf('andesite') !== -1 ||
            id.indexOf('granite') !== -1 || id.indexOf('diorite') !== -1 ||
            id.indexOf('deepslate') !== -1 || id.indexOf('cobble') !== -1) return '#8A8A8A'
        if (id === 'minecraft:air' || id === 'minecraft:cave_air') return '#101010'
        return '#D03030'
    }

    function loadConfig() {
        var raw = null
        try { raw = JsonIO.read(CONFIG_PATH) } catch (e) { raw = null }
        function get(k, d) {
            if (!raw) return d
            try {
                var v = raw[k]
                return (v === undefined || v === null) ? d : v
            } catch (e) { return d }
        }
        return {
            dim: String(get('dim', '')),
            x: Number(get('x', 0)),
            y: Number(get('y', 0)),
            z: Number(get('z', 0)),
            yaw: Number(get('yaw', 0)),
            cx: Number(get('cx', 0)),
            cz: Number(get('cz', 0)),
            scale: Number(get('scale', 32)),
            size: Number(get('size', 4)),
            cols: Number(get('cols', 161)),
            rows: Number(get('rows', 81))
        }
    }

    var cfg = loadConfig()
    var terrain = null
    var lastMarkRows = []

    function saveConfig() {
        try {
            JsonIO.write(CONFIG_PATH, {
                dim: cfg.dim, x: cfg.x, y: cfg.y, z: cfg.z, yaw: cfg.yaw,
                cx: cfg.cx, cz: cfg.cz, scale: cfg.scale, size: cfg.size,
                cols: cfg.cols, rows: cfg.rows
            })
            return true
        } catch (e) {
            console.error('[micromap] could not write ' + CONFIG_PATH + ': ' + e)
            return false
        }
    }

    function ready() { return cfg.dim !== '' }

    function dimOf(level) {
        try {
            var d = level.dimension
            var raw = (d && typeof d.location === 'function') ? String(d.location()) : String(d)
            if (/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(raw)) return raw
            var m = /([a-z0-9_.-]+:[a-z0-9_./-]+)\s*\]?\s*$/.exec(raw)
            if (m) return m[1]
        } catch (e) {}
        return 'minecraft:overworld'
    }

    function snbtSafe(json) { return json.split('\\').join('\\\\') }

    function sample(level) {
        var halfC = Math.floor(cfg.cols / 2)
        var halfR = Math.floor(cfg.rows / 2)
        var grid = []
        for (var row = 0; row < cfg.rows; row++) {
            var line = []
            for (var col = 0; col < cfg.cols; col++) {
                var wx = cfg.cx + (col - halfC) * cfg.scale
                var wz = cfg.cz + (row - halfR) * cfg.scale
                var id = 'minecraft:air'
                try {
                    var h = level.getHeight(Heightmap.WORLD_SURFACE, wx, wz)
                    id = String(level.getBlock(wx, h - 1, wz).id)
                } catch (e) {}
                line.push(colourFor(id))
            }
            grid.push(line)
        }
        terrain = grid
    }

    // One row of cells, with any player marks drawn over the terrain. Runs of
    // identical colour merge into a single component to keep the command short.
    function rowJson(row, marks) {
        var parts = []
        var runColour = null
        var runText = ''
        for (var c = 0; c < cfg.cols; c++) {
            var mark = marks[row + ':' + c]
            var colour = mark ? '#FFFFFF' : terrain[row][c]
            var ch = mark ? mark : '\\u2588'
            if (colour !== runColour) {
                if (runColour !== null) parts.push('{"text":"' + runText + '","color":"' + runColour + '"}')
                runColour = colour
                runText = ch
            } else {
                runText += ch
            }
        }
        if (runColour !== null) parts.push('{"text":"' + runText + '","color":"' + runColour + '"}')
        return '{"text":"","extra":[' + parts.join(',') + ']}'
    }

    function markMap(server) {
        var halfC = Math.floor(cfg.cols / 2)
        var halfR = Math.floor(cfg.rows / 2)
        var marks = {}
        var rows = []
        var players = server.players
        for (var i = 0; i < players.length; i++) {
            var p = players[i]
            var nm = String(p.username)
            if (!/^[A-Za-z0-9_]{1,16}$/.test(nm)) continue
            if (dimOf(p.level) !== cfg.dim) continue
            var col = Math.round((p.x - cfg.cx) / cfg.scale) + halfC
            var row = Math.round((p.z - cfg.cz) / cfg.scale) + halfR
            if (col < 0 || col >= cfg.cols || row < 0 || row >= cfg.rows) continue
            marks[row + ':' + col] = nm.substring(0, 1).toUpperCase()
            rows.push(row)
        }
        return { marks: marks, rows: rows }
    }

    function writeRow(server, row, marks) {
        server.runCommandSilent('execute as @e[tag=' + TAG + '_r' + row + '] run data merge entity @s ' +
            "{text:'" + snbtSafe(rowJson(row, marks)) + "'}")
    }

    // Only rewrite rows holding a player now, plus rows that held one last
    // cycle and need clearing. Terrain rows are written once and left alone.
    function refresh(server) {
        if (!ready() || !terrain) return
        var mm = markMap(server)
        var touch = {}
        var i
        for (i = 0; i < mm.rows.length; i++) touch[mm.rows[i]] = true
        for (i = 0; i < lastMarkRows.length; i++) touch[lastMarkRows[i]] = true
        for (var key in touch) writeRow(server, Number(key), mm.marks)
        lastMarkRows = mm.rows
    }

    function place(server) {
        server.runCommandSilent('kill @e[type=minecraft:text_display,tag=' + TAG + ']')
        // A text line is about a quarter block tall at scale 1, so spacing
        // rows by that times size keeps them flush: no gaps, no overlap.
        var step = 0.25 * cfg.size
        var top = cfg.y + (cfg.rows * step) / 2
        var mm = markMap(server)
        for (var row = 0; row < cfg.rows; row++) {
            var y = top - row * step
            var nbt = '{Tags:["' + TAG + '","' + TAG + '_r' + row + '"]' +
                ',billboard:"fixed",background:0,alignment:"center"' +
                ',line_width:8000,Rotation:[' + cfg.yaw + 'f,0.0f]' +
                ',transformation:{left_rotation:[0f,0f,0f,1f],right_rotation:[0f,0f,0f,1f]' +
                ',translation:[0f,0f,0f],scale:[' + cfg.size + 'f,' + cfg.size + 'f,' + cfg.size + 'f]}' +
                ',text:' + "'" + snbtSafe(rowJson(row, mm.marks)) + "'" + '}'
            server.runCommandSilent('execute in ' + cfg.dim + ' run summon minecraft:text_display ' +
                cfg.x + ' ' + y + ' ' + cfg.z + ' ' + nbt)
        }
        lastMarkRows = mm.rows
    }

    var ticks = 0
    ServerEvents.tick(event => {
        ticks++
        if (ticks % TICKS !== 0) return
        refresh(event.server)
    })

    ServerEvents.commandRegistry(event => {
        var Commands = event.commands
        var requireOp = src => src.hasPermission(2)

        function tooBig(player) {
            var cells = cfg.cols * cfg.rows
            if (cells <= MAX_CELLS) return false
            if (player) {
                player.tell(Text.red(cells + ' cells is too many - each one costs a terrain lookup'))
                player.tell(Text.white('and the server would lock up. Cap is ' + MAX_CELLS + '.'))
                player.tell(Text.gray('For more coverage raise /micromap scale instead - that is free.'))
            }
            return true
        }

        function rebuild(ctx, msg) {
            var player = ctx.source.player
            if (tooBig(player)) return 0
            saveConfig()
            if (player) {
                sample(player.level)
                place(ctx.source.server)
                player.tell(Text.green(msg))
            }
            return 1
        }

        event.register(
            Commands.literal('micromap')
                .then(Commands.literal('here').requires(requireOp).executes(ctx => {
                    var player = ctx.source.player
                    if (!player) return 0
                    var yaw = 0
                    try { yaw = Number(player.yaw) } catch (e) {}
                    if (isNaN(yaw)) { try { yaw = Number(player.yRot) } catch (e) { yaw = 0 } }
                    if (isNaN(yaw)) yaw = 0
                    cfg.dim = dimOf(player.level)
                    cfg.x = player.x
                    cfg.y = player.y + 2
                    cfg.z = player.z
                    cfg.yaw = yaw
                    if (cfg.cx === 0 && cfg.cz === 0) {
                        cfg.cx = Math.floor(player.x)
                        cfg.cz = Math.floor(player.z)
                    }
                    player.tell(Text.gray('Sampling ' + (cfg.cols * cfg.rows) + ' cells...'))
                    return rebuild(ctx, 'Map placed: ' + (cfg.cols * cfg.scale) + ' x ' +
                        (cfg.rows * cfg.scale) + ' blocks of world.')
                }))
                .then(Commands.literal('centre').requires(requireOp).executes(ctx => {
                    var player = ctx.source.player
                    if (!player) return 0
                    cfg.cx = Math.floor(player.x)
                    cfg.cz = Math.floor(player.z)
                    return rebuild(ctx, 'Re-centred on ' + cfg.cx + ', ' + cfg.cz + '.')
                }))
                .then(Commands.literal('scale').requires(requireOp).then(
                    Commands.argument('n', IntegerArgumentType.integer(1, 512)).executes(ctx => {
                        cfg.scale = IntegerArgumentType.getInteger(ctx, 'n')
                        return rebuild(ctx, '1 cell = ' + cfg.scale + ' blocks, covering ' +
                            (cfg.cols * cfg.scale) + ' x ' + (cfg.rows * cfg.scale) + '.')
                    })
                ))
                .then(Commands.literal('size').requires(requireOp).then(
                    Commands.argument('n', IntegerArgumentType.integer(1, 40)).executes(ctx => {
                        cfg.size = IntegerArgumentType.getInteger(ctx, 'n')
                        return rebuild(ctx, 'Hologram size x' + cfg.size + '.')
                    })
                ))
                .then(Commands.literal('grid').requires(requireOp).then(
                    Commands.argument('w', IntegerArgumentType.integer(11, 501)).then(
                        Commands.argument('h', IntegerArgumentType.integer(5, 301)).executes(ctx => {
                            cfg.cols = IntegerArgumentType.getInteger(ctx, 'w')
                            cfg.rows = IntegerArgumentType.getInteger(ctx, 'h')
                            return rebuild(ctx, 'Grid ' + cfg.cols + ' x ' + cfg.rows + ' cells.')
                        })
                    )
                ))
                .then(Commands.literal('remove').requires(requireOp).executes(ctx => {
                    ctx.source.server.runCommandSilent('kill @e[type=minecraft:text_display,tag=' + TAG + ']')
                    cfg.dim = ''
                    saveConfig()
                    if (ctx.source.player) ctx.source.player.tell(Text.green('Map removed.'))
                    return 1
                }))
        )
    })
})()
