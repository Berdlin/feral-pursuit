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
    } catch (err) { console.log("Supabase failed:", err.message); }
}

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(__dirname + '/gameintro.html'));

const MAP_SIZE = 1500;
const WOLF_SPEED = 5.0;
const DOG_SPEED = 6.0;
const PLAYER_SPEED = 7;
const LOOT_RADIUS = 80;

const rooms = {};
let currentWorldRecord = { holder: 'Nobody', days: 0 };

async function fetchWorldRecord() {
    if (!supabase) return;
    const { data } = await supabase.from('leaderboard').select('*').order('days_survived', { ascending: false }).limit(1).single();
    if (data) currentWorldRecord = { holder: data.username, days: data.days_survived };
}
fetchWorldRecord();

io.on('connection', (socket) => {
    socket.on('getLeaderboard', () => socket.emit('leaderboardData', currentWorldRecord));

    socket.on('verifyIdentity', (data) => {
        // --- ADMIN SECURITY CHECK ---
        const ADMIN_USER = "bereketisthebest"; // The new username
        // In a real app, use process.env.ADMIN_PASSWORD. For now, we hardcode to match your request.
        const ADMIN_PASS = process.env.ADMIN_PASSWORD || "your_secret_password";

        if (data.username && data.username.toLowerCase() === ADMIN_USER) {
            if (data.password === ADMIN_PASS) socket.emit('authResult', { success: true, msg: "ADMIN VERIFIED" });
            else socket.emit('authResult', { success: false, msg: "WRONG PASSWORD" });
        } else {
            socket.emit('authResult', { success: true, msg: "VERIFIED" });
        }
    });

    socket.on('hostGame', (data) => {
        const code = Math.floor(1000 + Math.random() * 9000).toString();
        socket.join(code);
        const safeName = (data.username || "Hunter").replace(/[<>]/g, "");
        rooms[code] = createRoom(code);
        rooms[code].players[socket.id] = createPlayer(socket.id, safeName);
        socket.emit('roomCreated', code);
        io.to(code).emit('lobbyUpdate', getPlayerNames(rooms[code]));
    });

    socket.on('joinGame', (code, data) => {
        if (rooms[code] && rooms[code].status !== 'over') {
            socket.join(code);
            const safeName = (data.username || "Hunter").replace(/[<>]/g, "");
            rooms[code].players[socket.id] = createPlayer(socket.id, safeName);
            socket.emit('joinSuccess', code);
            if (rooms[code].status !== 'lobby') socket.emit('gameStarted');
            else io.to(code).emit('lobbyUpdate', getPlayerNames(rooms[code]));
        } else {
            socket.emit('joinFailed', 'Room not found');
        }
    });

    socket.on('startGame', () => {
        const r = getRoom(socket);
        if (r && r.status === 'lobby') {
            r.status = 'collection'; r.timerStart = Date.now();
            spawnEntities(r, 1);
            io.to(r.id).emit('gameStarted');
            io.to(r.id).emit('alert', { msg: "DAY 1 START", color: "white" });
        }
    });

    socket.on('sendChat', (msg) => {
        const r = getRoom(socket);
        if (r) {
            const p = r.players[socket.id];
            if (p && typeof msg === 'string') {
                const clean = msg.substring(0, 100).replace(/</g, "&lt;").replace(/>/g, "&gt;");
                io.to(r.id).emit('chatMsg', { user: p.username, text: clean, color: p.color });
            }
        }
    });

    socket.on('playerMove', (data) => {
        const r = getRoom(socket);
        if (!r) return;
        const p = r.players[socket.id];
        if (p && p.alive) {
            // Simple validation
            let len = Math.hypot(data.dx, data.dy);
            if (len > 1.1) { data.dx /= len; data.dy /= len; } // Normalize
            p.x = Math.max(20, Math.min(MAP_SIZE - 20, p.x + (data.dx * p.speed)));
            p.y = Math.max(20, Math.min(MAP_SIZE - 20, p.y + (data.dy * p.speed)));
        }
    });

    socket.on('playerAction', (data) => {
        const r = getRoom(socket); if (!r) return;
        const p = r.players[socket.id]; if (!p) return;

        if (data.type === 'attack' && p.alive) {
            io.to(r.id).emit('fx', { type: 'attack', x: p.x, y: p.y });
            r.wolves.forEach(w => {
                if (w.hp > 0 && Math.hypot(w.x - p.x, w.y - p.y) < 140) {
                    w.hp -= p.dmg; if (w.hp <= 0) checkVictory(r.id);
                }
            });
        }
        else if (data.type === 'loot' && p.alive) {
            r.chests.forEach(c => {
                if (!c.opened && Math.hypot(p.x - c.x, p.y - c.y) < LOOT_RADIUS) {
                    c.opened = true;
                    if (c.reward.type.includes('curse') || c.reward.type.includes('hp_loss')) {
                        if (c.reward.type === 'hp_loss') p.hp += c.reward.val;
                        else if (c.reward.type === 'hp_half') p.hp = Math.floor(p.hp * c.reward.val);
                        else if (c.reward.type === 'curse_dmg') p.dmg = Math.max(1, p.dmg + c.reward.val);
                        socket.emit('alert', { msg: `TRAP: ${c.reward.name}`, color: "red" });
                        if (p.hp <= 0) handleDeath(r, p);
                    } else {
                        p.inventory.push(c.reward);
                        socket.emit('alert', { msg: "LOOT FOUND", color: "yellow" });
                    }
                }
            });
        }
        else if (data.type === 'useItem') {
            const item = p.inventory[data.index];
            if (!item) return;
            if (item.type === 'revive') {
                const dead = Object.values(r.players).filter(pl => !pl.alive && pl.id !== p.id);
                if (!p.alive) { p.alive = true; p.hp = 50; p.inventory.splice(data.index, 1); socket.emit('youRevived'); }
                else if (dead.length > 0) socket.emit('openReviveModal', dead.map(pl => ({ id: pl.id, name: pl.username })));
                else socket.emit('alert', { msg: "NO DEAD ALLIES", color: "orange" });
            } else if (p.alive) {
                applyItemEffect(p, item, r.level); p.inventory.splice(data.index, 1);
            }
        }
        else if (data.type === 'confirmRevive') {
            const itemIdx = p.inventory.findIndex(i => i.type === 'revive');
            const target = r.players[data.targetId];
            if (itemIdx > -1 && target && !target.alive) {
                p.inventory.splice(itemIdx, 1);
                target.alive = true; target.hp = 50; target.x = p.x; target.y = p.y;
                io.to(target.id).emit('youRevived');
                io.to(r.id).emit('alert', { msg: `${target.username} REVIVED`, color: "#00ff00" });
            }
        }
    });

    socket.on('adminCmd', (data) => {
        const r = getRoom(socket); if (!r) return;
        const p = r.players[socket.id];
        // Only allow if username is correct (Basic check)
        if (p.username.toLowerCase() !== "bereketisthebest") return;

        if (data.action === 'spawnDogs') for (let i = 0; i < data.val; i++) p.companions.push({ x: p.x, y: p.y, hp: 200, maxHp: 200, dmg: 20, nextAttack: 0 });
        if (data.action === 'killWolves') { r.wolves.forEach(w => w.hp = 0); checkVictory(r.id); }
        if (data.action === 'setStats') { if (data.hp) p.hp = parseInt(data.hp); if (data.dmg) p.dmg = parseInt(data.dmg); if (data.speed) p.speed = parseInt(data.speed); }
    });

    socket.on('disconnect', () => {
        const r = getRoom(socket);
        if (r) {
            delete r.players[socket.id];
            setTimeout(() => { if (r && Object.keys(r.players).length === 0) delete rooms[r.id]; }, 1000);
        }
    });

    socket.on('reportScore', async (data) => {
        if (!supabase) return;
        await supabase.from('leaderboard').insert([{ username: data.username, days_survived: data.days }]);
        if (data.days > currentWorldRecord.days) {
            currentWorldRecord = { holder: data.username, days: data.days };
            io.emit('recordBroken', currentWorldRecord);
        }
    });
});

// GAME LOOP
setInterval(() => {
    for (const rid in rooms) updateRoom(rooms[rid]);
}, 1000 / 30);

function updateRoom(r) {
    if (r.status === 'lobby' || r.status === 'over') return;
    const elapsed = (Date.now() - r.timerStart) / 1000;

    if (r.status === 'collection' && elapsed > 25) {
        r.status = 'chase'; io.to(r.id).emit('alert', { msg: "BLOOD MOON RISES", color: "red" });
    }

    if (r.status === 'chase') {
        r.wolves.forEach(w => {
            if (w.hp <= 0) return;
            // Target logic
            let target = null, minDist = 9999;
            for (const pid in r.players) {
                const p = r.players[pid];
                if (p.alive) {
                    let d = Math.hypot(p.x - w.x, p.y - w.y);
                    if (d < minDist) { minDist = d; target = p; }
                    p.companions.forEach(dog => {
                        let dd = Math.hypot(dog.x - w.x, dog.y - w.y);
                        if (dd < minDist) { minDist = dd; target = dog; }
                    });
                }
            }
            if (target) {
                const ang = Math.atan2(target.y - w.y, target.x - w.x);
                w.x += Math.cos(ang) * WOLF_SPEED; w.y += Math.sin(ang) * WOLF_SPEED;
                if (minDist < 50 && Date.now() > w.nextAttack) {
                    w.nextAttack = Date.now() + 500;
                    target.hp -= w.dmg;
                    io.to(r.id).emit('fx', { type: 'blood', x: target.x, y: target.y });
                    if (target.username && target.hp <= 0) handleDeath(r, target);
                }
            }
        });
    }

    // Companion Logic
    for (const pid in r.players) {
        const p = r.players[pid];
        if (!p.alive) continue;
        p.companions.forEach(dog => {
            let targetW = null, minDist = 9999;
            r.wolves.forEach(w => {
                if (w.hp > 0) {
                    let d = Math.hypot(w.x - dog.x, w.y - dog.y);
                    if (d < minDist) { minDist = d; targetW = w; }
                }
            });
            let moveT = targetW && r.status === 'chase' ? targetW : p;
            let dToT = Math.hypot(moveT.x - dog.x, moveT.y - dog.y);
            if (dToT > (moveT === p ? 60 : 35)) {
                let ang = Math.atan2(moveT.y - dog.y, moveT.x - dog.x);
                dog.x += Math.cos(ang) * DOG_SPEED; dog.y += Math.sin(ang) * DOG_SPEED;
            }
            if (targetW && dToT < 60 && Date.now() > dog.nextAttack) {
                targetW.hp -= dog.dmg; dog.nextAttack = Date.now() + 800;
                if (targetW.hp <= 0) checkVictory(r.id);
            }
        });
    }

    io.to(r.id).emit('gameStateUpdate', {
        players: r.players, wolves: r.wolves, chests: r.chests,
        status: r.status, day: r.level, bloodMoon: r.status === 'chase',
        timer: Math.max(0, 25 - Math.floor(elapsed))
    });
}

function handleDeath(r, p) {
    p.alive = false; p.hp = 0;
    io.to(r.id).emit('playerDied', { id: p.id, name: p.username });
    if (!Object.values(r.players).some(pl => pl.alive)) {
        r.status = 'over';
        io.to(r.id).emit('gameOver', { win: false, reason: "SLAUGHTERED", days: r.level });
    }
}

function checkVictory(rid) {
    const r = rooms[rid];
    if (r.wolves.every(w => w.hp <= 0)) {
        r.level++; r.status = 'collection'; r.timerStart = Date.now();
        spawnEntities(r, r.level);
        io.to(rid).emit('alert', { msg: `DAY ${r.level} BEGINS`, color: "#00bfff" });
    }
}

function getRoom(socket) { const id = Array.from(socket.rooms).filter(r => r !== socket.id)[0]; return id ? rooms[id] : null; }
function getPlayerNames(r) { return Object.values(r.players).map(p => p.username); }
function createRoom(id) { return { id: id, players: {}, wolves: [], chests: [], status: 'lobby', timerStart: 0, level: 1 }; }
function createPlayer(id, name) {
    return { id: id, username: name, color: `hsl(${Math.random() * 360},80%,60%)`, x: 750, y: 750, hp: 100, maxHp: 100, dmg: 10, speed: PLAYER_SPEED, alive: true, inventory: [], companions: [] };
}
function spawnEntities(r, lvl) {
    r.wolves = []; r.chests = [];
    const wCount = lvl === 1 ? 1 : Math.min(lvl + 1, 50);
    for (let i = 0; i < wCount; i++) r.wolves.push({ id: i, x: Math.random() > 0.5 ? -100 : 1600, y: Math.random() * 1500, hp: lvl * 80 + 50, maxHp: lvl * 80 + 50, dmg: lvl * 5 + 5, nextAttack: 0 });
    for (let i = 0; i < 12; i++) r.chests.push({ x: Math.random() * 1400 + 50, y: Math.random() * 1400 + 50, opened: false, reward: generateReward(lvl) });
}
function generateReward(lvl) {
    if (Math.random() < 0.05) return { name: "Totem", type: "revive", icon: "✝️" };
    const r = Math.random() * 100;
    if (r < Math.max(10, 50 - (lvl * 2))) return { name: "Cursed Blade", type: "curse_dmg", val: -5, icon: "💀" };
    return { name: "Health Kit", type: "hp", val: 40, icon: "🍷" };
}
function applyItemEffect(p, i, l) {
    if (i.type === 'potion') p.companions.push({ x: p.x, y: p.y, hp: 100 + l * 10, maxHp: 100 + l * 10, dmg: 15 + l, nextAttack: 0 });
    else if (i.type === 'hp') p.hp = Math.min(p.maxHp, p.hp + i.val);
    else if (i.type === 'sword') p.dmg += i.val;
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`Run on ${PORT}`));