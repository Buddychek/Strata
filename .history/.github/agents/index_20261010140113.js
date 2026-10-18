const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals: { GoalFollow, GoalNear } } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const readline = require('readline')

const bot = mineflayer.createBot({
    host: 'localhost',
    port: 60307,
    auth: 'microsoft',
})

bot.loadPlugin(pathfinder)

bot.once('spawn', () => {
    bot.pathfinder.setMovements(new Movements(bot))
    console.log('BudBot spawned — console ready (chat|goto|follow|stop|look|dig|status)')
})

bot.on('chat', (playerName, message) => {
    if (playerName === bot.username) return
    bot.chat(`Hi ${playerName}! ${message}`)
    const target = bot.players[playerName]
    if (target && target.position) bot.pathfinder.setGoal(new GoalFollow(target, 3), true)
})

// turn to the nearest player and stay close, even without chat
setInterval(() => {
    if (!bot.position) return
    const players = bot.players
    let nearest = null
    let best = Infinity
    for (const [name, p] of Object.entries(players)) {
        if (!p || !p.position) continue
        const dx = p.position.x - bot.position.x
        const dy = p.position.y - bot.position.y
        const dz = p.position.z - bot.position.z
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
        if (d < best) {
            best = d
            nearest = name
        }
    }
    if (nearest && best < 12) {
        bot.pathfinder.setGoal(new GoalFollow(players[nearest], 2), true)
    }
}, 1000)

bot.on('kicked', console.log)
bot.on('error', console.log)

// --- command console: type commands into the bot's terminal to steer it ---
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

const handle = (line) => {
    const [cmd, ...rest] = line.trim().split(/\s+/)
    if (!cmd) return
    try {
        if (cmd === 'chat') {
            bot.chat(rest.join(' '))
        } else if (cmd === 'goto') {
            const [x, y, z] = rest.map(Number)
            bot.pathfinder.setGoal(new GoalNear(x, y, z, 1), true)
        } else if (cmd === 'follow') {
            const target = bot.players[rest[0]]
            if (target && target.position) bot.pathfinder.setGoal(new GoalFollow(target, 2), true)
        } else if (cmd === 'stop') {
            bot.pathfinder.setGoal(null)
        } else if (cmd === 'look') {
            const [x, y, z] = rest.map(Number)
            bot.lookAt(new Vec3(x, y, z))
        } else if (cmd === 'dig') {
            const here = bot.position.offset(0, -1, 0).floor()
            const block = bot.blockAt(here)
            if (block) bot.dig(block)
        } else if (cmd === 'status') {
            const p = bot.position
            console.log(`pos ${Math.round(p.x)} ${Math.round(p.y)} ${Math.round(p.z)} | hp ${bot.health}`)
        } else {
            console.log(`? unknown: ${cmd} (chat|goto|follow|stop|look|dig|status)`)
        }
    } catch (e) {
        console.log(`! ${e.message}`)
    }
}

rl.on('line', handle)