// Protect the hub building, and keep its starter chests stocked.
//
// Two jobs that belong together because they share one config and one idea:
// the hub is scenery, not a resource. Players cannot take it apart, and what
// it hands out comes back for the next child who walks in.
//
//   /hubguard corner1    (op) one corner of the protected box, where you stand
//   /hubguard corner2    (op) the opposite corner
//   /hubguard show       (op) report the box and the registered chests
//   /hubguard off        (op) remove protection entirely
//   /hubguard chest      (op) then right-click a chest to register it
//   /hubguard forget     (op) then right-click a chest to unregister it
//   /hubguard restock    (op) refill every registered chest right now
//
// Protection covers breaking and placing. Opening doors, chests and buttons
// is deliberately still allowed - the hub is meant to be used, and a tutorial
// nobody can interact with is the mistake the first walkthrough already made.
//
// HAZARDS this is shaped around, all found the hard way on this server:
//   1. No top-level declarations - server scripts share one scope and a
//      collision silently kills whichever loads second (a `const CONFIG` in
//      hub.js once took the playtime limiter down with it).
//   2. `var` not const/let inside try blocks - this Rhino throws
//      "redeclaration of var" on the FIRST call otherwise, so the block is
//      dead and the catch silently wins.
//   3. Math.PI is undefined here; inline any constant or coords become NaN.

(function () {
    var CONFIG_PATH = 'kubejs/config/hub_guard.json'

    // The loadout is declared here rather than copied out of a chest in the
    // world. Reading a container's contents means trusting a KubeJS
    // inventory API, and every API guessed at in this file's siblings cost a
    // live debugging session; `/item replace block` is plain vanilla and its
    // behaviour is not in question. Editing this list is also reviewable in
    // a diff, which a chest in a world file is not.
    var LOADOUT = [
        { item: 'minecraft:bread', count: 16 },
        { item: 'minecraft:cooked_beef', count: 8 },
        { item: 'minecraft:apple', count: 8 },
        { item: 'minecraft:torch', count: 32 },
        { item: 'minecraft:oak_planks', count: 32 },
        { item: 'minecraft:stone_pickaxe', count: 1 },
        { item: 'minecraft:stone_axe', count: 1 },
        { item: 'minecraft:stone_sword', count: 1 },
        { item: 'minecraft:leather_boots', count: 1 },
        { item: 'minecraft:water_bucket', count: 1 }
    ]
    var CHEST_SLOTS = 27

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
        var chests = []
        try {
            var cs = get('chests', null)
            if (cs) {
                for (var i = 0; i < cs.length; i++) {
                    chests.push({
                        x: Number(cs[i].x), y: Number(cs[i].y), z: Number(cs[i].z)
                    })
                }
            }
        } catch (e) {}
        return {
            dim: String(get('dim', '')),
            x1: Number(get('x1', 0)), y1: Number(get('y1', 0)), z1: Number(get('z1', 0)),
            x2: Number(get('x2', 0)), y2: Number(get('y2', 0)), z2: Number(get('z2', 0)),
            // Half a box is not a box. Protection stays off until both
            // corners exist, so a half-finished setup never silently locks
            // players out of a region nobody meant to protect.
            have1: !!get('have1', false),
            have2: !!get('have2', false),
            chests: chests
        }
    }

    var cfg = loadConfig()

    function saveConfig() {
        try {
            JsonIO.write(CONFIG_PATH, {
                dim: cfg.dim,
                x1: cfg.x1, y1: cfg.y1, z1: cfg.z1,
                x2: cfg.x2, y2: cfg.y2, z2: cfg.z2,
                have1: cfg.have1, have2: cfg.have2,
                chests: cfg.chests
            })
            return true
        } catch (e) {
            console.error('[hubguard] could not write ' + CONFIG_PATH + ': ' + e)
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

    function active() {
        return cfg.have1 && cfg.have2 && cfg.dim !== ''
    }

    function inside(dim, x, y, z) {
        if (!active()) return false
        if (dim !== cfg.dim) return false
        var lox = Math.min(cfg.x1, cfg.x2), hix = Math.max(cfg.x1, cfg.x2)
        var loy = Math.min(cfg.y1, cfg.y2), hiy = Math.max(cfg.y1, cfg.y2)
        var loz = Math.min(cfg.z1, cfg.z2), hiz = Math.max(cfg.z1, cfg.z2)
        return x >= lox && x <= hix && y >= loy && y <= hiy && z >= loz && z <= hiz
    }

    function isOp(player) {
        try { return player.hasPermission(2) } catch (e) { return false }
    }

    // ------------------------------------------------------ protection --

    function denyEdit(event, player) {
        event.cancel()
        try {
            player.tell(Text.red('This building is protected - it belongs to everyone.'))
            player.tell(Text.gray('Head outside to build. The whole world is yours.'))
        } catch (e) {}
    }

    BlockEvents.broken(event => {
        var player = event.player
        if (!player || isOp(player)) return
        var b = event.block
        if (inside(dimOf(b.level), b.x, b.y, b.z)) denyEdit(event, player)
    })

    BlockEvents.placed(event => {
        var player = event.player
        if (!player || isOp(player)) return
        var b = event.block
        if (inside(dimOf(b.level), b.x, b.y, b.z)) denyEdit(event, player)
    })

    // --------------------------------------------------------- chests --

    function sameChest(c, x, y, z) {
        return c.x === x && c.y === y && c.z === z
    }

    function findChest(x, y, z) {
        for (var i = 0; i < cfg.chests.length; i++) {
            if (sameChest(cfg.chests[i], x, y, z)) return i
        }
        return -1
    }

    // Wipe then fill, so a chest a player half-emptied and half-filled with
    // their own junk comes back to exactly the loadout rather than to the
    // loadout plus whatever they left in it.
    function restockOne(server, c) {
        var at = c.x + ' ' + c.y + ' ' + c.z
        var i
        for (i = 0; i < CHEST_SLOTS; i++) {
            server.runCommandSilent('execute in ' + cfg.dim + ' run item replace block ' +
                at + ' container.' + i + ' with minecraft:air')
        }
        for (i = 0; i < LOADOUT.length && i < CHEST_SLOTS; i++) {
            server.runCommandSilent('execute in ' + cfg.dim + ' run item replace block ' +
                at + ' container.' + i + ' with ' + LOADOUT[i].item + ' ' + LOADOUT[i].count)
        }
    }

    function restockAll(server) {
        if (cfg.dim === '') return 0
        for (var i = 0; i < cfg.chests.length; i++) restockOne(server, cfg.chests[i])
        return cfg.chests.length
    }

    // Refill for every player who has never been here before. Deliberately
    // not "on every join": a returning player who stashed something in a hub
    // chest should not have it silently deleted, and restocking on every
    // login would also hand out an unlimited supply to anyone willing to
    // relog.
    PlayerEvents.loggedIn(event => {
        var d = null
        try { d = event.player.persistentData } catch (e) { return }
        if (d.getBoolean('hubChestSeen')) return
        d.putBoolean('hubChestSeen', true)
        var n = restockAll(event.server)
        if (n > 0) console.info('[hubguard] restocked ' + n + ' chest(s) for a new player')
    })

    // An op arms one of these, then right-clicks the chest. The same
    // click-to-pick pattern hub.js uses for the Home switch, because asking
    // anyone to type block coordinates they read off F3 is how the first cut
    // of that feature went wrong.
    var pending = {}        // player name -> 'chest' | 'forget'

    BlockEvents.rightClicked(event => {
        var player = event.player
        if (!player) return
        var name = String(player.username)
        var mode = pending[name]
        if (!mode) return
        var b = event.block
        var id = ''
        try { id = String(b.id) } catch (e) {}
        if (id.indexOf('chest') === -1 && id.indexOf('barrel') === -1) {
            player.tell(Text.gold('That is not a chest or barrel. Right-click one, or run the command again to cancel.'))
            return
        }
        delete pending[name]
        event.cancel()
        var idx = findChest(b.x, b.y, b.z)
        if (mode === 'forget') {
            if (idx === -1) {
                player.tell(Text.gold('That chest was not registered.'))
                return
            }
            cfg.chests.splice(idx, 1)
            saveConfig()
            player.tell(Text.green('Unregistered. It will no longer be restocked.'))
            return
        }
        if (idx !== -1) {
            player.tell(Text.gold('That chest is already registered.'))
            return
        }
        cfg.dim = dimOf(b.level)
        cfg.chests.push({ x: b.x, y: b.y, z: b.z })
        saveConfig()
        restockOne(event.server, cfg.chests[cfg.chests.length - 1])
        player.tell(Text.green('Registered and filled. It refills for every new player.'))
    })

    // ----------------------------------------------------- mob control --

    // Hostiles are listed explicitly rather than detected. There is no
    // vanilla "hostile" entity tag in 1.20.1 covering all of these, and
    // asking KubeJS whether an entity is a monster means trusting another
    // API; a list is dull but it is exact, and a mod mob that is missed
    // simply is not swept rather than something breaking.
    var HOSTILES = [
        'minecraft:zombie', 'minecraft:zombie_villager', 'minecraft:husk',
        'minecraft:drowned', 'minecraft:skeleton', 'minecraft:stray',
        'minecraft:wither_skeleton', 'minecraft:creeper', 'minecraft:spider',
        'minecraft:cave_spider', 'minecraft:enderman', 'minecraft:witch',
        'minecraft:slime', 'minecraft:silverfish', 'minecraft:phantom',
        'minecraft:pillager', 'minecraft:vindicator', 'minecraft:evoker',
        'minecraft:ravager', 'minecraft:vex', 'minecraft:illusioner'
    ]
    var SWEEP_TICKS = 100       // every 5s; the box is small and the server
                                // already reports "Can't keep up" under load

    // Prevention first: cancelling the spawn is cheaper than killing the mob
    // afterwards, and it means children never see one appear indoors at all.
    // Guarded end to end - if this build does not expose entity.type the way
    // we expect, the sweep below still covers it.
    EntityEvents.spawned(event => {
        if (!active()) return
        try {
            var e = event.entity
            if (!e) return
            var id = String(e.type)
            var hostile = false
            for (var i = 0; i < HOSTILES.length; i++) {
                if (HOSTILES[i] === id) { hostile = true; break }
            }
            if (!hostile) return
            if (inside(dimOf(e.level), Math.floor(e.x), Math.floor(e.y), Math.floor(e.z))) {
                event.cancel()
            }
        } catch (e2) {}
    })

    // Belt and braces: anything that walked in, or spawned before this
    // script loaded, is removed on a slow sweep. Uses plain commands so it
    // does not depend on any entity API at all.
    var sweepTick = 0
    ServerEvents.tick(event => {
        sweepTick++
        if (sweepTick % SWEEP_TICKS !== 0) return
        if (!active()) return
        var lox = Math.min(cfg.x1, cfg.x2), hix = Math.max(cfg.x1, cfg.x2)
        var loy = Math.min(cfg.y1, cfg.y2), hiy = Math.max(cfg.y1, cfg.y2)
        var loz = Math.min(cfg.z1, cfg.z2), hiz = Math.max(cfg.z1, cfg.z2)
        var sel = 'x=' + lox + ',y=' + loy + ',z=' + loz +
            ',dx=' + (hix - lox) + ',dy=' + (hiy - loy) + ',dz=' + (hiz - loz)
        for (var i = 0; i < HOSTILES.length; i++) {
            event.server.runCommandSilent('execute in ' + cfg.dim +
                ' run kill @e[type=' + HOSTILES[i] + ',' + sel + ']')
        }
    })

    // -------------------------------------------------------- commands --

    ServerEvents.commandRegistry(event => {
        var Commands = event.commands
        var requireOp = src => src.hasPermission(2)

        event.register(
            Commands.literal('hubguard').requires(requireOp)
                .then(Commands.literal('corner1').executes(ctx => {
                    var p = ctx.source.player
                    if (!p) return 0
                    cfg.dim = dimOf(p.level)
                    cfg.x1 = Math.floor(p.x); cfg.y1 = Math.floor(p.y); cfg.z1 = Math.floor(p.z)
                    cfg.have1 = true
                    saveConfig()
                    p.tell(Text.green('Corner 1 set at ' + cfg.x1 + ', ' + cfg.y1 + ', ' + cfg.z1))
                    p.tell(Text.gray(cfg.have2 ? 'Protection is ON.' : 'Now stand at the opposite corner and run /hubguard corner2'))
                    return 1
                }))
                .then(Commands.literal('corner2').executes(ctx => {
                    var p = ctx.source.player
                    if (!p) return 0
                    cfg.dim = dimOf(p.level)
                    cfg.x2 = Math.floor(p.x); cfg.y2 = Math.floor(p.y); cfg.z2 = Math.floor(p.z)
                    cfg.have2 = true
                    saveConfig()
                    p.tell(Text.green('Corner 2 set at ' + cfg.x2 + ', ' + cfg.y2 + ', ' + cfg.z2))
                    p.tell(Text.gray(cfg.have1 ? 'Protection is ON.' : 'Now set /hubguard corner1'))
                    return 1
                }))
                .then(Commands.literal('show').executes(ctx => {
                    var p = ctx.source.player
                    if (!p) return 0
                    if (!active()) {
                        p.tell(Text.gold('Protection is OFF - set both corners.'))
                    } else {
                        p.tell(Text.green('Protected box in ' + cfg.dim + ':'))
                        p.tell(Text.gray('  ' + cfg.x1 + ', ' + cfg.y1 + ', ' + cfg.z1 +
                            '   to   ' + cfg.x2 + ', ' + cfg.y2 + ', ' + cfg.z2))
                    }
                    p.tell(Text.gray('  ' + cfg.chests.length + ' chest(s) registered for restock'))
                    return 1
                }))
                .then(Commands.literal('off').executes(ctx => {
                    cfg.have1 = false; cfg.have2 = false
                    saveConfig()
                    if (ctx.source.player) ctx.source.player.tell(Text.gold('Protection OFF.'))
                    return 1
                }))
                .then(Commands.literal('chest').executes(ctx => {
                    var p = ctx.source.player
                    if (!p) return 0
                    pending[String(p.username)] = 'chest'
                    p.tell(Text.green('Now right-click the chest to register it.'))
                    return 1
                }))
                .then(Commands.literal('forget').executes(ctx => {
                    var p = ctx.source.player
                    if (!p) return 0
                    pending[String(p.username)] = 'forget'
                    p.tell(Text.green('Now right-click the chest to unregister it.'))
                    return 1
                }))
                .then(Commands.literal('restock').executes(ctx => {
                    var n = restockAll(ctx.source.server)
                    if (ctx.source.player) ctx.source.player.tell(Text.green('Refilled ' + n + ' chest(s).'))
                    return 1
                }))
        )
    })
})()
