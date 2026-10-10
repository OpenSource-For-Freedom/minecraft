(function () {
    // Verified live on this server: Commands.string() does not exist;
    // the Brigadier string type lives on StringArgumentType.
    var StringArgumentType = Java.loadClass('com.mojang.brigadier.arguments.StringArgumentType')
    var CONFIG_PATH = 'kubejs/config/live_board.json'
    var TAG = 'educraft_liveboard'
    var REFRESH_TICKS = 60      // 3s
    var GRID_W = 25             // characters across
    var GRID_H = 11             // rows
    var RANGE = 160             // blocks from centre to grid edge

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
        var marks = []
        try {
            var raw_marks = get('landmarks', null)
            if (raw_marks) {
                for (var i = 0; i < raw_marks.length; i++) {
                    var m = raw_marks[i]
                    marks.push({
                        name: String(m.name || '?'),
                        x: Number(m.x || 0),
                        z: Number(m.z || 0)
                    })
                }
            }
        } catch (e) {}
        return {
            dim: String(get('dim', '')),
            x: Number(get('x', 0)),
            y: Number(get('y', 0)),
            z: Number(get('z', 0)),
            yaw: Number(get('yaw', 0)),
            landmarks: marks
        }
    }

    var cfg = loadConfig()

    function saveConfig() {
        try {
            JsonIO.write(CONFIG_PATH, { dim: cfg.dim, x: cfg.x, y: cfg.y, z: cfg.z, yaw: cfg.yaw, landmarks: cfg.landmarks })
            return true
        } catch (e) {
            console.error('[liveboard] could not write ' + CONFIG_PATH + ': ' + e)
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

    // Strip anything that would break the SNBT/JSON transport. Player names
    // are already limited to word characters, but a nickname mod could change
    // that, and a stray apostrophe would silently kill the whole refresh.
    function safe(s) {
        return String(s).replace(/[^A-Za-z0-9_ .:\-\/]/g, '')
    }

    function snbtSafe(json) {
        return json.split('\\').join('\\\\')
    }

    // ------------------------------------------------------------- radar --

    function buildRadar(server) {
        var rows = []
        var r, c
        for (r = 0; r < GRID_H; r++) {
            var row = []
            for (c = 0; c < GRID_W; c++) row.push('.')
            rows.push(row)
        }

        // Centre marker - the board itself, i.e. spawn.
        var midR = Math.floor(GRID_H / 2)
        var midC = Math.floor(GRID_W / 2)
        rows[midR][midC] = '+'

        // Landmarks first, so a player standing on one still shows as the
        // player - who is where matters more at a glance than what is there.
        for (var k = 0; k < cfg.landmarks.length; k++) {
            var lm = cfg.landmarks[k]
            var lc = midC + Math.round(((lm.x - cfg.x) / RANGE) * midC)
            var lr = midR + Math.round(((lm.z - cfg.z) / RANGE) * midR)
            if (lc < 0 || lc >= GRID_W || lr < 0 || lr >= GRID_H) continue
            rows[lr][lc] = '#'
        }

        var plotted = []
        var players = server.players
        for (var i = 0; i < players.length; i++) {
            var p = players[i]
            if (dimOf(p.level) !== cfg.dim) continue

            var dx = p.x - cfg.x
            var dz = p.z - cfg.z
            var gc = midC + Math.round((dx / RANGE) * midC)
            var gr = midR + Math.round((dz / RANGE) * midR)
            if (gc < 0) gc = 0
            if (gc >= GRID_W) gc = GRID_W - 1
            if (gr < 0) gr = 0
            if (gr >= GRID_H) gr = GRID_H - 1

            var letter = safe(String(p.username).substring(0, 1)).toUpperCase()
            if (letter === '') letter = '?'
            rows[gr][gc] = letter
            plotted.push(p)
        }

        var out = []
        for (r = 0; r < GRID_H; r++) out.push(rows[r].join(''))
        return { grid: out, players: plotted }
    }

    function activeChallenge(p) {
        try {
            var id = String(p.persistentData.getString('challengeId') || '')
            return id === '' ? '' : id
        } catch (e) { return '' }
    }

    function badgeCount(p) {
        try {
            var raw = String(p.persistentData.getString('badges') || '')
            if (raw === '') return 0
            return raw.split(',').filter(b => b !== '').length
        } catch (e) { return 0 }
    }

    function buildJson(server) {
        var radar = buildRadar(server)
        var parts = []

        parts.push('{"text":"TACTICAL MAP\\n","bold":true,"color":"gold"}')
        parts.push('{"text":"' + RANGE + ' blocks across, + is spawn\\n\\n","color":"dark_gray"}')

        for (var r = 0; r < radar.grid.length; r++) {
            parts.push('{"text":"' + safe(radar.grid[r]) + '\\n","color":"green"}')
        }

        parts.push('{"text":"\\n"}')

        if (radar.players.length === 0) {
            parts.push('{"text":"nobody online\\n","color":"dark_gray"}')
        } else {
            for (var i = 0; i < radar.players.length; i++) {
                var p = radar.players[i]
                var dx = p.x - cfg.x
                var dz = p.z - cfg.z
                var dist = Math.floor(Math.sqrt(dx * dx + dz * dz))
                var ch = activeChallenge(p)
                var bc = badgeCount(p)
                parts.push('{"text":"' + safe(p.username) + '  ","color":"aqua"}')
                parts.push('{"text":"' + dist + 'm out","color":"white"}')
                if (bc > 0) parts.push('{"text":"  ' + bc + ' badges","color":"yellow"}')
                if (ch !== '') parts.push('{"text":"  on: ' + safe(ch) + '","color":"gray"}')
                parts.push('{"text":"\\n"}')
            }
        }

        if (cfg.landmarks.length > 0) {
            parts.push('{"text":"\\nLandmarks  ","color":"gold"}')
            parts.push('{"text":"#\\n","color":"light_purple"}')
            for (var L = 0; L < cfg.landmarks.length; L++) {
                var lm2 = cfg.landmarks[L]
                var ldx = lm2.x - cfg.x
                var ldz = lm2.z - cfg.z
                var ldist = Math.floor(Math.sqrt(ldx * ldx + ldz * ldz))
                parts.push('{"text":"  ' + safe(lm2.name) + '  ","color":"light_purple"}')
                parts.push('{"text":"' + ldist + 'm\\n","color":"gray"}')
            }
        }

        parts.push('{"text":"\\nNo PvP. Nobody can break your builds.","color":"gray"}')
        return '{"text":"","extra":[' + parts.join(',') + ']}'
    }

    function refresh(server) {
        if (!ready()) return
        var json = buildJson(server)
        if (json.indexOf("'") !== -1) return
        server.runCommandSilent("execute as @e[tag=" + TAG + "] run data merge entity @s {text:'" + snbtSafe(json) + "'}")
    }

    function place(server) {
        server.runCommandSilent('kill @e[type=minecraft:text_display,tag=' + TAG + ']')
        // background 0x30000000: darker alpha than the other boards so the
        // radar grid stays legible while still reading as a hologram.
        var nbt = '{Tags:["' + TAG + '"],billboard:"fixed",background:805306368' +
            ',line_width:400,alignment:"center",text_opacity:230b' +
            ',Rotation:[' + cfg.yaw + 'f,0.0f]' +
            ',text:' + "'" + '{"text":"starting up...","color":"gray"}' + "'" + '}'
        server.runCommandSilent('execute in ' + cfg.dim + ' run summon minecraft:text_display ' +
            cfg.x + ' ' + cfg.y + ' ' + cfg.z + ' ' + nbt)
    }

    var ticks = 0
    ServerEvents.tick(event => {
        ticks++
        if (ticks % REFRESH_TICKS !== 0) return
        refresh(event.server)
    })

    ServerEvents.commandRegistry(event => {
        var Commands = event.commands
        var requireOp = src => src.hasPermission(2)

        event.register(
            Commands.literal('liveboard')
                .then(Commands.literal('here').requires(requireOp).executes(ctx => {
                    var player = ctx.source.player
                    if (!player) return 0
                    var yaw = 0
                    try { yaw = Number(player.yaw) } catch (e) {}
                    if (isNaN(yaw)) { try { yaw = Number(player.yRot) } catch (e) { yaw = 0 } }
                    if (isNaN(yaw)) yaw = 0
                    cfg.dim = dimOf(player.level)
                    cfg.x = player.x
                    cfg.y = player.y + 1.6
                    cfg.z = player.z
                    // Matches the leaderboard, which renders correctly: the
                    // display takes the op own yaw, NOT yaw+180. Flipping it
                    // put the text facing away and it read as invisible.
                    cfg.yaw = yaw
                    saveConfig()
                    place(ctx.source.server)
                    refresh(ctx.source.server)
                    player.tell(Text.green('Live map placed. Step back a few blocks to read it.'))
                    return 1
                }))
                .then(Commands.literal('refresh').requires(requireOp).executes(ctx => {
                    refresh(ctx.source.server)
                    return 1
                }))
                // Mark whatever you are standing on - a big build, a launch
                // pad, a base - so it shows as # on the radar with its name
                // and distance underneath.
                .then(Commands.literal('mark').requires(requireOp).then(
                    Commands.argument('name', StringArgumentType.greedyString()).executes(ctx => {
                        var player = ctx.source.player
                        if (!player) return 0
                        var nm = safe(StringArgumentType.getString(ctx, 'name'))
                        if (nm === '') {
                            player.tell(Text.red('That name has no usable characters.'))
                            return 0
                        }
                        cfg.landmarks.push({ name: nm, x: player.x, z: player.z })
                        saveConfig()
                        refresh(ctx.source.server)
                        player.tell(Text.green('Marked ' + nm + ' on the live map.'))
                        return 1
                    })
                ))
                .then(Commands.literal('unmark').requires(requireOp).then(
                    Commands.argument('name', StringArgumentType.greedyString()).executes(ctx => {
                        var player = ctx.source.player
                        if (!player) return 0
                        var nm2 = safe(StringArgumentType.getString(ctx, 'name'))
                        var kept = []
                        var removed = 0
                        for (var i = 0; i < cfg.landmarks.length; i++) {
                            if (cfg.landmarks[i].name === nm2) { removed++; continue }
                            kept.push(cfg.landmarks[i])
                        }
                        cfg.landmarks = kept
                        saveConfig()
                        refresh(ctx.source.server)
                        player.tell(removed > 0
                            ? Text.green('Removed ' + removed + ' landmark(s) named ' + nm2 + '.')
                            : Text.gold('No landmark called ' + nm2 + '.'))
                        return 1
                    })
                ))
                .then(Commands.literal('remove').requires(requireOp).executes(ctx => {
                    ctx.source.server.runCommandSilent('kill @e[type=minecraft:text_display,tag=' + TAG + ']')
                    cfg.dim = ''
                    saveConfig()
                    if (ctx.source.player) ctx.source.player.tell(Text.green('Live map removed.'))
                    return 1
                }))
        )
    })
})()
