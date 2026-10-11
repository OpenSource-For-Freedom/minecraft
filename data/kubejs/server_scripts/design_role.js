// Design role: lets named players shape the world without being op.
//
// Players listed in kubejs/config/designers.json get:
//   - creative mode, set every time they log in
//   - /design fill, /design setblock, /design clone and /design tp, limited to
//     a square zone around a centre point and to plain blocks
//
// They get NOTHING else. They are not op, so every vanilla command that
// touches other players (/kill, /tp <player>, /give, /effect, /clear, /kick,
// /ban, /op, /whitelist, /stop) stays out of reach. The /design commands run
// the matching vanilla command as the server, but only after the arguments
// pass a strict check:
//   - coordinates are plain integers (no ~ or ^, no selectors like @a)
//   - every position is inside the design zone, in the overworld
//   - block ids are bare "namespace:name": no [states] and no {nbt}, so no
//     pre-filled chests, no signs with text, and no command block contents
//   - command blocks, structure blocks and jigsaw blocks are refused outright
//
// FAIL CLOSED. If the config can't be read, nobody is a designer and the
// commands are hidden. A broken file takes powers away, never hands them out.
//
// Block changes made through /design are NOT recorded by PrismProtect, so they
// can't be rolled back with it. That is why the zone exists: keep it around
// the area being designed, away from the kids' builds.
//
// Every /design command is logged as "[design] <name>: <command>", which the
// droplet's Discord alerts (alerts/security_alert.sh) report for watched
// players.
//
// Follows the two Rhino rules in hub.js: everything lives inside an IIFE, and
// nothing is declared with const or let inside a try block.

(function () {
    const DESIGN_CONFIG_PATH = 'kubejs/config/designers.json'
    const DESIGN_NAME_RE = /^[A-Za-z0-9_]{3,16}$/
    const DESIGN_INT_RE = /^-?[0-9]{1,8}$/
    const DESIGN_BLOCK_RE = /^[a-z0-9_.-]+:[a-z0-9_/.-]+$/
    const DESIGN_DENY_BLOCKS = [
        'minecraft:command_block',
        'minecraft:chain_command_block',
        'minecraft:repeating_command_block',
        'minecraft:structure_block',
        'minecraft:structure_void',
        'minecraft:jigsaw'
    ]
    const DESIGN_FILL_MODES = ['replace', 'hollow', 'outline', 'keep']
    const DESIGN_MAX_VOLUME = 32768   // vanilla's own /fill and /clone limit
    const DESIGN_MIN_Y = -64
    const DESIGN_MAX_Y = 319

    function designReadKey(raw, key, fallback) {
        if (!raw) return fallback
        try {
            var v = raw[key]
            if (v === undefined || v === null) return fallback
            return v
        } catch (e) {
            return fallback
        }
    }

    function designLoadConfig() {
        var raw = null
        try { raw = JsonIO.read(DESIGN_CONFIG_PATH) } catch (e) { raw = null }
        const names = String(designReadKey(raw, 'players', ''))
            .split(',')
            .map(s => s.trim())
            .filter(s => DESIGN_NAME_RE.test(s))
        return {
            players: names,
            creative_on_login: !!designReadKey(raw, 'creative_on_login', true),
            center_x: Math.round(Number(designReadKey(raw, 'zone_center_x', 0))),
            center_z: Math.round(Number(designReadKey(raw, 'zone_center_z', 0))),
            // 0 when unset, which makes the zone a single column: effectively
            // no zone, so a missing radius can't mean "the whole world".
            radius: Math.max(0, Math.round(Number(designReadKey(raw, 'zone_radius', 0))))
        }
    }

    const designCfg = designLoadConfig()

    function isDesignerName(name) {
        return designCfg.players.indexOf(String(name)) !== -1
    }

    function inZone(x, y, z) {
        return Math.abs(x - designCfg.center_x) <= designCfg.radius &&
            Math.abs(z - designCfg.center_z) <= designCfg.radius &&
            y >= DESIGN_MIN_Y && y <= DESIGN_MAX_Y
    }

    function zoneText() {
        return 'x ' + (designCfg.center_x - designCfg.radius) + ' to ' + (designCfg.center_x + designCfg.radius) +
            ', z ' + (designCfg.center_z - designCfg.radius) + ' to ' + (designCfg.center_z + designCfg.radius)
    }

    // Parse n integer coordinates as positions of 3. Returns an array of
    // [x, y, z] triples, or a string explaining what is wrong.
    function parsePositions(parts, count) {
        if (parts.length < count * 3) return 'not enough coordinates'
        const out = []
        for (var i = 0; i < count; i++) {
            var p = []
            for (var j = 0; j < 3; j++) {
                var s = parts[i * 3 + j]
                if (!DESIGN_INT_RE.test(s)) return 'coordinates must be whole numbers, got "' + s + '"'
                p.push(parseInt(s, 10))
            }
            if (!inZone(p[0], p[1], p[2])) return p.join(' ') + ' is outside the design zone (' + zoneText() + ')'
            out.push(p)
        }
        return out
    }

    function checkBlock(id) {
        if (!DESIGN_BLOCK_RE.test(id)) return 'use a plain block id like minecraft:stone (no [states] or {data})'
        if (DESIGN_DENY_BLOCKS.indexOf(id) !== -1) return id + ' is not allowed'
        return ''
    }

    function volume(a, b) {
        return (Math.abs(a[0] - b[0]) + 1) * (Math.abs(a[1] - b[1]) + 1) * (Math.abs(a[2] - b[2]) + 1)
    }

    // Turn "/design <kind> <args>" into the vanilla command to run, or an
    // error message. Pure, so it can be tested without a server.
    function buildDesignCommand(kind, name, argText) {
        const parts = String(argText || '').trim().split(/\s+/).filter(s => s.length > 0)
        var pos, err
        if (kind === 'setblock') {
            if (parts.length !== 4) return { error: 'usage: /design setblock x y z block' }
            pos = parsePositions(parts, 1)
            if (typeof pos === 'string') return { error: pos }
            err = checkBlock(parts[3])
            if (err) return { error: err }
            return { command: 'setblock ' + pos[0].join(' ') + ' ' + parts[3] }
        }
        if (kind === 'fill') {
            if (parts.length !== 7 && parts.length !== 8) return { error: 'usage: /design fill x1 y1 z1 x2 y2 z2 block [replace|hollow|outline|keep]' }
            pos = parsePositions(parts, 2)
            if (typeof pos === 'string') return { error: pos }
            err = checkBlock(parts[6])
            if (err) return { error: err }
            if (volume(pos[0], pos[1]) > DESIGN_MAX_VOLUME) return { error: 'too big: at most ' + DESIGN_MAX_VOLUME + ' blocks at once' }
            var mode = parts.length === 8 ? parts[7] : ''
            if (mode && DESIGN_FILL_MODES.indexOf(mode) === -1) return { error: 'mode must be one of ' + DESIGN_FILL_MODES.join(', ') }
            return { command: 'fill ' + pos[0].join(' ') + ' ' + pos[1].join(' ') + ' ' + parts[6] + (mode ? ' ' + mode : '') }
        }
        if (kind === 'clone') {
            if (parts.length !== 9) return { error: 'usage: /design clone x1 y1 z1 x2 y2 z2 x y z' }
            pos = parsePositions(parts, 3)
            if (typeof pos === 'string') return { error: pos }
            if (volume(pos[0], pos[1]) > DESIGN_MAX_VOLUME) return { error: 'too big: at most ' + DESIGN_MAX_VOLUME + ' blocks at once' }
            // The far corner of the destination must be in the zone too.
            var far = [
                pos[2][0] + Math.abs(pos[0][0] - pos[1][0]),
                pos[2][1] + Math.abs(pos[0][1] - pos[1][1]),
                pos[2][2] + Math.abs(pos[0][2] - pos[1][2])
            ]
            if (!inZone(far[0], far[1], far[2])) return { error: 'the copy would reach outside the design zone (' + zoneText() + ')' }
            return { command: 'clone ' + pos[0].join(' ') + ' ' + pos[1].join(' ') + ' ' + pos[2].join(' ') }
        }
        if (kind === 'tp') {
            if (parts.length !== 3) return { error: 'usage: /design tp x y z' }
            pos = parsePositions(parts, 1)
            if (typeof pos === 'string') return { error: pos }
            if (!DESIGN_NAME_RE.test(String(name))) return { error: 'unusual username' }
            return { command: 'tp ' + name + ' ' + pos[0].join(' ') }
        }
        return { error: 'unknown design command' }
    }

    function sourceIsDesigner(src) {
        var player = null
        try { player = src.player } catch (e) { player = null }
        if (!player) return false
        return isDesignerName(player.username)
    }

    // ------------------------------------------------------------- joins --

    PlayerEvents.loggedIn(event => {
        const player = event.player
        const name = String(player.username)
        if (!isDesignerName(name) || !designCfg.creative_on_login) return
        event.server.runCommandSilent('gamemode creative ' + name)
        console.info('[design] ' + name + ': joined as designer (creative)')
        player.tell(Text.green('Design mode: creative. Type /design for building commands.'))
    })

    // ---------------------------------------------------------- commands --

    ServerEvents.commandRegistry(event => {
        const { commands: Commands, arguments: Arguments } = event

        function runDesign(ctx, kind) {
            const player = ctx.source.player
            if (!player) return 0
            const name = String(player.username)
            const argText = String(Arguments.GREEDY_STRING.getResult(ctx, 'args'))
            const built = buildDesignCommand(kind, name, argText)
            if (built.error) {
                player.tell(Text.red(built.error))
                return 0
            }
            console.info('[design] ' + name + ': ' + built.command)
            ctx.source.server.runCommandSilent('execute in minecraft:overworld run ' + built.command)
            player.tell(Text.gray('Done: ' + built.command))
            return 1
        }

        function sub(kind) {
            return Commands.literal(kind).then(
                Commands.argument('args', Arguments.GREEDY_STRING.create(event))
                    .executes(ctx => runDesign(ctx, kind)))
        }

        event.register(
            Commands.literal('design')
                .requires(src => sourceIsDesigner(src))
                .executes(ctx => {
                    const player = ctx.source.player
                    if (!player) return 0
                    player.tell(Text.gold('Design commands (zone: ' + zoneText() + ')'))
                    player.tell(Text.white('  /design fill x1 y1 z1 x2 y2 z2 block [replace|hollow|outline|keep]'))
                    player.tell(Text.white('  /design setblock x y z block'))
                    player.tell(Text.white('  /design clone x1 y1 z1 x2 y2 z2 x y z'))
                    player.tell(Text.white('  /design tp x y z'))
                    player.tell(Text.gray('  Whole-number coordinates only. Press F3 to see where you are.'))
                    return 1
                })
                .then(sub('fill'))
                .then(sub('setblock'))
                .then(sub('clone'))
                .then(sub('tp'))
        )
    })

    // Exposed for tests/test_design_role.js only. Harmless on the server.
    if (typeof DESIGN_ROLE_TEST_HOOK !== 'undefined') {
        DESIGN_ROLE_TEST_HOOK.buildDesignCommand = buildDesignCommand
        DESIGN_ROLE_TEST_HOOK.config = designCfg
    }
})()
