require('dotenv').config();
const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));

app.get('/', (req, res) => { res.sendFile(__dirname + '/gameintro.html'); });

// --- CONSTANTS (Synced with Real Game) ---
const MAP_SIZE = 1500;
const WOLF_SPEED = 5.0;
const PLAYER_SPEED = 7;

// --- STATE ---
const rooms = {};
let globalRecord = { days: 12, holder: "AlphaTester" }; // Mock DB for World Record

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

    // Day Cycle
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

            // Target closest living player
            for (const pid in room.players) {
                const p = room.players[pid];
                if (!p.alive) continue;
                const dist = Math.hypot(p.x - wolf.x, p.y - wolf.y);
                if (dist < minDist) { minDist = dist; target = p; }
            }

            if (target) {
                const angle = Math.atan2(target.y - wolf.y, target.x - wolf.x);
                const speed = wolf.isWhite ? WOLF_SPEED * 0.8 : WOLF_SPEED;

                // Move Wolf
                wolf.x += Math.cos(angle) * speed;
                wolf.y += Math.sin(angle) * speed;

                // Collision/Attack
                const attackRange = wolf.isWhite ? 80 : 40;
                if (minDist < attackRange) {
                    const now = Date.now();
                    if (now > (wolf.nextAttack || 0)) {
                        wolf.nextAttack = now + 500;
                        if (!target.invulnerable) {
                            target.hp -= wolf.dmg;
                            io.to(roomId).emit('playerHit', { id: target.id, hp: target.hp });

                            if (target.hp <= 0) {
                                target.alive = false;
                                io.to(roomId).emit('playerDied', { id: target.id, name: target.username });
                                checkGameOver(roomId);
                            }
                        }
                    }
                }
            }
        });

        if (activeBoss) {
            io.to(roomId).emit('bossUpdate', { active: true, hp: activeBoss.hp, maxHp: activeBoss.maxHp });
        }
    }

    // Send State
    io.to(roomId).emit('gameStateUpdate', {
        players: room.players,
        wolves: room.wolves,
        chests: room.chests,
        status: room.status,
        day: room.level,
        timer: Math.max(0, 25 - Math.floor(elapsed))
    });
}

function checkGameOver(roomId) {
    const room = rooms[roomId];
    const anyAlive = Object.values(room.players).some(p => p.alive);
    if (!anyAlive) {
        room.status = 'over';
        io.to(roomId).emit('gameOver', { win: false, reason: "SQUAD WIPED OUT", days: room.level });
    }
}

function checkVictory(roomId) {
    const room = rooms[roomId];
    const allDead = room.wolves.every(w => w.hp <= 0);
    if (allDead) {
        room.level++;
        if (room.level > globalRecord.days) {
            globalRecord = { days: room.level, holder: "Squad " + roomId };
        }
        room.status = 'collection';
        room.timerStart = Date.now();
        // Heal Survivors
        for (const pid in room.players) {
            if (room.players[pid].alive) {
                room.players[pid].hp = Math.min(room.players[pid].maxHp, room.players[pid].hp + 30);
                room.players[pid].invulnerable = false;
            }
        }
        spawnEntities(room, room.level);
        io.to(roomId).emit('alert', { msg: `DAY ${room.level} STARTED`, color: "#00bfff" });
    }
}

// --- SOCKET EVENTS ---
io.on('connection', (socket) => {

    // 1. LEADERBOARD REQUEST
    socket.on('getLeaderboard', () => {
        socket.emit('leaderboardData', globalRecord);
    });

    // 2. GLOBAL CHAT (Broadcast to ALL connected clients)
    socket.on('globalChat', (data) => {
        io.emit('globalChatMsg', {
            user: data.username || "Anon",
            text: data.text,
            color: data.isAdmin ? "#ff0000" : "#00bfff"
        });
    });

    // 3. AUTH & IDENTITY
    socket.on('verifyIdentity', (data) => {
        if (data.username?.toLowerCase() === "beka_ei" && data.password === "bereketisthebest") {
            socket.username = "beka_ei";
            socket.isAdmin = true;
            socket.emit('authResult', { success: true, isAdmin: true });
        } else {
            socket.username = data.username || "Survivor";
            socket.isAdmin = false;
            socket.emit('authResult', { success: true, isAdmin: false });
        }
    });

    // 4. GAME LOGIC
    socket.on('hostGame', (data) => {
        const code = Math.floor(1000 + Math.random() * 9000).toString();
        socket.join(code);
        rooms[code] = createRoom(code);
        rooms[code].players[socket.id] = createPlayer(socket.id, data.username);
        socket.emit('roomCreated', code);
        io.to(code).emit('lobbyUpdate', getPlayerNames(rooms[code]));
    });

    socket.on('joinGame', (code, data) => {
        if (rooms[code] && rooms[code].status !== 'over') {
            socket.join(code);
            rooms[code].players[socket.id] = createPlayer(socket.id, data.username);
            socket.emit('joinSuccess', code);
            if (rooms[code].status !== 'lobby') {
                socket.emit('gameStarted');
            } else {
                io.to(code).emit('lobbyUpdate', getPlayerNames(rooms[code]));
            }
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

    socket.on('playerInput', (data) => {
        const room = getRoom(socket);
        if (!room) return;
        const p = room.players[socket.id];
        if (p && p.alive) {
            // Apply speed multiplier from Admin if set
            const spd = p.speed || PLAYER_SPEED;
            if (data.dx || data.dy) {
                p.x = Math.max(20, Math.min(MAP_SIZE - 20, p.x + data.dx * spd));
                p.y = Math.max(20, Math.min(MAP_SIZE - 20, p.y + data.dy * spd));
            }
        }
    });

    socket.on('playerAttack', () => {
        const room = getRoom(socket);
        if (!room) return;
        const p = room.players[socket.id];
        if (!p || !p.alive) return;
        room.wolves.forEach(w => {
            const range = w.isWhite ? 120 : 100;
            if (w.hp > 0 && Math.hypot(w.x - p.x, w.y - p.y) < range) {
                w.hp -= p.dmg;
                if (w.hp <= 0) checkVictory(room.id);
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
                const rand = Math.random();
                let msg = "";
                if (rand < 0.3) { p.dmg += 5; msg = "Sword Upgrade (+5 DMG)"; }
                else if (rand < 0.6) { p.hp = Math.min(p.maxHp, p.hp + 50); msg = "Health Potion (+50 HP)"; }
                else { p.maxHp += 20; p.hp += 20; msg = "Armor Found (+20 Max HP)"; }
                io.to(room.id).emit('lootOpened', { id: i });
                socket.emit('notification', { msg: msg, color: "gold" });
            }
        });
    });

    // --- MULTIPLAYER ADMIN ACTIONS ---
    socket.on('adminAction', (data) => {
        if (!socket.isAdmin) return;
        const room = getRoom(socket);
        if (!room) return;

        // Handle Admin Commands
        if (data.type === 'setStats') {
            const p = room.players[socket.id];
            if (p) {
                p.hp = data.hp; p.dmg = data.dmg; p.speed = data.speed;
                // Force room level if needed
                if (data.level) room.level = data.level;
            }
        } else if (data.type === 'killWolves') {
            room.wolves.forEach(w => w.hp = 0);
            checkVictory(room.id);
        } else if (data.type === 'spawnWhiteWolf') {
            room.wolves.push({
                id: Date.now(), x: Math.random() * MAP_SIZE, y: Math.random() * MAP_SIZE,
                hp: 10000, maxHp: 10000, dmg: 100, isWhite: true, nextAttack: 0
            });
            io.to(room.id).emit('alert', { msg: "ADMIN SPAWNED LEGENDARY WOLF", color: "white" });
        }
    });

    socket.on('disconnect', () => {
        const roomCode = getRoomCode(socket);
        if (roomCode && rooms[roomCode]) {
            delete rooms[roomCode].players[socket.id];
            io.to(roomCode).emit('lobbyUpdate', getPlayerNames(rooms[roomCode]));
            if (Object.keys(rooms[roomCode].players).length === 0) delete rooms[roomCode];
        }
    });
});

function getRoomCode(socket) { return Array.from(socket.rooms).filter(r => r !== socket.id)[0]; }
function getRoom(socket) { const c = getRoomCode(socket); return c ? rooms[c] : null; }
function getPlayerNames(room) { return Object.values(room.players).map(p => p.username); }
function createRoom(id) { return { id: id, players: {}, wolves: [], chests: [], status: 'lobby', timerStart: 0, level: 1 }; }
function createPlayer(id, name) {
    return { id: id, username: name, x: 750, y: 750, hp: 100, maxHp: 100, dmg: 10, speed: PLAYER_SPEED, alive: true, invulnerable: false };
}
function spawnEntities(room, level) {
    room.wolves = []; room.chests = [];
    const count = Math.min(level + 1, 40);
    for (let i = 0; i < count; i++) {
        room.wolves.push({ id: i, x: Math.random() > 0.5 ? -100 : MAP_SIZE + 100, y: Math.random() * MAP_SIZE, hp: (level * 80) + 50, maxHp: (level * 80) + 50, dmg: (level * 5) + 5, nextAttack: 0, isWhite: false });
    }
    for (let i = 0; i < 15; i++) {
        room.chests.push({ x: Math.random() * (MAP_SIZE - 100) + 50, y: Math.random() * (MAP_SIZE - 100) + 50, opened: false });
    }
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));