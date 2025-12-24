// chat_overlay.js
(function () {
    // 1. Inject HTML
    const div = document.createElement('div');
    div.innerHTML = `
    <div id="globalChat" style="display:none; position: fixed; bottom: 20px; right: 20px; width: 320px; height: 250px; background: rgba(0,0,0,0.9); border: 1px solid #ff4500; z-index: 9999; flex-direction: column; border-radius: 5px; box-shadow: 0 0 15px rgba(255, 69, 0, 0.2); font-family: sans-serif;">
        <div style="padding: 8px; background: #220000; color: #ff4500; font-weight: bold; border-bottom: 1px solid #440000; display: flex; justify-content: space-between;">
            <span>GLOBAL COMM LINK</span>
            <span style="font-size:10px; cursor:pointer;" onclick="document.getElementById('globalChat').style.display='none'">[X]</span>
        </div>
        <div id="chatMessages" style="flex-grow: 1; padding: 10px; overflow-y: auto; font-size: 14px; font-family: monospace; color: #ccc;"></div>
        <div style="padding: 5px; border-top: 1px solid #333; display: flex;">
            <input type="text" id="chatInput" placeholder="Message..." style="flex-grow: 1; background: #111; border: none; color: white; padding: 5px; outline: none;">
            <button id="chatSendBtn" style="background: #ff4500; border: none; color: white; font-weight: bold; cursor: pointer; padding: 0 10px;">></button>
        </div>
    </div>
    <div style="position: fixed; bottom: 10px; right: 10px; color: #555; font-size: 10px; font-family: monospace;">SHIFT+C to Chat</div>
    `;
    document.body.appendChild(div);

    // 2. Setup Socket (Assuming socket.io script is already loaded in parent file)
    // If not loaded, we check.
    if (typeof io === 'undefined') {
        console.error("Socket.io not found for chat overlay");
        return;
    }
    const socket = io(); // Connects to same server

    const user = localStorage.getItem('gameUsername') || "Guest";
    const isAdmin = (user.toLowerCase() === 'beka_ei'); // Client-side visual only

    // 3. Logic
    const chatBox = document.getElementById('globalChat');
    const msgs = document.getElementById('chatMessages');
    const inp = document.getElementById('chatInput');
    const btn = document.getElementById('chatSendBtn');

    window.addEventListener('keydown', (e) => {
        if (e.shiftKey && e.key.toLowerCase() === 'c') {
            e.preventDefault();
            chatBox.style.display = (chatBox.style.display === 'none') ? 'flex' : 'none';
            if (chatBox.style.display === 'flex') inp.focus();
        }
    });

    function send() {
        const txt = inp.value.trim();
        if (!txt) return;
        socket.emit('globalChat', { username: user, text: txt, isAdmin: isAdmin });
        inp.value = '';
    }

    btn.onclick = send;
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

    socket.on('globalChatMsg', (msg) => {
        const el = document.createElement('div');
        el.style.marginBottom = '4px';
        el.innerHTML = `<span style="color:${msg.color}; font-weight:bold;">[${msg.user}]</span>: ${msg.text}`;
        msgs.appendChild(el);
        msgs.scrollTop = msgs.scrollHeight;
    });
})();