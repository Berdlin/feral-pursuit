require('dotenv').config();
const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
const { createClient } = require('@supabase/supabase-js');

// --- DATABASE SETUP ---
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Serve files from root
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/gameintro.html');
});

// --- GAME CONFIGURATION ---
const MAP_SIZE = 1500;
const WOLF_SPEED = 4.5;
const DOG_SPEED = 6.0;
const PLAYER_SPEED = 7;

// Active Rooms
const rooms = {};

// --- SERVER GAME LOOP (30 FPS) ---
setInterval(() => {
    for (const roomId in rooms) {
        updateRoom(roomId);
    }
}, 1000 / 30);

function updateRoom(roomId) {
    const room = rooms[roomId];
    if (!room || room.status === 'lobby') return;

    // 1. Manage Timer
    if (room.status === 'collection') {
        const now = Date.now();
        if (now - room.timerStart > 25000) { // 25 seconds collection phase
            room.status = 'chase';
        }
    }

    // 2. Move Wolves
    if (room.status === 'chase') {
        room.wolves.forEach(wolf => {
            if (wolf.hp <= 0) return;

            // Find nearest alive player OR player's dog
            let target = null;
            let minDist = 9999;

            // Check Players
            for (const pid in room.players) {
                const p = room.players[pid];
                if (!p.alive) continue;

                // Check Player Distance
                const distP = Math.hypot(p.x - wolf.x, p.y - wolf.y);
                if (distP < minDist) { minDist = distP; target = p; }

                // Check Player's Dogs (Wolves attack dogs too!)
                p.companions.forEach(dog => {
                    const distD = Math.hypot(dog.x - wolf.x, dog.y - wolf.y);
                    if (distD < minDist) { minDist = distD; target = dog; }
                });
            }

            if (target) {
                const angle = Math.atan2(target.y - wolf.y, target.x - wolf.x);
                wolf.x += Math.cos(angle) * WOLF_SPEED;
                wolf.y += Math.sin(angle) * WOLF_SPEED;

                // Attack Target
                if (minDist < 35) {
                    // If target is player
                    if (target.username && !target.invulnerable) {
                        target.hp -= wolf.dmg;
                        target.invulnerable = true;
                        setTimeout(() => { if (target) target.invulnerable = false; }, 1000);
                        if (target.hp <= 0) { target.hp = 0; target.alive = false; checkGameOver(roomId); }
                    }
                    // If target is dog
                    else if (!target.username) {
                        target.hp -= wolf.dmg;
                        // Remove dead dogs
                        if (target.hp <= 0) {
                            for (const pid in room.players) {
                                room.players[pid].companions = room.players[pid].companions.filter(d => d !== target);
                            }
                        }
                    }
                }
            }
        });
    }

    // 3. Move Companions (Dogs)
    for (const pid in room.players) {
        const p = room.players[pid];
        if (!p.alive) continue;

        p.companions.forEach(dog => {
            // Find nearest active wolf
            let targetWolf = null;
            let minDist = 9999;

            room.wolves.forEach(w => {
                if (w.hp <= 0) return;
                const dist = Math.hypot(w.x - dog.x, w.y - dog.y);
                if (dist < minDist) { minDist = dist; targetWolf = w; }
            });

            // Logic: Follow player if no wolf nearby, else attack wolf
            let moveTarget = p; // Default follow player
            if (targetWolf && room.status === 'chase') moveTarget = targetWolf;

            const angle = Math.atan2(moveTarget.y - dog.y, moveTarget.x - dog.x);
            const dist = Math.hypot(moveTarget.x - dog.x, moveTarget.y - dog.y);

            // Move
            if (dist > 40) {
                dog.x += Math.cos(angle) * DOG_SPEED;
                dog.y += Math.sin(angle) * DOG_SPEED;
            }

            // Attack Wolf
            if (targetWolf && dist < 50) {
                const now = Date.now();
                if (now > dog.nextAttack) {
                    targetWolf.hp -= dog.dmg;
                    dog.nextAttack = now + 800; // Attack cooldown
                }
            }
        });
    }

    // 4. Broadcast State
    io.to(roomId).emit('gameStateUpdate', {
        players: room.players,
        wolves: room.wolves,
        chests: room.chests,
        status: room.status,
        timer: 25 - Math.floor((Date.now() - room.timerStart) / 1000)
    });
}

function checkGameOver(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    const anyAlive = Object.values(room.players).some(p => p.alive);
    if (!anyAlive) {
        room.status = 'over';
        io.to(roomId).emit('gameOver', { win: false, reason: "THE PACK CONSUMED ALL" });
    } else {
        // Check if wolves are all dead
        const wolvesAlive = room.wolves.some(w => w.hp > 0);
        if (!wolvesAlive && room.status === 'chase') {
            room.status = 'over';
            io.to(roomId).emit('gameOver', { win: true, reason: "WAVE SURVIVED" });
        }
    }
}

// --- CONNECTION LOGIC ---
io.on('connection', (socket) => {

    // Identity
    socket.on('verifyIdentity', (data) => {
        const { username, password } = data;
        if (username && username.toLowerCase() === "beka_ei" && password !== "bereketisthebest") {
            socket.emit('authResult', { success: false, msg: "ACCESS DENIED" });
        } else {
            socket.emit('authResult', { success: true, msg: "VERIFIED" });
        }
    });

    // Room Management
    socket.on('hostGame', (data) => {
        const code = Math.floor(1000 + Math.random() * 9000).toString();
        socket.join(code);
        rooms[code] = createRoom(code);
        rooms[code].players[socket.id] = createPlayer(socket.id, data.username);
        socket.emit('roomCreated', code);
        io.to(code).emit('lobbyUpdate', getPlayerNames(rooms[code]));
    });

    socket.on('joinGame', (code, data) => {
        if (rooms[code] && rooms[code].status === 'lobby') {
            socket.join(code);
            rooms[code].players[socket.id] = createPlayer(socket.id, data.username);
            socket.emit('joinSuccess', code);
            io.to(code).emit('lobbyUpdate', getPlayerNames(rooms[code]));
        } else {
            socket.emit('joinFailed', 'Invalid Room');
        }
    });

    socket.on('startGame', () => {
        const roomCode = getRoomCode(socket);
        if (roomCode && rooms[roomCode]) {
            rooms[roomCode].status = 'collection';
            rooms[roomCode].timerStart = Date.now();
            spawnEntities(rooms[roomCode], 1);
            io.to(roomCode).emit('gameStarted');
        }
    });

    // Game Inputs
    socket.on('playerMove', (data) => {
        const room = getRoom(socket);
        if (!room) return;
        const p = room.players[socket.id];
        if (p && p.alive) {
            p.x += data.dx * p.speed;
            p.y += data.dy * p.speed;
            p.x = Math.max(20, Math.min(MAP_SIZE - 20, p.x));
            p.y = Math.max(20, Math.min(MAP_SIZE - 20, p.y));
        }
    });

    socket.on('playerAction', (data) => {
        const room = getRoom(socket);
        if (!room) return;
        const p = room.players[socket.id];
        if (!p || !p.alive) return;

        if (data.type === 'attack') {
            room.wolves.forEach(w => {
                if (w.hp > 0 && Math.hypot(w.x - p.x, w.y - p.y) < 100) {
                    w.hp -= p.dmg;
                    if (w.hp <= 0) checkGameOver(room.id);
                }
            });
        }
        else if (data.type === 'loot') {
            room.chests.forEach((c, i) => {
                if (!c.opened && Math.hypot(p.x - c.x, p.y - c.y) < 60) {
                    c.opened = true;
                    // Apply immediate effect or add to inventory
                    if (c.reward.type.includes('hp_loss')) {
                        p.hp += c.reward.val; // Negative value
                        if (p.hp <= 0) { p.alive = false; checkGameOver(room.id); }
                    } else {
                        p.inventory.push(c.reward);
                    }
                }
            });
        }
        else if (data.type === 'useItem') {
            const item = p.inventory[data.index];
            if (item) {
                applyItemEffect(p, item);
                p.inventory.splice(data.index, 1);
            }
        }
    });

    // --- ADMIN COMMANDS ---
    socket.on('adminCmd', (data) => {
        const room = getRoom(socket);
        if (!room) return;

        if (data.action === 'spawnDogs') {
            const p = room.players[socket.id];
            for (let i = 0; i < data.val; i++) {
                p.companions.push({
                    x: p.x, y: p.y,
                    hp: 150, maxHp: 150, dmg: 20,
                    nextAttack: 0
                });
            }
        }
        else if (data.action === 'killWolves') {
            room.wolves.forEach(w => w.hp = 0);
            checkGameOver(room.id);
        }
        else if (data.action === 'setStats') {
            const p = room.players[socket.id];
            if (data.hp) p.hp = parseInt(data.hp);
            if (data.dmg) p.dmg = parseInt(data.dmg);
            if (data.speed) p.speed = parseInt(data.speed);
        }
    });

    socket.on('disconnect', () => {
        const roomCode = getRoomCode(socket);
        if (roomCode && rooms[roomCode]) {
            delete rooms[roomCode].players[socket.id];
            if (Object.keys(rooms[roomCode].players).length === 0) delete rooms[roomCode];
        }
    });
});

// --- HELPER FUNCTIONS ---
function getRoomCode(socket) { return Array.from(socket.rooms).filter(r => r !== socket.id)[0]; }
function getRoom(socket) { const c = getRoomCode(socket); if (c) return rooms[c]; return null; }
function getPlayerNames(room) { return Object.values(room.players).map(p => p.username); }

function createRoom(id) {
    return { id: id, players: {}, wolves: [], chests: [], status: 'lobby', timerStart: 0 };
}

function createPlayer(id, name) {
    return {
        id: id, username: name || "Hunter",
        x: 750, y: 750,
        hp: 100, maxHp: 100, dmg: 10, speed: PLAYER_SPEED,
        alive: true, invulnerable: false,
        inventory: [], companions: []
    };
}

function spawnEntities(room, level) {
    // Wolves
    room.wolves = [];
    const count = level + 2;
    for (let i = 0; i < count; i++) {
        room.wolves.push({
            id: i,
            x: Math.random() > 0.5 ? -100 : MAP_SIZE + 100,
            y: Math.random() * MAP_SIZE,
            hp: 80 + (level * 20), maxHp: 80, dmg: 5 + level
        });
    }
    // Chests (Uses logic from realgame)
    room.chests = [];
    for (let i = 0; i < 15; i++) {
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
    if (rand < 30) return { name: "Cursed Blade", type: "curse_dmg", val: -5, icon: "💀" };
    if (rand < 50) return { name: "Summon Dog", type: "potion", icon: "🐕" };
    if (rand < 70) return { name: "Health Kit", type: "hp", val: 40, icon: "🍷" };
    return { name: "Steel Sword", type: "sword", val: 12, icon: "⚔️" };
}

function applyItemEffect(p, item) {
    if (item.type === 'potion') {
        p.companions.push({ x: p.x, y: p.y, hp: 120, maxHp: 120, dmg: 15, nextAttack: 0 });
    }
    else if (item.type === 'hp') p.hp = Math.min(p.maxHp, p.hp + item.val);
    else if (item.type === 'sword') p.dmg += item.val;
    else if (item.type === 'curse_dmg') p.dmg += item.val;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));