const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const BIN_ID = process.env.JSONBIN_BIN_ID;
const API_KEY = process.env.JSONBIN_API_KEY;
const DB_URL = `https://api.jsonbin.io/v3/b/${BIN_ID}`;

// دیتابیس در حافظه موقت سرور نگهداری می‌شود تا تاخیر به صفر برسد
let memoryDb = { users: [], lobbies: [], matches: [], clanMessages: [], dms: [], challenges: [] };
let isSaving = false;

const TRIVIA_QUESTIONS = [
    { q: "پایتخت ایران کجاست؟", opts: ["تهران", "شیراز", "اصفهان", "مشهد"], ans: 0 },
    { q: "۵ ضرب در ۶ چنده؟", opts: ["۳۵", "۴۰", "۳۰", "۲۵"], ans: 2 },
    { q: "آب مخفف کدام سیاره است؟", opts: ["مرکری", "زحل", "ناهید", "مشتری"], ans: 3 },
    { q: "نویسنده کتاب شاهنامه کیست؟", opts: ["سعدی", "حافظ", "فردوسی", "نظامی"], ans: 2 }
];

async function loadDb() {
    try {
        const response = await fetch(DB_URL + '/latest', { headers: { 'X-Master-Key': API_KEY } });
        if (response.ok) {
            const data = await response.json();
            const db = data.record || {};
            memoryDb.users = db.users || [];
            memoryDb.lobbies = db.lobbies || [];
            memoryDb.matches = db.matches || [];
            memoryDb.clanMessages = db.clanMessages || [];
            memoryDb.dms = db.dms || [];
            memoryDb.challenges = db.challenges || [];
            memoryDb.users.forEach(u => {
                if(!u.friends) u.friends = [];
                if(!u.friendRequests) u.friendRequests = [];
            });
            console.log("DB Loaded into Memory!");
        }
    } catch (e) { console.error("Load DB Error:", e.message); }
}

async function saveDb() {
    if(isSaving) return; // جلوگیری از تداخل درخواست‌های ذخیره سازی
    isSaving = true;
    try {
        await fetch(DB_URL, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'X-Master-Key': API_KEY },
            body: JSON.stringify(memoryDb)
        });
    } catch (e) { console.error('Save DB Error:', e.message); }
    isSaving = false;
}

// هر 10 ثانیه دیتابیس حافظه موقت در اینترنت ذخیره میشود
setInterval(saveDb, 10000);

app.get('/api/db', async (req, res) => {
    res.json(memoryDb); // بازگرداندن فوری اطلاعات بدون تاخیر
});

app.post('/api/db', async (req, res) => {
    memoryDb = req.body;
    saveDb(); // ذخیره در پس زمینه
    res.json({ success: true });
});

// --- Social Endpoints ---
app.post('/api/social/addfriend', async (req, res) => {
    const { username, target } = req.body;
    let targetUser = memoryDb.users.find(u => u.username === target);
    if(!targetUser) return res.status(404).json({ error: 'کاربر پیدا نشد' });
    if(targetUser.friendRequests.includes(username)) return res.status(400).json({ error: 'قبلاً درخواست فرستاده‌اید' });
    if(targetUser.friends.includes(username)) return res.status(400).json({ error: 'این کاربر در لیست دوستان شماست' });
    targetUser.friendRequests.push(username);
    saveDb();
    res.json({ success: true });
});

app.post('/api/social/acceptfriend', async (req, res) => {
    const { username, target } = req.body;
    let user = memoryDb.users.find(u => u.username === username);
    let targetUser = memoryDb.users.find(u => u.username === target);
    if(user && targetUser) {
        user.friendRequests = user.friendRequests.filter(u => u !== target);
        if(!user.friends.includes(target)) user.friends.push(target);
        if(!targetUser.friends.includes(username)) targetUser.friends.push(username);
        saveDb();
        res.json({ success: true });
    } else { res.status(404).json({ error: 'User not found' }); }
});

app.post('/api/social/sendmessage', async (req, res) => {
    const { from, to, text } = req.body;
    if(to === 'clan') {
        memoryDb.clanMessages.push({ id: Date.now(), from, text, date: new Date().toLocaleTimeString('fa-IR') });
        if(memoryDb.clanMessages.length > 100) memoryDb.clanMessages.shift();
    } else {
        const dmId = [from, to].sort().join('_');
        if(!memoryDb.dms.find(d => d.id === dmId)) memoryDb.dms.push({ id: dmId, messages: [] });
        let dm = memoryDb.dms.find(d => d.id === dmId);
        dm.messages.push({ id: Date.now(), from, text, date: new Date().toLocaleTimeString('fa-IR') });
        if(dm.messages.length > 50) dm.messages.shift();
    }
    saveDb();
    res.json({ success: true });
});

app.post('/api/social/challenge', async (req, res) => {
    const { from, to, gameType } = req.body;
    let lobby = { id: 'lobby_chal_' + Date.now(), gameType: gameType, teamSize: 1, players: [from], isPrivate: true };
    memoryDb.lobbies.push(lobby);
    memoryDb.challenges.push({ id: lobby.id, from, to, gameType, status: 'pending' });
    saveDb();
    res.json({ success: true });
});

function initGameLogic(gameType, lobby) {
    const baseGame = gameType.split(':')[0];
    const newMatch = {
        id: 'match_' + Date.now(),
        gameType: gameType,
        players: [...lobby.players],
        state: { scores: {}, turn: lobby.players[0], data: {}, winner: null, startTime: null, finished: false },
        createdAt: Date.now()
    };
    lobby.players.forEach(p => newMatch.state.scores[p] = 0);

    if (baseGame === 'math_battle') {
        const a = Math.floor(Math.random() * 20) + 1, b = Math.floor(Math.random() * 20) + 1;
        newMatch.state.data = { question: `${a} + ${b}`, currentAnswer: a+b };
    } else if (baseGame === 'tictactoe') {
        newMatch.state.data = { board: ["","","","","","","","",""] };
        newMatch.state.symbols = { [lobby.players[0]]: "X", [lobby.players[1]]: "O" };
    } else if (baseGame === 'typing') {
        const texts = ["learning is the key to success", "practice makes perfect", "speed and accuracy matter"];
        newMatch.state.data = { targetText: texts[Math.floor(Math.random()*texts.length)], finished: {} };
    } else if (baseGame === 'trivia') {
        const q = TRIVIA_QUESTIONS[Math.floor(Math.random() * TRIVIA_QUESTIONS.length)];
        newMatch.state.data = { question: q.q, options: q.opts, currentAnswer: q.ans };
    }
    return newMatch;
}

app.post('/api/social/acceptchallenge', async (req, res) => {
    const { username, challengeId } = req.body;
    let challenge = memoryDb.challenges.find(c => c.id === challengeId && c.to === username);
    if(!challenge) return res.status(404).json({ error: 'Challenge not found' });
    
    let lobby = memoryDb.lobbies.find(l => l.id === challenge.id);
    if(lobby) {
        lobby.players.push(username);
        if (lobby.players.length === 2) {
            const newMatch = initGameLogic(lobby.gameType, lobby);
            memoryDb.matches.push(newMatch);
            memoryDb.lobbies = memoryDb.lobbies.filter(l => l.id !== lobby.id);
            memoryDb.challenges = memoryDb.challenges.filter(c => c.id !== challengeId);
            saveDb();
            return res.json({ status: 'in_match', match: newMatch });
        }
    }
    saveDb();
    res.json({ success: true });
});

// --- Matchmaking (Public) ---
app.post('/api/matchmaking', async (req, res) => {
    const { username, gameType, teamSize } = req.body;
    
    let existingMatch = memoryDb.matches.find(m => m.players.includes(username));
    if (existingMatch) return res.json({ status: 'in_match', match: existingMatch });
    
    let existingLobby = memoryDb.lobbies.find(l => l.players.includes(username) && !l.isPrivate);
    if (existingLobby) return res.json({ status: 'waiting', lobby: existingLobby });

    let lobby = memoryDb.lobbies.find(l => l.gameType === gameType && l.teamSize === teamSize && l.players.length < (teamSize * 2) && !l.isPrivate);
    
    if (lobby) {
        lobby.players.push(username);
        if (lobby.players.length === lobby.teamSize * 2) {
            const newMatch = initGameLogic(lobby.gameType, lobby);
            memoryDb.matches.push(newMatch);
            memoryDb.lobbies = memoryDb.lobbies.filter(l => l.id !== lobby.id);
            saveDb();
            return res.json({ status: 'in_match', match: newMatch });
        }
    } else {
        lobby = { id: 'lobby_' + Date.now(), gameType: gameType, teamSize: teamSize, players: [username], createdAt: Date.now() };
        memoryDb.lobbies.push(lobby);
    }
    saveDb();
    res.json({ status: 'waiting', lobby });
});

app.post('/api/match/action', async (req, res) => {
    const { username, matchId, action, value } = req.body;
    let match = memoryDb.matches.find(m => m.id === matchId);
    if (!match || match.state.winner) return res.status(400).json({ error: 'Match invalid' });

    const baseGame = match.gameType.split(':')[0];

    if (action === 'surrender') match.state.winner = match.players.find(p => p !== username);
    else if (baseGame === 'math_battle') {
        if(action === 'answer' && match.state.turn === username) {
            if(value === match.state.data.currentAnswer) {
                match.state.scores[username] += 10;
                if (match.state.scores[username] >= 30) match.state.winner = username;
                else {
                    const a = Math.floor(Math.random() * 20) + 1, b = Math.floor(Math.random() * 20) + 1;
                    match.state.data = { question: `${a} + ${b}`, currentAnswer: a+b };
                    match.state.turn = match.players.find(p => p !== username);
                }
            } else match.state.scores[username] -= 2;
        }
    } else if (baseGame === 'tictactoe') {
        if(action === 'place' && match.state.turn === username) {
            if(match.state.data.board[value] === "") {
                match.state.data.board[value] = match.state.symbols[username];
                const winPatterns = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
                for(let p of winPatterns) {
                    if(match.state.data.board[p[0]] !== "" && match.state.data.board[p[0]] === match.state.data.board[p[1]] && match.state.data.board[p[1]] === match.state.data.board[p[2]]) {
                        match.state.winner = username; break;
                    }
                }
                if(!match.state.winner && !match.state.data.board.includes("")) match.state.winner = "draw";
                else if(!match.state.winner) match.state.turn = match.players.find(p => p !== username);
            }
        }
    } else if (baseGame === 'typing') {
        if(action === 'finish' && !match.state.data.finished[username]) {
            if(value === match.state.data.targetText) {
                match.state.data.finished[username] = true;
                match.state.winner = username;
            }
        }
    } else if (baseGame === 'trivia') {
        if(action === 'answer_trivia' && match.state.turn === username) {
            if(value === match.state.data.currentAnswer) {
                match.state.scores[username] += 10;
                if (match.state.scores[username] >= 30) match.state.winner = username;
                else {
                    const q = TRIVIA_QUESTIONS[Math.floor(Math.random() * TRIVIA_QUESTIONS.length)];
                    match.state.data = { question: q.q, options: q.opts, currentAnswer: q.ans };
                    match.state.turn = match.players.find(p => p !== username);
                }
            } else match.state.scores[username] -= 2;
        }
    } else if (baseGame === 'reaction') {
        if(action === 'init' && !match.state.startTime && match.state.turn === username) match.state.startTime = Date.now() + Math.floor(Math.random() * 4000) + 2000;
        if(action === 'click' && !match.state.winner) match.state.winner = username;
    }

    saveDb();
    res.json({ success: true, match });
});

app.post('/api/match/finish', async (req, res) => {
    const { matchId } = req.body;
    let match = memoryDb.matches.find(m => m.id === matchId);
    if(match && !match.finished) {
        match.finished = true;
        match.players.forEach(p => {
            let user = memoryDb.users.find(u => u.username === p);
            if(user) {
                if(!user.history) user.history = [];
                const isWin = match.state.winner === p;
                const isDraw = match.state.winner === 'draw';
                user.history.push({ game: match.gameType, result: isWin ? 'win' : (isDraw ? 'draw' : 'lose'), date: Date.now() });
                if(isWin) { user.wins = (user.wins || 0) + 1; user.elo = (user.elo || 1000) + 15; }
                else if (!isDraw) { user.losses = (user.losses || 0) + 1; user.elo = (user.elo || 1000) - 10; }
            }
        });
        memoryDb.matches = memoryDb.matches.filter(m => m.id !== matchId);
    }
    saveDb();
    res.json({ success: true });
});

// بارگذاری اطلاعات در حافظه موقت هنگام روشن شدن سرور
loadDb().then(() => {
    app.listen(PORT, () => console.log(`NeoBattle Server running on ${PORT}`));
});
