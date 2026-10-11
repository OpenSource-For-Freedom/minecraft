(function () {
    var CONFIG_PATH = 'kubejs/config/challenges.json'
    var TAG = 'educraft_challenges'
    var CHECK_TICKS = 100 // 5s

    // Each challenge: a scoreboard objective to watch, how much progress is
    // needed from the moment of signup, and the badge/trophy awarded.
    // reward: item stacks handed over on completion, on top of the badge and
    // the named trophy. Kept to vanilla ids so nothing here depends on a mod
    // staying installed.
    var CHALLENGES = [
        { id: 'explorer', name: 'Explorer', obj: 'ch_walked', need: 200000,
          desc: 'Walk 2000 blocks', unit: 'blocks', div: 100, badge: 'Explorer',
          reward: ['minecraft:diamond 3', 'minecraft:compass 1', 'minecraft:cooked_beef 16'] },
        { id: 'jumper', name: 'Jumper', obj: 'ch_jumps', need: 1000,
          desc: 'Jump 1000 times', unit: 'jumps', div: 1, badge: 'Jumper',
          reward: ['minecraft:iron_ingot 8', 'minecraft:slime_block 4'] },
        { id: 'miner', name: 'Miner', obj: 'ch_mined', need: 200,
          desc: 'Mine 200 stone', unit: 'stone', div: 1, badge: 'Miner',
          reward: ['minecraft:iron_pickaxe 1', 'minecraft:iron_ingot 16', 'minecraft:torch 64'] },
        { id: 'hunter', name: 'Monster Hunter', obj: 'ch_kills', need: 100,
          desc: 'Defeat 100 mobs', unit: 'mobs', div: 1, badge: 'Monster Hunter',
          reward: ['minecraft:iron_sword 1', 'minecraft:shield 1', 'minecraft:golden_apple 2'] },
        { id: 'dedicated', name: 'Dedicated', obj: 'ch_playtime', need: 576000,
          desc: 'Play for 8 hours', unit: 'minutes', div: 1200, badge: 'Dedicated',
          reward: ['minecraft:diamond 10', 'minecraft:experience_bottle 16'] },
        // Not stat-backed: no vanilla statistic tracks "left the planet", so
        // this one is completed by the tick check noticing the player is
        // standing in an Ad Astra dimension. See SPACE_DIMS below.
        { id: 'spacewalker', name: 'Space Walker', obj: '', need: 0, special: 'space',
          desc: 'Travel to space', unit: '', div: 1, badge: 'Space Walker',
          reward: ['minecraft:diamond 20', 'minecraft:elytra 1'] }
    ]

    // Any dimension that counts as "space" for the Space Walker challenge.
    // Matched by prefix so every Ad Astra planet, moon and orbit qualifies
    // without having to enumerate them all as the mod adds more.
    var SPACE_DIMS = ['ad_astra:']

    function byId(id) {
        for (var i = 0; i < CHALLENGES.length; i++) {
            if (CHALLENGES[i].id === id) return CHALLENGES[i]
        }
        return null
    }

    // ------------------------------------------------------------ config --

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
            console.error('[challenges] could not write ' + CONFIG_PATH + ': ' + e)
            return false
        }
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

    // ------------------------------------------------------------ scores --

    function scoreOf(server, objName, playerName) {
        try {
            var sb = server.scoreboard
            var obj = sb.getObjective(objName)
            if (!obj) return 0
            return sb.getOrCreatePlayerScore(playerName, obj).getScore()
        } catch (e) { return 0 }
    }

    // ------------------------------------------------------------ badges --

    function badgeList(player) {
        var raw = player.persistentData.getString('badges')
        if (!raw) return []
        return String(raw).split(',').filter(b => b !== '')
    }

    function hasBadge(player, badge) {
        return badgeList(player).indexOf(badge) !== -1
    }

    function addBadge(player, badge) {
        var list = badgeList(player)
        if (list.indexOf(badge) !== -1) return
        list.push(badge)
        player.persistentData.putString('badges', list.join(','))
    }

    // ------------------------------------------------------------ signup --

    function activeId(player) {
        return String(player.persistentData.getString('challengeId') || '')
    }

    function join(server, player, ch) {
        var name = String(player.username)
        player.persistentData.putString('challengeId', ch.id)
        player.persistentData.putInt('challengeBase', scoreOf(server, ch.obj, name))
        player.tell(Text.gold('Challenge accepted: ' + ch.name))
        player.tell(Text.white('  ' + ch.desc))
        player.tell(Text.gray('  Track it with /challenge status'))
    }

    function progressOf(server, player, ch) {
        var name = String(player.username)
        var now = scoreOf(server, ch.obj, name)
        var base = player.persistentData.getInt('challengeBase')
        var done = now - base
        return done < 0 ? 0 : done
    }

    function complete(server, player, ch) {
        player.persistentData.putString('challengeId', '')
        player.persistentData.putInt('challengeBase', 0)
        addBadge(player, ch.badge)

        var name = String(player.username)
        if (/^[A-Za-z0-9_]{1,16}$/.test(name)) {
            // A physical trophy, named for the badge, so the achievement is
            // something they can actually hold and show off.
            server.runCommandSilent('give ' + name +
                ' minecraft:heart_of_the_sea[custom_name=' +
                "'" + '{"text":"' + ch.badge + ' Badge","color":"gold","italic":false}' + "'" + ']')
            var rewards = ch.reward || []
            for (var i = 0; i < rewards.length; i++) {
                server.runCommandSilent('give ' + name + ' ' + rewards[i])
            }
        }

        player.tell(Text.gold('*** CHALLENGE COMPLETE: ' + ch.name + ' ***'))
        player.tell(Text.green('Badge earned: ' + ch.badge))
        var rl = ch.reward || []
        if (rl.length > 0) {
            player.tell(Text.yellow('Rewards:'))
            for (var j = 0; j < rl.length; j++) {
                var bits = String(rl[j]).split(' ')
                var item = bits[0].replace('minecraft:', '').split('_').join(' ')
                player.tell(Text.white('  ' + (bits[1] || '1') + 'x ' + item))
            }
        }
        player.tell(Text.gray('See all your badges with /badges'))
        server.tell(Text.yellow(name + ' earned the ' + ch.badge + ' badge!'))
    }

    // ------------------------------------------------------------- board --

    function snbtSafe(json) {
        return json.split('\\').join('\\\\')
    }

    function boardJson() {
        var parts = []
        parts.push('{"text":"CHALLENGE BOARD\\n","bold":true,"color":"gold"}')
        parts.push('{"text":"\\n"}')
        for (var i = 0; i < CHALLENGES.length; i++) {
            var c = CHALLENGES[i]
            parts.push('{"text":"' + c.name + '  ","color":"aqua"}')
            parts.push('{"text":"' + c.desc + '\\n","color":"white"}')
        }
        parts.push('{"text":"\\n"}')
        parts.push('{"text":"/challenge join <name>","color":"green"}')
        parts.push('{"text":"  to sign up\\n","color":"gray"}')
        parts.push('{"text":"/badges","color":"green"}')
        parts.push('{"text":"  to see what you have earned","color":"gray"}')
        return '{"text":"","extra":[' + parts.join(',') + ']}'
    }

    function placeBoard(server) {
        server.runCommandSilent('kill @e[type=minecraft:text_display,tag=' + TAG + ']')
        var nbt = '{Tags:["' + TAG + '"],billboard:"fixed",background:1275068416' +
            ',line_width:320,alignment:"center",Rotation:[' + cfg.yaw + 'f,0.0f]' +
            ',text:' + "'" + snbtSafe(boardJson()) + "'" + '}'
        server.runCommandSilent('execute in ' + cfg.dim + ' run summon minecraft:text_display ' +
            cfg.x + ' ' + cfg.y + ' ' + cfg.z + ' ' + nbt)
    }

    // -------------------------------------------------------------- tick --

    var ticks = 0
    ServerEvents.tick(event => {
        ticks++
        if (ticks % CHECK_TICKS !== 0) return
        var server = event.server
        var players = server.players
        for (var i = 0; i < players.length; i++) {
            var p = players[i]
            var id = activeId(p)
            if (id === '') continue
            var ch = byId(id)
            if (!ch) continue

            if (ch.special === 'space') {
                var here = dimOf(p.level)
                var inSpace = false
                for (var d = 0; d < SPACE_DIMS.length; d++) {
                    if (here.indexOf(SPACE_DIMS[d]) === 0) inSpace = true
                }
                if (inSpace) complete(server, p, ch)
                continue
            }

            if (progressOf(server, p, ch) >= ch.need) complete(server, p, ch)
        }
    })

    // ---------------------------------------------------------- commands --

    ServerEvents.commandRegistry(event => {
        var Commands = event.commands
        var requireOp = src => src.hasPermission(2)

        var root = Commands.literal('challenge')

        root.then(Commands.literal('list').executes(ctx => {
            var player = ctx.source.player
            if (!player) return 0
            player.tell(Text.gold('Available challenges'))
            for (var i = 0; i < CHALLENGES.length; i++) {
                var c = CHALLENGES[i]
                var mark = hasBadge(player, c.badge) ? Text.green('  [done]') : Text.gray('')
                player.tell(Text.aqua('  ' + c.id).append(Text.white('  ' + c.desc)).append(mark))
            }
            player.tell(Text.gray('Join one with /challenge join <id>'))
            return 1
        }))

        root.then(Commands.literal('status').executes(ctx => {
            var player = ctx.source.player
            if (!player) return 0
            var id = activeId(player)
            if (id === '') {
                player.tell(Text.gold('No active challenge. Pick one with /challenge list'))
                return 1
            }
            var ch = byId(id)
            if (!ch) {
                player.tell(Text.red('Your challenge no longer exists. Clearing it.'))
                player.persistentData.putString('challengeId', '')
                return 0
            }
            player.tell(Text.gold(ch.name + ' - ' + ch.desc))
            if (ch.special === 'space') {
                player.tell(Text.white('  Build a rocket and launch. Completes the')
                    .append(Text.white(' moment you arrive.')))
                return 1
            }
            var done = progressOf(ctx.source.server, player, ch)
            var shownDone = Math.floor(done / ch.div)
            var shownNeed = Math.floor(ch.need / ch.div)
            player.tell(Text.white('  Progress: ')
                .append(Text.yellow(shownDone + ' / ' + shownNeed + ' ' + ch.unit)))
            return 1
        }))

        root.then(Commands.literal('leave').executes(ctx => {
            var player = ctx.source.player
            if (!player) return 0
            if (activeId(player) === '') {
                player.tell(Text.gold('You are not signed up for a challenge.'))
                return 0
            }
            player.persistentData.putString('challengeId', '')
            player.persistentData.putInt('challengeBase', 0)
            player.tell(Text.gray('Challenge abandoned. Progress reset if you rejoin.'))
            return 1
        }))

        // One literal per challenge keeps tab-completion working and avoids
        // needing a string argument type here.
        var joinNode = Commands.literal('join')
        for (var i = 0; i < CHALLENGES.length; i++) {
            (function (ch) {
                joinNode.then(Commands.literal(ch.id).executes(ctx => {
                    var player = ctx.source.player
                    if (!player) return 0
                    if (hasBadge(player, ch.badge)) {
                        player.tell(Text.gold('You already earned the ' + ch.badge + ' badge.'))
                        return 0
                    }
                    if (activeId(player) !== '') {
                        player.tell(Text.gold('Finish or /challenge leave your current one first.'))
                        return 0
                    }
                    join(ctx.source.server, player, ch)
                    return 1
                }))
            })(CHALLENGES[i])
        }
        root.then(joinNode)

        root.then(Commands.literal('board').requires(requireOp).executes(ctx => {
            var player = ctx.source.player
            if (!player) return 0
            var yaw = 0
            try { yaw = Number(player.yaw) } catch (e) {}
            if (isNaN(yaw)) { try { yaw = Number(player.yRot) } catch (e) { yaw = 0 } }
            if (isNaN(yaw)) yaw = 0

            // Stand where you want to READ it from, looking at where it should
            // hang. Placing it at the op own feet puts it inside or directly
            // above their head, where it cannot be seen at all - that mistake
            // cost two rounds of "it is not there". So: 3 blocks along the way
            // they face, at eye level, turned 180 to look back at them.
            // Math.PI came back undefined here, turning the position into
            // NaN while yaw + 180 still worked - so it silently wrote NaN
            // coords and summoned nothing. Constant inlined instead.
            var rad = yaw * 0.017453292519943295
            var fx = -Math.sin(rad)
            var fz = Math.cos(rad)
            cfg.dim = dimOf(player.level)
            cfg.x = player.x
            cfg.y = player.y + 1.6
            cfg.z = player.z
            cfg.yaw = yaw + 180
            saveConfig()
            placeBoard(ctx.source.server)
            player.tell(Text.green('Challenge board placed here.'))
            return 1
        }))

        root.then(Commands.literal('init').requires(requireOp).executes(ctx => {
            var s = ctx.source.server
            s.runCommandSilent('scoreboard objectives add ch_walked minecraft.custom:minecraft.walk_one_cm {"text":"ChWalk"}')
            s.runCommandSilent('scoreboard objectives add ch_jumps minecraft.custom:minecraft.jump {"text":"ChJump"}')
            s.runCommandSilent('scoreboard objectives add ch_mined minecraft.mined:minecraft.stone {"text":"ChMine"}')
            s.runCommandSilent('scoreboard objectives add ch_kills totalKillCount {"text":"ChKills"}')
            s.runCommandSilent('scoreboard objectives add ch_playtime minecraft.custom:minecraft.play_time {"text":"ChTime"}')
            if (ctx.source.player) ctx.source.player.tell(Text.green('Challenge objectives created.'))
            return 1
        }))

        event.register(root)

        event.register(Commands.literal('badges').executes(ctx => {
            var player = ctx.source.player
            if (!player) return 0
            var list = badgeList(player)
            if (list.length === 0) {
                player.tell(Text.gold('No badges yet. See /challenge list to start one.'))
                return 1
            }
            player.tell(Text.gold('Your badges (' + list.length + ')'))
            for (var i = 0; i < list.length; i++) {
                player.tell(Text.yellow('  * ' + list[i]))
            }
            return 1
        }))
    })
})()
