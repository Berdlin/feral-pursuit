require('dotenv').config();
const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server, {
    cors: { origin: "*" }
});

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/gameintro.html');
});

// --- CONSTANTS ---
const MAP_SIZE = 1500;
const WOLF_SPEED = 5.0;
const PLAYER_SPEED = 7;

const rooms = {};

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

        // Boss Bar Update
        if (activeBoss) {
            io.to(roomId).emit('bossUpdate', { active: true, hp: activeBoss.hp, maxHp: activeBoss.maxHp });
        }
    }

    // Send State to Clients
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
    if (!room) return;
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

    // 1. GLOBAL CHAT LISTENER
    socket.on('globalChat', (data) => {
        // Broadcast to ALL sockets connected to server (Global)
        io.emit('globalChatMsg', {
            user: data.username || "Anon",
            text: data.text,
            color: data.isAdmin ? "#ff0000" : "#00bfff"
        });
    });

    // 2. AUTH
    socket.on('verifyIdentity', (data) => {
        if (data.username?.toLowerCase() === "beka_ei" && data.password === "bereketisthebest") {
            socket.username = "beka_ei";
            socket.isAdmin = true;
            socket.emit('authResult', { success: true, isAdmin: true });
        } else {
            socket.username = data.username || "Survivor";
            socket.emit('authResult', { success: true, isAdmin: false });
        }
    });

    // 3. VOICE SIGNALING (WebRTC Relay)
    socket.on('voiceSignal', (data) => {
        // data = { to: socketId, signal: signalData, from: socketId }
        io.to(data.to).emit('voiceSignalReceived', {
            signal: data.signal,
            from: socket.id
        });
    });

    // 4. GAME LOBBY LOGIC
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

            // If game already running, sync them immediately
            if (rooms[code].status !== 'lobby') {
                socket.emit('gameStarted');
            } else {
                io.to(code).emit('lobbyUpdate', getPlayerNames(rooms[code]));
            }

            // Notify existing players of new peer (for Voice)
            socket.to(code).emit('peerJoined', { signalId: socket.id });
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

    // 5. PLAYER INPUTS
    socket.on('playerInput', (data) => {
        const room = getRoom(socket);
        if (!room) return;
        const p = room.players[socket.id];
        if (p && p.alive) {
            // Apply movement (Server Authority)
            // data = { dx, dy } normalized
            if (data.dx || data.dy) {
                p.x = Math.max(20, Math.min(MAP_SIZE - 20, p.x + data.dx * p.speed));
                p.y = Math.max(20, Math.min(MAP_SIZE - 20, p.y + data.dy * p.speed));
            }
        }
    });

    socket.on('playerAttack', () => {
        const room = getRoom(socket);
        if (!room) return;
        const p = room.players[socket.id];
        if (!p || !p.alive) return;

        // Hit Detection
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
                // Simple reward logic for multiplayer (Upgrade dmg or heal)
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

    socket.on('disconnect', () => {
        const roomCode = getRoomCode(socket);
        if (roomCode && rooms[roomCode]) {
            delete rooms[roomCode].players[socket.id];
            io.to(roomCode).emit('lobbyUpdate', getPlayerNames(rooms[roomCode]));
            // Notify for voice disconnect
            io.to(roomCode).emit('peerLeft', { signalId: socket.id });

            // Clean up empty rooms
            if (Object.keys(rooms[roomCode].players).length === 0) {
                delete rooms[roomCode];
            }
        }
    });
});

// --- HELPER FUNCTIONS ---
function getRoomCode(socket) { return Array.from(socket.rooms).filter(r => r !== socket.id)[0]; }
function getRoom(socket) { const c = getRoomCode(socket); return c ? rooms[c] : null; }
function getPlayerNames(room) { return Object.values(room.players).map(p => p.username); }
function createRoom(id) { return { id: id, players: {}, wolves: [], chests: [], status: 'lobby', timerStart: 0, level: 1 }; }

function createPlayer(id, name) {
    return {
        id: id, username: name,
        x: 750, y: 750, hp: 100, maxHp: 100, dmg: 10, speed: PLAYER_SPEED,
        alive: true, invulnerable: false
    };
}

function spawnEntities(room, level) {
    room.wolves = [];
    room.chests = [];
    const count = Math.min(level + 1, 40);

    // Spawn Wolves
    for (let i = 0; i < count; i++) {
        room.wolves.push({
            id: i,
            x: Math.random() > 0.5 ? -100 : MAP_SIZE + 100,
            y: Math.random() * MAP_SIZE,
            hp: (level * 80) + 50,
            maxHp: (level * 80) + 50,
            dmg: (level * 5) + 5,
            nextAttack: 0, isWhite: false
        });
    }

    // Spawn Chests
    for (let i = 0; i < 15; i++) {
        room.chests.push({
            x: Math.random() * (MAP_SIZE - 100) + 50,
            y: Math.random() * (MAP_SIZE - 100) + 50,
            opened: false
        });
    }
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));