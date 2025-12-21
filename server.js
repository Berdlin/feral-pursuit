require('dotenv').config();
const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
const { createClient } = require('@supabase/supabase-js');

// --- DATABASE SETUP (Safe Failover) ---
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/gameintro.html');
});

// --- GAME CONFIGURATION ---
const MAP_SIZE = 1500;
const WOLF_SPEED = 4.5;
const DOG_SPEED = 6.0;
const PLAYER_SPEED = 7;

const rooms = {};

// --- GAME LOOP (30 Ticks/Sec) ---
setInterval(() => {
    for (const roomId in rooms) {
        updateRoom(roomId);
    }
}, 1000 / 30);

function updateRoom(roomId) {
    const room = rooms[roomId];
    if (!room || room.status === 'lobby' || room.status === 'over') return;

    const elapsed = (Date.now() - room.timerStart) / 1000;

    // 1. Phase Change: Collection -> Chase
    if (room.status === 'collection' && elapsed > 25) {
        room.status = 'chase';
        io.to(roomId).emit('alert', { msg: "THE HUNT BEGINS!", color: "red" });
    }

    // 2. Wolf AI (Exact Replica of Single Player)
    if (room.status === 'chase') {
        room.wolves.forEach(wolf => {
            if (wolf.hp <= 0) return;

            // Find closest target (Player or Dog)
            let target = null;
            let minDist = 9999;

            for (const pid in room.players) {
                const p = room.players[pid];
                if (!p.alive) continue;

                // Check Player Distance
                const distP = Math.hypot(p.x - wolf.x, p.y - wolf.y);
                if (distP < minDist) { minDist = distP; target = p; }

                // Check Dog Distance
                p.companions.forEach(dog => {
                    const distD = Math.hypot(dog.x - wolf.x, dog.y - wolf.y);
                    if (distD < minDist) { minDist = distD; target = dog; }
                });
            }

            // Move and Attack
            if (target) {
                const angle = Math.atan2(target.y - wolf.y, target.x - wolf.x);
                wolf.x += Math.cos(angle) * WOLF_SPEED;
                wolf.y += Math.sin(angle) * WOLF_SPEED;

                // Hit Detection
                if (minDist < 35) {
                    const now = Date.now();
                    // Simple cooldown to prevent instant melting (optional, but good for multiplayer latency)
                    if (now > (wolf.nextAttack || 0)) {
                        wolf.nextAttack = now + 500;

                        if (target.username) {
                            // It's a Player
                            if (!target.invulnerable) {
                                target.hp -= wolf.dmg;
                                target.invulnerable = true;
                                setTimeout(() => { if (target) target.invulnerable = false; }, 1000);

                                if (target.hp <= 0) {
                                    target.hp = 0;
                                    target.alive = false;
                                    io.to(roomId).emit('alert', { msg: `${target.username} HAS FALLEN!`, color: "red" });
                                    checkGameOver(roomId);
                                }
                            }
                        } else {
                            // It's a Dog
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
    }

    // 3. Companion (Dog) AI
    for (const pid in room.players) {
        const p = room.players[pid];
        if (!p.alive) continue;
        p.companions.forEach(dog => {
            let targetWolf = null;
            let minDist = 9999;

            // Find closest wolf
            room.wolves.forEach(w => {
                if (w.hp <= 0) return;
                const dist = Math.hypot(w.x - dog.x, w.y - dog.y);
                if (dist < minDist) { minDist = dist; targetWolf = w; }
            });

            // Decide movement
            let moveTarget = p; // Default follow player
            if (targetWolf && room.status === 'chase') moveTarget = targetWolf; // Attack if chasing

            const angle = Math.atan2(moveTarget.y - dog.y, moveTarget.x - dog.x);
            const dist = Math.hypot(moveTarget.x - dog.x, moveTarget.y - dog.y);

            // Move if too far
            if ((moveTarget === p && dist > 60) || (moveTarget === targetWolf && dist > 35)) {
                dog.x += Math.cos(angle) * DOG_SPEED;
                dog.y += Math.sin(angle) * DOG_SPEED;
            }

            // Attack Wolf
            if (targetWolf && dist < 50) {
                const now = Date.now();
                if (now > dog.nextAttack) {
                    targetWolf.hp -= dog.dmg;
                    dog.nextAttack = now + 800;
                    if (targetWolf.hp <= 0) checkVictory(roomId);
                }
            }
        });
    }

    // 4. Send State to Clients
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
    // If all wolves dead
    if (!room.wolves.some(w => w.hp > 0)) {
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
    // If NO players are alive
    if (!Object.values(room.players).some(p => p.alive)) {
        room.status = 'over';
        io.to(roomId).emit('gameOver', { win: false, reason: "THE PACK CONSUMED ALL", days: room.level });
    }
}

// --- SOCKET LOGIC ---
io.on('connection', (socket) => {

    // Identity Verification
    socket.on('verifyIdentity', (data) => {
        const { username, password } = data;
        if (username && username.toLowerCase() === "beka_ei" && password !== "bereketisthebest") {
            socket.emit('authResult', { success: false, msg: "ACCESS DENIED" });
        } else {
            socket.emit('authResult', { success: true, msg: "VERIFIED" });
        }
    });

    // Hosting
    socket.on('hostGame', (data) => {
        const code = Math.floor(1000 + Math.random() * 9000).toString();
        socket.join(code);
        rooms[code] = createRoom(code);
        const name = data && data.username ? data.username : "Hunter";
        rooms[code].players[socket.id] = createPlayer(socket.id, name);
        socket.emit('roomCreated', code);
        io.to(code).emit('lobbyUpdate', getPlayerNames(rooms[code]));
    });

    // Joining
    socket.on('joinGame', (code, data) => {
        if (rooms[code] && rooms[code].status !== 'over') {
            socket.join(code);
            const name = data && data.username ? data.username : "Hunter";
            rooms[code].players[socket.id] = createPlayer(socket.id, name);
            socket.emit('joinSuccess', code);

            if (rooms[code].status !== 'lobby') {
                socket.emit('gameStarted'); // Late join
            } else {
                io.to(code).emit('lobbyUpdate', getPlayerNames(rooms[code]));
            }
        } else {
            socket.emit('joinFailed', 'Room not found');
        }
    });

    // Start Game
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

    // --- PLAYER INPUTS ---

    socket.on('playerMove', (data) => {
        const room = getRoom(socket);
        if (!room) return;
        const p = room.players[socket.id];
        if (p && p.alive) {
            // Update Position (Server Authority with lenient checks)
            p.x = Math.max(20, Math.min(MAP_SIZE - 20, p.x + data.dx * p.speed));
            p.y = Math.max(20, Math.min(MAP_SIZE - 20, p.y + data.dy * p.speed));
        }
    });

    socket.on('playerAction', (data) => {
        const room = getRoom(socket);
        if (!room) return;
        const p = room.players[socket.id];
        if (!p || !p.alive) return;

        // ATTACK
        if (data.type === 'attack') {
            io.to(room.id).emit('fx', { type: 'attack', x: p.x, y: p.y });
            room.wolves.forEach(w => {
                if (w.hp > 0 && Math.hypot(w.x - p.x, w.y - p.y) < 100) {
                    w.hp -= p.dmg;
                    if (w.hp <= 0) checkVictory(room.id);
                }
            });
        }
        // LOOT
        else if (data.type === 'loot') {
            room.chests.forEach(c => {
                if (!c.opened && Math.hypot(p.x - c.x, p.y - c.y) < 60) {
                    c.opened = true;
                    // Handle Trap Logic immediately
                    if (c.reward.type.includes('hp_loss') || c.reward.type.includes('curse') || c.reward.type.includes('hp_half')) {
                        if (c.reward.type === 'hp_loss') p.hp += c.reward.val;
                        else if (c.reward.type === 'hp_half') p.hp = Math.floor(p.hp * c.reward.val);
                        else if (c.reward.type === 'curse_dmg') p.dmg += c.reward.val;

                        socket.emit('alert', { msg: `TRAP: ${c.reward.name}!`, color: "red" });
                        if (p.hp <= 0) {
                            p.alive = false;
                            io.to(room.id).emit('alert', { msg: `${p.username} DIED TO A TRAP!`, color: "red" });
                            checkGameOver(room.id);
                        }
                    } else {
                        // Add to inventory
                        p.inventory.push(c.reward);
                        socket.emit('alert', { msg: "LOOT FOUND", color: "yellow" });
                    }
                }
            });
        }
        // USE ITEM
        else if (data.type === 'useItem') {
            const item = p.inventory[data.index];
            if (!item) return;

            if (item.type === 'revive') {
                // Check if there are actually dead players
                const deadPlayers = Object.values(room.players).filter(pl => !pl.alive);
                if (deadPlayers.length === 0) {
                    socket.emit('alert', { msg: "NO DEAD CREW MEMBERS", color: "orange" });
                } else {
                    // Send list of dead players to client to choose
                    socket.emit('openReviveModal', deadPlayers.map(pl => ({ id: pl.id, name: pl.username })));
                }
            } else {
                applyItemEffect(p, item);
                p.inventory.splice(data.index, 1);
            }
        }
        // CONFIRM REVIVE
        else if (data.type === 'confirmRevive') {
            const itemIdx = p.inventory.findIndex(i => i.type === 'revive');
            if (itemIdx === -1) return;

            const target = room.players[data.targetId];
            if (target && !target.alive) {
                p.inventory.splice(itemIdx, 1); // Consume item
                target.alive = true;
                target.hp = 50; // Revive with half HP
                target.x = p.x; // Spawn at reviver's location
                target.y = p.y;
                io.to(room.id).emit('alert', { msg: `${target.username} REVIVED BY ${p.username}!`, color: "#00ff00" });
            }
        }
    });

    // Admin
    socket.on('adminCmd', (data) => {
        const room = getRoom(socket);
        if (!room) return;
        const p = room.players[socket.id];
        if (data.action === 'spawnDogs') {
            for (let i = 0; i < data.val; i++) p.companions.push({ x: p.x, y: p.y, hp: 150, maxHp: 150, dmg: 20, nextAttack: 0 });
        }
        else if (data.action === 'killWolves') { room.wolves.forEach(w => w.hp = 0); checkVictory(room.id); }
        else if (data.action === 'setStats') { if (data.hp) p.hp = parseInt(data.hp); if (data.dmg) p.dmg = parseInt(data.dmg); if (data.speed) p.speed = parseInt(data.speed); }
    });

    // Disconnect
    socket.on('disconnect', () => {
        const roomCode = getRoomCode(socket);
        if (roomCode && rooms[roomCode]) {
            delete rooms[roomCode].players[socket.id];
            // If room empty, delete it
            setTimeout(() => {
                if (rooms[roomCode] && Object.keys(rooms[roomCode].players).length === 0) {
                    delete rooms[roomCode];
                }
            }, 1000);
        }
    });

    // Score Reporting (If Supabase configured)
    socket.on('reportScore', async (data) => {
        if (!supabase) return;
        try {
            await supabase.from('leaderboard').insert([{ username: data.username, days_survived: data.days }]);
        } catch (e) { console.log("DB Error", e); }
    });
});

// --- HELPERS ---

function getRoomCode(socket) { return Array.from(socket.rooms).filter(r => r !== socket.id)[0]; }
function getRoom(socket) { const c = getRoomCode(socket); return c ? rooms[c] : null; }
function getPlayerNames(room) { return Object.values(room.players).map(p => p.username); }
function createRoom(id) { return { id: id, players: {}, wolves: [], chests: [], status: 'lobby', timerStart: 0, level: 1 }; }

function createPlayer(id, name) {
    const hue = Math.floor(Math.random() * 360);
    return {
        id: id,
        username: name,
        color: `hsl(${hue}, 80%, 60%)`,
        x: 750, y: 750,
        hp: 100, maxHp: 100, dmg: 10, speed: PLAYER_SPEED,
        alive: true, invulnerable: false,
        inventory: [], companions: []
    };
}

function spawnEntities(room, level) {
    // Spawn Wolves
    room.wolves = [];
    const count = (level === 1) ? 1 : Math.min(level + 2, 50);
    for (let i = 0; i < count; i++) {
        room.wolves.push({
            id: i,
            x: Math.random() > 0.5 ? -100 : MAP_SIZE + 100,
            y: Math.random() * MAP_SIZE,
            hp: 80 + (level * 20),
            maxHp: 80 + (level * 20),
            dmg: 5 + level
        });
    }

    // Spawn Chests
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
    // 15 out of 50 chance for Revive = 30% (0.3)
    // We roll 0 to 1. If < 0.3, it's a revive.
    const rand = Math.random();

    if (rand < 0.30) {
        return { name: "Revive Totem", type: "revive", icon: "✝️" };
    }

    // Remaining 70% distributed among other items
    const subRand = Math.random() * 100;
    let badChance = Math.max(10, 50 - (level * 2));

    if (subRand < badChance) {
        // Trap / Curse
        return [
            { name: "Cursed Blade", type: "curse_dmg", val: -5, icon: "💀" },
            { name: "Blood Debt", type: "hp_half", val: 0.5, icon: "🩸" },
            { name: "Rotten Meat", type: "hp_loss", val: -25, icon: "🥩" }
        ][Math.floor(Math.random() * 3)];
    } else if (subRand < badChance + 15) {
        // Dog Potion
        return { name: "Summon Dog", type: "potion", icon: "🐕" };
    } else {
        // Good Item
        return [
            { name: "Steel Sword", type: "sword", val: 12, icon: "⚔️" },
            { name: "Health Kit", type: "hp", val: 40, icon: "🍷" },
            { name: "Plate Armor", type: "shield", val: 60, icon: "🛡️" }
        ][Math.floor(Math.random() * 3)];
    }
}

function applyItemEffect(p, item) {
    if (item.type === 'potion') p.companions.push({ x: p.x, y: p.y, hp: 120, maxHp: 120, dmg: 15, nextAttack: 0 });
    else if (item.type === 'hp') p.hp = Math.min(p.maxHp, p.hp + item.val);
    else if (item.type === 'shield') { p.maxHp += item.val; p.hp += item.val; }
    else if (item.type === 'sword') p.dmg += item.val;
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));