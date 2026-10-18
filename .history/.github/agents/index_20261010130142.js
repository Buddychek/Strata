const mineflayer = require(`mineflayer`)

const bot = mineflayer.createBot({
    host: `localhost`,
    port: 60307,
    username: `BudBot`
})

bot.on(`Chat`, (BudBot, Hallo) => {
    if (Hallo === bot.BudBot) return
bot.chat(Hi)
})

bot.on('kicked', console.log)
bot.on('error', console.log)