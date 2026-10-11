// Record a camera flight, then replay it as an intro cutscene.
//
// Rather than hand-authoring waypoints and guessing at easing, you FLY the
// shot yourself and the server samples your position and look angle every
// tick. Playback teleports the viewer through those same samples at the same
// rate, so the replay is exactly the flight you flew - including the pacing,
// the pauses and the way you turned the camera.
//
//   /cutscene record     (op) start recording your flight
//   /cutscene stop       (op) stop and save it
//   /cutscene play       preview it on yourself
//   /cutscene cancel     abort a playback in progress
//   /cutscene intro on|off  (op) play it automatically on a first join
//   /cutscene again      (op) let yourself see the intro again
//   /cutscene clear      (op) throw the recording away
//
// Viewers are put in spectator for the duration and set down at the hub
// afterwards, so a cutscene can never strand anyone or hand them a free
// flight. Landing at the hub rather than wherever they were when it started
// is deliberate: the intro fires a couple of seconds after login, which is
// a race with hub.js's own login teleport, so "wherever they were" was
// sometimes mid-air over the monastery. The hub is a known floor.
//
// HAZARDS this is shaped around, all found the hard way on this server:
//   1. No top-level declarations - server scripts share one scope and a
//      collision silently kills whichever loads second.
//   2. `var` not const/let inside try blocks - this Rhino throws
//      "redeclaration of var" on the FIRST call otherwise.
//   3. Math.PI is undefined here; inline any constant or coords become NaN.
//   4. Display/title JSON rides in a single-quoted string: no apostrophes.

(function () {
    var CONFIG_PATH = 'kubejs/config/cutscene.json'
    var MAX_FRAMES = 2400           // 2 minutes at 20/s - plenty, and bounded

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
        var frames = []
        try {
            var fr = get('frames', null)
            if (fr) {
                for (var i = 0; i < fr.length; i++) {
                    var f = fr[i]
                    frames.push({
                        x: Number(f.x), y: Number(f.y), z: Number(f.z),
                        yaw: Number(f.yaw), pitch: Number(f.pitch)
                    })
                }
            }
        } catch (e) {}
        return {
            dim: String(get('dim', 'minecraft:overworld')),
            intro: !!get('intro', false),
            frames: frames
        }
    }

    var cfg = loadConfig()

    function saveConfig() {
        try {
            JsonIO.write(CONFIG_PATH, { dim: cfg.dim, intro: cfg.intro, frames: cfg.frames })
            return true
        } catch (e) {
            console.error('[cutscene] could not write ' + CONFIG_PATH + ': ' + e)
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

    function rotOf(p) {
        var yaw = NaN, pitch = NaN
        try { yaw = Number(p.yaw); pitch = Number(p.pitch) } catch (e) {}
        if (isNaN(yaw)) { try { yaw = Number(p.yRot); pitch = Number(p.xRot) } catch (e) {} }
        if (isNaN(yaw)) yaw = 0
        if (isNaN(pitch)) pitch = 0
        return { yaw: yaw, pitch: pitch }
    }

    function safeName(n) { return String(n).replace(/[^A-Za-z0-9_]/g, '') }

    // Recording and playback state are per-session, never persisted: a
    // half-finished recording or an interrupted playback must not survive a
    // reload and leave somebody stuck in spectator.
    var recording = null            // { name: [...frames] }
    var playing = {}                // name -> { i, gamemode, back }

    // ------------------------------------------------------------ titles --

    // Beats are shown at given frame numbers during playback. Text only -
    // the Full Hearts logo as an image would need a resource pack, which
    // means every family re-imports the client pack.
    //
    // NOTHING goes through `title <p> title`. That line is drawn at 4x scale
    // and is not wrapped or shrunk to fit, so a brand name that looks fine on
    // a 1080p window runs off both edges at a higher GUI scale or on a small
    // one - which is exactly what happened. The headline rides on the
    // SUBTITLE line (2x) and the detail on the ACTION BAR (1x, one line, never
    // scaled). Keep `head` under ~16 characters and it fits at any GUI scale.
    var BEATS = [
        { at: 10,  head: '\\u2665 FULL HEARTS', sub: 'a modpack that just launches', colour: 'red' },
        { at: 200, head: 'EduCraft', sub: 'build, explore, reach the stars', colour: 'gold' },
        { at: 420, head: 'Welcome', sub: 'your adventure starts now', colour: 'aqua' }
    ]

    function showBeat(server, name, beat) {
        server.runCommandSilent('title ' + name + ' times 10 50 20')
        server.runCommandSilent('title ' + name + ' title {"text":""}')
        server.runCommandSilent('title ' + name + ' subtitle {"text":"' + beat.head +
            '","bold":true,"color":"' + beat.colour + '"}')
        server.runCommandSilent('title ' + name + ' actionbar {"text":"' + beat.sub + '","color":"white"}')
        server.runCommandSilent('execute at ' + name +
            ' run playsound minecraft:block.note_block.chime player ' + name + ' ~ ~ ~ 0.6 1.2')
    }

    // --------------------------------------------------------- playback --

    // Whatever this build exposes as the player's gamemode, it is NOT fed to
    // the `gamemode` command unvalidated. `String(player.gameMode)` returned
    // something that is not a mode name (ServerPlayer.gameMode is the
    // ServerPlayerGameMode handler object, not the GameType enum), so the
    // restore command failed silently and left the viewer in spectator - no
    // collision, which is why they ended up "in the sky". Several accessors
    // are tried and the answer is only accepted if it is one of the four real
    // mode names; anything else means survival.
    function gameModeOf(player) {
        var tries = []
        try { tries.push(player.gameMode.gameModeForPlayer) } catch (e) {}
        try { tries.push(player.gameMode) } catch (e) {}
        try { tries.push(player.gameType) } catch (e) {}
        for (var i = 0; i < tries.length; i++) {
            var s = ''
            try { s = String(tries[i]).toLowerCase() } catch (e) { continue }
            // Spectator is never a restore target: a viewer who was somehow
            // already spectating would otherwise be left floating for good.
            if (s === 'survival' || s === 'creative' || s === 'adventure') return s
        }
        return 'survival'
    }

    // Where a viewer is set down when the shot ends. The hub floor if an op
    // has set one (hub.js owns that config), otherwise the last frame of the
    // flight, which is where the camera came to rest.
    function landingSpot() {
        var raw = null
        try { raw = JsonIO.read('kubejs/config/hub.json') } catch (e) { raw = null }
        try {
            if (raw && raw.spawn_dim && String(raw.spawn_dim) !== '') {
                return {
                    dim: String(raw.spawn_dim),
                    x: Number(raw.spawn_x), y: Number(raw.spawn_y), z: Number(raw.spawn_z),
                    yaw: Number(raw.spawn_yaw), pitch: Number(raw.spawn_pitch)
                }
            }
        } catch (e) {}
        var f = cfg.frames[cfg.frames.length - 1]
        if (!f) return null
        return { dim: cfg.dim, x: f.x, y: f.y, z: f.z, yaw: f.yaw, pitch: 0 }
    }

    // ------------------------------------------------ chunk preloading --

    // The camera outruns chunk streaming: teleporting 20 times a second
    // through terrain the client has never seen means it flies through grey
    // void, because chunks are only sent once the viewer is near them and
    // they arrive well behind the camera.
    //
    // Two things fix it together, and neither is enough alone:
    //   1. forceload the ground the flight covers, so the SERVER has those
    //      chunks resident and can send them immediately rather than
    //      generating or reading them from disk mid-shot;
    //   2. hold the camera still at frame 0 for a moment (WARMUP below) so
    //      the CLIENT has time to receive and build them before anything
    //      moves.
    //
    // Forceload is bounded deliberately. It is a memory cost for as long as
    // it is held, and an unbounded box around a long flight would pin
    // hundreds of chunks; past FORCELOAD_MAX we skip it entirely and rely on
    // the warmup, rather than quietly pinning more than anyone intended.
    var WARMUP = 70                 // ticks held at frame 0 (~3.5s)
    var FORCELOAD_MAX = 400         // chunks; a 20x20 box

    function pathBounds() {
        if (cfg.frames.length === 0) return null
        var f = cfg.frames[0]
        var b = { minx: f.x, maxx: f.x, minz: f.z, maxz: f.z }
        for (var i = 1; i < cfg.frames.length; i++) {
            var p = cfg.frames[i]
            if (p.x < b.minx) b.minx = p.x
            if (p.x > b.maxx) b.maxx = p.x
            if (p.z < b.minz) b.minz = p.z
            if (p.z > b.maxz) b.maxz = p.z
        }
        return b
    }

    // Held once for everyone watching, not once per viewer: two players
    // joining together would otherwise add and then remove the same ticket,
    // and the first to finish would unload it from under the second.
    var forceloadHolders = 0

    function forceloadPath(server, on) {
        if (cfg.dim === '') return
        if (on) {
            forceloadHolders++
            if (forceloadHolders > 1) return
        } else {
            forceloadHolders--
            if (forceloadHolders > 0) return
            forceloadHolders = 0
            server.runCommandSilent('execute in ' + cfg.dim + ' run forceload remove all')
            return
        }
        var b = pathBounds()
        if (!b) return
        // One chunk of margin so the viewer is never looking at the ragged
        // edge of the loaded area.
        var cminx = Math.floor(b.minx / 16) - 1, cmaxx = Math.floor(b.maxx / 16) + 1
        var cminz = Math.floor(b.minz / 16) - 1, cmaxz = Math.floor(b.maxz / 16) + 1
        var count = (cmaxx - cminx + 1) * (cmaxz - cminz + 1)
        if (count > FORCELOAD_MAX) {
            console.info('[cutscene] flight covers ' + count + ' chunks, over the ' +
                FORCELOAD_MAX + ' cap - skipping forceload, warmup only')
            forceloadHolders = 0
            return
        }
        server.runCommandSilent('execute in ' + cfg.dim + ' run forceload add ' +
            (cminx * 16) + ' ' + (cminz * 16) + ' ' + (cmaxx * 16) + ' ' + (cmaxz * 16))
    }

    function startPlayback(server, player) {
        if (cfg.frames.length === 0) return false
        var name = safeName(player.username)
        if (name === '') return false
        playing[name] = { i: 0, gamemode: gameModeOf(player), warmup: WARMUP }
        // A marker on the player, not just in memory: if the server reloads or
        // they log out mid-shot, nothing in `playing` survives and they would
        // stay in spectator forever. The login handler below clears it.
        try { player.persistentData.putBoolean('introStuck', true) } catch (e) {}
        server.runCommandSilent('gamemode spectator ' + name)
        forceloadPath(server, true)
        // Put the camera on frame 0 immediately and leave it there for the
        // warmup, so the client is loading the opening shot rather than
        // wherever the player happened to spawn.
        var f0 = cfg.frames[0]
        server.runCommandSilent('execute in ' + cfg.dim + ' run tp ' + name + ' ' +
            f0.x + ' ' + f0.y + ' ' + f0.z + ' ' + f0.yaw + ' ' + f0.pitch)
        // Black out the warmup so the grey-void moment is never on screen.
        server.runCommandSilent('title ' + name + ' times 0 ' + (WARMUP + 20) + ' 10')
        server.runCommandSilent('title ' + name + ' title {"text":""}')
        return true
    }

    function endPlayback(server, name) {
        var st = playing[name]
        if (!st) return
        delete playing[name]
        forceloadPath(server, false)
        restore(server, name, st.gamemode)
    }

    function restore(server, name, gamemode) {
        var at = landingSpot()
        // Gamemode BEFORE the teleport: a spectator does not collide, and
        // placing a still-spectating player on the floor just lets them drift
        // through it.
        server.runCommandSilent('gamemode ' + gamemode + ' ' + name)
        if (at) {
            server.runCommandSilent('execute in ' + at.dim + ' run tp ' + name + ' ' +
                at.x + ' ' + at.y + ' ' + at.z + ' ' +
                (isNaN(at.yaw) ? 0 : at.yaw) + ' ' + (isNaN(at.pitch) ? 0 : at.pitch))
        }
        server.runCommandSilent('title ' + name + ' clear')
        var p = server.getPlayer(name)
        if (p) { try { p.persistentData.putBoolean('introStuck', false) } catch (e) {} }
    }

    ServerEvents.tick(event => {
        var server = event.server

        // --- sampling a recording ---
        if (recording) {
            var rp = server.getPlayer(recording.name)
            if (rp) {
                var r = rotOf(rp)
                recording.frames.push({
                    x: rp.x, y: rp.y, z: rp.z, yaw: r.yaw, pitch: r.pitch
                })
                if (recording.frames.length >= MAX_FRAMES) {
                    cfg.frames = recording.frames
                    cfg.dim = dimOf(rp.level)
                    saveConfig()
                    rp.tell(Text.gold('Recording hit the length cap and was saved automatically.'))
                    recording = null
                }
            }
        }

        // --- driving playbacks ---
        for (var name in playing) {
            var st = playing[name]
            // Warmup: hold on frame 0 while the client receives the chunks
            // the opening shot looks at. Re-teleporting each tick keeps the
            // camera pinned and the chunk requests centred on the shot.
            if (st.warmup > 0) {
                st.warmup--
                var w = cfg.frames[0]
                server.runCommandSilent('execute in ' + cfg.dim + ' run tp ' + name + ' ' +
                    w.x + ' ' + w.y + ' ' + w.z + ' ' + w.yaw + ' ' + w.pitch)
                continue
            }
            var f = cfg.frames[st.i]
            if (!f) { endPlayback(server, name); continue }
            server.runCommandSilent('execute in ' + cfg.dim + ' run tp ' + name + ' ' +
                f.x + ' ' + f.y + ' ' + f.z + ' ' + f.yaw + ' ' + f.pitch)
            for (var b = 0; b < BEATS.length; b++) {
                if (BEATS[b].at === st.i) showBeat(server, name, BEATS[b])
            }
            st.i++
        }
    })

    // Plays once per player, on their first join. `/cutscene again` re-arms
    // it for one person; `/cutscene intro off` stops it for everyone.
    PlayerEvents.loggedIn(event => {
        var player = event.player
        var d = null
        try { d = player.persistentData } catch (e) { return }

        // Rescue first: somebody whose playback was cut short by a logout or a
        // reload comes back still in spectator, and `playing` did not survive.
        if (d.getBoolean('introStuck')) {
            d.putBoolean('introStuck', false)
            restore(event.server, safeName(player.username), 'survival')
            return
        }

        if (!cfg.intro || cfg.frames.length === 0) return
        if (d.getBoolean('introSeen')) return
        d.putBoolean('introSeen', true)
        d.putBoolean('introPending', true)
        d.putInt('introDelay', 0)
    })

    // A viewer who quits mid-shot must not leave their entry in `playing`:
    // the tick loop would go on teleporting a player who is not there, and
    // the forceload ticket would never be released.
    PlayerEvents.loggedOut(event => {
        var name = safeName(event.player.username)
        if (playing[name]) {
            delete playing[name]
            forceloadPath(event.server, false)
        }
    })

    // Give the client a moment to finish loading before yanking the camera,
    // or the first second of the shot plays against a grey screen.
    PlayerEvents.tick(event => {
        var player = event.player
        var d = player.persistentData
        if (!d.getBoolean('introPending')) return
        var delay = d.getInt('introDelay') + 1
        d.putInt('introDelay', delay)
        if (delay < 40) return
        d.putBoolean('introPending', false)
        startPlayback(event.server, player)
    })

    // ---------------------------------------------------------- commands --

    ServerEvents.commandRegistry(event => {
        var Commands = event.commands
        var requireOp = src => src.hasPermission(2)

        event.register(
            Commands.literal('cutscene')
                .then(Commands.literal('record').requires(requireOp).executes(ctx => {
                    var player = ctx.source.player
                    if (!player) return 0
                    recording = { name: String(player.username), frames: [] }
                    player.tell(Text.green('RECORDING. Fly the shot, then /cutscene stop.'))
                    player.tell(Text.gray('Spectator mode gives the smoothest result.'))
                    return 1
                }))
                .then(Commands.literal('stop').requires(requireOp).executes(ctx => {
                    var player = ctx.source.player
                    if (!player) return 0
                    if (!recording) {
                        player.tell(Text.gold('Not recording.'))
                        return 0
                    }
                    cfg.frames = recording.frames
                    cfg.dim = dimOf(player.level)
                    recording = null
                    saveConfig()
                    player.tell(Text.green('Saved ' + cfg.frames.length + ' frames (' +
                        Math.round(cfg.frames.length / 20) + ' seconds).'))
                    player.tell(Text.gray('Preview it with /cutscene play'))
                    return 1
                }))
                .then(Commands.literal('play').executes(ctx => {
                    var player = ctx.source.player
                    if (!player) return 0
                    if (cfg.frames.length === 0) {
                        player.tell(Text.gold('Nothing recorded yet.'))
                        return 0
                    }
                    startPlayback(ctx.source.server, player)
                    return 1
                }))
                .then(Commands.literal('cancel').executes(ctx => {
                    var player = ctx.source.player
                    if (!player) return 0
                    endPlayback(ctx.source.server, safeName(player.username))
                    player.tell(Text.gray('Cutscene stopped.'))
                    return 1
                }))
                .then(Commands.literal('intro').requires(requireOp)
                    .then(Commands.literal('on').executes(ctx => {
                        cfg.intro = true
                        saveConfig()
                        if (ctx.source.player) ctx.source.player.tell(Text.green('Intro will play on each player first join.'))
                        return 1
                    }))
                    .then(Commands.literal('off').executes(ctx => {
                        cfg.intro = false
                        saveConfig()
                        if (ctx.source.player) ctx.source.player.tell(Text.gray('Intro disabled.'))
                        return 1
                    })))
                .then(Commands.literal('again').requires(requireOp).executes(ctx => {
                    var player = ctx.source.player
                    if (!player) return 0
                    try { player.persistentData.putBoolean('introSeen', false) } catch (e) {}
                    player.tell(Text.green('You will see the intro again on your next join.'))
                    return 1
                }))
                .then(Commands.literal('clear').requires(requireOp).executes(ctx => {
                    cfg.frames = []
                    saveConfig()
                    if (ctx.source.player) ctx.source.player.tell(Text.green('Recording cleared.'))
                    return 1
                }))
        )
    })
})()
