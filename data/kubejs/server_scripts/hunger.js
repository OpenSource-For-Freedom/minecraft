// Slow hunger down, without switching it off.
//
// Children were spending the session eating instead of building. Peaceful
// difficulty or a permanent saturation effect would remove the mechanic
// entirely; this keeps it visible and meaningful but stretches it out, so
// food matters a few times a session rather than every few minutes.
//
// HOW: Minecraft does not drain the hunger bar directly. Every action adds
// to a hidden `exhaustion` counter, and each time that counter passes 4.0
// the game spends 4.0 of it to take a point of saturation, and then of
// hunger. So the honest way to slow hunger is to let only a fraction of each
// tick's exhaustion GAIN stick, which scales the whole system uniformly:
// sprinting still costs more than standing, it just all takes longer.
//
// Scaling the gain rather than clamping the total matters. Clamping
// exhaustion to zero would stop hunger completely and also freeze natural
// regeneration, which spends saturation - players would never heal.
//
// The FoodData accessors here were verified live against this server, not
// assumed: `foodData.exhaustionLevel` reads, but assigning to it throws
// "no public instance field or method named exhaustionLevel". The setter is
// `setExhaustion(float)`. Probed before this file was written, because
// guessing KubeJS APIs has cost this server several debugging sessions.

(function () {
    // Fraction of each tick's exhaustion gain that is kept.
    // 1.0 = vanilla, 0.2 = hunger drains five times slower.
    var RATE = 0.2

    // Last exhaustion value we are responsible for, per player. Compared
    // against the live value each tick to find how much the game added.
    var lastExh = {}

    ServerEvents.tick(event => {
        var players = event.server.players
        for (var i = 0; i < players.length; i++) {
            var p = players[i]
            var name = String(p.username)

            var fd = null
            try { fd = p.foodData } catch (e) { continue }
            if (!fd) continue

            var cur = NaN
            try { cur = Number(fd.exhaustionLevel) } catch (e) { continue }
            if (isNaN(cur)) continue

            var prev = lastExh[name]
            if (prev === undefined) { lastExh[name] = cur; continue }

            if (cur > prev) {
                // The game added exhaustion this tick. Keep only RATE of it.
                var kept = prev + (cur - prev) * RATE
                try { fd.setExhaustion(kept) } catch (e) { lastExh[name] = cur; continue }
                lastExh[name] = kept
            } else {
                // Went down or stayed level: the game spent 4.0 of it on a
                // hunger point, or nothing happened. Resync and leave alone.
                lastExh[name] = cur
            }
        }
    })

    // Without this the table grows for every player who ever joins, and a
    // returning player inherits a stale baseline from their last session.
    PlayerEvents.loggedOut(event => {
        delete lastExh[String(event.player.username)]
    })
})()
