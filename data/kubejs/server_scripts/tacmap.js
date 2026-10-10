(function () {
    var CONFIG_PATH = 'kubejs/config/tacmap.json'
    var TICKS = 10   // twice a second - smooth enough to feel live

    var IntegerArgumentType = Java.loadClass('com.mojang.brigadier.arguments.IntegerArgumentType')

    function loadConfig() {
        var raw = null
        try { raw = JsonIO.read(CONFIG_PATH) } catch (e) { raw = null }
        var cell = 128
        try {
            if (raw && raw.cell !== undefined && raw.cell !== null) cell = Number(raw.cell)
        } catch (e) {}
        function get(k, d) {
            if (!raw) return d
            try {
                var v = raw[k]
                return (v === undefined || v === null) ? d : v
            } catch (e) { return d }
        }
        return {
            cell: cell,
            dim: String(get('dim', '')),
            x: Number(get('x', 0)),
            y: Number(get('y', 0)),
            z: Number(get('z', 0)),
            yaw: Number(get('yaw', 0))
        }
    }

    var cfg = loadConfig()

    function saveConfig() {
        try {
            JsonIO.write(CONFIG_PATH, { cell: cfg.cell, dim: cfg.dim, x: cfg.x, y: cfg.y, z: cfg.z, yaw: cfg.yaw })
            return true
        } catch (e) {
            console.error('[tacmap] could not write ' + CONFIG_PATH + ': ' + e)
            return false
        }
    }

    // Column letters run A..Z then AA, AB, ... so the grid never runs out of
    // labels however far anyone travels. Negative coordinates get a leading
    // minus rather than wrapping, so west of origin reads -A, -B and stays
    // unambiguous.
    function colLabel(index) {
        var neg = index < 0
        var n = neg ? -index - 1 : index
        var s = ''
        while (true) {
            s = String.fromCharCode(65 + (n % 26)) + s
            n = Math.floor(n / 26) - 1
            if (n < 0) break
        }
        return (neg ? '-' : '') + s
    }

    // Real world coordinates. An earlier version used letter-grid labels
    // (A1, B7) anchored at world origin, which read as nonsense like -B-2
    // for a base sitting in negative coordinates.
    function gridRef(x, y, z) {
        return Math.floor(x) + ', ' + Math.floor(y) + ', ' + Math.floor(z)
    }

    function enabled(player) {
        try { return player.persistentData.getBoolean('tacmap') } catch (e) { return false }
    }

    function setEnabled(player, on) {
        try { player.persistentData.putBoolean('tacmap', on) } catch (e) {}
    }

    function safeName(n) {
        return String(n).replace(/[^A-Za-z0-9_]/g, '')
    }

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

    function sendBar(server, viewer, players) {
        var name = safeName(viewer.username)
        if (name === '') return

        var parts = []
        var mine = gridRef(viewer.x, viewer.y, viewer.z)
        parts.push('{"text":"' + mine + '","bold":true,"color":"gold"}')

        var others = 0
        for (var i = 0; i < players.length; i++) {
            var p = players[i]
            if (p === viewer) continue
            var pn = safeName(p.username)
            if (pn === '') continue
            if (others === 0) parts.push('{"text":"   ","color":"white"}')
            else parts.push('{"text":"  ","color":"white"}')
            // Short name keeps the bar readable when several are online.
            var short = pn.length > 8 ? pn.substring(0, 8) : pn
            var sameDim = dimOf(p.level) === dimOf(viewer.level)
            parts.push('{"text":"' + short + ' ","color":"' + (sameDim ? 'aqua' : 'dark_gray') + '"}')
            parts.push('{"text":"' + (sameDim ? gridRef(p.x, p.y, p.z) : 'away') +
                       '","color":"' + (sameDim ? 'white' : 'dark_gray') + '"}')
            others++
        }

        var json = '{"text":"","extra":[' + parts.join(',') + ']}'
        if (json.indexOf("'") !== -1) return
        server.runCommandSilent("title " + name + " actionbar " + json)
    }

    // ------------------------------------------------------- hologram --

    var TAG = 'educraft_tacmap'

    function snbtSafe(json) { return json.split('\\').join('\\\\') }

    function boardJson(players) {
        var parts = []
        parts.push('{"text":"TACTICAL GRID\\n","bold":true,"color":"gold"}')
        parts.push('{"text":"live positions\\n\\n","color":"dark_gray"}')
        var shown = 0
        for (var i = 0; i < players.length; i++) {
            var p = players[i]
            if (!enabled(p)) continue        // opt-in: off means not listed
            var pn = safeName(p.username)
            if (pn === '') continue
            parts.push('{"text":"' + gridRef(p.x, p.y, p.z) + '  ","bold":true,"color":"aqua"}')
            parts.push('{"text":"' + pn + '\\n","color":"white"}')
            shown++
        }
        if (shown === 0) {
            parts.push('{"text":"nobody sharing position\\n","color":"dark_gray"}')
            parts.push('{"text":"run /tacmap to appear here","color":"gray"}')
        }
        return '{"text":"","extra":[' + parts.join(',') + ']}'
    }

    function refreshBoard(server) {
        if (cfg.dim === '') return
        var json = boardJson(server.players)
        if (json.indexOf("'") !== -1) return
        server.runCommandSilent("execute as @e[tag=" + TAG + "] run data merge entity @s {text:'" +
            snbtSafe(json) + "'}")
    }

    function placeBoard(server) {
        server.runCommandSilent('kill @e[type=minecraft:text_display,tag=' + TAG + ']')
        var nbt = '{Tags:["' + TAG + '"],billboard:"fixed",background:1275068416' +
            ',line_width:300,alignment:"center",Rotation:[' + cfg.yaw + 'f,0.0f]' +
            ',text:' + "'" + '{"text":"starting...","color":"gray"}' + "'" + '}'
        server.runCommandSilent('execute in ' + cfg.dim + ' run summon minecraft:text_display ' +
            cfg.x + ' ' + cfg.y + ' ' + cfg.z + ' ' + nbt)
    }

    var ticks = 0
    ServerEvents.tick(event => {
        ticks++
        if (ticks % TICKS !== 0) return
        var server = event.server
        var players = server.players
        for (var i = 0; i < players.length; i++) {
            if (enabled(players[i])) sendBar(server, players[i], players)
        }
        refreshBoard(server)
    })

    ServerEvents.commandRegistry(event => {
        var Commands = event.commands
        var requireOp = src => src.hasPermission(2)

        event.register(
            Commands.literal('tacmap')
                .executes(ctx => {
                    var player = ctx.source.player
                    if (!player) return 0
                    var on = !enabled(player)
                    setEnabled(player, on)
                    if (on) {
                        player.tell(Text.green('Tactical grid ON - your square shows above your hotbar.'))
                        player.tell(Text.gray('Run /tacmap again to turn it off.'))
                    } else {
                        player.tell(Text.gray('Tactical grid off.'))
                        var nm = safeName(player.username)
                        if (nm !== '') ctx.source.server.runCommandSilent('title ' + nm + ' actionbar {"text":""}')
                    }
                    return 1
                })
                .then(Commands.literal('where').executes(ctx => {
                    var player = ctx.source.player
                    if (!player) return 0
                    player.tell(Text.gold('You are in grid square ' + gridRef(player.x, player.y, player.z))
                        .append(Text.gray('  (' + Math.floor(player.x) + ', ' + Math.floor(player.z) + ')')))
                    return 1
                }))
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
                    cfg.yaw = yaw
                    saveConfig()
                    placeBoard(ctx.source.server)
                    refreshBoard(ctx.source.server)
                    player.tell(Text.green('Grid board placed. Step back to read it.'))
                    return 1
                }))
                .then(Commands.literal('cell').requires(requireOp).then(
                    Commands.argument('n', IntegerArgumentType.integer(16, 1024)).executes(ctx => {
                        cfg.cell = IntegerArgumentType.getInteger(ctx, 'n')
                        saveConfig()
                        if (ctx.source.player) {
                            ctx.source.player.tell(Text.green('Grid squares are now ' + cfg.cell +
                                ' blocks across. You are in ' +
                                gridRef(ctx.source.player.x, ctx.source.player.y, ctx.source.player.z) + '.'))
                        }
                        return 1
                    })
                ))
        )
    })
})()
