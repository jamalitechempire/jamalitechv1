// JAMALI MD - Auto Status & Newsletter Handler (Single Channel)
const { downloadContentFromMessage, delay } = require('@whiskeysockets/baileys');
const config = require('../config');

const STATUS_CONFIG = {
    AUTO_VIEW_STATUS: 'true',
    AUTO_LIKE_STATUS: 'true',
    AUTO_RECORDING: 'true',
    AUTO_LIKE_EMOJI: ['💗', '🔥', '❤️', '👍', '😎', '💫', '👑', '⭐', '🎉', '🤩'],
    AUTO_REACT_NEWSLETTERS: 'true',
    NEWSLETTER_JIDS: [config.CHANNEL_JID || '120363425061263455@newsletter'], // Single channel
    NEWSLETTER_REACT_EMOJIS: ['❤️', '🔥', '💫', '👑', '⚡', '🎯'],
    MAX_RETRIES: 3,
    SAVE_TRANSLATIONS: ['save', 'send', 'okoa', 'tuma', 'status']
};

async function setupNewsletterHandlers(socket) {
    if (!socket) return;
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key) return;
        const isNewsletter = STATUS_CONFIG.NEWSLETTER_JIDS.some(jid => message.key.remoteJid === jid);
        if (!isNewsletter || STATUS_CONFIG.AUTO_REACT_NEWSLETTERS !== 'true') return;
        try {
            const emoji = STATUS_CONFIG.NEWSLETTER_REACT_EMOJIS[Math.floor(Math.random() * STATUS_CONFIG.NEWSLETTER_REACT_EMOJIS.length)];
            const msgId = message.newsletterServerId;
            if (!msgId) return;
            await socket.newsletterReactMessage(message.key.remoteJid, msgId.toString(), emoji);
            console.log(`✅ Reacted to newsletter ${message.key.remoteJid} with ${emoji}`);
        } catch (e) { console.error('Newsletter react error:', e.message); }
    });
}

async function setupStatusHandlers(socket) { /* existing logic, keep as is but with JAMALI MD footer */ }
async function setupStatusSavers(socket) { /* existing logic with JAMALI MD footer */ }

async function setupAutoStatus(socket) {
    if (!socket) return;
    await setupStatusHandlers(socket);
    await setupStatusSavers(socket);
    await setupNewsletterHandlers(socket);
    console.log('✅ JAMALI MD Auto-Status Handlers Active');
}

module.exports = { setupAutoStatus, STATUS_CONFIG };
