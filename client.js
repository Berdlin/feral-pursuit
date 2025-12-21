const socket = io();
let isHost = false;
let myId = null;

const getEl = (id) => document.getElementById(id);
const connectionScreen = getEl('connection-screen');
const lobbyScreen = getEl('lobby-screen');
const displayCode = getEl('displayCode');
const playerList = getEl('playerList');
const startButton = getEl('startButton');
const errorMessage = getEl('error-message');

// Auto-fill code from URL
const urlParams = new URLSearchParams(window.location.search);
const urlCode = urlParams.get('code');
if (urlCode && getEl('joinCode')) {
    getEl('joinCode').value = urlCode;
}

function getUsername() {
    const inp = getEl('usernameInput');
    let name = inp.value.trim() || localStorage.getItem('gameUsername');
    if (!name || name === "Guest") {
        name = 'Hunter_' + Math.floor(Math.random() * 100);
    }
    localStorage.setItem('gameUsername', name);
    return name;
}

function displayError(msg) {
    if (errorMessage) {
        errorMessage.textContent = msg;
        setTimeout(() => errorMessage.textContent = '', 5000);
    }
}

function hostGame() {
    socket.emit('hostGame', { username: getUsername() });
}

function joinGame() {
    const code = getEl('joinCode').value.trim();
    if (code.length !== 4) return displayError('Code must be 4 digits.');
    socket.emit('joinGame', code, { username: getUsername() });
}

function startGame() {
    if (isHost) socket.emit('startGame');
}

function copyInvite() {
    const code = displayCode.textContent;
    const url = `${window.location.origin}/gameintro.html?code=${code}`;
    navigator.clipboard.writeText(url).then(() => alert("Link Copied!"));
}

socket.on('connect', () => { myId = socket.id; });

socket.on('roomCreated', (code) => {
    isHost = true;
    localStorage.setItem('gameRoomCode', code);
    connectionScreen.style.display = 'none';
    lobbyScreen.style.display = 'block';
    displayCode.textContent = code;
    startButton.style.display = 'block';
});

socket.on('joinSuccess', (code) => {
    isHost = false;
    localStorage.setItem('gameRoomCode', code);
    connectionScreen.style.display = 'none';
    lobbyScreen.style.display = 'block';
    displayCode.textContent = code;
    startButton.style.display = 'none';
});

socket.on('joinFailed', (msg) => displayError(msg));

socket.on('lobbyUpdate', (players) => {
    playerList.innerHTML = '';
    players.forEach(name => {
        const li = document.createElement('li');
        li.textContent = `➤ ${name}`;
        li.style.padding = '5px';
        li.style.borderBottom = '1px solid #333';
        li.style.color = '#ccc';
        playerList.appendChild(li);
    });
});

socket.on('gameStarted', () => {
    window.location.href = 'multiplay.html';
});