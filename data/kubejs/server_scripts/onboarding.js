// Opens the EduCraft guide book and sends a welcome message the FIRST time a
// player ever joins (tracked in their own persistent data, so it never repeats
// on later joins), and registers /guide so they can reopen the book themselves
// anytime after that - external Patchouli books have no physical item to hold.
//
// Returning players get a short one-line reminder instead of the full welcome,
// unless they've turned it off with /guide disable (re-enable with /guide
// enable). Either way /guide itself always works - only the on-join reminder
// is what gets toggled.

PlayerEvents.loggedIn(event => {
    const player = event.player
    const data = player.persistentData

    if (data.getBoolean('onboarded')) {
        if (!data.getBoolean('guideReminderOff')) {
            data.putBoolean('pendingReminder', true)
            data.putInt('reminderDelayTicks', 0)
        }
        return
    }

    data.putBoolean('pendingWelcome', true)
    data.putInt('welcomeDelayTicks', 0)
})

PlayerEvents.tick(event => {
    const player = event.player
    const data = player.persistentData

    if (data.getBoolean('pendingWelcome')) {
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
        player.tell(Text.gray("(If no book popped up just now, ask an admin to check your modpack is up to date.)"))
        return
    }

    if (data.getBoolean('pendingReminder')) {
        const ticks = data.getInt('reminderDelayTicks') + 1
        data.putInt('reminderDelayTicks', ticks)
        if (ticks < 40) return

        data.putBoolean('pendingReminder', false)
        player.tell(Text.gray('Type /guide to open your guide book. (/guide disable turns this reminder off)'))
    }
})

ServerEvents.commandRegistry(event => {
    const { commands: Commands } = event
    event.register(
        Commands.literal('guide')
            .executes(ctx => {
                const player = ctx.source.player
                if (!player) return 0
                ctx.source.server.runCommandSilent('open-patchouli-book ' + player.username + ' patchouli:educraft_guide')
                player.tell(Text.gray("(If the book didn't pop up, ask an admin to check your modpack is up to date.)"))
                return 1
            })
            .then(Commands.literal('disable').executes(ctx => {
                const player = ctx.source.player
                if (!player) return 0
                player.persistentData.putBoolean('guideReminderOff', true)
                player.tell(Text.gray("Okay, no more join reminder. /guide still works anytime - run /guide enable to bring the reminder back."))
                return 1
            }))
            .then(Commands.literal('enable').executes(ctx => {
                const player = ctx.source.player
                if (!player) return 0
                player.persistentData.putBoolean('guideReminderOff', false)
                player.tell(Text.gray("The join reminder is back on."))
                return 1
            }))
    )
})
