// Opens the EduCraft guide book and sends a welcome message the FIRST time a
// player ever joins (tracked in their own persistent data, so it never repeats
// on later joins), and registers /guide so they can reopen the book themselves
// anytime after that - external Patchouli books have no physical item to hold.

PlayerEvents.loggedIn(event => {
    const player = event.player
    const data = player.persistentData
    if (data.getBoolean('onboarded')) return
    data.putBoolean('pendingWelcome', true)
    data.putInt('welcomeDelayTicks', 0)
})

PlayerEvents.tick(event => {
    const player = event.player
    const data = player.persistentData
    if (!data.getBoolean('pendingWelcome')) return

    const ticks = data.getInt('welcomeDelayTicks') + 1
    data.putInt('welcomeDelayTicks', ticks)
    if (ticks < 40) return // wait ~2s after login so the client is ready for a GUI

    data.putBoolean('pendingWelcome', false)
    data.putBoolean('onboarded', true)

    event.server.runCommandSilent('open-patchouli-book ' + player.username + ' patchouli:educraft_guide')

    player.tell(Text.gold('Welcome to the server, ' + player.username + '!'))
    player.tell(Text.white('- Only whitelisted players can join - keep it that way, just you and your approved friends.'))
    player.tell(Text.white('- Your daily playtime is tracked automatically and resets every day.'))
    player.tell(Text.white('- Type /guide anytime to reopen this guide book.'))
})

ServerEvents.commandRegistry(event => {
    const { commands: Commands } = event
    event.register(
        Commands.literal('guide').executes(ctx => {
            const player = ctx.source.player
            if (!player) return 0
            ctx.source.server.runCommandSilent('open-patchouli-book ' + player.username + ' patchouli:educraft_guide')
            return 1
        })
    )
})
