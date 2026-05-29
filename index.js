const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, delay, makeCacheableSignalKeyStore, Browsers, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs-extra');
const path = require('path');
const config = require('./config');
const { connectdb, saveSessionToMongoDB, getSessionFromMongoDB, deleteSessionFromMongoDB, addNumberToMongoDB, removeNumberFromMongoDB, getAllNumbersFromMongoDB } = require('./lib/database');

const app = express();
const port = process.env.PORT || 8000;
app.use(express.json());
app.use(express.static(__dirname));

connectdb();

const activeSockets = new Map();
const pendingPairings = new Map();

async function startBot(number, res = null) {
    const clean = number.replace(/\D/g, '');
    if (clean.length < 9) return res?.status(400).json({ error: 'Invalid number' });
    if (activeSockets.has(clean)) return res?.json({ status: 'already_connected' });
    if (res) {
        if (!pendingPairings.has(clean)) pendingPairings.set(clean, []);
        pendingPairings.get(clean).push(res);
    }
    const sessionDir = path.join(__dirname, 'session', clean);
    const existing = await getSessionFromMongoDB(clean);
    if (!existing) await fs.remove(sessionDir);
    else {
        await fs.ensureDir(sessionDir);
        await fs.writeFile(path.join(sessionDir, 'creds.json'), JSON.stringify(existing));
    }
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const conn = makeWASocket({
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })) },
        printQRInTerminal: false,
        usePairingCode: !existing,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Safari')
    });
    activeSockets.set(clean, conn);
    conn.ev.on('creds.update', async () => {
        await saveCreds();
        const creds = JSON.parse(await fs.readFile(path.join(sessionDir, 'creds.json')));
        await saveSessionToMongoDB(clean, creds);
    });
    conn.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
            await addNumberToMongoDB(clean);
            console.log(`✅ Bot ${clean} connected`);
            const pending = pendingPairings.get(clean);
            if (pending) pending.forEach(p => p?.json({ status: 'connected' }));
            pendingPairings.delete(clean);
        }
        if (connection === 'close') {
            activeSockets.delete(clean);
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                await deleteSessionFromMongoDB(clean);
                await removeNumberFromMongoDB(clean);
                console.log(`🔐 Session logged out: ${clean}`);
            }
        }
    });
    if (!existing) {
        setTimeout(async () => {
            try {
                const code = await conn.requestPairingCode(clean);
                console.log(`🔑 Pairing code for ${clean}: ${code}`);
                const pending = pendingPairings.get(clean);
                if (pending) pending.forEach(p => p?.json({ code }));
                pendingPairings.delete(clean);
            } catch (err) {
                const pending = pendingPairings.get(clean);
                if (pending) pending.forEach(p => p?.status(500).json({ error: err.message }));
                pendingPairings.delete(clean);
            }
        }, 2000);
    } else {
        const pending = pendingPairings.get(clean);
        if (pending) pending.forEach(p => p?.json({ status: 'reconnected' }));
        pendingPairings.delete(clean);
    }
}

// ==================== EXPRESS ROUTES ====================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'pair.html')));
app.get('/pair', (req, res) => res.sendFile(path.join(__dirname, 'pair.html')));
app.get('/code', async (req, res) => {
    const number = req.query.number;
    if (!number) return res.status(400).json({ error: 'Number required' });
    const clean = number.replace(/\D/g, '');
    if (clean.length < 9) return res.status(400).json({ error: 'Invalid number' });
    if (activeSockets.has(clean)) return res.json({ status: 'already_connected' });
    await startBot(clean, res);
});
app.get('/active', (req, res) => res.json({ count: activeSockets.size, numbers: Array.from(activeSockets.keys()) }));
app.get('/status', (req, res) => {
    const num = req.query.number?.replace(/\D/g, '');
    res.json({ isConnected: activeSockets.has(num), uptime: 0 });
});
app.get('/disconnect', async (req, res) => {
    const num = req.query.number?.replace(/\D/g, '');
    const sock = activeSockets.get(num);
    if (sock) {
        await sock.ws.close();
        activeSockets.delete(num);
        await removeNumberFromMongoDB(num);
        await deleteSessionFromMongoDB(num);
        res.json({ status: 'disconnected' });
    } else res.status(404).json({ error: 'Not found' });
});
app.get('/ping', (req, res) => res.json({ status: 'pong' }));
app.use((req, res) => res.status(404).send('Not found'));

// Auto-reconnect on startup
setTimeout(async () => {
    const nums = await getAllNumbersFromMongoDB();
    for (let num of nums) startBot(num);
}, 3000);

app.listen(port, () => console.log(`✅ JAMALI MD server on port ${port}`));