// Automatically claim the chunk a player logs in at, so kids never have to
// remember /claim for their base to be protected.
//
// WHY A SPAWN GUARD. Claiming on login sounds simple until the first person to
// join claims the spawn chunk and locks everyone else out of it, permanently
// and silently. Spawn is shared ground, so anything within SPAWN_RADIUS is
// skipped. That is the one case where "claim where you stand" is actively
// wrong.
//
// Ops bypass claims anyway, so this changes nothing for admins.
// Unclaimed wilderness stays unprotected on purpose: otherwise nobody could
// mine anywhere.

const SPAWN_RADIUS = 96      // blocks around world spawn that are never auto-claimed
const DELAY_TICKS  = 60      // ~3s after login, so the world is loaded and the
                             // player is actually placed before we run a command

PlayerEvents.loggedIn(event => {
    event.player.persistentData.putInt('autoclaimDelay', 1)
})

PlayerEvents.tick(event => {
    const player = event.player
    const data = player.persistentData
    let t = data.getInt('autoclaimDelay')
    if (t <= 0) return

    t += 1
    if (t < DELAY_TICKS) { data.putInt('autoclaimDelay', t); return }
    data.putInt('autoclaimDelay', 0)

    try {
        // Overworld only. Claiming in the Nether/End on arrival is not wanted,
        // and Ad Astra's planets are their own dimensions.
        if (player.level.dimension !== 'minecraft:overworld') return

        // var, not const: Rhino aborts the whole try block on const/let inside it
        // (see tests/test_kubejs_script_hazards.py), so the catch always won and
        // nothing was ever claimed.
        var spawn = player.level.getLevelData().getSpawnPos ?
              player.level.getLevelData().getSpawnPos() : null
        if (spawn) {
            var dx = player.x - spawn.x
            var dz = player.z - spawn.z
            if ((dx * dx + dz * dz) < (SPAWN_RADIUS * SPAWN_RADIUS)) {
                return   // shared ground, leave it unclaimed
            }
        }

        var name = player.username
        player.server.runCommandSilent(
            `execute as ${name} at ${name} run claim`)
    } catch (err) {
        console.warn('autoclaim skipped for ' + player.username + ': ' + err)
    }
})
