const mineflayer = require(`mineflayer`)

const bot = mineflayer.createBot({
    host: `localhost`,
    port: 60307,
    username: `BudBot`
})

bot.on(`chat`, (BudBot, message) => {
    if (message === `hello`) return
bot.chat(Hi)
})

bot.on('kicked', console.log)
bot.on('error', console.log)