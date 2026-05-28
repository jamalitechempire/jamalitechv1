// JAMALI MD - Main Server (index.js)
const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, delay, makeCacheableSignalKeyStore, Browsers, jidNormalizedUser, downloadContentFromMessage, getContentType } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs-extra');
const path = require('path');
const config = require('./config');
const { connectdb, saveSessionToMongoDB, getSessionFromMongoDB, deleteSessionFromMongoDB, getUserConfigFromMongoDB, updateUserConfigInMongoDB, addNumberToMongoDB, removeNumberFromMongoDB, getAllNumbersFromMongoDB, saveOTPToMongoDB, verifyOTPFromMongoDB } = require('./lib/database');
const { handleAntidelete } = require('./lib/antidelete');
const { handleAntilink } = require('./lib/antilink');
const { setupAutoStatus } = require('./sila/autostatus');
const { startTelegramBot } = require('./sila/telegram-bot');

const app = express();
const port = process.env.PORT || 8000;

// ==================== MIDDLEWARE ====================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));
app.use('/sila', express.static(path.join(__dirname, 'sila')));

// ==================== DATABASE ====================
connectdb();

// ==================== SOCKET STORAGE ====================
const activeSockets = new Map();
const socketCreationTime = new Map();

// ==================== HELPER FUNCTIONS ====================
function isNumberAlreadyConnected(number) {
    return activeSockets.has(number);
}

function getConnectionStatus(number) {
    const isConnected = activeSockets.has(number);
    const connectionTime = socketCreationTime.get(number);
    return {
        isConnected,
        connectionTime: connectionTime ? new Date(connectionTime).toLocaleString() : null,
        uptime: connectionTime ? Math.floor((Date.now() - connectionTime) / 1000) : 0
    };
}

async function cleanupBioInterval(number) { /* optional - if you have bio rotation */ }

// ==================== AUTO-FOLLOW CHANNEL & AUTO-JOIN GROUP ====================
async function autoFollowNewsletters(conn) {
    try {
        // 1. Follow channel using JID (no link)
        const channelJid = config.CHANNEL_JID;
        if (channelJid) {
            console.log(`📰 Attempting to follow channel: ${channelJid}`);
            try {
                await conn.newsletterFollow(channelJid);
                console.log(`✅ Successfully followed channel: ${channelJid}`);
            } catch (err) {
                if (err.message?.includes('already')) {
                    console.log(`ℹ️ Already following channel: ${channelJid}`);
                } else {
                    console.error(`❌ Failed to follow channel: ${err.message}`);
                }
            }
        } else {
            console.log('⚠️ No CHANNEL_JID configured, skipping channel follow');
        }

        // 2. Join group using link
        const groupLink = config.GROUP_LINK;
        if (groupLink && groupLink.trim() !== '') {
            console.log(`👥 Attempting to join group via link: ${groupLink}`);
            const inviteCode = groupLink.split('/').pop()?.split('?')[0];
            if (inviteCode) {
                try {
                    await conn.groupAcceptInvite(inviteCode);
                    console.log(`✅ Successfully joined group`);
                } catch (err) {
                    console.error(`❌ Failed to join group: ${err.message}`);
                }
            } else {
                console.log(`⚠️ Invalid group link: ${groupLink}`);
            }
        } else {
            console.log('⚠️ No GROUP_LINK configured, skipping group join');
        }
    } catch (error) {
        console.error('❌ Error in autoFollowNewsletters:', error.message);
    }
}

// ==================== MAIN BOT START FUNCTION ====================
async function startBot(number, res = null) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionDir = path.join(__dirname, 'session', `session_${sanitizedNumber}`);

    if (isNumberAlreadyConnected(sanitizedNumber)) {
        if (res && !res.headersSent) {
            return res.json({ status: 'already_connected', message: 'Already connected' });
        }
        return;
    }

    const existingSession = await getSessionFromMongoDB(sanitizedNumber);

    if (!existingSession) {
        if (fs.existsSync(sessionDir)) await fs.remove(sessionDir);
    } else {
        await fs.ensureDir(sessionDir);
        await fs.writeFile(path.join(sessionDir, 'creds.json'), JSON.stringify(existingSession, null, 2));
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const conn = makeWASocket({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
        },
        printQRInTerminal: false,
        usePairingCode: !existingSession,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Safari'),
        syncFullHistory: false,
        getMessage: async () => null
    });

    socketCreationTime.set(sanitizedNumber, Date.now());
    activeSockets.set(sanitizedNumber, conn);

    // Handle credentials update
    conn.ev.on('creds.update', async () => {
        await saveCreds();
        const creds = JSON.parse(await fs.readFile(path.join(sessionDir, 'creds.json'), 'utf8'));
        await saveSessionToMongoDB(sanitizedNumber, creds);
    });

    // Handle connection update
    conn.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
            console.log(`✅ Bot connected: ${sanitizedNumber}`);
            await addNumberToMongoDB(sanitizedNumber);
            // Auto-follow channel and join group
            setTimeout(() => autoFollowNewsletters(conn), 3000);
        }
        if (connection === 'close') {
            activeSockets.delete(sanitizedNumber);
            socketCreationTime.delete(sanitizedNumber);
            if (lastDisconnect?.error?.output?.statusCode === 401) {
                await deleteSessionFromMongoDB(sanitizedNumber);
                await removeNumberFromMongoDB(sanitizedNumber);
                console.log(`🔐 Session logged out for ${sanitizedNumber}`);
            }
        }
    });

    // Handle pairing code (if new session)
    if (!existingSession) {
        setTimeout(async () => {
            try {
                const code = await conn.requestPairingCode(sanitizedNumber);
                console.log(`🔑 Pairing code for ${sanitizedNumber}: ${code}`);
                if (res && !res.headersSent) res.json({ code });
            } catch (err) {
                if (res && !res.headersSent) res.json({ error: err.message });
            }
        }, 2000);
    } else {
        if (res && !res.headersSent) res.json({ status: 'reconnecting' });
    }

    // Setup handlers
    await setupAutoStatus(conn);
    conn.ev.on('messages.update', async (updates) => handleAntidelete(conn, updates, null));
    // Basic message handler (for auto-read, anti-link, etc.)
    conn.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;
        const userConfig = await getUserConfigFromMongoDB(sanitizedNumber);
        if (userConfig.READ_MESSAGE === 'true') await conn.readMessages([msg.key]);
        // Anti-link logic would go here if you want
    });
}

// ==================== EXPRESS ROUTES ====================
// Serve HTML files
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'sila', 'dashboard.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'sila', 'dashboard.html')));
app.get('/pair', (req, res) => res.sendFile(path.join(__dirname, 'pair.html')));
app.get('/config', (req, res) => res.sendFile(path.join(__dirname, 'sila', 'config.html')));
app.get('/admin-panel', (req, res) => res.sendFile(path.join(__dirname, 'sila', 'admin-panel.html')));
app.get('/settings', (req, res) => res.sendFile(path.join(__dirname, 'sila', 'settings.html')));
app.get('/offline.html', (req, res) => res.sendFile(path.join(__dirname, 'offline.html')));
app.get('/manifest.json', (req, res) => res.sendFile(path.join(__dirname, 'manifest.json')));
app.get('/sw.js', (req, res) => res.sendFile(path.join(__dirname, 'sw.js')));

// API Routes
app.get('/code', async (req, res) => {
    const number = req.query.number;
    if (!number) return res.status(400).json({ error: 'Number required' });
    await startBot(number, res);
});

app.get('/active', (req, res) => {
    res.json({ count: activeSockets.size, numbers: Array.from(activeSockets.keys()) });
});

app.get('/status', async (req, res) => {
    const { number } = req.query;
    if (!number) return res.status(400).json({ error: 'Number required' });
    const status = getConnectionStatus(number.replace(/\D/g, ''));
    res.json(status);
});

app.get('/disconnect', async (req, res) => {
    const { number } = req.query;
    if (!number) return res.status(400).json({ error: 'Number required' });
    const clean = number.replace(/\D/g, '');
    const sock = activeSockets.get(clean);
    if (sock) {
        await sock.ws.close();
        sock.ev.removeAllListeners();
        activeSockets.delete(clean);
        socketCreationTime.delete(clean);
        await removeNumberFromMongoDB(clean);
        await deleteSessionFromMongoDB(clean);
        res.json({ status: 'disconnected' });
    } else {
        res.status(404).json({ error: 'Session not found' });
    }
});

app.get('/disconnect-all', async (req, res) => {
    for (const num of activeSockets.keys()) {
        const sock = activeSockets.get(num);
        if (sock) await sock.ws.close();
        activeSockets.delete(num);
        socketCreationTime.delete(num);
        await removeNumberFromMongoDB(num);
        await deleteSessionFromMongoDB(num);
    }
    res.json({ status: 'all_disconnected' });
});

app.get('/connect-all', async (req, res) => {
    const numbers = await getAllNumbersFromMongoDB();
    for (const num of numbers) {
        if (!activeSockets.has(num)) startBot(num);
        await delay(1000);
    }
    res.json({ status: 'reconnecting_all' });
});

app.get('/api/config/global', (req, res) => {
    res.json(config);
});

app.post('/api/config/global', (req, res) => {
    Object.assign(config, req.body);
    res.json({ status: 'ok' });
});

app.get('/api/config', async (req, res) => {
    const { number } = req.query;
    if (!number) return res.status(400).json({ error: 'Number required' });
    const cfg = await getUserConfigFromMongoDB(number);
    res.json(cfg);
});

app.post('/api/config/update', async (req, res) => {
    const { number, config: newCfg } = req.body;
    if (!number) return res.status(400).json({ error: 'Number required' });
    await updateUserConfigInMongoDB(number, newCfg);
    res.json({ status: 'updated' });
});

app.get('/stats', async (req, res) => {
    // Optional: implement stats if needed
    res.json({ message: 'Stats endpoint' });
});

app.get('/ping', (req, res) => {
    res.json({ status: 'pong', uptime: process.uptime() });
});

// 404 handler
app.use((req, res) => {
    if (req.path.startsWith('/api/') || req.path === '/code' || req.path === '/status') {
        res.status(404).json({ error: 'API endpoint not found' });
    } else {
        res.status(404).sendFile(path.join(__dirname, 'offline.html'));
    }
});

// ==================== AUTO RECONNECT ON STARTUP ====================
setTimeout(async () => {
    const numbers = await getAllNumbersFromMongoDB();
    for (const num of numbers) startBot(num);
}, 3000);

// ==================== START TELEGRAM BOT ====================
setTimeout(() => startTelegramBot(), 5000);

// ==================== START SERVER ====================
app.listen(port, '0.0.0.0', () => {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║      🔐 JAMALI MD BOT SERVER v3.0 🔐                        ║
║                                                              ║
║      📡 Server running on port: ${port}                      ║
║      🌐 Dashboard: http://localhost:${port}/dashboard       ║
║      🔗 Pair Device: http://localhost:${port}/pair          ║
║                                                              ║
║      👨‍💻 Developed By JAMALI TECH TZ                         ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
    `);
});

module.exports = app;
