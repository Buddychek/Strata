const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals: { GoalFollow } } = require('mineflayer-pathfinder')

const bot = mineflayer.createBot({
    host: 'localhost',
    port: 60307,
    username: 'BudBot',
})

bot.loadPlugin(pathfinder)

bot.once('spawn', () => {
    bot.pathfinder.setMovements(new Movements(bot))
})

bot.on('chat', (playerName, message) => {
    if (playerName === bot.username) return
    bot.chat(`Hi ${playerName}! ${message}`)
    const target = bot.players()[playerName]
    if (target && target.position) bot.pathfinder.setGoal(new GoalFollow(target, 3))
})

// turn to the nearest player and stay close, even without chat
setInterval(() => {
    if (!bot.position) return
    const players = bot.players()
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
        bot.pathfinder.setGoal(new GoalFollow(players[nearest], 2))
    }
}, 1000)

bot.on('kicked', console.log)
bot.on('error', console.log)