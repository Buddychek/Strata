const mineflayer = require(`mineflayer`)

const bot = mineflayer.createBot({
    host: `localhost`,
    port: 60307,
    username: `BudBot`
})

bot.on('chat', (playerName, message) => {
    if (playerName === bot.username) return
    bot.chat(`Hi ${playerName}! ${message}`)
})

bot.on('kicked', console.log)
bot.on('error', console.log)