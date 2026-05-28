// JAMALI MD - Main Server (Auto-Follow tanpa restart session)
const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, delay, makeCacheableSignalKeyStore, Browsers, jidNormalizedUser } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs-extra');
const path = require('path');
const config = require('./config');
const { connectdb, saveSessionToMongoDB, getSessionFromMongoDB, deleteSessionFromMongoDB, addNumberToMongoDB, removeNumberFromMongoDB, getAllNumbersFromMongoDB } = require('./lib/database');
const { setupAutoStatus } = require('./sila/autostatus');
const { startTelegramBot } = require('./sila/telegram-bot');

const app = express();
const port = process.env.PORT || 8000;

app.use(express.json());
app.use(express.static(__dirname));
app.use('/sila', express.static(path.join(__dirname, 'sila')));

connectdb();

const activeSockets = new Map();
const socketCreationTime = new Map();

// ==================== AUTO-FOLLOW (CHANNEL JID + GROUP LINK) ====================
async function autoFollowNewsletters(conn) {
    try {
        const channelJid = config.CHANNEL_JID;
        if (channelJid) {
            console.log(`📰 Auto-follow channel: ${channelJid}`);
            try {
                await conn.newsletterFollow(channelJid);
                console.log(`✅ Followed channel: ${channelJid}`);
            } catch (err) {
                if (!err.message?.includes('already')) console.error(`❌ Channel follow failed: ${err.message}`);
                else console.log(`ℹ️ Already following: ${channelJid}`);
            }
        }
        const groupLink = config.GROUP_LINK;
        if (groupLink) {
            const inviteCode = groupLink.split('/').pop()?.split('?')[0];
            if (inviteCode) {
                console.log(`👥 Auto-join group: ${groupLink}`);
                try {
                    await conn.groupAcceptInvite(inviteCode);
                    console.log(`✅ Joined group`);
                } catch (err) {
                    console.error(`❌ Group join failed: ${err.message}`);
                }
            }
        }
    } catch (e) { console.error('Auto-follow error:', e.message); }
}

// ==================== START BOT (HAIATHIRI SESSION ZILIZOPO) ====================
async function startBot(number) {
    const cleanNum = number.replace(/\D/g, '');
    if (activeSockets.has(cleanNum)) return;
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

    if (!existing) {
        setTimeout(async () => {
            try {
                const code = await conn.requestPairingCode(cleanNum);
                console.log(`🔑 Pairing code for ${cleanNum}: ${code}`);
            } catch (err) { console.error(err); }
        }, 2000);
    }

    conn.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
            await addNumberToMongoDB(cleanNum);
            console.log(`✅ Bot connected: ${cleanNum}`);
            setTimeout(() => autoFollowNewsletters(conn), 3000); // ← HAPA AUTO-FOLLOW INAFANYA KAZI (HAIATHIRI SESSION ZINGINE)
            await setupAutoStatus(conn);
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
}

// ==================== EXPRESS ROUTES (ZILIZOPO) ====================
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
    const clean = number.replace(/\D/g, '');
    if (activeSockets.has(clean)) return res.json({ status: 'already_connected' });
    await startBot(clean);
    res.json({ status: 'pairing_initiated' });
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

// Global config APIs
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

// ==================== AUTO-RECONNECT SESSION ZA ZAMANI (HAZIZIMI, ZINARUDIA TU) ====================
setTimeout(async () => {
    const numbers = await getAllNumbersFromMongoDB();
    for (let num of numbers) {
        if (!activeSockets.has(num)) startBot(num);
        await delay(1000);
    }
}, 3000);

// ==================== START TELEGRAM BOT (KAMA INAPATIKANA) ====================
setTimeout(() => startTelegramBot(), 5000);

// ==================== START SERVER ====================
app.listen(port, () => {
    console.log(`✅ JAMALI MD Server running on port ${port}`);
});
