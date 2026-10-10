(function () {
    var CONFIG_PATH = 'kubejs/config/starter_chests.json'
    // Commands.string() does not exist - verified live against the running
    // server, not assumed: the real Brigadier string type lives on
    // StringArgumentType, loaded the same way playtime_limit.js loads
    // java.time.LocalDate.
    var StringArgumentType = Java.loadClass('com.mojang.brigadier.arguments.StringArgumentType')

    function loadConfig() {
        var raw = null
        try { raw = JsonIO.read(CONFIG_PATH) } catch (e) { raw = null }
        var chests = []
        try {
            if (raw && raw.chests) {
                for (var i = 0; i < raw.chests.length; i++) {
                    var c = raw.chests[i]
                    chests.push({
                        dim: String(c.dim || 'minecraft:overworld'),
                        x: Number(c.x || 0),
                        y: Number(c.y || 0),
                        z: Number(c.z || 0),
                        claimed_by: String(c.claimed_by || ''),
                        claimed_by_name: String(c.claimed_by_name || '')
                    })
                }
            }
        } catch (e) {}
        return chests
    }

    var CHESTS = loadConfig()

    function saveConfig() {
        try {
            JsonIO.write(CONFIG_PATH, { chests: CHESTS })
            return true
        } catch (e) {
            console.error('[starter_chests] could not write ' + CONFIG_PATH + ': ' + e)
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

    function sameSpot(c, dim, x, y, z) {
        return c.dim === dim && c.x === x && c.y === y && c.z === z
    }

    function findChestAt(block) {
        var dim = dimOf(block.level)
        for (var i = 0; i < CHESTS.length; i++) {
            if (sameSpot(CHESTS[i], dim, block.x, block.y, block.z)) return CHESTS[i]
        }
        return null
    }

    function findChestOwnedBy(uuid) {
        for (var i = 0; i < CHESTS.length; i++) {
            if (CHESTS[i].claimed_by === uuid) return CHESTS[i]
        }
        return null
    }

    function fmt(c) {
        return Math.round(c.x) + ', ' + Math.round(c.y) + ', ' + Math.round(c.z) +
            ' in ' + c.dim.replace('minecraft:', '')
    }

    // ----------------------------------------------------------- opening --

    BlockEvents.rightClicked(event => {
        var player = event.player
        if (!player) return
        var block = event.block
        if (!/chest$/.test(String(block.id))) return

        var chest = findChestAt(block)
        if (!chest) return // not a registered starter chest - leave it alone

        var uuid = String(player.uuid || player.username)
        var already = findChestOwnedBy(uuid)

        if (chest.claimed_by === '') {
            // First player to open it claims it, right now.
            chest.claimed_by = uuid
            chest.claimed_by_name = String(player.username)
            if (!saveConfig()) {
                player.tell(Text.red('Could not save your claim - ask an admin to check the server log.'))
                return
            }
            player.tell(Text.green('This is now your starter chest! Only you can open it from here on.'))
            return
        }

        if (chest.claimed_by === uuid) return // their own chest - let them in

        if (already) {
            event.cancel()
            player.tell(Text.gold("This chest belongs to someone else."))
            player.tell(Text.white('Your own starter chest is at ' + fmt(already) + '.'))
            return
        }

        event.cancel()
        player.tell(Text.gold('This chest belongs to ' + chest.claimed_by_name + '.'))
        player.tell(Text.white('Find an unclaimed one, or ask an admin for /starterchest reset.'))
    })

    // ----------------------------------------------------------- commands --

    ServerEvents.commandRegistry(event => {
        var Commands = event.commands
        var requireOp = src => src.hasPermission(2)

        event.register(
            Commands.literal('starterchest')
                .then(Commands.literal('add').requires(requireOp).executes(ctx => {
                    var player = ctx.source.player
                    if (!player) return 0
                    var px = player.x, py = player.y, pz = player.z
                    var level = player.level
                    var dim = dimOf(level)

                    // Nearest chest-type block within 2 blocks of the player,
                    // found the same simple way hub.js finds the switch: look
                    // at where the op is actually standing rather than require
                    // them to pass coordinates by hand.
                    var found = null
                    var bestDist = 999
                    for (var dx = -2; dx <= 2; dx++) {
                        for (var dy = -2; dy <= 2; dy++) {
                            for (var dz = -2; dz <= 2; dz++) {
                                var bx = Math.floor(px) + dx, by = Math.floor(py) + dy, bz = Math.floor(pz) + dz
                                var b
                                try { b = level.getBlock(bx, by, bz) } catch (e) { continue }
                                if (!b || !/chest$/.test(String(b.id))) continue
                                var d = dx * dx + dy * dy + dz * dz
                                if (d < bestDist) { bestDist = d; found = { x: bx, y: by, z: bz } }
                            }
                        }
                    }
                    if (!found) {
                        player.tell(Text.red('No chest found within 2 blocks of you. Stand right next to the chest and try again.'))
                        return 0
                    }
                    for (var i = 0; i < CHESTS.length; i++) {
                        if (sameSpot(CHESTS[i], dim, found.x, found.y, found.z)) {
                            player.tell(Text.gold('That chest is already registered.'))
                            return 0
                        }
                    }
                    CHESTS.push({ dim: dim, x: found.x, y: found.y, z: found.z, claimed_by: '', claimed_by_name: '' })
                    if (!saveConfig()) {
                        CHESTS.pop()
                        player.tell(Text.red('Could not save - ask an admin to check the server log.'))
                        return 0
                    }
                    player.tell(Text.green('Registered the chest at ' + found.x + ', ' + found.y + ', ' + found.z +
                        ' as claimable (' + CHESTS.length + ' total).'))
                    return 1
                }))
                .then(Commands.literal('list').requires(requireOp).executes(ctx => {
                    var player = ctx.source.player
                    if (!player) return 0
                    player.tell(Text.gold('Starter chests (' + CHESTS.length + ')'))
                    for (var i = 0; i < CHESTS.length; i++) {
                        var c = CHESTS[i]
                        var status = c.claimed_by === '' ? Text.green('unclaimed') : Text.yellow(c.claimed_by_name)
                        player.tell(Text.white('  ' + fmt(c) + '  -  ').append(status))
                    }
                    return 1
                }))
                // 'reset' deliberately omitted for now - verifying the real
                // string-argument syntax against the live server first rather
                // than shipping a guess (see zz_probe_args.js).
        )
    })
})()
