// Daily playtime cap per player. Config: kubejs/config/playtime_limits.json.
// After editing the config, run `/kubejs reload server_scripts` or restart the
// container to apply changes (config is read once at script load).
//
// Time is tracked in each player's own persistent data (survives relogs and
// restarts within the same day) and resets automatically when the local date
// (server TZ) changes - no external scheduler needed.

const LocalDate = Java.loadClass('java.time.LocalDate')
const CONFIG = JsonIO.read('kubejs/config/playtime_limits.json') || { default_minutes: 120, exempt: [], players: {} }

function limitSecondsFor(username) {
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

    const limitSeconds = limitSecondsFor(player.username)
    if (limitSeconds < 0) return // exempt player

    const remaining = limitSeconds - seconds

    if (remaining === 600 || remaining === 300 || remaining === 60) {
        player.tell(Text.gold('Heads up: ' + Math.ceil(remaining / 60) + ' minute(s) of playtime left today.'))
    }

    if (remaining <= 0) {
        player.kick(Text.red("Your playtime for today is up! Come back tomorrow."))
    }
})
