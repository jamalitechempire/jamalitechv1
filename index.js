const express = require('express');
const app = express();
const port = process.env.PORT || 8000;
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve static files FIRST
app.use(express.static(__dirname));
app.use('/sila', express.static(path.join(__dirname, 'sila')));

// Serve HTML files from root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'sila', 'dashboard.html'));
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'sila', 'dashboard.html'));
});

app.get('/pair', (req, res) => {
    res.sendFile(path.join(__dirname, 'pair.html'));
});

app.get('/config', (req, res) => {
    res.sendFile(path.join(__dirname, 'sila', 'config.html'));
});

app.get('/admin-panel', (req, res) => {
    res.sendFile(path.join(__dirname, 'sila', 'admin-panel.html'));
});

app.get('/settings', (req, res) => {
    res.sendFile(path.join(__dirname, 'sila', 'settings.html'));
});

// PWA manifest
app.get('/manifest.json', (req, res) => {
    res.sendFile(path.join(__dirname, 'manifest.json'));
});

// TEMPORARILY DISABLE service worker to avoid offline error
app.get('/sw.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Service-Worker-Allowed', '/');
    res.send(`
        // Empty service worker - disabled temporarily to fix offline issues
        self.addEventListener('install', () => {});
        self.addEventListener('fetch', () => {});
        self.addEventListener('activate', () => {});
    `);
});

app.get('/offline.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'offline.html'));
});

// Import and use the main bot router
const silaRouter = require('./sila');
app.use('/', silaRouter);

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Test endpoint for config
app.get('/test-api', (req, res) => {
    res.json({ message: 'API is working!', success: true });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('❌ Server Error:', err);
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
});

// 404 handler
app.use((req, res) => {
    if (req.path.startsWith('/api/') || req.path === '/code' || req.path === '/status' || req.path === '/active') {
        res.status(404).json({ error: 'API endpoint not found' });
    } else {
        res.status(404).sendFile(path.join(__dirname, 'offline.html'));
    }
});

// Start server
app.listen(port, '0.0.0.0', () => {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║      ███╗   ███╗ ██████╗ ███╗   ███╗██╗   ██╗              ║
║      ████╗ ████║██╔═══██╗████╗ ████║╚██╗ ██╔╝              ║
║      ██╔████╔██║██║   ██║██╔████╔██║ ╚████╔╝               ║
║      ██║╚██╔╝██║██║   ██║██║╚██╔╝██║  ╚██╔╝                ║
║      ██║ ╚═╝ ██║╚██████╔╝██║ ╚═╝ ██║   ██║                 ║
║      ╚═╝     ╚═╝ ╚═════╝ ╚═╝     ╚═╝   ╚═╝                 ║
║                                                              ║
║         ██████╗  ██████╗ ████████╗                         ║
║         ██╔══██╗██╔═══██╗╚══██╔══╝                         ║
║         ██████╔╝██║   ██║   ██║                            ║
║         ██╔══██╗██║   ██║   ██║                            ║
║         ██████╔╝╚██████╔╝   ██║                            ║
║         ╚═════╝  ╚═════╝    ╚═╝                            ║
║                                                              ║
║      🔐 MOMY-KIDY BOT SERVER v3.0 🔐                       ║
║                                                              ║
║      📡 Server running on port: ${port}                      ║
║      🌐 Dashboard: http://localhost:${port}/dashboard       ║
║      🔗 Pair Device: http://localhost:${port}/pair          ║
║      🧪 Test API: http://localhost:${port}/test-api         ║
║                                                              ║
║      👨‍💻 Developed By Sila Tech                             ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
    `);
});

module.exports = app;
