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

// --- GAME SETTINGS ---
const MAP_SIZE = 1500;
const WOLF_SPEED = 5.0;
const PLAYER_SPEED = 7;

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

// --- GAME LOOP (30 FPS) ---
setInterval(() => {
    for (const roomId in rooms) {
        updateRoom(roomId);
    }
}, 1000 / 30);

function updateRoom(roomId) {
    const room = rooms[roomId];
    if (!room || room.status === 'lobby' || room.status === 'over') return;

    const elapsed = (Date.now() - room.timerStart) / 1000;

    // Day Cycle Logic
    if (room.status === 'collection' && elapsed > 25) {
        room.status = 'chase';
        io.to(roomId).emit('alert', { msg: "THE HUNT BEGINS!", color: "red" });
    }

    // Wolf AI
    if (room.status === 'chase') {
        let activeBoss = null;
        room.wolves.forEach(wolf => {
            if (wolf.hp <= 0) return;
            if (wolf.isWhite) activeBoss = wolf;

            let target = null;
            let minDist = 9999;

            // Find closest target (Player or Dog)
            for (const pid in room.players) {
                const p = room.players[pid];
                if (!p.alive) continue;

                // Check Player
                const distP = Math.hypot(p.x - wolf.x, p.y - wolf.y);
                if (distP < minDist) { minDist = distP; target = p; }

                // Check Dogs
                if (p.companions) {
                    p.companions.forEach(dog => {
                        const distD = Math.hypot(dog.x - wolf.x, dog.y - wolf.y);
                        if (distD < minDist) { minDist = distD; target = dog; }
                    });
                }
            }

            if (target) {
                const angle = Math.atan2(target.y - wolf.y, target.x - wolf.x);
                // Boss is slower but scarier
                const speed = wolf.isWhite ? WOLF_SPEED * 0.8 : WOLF_SPEED;

                wolf.x += Math.cos(angle) * speed;
                wolf.y += Math.sin(angle) * speed;

                // Attack Logic
                const attackRange = wolf.isWhite ? 80 : 40;
                if (minDist < attackRange) {
                    const now = Date.now();
                    if (now > (wolf.nextAttack || 0)) {
                        wolf.nextAttack = now + 500;

                        // Deal Damage
                        if (target.username) { // It's a player
                            if (!target.invulnerable) {
                                target.hp -= wolf.dmg;
                                io.to(roomId).emit('playerHit', { id: target.id }); // Trigger visual flash
                                if (target.hp <= 0) {
                                    target.hp = 0;
                                    target.alive = false;
                                    io.to(roomId).emit('playerDied', { id: target.id, name: target.username });
                                    io.to(roomId).emit('alert', { msg: `${target.username} HAS FALLEN!`, color: "red" });
                                    checkGameOver(roomId);
                                }
                            }
                        } else { // It's a dog
                            target.hp -= wolf.dmg;
                            if (target.hp <= 0) {
                                // Remove dead dog
                                for (const pid in room.players) {
                                    room.players[pid].companions = room.players[pid].companions.filter(d => d !== target);
                                }
                            }
                        }
                    }
                }
            }
        });

        // Broadcast Boss Health if active
        if (activeBoss) {
            io.to(roomId).emit('bossUpdate', { active: true, hp: activeBoss.hp, maxHp: activeBoss.maxHp });
        } else {
            io.to(roomId).emit('bossUpdate', { active: false });
        }
    }

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
        // Heal survivors
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

// --- SOCKET EVENTS ---
io.on('connection', (socket) => {
    socket.username = "Guest";

    // 1. Identity Verification
    socket.on('verifyIdentity', (data) => {
        if (data.username && data.username.toLowerCase() === "beka_ei") {
            if (data.password === "bereketisthebest") {
                socket.username = "beka_ei";
                socket.isAdmin = true;
                socket.emit('authResult', { success: true, msg: "ADMIN VERIFIED", isAdmin: true });
            } else {
                socket.emit('authResult', { success: false, msg: "ACCESS DENIED" });
            }
        } else {
            socket.username = data.username || "Guest";
            socket.emit('authResult', { success: true, msg: "VERIFIED" });
        }
    });

    // 2. Global Admin Broadcast (Fixed)
    socket.on('globalAdminAction', (data) => {
        if (!socket.isAdmin) return;

        if (data.action === 'broadcast') {
            // Sends to everyone connected to the server
            io.emit('chatMessage', { user: "SERVER [ADMIN]", text: data.msg, color: "magenta" });
            io.emit('alert', { msg: data.msg, color: "magenta" });
        }
        else if (data.action === 'spawnWolf') {
            io.emit('globalSpawnWolf', { hp: 10000, dmg: 100 }); // For single players
            // For multiplayer rooms
            for (const rid in rooms) {
                const room = rooms[rid];
                if (room.status !== 'over') {
                    spawnBossWolf(room, 10000, 100);
                }
            }
        }
        else if (data.action === 'killAll') {
            for (const rid in rooms) {
                rooms[rid].wolves.forEach(w => w.hp = 0);
            }
        }
    });

    // 3. Game Hosting & Joining
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

    // 4. Player Movement
    socket.on('playerMove', (data) => {
        const room = getRoom(socket);
        if (!room) return;
        const p = room.players[socket.id];
        if (p && p.alive) {
            p.x = Math.max(20, Math.min(MAP_SIZE - 20, p.x + data.dx * p.speed));
            p.y = Math.max(20, Math.min(MAP_SIZE - 20, p.y + data.dy * p.speed));
        }
    });

    // 5. Attacks & Looting (Server Authority)
    socket.on('playerAttack', () => {
        const room = getRoom(socket);
        if (!room) return;
        const p = room.players[socket.id];
        if (!p || !p.alive) return;

        // Check distance to wolves
        room.wolves.forEach(w => {
            if (w.hp > 0 && Math.hypot(w.x - p.x, w.y - p.y) < 100) {
                w.hp -= p.dmg;
                if (w.hp <= 0) {
                    checkVictory(room.id);
                }
            }
        });
    });

    socket.on('tryLoot', () => {
        const room = getRoom(socket);
        if (!room) return;
        const p = room.players[socket.id];
        if (!p || !p.alive) return;

        room.chests.forEach((c, i) => {
            if (!c.opened && Math.hypot(p.x - c.x, p.y - c.y) < 80) {
                c.opened = true;
                // Apply reward directly to player state
                applyReward(p, c.reward);
                io.to(room.id).emit('lootOpened', { id: i, by: p.username });
                socket.emit('notification', { msg: `Found: ${c.reward.name}`, color: "gold" });
            }
        });
    });

    // 6. Chat System
    socket.on('sendChat', (msg) => {
        const roomCode = getRoomCode(socket);
        if (roomCode) {
            io.to(roomCode).emit('chatMessage', { user: socket.username, text: msg });
        }
    });

    // 7. Voice Call (WebRTC Signaling)
    socket.on('voice-signal', (payload) => {
        io.to(payload.target).emit('voice-signal', {
            signal: payload.signal,
            callerID: payload.callerID
        });
    });

    socket.on('join-voice', () => {
        const roomCode = getRoomCode(socket);
        const room = rooms[roomCode];
        if (room) {
            // Tell other players in this room to prepare for a call
            const otherUsers = Object.keys(room.players).filter(id => id !== socket.id);
            socket.emit('all-users', otherUsers);
        }
    });

    // 8. New OP Admin Panel (Shift + I)
    socket.on('adminPowerAction', (data) => {
        // Simple security: check if this socket is verified admin OR just allow for gameplay demo
        // For security, strict check:
        // if (!socket.isAdmin) return; 

        const room = getRoom(socket);
        if (!room) return;
        const p = room.players[socket.id];

        if (data.type === 'giveOP') {
            p.dmg = 500;
            p.hp = 5000;
            p.maxHp = 5000;
            socket.emit('alert', { msg: "GOD MODE ACTIVATED", color: "#00ff00" });
        }
        else if (data.type === 'spawnWolfLocal') {
            // Spawns a wolf just in this room
            const id = Date.now();
            room.wolves.push({
                id: id, x: p.x + 50, y: p.y, hp: 100, maxHp: 100, dmg: 10
            });
        }
    });

    socket.on('disconnect', () => {
        const roomCode = getRoomCode(socket);
        if (roomCode && rooms[roomCode]) {
            delete rooms[roomCode].players[socket.id];
            io.to(roomCode).emit('user-disconnected', socket.id); // For voice chat cleanup

            setTimeout(() => {
                if (rooms[roomCode] && Object.keys(rooms[roomCode].players).length === 0) {
                    delete rooms[roomCode];
                }
            }, 1000);
        }
    });
});

// --- HELPER FUNCTIONS ---
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
            hp: wolfHP, maxHp: wolfHP, dmg: wolfDMG, nextAttack: 0, isWhite: false
        });
    }
    room.chests = [];
    for (let i = 0; i < 15; i++) { // More chests for multiplayer
        room.chests.push({
            x: Math.random() * (MAP_SIZE - 100) + 50,
            y: Math.random() * (MAP_SIZE - 100) + 50,
            opened: false,
            reward: generateReward(level)
        });
    }
}

function spawnBossWolf(room, hp, dmg) {
    const id = Date.now();
    room.wolves.push({
        id: id, x: 750, y: 750, hp: hp, maxHp: hp, dmg: dmg, nextAttack: 0, isWhite: true
    });
    io.to(room.id).emit('alert', { msg: "LEGENDARY WHITE WOLF SPAWNED", color: "white" });
}

function generateReward(level) {
    const rand = Math.random() * 100;
    if (rand < 20) return { name: "Companion Dog", type: "potion", icon: "🐕" };
    if (rand < 40) return { name: "Iron Sword", type: "sword", val: 10, icon: "⚔️" };
    if (rand < 60) return { name: "Heavy Armor", type: "shield", val: 50, icon: "🛡️" };
    return { name: "Bandage", type: "hp", val: 40, icon: "🍷" };
}

function applyReward(p, item) {
    if (item.type === 'potion') {
        p.companions.push({ x: p.x, y: p.y, hp: 150, maxHp: 150, dmg: 20 });
    } else if (item.type === 'sword') {
        p.dmg += item.val;
    } else if (item.type === 'hp') {
        p.hp = Math.min(p.maxHp, p.hp + item.val);
    } else if (item.type === 'shield') {
        p.maxHp += item.val;
        p.hp += item.val;
    }
    p.inventory.push(item);
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});