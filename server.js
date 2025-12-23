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
    } catch (err) { console.log("Supabase connection failed:", err.message); }
}

app.use(express.static(__dirname));
app.get('/', (req, res) => { res.sendFile(__dirname + '/gameintro.html'); });

// Game Constants
const MAP_SIZE = 1500;
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

// --- GAME LOOP ---
setInterval(() => {
    for (const roomId in rooms) {
        updateRoom(roomId);
    }
}, 1000 / 30);

function updateRoom(roomId) {
    const room = rooms[roomId];
    if (!room || room.status === 'lobby' || room.status === 'over') return;

    const elapsed = (Date.now() - room.timerStart) / 1000;

    // Phase Switch
    if (room.status === 'collection' && elapsed > 25) {
        room.status = 'chase';
        io.to(roomId).emit('alert', { msg: "THE HUNT BEGINS!", color: "red", sound: 'wolf_growl' });
        io.to(roomId).emit('phaseChange', 'chase');
    }

    // Wolf Logic
    if (room.status === 'chase') {
        room.wolves.forEach(wolf => {
            if (wolf.hp <= 0) return;

            // Target Finding
            let target = null;
            let minDist = 9999;
            const entities = [...Object.values(room.players).filter(p => p.alive)];

            // Add dogs to targets
            Object.values(room.players).forEach(p => {
                p.companions.forEach(d => entities.push(d));
            });

            entities.forEach(ent => {
                const d = Math.hypot(ent.x - wolf.x, ent.y - wolf.y);
                if (d < minDist) { minDist = d; target = ent; }
            });

            if (target) {
                const angle = Math.atan2(target.y - wolf.y, target.x - wolf.x);
                // Boss is slower but hits harder
                const speed = wolf.isBoss ? 5.5 : 4.5;
                wolf.x += Math.cos(angle) * speed;
                wolf.y += Math.sin(angle) * speed;

                if (minDist < 40) {
                    const now = Date.now();
                    if (now > (wolf.nextAttack || 0)) {
                        wolf.nextAttack = now + 500;
                        if (target.username) { // It's a player
                            if (!target.invulnerable) {
                                target.hp -= wolf.dmg;
                                target.invulnerable = true;
                                setTimeout(() => { if (target) target.invulnerable = false; }, 1000);
                                if (target.hp <= 0) {
                                    target.hp = 0; target.alive = false;
                                    io.to(roomId).emit('playerDied', { id: target.id, name: target.username });
                                    checkGameOver(roomId);
                                }
                            }
                        } else { // It's a dog
                            target.hp -= wolf.dmg;
                        }
                    }
                }
            }
        });
    }

    // Send Update
    io.to(roomId).emit('gameStateUpdate', {
        players: room.players,
        wolves: room.wolves, // Now includes type/boss info
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
        // Check if boss was killed for bonus
        const boss = room.wolves.find(w => w.isBoss);
        let bonusDays = 0;

        // Logic: If boss existed and is dead, give rewards
        if (boss && boss.hp <= 0) {
            bonusDays = 50;
            io.to(roomId).emit('alert', { msg: "WHITE WOLF DEFEATED! +50 DAYS", color: "gold" });
            io.to(roomId).emit('bossDefeated', { coins: 20 });
        }

        room.level += (1 + bonusDays);
        room.status = 'collection';
        room.timerStart = Date.now();

        // Heal Players
        for (const pid in room.players) {
            if (room.players[pid].alive) room.players[pid].hp = Math.min(room.players[pid].maxHp, room.players[pid].hp + 20);
        }

        spawnEntities(room, room.level);
        io.to(roomId).emit('alert', { msg: `VICTORY! DAY ${room.level} STARTED`, color: "#00bfff", sound: 'scary_theme' });
        io.to(roomId).emit('phaseChange', 'collection');
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
    socket.on('getLeaderboard', () => { socket.emit('leaderboardData', currentWorldRecord); });

    socket.on('verifyIdentity', (data) => {
        const isAdmin = data.username && data.username.toLowerCase() === "beka_ei" && data.password === "bereketisthebest";
        if (data.username && data.username.toLowerCase() === "beka_ei" && !isAdmin) {
            socket.emit('authResult', { success: false, msg: "ACCESS DENIED" });
        } else {
            socket.emit('authResult', { success: true, msg: "VERIFIED", isAdmin: isAdmin });
        }
    });

    socket.on('hostGame', (data) => {
        const code = Math.floor(1000 + Math.random() * 9000).toString();
        socket.join(code);
        rooms[code] = createRoom(code);
        rooms[code].players[socket.id] = createPlayer(socket.id, data.username || "Hunter");
        // Store admin status in player object for safety
        if (data.username === 'beka_ei') rooms[code].players[socket.id].isAdmin = true;

        socket.emit('roomCreated', code);
        io.to(code).emit('lobbyUpdate', getPlayerNames(rooms[code]));
    });

    socket.on('joinGame', (code, data) => {
        if (rooms[code] && rooms[code].status !== 'over') {
            socket.join(code);
            rooms[code].players[socket.id] = createPlayer(socket.id, data.username || "Hunter");
            if (data.username === 'beka_ei') rooms[code].players[socket.id].isAdmin = true;

            socket.emit('joinSuccess', code);
            if (rooms[code].status !== 'lobby') socket.emit('gameStarted');
            else io.to(code).emit('lobbyUpdate', getPlayerNames(rooms[code]));
        } else socket.emit('joinFailed', 'Room not found');
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

    socket.on('playerAction', (data) => {
        const room = getRoom(socket);
        if (!room) return;
        const p = room.players[socket.id];
        if (!p || !p.alive) return;

        if (data.type === 'attack') {
            io.to(room.id).emit('fx', { type: 'attack', x: p.x, y: p.y });
            room.wolves.forEach(w => {
                if (w.hp > 0 && Math.hypot(w.x - p.x, w.y - p.y) < 100) {
                    w.hp -= p.dmg;
                    if (w.hp <= 0) checkVictory(room.id);
                }
            });
        } else if (data.type === 'loot') {
            room.chests.forEach(c => {
                if (!c.opened && Math.hypot(p.x - c.x, p.y - c.y) < LOOT_RADIUS) {
                    c.opened = true;
                    if (c.reward.type === 'hp_loss' || c.reward.type === 'curse_dmg' || c.reward.type === 'hp_half') {
                        socket.emit('alert', { msg: `TRAP: ${c.reward.name}!`, color: "red" });
                        if (c.reward.type === 'hp_loss') p.hp += c.reward.val;
                        if (c.reward.type === 'curse_dmg') p.dmg += c.reward.val;
                        if (c.reward.type === 'hp_half') p.hp = Math.floor(p.hp * 0.5);
                        if (p.hp <= 0) { p.alive = false; checkGameOver(room.id); }
                    } else {
                        p.inventory.push(c.reward);
                        socket.emit('alert', { msg: "LOOT FOUND", color: "yellow" });
                    }
                }
            });
        } else if (data.type === 'useItem') {
            const item = p.inventory[data.index];
            if (item) {
                if (item.type !== 'revive') {
                    applyItemEffect(p, item, room.level);
                    p.inventory.splice(data.index, 1);
                }
            }
        }
    });

    // --- SECURE ADMIN COMMANDS ---
    socket.on('adminCmd', (data) => {
        const room = getRoom(socket);
        if (!room) return;
        const p = room.players[socket.id];

        // Security Check: Only beka_ei is admin
        if (!p || !p.isAdmin) return;

        if (data.action === 'spawnDogs') for (let i = 0; i < data.val; i++) p.companions.push(createDog(p.x, p.y, room.level));
        else if (data.action === 'killWolves') { room.wolves.forEach(w => w.hp = 0); checkVictory(room.id); }
        else if (data.action === 'setStats') { if (data.hp) p.hp = parseInt(data.hp); if (data.dmg) p.dmg = parseInt(data.dmg); if (data.speed) p.speed = parseInt(data.speed); }
        else if (data.action === 'setDay') { room.level = parseInt(data.val); spawnEntities(room, room.level); io.to(room.id).emit('alert', { msg: `ADMIN: WARP TO DAY ${data.val}`, color: 'violet' }); }
        else if (data.action === 'getStuff') {
            p.inventory.push({ name: "Admin Sword", type: "sword", val: 100, icon: "⚔️" });
            p.inventory.push({ name: "God Elixir", type: "hp", val: 999, icon: "🍷" });
            socket.emit('alert', { msg: "ADMIN ITEMS GRANTED", color: "lime" });
        }
        else if (data.action === 'spawnWhiteWolf') {
            // Boss Logic: 10k HP, 100 DMG
            room.wolves.push({
                id: 9999,
                x: MAP_SIZE / 2, y: MAP_SIZE / 2,
                hp: 10000, maxHp: 10000, dmg: 100,
                nextAttack: 0, isBoss: true
            });
            io.to(room.id).emit('alert', { msg: "⚠️ THE WHITE WOLF HAS AWOKEN ⚠️", color: "#fff", sound: 'scary_theme' });
            io.to(room.id).emit('bossSpawned', { maxHp: 10000 });
        }
    });

    // --- GLOBAL ADMIN (Affects ALL Rooms) ---
    socket.on('globalAdminCmd', (data) => {
        // Verify user again purely by username stored in socket metadata is tricky, 
        // but since we checked on join, we check the player object in their current room
        const myRoom = getRoom(socket);
        if (!myRoom || !myRoom.players[socket.id]?.isAdmin) return;

        if (data.action === 'globalChat') {
            io.emit('alert', { msg: `[GLOBAL ADMIN]: ${data.val}`, color: "cyan" });
        } else if (data.action === 'globalKill') {
            Object.values(rooms).forEach(r => {
                r.wolves.forEach(w => w.hp = 0);
                checkVictory(r.id);
            });
            io.emit('alert', { msg: "ADMIN CLEARED ALL WOLVES GLOBALLY", color: "red" });
        }
    });

    socket.on('disconnect', () => {
        const roomCode = getRoomCode(socket);
        if (roomCode && rooms[roomCode]) {
            delete rooms[roomCode].players[socket.id];
            setTimeout(() => { if (rooms[roomCode] && Object.keys(rooms[roomCode].players).length === 0) delete rooms[roomCode]; }, 1000);
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
    return { id: id, username: name, color: `hsl(${hue}, 80%, 60%)`, x: 750, y: 750, hp: 100, maxHp: 100, dmg: 10, speed: PLAYER_SPEED, alive: true, invulnerable: false, inventory: [], companions: [], isAdmin: false };
}
function createDog(x, y, level) { return { x: x, y: y, hp: 150 + (level * 20), maxHp: 150 + (level * 20), dmg: 15 + (level * 2), nextAttack: 0 }; }

function spawnEntities(room, level) {
    room.wolves = [];
    const count = (level === 1) ? 1 : Math.min(level + 1, 50);
    for (let i = 0; i < count; i++) {
        room.wolves.push({
            id: i,
            x: Math.random() > 0.5 ? -100 : MAP_SIZE + 100,
            y: Math.random() * MAP_SIZE,
            hp: level * 80 + 50, maxHp: level * 80 + 50, dmg: level * 5 + 5, nextAttack: 0, isBoss: false
        });
    }
    room.chests = [];
    for (let i = 0; i < 12; i++) {
        room.chests.push({ x: Math.random() * (MAP_SIZE - 100) + 50, y: Math.random() * (MAP_SIZE - 100) + 50, opened: false, reward: generateReward(level) });
    }
}

function generateReward(level) {
    const rand = Math.random() * 100;
    if (Math.random() < 0.05) return { name: "Revive Totem", type: "revive", icon: "✝️" };
    let badChance = Math.max(10, 50 - (level * 2));
    if (rand < badChance) return [{ name: "Cursed Blade", type: "curse_dmg", val: -5, icon: "💀" }, { name: "Blood Debt", type: "hp_half", val: 0.5, icon: "🩸" }, { name: "Rotten Meat", type: "hp_loss", val: -25, icon: "🥩" }][Math.floor(Math.random() * 3)];
    else if (rand < badChance + 15) return { name: "Summon Dog", type: "potion", icon: "🐕" };
    else return [{ name: "Steel Sword", type: "sword", val: 12, icon: "⚔️" }, { name: "Health Kit", type: "hp", val: 40, icon: "🍷" }, { name: "Plate Armor", type: "shield", val: 60, icon: "🛡️" }][Math.floor(Math.random() * 3)];
}

function applyItemEffect(p, item, level) {
    if (item.type === 'potion') p.companions.push(createDog(p.x, p.y, level));
    else if (item.type === 'hp') p.hp = Math.min(p.maxHp, p.hp + item.val);
    else if (item.type === 'shield') { p.maxHp += item.val; p.hp += item.val; }
    else if (item.type === 'sword') p.dmg += item.val;
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));