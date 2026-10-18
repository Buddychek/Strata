const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals: { GoalFollow, GoalNear } } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const readline = require('readline')

const bot = mineflayer.createBot({
    host: 'localhost',
    port: 60307,
    username: 'BudBot',
    version: '1.19.4',
})

bot.loadPlugin(pathfinder)

// 4.x: 'chat' gives a ChatMessage object; 'messagestr' is the plain-text signal.
// Player chat formats vary: "<Name> text" and "Name: text" — accept both.
// Commands prefixed with '!' run on the bot.
const CHAT_PREFIX = /^(?:<([^>]+)>|([A-Za-z0-9_]{1,16})[:])\s*(.*)$/
let lastGreet = 0
bot.on('messagestr', (text, position, msgType, sender) => {
    console.log(`[chatraw] ${JSON.stringify(text)}`)
    const m = CHAT_PREFIX.exec(text)
    if (!m) return
    const name = m[1] || m[2]
    const body = m[3] || ''
    if (name === bot.username) return
    if (body.startsWith('!')) {
        replyChat = true
        handle(body.slice(1)).finally(() => { replyChat = false })
        return
    }
    const target = bot.players[name]
    if (target && target.position) bot.pathfinder.setGoal(new GoalFollow(target, 3), true)
    if (Date.now() - lastGreet > 25000) {
        lastGreet = Date.now()
        bot.chat(`Ich höre, ${name}! Neu: grub 14 · leuchte · farme spinne 4 · baue eine werkbank · farme holz 16 · bei mir · autonomia an · friss · status`)
    }
})

bot.on('kicked', console.log)
bot.on('error', console.log)
bot.on('death', () => {
    console.log('! Bot gestorben — Respawn in 5s')
    setTimeout(() => { try { bot.respawn() } catch (e) { console.log(`! Respawn fehlgeschlagen: ${e.message}`) } }, 5000)
})

// nach Respawn/Spawn: erst mal zum Herrn flüchten, dann arbeiten
let spawnFleeDone = false
bot.on('spawn', () => {
    setTimeout(() => {
        const mate = nearestPlayerName()
        if (mate && bot.entity) {
            bot.chat(`Bin wieder da — komme zu ${mate}`)
            manualUntil = Date.now() + 25000
            bot.pathfinder.setGoal(new GoalFollow(bot.players[mate], 2), true)
        }
    }, 3000)
})

// safe-position memory: anti-drowning (Drowneds kill bot at water's edge)
let safePos = null
let lastSwimChat = 0
setInterval(() => {
    if (!bot.entity || !bot.isAlive) return
    const ep = bot.entity.position
    const wet = !!bot.entity.isInWater
    if (!wet && ep.y > 20) { safePos = { x: ep.x, y: ep.y, z: ep.z }; return }
    if (wet && safePos) {
        manualUntil = Date.now() + 15000
        bot.pathfinder.setGoal(new GoalNear(safePos.x, safePos.y, safePos.z, 1), true)
        if (Date.now() - lastSwimChat > 20000) {
            lastSwimChat = Date.now()
            bot.chat('Aua — Wassr! Schwim to next dry land')
        }
    }
}, 4000)

// auto-follow the nearest player, unless a manual command owns the goal
let manualUntil = 0
setInterval(() => {
    if (!bot.entity || !bot.entity.position) return
    if (Date.now() < manualUntil) return
    let nearest = null
    let best = Infinity
    for (const [name, p] of Object.entries(bot.players)) {
        if (!p || !p.position || name === bot.username) continue
        const d = bot.entity.position.distance(p.position)
        if (d < best) { best = d; nearest = name }
    }
    if (nearest && best < 25) {
        bot.pathfinder.setGoal(new GoalFollow(bot.players[nearest], 2), true)
    }
}, 1000)

// --- robust gather: id-list matching, chunk-load polling, bad-spot retry ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const badSpots = new Set()
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) // plain-object-safe distance
function nearestPlayerName() {
    if (!bot.entity) return null
    let best = Infinity
    let name = null
    for (const [n, p] of Object.entries(bot.players)) {
        if (!p || !p.position || n === bot.username) continue
        const d = dist(p.position, bot.entity.position)
        if (d < best) { best = d; name = n }
    }
    return name
}
let replyChat = false
const say = (t) => {
    console.log(t)
    if (replyChat) bot.chat(String(t).slice(0, 100))
}

function diggableIds() {
    const skip = new Set(['water', 'lava', 'bedrock', 'fire', 'structure_block', 'structure_void', 'barrier'])
    const ids = []
    const list = bot.registry.blocksArray || bot.registry.blocksList || []
    for (const b of list) {
        if (b && b.diggable && !skip.has(b.name)) ids.push(b.id)
    }
    return ids
}

const LOG_BLOCKS = ['oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log']
const invCount = (name) => { const it = bot.registry.itemsByName[name]; return it ? bot.inventory.count(it.id, it.metadata) : 0 }
const countLogs = () => LOG_BLOCKS.reduce((s, n) => s + invCount(n), 0)

async function gather(nameArg) {
    let matching
    if (nameArg) {
        const resolved = OBJECT_ALIAS[nameArg] || nameArg
        const b = bot.registry.blocksByName[resolved]
        if (!b) { say(`! kein Block namens: ${resolved}`); return false }
        matching = resolved === 'oak_log'
            ? LOG_BLOCKS.map((n) => bot.registry.blocksByName[n] && bot.registry.blocksByName[n].id).filter((x) => x)
            : b.id
    } else {
        matching = diggableIds()
    }
    let found = []
    for (let i = 0; i < 6; i++) {
        found = bot.findBlocks({ matching, maxDistance: 64, count: 48 })
        if (found.length) break
        await sleep(2000)
    }
    found = found.filter((v) => !badSpots.has(`${v.x},${v.y},${v.z}`))
    if (!found.length) { say('! nichts erreichbar gefunden (Chunks geladen? Ziele gemerkt?)'); return false }
    const p = bot.entity.position
    found.sort((a, b) => (a.distanceSquared(p) + 16 * Math.pow(Math.max(0, a.y - p.y), 2)) - (b.distanceSquared(p) + 16 * Math.pow(Math.max(0, b.y - p.y), 2)))
    for (const spot of found.slice(0, 5)) {
        const blk = bot.blockAt(spot)
        say(`laufe zu ${blk ? blk.name : '?'} bei ${spot.x} ${spot.y} ${spot.z} …`)
        manualUntil = Date.now() + 20000
        try {
            await bot.pathfinder.goto(new GoalNear(spot.x, spot.y, spot.z, 1))
            const b2 = bot.blockAt(spot)
            if (b2 && b2.name !== 'air') { await bot.dig(b2); say(`gegraben: ${b2.name}`); return true }
            badSpots.add(`${spot.x},${spot.y},${spot.z}`)
        } catch (e) {
            badSpots.add(`${spot.x},${spot.y},${spot.z}`)
            say(`! Spot ${spot.x} ${spot.y} ${spot.z} fehlgeschlagen (${e.message.split('\n')[0]}) — nächster`)
        }
    }
    return false
}

// --- planner: recursive material supply via the recipe chain ---
async function gatherMany(name, qty, drop) {
    const isLog = name === 'holz' || LOG_BLOCKS.includes(name)
    const count = () => (isLog ? countLogs() : invCount(drop || name))
    for (let i = 0; i < 14 && count() < qty; i++) {
        if (fighting) { await sleep(4000); i--; continue }
        const ok = await gather(isLog ? 'holz' : name)
        if (!ok) return count() >= qty
    }
    return count() >= qty
}

async function ensureItem(name, qty) {
    if (invCount(name) >= qty) return true
    if (LOG_BLOCKS.includes(name) || name === 'holz') return gatherMany('holz', qty)
    if (name === 'coal') return gatherMany('coal_ore', qty)
    if (name === 'cobblestone') {
        const okp = await ensureItem('wooden_pickaxe', 1)
        if (!okp) { say('! keine Holzspitzhacke beschaffbar — kein Cobblestone'); return false }
        try { const pk = bot.inventory.items().find((i) => i.name === 'wooden_pickaxe'); if (pk) await bot.equip(pk, 'hand') } catch (e) {}
        return gatherMany('stone', qty, 'cobblestone')
    }
    if (name === 'stone_pickaxe' || name === 'iron_ore') {
        if (name === 'iron_ore') {
            const oksp = await ensureItem('stone_pickaxe', 1)
            if (!oksp) return false
            try { const pk = bot.inventory.items().find((i) => i.name === 'stone_pickaxe' || i.name === 'wooden_pickaxe'); if (pk) await bot.equip(pk, 'hand') } catch (e) {}
            return gatherMany('iron_ore', qty)
        }
    }
    if (name === 'iron_ingot') {
        const okF = await ensureItem('furnace', 1)
        const okO = await ensureItem('iron_ore', 2)
        const okC = await ensureItem('coal', 2)
        if (!(okF && okO && okC)) { say('! Schmiede-Kette nicht beschaffbar (Ofen/Erz/Kohle)'); return false }
        const fBlock = bot.registry.blocksByName['furnace']
        if (fBlock && !bot.findBlock({ matching: fBlock.id, maxDistance: 32 })) {
            const okP = await placeBehind('furnace')
            if (!okP) { say('! kein Platz, den Ofen zu stellen'); return false }
        }
        const haveOre = Math.min(6, invCount('iron_ore'))
        if (haveOre < 1) return false
        await smelt('iron_ore', haveOre)
        return invCount('iron_ingot') >= 1
    }
    if (name === 'string') {
        for (let i = 0; i < 5 && invCount('string') < qty; i++) {
            const sp = Object.values(bot.entities).find((e) => e.name === 'spider' && e.health > 0 && dist(e.position, bot.entity.position) < 24)
            if (!sp) { say('! keine Spinne in 24 Blocks — kein String'); return false }
            await fight('spider')
        }
        return invCount('string') >= qty
    }
    if (name === 'flint') return gatherMany('gravel', qty, 'flint')
    if (name === 'feather') {
        for (let i = 0; i < 5 && invCount('feather') < qty; i++) {
            const c = Object.values(bot.entities).find((e) => e.name === 'chicken' && e.health > 0 && dist(e.position, bot.entity.position) < 24)
            if (!c) { say('! keine Kuhn in 24 Blocks — kein Feather'); return false }
            await fight('chicken')
        }
        return invCount('feather') >= qty
    }
    for (let i = 0; i < 3 && invCount(name) < qty; i++) {
        await craft(name, Math.max(1, Math.min(6, qty - invCount(name))))
    }
    return invCount(name) >= qty
}

// --- crafting: recipes store raw numeric item ids in inShape/ingredients ---
function slotIds(slot) {
  const one = (x) => {
    if (typeof x === 'number') return { id: x }
    if (x && typeof x === 'object' && typeof x.id === 'number') return { id: x.id }
    return null
  }
  const list = (Array.isArray(slot) ? slot : [slot]).map(one).filter(Boolean)
  return list.length ? list : null
}

function groupsOf(r) {
  let raw = []
  if (Array.isArray(r.ingredients) && r.ingredients.length) raw = r.ingredients
  else if (Array.isArray(r.inShape) && r.inShape.length) raw = r.inShape.flat(Infinity)
  const groups = []
  for (const slot of raw) {
    const ids = slotIds(slot)
    if (ids) groups.push(ids)
  }
  return groups
}

function groupShortfall(r, crafts) {
  const short = []
  for (const group of groupsOf(r)) {
    const avail = Math.max(0, ...group.map((e) => bot.inventory.count(e.id, 0)))
    if (avail < crafts) short.push({ group, need: crafts - avail })
  }
  return short
}

async function craft(name, crafts) {
    name = OBJECT_ALIAS[name.replace(/ /g, '_')] || name.replace(/ /g, '_')
    let item = bot.registry.itemsByName[name]
    if (!item) {
        const guess = ['oak_', 'stone_', 'smooth_', 'deepslate_'].map((p) => bot.registry.itemsByName[p + name]).find(Boolean)
        if (!guess) { say(`! kein Item namens: ${name}`); return }
        name = guess.name
        item = guess
    }
    const tableBlock = bot.registry.blocksByName['crafting_table']
    let table = tableBlock ? bot.findBlock({ matching: tableBlock.id, maxDistance: 32 }) : null
    if (!table && invCount('crafting_table') >= 1) {
        const okP = await placeBehind('crafting_table')
        if (okP && tableBlock) table = bot.findBlock({ matching: tableBlock.id, maxDistance: 8 })
    }
    const all = [...bot.recipesAll(item.id, null, null), ...(table ? bot.recipesAll(item.id, table, table) : [])]
    let chosen = null
    for (const r of all) {
        if (r.requiresTable && !table) continue
        if (groupShortfall(r, crafts).length === 0) { chosen = r; break }
        if (!chosen) chosen = r // remember first feasible-shape recipe, will ensure materials below
    }
    if (!chosen) {
        const why = all.length ? (all.some((r) => r.requiresTable) && !table ? ' — Craftingstafel in 24 Blocks nötig' : ' — Zutaten fehlen') : ' — kein Rezept'
        say(`! kann ${name} nicht craften${why}`)
        return
    }
    // planner: get missing ingredients via the recipe chain (logs→planks→table …)
    for (let guard = 0; guard < 4; guard++) {
        const short = groupShortfall(chosen, crafts)
        if (!short.length) break
        for (const { group, need } of short) {
            const names = group.map((e) => (bot.registry.itemsArray || bot.registry.itemsById)[e.id] && (bot.registry.itemsArray || bot.registry.itemsById)[e.id].name).filter(Boolean)
            if (!names.length) { say('! Rezept-Gruppe ohne benannte Zutaten — craft-Abbruch'); return }
            const target = names.find((n) => LOG_BLOCKS.includes(n)) || names.find((n) => n.startsWith('oak_')) || names[0]
            say(`beschaffe ${need}x ${target} für ${name} …`)
            const ok = await ensureItem(target, need)
            if (!ok) { say(`! ${target} nicht beschaffbar (kein Vorrat, nichts in 48 Blocks?) — craft-Abbruch`); return }
        }
    }
    if (groupShortfall(chosen, crafts).length) { say(`! Zutaten für ${name} fehlen weiterhin`); return }
    let res = null
    for (let t = 0; t < 2; t++) {
        try {
            res = await bot.craft(chosen, crafts, chosen.requiresTable ? table : null)
            break
        } catch (e) {
            if (t === 0) {
                say(`! craft-glitch (${e.message.split('\n')[0]}) — retry`)
                await sleep(3000)
            } else {
                say(`! craft-failed: ${e.message.split('\n')[0]}`)
                return
            }
        }
    }
    say(`gecraftet: ${crafts}x ${name}${res ? ` (${res.name})` : ''}`)
}

// --- smelting: furnace in range, fuel from inventory, poll the result slot ---
const SMELT_MAP = {
    iron_ore: 'iron_ingot', deepslate_iron_ore: 'iron_ingot', raw_iron: 'iron_ingot',
    gold_ore: 'gold_ingot', deepslate_gold_ore: 'gold_ingot', raw_gold: 'gold_ingot',
    copper_ore: 'copper_ingot', deepslate_copper_ore: 'copper_ingot',
    beef: 'cooked_beef', porkchop: 'cooked_porkchop', chicken: 'cooked_chicken',
    mutton: 'cooked_mutton', potato: 'baked_potato',
    oak_log: 'charcoal', spruce_log: 'charcoal', birch_log: 'charcoal',
    jungle_log: 'charcoal', acacia_log: 'charcoal', dark_oak_log: 'charcoal',
    sand: 'glass', cobblestone: 'stone',
}
const FUELS = ['coal', 'charcoal', 'planks', 'stick', 'coal_block']

async function smelt(name, count) {
    name = name.replace(/ /g, '_')
    const out = SMELT_MAP[name]
    if (!out) { say(`! smelt kenne ich für: ${Object.keys(SMELT_MAP).join(', ')}`); return }
    const src = bot.registry.itemsByName[name]
    const res = bot.registry.itemsByName[out]
    if (!src || !res) { say(`! Item unbekannt: ${name}/${out}`); return }
    const have = bot.inventory.count(src.id, src.metadata)
    if (have < 1) { say(`! keine ${name} im Inventar`); return }
    count = Math.min(count, have)
    const furnaceBlock = bot.registry.blocksByName['furnace']
    const furnace = furnaceBlock ? bot.findBlock({ matching: furnaceBlock.id, maxDistance: 32 }) : null
    if (!furnace) { say('! keine Furnace in 24 Blocks'); return }
    const fuelName = FUELS.find((f) => bot.registry.itemsByName[f] && bot.inventory.count(bot.registry.itemsByName[f].id, 0) > 0)
    if (!fuelName) { say('! kein Brennstoff (coal/charcoal/planks/stick) im Inventar'); return }
    manualUntil = Date.now() + 30000
    try {
        await bot.pathfinder.goto(new GoalNear(furnace.position.x, furnace.position.y, furnace.position.z, 2))
    } catch (e) { say(`! Weg zur Furnace: ${e.message.split('\n')[0]}`); return }
    const w = await bot.openBlock(furnace)
    try {
        w.deposit(bot.registry.itemsByName[fuelName].id, 0, 1)
        w.deposit(src.id, src.metadata, count)
        let made = 0
        for (let i = 0; i < 30; i++) {
            await sleep(1000)
            const slot = w.slots[2]
            if (slot && slot.name === out && slot.count >= Math.min(count, 8)) { made = slot.count; break }
        }
        if (made > 0) {
            w.withdraw(res.id, res.metadata, made)
            say(`geschmolzen: ${made}x ${out}`)
        } else {
            say('! Schmelzen nach 30s nicht fertig (Brennstoff? mehr als 8 Stück?)')
        }
    } finally {
        w.close()
    }
}

// --- eating ---
const BAD_FOODS = new Set(['rotten_flesh', 'spider_eye', 'pufferfish', 'chorus_fruit', 'bone_meal'])
async function eatFood() {
    const foods = bot.registry.foodsByName
    const item = bot.inventory.items().find((i) => foods[i.name] && foods[i.name].foodPoints >= 4 && !BAD_FOODS.has(i.name))
    if (!item) { say('! keine essbare Nahrung im Inventar'); return }
    await bot.equip(item, 'hand')
    await bot.consume()
    say(`gegessen: ${item.name} (Sättigung ${Math.round(bot.food)})`)
}
let autoEat = true
let eatingBusy = false
setInterval(() => {
    if (!autoEat || !bot.entity || !bot.isAlive || eatingBusy) return
    if (bot.food > 6) return
    eatingBusy = true
    eatFood().catch((e) => console.log(`! eat: ${e.message}`)).finally(() => { eatingBusy = false })
}, 5000)

// --- fighting ---
const HOSTILES = new Set(['zombie', 'husk', 'zombie_villager', 'skeleton', 'stray', 'creeper',
    'spider', 'cave_spider', 'silverfish', 'enderman', 'slime', 'magma_cube',
    'pillager', 'witch', 'blaze', 'phantom', 'drowned', 'evoker', 'vex'])
const WEAPON_ORDER = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword', 'axe']
let fighting = null
let guardOn = false

function bestWeapon() {
    const items = bot.inventory.items().filter((i) => WEAPON_ORDER.includes(i.name) && (i.durability === undefined || i.durability < 40))
    items.sort((a, b) => WEAPON_ORDER.indexOf(a.name) - WEAPON_ORDER.indexOf(b.name))
    return items[0]
}

async function fight(name) {
    let target = bot.players[name] ? bot.players[name].entity : null
    if (!target) target = Object.values(bot.entities).find((e) => e.name === name && e.kind === 'Mob') || null
    if (!target) { say(`! Ziel nicht gefunden: ${name}`); return }
    const w = bestWeapon()
    if (w) { try { await bot.equip(w, 'hand') } catch (e) { console.log(`! equip: ${e.message}`) } }
    say(`angriff: ${name}${w ? ` (Waffe: ${w.name})` : ' (mit Fäusten)'} — ${Math.ceil(target.health)} HP`)
    fighting = target
    // Bow-Phase: shoot as long as arrows last
    const bow = bot.inventory.items().find((i) => i.name === 'bow')
    if (bow && invCount('arrow') > 0) {
        try { await bot.equip(bow, 'hand') } catch (e) {}
        say('shoots with bow …')
        while (fighting && target.isValid && (!target.health || target.health > 0) && bot.isAlive && invCount('arrow') > 0) {
            if (bot.health <= 8) break
            const ep = bot.entity.position.offset(0, 1.6, 0)
            const tp = target.position
            const d = dist(tp, ep)
            if (d > 18) {
                try { await bot.pathfinder.goto(new GoalFollow(target, 8)) } catch (e) { break }
            }
            const aimY = tp.y + 0.4 - ep.y + d * d * 0.006
            try { await bot.shoot(new Vec3(tp.x - ep.x, aimY, tp.z - ep.z)) } catch (e) { break }
            await sleep(1400)
        }
        const w2 = bestWeapon()
        if (w2) { try { await bot.equip(w2, 'hand') } catch (e) {} }
    }
    while (fighting && target.isValid && (!target.health || target.health > 0) && bot.isAlive) {
        if (bot.health <= 8) {
            say(`Rückzug! HP ${Math.round(bot.health)} — ich brauche Deckung`)
            const mate = nearestPlayerName()
            const me = mate && bot.players[mate] && bot.players[mate].entity
            const mp = me ? me.position : null
            fighting = null
            if (mp) {
                manualUntil = Date.now() + 20000
                try { await bot.pathfinder.goto(new GoalNear(mp.x, mp.y, mp.z, 2)) } catch (e) {}
            }
            break
        }
        manualUntil = Date.now() + 8000
        const d = dist(target.position, bot.entity.position)
        if (d > 3.2) {
            try { await bot.pathfinder.goto(new GoalFollow(target, 2)) } catch (e) { break }
        }
        try { bot.attack(target) } catch (e) { break }
        await sleep(600)
    }
    fighting = null
    say(`${name}: erledigt oder Kampf beendet`)
}

setInterval(() => {
    if (!guardOn || fighting || !bot.entity || !bot.isAlive) return
    const hostile = Object.values(bot.entities)
        .filter((e) => e && e.kind === 'Mob' && HOSTILES.has(e.name) && e.health > 0 &&
            dist(e.position, bot.entity.position) < 16)
        .sort((a, b) => ((a.name === 'creeper' ? 0 : 1) - (b.name === 'creeper' ? 0 : 1)) ||
            dist(a.position, bot.entity.position) - dist(b.position, bot.entity.position))[0]
    if (hostile) fight(hostile.name).catch((e) => console.log(`! guard: ${e.message}`))
}, 3000)

// --- Autonomia: eigenständiger Wirtschafts-Loop (Fressen > Holz > Planken > Stöcke > Werkbank > Fackeln) ---
let autopilot = false
let autopilotBusy = false
async function autopilotTick() {
    if (!autopilot || autopilotBusy || fighting || !bot.entity || !bot.isAlive) return
    autopilotBusy = true
    try {
        // Nachtsperre: ohne Schwert bleibt der Bot dunkel bei Herrn in der Nähe
        if (bot.time && !bot.time.isDay && !invCount('stone_sword')) {
            const mate = nearestPlayerName()
            if (mate && bot.players[mate] && bot.players[mate].position) {
                manualUntil = Date.now() + 20000
                bot.pathfinder.setGoal(new GoalFollow(bot.players[mate], 2), true)
            }
            return
        }
        if (bot.food <= 8) {
            const hasFood = bot.inventory.items().some((i) => bot.registry.foodsByName[i.name] && bot.registry.foodsByName[i.name].foodPoints >= 4 && !BAD_FOODS.has(i.name))
            if (hasFood) { await eatFood(); return }
        }
        if (countLogs() < 16) { say('autonomia: sammle Holz …'); await gatherMany('holz', 16); return }
        if (invCount('oak_planks') < 16) { await craft('oak_planks', 4); return }
        if (invCount('stick') < 8) { await craft('stick', 2); return }
        if (!bestWeapon() && invCount('oak_planks') >= 6) {
            say('autonomia: ich rüste eine Waffe her …')
            const okp = await ensureItem('wooden_pickaxe', 1)
            if (okp) {
                const okc = await ensureItem('cobblestone', 4)
                if (okc) await craft('stone_sword', 1)
            }
            return
        }
        if (invCount('crafting_table') < 1) { await craft('crafting_table', 1); return }
        if (invCount('torch') < 4 && invCount('coal') >= 1) { await craft('torch', 1); return }
        if (invCount('stone_sword') > 0 && !invCount('shield') && invCount('oak_planks') >= 6) {
            say('autonomia: ich rüste ein Schild her (Schmiede-Kette) …')
            const oki = await ensureItem('iron_ingot', 1)
            if (oki) await craft('shield', 1)
            return
        }
        if (invCount('bow') < 1 && invCount('stick') >= 6) {
            say('autonomia: craften Boge …')
            await ensureItem('bow', 1)
            return
        }
        if (invCount('bow') >= 1 && invCount('arrow') < 12) {
            say('autonomia: craften Pfeile …')
            await ensureItem('arrow', 6)
            return
        }
        if (invCount('white_bed') < 1 && invCount('oak_planks') >= 3) {
            say('autonomia: craften Bett …')
            await ensureItem('white_bed', 1)
            return
        }
        console.log('autonomia: Vorrat rund — warte auf Aufgaben')
    } catch (e) { console.log(`! autonomia: ${e.message}`) }
    finally { autopilotBusy = false }
}
setInterval(autopilotTick, 10000)

// --- German / natural-language normalisation ---
const norm = (w) => w.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
const STOP = new Set(['eine', 'ein', 'einen', 'den', 'das', 'der', 'die', 'mir', 'zu'])
const VERB_ALIAS = { erstelle: 'craft', herstelle: 'craft', bastle: 'craft', erfinde: 'craft', craft: 'craft', baue: 'build', setze: 'place', platziere: 'place', farme: 'farm', farm: 'farm', ernte: 'farm', grabbe: 'gather', sammle: 'gather', kaempfe: 'fight', kampfe: 'fight', kaempf: 'fight', bek: 'fight', friss: 'eat', iss: 'eat', nahr: 'eat', schmelze: 'smelt', siede: 'sleepbed', schau: 'watch', naechste: 'near', inventar: 'inventory', bei: 'beimir', komm: 'beimir', tp: 'beimir', teleportiere: 'beimir', grub: 'min', bergbau: 'min', schacht: 'min', grab: 'min', leuchte: 'licht', beleuchte: 'licht', bewache: 'guard', schuetze: 'guard', stoppe: 'stop', halt: 'stop', arbeit: 'autonomia', autonom: 'autonomia', folgen: 'follow', stow: 'store', stash: 'store', deposita: 'store', pack: 'store', take: 'take', leer: 'take', offnen: 'take' }
const OBJECT_ALIAS = { werkbank: 'crafting_table', werkbanktisch: 'crafting_table', tafel: 'crafting_table', holztafel: 'oak_planks', brette: 'oak_planks', bretter: 'oak_planks', eichenplanken: 'oak_planks', planken: 'oak_planks', holz: 'oak_log', stamm: 'oak_log', eichenstamm: 'oak_log', baum: 'oak_log', erde: 'dirt', erdblock: 'dirt', kies: 'gravel', stein: 'stone', kohle: 'coal_ore', kohlestueck: 'coal', steinkohle: 'coal', eisen: 'iron_ingot', eisenerz: 'iron_ore', gold: 'gold_ingot', kupfer: 'copper_ingot', kupfererz: 'copper_ore', diamant: 'diamond', steinschwert: 'stone_sword', schwert: 'stone_sword', steinspitzhacke: 'stone_pickaxe', spitzhacke: 'wooden_pickaxe', hacke: 'wooden_pickaxe', stocke: 'stick', stock: 'stick', spinne: 'spider', spinnen: 'spider', kuhn: 'chicken', haehner: 'chicken', faden: 'string', fadenbuendel: 'string', wolle: 'wool', woll: 'wool', bett: 'white_bed', bed: 'white_bed', schild: 'shield', ofen: 'furnace', fackel: 'torch', fackeln: 'torch', braten: 'cooked_beef', brot: 'bread', apfel: 'apple', karotte: 'carrot', kartoffel: 'potato', brotblock: 'hay_block', weizen: 'wheat', samis: 'seed', samen: 'seed', wall: 'wall', mauer: 'wall', boge: 'bow', bogen: 'bow', pfeile: 'arrow', Pfeile: 'arrow', sarg: 'coffin' }

// --- place helper: set a block behind the bot on the ground ---
async function placeBehind(name) {
    const item = bot.inventory.items().find((i) => i.name === name)
    if (!item) { say(`! kein ${name} im Inventar zum Platzieren`); return false }
    const ref = bot.blockAt(bot.entity.position.offset(-1, -1, 0).floor())
    if (!ref) { say('! kein Referenzblock hinter mir'); return false }
    try {
        await bot.placeBlock(ref, new Vec3(0, 1, 0), item)
        say(`platziert: ${name}`)
        return true
    } catch (e) { say(`! Platzieren von ${name}: ${e.message.split('\n')[0]}`); return false }
}

// --- Bergbau: Treppenschacht abwärts, Erze scannen & abbauen ---
const ORE_BLOCKS = ['coal_ore', 'deepslate_coal_ore', 'iron_ore', 'deepslate_iron_ore', 'copper_ore', 'deepslate_copper_ore', 'gold_ore', 'deepslate_gold_ore']
async function mine(targetY) {
    const okp = await ensureItem('stone_pickaxe', 1)
    if (!okp) { say('! Stein-Spitzhacke nicht beschaffbar — Bergbau abgebrochen'); return }
    try {
        if (!await equipBestTool('stone_pickaxe')) await equipBestTool('wooden_pickaxe')
    } catch (e) {}
    const oreIds = ORE_BLOCKS.map((n) => bot.registry.blocksByName[n] && bot.registry.blocksByName[n].id).filter((x) => x)
    manualUntil = Date.now() + 300000
    let steps = 0
    let oresFound = 0
    while (bot.entity && bot.isAlive && bot.entity.position.y > targetY && steps < 80) {
        steps++
        manualUntil = Date.now() + 30000
        const front = bot.blockAt(bot.entity.position.offset(1, -1, 0).floor())
        if (front && !front.diggable) break
        if (front) { try { await bot.dig(front) } catch (e) { break } }
        try {
            await bot.pathfinder.goto(new GoalNear(Math.round(bot.entity.position.x + 1), Math.round(bot.entity.position.y - 1), Math.round(bot.entity.position.z), 1))
        } catch (e) { break }
        if (steps % 5 === 0) {
            const ores = bot.findBlocks({ matching: oreIds, maxDistance: 8, count: 10 })
            for (const o of ores.slice(0, 5)) {
                const b = bot.blockAt(o)
                if (b && oreIds.includes(b.id)) {
                    try { await bot.dig(b); oresFound++; say(`Erz gegraben: ${b.name} bei ${o.x} ${o.y} ${o.z}`) } catch (e) {}
                }
            }
            if (oresFound > 0 && steps % 10 === 0 && invCount('torch') > 0) {
                await placeBehind('torch')
            }
        }
    }
    say(`Bergbau fertig bei y ${Math.round(bot.entity.position.y)} — ${steps} Stufen, ${oresFound} Erze`)
}

// --- Licht: Fackelring um den Standpunkt ---
async function licht(n) {
    const ok = await ensureItem('torch', n)
    if (!ok) { say('! Fackeln nicht beschaffbar (Kohle + Stöcke?)'); return }
    const spots = [[3, 0], [-3, 0], [0, 3], [0, -3], [3, 3], [-3, -3], [3, -3], [-3, 3]]
    const home = { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z }
    let placed = 0
    for (const [dx, dz] of spots.slice(0, n)) {
        manualUntil = Date.now() + 15000
        try {
            await bot.pathfinder.goto(new GoalNear(Math.round(home.x + dx), Math.round(home.y), Math.round(home.z + dz), 1))
        } catch (e) { continue }
        const ref = bot.blockAt(bot.entity.position.offset(0, -1, 0).floor())
        const item = bot.inventory.items().find((i) => i.name === 'torch')
        if (!ref || !item) continue
        try { await bot.placeBlock(ref, new Vec3(0, 1, 0), item); placed++ } catch (e) {}
    }
    say(`Fackeln gesetzt: ${placed}`)
}

// --- Spinnen-Farm: String für Wolle/Bett ---
async function spiderFarm(n) {
    for (let i = 0; i < n; i++) {
        const sp = Object.values(bot.entities).find((e) => e.name === 'spider' && e.health > 0 && dist(e.position, bot.entity.position) < 24)
        if (!sp) { say('! keine Spinne in 24 Blocks'); break }
        await fight('spider')
        await sleep(1500)
    }
    say(`String-Ergebnis: ${invCount('string')} Fäden`)
}

// --- Chicken-Farm: Feather for Arrows ---
async function chickenFarm(n) {
    for (let i = 0; i < n; i++) {
        const c = Object.values(bot.entities).find((e) => e.name === 'chicken' && e.health > 0 && dist(e.position, bot.entity.position) < 24)
        if (!c) { say('! keine Kuhn in 24 Blocks'); break }
        await fight('chicken')
        await sleep(1500)
    }
    say(`Feather-Result: ${invCount('feather')} Plumes`)
}

// --- Sleep in Bed: pass the night ---
async function sleepBed() {
    const bedBlock = bot.registry.blocksByName['bed'] || bot.registry.blocksByName['double_bed']
    if (!bedBlock) { say('! bed not in Registry'); return }
    let bed = bot.findBlock({ matching: bedBlock.id, maxDistance: 32 })
    if (!bed && invCount('white_bed') >= 1) {
        const okP = await placeBehind('white_bed')
        if (okP) bed = bot.findBlock({ matching: bedBlock.id, maxDistance: 8 })
    }
    if (!bed) { say('! no Bed in 32 Blocks (and crafting failed?)'); return }
    manualUntil = Date.now() + 20000
    try {
        await bot.pathfinder.goto(new GoalNear(bed.x, bed.y, bed.z, 1))
    } catch (e) { say(`! no way to Bed: ${e.message.split('\n')[0]}`); return }
    const bedBlock2 = bot.blockAt(bed)
    if (!bedBlock2) { say('! Bedblock not found (loaded? bed placed?)'); return }
    try {
        await bot.sleep(bedBlock2)
        say('slept — night over, sun is up~')
    } catch (e) { say(`! cannot sleep: ${e.message.split('\n')[0]}`) }
}

// --- Acker: Seeds on Dirt, wait ripe, harvest ---
async function wheatFarm(n) {
    const okSeed = await gatherMany('grass', Math.max(2, n), 'seed')
    if (invCount('seed') < 1) { say('! no Seeds (grass search failed)'); return }
    const dirtB = bot.registry.blocksByName['dirt']
    if (!dirtB) { say('! no Dirt in Registry'); return }
    const plots = bot.findBlocks({ matching: dirtB.id, maxDistance: 32, count: Math.min(n, 8) })
    if (!plots.length) { say('! no Dirt for Acker in 32 Blocks'); return }
    let harvested = 0
    for (const spot of plots.slice(0, Math.min(n, plots.length))) {
        if (invCount('seed') < 1) break
        manualUntil = Date.now() + 20000
        try {
            await bot.pathfinder.goto(new GoalNear(spot.x, spot.y, spot.z, 1))
        } catch (e) { continue }
        const dirtBlock = bot.blockAt(spot)
        const seedItem = bot.inventory.items().find((i) => i.name === 'seed')
        if (!dirtBlock || !seedItem) continue
        try { await bot.placeBlock(dirtBlock, new Vec3(0, 1, 0), seedItem) } catch (e) { continue }
        const plantPos = new Vec3(spot.x, spot.y + 1, spot.z)
        let ripe = false
        for (let t = 0; t < 60; t++) {
            await sleep(2000)
            const b = bot.blockAt(plantPos)
            if (b && b.name === 'wheat') { ripe = true; break }
        }
        if (ripe) {
            const b = bot.blockAt(plantPos)
            try {
                await bot.dig(b)
                harvested++
                say(`harvested ripe Wheat at ${plantPos.x} ${plantPos.y} ${plantPos.z}`)
            } catch (e) {}
        } else {
            say(`! Wheat at ${plantPos.x} ${plantPos.y} ${plantPos.z} not ripe after 120s (needs Water/light)`)
        }
    }
    say(`Acker done: ${harvested} harvests from ${plots.length} plots`)
}

// --- Wall: Cobblestone-Line, Bot walks backwards ---
async function buildWall(n) {
    const ok = await ensureItem('cobblestone', Math.min(n, 12))
    if (!ok) { say('! no Cobblestone (stone+pickaxe failed)'); return }
    let built = 0
    for (let i = 0; i < n; i++) {
        if (invCount('cobblestone') < 1) break
        if (await placeBehind('cobblestone')) built++
        const p = bot.entity.position
        manualUntil = Date.now() + 15000
        try {
            await bot.pathfinder.goto(new GoalNear(Math.round(p.x + 1), Math.round(p.y), Math.round(p.z), 1))
        } catch (e) { break }
    }
    say(`Wall built: ${built} Blocks cobblestone`)
}

// --- Storage: deposit/take via Chest ---
async function chestStore() {
    const chestBlock = bot.registry.blocksByName['chest']
    if (!chestBlock) { say('! chest not in Registry'); return }
    const chest = bot.findBlock({ matching: chestBlock.id, maxDistance: 32 })
    if (!chest) { say('! no chest in 32 Blocks'); return }
    const keep = new Set(['stone_sword', 'stone_pickaxe', 'wooden_pickaxe', 'shield', 'torch', 'bow', 'arrow', 'bed', 'crafting_table', 'bread', 'apple', 'carrot', 'cooked_beef'])
    const w = await bot.openBlock(chest)
    try {
        let moved = 0
        for (const it of bot.inventory.items()) {
            if (keep.has(it.name)) continue
            w.deposit(it.id, it.metadata, it.count)
            moved++
        }
        say(`stored ${moved} types into chest`)
    } finally {
        w.close()
    }
}
async function chestTake() {
    const chestBlock = bot.registry.blocksByName['chest']
    if (!chestBlock) { say('! chest not in Registry'); return }
    const chest = bot.findBlock({ matching: chestBlock.id, maxDistance: 32 })
    if (!chest) { say('! no chest in 32 Blocks'); return }
    const w = await bot.openBlock(chest)
    try {
        let taken = 0
        for (const s of w.slots) {
            if (s && s.count > 0) { w.withdraw(s.id, s.metadata, s.count); taken++ }
        }
        say(`took ${taken} types from chest`)
    } finally {
        w.close()
    }
}

// --- Tool management: craft new if worn ---
async function equipBestTool(name) {
    let items = bot.inventory.items().filter((i) => i.name === name)
    items.sort((a, b) => (a.durability === undefined ? 0 : a.durability) - (b.durability === undefined ? 0 : b.durability))
    let it = items.find((i) => (i.durability === undefined ? 0 : i.durability) < 40)
    if (!it) {
        await craft(name, 1)
        items = bot.inventory.items().filter((i) => i.name === name)
        it = items[0]
    }
    if (!it) { say(`! cannot equip ${name}`); return false }
    await bot.equip(it, 'hand')
    return true
}

// --- Self-awareness: what can be built now, what via chain? ---
const TECHTREE = ['oak_planks', 'stick', 'crafting_table', 'furnace', 'wooden_pickaxe', 'stone_pickaxe', 'stone_sword', 'shield', 'torch', 'bow', 'arrow', 'white_bed', 'chest', 'hay_block']
const FINDABLE = new Set(['oak_log', 'coal_ore', 'gravel', 'flint', 'string', 'feather', 'seed'])
let gTable = null
function itemName(id) { const it = (bot.registry.itemsArray || [])[id]; return it && it.name }
async function canObtain(name, depth) {
    if (invCount(name) >= 1) return true
    if (FINDABLE.has(name) || name === 'holz') return true
    if (name === 'coal') return await canObtain('coal_ore', depth - 1)
    if (name === 'cobblestone') return await canObtain('wooden_pickaxe', depth - 1)
    if (name === 'iron_ingot') { const a = await canObtain('iron_ore', depth - 1); const b = await canObtain('coal', depth - 1); return a && b }
    if (depth <= 0) return false
    const item = bot.registry.itemsByName[name]
    if (!item) return false
    const recipes = [...bot.recipesAll(item.id, null, null), ...(gTable ? bot.recipesAll(item.id, gTable, gTable) : [])]
    for (const r of recipes) {
        let ok = true
        for (const group of groupsOf(r)) {
            let g = false
            for (const e of group) {
                const n = itemName(e.id)
                if (n && await canObtain(n, depth - 1)) { g = true; break }
            }
            if (!g) { ok = false; break }
        }
        if (ok) return true
    }
    return false
}
async function canCraftReport() {
    const tblB = bot.registry.blocksByName['crafting_table']
    gTable = tblB ? bot.findBlock({ matching: tblB.id, maxDistance: 32 }) : null
    if (!gTable && invCount('crafting_table') >= 1 && tblB) {
        const under = bot.entity && bot.entity.position ? bot.blockAt(bot.entity.position.offset(0, -1, 0).floor()) : null
        if (under) gTable = under
    }
    const have = []
    const now = []
    const chain = []
    for (const name of TECHTREE) {
        const item = bot.registry.itemsByName[name]
        if (!item) continue
        if (invCount(name) >= 1) { have.push(name); continue }
        const recipes = [...bot.recipesAll(item.id, null, null), ...(gTable ? bot.recipesAll(item.id, gTable, gTable) : [])]
        if (!recipes.length) continue
        let anyNow = false
        let anyChain = false
        for (const r of recipes) {
            if (!groupShortfall(r, 1).length) anyNow = true
            let ob = true
            for (const group of groupsOf(r)) {
                let g = false
                for (const e of group) {
                    const n = itemName(e.id)
                    if (n && await canObtain(n, 3)) { g = true; break }
                }
                if (!g) { ob = false; break }
            }
            if (ob && r.requiresTable && !gTable) ob = await canObtain('crafting_table', 3)
            if (ob) anyChain = true
        }
        if (anyNow) now.push(name)
        else if (anyChain) chain.push(name)
    }
    say(`have: ${have.join(', ') || '—'} | craft right now: ${now.join(', ') || '—'} | via chain: ${chain.join(', ') || '—'}`)
}

// --- command console ---
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const HELP = 'deutsche Befehle: grub [tiefe] · leuchte [n] · farme holz 16 · farme spinne 4 · farme kuhn 4 · farme weizen 4 · baue eine werkbank · baue mauer 8 · erfinde boge · schmelze eisen · siede (sleep) · siede eisen_erz (smelt) · friss · bei mir · autonomia an · bewache an · pack (store) · leer (take) · status · schau · can craft · stop · grabbe <block> · kämpfe <name>'

const handle = async (line) => {
    const tokens = line.trim().split(/\s+/).map(norm).filter(Boolean)
    const [rawCmd, ...rawRest] = tokens
    if (!rawCmd) return
    const cmd = VERB_ALIAS[rawCmd] || rawCmd
    const rest = rawRest.filter((t) => !STOP.has(t))
    const arg = rest.join(' ')
    const needsEntity = ['dig', 'status', 'gather', 'craft', 'smelt', 'eat', 'inventory', 'equip', 'fight', 'near', 'watch', 'stop', 'goto', 'follow', 'look', 'place', 'farm', 'build', 'beimir', 'min', 'licht', 'sleepbed', 'store', 'take']
    if (needsEntity.includes(cmd) && (!bot.entity || !bot.isAlive)) {
        say('! noch nicht gespawnnt (oder tot)')
        return
    }
    try {
        if (cmd === 'chat') {
            bot.chat(arg)
        } else if (cmd === 'goto') {
            const [x, y, z] = rest.map(Number)
            manualUntil = Date.now() + 15000
            bot.pathfinder.setGoal(new GoalNear(x, y, z, 1), true)
        } else if (cmd === 'follow') {
            const target = bot.players[rest[0]]
            if (target && target.position) bot.pathfinder.setGoal(new GoalFollow(target, 2), true)
        } else if (cmd === 'stop') {
            bot.pathfinder.setGoal(null)
            fighting = null
        } else if (cmd === 'look') {
            const [x, y, z] = rest.map(Number)
            bot.lookAt(new Vec3(x, y, z))
        } else if (cmd === 'dig') {
            const here = bot.entity.position.offset(0, -1, 0).floor()
            const block = bot.blockAt(here)
            if (block) bot.dig(block)
        } else if (cmd === 'status') {
            const p = bot.entity.position
            say(`pos ${Math.round(p.x)} ${Math.round(p.y)} ${Math.round(p.z)} | hp ${Math.round(bot.health * 10) / 10} | food ${Math.round(bot.food)} | guard ${guardOn ? 'an' : 'aus'}`)
        } else if (cmd === 'gather') {
            await gather(arg)
        } else if (cmd === 'craft') {
            const n = parseInt(rest[rest.length - 1], 10)
            const isNum = rest.length > 1 && !Number.isNaN(n)
            await craft(isNum ? rest.slice(0, -1).join(' ') : arg, isNum ? n : 1)
        } else if (cmd === 'smelt') {
            await smelt(arg.split(/\s+/)[0], parseInt(arg.split(/\s+/)[1], 10) || 8)
        } else if (cmd === 'eat') {
            await eatFood()
        } else if (cmd === 'inventory') {
            const items = bot.inventory.items()
            if (!items.length) { say('Inventar: leer'); return }
            say('Inventar: ' + items.map((i) => `${i.count}x ${i.name}`).join(', '))
        } else if (cmd === 'equip') {
            const item = bot.inventory.items().find((i) => i.name === arg.replace(/ /g, '_'))
            if (!item) { say(`! kein ${arg} im Inventar`); return }
            await bot.equip(item, 'hand')
            say(`equipiert: ${item.name}`)
        } else if (cmd === 'fight') {
            if (!arg) { say('! fight <name>'); return }
            fight(arg).catch((e) => say(`! fight: ${e.message}`))
        } else if (cmd === 'guard') {
            guardOn = rest[0] !== 'off'
            say(`guard ${guardOn ? 'an' : 'aus'}`)
        } else if (cmd === 'near') {
            const p = bot.entity.position
            const ents = Object.values(bot.entities)
                .filter((e) => e && e.position && dist(e.position, p) < 48 && e.username !== bot.username)
                .map((e) => `${e.username || e.name} (${e.kind}, ${Math.round(dist(e.position, p))}m)`)
            say(ents.length ? 'in der Nähe: ' + ents.join(', ') : 'niemand in 48 Blocks')
        } else if (cmd === 'place') {
            const want = OBJECT_ALIAS[arg] || arg
            const item = bot.inventory.items().find((i) => i.name === want.replace(/ /g, '_'))
            if (!item) { say(`! kein ${want} im Inventar`); return }
            const ref = bot.blockAt(bot.entity.position.offset(0, -1, 0).floor())
            if (!ref) { say('! kein Referenzblock unter mir'); return false }
            await bot.placeBlock(ref, new Vec3(0, 1, 0), item)
            say(`platziert: ${item.name}`)
        } else if (cmd === 'autonomia' || cmd === 'autopilot') {
            autopilot = rest[0] !== 'off'
            if (autopilot) guardOn = true
            say(`autonomia ${autopilot ? 'an (guard automatisch an)' : 'aus'}`)
        } else if (cmd === 'beimir') {
            let target = rest[0] && rest[0] !== 'mir' ? rest[0] : null
            if (!target) {
                let best = Infinity
                for (const [n, p] of Object.entries(bot.players)) {
                    if (!p || !p.position || n === bot.username) continue
                    const d = dist(p.position, bot.entity.position)
                    if (d < best) { best = d; target = n }
                }
            }
            if (!target) { say('! kein Spieler gefunden — nutze: bei mir <name>'); return }
            bot.chat(`/tp @s ${target}`)
            say(`TP-Befehl raus: /tp @s ${target} — ohne /op BudBot ignoriert der Server ihn`)
        } else if (cmd === 'sleepbed') {
            const sm = OBJECT_ALIAS[rest[0]] || rest[0]
            if (sm && SMELT_MAP[sm]) {
                await smelt(sm, parseInt(rest[1], 10) || 8)
            } else {
                await sleepBed()
            }
        } else if (cmd === 'store') {
            await chestStore()
        } else if (cmd === 'take') {
            await chestTake()
        } else if (cmd === 'cancraft' || cmd === 'what' || cmd === 'buildlist') {
            await canCraftReport()
        } else if (cmd === 'min') {
            const depth = parseInt(rest[0], 10)
            const targetY = !Number.isNaN(depth) && depth < 64 ? depth : 14
            await mine(targetY)
        } else if (cmd === 'licht') {
            const n = parseInt(rest[0], 10) || 8
            await licht(Math.min(n, 8))
        } else if (cmd === 'farm') {
            const target = OBJECT_ALIAS[rest[0]] || rest[0]
            const n = parseInt(rest[1], 10) || 8
            if (!target) { say('! farme <block> [anzahl]'); return }
            if (target === 'spider') { await spiderFarm(parseInt(rest[1], 10) || 4); return }
            if (target === 'chicken') { await chickenFarm(parseInt(rest[1], 10) || 4); return }
            if (target === 'wheat' || target === 'seed') { await wheatFarm(parseInt(rest[1], 10) || 4); return }
            const ok = await gatherMany(target, n)
            const have = (target === 'oak_log' ? countLogs() : invCount(target))
            say(ok ? `gefarmt: ${have}x ${target}` : `Farm-Stopp bei ${have}/${n} ${target}`)
        } else if (cmd === 'build') {
            const want = OBJECT_ALIAS[arg] || arg
            if (want === 'wall') { await buildWall(parseInt(rest[1], 10) || 6); return }
            await craft(want, 1)
            const made = invCount(want)
            if (made < 1) { say(`! ${want} nicht herstellbar`); return }
            const item = bot.inventory.items().find((i) => i.name === want)
            const ref = bot.blockAt(bot.entity.position.offset(0, -1, 0).floor())
            if (item && ref) {
                try {
                    await bot.placeBlock(ref, new Vec3(0, 1, 0), item)
                    say(`gebaut und platziert: ${want}`)
                } catch (e) { say(`${want} gecraftet, Platzieren fehlgeschlagen: ${e.message.split('\n')[0]}`) }
            } else {
                say(`${want} gecraftet (kein Platz zum Platzieren)`)
            }
        } else if (cmd === 'watch') {
            const p = bot.entity.position
            const under = bot.blockAt(p.offset(0, -1, 0).floor())
            const ahead = bot.blockAt(p.offset(0, 0, 1).floor())
            const t = bot.time
            say(`pos ${Math.round(p.x)} ${Math.round(p.y)} ${Math.round(p.z)} | hp ${Math.round(bot.health * 10) / 10} | food ${Math.round(bot.food)} | under ${under?.name} | ahead ${ahead?.name} | day ${t?.day ?? '?'} ${t?.isDay ? 'day' : 'night'}`)
        } else {
            say(`? unknown: ${cmd} (${HELP})`)
        }
    } catch (e) {
        say(`! ${e.message}`)
    }
}

rl.on('line', handle)

bot.once('spawn', () => {
    const rules = new Movements(bot)
    rules.canDig = true
    rules.canSwim = false
    rules.allowSprinting = true
    bot.pathfinder.setMovements(rules)

    // pathfinder safety: cap A* time per tick + watchdog against unreachable goals
    bot.pathfinder.thinkTimeout = 20000
    let movingSince = null
    setInterval(() => {
        if (!bot.entity) return
        if (bot.pathfinder.isMoving()) {
            if (!movingSince) movingSince = Date.now()
            else if (Date.now() - movingSince > 90000) {
                bot.pathfinder.setGoal(null)
                console.log('! watchdog: 90s unterwegs ohne Ankommen — Ziel gelöscht')
                movingSince = null
            }
        } else movingSince = null
    }, 5000)

    console.log(`BudBot spawned — Console + In-Game '!'-Kommandos ready (${HELP})`)
    bot.chat('Herrchen: gib mir /op BudBot — dann komme ich sofort per „!bei mir" zu dir~')
})
