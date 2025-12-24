// chat_overlay.js - Handles Shift+C Global Chat for all pages
(function () {
    // 1. Inject HTML Structure
    const overlayDiv = document.createElement('div');
    overlayDiv.innerHTML = `
    <div id="globalChatContainer" style="display:none; position: fixed; bottom: 20px; right: 20px; width: 320px; height: 250px; background: rgba(0,0,0,0.95); border: 2px solid #ff4500; z-index: 99999; flex-direction: column; border-radius: 8px; box-shadow: 0 0 20px rgba(255, 69, 0, 0.3); font-family: 'Segoe UI', monospace;">
        <div style="padding: 10px; background: #220000; color: #ff4500; font-weight: bold; border-bottom: 1px solid #440000; display: flex; justify-content: space-between; align-items: center;">
            <span>🌐 GLOBAL COMM LINK</span>
            <span style="font-size:12px; cursor:pointer; color:#fff;" onclick="document.getElementById('globalChatContainer').style.display='none'">[CLOSE]</span>
        </div>
        <div id="globalChatMessages" style="flex-grow: 1; padding: 10px; overflow-y: auto; font-size: 13px; color: #ccc; scrollbar-width: thin;"></div>
        <div style="padding: 8px; border-top: 1px solid #333; display: flex; background: #111;">
            <input type="text" id="globalChatInput" placeholder="Type here..." style="flex-grow: 1; background: #222; border: 1px solid #444; color: white; padding: 6px; outline: none; border-radius: 4px;">
            <button id="globalChatSend" style="background: #ff4500; border: none; color: white; font-weight: bold; cursor: pointer; padding: 0 12px; margin-left: 5px; border-radius: 4px;">➤</button>
        </div>
    </div>
    <div style="position: fixed; bottom: 5px; right: 10px; color: #666; font-size: 10px; font-family: monospace; z-index: 99998; pointer-events:none;">SHIFT+C to Chat</div>
    `;
    document.body.appendChild(overlayDiv);

    // 2. Initialize Socket Connection
    // We check if 'io' exists (socket.io.js must be loaded in the main HTML)
    let socket;
    if (typeof io !== 'undefined') {
        socket = io(); // Connect using existing or new socket
    } else {
        console.warn("GlobalChat: Socket.io not found on this page.");
        return;
    }

    const user = localStorage.getItem('gameUsername') || "Guest";
    const pass = localStorage.getItem('gamePass') || "";
    // Client-side 'admin' check for visual style, server verifies continuously
    const isAdmin = (user.toLowerCase() === 'beka_ei');

    // 3. Event Listeners
    const chatBox = document.getElementById('globalChatContainer');
    const msgBox = document.getElementById('globalChatMessages');
    const inp = document.getElementById('globalChatInput');
    const btn = document.getElementById('globalChatSend');

    // Toggle with Shift+C
    window.addEventListener('keydown', (e) => {
        if (e.shiftKey && e.key.toLowerCase() === 'c') {
            e.preventDefault();
            const isHidden = chatBox.style.display === 'none';
            chatBox.style.display = isHidden ? 'flex' : 'none';
            if (isHidden) inp.focus();
        }
    });

    function sendMessage() {
        const text = inp.value.trim();
        if (!text) return;
        // Verify admin status via logic before sending tag preference
        socket.emit('globalChat', { username: user, text: text, isAdmin: isAdmin });
        inp.value = '';
    }

    btn.onclick = sendMessage;
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMessage(); });

    // 4. Receive Messages
    socket.on('globalChatMsg', (msg) => {
        const line = document.createElement('div');
        line.style.marginBottom = '6px';
        line.style.wordWrap = 'break-word';
        line.innerHTML = `<span style="color:${msg.color}; font-weight:bold;">[${msg.user}]</span>: <span style="color:#eee;">${msg.text}</span>`;
        msgBox.appendChild(line);
        msgBox.scrollTop = msgBox.scrollHeight;
    });
})();