require('dotenv').config();
const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server, { cors: { origin: "*" } });
const { createClient } = require('@supabase/supabase-js');

// --- DATABASE & CONFIG ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ADMIN_PASS = process.env.ADMIN_PASSWORD;

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

// --- GAME CONSTANTS ---
const MAP_SIZE = 1500;
const TICK_RATE = 30;

// --- STATE ---
const rooms = {};
let worldRecord = { holder: 'Nobody', days: 0 };

// --- HELPERS ---
const getRoom = (id) => rooms[id];
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Fetch Record on Start
async function fetchWR() {
    const { data } = await supabase.from('leaderboard').select('*').order('days_survived', { ascending: false }).limit(1);
    if (data && data.length > 0) worldRecord = { holder: data[0].username, days: data[0].days_survived };
}
fetchWR();

// --- GAME LOOP ---
setInterval(() => {
    for (const rid in rooms) updateRoom(rooms[rid]);
}, 1000 / TICK_RATE);

function updateRoom(room) {
    if (room.status === 'over') return;

    // Timer Logic
    if (room.status === 'collection') {
        const elapsed = (Date.now() - room.timerStart) / 1000;
        if (elapsed > 25) {
            room.status = 'chase';
            io.to(room.id).emit('alert', { msg: "THE BLOOD MOON RISES", color: "red", sound: "howl" });
        }
    }

    // Wolf AI
    if (room.status === 'chase') {
        room.wolves.forEach(w => {
            if (w.hp <= 0) return;

            // White Wolf Logic (Admin Boss)
            const speed = w.isWhite ? 8 : 4.5;

            let target = null, minDist = 9999;
            // Find closest player or dog
            for (const pid in room.players) {
                const p = room.players[pid];
                if (!p.alive) continue;
                const d = dist(p, w);
                if (d < minDist) { minDist = d; target = p; }
                p.companions.forEach(dog => {
                    const dd = dist(dog, w);
                    if (dd < minDist) { minDist = dd; target = dog; }
                });
            }

            if (target) {
                const angle = Math.atan2(target.y - w.y, target.x - w.x);
                w.x += Math.cos(angle) * speed;
                w.y += Math.sin(angle) * speed;

                if (minDist < 40) {
                    if (Date.now() > w.nextAttack) {
                        w.nextAttack = Date.now() + 500;
                        target.hp -= w.dmg;
                        if (target.hp <= 0) {
                            target.alive = false;
                            if (target.username) { // It's a player
                                io.to(room.id).emit('playerDied', { id: target.id, name: target.username });
                                checkGameOver(room.id);
                            }
                        }
                    }
                }
            }
        });
    }

    // Send Update
    const pack = {
        players: room.players,
        wolves: room.wolves.map(w => ({ id: w.id, x: Math.round(w.x), y: Math.round(w.y), hp: w.hp, maxHp: w.maxHp, isWhite: w.isWhite })),
        chests: room.chests,
        day: room.level,
        status: room.status,
        timer: Math.max(0, 25 - Math.floor((Date.now() - room.timerStart) / 1000))
    };
    io.to(room.id).emit('state', pack);
}

// --- SOCKET HANDLING ---
io.on('connection', (socket) => {

    // 1. AUTH & SHOP
    socket.on('login', async ({ user, pass }) => {
        const { data, error } = await supabase.from('users').select('*').eq('username', user).eq('password', pass).single();
        if (data) socket.emit('authSuccess', { user: data.username, coins: data.coins, classes: data.unlocked_classes, isAdmin: user === 'beka_ei' });
        else socket.emit('authFail', "Invalid Credentials");
    });

    socket.on('register', async ({ user, pass }) => {
        const { error } = await supabase.from('users').insert([{ username: user, password: pass }]);
        if (!error) socket.emit('regSuccess');
        else socket.emit('authFail', "Username taken");
    });

    socket.on('buyClass', async ({ user, className, cost }) => {
        const { data } = await supabase.from('users').select('*').eq('username', user).single();
        if (data && data.coins >= cost && !data.unlocked_classes.includes(className)) {
            const newClasses = [...data.unlocked_classes, className];
            const newCoins = data.coins - cost;
            await supabase.from('users').update({ coins: newCoins, unlocked_classes: newClasses }).eq('username', user);
            socket.emit('updateUserData', { coins: newCoins, classes: newClasses });
        }
    });

    // 2. MULTIPLAYER LOBBY
    socket.on('host', ({ user, selectedClass }) => {
        const code = Math.floor(1000 + Math.random() * 9000).toString();
        rooms[code] = createRoom(code);
        joinRoom(socket, code, user, selectedClass);
        socket.emit('roomCode', code);
    });

    socket.on('join', ({ code, user, selectedClass }) => {
        if (rooms[code]) joinRoom(socket, code, user, selectedClass);
        else socket.emit('error', "Room not found");
    });

    socket.on('startMatch', () => {
        const room = getRoomFromSocket(socket);
        if (room) {
            room.status = 'collection';
            room.timerStart = Date.now();
            spawnEntities(room);
            io.to(room.id).emit('gameStart');
        }
    });

    // 3. GAME INPUTS (Fixing Rubberband)
    socket.on('move', ({ dx, dy }) => {
        const room = getRoomFromSocket(socket);
        if (!room) return;
        const p = room.players[socket.id];
        if (p && p.alive) {
            p.x = Math.max(20, Math.min(MAP_SIZE - 20, p.x + dx * p.speed));
            p.y = Math.max(20, Math.min(MAP_SIZE - 20, p.y + dy * p.speed));
        }
    });

    socket.on('action', ({ type, index }) => {
        const room = getRoomFromSocket(socket);
        if (!room) return;
        const p = room.players[socket.id];
        if (!p || !p.alive) return;

        if (type === 'attack') {
            io.to(room.id).emit('fx', { type: 'slash', x: p.x, y: p.y });
            room.wolves.forEach(w => {
                if (w.hp > 0 && dist(p, w) < 100) {
                    w.hp -= p.dmg;
                    if (w.hp <= 0) checkLevelClear(room);
                }
            });
        }
        else if (type === 'loot') {
            room.chests.forEach(c => {
                if (!c.opened && dist(p, c) < 60) {
                    c.opened = true;
                    if (c.content.type === 'coin') {
                        // Give coins to ALL players in room? No, just looter.
                        // Actually let's award immediate coin to database
                        updateUserCoins(p.username, 1);
                        socket.emit('alert', { msg: "+1 FERAL COIN", color: "gold" });
                    } else {
                        p.inventory.push(c.content);
                        socket.emit('alert', { msg: `FOUND: ${c.content.name}`, color: "#00ff00" });
                    }
                }
            });
        }
        else if (type === 'use' && p.inventory[index]) {
            applyItem(p, p.inventory[index]);
            p.inventory.splice(index, 1);
        }
    });

    // 4. VOICE CHAT
    socket.on('voice', (blob) => {
        const room = getRoomFromSocket(socket);
        if (room) socket.to(room.id).emit('voiceRelay', blob);
    });

    // 5. ADMIN PANELS
    socket.on('admin', (data) => {
        const { cmd, val, scope, targetUser } = data;

        // Scope: 'local' (current room) or 'global' (all rooms)
        const targetRooms = scope === 'global' ? Object.values(rooms) : [getRoomFromSocket(socket)];

        targetRooms.forEach(r => {
            if (!r) return;

            if (cmd === 'killWolves') {
                r.wolves.forEach(w => w.hp = 0);
                checkLevelClear(r);
                io.to(r.id).emit('alert', { msg: "ADMIN: WOLVES CLEARED", color: "lime" });
            }
            if (cmd === 'setDay') { r.level = parseInt(val); spawnEntities(r); }
            if (cmd === 'spawnWhiteWolf') {
                r.wolves.push({ id: 999, x: 750, y: 750, hp: 15000, maxHp: 15000, dmg: 1000, isWhite: true, nextAttack: 0 });
                io.to(r.id).emit('alert', { msg: "WARNING: THE WHITE DEATH HAS SPAWNED", color: "white", sound: "creepy" });
            }
            if (cmd === 'giveCoins') {
                // Database update
                Object.values(r.players).forEach(p => updateUserCoins(p.username, parseInt(val)));
                io.to(r.id).emit('alert', { msg: `ADMIN GIFT: ${val} COINS`, color: "gold" });
            }
        });

        if (scope === 'global' && cmd === 'chat') {
            io.emit('chatMsg', { user: 'ADMIN[GLOBAL]', text: val, color: 'red' });
        }
    });

    // Reset Record Command (Run once via console or admin)
    socket.on('resetWR', async () => {
        await supabase.from('leaderboard').delete().neq('days_survived', -1); // Clear all
        worldRecord = { holder: 'Nobody', days: 0 };
        io.emit('wrUpdate', worldRecord);
    });

    socket.on('disconnect', () => {
        // Cleanup room logic
    });
});

// --- LOGIC HELPERS ---
function createRoom(id) {
    return { id, players: {}, wolves: [], chests: [], status: 'lobby', level: 1, timerStart: 0 };
}

function joinRoom(socket, code, user, cls) {
    socket.join(code);
    const p = {
        id: socket.id, username: user, x: 750, y: 750,
        hp: 100, maxHp: 100, dmg: 10, speed: 7,
        alive: true, inventory: [], companions: [], class: cls
    };

    // Class Bonuses
    if (cls === 'starter') p.dmg += 5;
    if (cls === 'medic') p.inventory.push({ name: 'Medkit', type: 'hp', val: 50 });

    rooms[code].players[socket.id] = p;
}

function spawnEntities(room) {
    room.wolves = [];
    const count = room.level + 2;
    for (let i = 0; i < count; i++) {
        room.wolves.push({
            id: i, x: Math.random() * MAP_SIZE, y: Math.random() * MAP_SIZE,
            hp: 80 * room.level, maxHp: 80 * room.level, dmg: 10 * room.level,
            nextAttack: 0
        });
    }
    // Chests
    room.chests = [];
    for (let i = 0; i < 10; i++) {
        room.chests.push({
            x: Math.random() * MAP_SIZE, y: Math.random() * MAP_SIZE,
            opened: false,
            content: Math.random() < 0.2 ? { type: 'coin' } : { name: 'Potion', type: 'hp', val: 30 }
        });
    }
}

function checkLevelClear(room) {
    if (room.wolves.every(w => w.hp <= 0)) {
        room.level++;
        room.status = 'collection';
        room.timerStart = Date.now();
        // Heal Players
        Object.values(room.players).forEach(p => { if (p.alive) p.hp = p.maxHp; });
        spawnEntities(room);
        io.to(room.id).emit('alert', { msg: `NIGHT SURVIVED. DAY ${room.level}`, color: "cyan" });

        // Record Check
        if (room.level > worldRecord.days) {
            worldRecord.days = room.level;
            io.emit('wrUpdate', worldRecord);
            // Save to DB
            // We only know the "room" record, not specific user here, simplified for brevity
        }
    }
}

function checkGameOver(roomId) {
    const room = rooms[roomId];
    if (Object.values(room.players).every(p => !p.alive)) {
        room.status = 'over';
        io.to(roomId).emit('gameOver', { day: room.level });
    }
}

async function updateUserCoins(user, amount) {
    const { data } = await supabase.from('users').select('coins').eq('username', user).single();
    if (data) {
        await supabase.from('users').update({ coins: data.coins + amount }).eq('username', user);
    }
}

server.listen(process.env.PORT || 8080, () => console.log("Feral Server Online"));