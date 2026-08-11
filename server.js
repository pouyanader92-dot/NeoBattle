const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const BIN_ID = process.env.JSONBIN_BIN_ID;
const API_KEY = process.env.JSONBIN_API_KEY;
const DB_URL = `https://api.jsonbin.io/v3/b/${BIN_ID}`;

const defaultDb = { users: [], lobbies: [], matches: [] };

// سوالات بازی دانستنی‌ها
const TRIVIA_QUESTIONS = [
    { q: "پایتخت ایران کجاست؟", opts: ["تهران", "شیراز", "اصفهان", "مشهد"], ans: 0 },
    { q: "۵ ضرب در ۶ چنده؟", opts: ["۳۵", "۴۰", "۳۰", "۲۵"], ans: 2 },
    { q: "آب مخفف کدام سیاره است؟", opts: ["مرکری", "زحل", "ناهید", "مشتری"], ans: 3 },
    { q: "طول رودخانه نیل چقدر است؟", opts: ["۶۶۵۰ کیلومتر", "۵۰۰۰ کیلومتر", "۴۰۰۰ کیلومتر", "۳۰۰۰ کیلومتر"], ans: 0 },
    { q: "بزرگترین سیاره منظومه شمسی کدام است؟", opts: ["زمین", "مشتری", "زحل", "مریخ"], ans: 1 },
    { q: "نویسنده کتاب شاهنامه کیست؟", opts: ["سعدی", "حافظ", "فردوسی", "نظامی"], ans: 2 }
];

async function getDb() {
    try {
        const response = await fetch(DB_URL + '/latest', { headers: { 'X-Master-Key': API_KEY } });
        if (!response.ok) throw new Error('Fetch failed');
        const data = await response.json();
        return data.record;
    } catch (err) {
        console.error('GET Error:', err.message);
        return defaultDb;
    }
}

async function saveDb(data) {
    try {
        const response = await fetch(DB_URL, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'X-Master-Key': API_KEY },
            body: JSON.stringify(data)
        });
        if (!response.ok) throw new Error('Save failed');
        return true;
    } catch (err) {
        console.error('POST Error:', err.message);
        return false;
    }
}

app.get('/api/db', async (req, res) => {
    const db = await getDb();
    if (!db.users) db.users = [];
    if (!db.lobbies) db.lobbies = [];
    if (!db.matches) db.matches = [];
    res.json(db);
});

app.post('/api/db', async (req, res) => {
    await saveDb(req.body);
    res.json({ success: true });
});

// سیستم هم‌یابی و ساخت مسابقه
app.post('/api/matchmaking', async (req, res) => {
    const { username, gameType, teamSize } = req.body;
    let db = await getDb();
    
    if (!db.matches) db.matches = [];
    if (!db.lobbies) db.lobbies = [];
    
    let existingMatch = db.matches.find(m => m.players.includes(username));
    if (existingMatch) return res.json({ status: 'in_match', match: existingMatch });
    
    let existingLobby = db.lobbies.find(l => l.players.includes(username));
    if (existingLobby) return res.json({ status: 'waiting', lobby: existingLobby });

    let lobby = db.lobbies.find(l => l.gameType === gameType && l.teamSize === teamSize && l.players.length < (teamSize * 2));
    
    if (lobby) {
        lobby.players.push(username);
        // وقتی اتاق پر شد، مسابقه شروع میشه
        if (lobby.players.length === lobby.teamSize * 2) {
            const newMatch = {
                id: 'match_' + Date.now(),
                gameType: gameType,
                players: lobby.players,
                state: { 
                    scores: {}, 
                    turn: lobby.players[0], 
                    data: {}, 
                    winner: null, 
                    startTime: null, 
                    finished: false 
                },
                createdAt: Date.now()
            };
            lobby.players.forEach(p => newMatch.state.scores[p] = 0);
            
            // لاجیک شروع هر بازی
            if (gameType === 'math_battle') {
                const a = Math.floor(Math.random() * 20) + 1, b = Math.floor(Math.random() * 20) + 1;
                newMatch.state.data = { question: `${a} + ${b}`, currentAnswer: a+b };
            } 
            else if (gameType === 'tictactoe') {
                newMatch.state.data = { board: ["","","","","","","","",""] };
                newMatch.state.symbols = { [lobby.players[0]]: "X", [lobby.players[1]]: "O" };
            } 
            else if (gameType === 'typing') {
                const texts = ["learning is the key to success", "practice makes perfect", "speed and accuracy matter"];
                newMatch.state.data = { targetText: texts[Math.floor(Math.random()*texts.length)], finished: {} };
            } 
            else if (gameType === 'trivia') {
                const q = TRIVIA_QUESTIONS[Math.floor(Math.random() * TRIVIA_QUESTIONS.length)];
                newMatch.state.data = { question: q.q, options: q.opts, currentAnswer: q.ans };
            }
            
            db.matches.push(newMatch);
            db.lobbies = db.lobbies.filter(l => l.id !== lobby.id);
            await saveDb(db);
            return res.json({ status: 'in_match', match: newMatch });
        }
    } else {
        lobby = { id: 'lobby_' + Date.now(), gameType: gameType, teamSize: teamSize, players: [username], createdAt: Date.now() };
        db.lobbies.push(lobby);
    }

    await saveDb(db);
    res.json({ status: 'waiting', lobby });
});

// دریافت حرکت‌های بازیکنان در طول مسابقه
app.post('/api/match/action', async (req, res) => {
    const { username, matchId, action, value } = req.body;
    let db = await getDb();
    let match = db.matches.find(m => m.id === matchId);
    
    if (!match || match.state.winner) return res.status(400).json({ error: 'Match invalid or ended' });

    // تسلیم شدن
    if (action === 'surrender') {
        const winner = match.players.find(p => p !== username);
        match.state.winner = winner;
    } 
    // لاجیک نبرد ریاضی
    else if (match.gameType === 'math_battle') {
        if(action === 'answer' && match.state.turn === username) {
            if(value === match.state.data.currentAnswer) {
                match.state.scores[username] += 10;
                if (match.state.scores[username] >= 30) {
                    match.state.winner = username;
                } else {
                    const a = Math.floor(Math.random() * 20) + 1, b = Math.floor(Math.random() * 20) + 1;
                    match.state.data = { question: `${a} + ${b}`, currentAnswer: a+b };
                    match.state.turn = match.players.find(p => p !== username);
                }
            } else {
                match.state.scores[username] -= 2;
            }
        }
    }
    // لاجیک دوز بازی
    else if (match.gameType === 'tictactoe') {
        if(action === 'place' && match.state.turn === username) {
            const index = value;
            if(match.state.data.board[index] === "") {
                match.state.data.board[index] = match.state.symbols[username];
                const winPatterns = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
                for(let pattern of winPatterns) {
                    if(match.state.data.board[pattern[0]] !== "" && 
                       match.state.data.board[pattern[0]] === match.state.data.board[pattern[1]] && 
                       match.state.data.board[pattern[1]] === match.state.data.board[pattern[2]]) {
                        match.state.winner = username;
                        break;
                    }
                }
                if(!match.state.winner && !match.state.data.board.includes("")) {
                    match.state.winner = "draw";
                } else if(!match.state.winner) {
                    match.state.turn = match.players.find(p => p !== username);
                }
            }
        }
    }
    // لاجیک تایپ سریع
    else if (match.gameType === 'typing') {
        if(action === 'finish' && !match.state.data.finished[username]) {
            if(value === match.state.data.targetText) {
                match.state.data.finished[username] = true;
                match.state.winner = username;
            }
        }
    }
    // لاجیک بازی دانستنی‌ها
    else if (match.gameType === 'trivia') {
        if(action === 'answer_trivia' && match.state.turn === username) {
            if(value === match.state.data.currentAnswer) {
                match.state.scores[username] += 10;
                if (match.state.scores[username] >= 30) {
                    match.state.winner = username;
                } else {
                    const q = TRIVIA_QUESTIONS[Math.floor(Math.random() * TRIVIA_QUESTIONS.length)];
                    match.state.data = { question: q.q, options: q.opts, currentAnswer: q.ans };
                    match.state.turn = match.players.find(p => p !== username);
                }
            } else {
                match.state.scores[username] -= 2;
            }
        }
    }
    // لاجیک زمان واکنش
    else if (match.gameType === 'reaction') {
        if(action === 'init' && !match.state.startTime && match.state.turn === username) {
            match.state.startTime = Date.now() + Math.floor(Math.random() * 4000) + 2000;
        }
        if(action === 'click' && !match.state.winner) {
            match.state.winner = username;
        }
    }

    await saveDb(db);
    res.json({ success: true, match });
});

// پایان مسابقه و آپدیت امتیازات
app.post('/api/match/finish', async (req, res) => {
    const { matchId } = req.body;
    let db = await getDb();
    let match = db.matches.find(m => m.id === matchId);
    
    if(match && !match.finished) {
        match.finished = true;
        match.players.forEach(p => {
            let user = db.users.find(u => u.username === p);
            if(user) {
                if(!user.history) user.history = [];
                const isWin = match.state.winner === p;
                const isDraw = match.state.winner === 'draw';
                user.history.push({ game: match.gameType, result: isWin ? 'win' : (isDraw ? 'draw' : 'lose'), date: Date.now() });
                if(isWin) {
                    user.wins = (user.wins || 0) + 1;
                    user.elo = (user.elo || 1000) + 15;
                } else if (!isDraw) {
                    user.losses = (user.losses || 0) + 1;
                    user.elo = (user.elo || 1000) - 10;
                }
            }
        });
        // حذف مسابقه از دیتابیس
        db.matches = db.matches.filter(m => m.id !== matchId);
    }
    await saveDb(db);
    res.json({ success: true });
});

app.listen(PORT, () => console.log(`NeoBattle Server is running on port ${PORT}`));
