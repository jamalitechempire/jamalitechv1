module.exports = {
    command: 'alive',
    function: async (ctx) => {
        try {
            const uptime = process.uptime();
            const hours = Math.floor(uptime / 3600);
            const minutes = Math.floor((uptime % 3600) / 60);
            const uptimeStr = `${hours}h ${minutes}m`;

            await ctx.replyWithPhoto(
                { url: 'https://files.catbox.moe/0e3rok.jpg' },
                {
                    caption: `⚡ *JAMALI MD IS ALIVE* ⚡\n\n` +
                        `✨ *Status:* \`Active & Ready\`\n` +
                        `⏰ *Uptime:* \`${uptimeStr}\`\n` +
                        `🔧 *Version:* \`3.0.0\`\n` +
                        `📊 *Performance:* \`Optimal\`\n\n` +
                        `🚀 *Modern Features:*\n` +
                        `• 🔐 WhatsApp Pairing System\n` +
                        `• 📰 Auto-Follow Channels\n` +
                        `• 🤖 AI Integration (ChatGPT)\n` +
                        `• 📱 Multi-Number Support\n` +
                        `• 🎵 Music & Sticker Tools\n` +
                        `• 🛡️ Anti-Call & Group Manager\n\n` +
                        `> 🔥 Powered by *JAMALI TECH TZ*`,
                    parse_mode: 'Markdown'
                }
            );
        } catch (error) {
            await ctx.reply(
                `⚡ *JAMALI MD IS ALIVE* ⚡\n\n` +
                `✨ *Status:* Active & Running\n` +
                `⏰ *Uptime:* 24/7\n` +
                `🔧 *Version:* 3.0.0\n` +
                `📊 *Performance:* Optimal\n\n` +
                `> 🔥 Powered by *JAMALI TECH TZ*`,
                { parse_mode: 'Markdown' }
            );
        }
    }
};
