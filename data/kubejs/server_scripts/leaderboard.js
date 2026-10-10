(function () {
    var CONFIG_PATH = 'kubejs/config/leaderboard.json'
    var TAG = 'educraft_leaderboard'
    var REFRESH_TICKS = 100 // 5s - fast enough to feel live, cheap enough to ignore

    // Each row: objective name, label, and how to render the raw score.
    var ROWS = [
        { obj: 'lb_playtime', label: 'Time Played', fmt: 'time' },
        { obj: 'lb_walked', label: 'Distance', fmt: 'dist' },
        { obj: 'lb_kills', label: 'Mobs Defeated', fmt: 'plain' },
        { obj: 'lb_jumps', label: 'Jumps', fmt: 'plain' }
    ]

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
            yaw: Number(get('yaw', 0))
        }
    }

    var cfg = loadConfig()

    function saveConfig() {
        try {
            JsonIO.write(CONFIG_PATH, { dim: cfg.dim, x: cfg.x, y: cfg.y, z: cfg.z, yaw: cfg.yaw })
            return true
        } catch (e) {
            console.error('[leaderboard] could not write ' + CONFIG_PATH + ': ' + e)
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

    // ------------------------------------------------------------ scores --

    // Every player the scoreboard knows about, not just the ones online, so
    // the board still shows the leader when they are offline.
    function trackedNames(server) {
        var names = []
        try {
            var tracked = server.scoreboard.getTrackedPlayers()
            var it = tracked.iterator()
            while (it.hasNext()) names.push(String(it.next()))
        } catch (e) {}
        if (names.length === 0) {
            try {
                var ps = server.players
                for (var i = 0; i < ps.length; i++) names.push(String(ps[i].username))
            } catch (e) {}
        }
        return names
    }

    function scoreOf(server, objName, playerName) {
        try {
            var sb = server.scoreboard
            var obj = sb.getObjective(objName)
            if (!obj) return 0
            return sb.getOrCreatePlayerScore(playerName, obj).getScore()
        } catch (e) { return 0 }
    }

    function render(value, how) {
        if (how === 'time') {
            var mins = Math.floor(value / 20 / 60)
            if (mins < 60) return mins + 'm'
            return Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm'
        }
        if (how === 'dist') {
            var m = Math.floor(value / 100)
            if (m < 1000) return m + 'm'
            return (Math.floor(m / 100) / 10) + 'km'
        }
        return String(value)
    }

    // ------------------------------------------------------------- build --

    function buildText(server) {
        var names = trackedNames(server)
        var parts = []
        parts.push('{"text":"EDUCRAFT LEADERBOARD\\n","bold":true,"color":"gold"}')
        parts.push('{"text":"\\n"}')

        for (var r = 0; r < ROWS.length; r++) {
            var row = ROWS[r]
            var best = null
            var bestVal = -1
            for (var i = 0; i < names.length; i++) {
                var v = scoreOf(server, row.obj, names[i])
                if (v > bestVal) { bestVal = v; best = names[i] }
            }
            parts.push('{"text":"' + row.label + '  ","color":"aqua"}')
            if (best === null || bestVal <= 0) {
                parts.push('{"text":"nobody yet\\n","color":"dark_gray"}')
            } else {
                parts.push('{"text":"' + best + ' ","color":"white"}')
                parts.push('{"text":"' + render(bestVal, row.fmt) + '\\n","color":"yellow"}')
            }
        }

        parts.push('{"text":"\\n"}')
        parts.push('{"text":"' + names.length + ' explorers so far","color":"gray"}')
        return '{"text":"","extra":[' + parts.join(',') + ']}'
    }

    // The JSON goes inside a SINGLE-QUOTED SNBT string, where backslash is
    // an escape character and an escaped newline is not valid SNBT - so it
    // silently kills the whole command. Doubling every backslash makes SNBT
    // unescape back to what the JSON parser wants. This cost a debugging
    // round: a manual test passed only because it had no newlines in it.
    function snbtSafe(json) {
        return json.split('\\').join('\\\\')
    }

    function refresh(server) {
        if (!ready()) return
        var json = buildText(server)
        if (json.indexOf("'") !== -1) return // would terminate the SNBT string
        server.runCommandSilent("execute as @e[tag=" + TAG + "] run data merge entity @s {text:'" + snbtSafe(json) + "'}")
    }

    function place(server) {
        server.runCommandSilent('kill @e[type=minecraft:text_display,tag=' + TAG + ']')
        var nbt = '{Tags:["' + TAG + '"],billboard:"fixed",background:1275068416' +
            ',line_width:300,alignment:"center",Rotation:[' + cfg.yaw + 'f,0.0f]' +
            ',text:' + "'" + '{"text":"loading...","color":"gray"}' + "'" + '}'
        server.runCommandSilent('execute in ' + cfg.dim + ' run summon minecraft:text_display ' +
            cfg.x + ' ' + cfg.y + ' ' + cfg.z + ' ' + nbt)
    }

    // -------------------------------------------------------------- tick --

    var ticks = 0
    ServerEvents.tick(event => {
        ticks++
        if (ticks % REFRESH_TICKS !== 0) return
        refresh(event.server)
    })

    // ---------------------------------------------------------- commands --

    ServerEvents.commandRegistry(event => {
        var Commands = event.commands
        var requireOp = src => src.hasPermission(2)

        event.register(
            Commands.literal('leaderboard')
                .then(Commands.literal('init').requires(requireOp).executes(ctx => {
                    var s = ctx.source.server
                    s.runCommandSilent('scoreboard objectives add lb_playtime minecraft.custom:minecraft.play_time {"text":"Playtime"}')
                    s.runCommandSilent('scoreboard objectives add lb_walked minecraft.custom:minecraft.walk_one_cm {"text":"Walked"}')
                    s.runCommandSilent('scoreboard objectives add lb_kills totalKillCount {"text":"Kills"}')
                    s.runCommandSilent('scoreboard objectives add lb_jumps minecraft.custom:minecraft.jump {"text":"Jumps"}')
                    if (ctx.source.player) ctx.source.player.tell(Text.green('Leaderboard objectives created.'))
                    return 1
                }))
                .then(Commands.literal('here').requires(requireOp).executes(ctx => {
                    var player = ctx.source.player
                    if (!player) return 0
                    cfg.dim = dimOf(player.level)
                    cfg.x = player.x
                    cfg.y = player.y + 2.4 // clear of head height, or the op placing it stands inside it and sees nothing
                    cfg.z = player.z
                    var yaw = 0
                    try { yaw = Number(player.yaw) } catch (e) {}
                    if (isNaN(yaw)) { try { yaw = Number(player.yRot) } catch (e) { yaw = 0 } }
                    cfg.yaw = isNaN(yaw) ? 0 : yaw
                    if (!saveConfig()) {
                        player.tell(Text.red('Placed, but the config did not save - it will be lost on restart.'))
                    }
                    place(ctx.source.server)
                    refresh(ctx.source.server)
                    player.tell(Text.green('Leaderboard placed here, facing the way you are.'))
                    return 1
                }))
                .then(Commands.literal('refresh').requires(requireOp).executes(ctx => {
                    refresh(ctx.source.server)
                    if (ctx.source.player) ctx.source.player.tell(Text.green('Refreshed.'))
                    return 1
                }))
                .then(Commands.literal('remove').requires(requireOp).executes(ctx => {
                    ctx.source.server.runCommandSilent('kill @e[type=minecraft:text_display,tag=' + TAG + ']')
                    cfg.dim = ''
                    saveConfig()
                    if (ctx.source.player) ctx.source.player.tell(Text.green('Leaderboard removed.'))
                    return 1
                }))
        )
    })
})()
