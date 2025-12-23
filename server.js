require('dotenv').config();
const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
const { createClient } = require('@supabase/supabase-js');

// --- DATABASE ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

app.use(express.static(__dirname));

// --- GAME CONSTANTS ---
const MAP_SIZE = 1500;
const WOLF_SPEED = 4.5;
const PLAYER_SPEED = 7;

// --- STATE ---
const rooms = {};
let worldRecord = { holder: 'None', days: 0 };

// --- HELPERS ---
async function addCoins(username, amount) {
    const { data } = await supabase.from('users').select('coins').eq('username', username).single();
    if (data) {
        await supabase.from('users').update({ coins: data.coins + amount }).eq('username', username);
    }
}

// --- GAME LOOP ---
setInterval(() => {
    for (const id in rooms) updateRoom(id);
}, 1000 / 30); // 30 TICKS/SEC

function updateRoom(id) {
    const room = rooms[id];
    if (!room || room.status === 'over') return;

    const now = Date.now();
    // TIMER LOGIC
    if (room.status === 'collection') {
        if (now - room.stateTimer > 25000) {
            room.status = 'chase';
            room.stateTimer = now;
            io.to(id).emit('alert', { msg: "THE BLOOD MOON RISES", color: "red", sound: 'howl' });
        }
    }

    // AI LOGIC (Simulate Wolves)
    if (room.status === 'chase') {
        room.wolves.forEach(w => {
            if (w.hp <= 0) return;
            // Find closest target
            let target = null, minDist = 9999;
            Object.values(room.players).forEach(p => {
                if (!p.alive) return;
                const d = Math.hypot(p.x - w.x, p.y - w.y);
                if (d < minDist) { minDist = d; target = p; }
            });

            if (target) {
                const ang = Math.atan2(target.y - w.y, target.x - w.x);
                w.x += Math.cos(ang) * w.speed;
                w.y += Math.sin(ang) * w.speed;

                // Attack
                if (minDist < 40 && now > w.nextAttack) {
                    w.nextAttack = now + 1000;
                    target.hp -= w.dmg;
                    io.to(id).emit('playerHit', { id: target.id, hp: target.hp });
                    if (target.hp <= 0) {
                        target.alive = false;
                        io.to(id).emit('playerDied', { name: target.username });
                        checkGameOver(id);
                    }
                }
            }
        });
    }

    // SEND SNAPSHOT (Optimized)
    io.to(id).emit('tick', {
        players: room.players,
        wolves: room.wolves.map(w => ({ id: w.id, x: Math.round(w.x), y: Math.round(w.y), hp: w.hp, type: w.type })),
        status: room.status,
        time: Math.max(0, 25 - Math.floor((now - room.stateTimer) / 1000))
    });
}

function checkGameOver(roomId) {
    const room = rooms[roomId];
    if (!Object.values(room.players).some(p => p.alive)) {
        room.status = 'over';
        io.to(roomId).emit('gameOver', { day: room.day });
    } else if (room.wolves.every(w => w.hp <= 0) && room.status === 'chase') {
        // Victory - Next Day
        room.day++;
        room.status = 'collection';
        room.stateTimer = Date.now();
        spawnEntities(room);
        Object.values(room.players).forEach(p => { if (p.alive) p.hp = Math.min(p.maxHp, p.hp + 20); });
        io.to(roomId).emit('nextDay', { day: room.day });
    }
}

// --- SOCKETS ---
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // 1. AUTH & LOGIN
    socket.on('login', async ({ username, password }) => {
        const { data, error } = await supabase.from('users').select('*').eq('username', username).single();
        if (data && data.password === password) {
            socket.emit('loginSuccess', { username: data.username, coins: data.coins, classes: data.classes_owned });
        } else {
            socket.emit('loginFail', 'Invalid credentials');
        }
    });

    socket.on('register', async ({ username, password }) => {
        const { error } = await supabase.from('users').insert([{ username, password }]);
        if (error) socket.emit('loginFail', 'Username taken');
        else socket.emit('registerSuccess');
    });

    // 2. SHOP
    socket.on('buyClass', async ({ username, className, cost }) => {
        const { data } = await supabase.from('users').select('*').eq('username', username).single();
        if (data.coins >= cost) {
            const newClasses = [...data.classes_owned, className];
            await supabase.from('users').update({ coins: data.coins - cost, classes_owned: newClasses }).eq('username', username);
            socket.emit('purchaseSuccess', { coins: data.coins - cost, classes: newClasses });
        }
    });

    // 3. GAME HOSTING/JOINING
    socket.on('host', ({ username, equippedClass }) => {
        const code = Math.floor(1000 + Math.random() * 9000).toString();
        rooms[code] = createRoom(code);
        joinRoom(socket, code, username, equippedClass);
    });

    socket.on('join', ({ code, username, equippedClass }) => {
        if (rooms[code]) joinRoom(socket, code, username, equippedClass);
        else socket.emit('error', 'Room not found');
    });

    // 4. PLAYER INPUT (Anti-Lag Logic)
    socket.on('move', (dir) => {
        const room = getRoom(socket);
        if (!room || !room.players[socket.id]) return;
        const p = room.players[socket.id];
        if (!p.alive) return;

        // Server-side movement validation
        p.x += dir.x * p.speed;
        p.y += dir.y * p.speed;
        // Clamp
        p.x = Math.max(0, Math.min(MAP_SIZE, p.x));
        p.y = Math.max(0, Math.min(MAP_SIZE, p.y));
    });

    socket.on('action', (act) => {
        const room = getRoom(socket);
        if (!room) return;
        const p = room.players[socket.id];

        if (act.type === 'attack') {
            room.wolves.forEach(w => {
                if (Math.hypot(w.x - p.x, w.y - p.y) < 100 && w.hp > 0) {
                    w.hp -= p.dmg;
                    // White Wolf Bonus
                    if (w.hp <= 0 && w.type === 'white') {
                        room.day += 50;
                        io.to(room.id).emit('alert', { msg: "WHITE WOLF SLAIN! +50 DAYS", color: "gold" });
                    }
                }
            });
            checkGameOver(room.id);
        }
    });

    // 5. GLOBAL ADMIN
    socket.on('adminCmd', async (data) => {
        if (data.username !== 'beka_ei') return; // SECURITY CHECK

        if (data.scope === 'global') {
            // Apply to ALL rooms or ALL DB users
            if (data.cmd === 'giveCoins') {
                // Give to everyone in DB? Or everyone online? Let's do everyone online for safety
                for (const rid in rooms) {
                    Object.values(rooms[rid].players).forEach(p => addCoins(p.username, data.val));
                }
                io.emit('alert', { msg: `ADMIN GIFT: ${data.val} COINS!`, color: 'gold' });
            } else if (data.cmd === 'globalMsg') {
                io.emit('chat', { user: 'ADMIN', text: data.val, color: 'red' });
            }
        } else {
            // Local Room Only
            const room = getRoom(socket);
            if (!room) return;

            if (data.cmd === 'killWolves') room.wolves.forEach(w => w.hp = 0);
            if (data.cmd === 'spawnWhiteWolf') {
                room.wolves.push({ id: 999, x: 750, y: 750, hp: 15000, maxHp: 15000, dmg: 1000, speed: 6, type: 'white', nextAttack: 0 });
                io.to(room.id).emit('alert', { msg: "LEGENDARY WHITE WOLF SPAWNED", color: "white" });
            }
            if (data.cmd === 'setDay') room.day = parseInt(data.val);
        }
    });

    // 6. VOICE CHAT SIGNALING
    socket.on('voice-join', (peerId) => {
        const room = getRoom(socket);
        if (room) socket.to(room.id).emit('user-connected', peerId);
    });

    socket.on('disconnect', () => {
        // Cleanup logic...
    });
});

function createRoom(id) {
    return { id, players: {}, wolves: [], status: 'collection', day: 1, stateTimer: Date.now() };
}

function joinRoom(socket, code, username, cls) {
    socket.join(code);
    const room = rooms[code];
    let hp = 100, dmg = 10;
    if (cls === 'medic') { hp = 150; } // Medic Class Perk
    if (cls === 'starter') { dmg = 15; } // Starter Class Perk

    room.players[socket.id] = {
        id: socket.id, username, x: 750, y: 750,
        hp, maxHp: hp, dmg, speed: PLAYER_SPEED, alive: true
    };
    socket.emit('joined', code);
    spawnEntities(room);
}

function spawnEntities(room) {
    room.wolves = [];
    const count = Math.min(room.day + 2, 40);
    for (let i = 0; i < count; i++) {
        room.wolves.push({
            id: i, x: Math.random() * MAP_SIZE, y: Math.random() * MAP_SIZE,
            hp: room.day * 50, maxHp: room.day * 50, dmg: 10 + room.day,
            speed: WOLF_SPEED, nextAttack: 0, type: 'normal'
        });
    }
}

function getRoom(socket) {
    const r = Array.from(socket.rooms).find(r => r !== socket.id);
    return rooms[r];
}

server.listen(process.env.PORT || 3000, () => console.log("Server Online"));