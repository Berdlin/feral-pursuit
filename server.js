require('dotenv').config();
const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
const { createClient } = require('@supabase/supabase-js');

// Supabase Setup 
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

app.use(express.static('public')); // Checks "public" folder for HTML files

let worldRecord = { days: 0, holder: "None" };

// Fetch initial record
async function loadWorldRecord() {
    try {
        const { data } = await supabase.from('leaderboard').select('*').order('days', { ascending: false }).limit(1).single();
        if (data) worldRecord = { days: data.days, holder: data.username };
    } catch (e) { console.log("DB connection pending..."); }
}
loadWorldRecord();

io.on('connection', (socket) => {
    socket.emit('updateWR', worldRecord);

    // --- 1. IDENTITY VERIFICATION (Fixes beka_ei issue) ---
    socket.on('verifyIdentity', (data) => {
        const { username, password } = data;

        // STRICT CHECK: If name is beka_ei, password MUST be bereketisthebest
        if (username && username.toLowerCase() === "beka_ei") {
            if (password !== "bereketisthebest") {
                socket.emit('authResult', { success: false, msg: ">> ACCESS DENIED: INCORRECT PASSWORD FOR THIS IDENTITY." });
                return;
            } else {
                socket.emit('authResult', { success: true, msg: ">> WELCOME, CREATOR." });
            }
        } else {
            // Everyone else is allowed
            socket.emit('authResult', { success: true, msg: ">> IDENTITY VERIFIED." });
        }
    });

    // --- 2. MULTIPLAYER START (Fixes "Start Mission" button) ---
    socket.on('hostGame', (data) => {
        let code = Math.floor(1000 + Math.random() * 9000).toString();
        socket.join(code);
        socket.emit('roomCreated', code);
    });

    socket.on('joinGame', (code, data) => {
        const room = io.sockets.adapter.rooms.get(code);
        if (room) {
            socket.join(code);
            socket.emit('joinSuccess', code);
            const players = Array.from(room).map(id => "Hunter"); // Simple list
            io.to(code).emit('lobbyUpdate', players);
        } else {
            socket.emit('joinFailed', 'Invalid Room Code');
        }
    });

    // THIS WAS MISSING: Handles the "Start Mission" button click
    socket.on('startGame', () => {
        // Find the room this player is in
        const rooms = Array.from(socket.rooms).filter(r => r !== socket.id);
        if (rooms.length > 0) {
            // Tell EVERYONE in the room to go to multiplay.html
            io.to(rooms[0]).emit('gameStarted');
        }
    });

    // --- 3. SCORE & MOVEMENT ---
    socket.on('reportScore', async (data) => {
        if (typeof data.days !== 'number' || data.days > 5000) return;
        if (data.days > worldRecord.days) {
            worldRecord = { days: data.days, holder: data.username };
            io.emit('updateWR', worldRecord);
            await supabase.from('leaderboard').insert([{ username: data.username, days: data.days }]);
        }
    });

    socket.on('playerAction', (packet) => {
        const rooms = Array.from(socket.rooms).filter(r => r !== socket.id);
        if (rooms.length > 0) socket.to(rooms[0]).emit('remoteAction', { id: socket.id, action: packet });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));