// Small milestone rewards, standing in for the quest system that was removed
// along with Questify (it and PrismProtect both shaded org.sqlite under the
// same package, a hard Forge module conflict - see git history). Each
// milestone fires once per player on first craft, tracked in persistentData
// the same way onboarding.js tracks 'onboarded'. The first three reuse the
// exact item/reward pairs the old Questify quests used; the rest cover the
// newer guide book sections.

const MILESTONES = [
    { id: 'quest_water_wheel', item: 'create:water_wheel', reward: 'minecraft:copper_ingot 8', message: 'You built your first Water Wheel! Create is all about rotational power - check the guide for what to build next.' },
    { id: 'quest_turtle', item: 'computercraft:turtle_normal', reward: 'minecraft:redstone 16', message: 'You crafted a Turtle! Check the Robots & Peripherals section of your guide book to program it.' },
    { id: 'quest_knife', item: 'farmersdelight:knife', reward: 'farmersdelight:bread 8', message: 'Time to cook! Your Knife is ready - pair it with a Cutting Board and a Cooking Pot.' },
    { id: 'quest_wallet', item: 'lightmanscurrency:wallet', reward: 'minecraft:emerald 4', message: "You've got a Wallet! Trade with a machine or another player to start earning coins." },
    { id: 'quest_waystone', item: 'waystones:waystone', reward: 'minecraft:ender_pearl 2', message: 'Your first Waystone! Place it, activate it, and never walk home again.' }
]

ItemEvents.crafted(event => {
    const player = event.player
    if (!player) return

    const data = player.persistentData
    const itemId = event.item.id

    MILESTONES.forEach(m => {
        if (m.item !== itemId) return
        if (data.getBoolean(m.id)) return
        data.putBoolean(m.id, true)

        player.tell(Text.aqua(m.message))
        event.server.runCommandSilent('give ' + player.username + ' ' + m.reward)
    })
})
