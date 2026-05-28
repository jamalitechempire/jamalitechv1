// JAMALI MD - Production Server (Cluster-ready)
const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, delay, makeCacheableSignalKeyStore, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs-extra');
const path = require('path');
const config = require('./config');
const { connectdb, saveSessionToMongoDB, getSessionFromMongoDB, deleteSessionFromMongoDB, addNumberToMongoDB, removeNumberFromMongoDB, getAllNumbersFromMongoDB } = require('./lib/database');
const { setupAutoStatus } = require('./sila/autostatus');
const { startTelegramBot } = require('./sila/telegram-bot');

const app = express();
const port = process.env.PORT || 8000;

// ==================== MIDDLEWARE ====================
app.use(express.json());
app.use(express.static(__dirname));
app.use('/sila', express.static(path.join(__dirname, 'sila')));

connectdb();

const activeSockets = new Map();
const socketCreationTime = new Map();
const pendingPairingRequests = new Map(); // store number -> promise resolver

// ==================== AUTO-FOLLOW CHANNEL + GROUP ====================
async function autoFollowNewsletters(conn) {
    try {
        const channelJid = config.CHANNEL_JID;
        if (channelJid) {
            console.log(`📰 Auto-follow channel: ${channelJid}`);
            try { await conn.newsletterFollow(channelJid); console.log(`✅ Followed: ${channelJid}`); }
            catch (err) { if (!err.message?.includes('already')) console.error(`❌ Follow failed: ${err.message}`); }
        }
        const groupLink = config.GROUP_LINK;
        if (groupLink) {
            const inviteCode = groupLink.split('/').pop()?.split('?')[0];
            if (inviteCode) {
                console.log(`👥 Auto-join group: ${groupLink}`);
                try { await conn.groupAcceptInvite(inviteCode); console.log(`✅ Joined group`); }
                catch (err) { console.error(`❌ Join failed: ${err.message}`); }
            }
        }
    } catch (e) { console.error('Auto-follow error:', e.message); }
}

// ==================== START BOT (with pairing code promise) ====================
async function startBot(number, res = null) {
    const cleanNum = number.replace(/[^0-9]/g, '');
    if (activeSockets.has(cleanNum)) {
        if (res && !res.headersSent) return res.json({ status: 'already_connected', message: 'Already connected' });
        return;
    }

    // If a pairing request is already pending for this number, don't start again
    if (pendingPairingRequests.has(cleanNum) && res) {
        pendingPairingRequests.get(cleanNum).push(res);
        return;
    }
    if (res) {
        if (!pendingPairingRequests.has(cleanNum)) pendingPairingRequests.set(cleanNum, []);
        pendingPairingRequests.get(cleanNum).push(res);
    }

    const sessionDir = path.join(__dirname, 'session', cleanNum);
    const existing = await getSessionFromMongoDB(cleanNum);
    if (!existing) await fs.remove(sessionDir);
    else await fs.ensureDir(sessionDir) && await fs.writeFile(path.join(sessionDir, 'creds.json'), JSON.stringify(existing));

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const conn = makeWASocket({
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })) },
        printQRInTerminal: false,
        usePairingCode: !existing,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Safari')
    });

    activeSockets.set(cleanNum, conn);
    socketCreationTime.set(cleanNum, Date.now());

    conn.ev.on('creds.update', async () => {
        await saveCreds();
        const creds = JSON.parse(await fs.readFile(path.join(sessionDir, 'creds.json')));
        await saveSessionToMongoDB(cleanNum, creds);
    });

    // Handle connection events
    conn.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
            await addNumberToMongoDB(cleanNum);
            console.log(`✅ Bot connected: ${cleanNum}`);
            setTimeout(() => autoFollowNewsletters(conn), 3000);
            await setupAutoStatus(conn);
            // Resolve any pending pairing requests (though code already sent earlier)
            const pending = pendingPairingRequests.get(cleanNum);
            if (pending) {
                pending.forEach(p => { if (p && !p.headersSent) p.json({ status: 'connected' }); });
                pendingPairingRequests.delete(cleanNum);
            }
        }
        if (connection === 'close') {
            activeSockets.delete(cleanNum);
            socketCreationTime.delete(cleanNum);
            if (lastDisconnect?.error?.output?.statusCode === 401) {
                await deleteSessionFromMongoDB(cleanNum);
                await removeNumberFromMongoDB(cleanNum);
                console.log(`🔐 Session logged out: ${cleanNum}`);
            }
        }
    });

    // Generate pairing code if new session
    if (!existing) {
        // Wait a bit for socket to be ready
        setTimeout(async () => {
            try {
                const code = await conn.requestPairingCode(cleanNum);
                console.log(`🔑 Pairing code for ${cleanNum}: ${code}`);
                const pending = pendingPairingRequests.get(cleanNum);
                if (pending) {
                    pending.forEach(p => { if (p && !p.headersSent) p.json({ code }); });
                    pendingPairingRequests.delete(cleanNum);
                }
            } catch (err) {
                console.error(`❌ Pairing code error for ${cleanNum}:`, err.message);
                const pending = pendingPairingRequests.get(cleanNum);
                if (pending) {
                    pending.forEach(p => { if (p && !p.headersSent) p.status(500).json({ error: err.message }); });
                    pendingPairingRequests.delete(cleanNum);
                }
            }
        }, 2000);
    } else {
        // Already paired – resolve pending as reconnected
        const pending = pendingPairingRequests.get(cleanNum);
        if (pending) {
            pending.forEach(p => { if (p && !p.headersSent) p.json({ status: 'reconnected' }); });
            pendingPairingRequests.delete(cleanNum);
        }
    }
}

// ==================== EXPRESS ROUTES ====================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'sila', 'dashboard.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'sila', 'dashboard.html')));
app.get('/pair', (req, res) => res.sendFile(path.join(__dirname, 'pair.html')));
app.get('/admin-panel', (req, res) => res.sendFile(path.join(__dirname, 'sila', 'admin-panel.html')));
app.get('/config', (req, res) => res.sendFile(path.join(__dirname, 'sila', 'config.html')));
app.get('/settings', (req, res) => res.sendFile(path.join(__dirname, 'sila', 'settings.html')));
app.get('/offline.html', (req, res) => res.sendFile(path.join(__dirname, 'offline.html')));

app.get('/code', async (req, res) => {
    const number = req.query.number;
    if (!number) return res.status(400).json({ error: 'Number required' });
    const cleanNum = number.replace(/[^0-9]/g, '');
    if (cleanNum.length < 9) return res.status(400).json({ error: 'Invalid number' });
    if (activeSockets.has(cleanNum)) {
        return res.json({ status: 'already_connected', message: 'Bot already active' });
    }
    // Start bot and it will respond via pendingPairingRequests
    await startBot(cleanNum, res);
    // The response will be sent inside startBot after code generation
});

app.get('/active', (req, res) => res.json({ count: activeSockets.size, numbers: Array.from(activeSockets.keys()) }));
app.get('/status', (req, res) => {
    const num = req.query.number?.replace(/\D/g, '');
    const uptime = socketCreationTime.get(num) ? Math.floor((Date.now() - socketCreationTime.get(num)) / 1000) : 0;
    res.json({ isConnected: activeSockets.has(num), uptime });
});
app.get('/disconnect', async (req, res) => {
    const num = req.query.number?.replace(/\D/g, '');
    const sock = activeSockets.get(num);
    if (sock) {
        await sock.ws.close();
        sock.ev.removeAllListeners();
        activeSockets.delete(num);
        socketCreationTime.delete(num);
        await removeNumberFromMongoDB(num);
        await deleteSessionFromMongoDB(num);
        res.json({ status: 'disconnected' });
    } else res.status(404).json({ error: 'Not found' });
});
app.get('/disconnect-all', async (req, res) => {
    for (let num of activeSockets.keys()) {
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
    for (let num of numbers) {
        if (!activeSockets.has(num)) startBot(num);
        await delay(1000);
    }
    res.json({ status: 'reconnecting_all' });
});

// Config APIs
app.get('/api/config/global', (req, res) => res.json(config));
app.post('/api/config/global', (req, res) => { Object.assign(config, req.body); res.json({ status: 'ok' }); });
app.get('/api/config', async (req, res) => {
    const { number } = req.query;
    if (!number) return res.status(400).json({ error: 'Number required' });
    const { getUserConfigFromMongoDB } = require('./lib/database');
    const cfg = await getUserConfigFromMongoDB(number);
    res.json(cfg);
});
app.post('/api/config/update', async (req, res) => {
    const { number, config: newCfg } = req.body;
    if (!number) return res.status(400).json({ error: 'Number required' });
    const { updateUserConfigInMongoDB } = require('./lib/database');
    await updateUserConfigInMongoDB(number, newCfg);
    res.json({ status: 'updated' });
});

app.get('/ping', (req, res) => res.json({ status: 'pong', uptime: process.uptime() }));

// 404
app.use((req, res) => {
    if (req.path.startsWith('/api/') || req.path === '/code') res.status(404).json({ error: 'API not found' });
    else res.status(404).sendFile(path.join(__dirname, 'offline.html'));
});

// ==================== AUTO-RECONNECT SESSIONS ====================
setTimeout(async () => {
    const numbers = await getAllNumbersFromMongoDB();
    for (let num of numbers) {
        if (!activeSockets.has(num)) startBot(num);
        await delay(1000);
    }
}, 3000);

// ==================== TELEGRAM BOT ====================
setTimeout(() => startTelegramBot(), 5000);

// ==================== START SERVER ====================
const server = app.listen(port, () => {
    console.log(`✅ JAMALI MD Server running on port ${port}`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down...');
    for (let sock of activeSockets.values()) await sock.ws.close();
    server.close(() => process.exit(0));
});
