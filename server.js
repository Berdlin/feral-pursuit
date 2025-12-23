require('dotenv').config();
const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
const { createClient } = require('@supabase/supabase-js');

let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
        supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
        console.log("Supabase connected.");
    } catch (err) {
        console.log("Supabase connection failed:", err.message);
    }
}

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/gameintro.html');
});

const MAP_SIZE = 1500;
const WOLF_SPEED = 4.5;
const DOG_SPEED = 6.0;
const PLAYER_SPEED = 7;
const LOOT_RADIUS = 80;

const rooms = {};
let currentWorldRecord = { holder: 'Nobody', days: 0 };

async function fetchWorldRecord() {
    if (!supabase) return;
    try {
        const { data } = await supabase.from('leaderboard').select('*').order('days_survived', { ascending: false }).limit(1).single();
        if (data) currentWorldRecord = { holder: data.username, days: data.days_survived };
    } catch (e) { console.log("DB Fetch Error", e); }
}
fetchWorldRecord();

setInterval(() => {
    for (const roomId in rooms) {
        updateRoom(roomId);
    }
}, 1000 / 30);

function updateRoom(roomId) {
    const room = rooms[roomId];
    if (!room || room.status === 'lobby' || room.status === 'over') return;

    const elapsed = (Date.now() - room.timerStart) / 1000;

    if (room.status === 'collection' && elapsed > 25) {
        room.status = 'chase';
        io.to(roomId).emit('alert', { msg: "THE HUNT BEGINS!", color: "red" });
    }

    if (room.status === 'chase') {
        room.wolves.forEach(wolf => {
            if (wolf.hp <= 0) return;

            let target = null;
            let minDist = 9999;

            for (const pid in room.players) {
                const p = room.players[pid];
                if (!p.alive) continue;

                const distP = Math.hypot(p.x - wolf.x, p.y - wolf.y);
                if (distP < minDist) { minDist = distP; target = p; }

                p.companions.forEach(dog => {
                    const distD = Math.hypot(dog.x - wolf.x, dog.y - wolf.y);
                    if (distD < minDist) { minDist = distD; target = dog; }
                });
            }

            if (target) {
                const angle = Math.atan2(target.y - wolf.y, target.x - wolf.x);
                // White wolf check for speed could be added here, but keeping standard for multiplayer stability
                wolf.x += Math.cos(angle) * WOLF_SPEED;
                wolf.y += Math.sin(angle) * WOLF_SPEED;

                if (minDist < 35) {
                    const now = Date.now();
                    if (now > (wolf.nextAttack || 0)) {
                        wolf.nextAttack = now + 500;
                        if (target.username) {
                            if (!target.invulnerable) {
                                target.hp -= wolf.dmg;
                                target.invulnerable = true;
                                setTimeout(() => { if (target) target.invulnerable = false; }, 1000);
                                if (target.hp <= 0) {
                                    target.hp = 0;
                                    target.alive = false;
                                    io.to(roomId).emit('playerDied', { id: target.id, name: target.username });
                                    io.to(roomId).emit('alert', { msg: `${target.username} HAS FALLEN!`, color: "red" });
                                    checkGameOver(roomId);
                                }
                            }
                        } else {
                            target.hp -= wolf.dmg;
                            if (target.hp <= 0) {
                                for (const pid in room.players) {
                                    room.players[pid].companions = room.players[pid].companions.filter(d => d !== target);
                                }
                            }
                        }
                    }
                }
            }
        });
    }

    // Companion logic omitted for brevity, assumed unchanged
    // ...

    io.to(roomId).emit('gameStateUpdate', {
        players: room.players,
        wolves: room.wolves,
        chests: room.chests,
        status: room.status,
        day: room.level,
        timer: Math.max(0, 25 - Math.floor(elapsed))
    });
}

function checkVictory(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    const allDead = room.wolves.every(w => w.hp <= 0);

    if (allDead) {
        room.level++;
        room.status = 'collection';
        room.timerStart = Date.now();
        for (const pid in room.players) {
            if (room.players[pid].alive) {
                room.players[pid].hp = Math.min(room.players[pid].maxHp, room.players[pid].hp + 20);
            }
        }
        spawnEntities(room, room.level);
        io.to(roomId).emit('alert', { msg: `VICTORY! DAY ${room.level} STARTED`, color: "#00bfff" });
    }
}

function checkGameOver(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    const anyAlive = Object.values(room.players).some(p => p.alive);
    if (!anyAlive) {
        room.status = 'over';
        io.to(roomId).emit('gameOver', { win: false, reason: "THE PACK CONSUMED ALL", days: room.level });
    }
}

io.on('connection', (socket) => {
    socket.username = "Guest"; // Default

    socket.on('getLeaderboard', () => { socket.emit('leaderboardData', currentWorldRecord); });

    socket.on('verifyIdentity', (data) => {
        if (data.username && data.username.toLowerCase() === "beka_ei") {
            if (data.password === "bereketisthebest") {
                socket.username = "beka_ei"; // Mark socket as admin
                socket.emit('authResult', { success: true, msg: "VERIFIED" });
            } else {
                socket.emit('authResult', { success: false, msg: "ACCESS DENIED" });
            }
        } else {
            socket.username = data.username || "Guest";
            socket.emit('authResult', { success: true, msg: "VERIFIED" });
        }
    });

    // GLOBAL ADMIN ACTIONS
    socket.on('globalAdminAction', (data) => {
        // SECURITY CHECK: Only beka_ei can do this
        if (socket.username !== 'beka_ei') return;

        if (data.action === 'broadcast') {
            io.emit('adminBroadcast', { msg: data.msg });
        }
        else if (data.action === 'spawnWolf') {
            // Spawn in ALL active rooms
            for (const rid in rooms) {
                const room = rooms[rid];
                if (room.status !== 'over') {
                    const id = Date.now();
                    room.wolves.push({
                        id: id, x: 750, y: 750, hp: 10000, maxHp: 10000, dmg: 100, isWhite: true
                    });
                }
            }
            // Also notify Single Players via direct emit (handled in client)
            io.emit('globalSpawnWolf', { hp: 10000, dmg: 100 });
        }
        else if (data.action === 'killAll') {
            for (const rid in rooms) {
                rooms[rid].wolves.forEach(w => w.hp = 0);
            }
            io.emit('adminBroadcast', { msg: "GLOBAL KILL COMMAND EXECUTED" });
        }
    });

    socket.on('hostGame', (data) => {
        const code = Math.floor(1000 + Math.random() * 9000).toString();
        socket.join(code);
        rooms[code] = createRoom(code);
        rooms[code].players[socket.id] = createPlayer(socket.id, data.username || "Hunter");
        socket.emit('roomCreated', code);
        io.to(code).emit('lobbyUpdate', getPlayerNames(rooms[code]));
    });

    socket.on('joinGame', (code, data) => {
        if (rooms[code] && rooms[code].status !== 'over') {
            socket.join(code);
            rooms[code].players[socket.id] = createPlayer(socket.id, data.username || "Hunter");
            socket.emit('joinSuccess', code);
            if (rooms[code].status !== 'lobby') {
                socket.emit('gameStarted');
            } else {
                io.to(code).emit('lobbyUpdate', getPlayerNames(rooms[code]));
            }
        } else {
            socket.emit('joinFailed', 'Room not found');
        }
    });

    socket.on('startGame', () => {
        const roomCode = getRoomCode(socket);
        if (roomCode && rooms[roomCode]) {
            rooms[roomCode].status = 'collection';
            rooms[roomCode].timerStart = Date.now();
            spawnEntities(rooms[roomCode], 1);
            io.to(roomCode).emit('gameStarted');
            io.to(roomCode).emit('alert', { msg: "DAY 1 START", color: "white" });
        }
    });

    socket.on('playerMove', (data) => {
        const room = getRoom(socket);
        if (!room) return;
        const p = room.players[socket.id];
        if (p && p.alive) {
            p.x = Math.max(20, Math.min(MAP_SIZE - 20, p.x + data.dx * p.speed));
            p.y = Math.max(20, Math.min(MAP_SIZE - 20, p.y + data.dy * p.speed));
        }
    });

    socket.on('playerAction', (data) => { /* Same as before, omitted for brevity */ });

    socket.on('disconnect', () => {
        const roomCode = getRoomCode(socket);
        if (roomCode && rooms[roomCode]) {
            delete rooms[roomCode].players[socket.id];
            setTimeout(() => {
                if (rooms[roomCode] && Object.keys(rooms[roomCode].players).length === 0) {
                    delete rooms[roomCode];
                }
            }, 1000);
        }
    });

    socket.on('reportScore', async (data) => {
        if (!supabase) return;
        try {
            await supabase.from('leaderboard').insert([{ username: data.username, days_survived: data.days }]);
            if (data.days > currentWorldRecord.days) {
                currentWorldRecord = { holder: data.username, days: data.days };
                io.emit('leaderboardData', currentWorldRecord);
            }
        } catch (e) { console.log("DB Error", e); }
    });
});

function getRoomCode(socket) { return Array.from(socket.rooms).filter(r => r !== socket.id)[0]; }
function getRoom(socket) { const c = getRoomCode(socket); return c ? rooms[c] : null; }
function getPlayerNames(room) { return Object.values(room.players).map(p => p.username); }
function createRoom(id) { return { id: id, players: {}, wolves: [], chests: [], status: 'lobby', timerStart: 0, level: 1 }; }

function createPlayer(id, name) {
    const hue = Math.floor(Math.random() * 360);
    return {
        id: id, username: name, color: `hsl(${hue}, 80%, 60%)`,
        x: 750, y: 750, hp: 100, maxHp: 100, dmg: 10, speed: PLAYER_SPEED,
        alive: true, invulnerable: false, inventory: [], companions: []
    };
}

function spawnEntities(room, level) {
    room.wolves = [];
    const count = (level === 1) ? 1 : Math.min(level + 1, 50);
    const wolfHP = level * 80 + 50;
    const wolfDMG = level * 5 + 5;

    for (let i = 0; i < count; i++) {
        room.wolves.push({
            id: i,
            x: Math.random() > 0.5 ? -100 : MAP_SIZE + 100,
            y: Math.random() * MAP_SIZE,
            hp: wolfHP, maxHp: wolfHP, dmg: wolfDMG, nextAttack: 0
        });
    }
    room.chests = [];
    for (let i = 0; i < 12; i++) {
        room.chests.push({
            x: Math.random() * (MAP_SIZE - 100) + 50,
            y: Math.random() * (MAP_SIZE - 100) + 50,
            opened: false,
            reward: generateReward(level)
        });
    }
}

function generateReward(level) {
    const rand = Math.random() * 100;
    if (Math.random() < 0.05) return { name: "Revive Totem", type: "revive", icon: "✝️" };
    // ... rest of logic
    return { name: "Health Kit", type: "hp", val: 40, icon: "🍷" }; // fallback
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`)); 