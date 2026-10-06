// Runs data/kubejs/server_scripts/design_role.js under Node with the KubeJS
// globals stubbed, and checks that /design only ever produces safe vanilla
// commands. This is the part of the role that decides what a non-op can do,
// so it is tested against inputs designed to escape it.
//
//   node tests/test_design_role.js
//
// It cannot prove the script loads under KubeJS's Rhino; load it on a local
// server for that (see CONTRIBUTING.md). It proves the rules are right.
'use strict'
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = path.resolve(__dirname, '..')
const SCRIPT = path.join(ROOT, 'data/kubejs/server_scripts/design_role.js')
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/kubejs/config/designers.json'), 'utf8'))

let failures = 0
let checks = 0
function check(name, cond, detail) {
    checks++
    if (cond) { console.log('PASS  ' + name) } else { failures++; console.log('FAIL  ' + name + (detail ? ' - ' + detail : '')) }
}

function load(config) {
    const hook = {}
    const handlers = { loggedIn: null, commandRegistry: null }
    const sandbox = {
        DESIGN_ROLE_TEST_HOOK: hook,
        JsonIO: { read: () => { if (config === 'throw') throw new Error('io'); return config } },
        PlayerEvents: { loggedIn: f => { handlers.loggedIn = f } },
        ServerEvents: { commandRegistry: f => { handlers.commandRegistry = f } },
        console: { info: () => {}, error: () => {} },
        Text: { red: s => s, green: s => s, gray: s => s, gold: s => s, white: s => s },
        Math, String, Number, parseInt, JSON
    }
    vm.runInNewContext(fs.readFileSync(SCRIPT, 'utf8'), sandbox, { filename: SCRIPT })
    return { hook, handlers }
}

const { hook, handlers } = load(CONFIG)
const build = (kind, args, name) => hook.buildDesignCommand(kind, name || 'SihabMaybe', args)
const cx = CONFIG.zone_center_x, cz = CONFIG.zone_center_z

console.log('== config ==')
check('the committed config lists SihabMaybe', hook.config.players.indexOf('SihabMaybe') !== -1)
check('the zone is centred on the world spawn', cx === 587 && cz === 87)

console.log('== allowed ==')
let r = build('setblock', `${cx} 70 ${cz} minecraft:stone`)
check('setblock in the zone', r.command === `setblock ${cx} 70 ${cz} minecraft:stone`, JSON.stringify(r))
r = build('fill', `${cx} 66 ${cz} ${cx + 10} 70 ${cz + 10} minecraft:oak_planks hollow`)
check('fill with a mode', r.command === `fill ${cx} 66 ${cz} ${cx + 10} 70 ${cz + 10} minecraft:oak_planks hollow`, JSON.stringify(r))
r = build('fill', `${cx} 66 ${cz} ${cx} 66 ${cz} create:andesite_casing`)
check('modded plain blocks are fine', !!r.command, JSON.stringify(r))
r = build('clone', `${cx} 66 ${cz} ${cx + 5} 70 ${cz + 5} ${cx + 20} 66 ${cz + 20}`)
check('clone inside the zone', !!r.command, JSON.stringify(r))
r = build('tp', `${cx} 80 ${cz}`)
check('tp moves only the player who asked', r.command === `tp SihabMaybe ${cx} 80 ${cz}`, JSON.stringify(r))

console.log('== refused ==')
const refused = [
    ['setblock', `${cx} 70 ${cz} minecraft:command_block`, 'command block'],
    ['setblock', `${cx} 70 ${cz} minecraft:repeating_command_block`, 'repeating command block'],
    ['setblock', `${cx} 70 ${cz} minecraft:structure_block`, 'structure block'],
    ['setblock', `${cx} 70 ${cz} minecraft:jigsaw`, 'jigsaw block'],
    ['setblock', `${cx} 70 ${cz} minecraft:chest{Items:[{id:"minecraft:tnt",Count:64b}]}`, 'NBT data'],
    ['setblock', `${cx} 70 ${cz} minecraft:oak_sign[rotation=4]`, 'block states'],
    ['setblock', `~ ~ ~ minecraft:stone`, 'relative coordinates'],
    ['setblock', `^ ^ ^ minecraft:stone`, 'local coordinates'],
    ['tp', `@a`, 'a selector'],
    ['tp', `SomeKid`, 'another player'],
    ['tp', `${cx} 80 ${cz} SomeKid`, 'an extra target'],
    ['setblock', `${cx} 70 ${cz} minecraft:stone\nkill @a`, 'a newline with a second command'],
    ['setblock', `${cx} 70 ${cz} minecraft:stone; kill @a`, 'a chained command'],
    ['setblock', `${cx + 151} 70 ${cz} minecraft:stone`, 'outside the zone on x'],
    ['setblock', `${cx} 70 ${cz - 151} minecraft:stone`, 'outside the zone on z'],
    ['setblock', `${cx} 400 ${cz} minecraft:stone`, 'above the build limit'],
    ['fill', `${cx - 150} 0 ${cz - 150} ${cx + 150} 10 ${cz + 150} minecraft:air`, 'a fill over the size limit'],
    ['fill', `${cx} 66 ${cz} ${cx + 1} 66 ${cz + 1} minecraft:stone destroy`, 'the destroy mode'],
    ['clone', `${cx} 66 ${cz} ${cx + 5} 70 ${cz + 5} ${cx + 148} 66 ${cz}`, 'a clone that spills out of the zone'],
    ['setblock', `1.5 70 ${cz} minecraft:stone`, 'decimal coordinates'],
    ['give', `SihabMaybe minecraft:diamond`, 'an unknown subcommand'],
]
for (const [kind, args, why] of refused) {
    r = build(kind, args)
    check('refuses ' + why, !r.command && !!r.error, JSON.stringify(r))
}

console.log('== fails closed ==')
let empty = load('throw').hook
check('an unreadable config makes nobody a designer', empty.config.players.length === 0)
empty = load({ players: 'bad name, @a, x' }).hook
check('invalid names in the config are ignored', empty.config.players.length === 0, JSON.stringify(empty.config.players))
empty = load({ players: 'SihabMaybe' }).hook
check('a missing radius allows only the centre column, not the world',
    !empty.buildDesignCommand('setblock', 'SihabMaybe', '1 70 1 minecraft:stone').command)

console.log('== wiring ==')
check('registers a login handler', typeof handlers.loggedIn === 'function')
check('registers the /design command', typeof handlers.commandRegistry === 'function')
let ran = []
handlers.loggedIn({ player: { username: 'SihabMaybe', tell: () => {} }, server: { runCommandSilent: c => ran.push(c) } })
check('a designer is put in creative on login', ran.length === 1 && ran[0] === 'gamemode creative SihabMaybe', JSON.stringify(ran))
ran = []
handlers.loggedIn({ player: { username: 'SomeKid', tell: () => {} }, server: { runCommandSilent: c => ran.push(c) } })
check('anyone else is left alone on login', ran.length === 0, JSON.stringify(ran))

console.log()
if (failures) { console.log(failures + ' of ' + checks + ' checks FAILED'); process.exit(1) }
console.log('all ' + checks + ' checks passed')
