require('dotenv').config();
const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server, { cors: { origin: "*" } });
const fs = require('fs'); // Native file system for persistence

app.use(express.static(__dirname));

app.get('/', (req, res) => { res.sendFile(__dirname + '/gameintro.html'); });

// --- CONSTANTS ---
const MAP_SIZE = 1500;
const WOLF_SPEED = 5.0;
const PLAYER_SPEED = 7;
const DB_FILE = 'record.json';

// --- PERSISTENCE (Simple JSON DB) ---
let globalRecord = { days: 0, holder: "None" };

function loadRecord() {
    if (fs.existsSync(DB_FILE)) {
        try {
            const data = fs.readFileSync(DB_FILE, 'utf8');
            globalRecord = JSON.parse(data);
            console.log("Record loaded:", globalRecord);
        } catch (e) { console.error("Error loading record:", e); }
    }
}

function saveRecord() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(globalRecord));
    } catch (e) { console.error("Error saving record:", e); }
}

loadRecord(); // Load on startup

// --- STATE ---
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

            for (const pid in room.players) {
                const p = room.players[pid];
                if (!p.alive) continue;
                const dist = Math.hypot(p.x - wolf.x, p.y - wolf.y);
                if (dist < minDist) { minDist = dist; target = p; }
            }

            if (target) {
                const angle = Math.atan2(target.y - wolf.y, target.x - wolf.x);
                const speed = wolf.isWhite ? WOLF_SPEED * 0.8 : WOLF_SPEED;
                wolf.x += Math.cos(angle) * speed;
                wolf.y += Math.sin(angle) * speed;

                const attackRange = wolf.isWhite ? 80 : 40;
                if (minDist < attackRange) {
                    const now = Date.now();
                    if (now > (wolf.nextAttack || 0)) {
                        wolf.nextAttack = now + 500;
                        if (!target.invulnerable) {
                            target.hp -= wolf.dmg;
                            io.to(roomId).emit('playerHit', { id: target.id, hp: target.hp }); // UI update only
                            // Note: We send full state below, but immediate events help UI response
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

        if (activeBoss) io.to(roomId).emit('bossUpdate', { active: true, hp: activeBoss.hp, maxHp: activeBoss.maxHp });
    }

    // Send State (Positions only, inventory is sent on change)
    io.to(roomId).emit('gameStateUpdate', {
        players: Object.values(room.players).map(p => ({
            id: p.id, username: p.username, x: p.x, y: p.y, hp: p.hp, maxHp: p.maxHp, alive: p.alive
        })),
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
    if (room.wolves.every(w => w.hp <= 0)) {
        room.level++;
        // Check Record
        if (room.level > globalRecord.days) {
            globalRecord = { days: room.level, holder: "Squad " + roomId };
            saveRecord(); // PERSIST TO DISK
            io.emit('newRecord', globalRecord); // Announce to everyone
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

    socket.on('getLeaderboard', () => { socket.emit('leaderboardData', globalRecord); });

    socket.on('globalChat', (data) => {
        io.emit('globalChatMsg', { user: data.username || "Anon", text: data.text, color: data.isAdmin ? "#ff0000" : "#00bfff" });
    });

    socket.on('verifyIdentity', (data) => {
        const isAdmin = (data.username?.toLowerCase() === "beka_ei" && data.password === "bereketisthebest");
        socket.username = data.username || "Survivor";
        socket.isAdmin = isAdmin;
        socket.emit('authResult', { success: true, isAdmin: isAdmin });
    });

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
                // Send current inventory to reconnecting player
                socket.emit('inventoryUpdate', rooms[code].players[socket.id].inventory);
            } else {
                io.to(code).emit('lobbyUpdate', getPlayerNames(rooms[code]));
            }
        } else {
            socket.emit('joinFailed', 'Invalid Room');
        }
    });

    socket.on('startGame', () => {
        const room = getRoom(socket);
        if (room) {
            room.status = 'collection';
            room.timerStart = Date.now();
            spawnEntities(room, 1);
            io.to(room.id).emit('gameStarted');
        }
    });

    socket.on('playerInput', (data) => {
        const room = getRoom(socket);
        if (!room) return;
        const p = room.players[socket.id];
        if (p && p.alive) {
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

    // --- INVENTORY SYSTEM ---
    socket.on('tryLoot', () => {
        const room = getRoom(socket);
        if (!room) return;
        const p = room.players[socket.id];
        if (!p || !p.alive) return;

        room.chests.forEach((c, i) => {
            if (!c.opened && Math.hypot(p.x - c.x, p.y - c.y) < 80) {
                c.opened = true;
                const item = generateItem(room.level);
                p.inventory.push(item);

                io.to(room.id).emit('lootOpened', { id: i });
                socket.emit('notification', { msg: `Found: ${item.name}`, color: "gold" });
                socket.emit('inventoryUpdate', p.inventory); // Sync Client
            }
        });
    });

    socket.on('useItem', (index) => {
        const room = getRoom(socket);
        if (!room) return;
        const p = room.players[socket.id];
        if (!p || !p.alive || !p.inventory[index]) return;

        const item = p.inventory[index];

        // Apply Effect
        if (item.type === 'hp') p.hp = Math.min(p.maxHp, p.hp + item.val);
        else if (item.type === 'sword') p.dmg += item.val;
        else if (item.type === 'shield') { p.maxHp += item.val; p.hp += item.val; }
        else if (item.type === 'curse_dmg') p.dmg = Math.max(1, p.dmg + item.val);
        else if (item.type === 'hp_half') p.hp = Math.floor(p.hp * 0.5);

        // Remove Item and Sync
        p.inventory.splice(index, 1);
        socket.emit('inventoryUpdate', p.inventory);
        socket.emit('notification', { msg: `Used ${item.name}`, color: "#00ff00" });
    });

    // Admin
    socket.on('adminAction', (data) => {
        if (!socket.isAdmin) return;
        const room = getRoom(socket);
        if (!room) return;
        if (data.type === 'setStats') {
            const p = room.players[socket.id];
            if (p) { p.hp = data.hp; p.dmg = data.dmg; p.speed = data.speed; if (data.level) room.level = data.level; }
        } else if (data.type === 'killWolves') {
            room.wolves.forEach(w => w.hp = 0); checkVictory(room.id);
        } else if (data.type === 'spawnWhiteWolf') {
            room.wolves.push({ id: Date.now(), x: Math.random() * MAP_SIZE, y: Math.random() * MAP_SIZE, hp: 10000, maxHp: 10000, dmg: 100, isWhite: true, nextAttack: 0 });
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

// --- HELPER FUNCTIONS ---
function getRoomCode(socket) { return Array.from(socket.rooms).filter(r => r !== socket.id)[0]; }
function getRoom(socket) { const c = getRoomCode(socket); return c ? rooms[c] : null; }
function getPlayerNames(room) { return Object.values(room.players).map(p => p.username); }

function createRoom(id) { return { id: id, players: {}, wolves: [], chests: [], status: 'lobby', timerStart: 0, level: 1 }; }
function createPlayer(id, name) {
    return {
        id: id, username: name, x: 750, y: 750, hp: 100, maxHp: 100, dmg: 10, speed: PLAYER_SPEED,
        alive: true, invulnerable: false, inventory: []
    };
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

function generateItem(level) {
    const rand = Math.random() * 100;
    const badChance = Math.max(10, 50 - (level * 2));
    if (rand < badChance) {
        // Cursed items
        return [{ name: "Cursed Blade", type: "curse_dmg", val: -5, icon: "💀" }, { name: "Blood Debt", type: "hp_half", val: 0, icon: "🩸" }][Math.floor(Math.random() * 2)];
    } else {
        // Good items
        return [{ name: "Steel Sword", type: "sword", val: 12, icon: "⚔️" }, { name: "Health Kit", type: "hp", val: 40, icon: "🍷" }, { name: "Plate Armor", type: "shield", val: 60, icon: "🛡️" }][Math.floor(Math.random() * 3)];
    }
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));