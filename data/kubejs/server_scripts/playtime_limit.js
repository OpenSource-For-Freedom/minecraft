// Daily playtime cap per player. Config: kubejs/config/playtime_limits.json.
// After editing the config, run `/kubejs reload server_scripts` or restart the
// container to apply changes (config is read once at script load).
//
// Ops are always exempt, checked live against ops.json - opping/deopping a
// player takes effect immediately, no config edit needed. The config's own
// "exempt" list is for anyone else you want unlimited without making them op.
//
// Time is tracked in each player's own persistent data (survives relogs and
// restarts within the same day) and resets automatically when the local date
// (server TZ) changes - no external scheduler needed.

const LocalDate = Java.loadClass('java.time.LocalDate')
const CONFIG = JsonIO.read('kubejs/config/playtime_limits.json') || { default_minutes: 120, exempt: [], players: {} }

// Announce on load. DEPLOY.md and the CHANGELOG both claimed for a month that
// there was "no time limit of any kind" while this script was tracked, mounted
// and running, because the Windows playtime_limit.ps1 was deleted at the same
// time and the two got conflated. Nothing in the server output said either way.
// This line is how anyone checks in future: `docker logs minecraft-java | grep playtime`.
console.info('[playtime] limiter ACTIVE - default ' + CONFIG.default_minutes
    + ' min/day, ' + ((CONFIG.exempt || []).length) + ' exempt, '
    + Object.keys(CONFIG.players || {}).length + ' per-player override(s). Ops are always exempt.')

function limitSecondsFor(player) {
    if (player.isOp()) return -1 // ops are always unlimited, checked live against ops.json - no config needed
    const username = player.username
    if (CONFIG.exempt && CONFIG.exempt.indexOf(username) !== -1) return -1 // -1 = unlimited
    const minutes = (CONFIG.players && CONFIG.players[username] !== undefined)
        ? CONFIG.players[username]
        : CONFIG.default_minutes
    return minutes * 60
}

PlayerEvents.tick(event => {
    const player = event.player
    const data = player.persistentData
    const ticks = data.getInt('ptTicks') + 1

    if (ticks % 20 !== 0) {
        data.putInt('ptTicks', ticks)
        return
    }
    data.putInt('ptTicks', ticks)

    const today = LocalDate.now().toString()
    if (data.getString('ptDate') !== today) {
        data.putString('ptDate', today)
        data.putInt('ptSeconds', 0)
    }

    const seconds = data.getInt('ptSeconds') + 1
    data.putInt('ptSeconds', seconds)

    const limitSeconds = limitSecondsFor(player)
    if (limitSeconds < 0) return // exempt player

    const remaining = limitSeconds - seconds

    if (remaining === 600 || remaining === 300 || remaining === 60) {
        player.tell(Text.gold('Heads up: ' + Math.ceil(remaining / 60) + ' minute(s) of playtime left today.'))
    }

    if (remaining <= 0) {
        player.kick(Text.red("Your playtime for today is up! Come back tomorrow."))
    }
})

ServerEvents.commandRegistry(event => {
    const { commands: Commands } = event
    event.register(
        Commands.literal('playtime')
            .executes(ctx => {
                const player = ctx.source.player
                if (!player) return 0

                const limitSeconds = limitSecondsFor(player)
                const used = player.persistentData.getInt('ptSeconds')
                const usedMin = Math.floor(used / 60)

                if (limitSeconds < 0) {
                    // Ops and exempt players have no cap, so their own numbers say
                    // nothing about whether the limiter works. Report its state
                    // instead: this is the admin answer to "is it actually on?".
                    player.tell(Text.gold('Playtime limiter: ACTIVE'))
                    player.tell(Text.white('- You are exempt, so no cap applies to you.'))
                    player.tell(Text.white('- Default cap for everyone else: ' + CONFIG.default_minutes + ' minutes per day.'))
                    player.tell(Text.white('- You have played ' + usedMin + ' minute(s) today.'))
                    return 1
                }

                const remainingMin = Math.max(0, Math.ceil((limitSeconds - used) / 60))
                player.tell(Text.gold('You have played ' + usedMin + ' minute(s) today.'))
                player.tell(Text.white(remainingMin + ' minute(s) left before the daily limit.'))
                return 1
            })
    )
})
