// Hub spawn, per-player homes, and the opt-in walkthrough.
//
// Every login drops the player in the hub you built (once an op has run
// `/hub set` there), so the hub is the front door of the server every time,
// not just on first join. The way back out is the Home switch: a lever or
// button in the hub that an op binds with `/hub switch`, which teleports each
// player to whatever spot they saved with `/sethome`.
//
// Config: kubejs/config/hub.json. It is WRITTEN by the /hub admin commands, so
// prefer those over hand-editing - an edit by hand needs `/reload` and will be
// overwritten the next time an op runs /hub set. Nothing teleports anyone until
// `/hub set` has been run at least once (spawn_dim stays ""), so installing
// this script before the hub exists is harmless.
//
// Player state (home position, walkthrough progress) lives in each player's own
// persistentData, the same place onboarding.js keeps 'onboarded'.
//
// TWO THINGS THIS FILE IS DELIBERATELY SHAPED AROUND, both found by loading an
// earlier draft on a real server rather than by reading it:
//
// 1. EVERY SERVER SCRIPT SHARES ONE GLOBAL SCOPE. A top-level `const CONFIG`
//    here collided with the one in playtime_limit.js and killed that script
//    with "redeclaration of var CONFIG" - the daily playtime cap silently
//    stopped loading. Hence the IIFE: this file declares nothing globally.
//    Anything added here must stay inside it.
//
// 2. NEVER DECLARE const OR let INSIDE A try BLOCK. This build's Rhino throws
//    "redeclaration of var <name>" on the FIRST call, not just repeat calls, so
//    the whole try block is dead and the catch always wins. It is invisible:
//    every such block here has a fallback, so the script looked like it worked
//    while readKey() silently returned defaults for every config value and
//    dimOf() silently answered "minecraft:overworld" for every dimension. Use
//    `var` inside try blocks. Verified by probe on the live server, not assumed.
//
// 3. NULL IN THE CONFIG JSON CRASHES RHINO. KubeJS hands JSON to scripts as a
//    Java map, and reading a null value out of one throws a NullPointerException
//    inside Rhino's ValueUnwrapper before any script code can check for it
//    (Object.assign over the file was enough to trigger it). So the config is
//    flat primitives only - no nested objects, no nulls - and "" is what an
//    unset position looks like.

(function () {
    const CONFIG_PATH = 'kubejs/config/hub.json'

    // ------------------------------------------------------------- config --

    // Read one key defensively: a missing key, a null, or a Java-side unwrap
    // failure all mean "not configured" rather than a broken script.
    function readKey(raw, key, fallback) {
        if (!raw) return fallback
        try {
            var v = raw[key]
            if (v === undefined || v === null) return fallback
            return v
        } catch (e) {
            return fallback
        }
    }

    function loadConfig() {
        let raw = null
        try { raw = JsonIO.read(CONFIG_PATH) } catch (e) { raw = null }
        return {
            spawn_every_join: !!readKey(raw, 'spawn_every_join', true),
            spawn_dim: String(readKey(raw, 'spawn_dim', '')),
            spawn_x: Number(readKey(raw, 'spawn_x', 0)),
            spawn_y: Number(readKey(raw, 'spawn_y', 0)),
            spawn_z: Number(readKey(raw, 'spawn_z', 0)),
            spawn_yaw: Number(readKey(raw, 'spawn_yaw', 0)),
            spawn_pitch: Number(readKey(raw, 'spawn_pitch', 0)),
            switch_dim: String(readKey(raw, 'switch_dim', '')),
            switch_x: Number(readKey(raw, 'switch_x', 0)),
            switch_y: Number(readKey(raw, 'switch_y', 0)),
            switch_z: Number(readKey(raw, 'switch_z', 0))
        }
    }

    const cfg = loadConfig()

    function saveConfig() {
        try {
            JsonIO.write(CONFIG_PATH, {
                spawn_every_join: cfg.spawn_every_join,
                spawn_dim: cfg.spawn_dim,
                spawn_x: cfg.spawn_x,
                spawn_y: cfg.spawn_y,
                spawn_z: cfg.spawn_z,
                spawn_yaw: cfg.spawn_yaw,
                spawn_pitch: cfg.spawn_pitch,
                switch_dim: cfg.switch_dim,
                switch_x: cfg.switch_x,
                switch_y: cfg.switch_y,
                switch_z: cfg.switch_z
            })
            return true
        } catch (e) {
            console.error('[hub] could not write ' + CONFIG_PATH + ': ' + e)
            return false
        }
    }

    function hubReady() { return cfg.spawn_dim !== '' }
    function switchReady() { return cfg.switch_dim !== '' }

    // Ops who ran `/hub switch` and are now expected to right-click the switch
    // block to bind it. Username -> epoch millis; deliberately NOT persisted, a
    // pending bind should not survive a restart.
    const PENDING_BIND = {}
    const BIND_WINDOW_MS = 60000

    // ----------------------------------------------------------- position --

    // KubeJS exposes entity position/rotation under different names across
    // builds, so read through a fallback chain rather than betting on one.
    function num(value, fallback) {
        const n = parseFloat(value)
        return (isNaN(n) || !isFinite(n)) ? fallback : n
    }

    function posOf(player) {
        let x = NaN, y = NaN, z = NaN
        try { x = num(player.x, NaN); y = num(player.y, NaN); z = num(player.z, NaN) } catch (e) {}
        if (isNaN(x) || isNaN(y) || isNaN(z)) {
            try {
                var p = player.position()
                x = num(p.x, NaN); y = num(p.y, NaN); z = num(p.z, NaN)
            } catch (e) {}
        }
        if (isNaN(x) || isNaN(y) || isNaN(z)) {
            var bp = player.blockPosition()
            x = num(bp.getX(), 0) + 0.5; y = num(bp.getY(), 0); z = num(bp.getZ(), 0) + 0.5
        }
        return { x: x, y: y, z: z }
    }

    function rotOf(player) {
        let yaw = NaN, pitch = NaN
        try { yaw = num(player.yaw, NaN); pitch = num(player.pitch, NaN) } catch (e) {}
        if (isNaN(yaw)) { try { yaw = num(player.yRot, NaN); pitch = num(player.xRot, NaN) } catch (e) {} }
        if (isNaN(yaw)) { try { yaw = num(player.getYRot(), NaN); pitch = num(player.getXRot(), NaN) } catch (e) {} }
        return { yaw: isNaN(yaw) ? 0 : yaw, pitch: isNaN(pitch) ? 0 : pitch }
    }

    // Dimension id as "minecraft:overworld". level.dimension is a ResourceKey
    // on some builds and a ResourceLocation on others; ResourceKey#toString
    // prints "ResourceKey[minecraft:dimension / minecraft:the_nether]", hence
    // the regex.
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

    function fmt(dim, x, y, z) {
        return Math.round(x) + ', ' + Math.round(y) + ', ' + Math.round(z) +
            ' in ' + String(dim).replace('minecraft:', '')
    }

    // Teleport by username through a command so cross-dimension moves work
    // without touching the level-change API directly. Usernames are validated
    // because they are interpolated into a command string.
    function teleport(server, player, dim, x, y, z, yaw, pitch) {
        const name = String(player.username)
        if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) {
            console.error('[hub] refusing to teleport unusual username: ' + name)
            return false
        }
        if (!/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(String(dim))) return false
        server.runCommandSilent('execute in ' + dim + ' run tp ' + name + ' ' +
            num(x, 0) + ' ' + num(y, 0) + ' ' + num(z, 0) + ' ' + num(yaw, 0) + ' ' + num(pitch, 0))
        return true
    }

    function toHub(server, player) {
        return teleport(server, player, cfg.spawn_dim,
            cfg.spawn_x, cfg.spawn_y, cfg.spawn_z, cfg.spawn_yaw, cfg.spawn_pitch)
    }

    // -------------------------------------------------------- walkthrough --

    // The walkthrough plays itself: each step throws a title card on screen,
    // rings a note, prints a framed block in chat, and advances on a timer.
    // Nothing needs clicking - chat components are only clickable while the
    // chat window is open, which is not a thing a first-time player knows, so
    // interaction is never on the critical path. Skip and stop are plain
    // commands, shown on every step.

    const STEP_TICKS = 220           // ~11s per step, enough to read four lines
    const RULE = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'

    const TOUR = [
        {
            card: 'WELCOME',
            sub: 'you have arrived in the hub',
            heading: 'THE HUB',
            lines: [
                'This is the hub. You arrive here every time you log in.',
                'It is a safe room - nothing can hurt you inside it.',
                'Everything you need to get started is in this building.'
            ]
        },
        {
            card: 'YOUR GUIDE BOOK',
            sub: 'type  /guide  to open it',
            heading: 'THE GUIDE BOOK',
            lines: [
                'The guide book covers every mod on this server:',
                'Create machines, cooking, computers and turtles,',
                'trading and bounties - with recipes and pictures.'
            ]
        },
        {
            card: 'SETTING YOUR HOME',
            sub: 'type  /sethome  where you build',
            heading: 'YOUR HOME',
            lines: [
                'Go out and build somewhere you like.',
                'Stand where you want to return to and type /sethome.',
                'Run it again any time to move your home somewhere else.'
            ]
        },
        {
            card: 'THE HOME SWITCH',
            sub: 'right-click it to travel',
            heading: 'THE HOME SWITCH',
            lines: [
                'In this room there is a switch marked HOME.',
                'Right-click it and you are sent to your saved spot.',
                'Typing /home does the same from anywhere in the world.'
            ]
        },
        {
            card: 'GETTING AROUND',
            sub: 'waystones link up the map',
            heading: 'TRAVEL',
            lines: [
                'Waystones are the other way to travel.',
                'Craft one, place it, right-click it to activate it,',
                'then warp between every waystone you have activated.'
            ]
        },
        {
            card: 'HOUSE RULES',
            sub: 'you are all set - have fun',
            heading: 'HOUSE RULES',
            lines: [
                'Only whitelisted players can join this server.',
                'Daily playtime is capped and resets overnight.',
                'Type /hub to come back to this room at any time.'
            ]
        }
    ]

    // Run a command with {p} standing in for the player name. The name is
    // validated here for the same reason teleport() validates it: it is being
    // interpolated into a command string.
    function runFor(server, player, command) {
        const name = String(player.username)
        if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) return false
        server.runCommandSilent(command.split('{p}').join(name))
        return true
    }

    // Title cards are sent as raw JSON components, so any quote or backslash in
    // the text would break the command. The tour text is authored above and
    // contains neither, but strip them anyway rather than trust that forever.
    function jsonSafe(s) {
        return String(s).replace(/[\\"]/g, '')
    }

    function showCard(server, player, step) {
        runFor(server, player, 'title {p} times 8 60 14')
        runFor(server, player, 'title {p} subtitle {"text":"' + jsonSafe(step.sub) + '","color":"yellow"}')
        runFor(server, player, 'title {p} title {"text":"' + jsonSafe(step.card) + '","color":"gold","bold":true}')
        runFor(server, player, 'execute at {p} run playsound minecraft:block.note_block.bell player {p} ~ ~ ~ 0.5 1.5')
    }

    function sendStep(server, player, index) {
        const step = TOUR[index]
        const last = (index + 1 >= TOUR.length)

        showCard(server, player, step)

        player.tell(Text.gold(RULE))
        player.tell(Text.yellow('  ' + step.heading).append(Text.gray('   step ' + (index + 1) + ' of ' + TOUR.length)))
        player.tell(Text.gray(''))
        step.lines.forEach(line => player.tell(Text.white('  ' + line)))
        player.tell(Text.gray(''))
        if (last) {
            player.tell(Text.green('  That is everything.').append(Text.gray('   /tutorial plays it again any time')))
        } else {
            player.tell(Text.gray('  next step shortly')
                .append(Text.green('    /tutorial skip'))
                .append(Text.gray('  to hurry it along'))
                .append(Text.red('    /tutorial stop'))
                .append(Text.gray('  to end it')))
        }
        player.tell(Text.gold(RULE))
    }

    function startTour(server, player) {
        const data = player.persistentData
        data.putInt('tourStep', 0)
        data.putInt('tourTicks', 0)
        data.putBoolean('tourActive', true)
        sendStep(server, player, 0)
    }

    // Advance one step. Returns false once the tour is over.
    function advanceTour(server, player) {
        const data = player.persistentData
        const next = data.getInt('tourStep') + 1
        if (next >= TOUR.length) {
            data.putBoolean('tourActive', false)
            data.putBoolean('tourDone', true)
            return false
        }
        data.putInt('tourStep', next)
        data.putInt('tourTicks', 0)
        sendStep(server, player, next)
        if (next + 1 >= TOUR.length) {
            // Last card is showing; let it sit, then retire the tour.
            data.putBoolean('tourDone', true)
        }
        return true
    }

    function stopTour(player, quiet) {
        const data = player.persistentData
        data.putBoolean('tourActive', false)
        data.putBoolean('tourDeclined', true)
        if (!quiet) player.tell(Text.gray('Walkthrough stopped. Type /tutorial whenever you want it again.'))
    }

    // -------------------------------------------------------------- joins --

    PlayerEvents.loggedIn(event => {
        const data = event.player.persistentData
        data.putInt('hubTicks', 0)
        data.putBoolean('hubPending', cfg.spawn_every_join && hubReady())
        data.putBoolean('hubGreetPending', true)
    })

    PlayerEvents.tick(event => {
        const player = event.player
        const data = player.persistentData

        if (!data.getBoolean('hubPending') && !data.getBoolean('hubGreetPending')) return

        const ticks = data.getInt('hubTicks') + 1
        data.putInt('hubTicks', ticks)

        // ~0.75s: late enough that the player is fully in the world, early
        // enough that they never really see where they logged out.
        if (data.getBoolean('hubPending') && ticks >= 15) {
            data.putBoolean('hubPending', false)
            toHub(event.server, player)
        }

        // ~5s: after onboarding.js has opened the guide book at 40 ticks, so
        // the two do not talk over each other on a first join.
        if (data.getBoolean('hubGreetPending') && ticks >= 100) {
            data.putBoolean('hubGreetPending', false)
            if (!hubReady()) return

            if (!data.getBoolean('tourDone') && !data.getBoolean('tourDeclined')) {
                // Plays itself on a first visit. It is skippable from the first
                // card onward, which is why it starts rather than asking: a
                // "click yes to begin" gate is exactly the interaction a new
                // player cannot reliably perform.
                startTour(event.server, player)
            } else if (!data.getString('homeDim')) {
                player.tell(Text.gray('You have not set a home yet - stand where you want to return to and type /sethome.'))
            }
        }
    })

    // Drives the walkthrough forward on its own timer.
    PlayerEvents.tick(event => {
        const player = event.player
        const data = player.persistentData
        if (!data.getBoolean('tourActive')) return

        const t = data.getInt('tourTicks') + 1
        data.putInt('tourTicks', t)
        if (t < STEP_TICKS) return

        data.putInt('tourTicks', 0)
        advanceTour(event.server, player)
    })

    // -------------------------------------------------------- home switch --

    function sendHome(server, player) {
        const data = player.persistentData
        const dim = data.getString('homeDim')
        if (!dim) {
            player.tell(Text.gold('You have not set a home yet.'))
            player.tell(Text.white('Go build somewhere, stand where you want to come back to, and type /sethome.'))
            player.tell(Text.gray('Then this switch (or /home) brings you straight back.'))
            return false
        }
        const ok = teleport(server, player, dim,
            data.getDouble('homeX'), data.getDouble('homeY'), data.getDouble('homeZ'),
            data.getDouble('homeYaw'), data.getDouble('homePitch'))
        if (!ok) {
            player.tell(Text.red('Could not send you home - ask an admin to check the server log.'))
            return false
        }
        player.tell(Text.green('Welcome home.'))
        return true
    }

    BlockEvents.rightClicked(event => {
        const player = event.player
        if (!player) return

        const block = event.block
        const dim = dimOf(block.level)
        const x = block.x, y = block.y, z = block.z

        // Op is binding the switch: the next block they right-click becomes it.
        const pending = PENDING_BIND[String(player.username)]
        if (pending && (Date.now() - pending) < BIND_WINDOW_MS && player.isOp()) {
            delete PENDING_BIND[String(player.username)]
            event.cancel()
            cfg.switch_dim = dim; cfg.switch_x = x; cfg.switch_y = y; cfg.switch_z = z
            if (saveConfig()) {
                player.tell(Text.green('Home switch bound to the ' + block.id + ' at ' + fmt(dim, x, y, z) + '.'))
                player.tell(Text.gray('Any player who right-clicks it now goes to their /sethome spot.'))
            } else {
                player.tell(Text.red('Bound for now, but the config file could not be written - it will be lost on restart.'))
            }
            return
        }

        if (!switchReady()) return
        if (cfg.switch_x !== x || cfg.switch_y !== y || cfg.switch_z !== z || cfg.switch_dim !== dim) return

        // Cancel so the lever does not actually flip - the switch is a button
        // in the UI sense, and a stuck lever would read as "broken" to a kid.
        event.cancel()
        sendHome(event.server, player)
    })

    // ----------------------------------------------------------- commands --

    ServerEvents.commandRegistry(event => {
        const { commands: Commands } = event

        const requireOp = src => src.hasPermission(2)

        event.register(
            Commands.literal('hub')
                .executes(ctx => {
                    const player = ctx.source.player
                    if (!player) return 0
                    if (!hubReady()) {
                        player.tell(Text.gold('The hub has not been set up yet.'))
                        return 0
                    }
                    toHub(ctx.source.server, player)
                    return 1
                })
                .then(Commands.literal('set').requires(requireOp).executes(ctx => {
                    const player = ctx.source.player
                    if (!player) return 0
                    const p = posOf(player)
                    const r = rotOf(player)
                    cfg.spawn_dim = dimOf(player.level)
                    cfg.spawn_x = p.x; cfg.spawn_y = p.y; cfg.spawn_z = p.z
                    cfg.spawn_yaw = r.yaw; cfg.spawn_pitch = r.pitch
                    if (!saveConfig()) {
                        player.tell(Text.red('Set for now, but the config file could not be written - it will be lost on restart.'))
                        return 0
                    }
                    player.tell(Text.green('Hub spawn set to ' + fmt(cfg.spawn_dim, p.x, p.y, p.z) + ', facing the way you are now.'))
                    player.tell(Text.gray('Everyone lands here on login. Next: /hub switch to bind the Home switch.'))
                    return 1
                }))
                .then(Commands.literal('switch').requires(requireOp).executes(ctx => {
                    const player = ctx.source.player
                    if (!player) return 0
                    PENDING_BIND[String(player.username)] = Date.now()
                    player.tell(Text.gold('Now right-click the block you want to be the Home switch.'))
                    player.tell(Text.gray('A lever or a button works best. You have 60 seconds.'))
                    return 1
                }))
                .then(Commands.literal('on').requires(requireOp).executes(ctx => {
                    const player = ctx.source.player
                    cfg.spawn_every_join = true
                    saveConfig()
                    if (player) player.tell(Text.green('Players will be sent to the hub on every login.'))
                    return 1
                }))
                .then(Commands.literal('off').requires(requireOp).executes(ctx => {
                    const player = ctx.source.player
                    cfg.spawn_every_join = false
                    saveConfig()
                    if (player) player.tell(Text.green('Login teleport off. /hub and the Home switch still work.'))
                    return 1
                }))
                .then(Commands.literal('status').requires(requireOp).executes(ctx => {
                    const player = ctx.source.player
                    if (!player) return 0
                    player.tell(Text.gold('Hub status'))
                    player.tell(Text.white('  teleport on every login: ' + cfg.spawn_every_join))
                    player.tell(Text.white('  spawn: ' + (hubReady()
                        ? fmt(cfg.spawn_dim, cfg.spawn_x, cfg.spawn_y, cfg.spawn_z)
                        : 'not set - run /hub set')))
                    player.tell(Text.white('  home switch: ' + (switchReady()
                        ? fmt(cfg.switch_dim, cfg.switch_x, cfg.switch_y, cfg.switch_z)
                        : 'not set - run /hub switch')))
                    return 1
                }))
        )

        event.register(
            Commands.literal('sethome').executes(ctx => {
                const player = ctx.source.player
                if (!player) return 0
                const p = posOf(player)
                const r = rotOf(player)
                const dim = dimOf(player.level)
                const data = player.persistentData
                data.putString('homeDim', dim)
                data.putDouble('homeX', p.x)
                data.putDouble('homeY', p.y)
                data.putDouble('homeZ', p.z)
                data.putDouble('homeYaw', r.yaw)
                data.putDouble('homePitch', r.pitch)
                player.tell(Text.green('Home set to ' + fmt(dim, p.x, p.y, p.z) + '.'))
                player.tell(Text.gray('Type /home, or flip the Home switch in the hub, to come back here.'))
                return 1
            })
        )

        event.register(
            Commands.literal('home').executes(ctx => {
                const player = ctx.source.player
                if (!player) return 0
                return sendHome(ctx.source.server, player) ? 1 : 0
            })
        )

        const skipStep = ctx => {
            const player = ctx.source.player
            if (!player) return 0
            if (!player.persistentData.getBoolean('tourActive')) {
                startTour(ctx.source.server, player)
                return 1
            }
            advanceTour(ctx.source.server, player)
            return 1
        }

        event.register(
            Commands.literal('tutorial')
                .executes(ctx => {
                    const player = ctx.source.player
                    if (!player) return 0
                    startTour(ctx.source.server, player)
                    return 1
                })
                // 'next' kept as an alias: it is what the old build printed, and
                // it is the word people reach for anyway.
                .then(Commands.literal('skip').executes(skipStep))
                .then(Commands.literal('next').executes(skipStep))
                .then(Commands.literal('stop').executes(ctx => {
                    const player = ctx.source.player
                    if (!player) return 0
                    stopTour(player, false)
                    return 1
                }))
        )
    })
})()
