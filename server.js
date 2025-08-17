const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

// serve static files from public directory
app.use(express.static('public'));
app.use(express.json({ limit: '1mb' }));

// in-memory storage for lobbies
const lobbies = {};

// emoji array
const EMOJIS = [
    '😀','😂','😍','😎','🤔','😱','🥳','😡','😭','😴','👻','🤖','🐶','🐱','🦄','🐉','🍕','🍔','🍟','🍎','🍌','🍉','⚽','🏀','🏈','🚗','✈️','🚀','🌈','🔥','⭐','🎲','🎸','🎮','🎤','🎧','📚','🧩','🖌️','🎨','🏆','🥇','🥈','🥉','🎯','🎳','🎮','🕹️','🧸','🎁','🎂','🍰','🍩','🍪','🍫','🍿','🍦','🍭','🍺','🍻','🥤','☕','🍵','🧃','🧊','🥪','🥗','🍲','🍜','🍣','🍙','🥠','🦐','🦞','🦀','🐟','🐬','🐋','🦈','🐊','🐢','🐍','🦎','🦖','🐅','🐆','🦓','🦍','🐘','🦛','🦏','🐪','🦒','🦘','🦥','🦦','🦨','🦡','🐁','🐀','🐇','🐿️','🦔'
];

// function to generate a 6-character room code
function generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// function to get 3 random emojis
function getRandomEmojis() {
    const shuffled = EMOJIS.sort(() => 0.5 - Math.random());
    return shuffled.slice(0, 3);
}

// handle socket.io connections
io.on('connection', (socket) => {
    console.log('user connected');

    // create lobby
    socket.on('create-lobby', ({ username, emoji }) => {
        const roomCode = generateRoomCode();
        lobbies[roomCode] = {
            host: socket.id,
            players: [{ id: socket.id, name: username, emoji }],
            started: false,
            emojis: {},
            stories: {}
        };
        socket.join(roomCode);
        socket.emit('lobby-created', { roomCode, players: lobbies[roomCode].players });
        io.to(roomCode).emit('players-update', lobbies[roomCode].players);
    });

    // join lobby
    socket.on('join-lobby', ({ username, roomCode, emoji }) => {
        const lobby = lobbies[roomCode];
        if (lobby && !lobby.started) {
            lobby.players.push({ id: socket.id, name: username, emoji });
            socket.join(roomCode);
            socket.emit('lobby-joined', { roomCode, players: lobby.players });
            io.to(roomCode).emit('players-update', lobby.players);
        } else {
            socket.emit('lobby-error', { message: 'Invalid or started room code.' });
        }
    });

    // start game
    socket.on('start-game', ({ roomCode }) => {
        const lobby = lobbies[roomCode];
        if (!lobby) return;
        if (lobby.players.length < 3) {
            socket.emit('lobby-error', { message: 'At least 3 players required to start the game.' });
            return;
        }
        if (lobby.host === socket.id && !lobby.started) {
            lobby.started = true;
            // assign emojis to each player
            lobby.players.forEach(player => {
                lobby.emojis[player.id] = getRandomEmojis();
            });
            // writing start time
            const writingStartTime = Date.now();
            lobby.writingStartTime = writingStartTime;
            // timer for 180 seconds
            if (lobby.writingTimeout) clearTimeout(lobby.writingTimeout);
            lobby.writingTimeout = setTimeout(() => {
                // if not all stories are submitted, we still go to guessing phase
                if (lobby && lobby.started && Object.keys(lobby.stories).length < lobby.players.length) {
                    startGuessingPhase(roomCode);
                }
            }, 180000);
            // send each player their emoji and start time
            lobby.players.forEach(player => {
                io.to(player.id).emit('emojis-assigned', { emojis: lobby.emojis[player.id], writingStartTime });
            });
            io.to(roomCode).emit('game-started');
        }
    });

    // receive story from player
    socket.on('submit-story', ({ roomCode, story }) => {
        const lobby = lobbies[roomCode];
        if (lobby && lobby.started) {
            lobby.stories[socket.id] = story;
            // check if all stories are in
            if (Object.keys(lobby.stories).length === lobby.players.length) {
                if (lobby.writingTimeout) clearTimeout(lobby.writingTimeout);
                startGuessingPhase(roomCode);
            }
        }
    });

    // receive guess from player
    socket.on('submit-guess', ({ roomCode, guess }) => {
        const lobby = lobbies[roomCode];
        if (!lobby.guesses) lobby.guesses = {};
        lobby.guesses[socket.id] = { guess };
        if (Object.keys(lobby.guesses).length === lobby.players.length) {
            processResults(roomCode);
        }
    });

    // handle disconnect
    socket.on('disconnect', () => {
        // remove player from all lobbies
        for (const code in lobbies) {
            const lobby = lobbies[code];
            lobby.players = lobby.players.filter(p => p.id !== socket.id);
            delete lobby.emojis?.[socket.id];
            delete lobby.stories?.[socket.id];
            // if host left or no players, delete lobby
            if (lobby.host === socket.id || lobby.players.length === 0) {
                if (lobby.writingTimeout) clearTimeout(lobby.writingTimeout);
                delete lobbies[code];
                io.to(code).emit('lobby-closed');
            } else {
                io.to(code).emit('players-update', lobby.players);
            }
        }
        console.log('user disconnected');
    });

    // results-continue from ADM
    socket.on('results-continue', ({ roomCode }) => {
        const lobby = lobbies[roomCode];
        if (!lobby || !lobby.resultsState) return;
        // Only ADM can manage
        if (lobby.host !== socket.id) return;
        let { currentChatIdx, currentMsgStep } = lobby.resultsState;
        currentMsgStep++;
        const totalSteps = 4; // 0:bot, 1:story, 2:guesser, 3:bot
        if (currentMsgStep >= totalSteps) {
            if (currentChatIdx < lobby.players.length - 1) {
                currentChatIdx++;
                currentMsgStep = 0;
            } else {
                currentMsgStep = totalSteps - 1;
            }
        }
        lobby.resultsState = { currentChatIdx, currentMsgStep };
        io.to(roomCode).emit('results-progress', lobby.resultsState);
    });

    // leaderboard-phase from ADM
    socket.on('leaderboard-phase', ({ roomCode }) => {
        const lobby = lobbies[roomCode];
        if (!lobby) return;
        io.to(roomCode).emit('leaderboard-phase', {
            leaderboard: lobby.leaderboard,
            leaderboardDetails: lobby.leaderboardDetails,
            players: lobby.players.map(p => ({ id: p.id, name: p.name, emoji: p.emoji }))
        });
    });
});

// function to start guessing phase
function startGuessingPhase(roomCode) {
    const lobby = lobbies[roomCode];
    if (!lobby) return;
    const playerIds = lobby.players.map(p => p.id);
    // generate derangement (перемешивание без совпадений)
    let assignments = {};
    let deranged = false;
    while (!deranged) {
        const shuffled = playerIds.slice().sort(() => 0.5 - Math.random());
        deranged = true;
        for (let i = 0; i < playerIds.length; i++) {
            if (playerIds[i] === shuffled[i]) {
                deranged = false;
                break;
            }
        }
        if (deranged) {
            for (let i = 0; i < playerIds.length; i++) {
                assignments[playerIds[i]] = shuffled[i];
            }
        }
    }
    // for each player, send story, 6 emoji options (one correct), and player list (без самого себя)
    playerIds.forEach(id => {
        const authorId = assignments[id];
        const story = lobby.stories[authorId];
        const correctEmojis = lobby.emojis[authorId];
        // generate 5 random wrong emoji combinations
        const emojiCombos = [correctEmojis];
        while (emojiCombos.length < 6) {
            const combo = getRandomEmojis();
            if (!emojiCombos.some(arr => arr.join() === combo.join())) {
                emojiCombos.push(combo);
            }
        }
        // shuffle options
        emojiCombos.sort(() => 0.5 - Math.random());
        // send to player (exclude self from player list)
        io.to(id).emit('guess-phase', {
            story,
            emojiOptions: emojiCombos,
            correctEmojis,
            players: lobby.players.filter(p => p.id !== id).map(p => ({ id: p.id, name: p.name, emoji: p.emoji })),
            authorId
        });
    });
}

// process results and send to all players
function processResults(roomCode) {
    const lobby = lobbies[roomCode];
    if (!lobby) return;
    if (!lobby.leaderboard) lobby.leaderboard = {};
    // prepare chat-style results and count points
    const results = [];
    // For Leaderboard: detailed breakdown of points
    const leaderboardDetails = {};
    // for each story/author
    lobby.players.forEach(author => {
        const story = lobby.stories[author.id];
        const emojis = lobby.emojis[author.id];
        // find all guesses (all guesses, not just from this author)
        const guesses = Object.entries(lobby.guesses).filter(([pid, g]) => g.guess);
        // who guessed the emoji, who guessed the author
        const emojiGuessers = guesses.filter(([pid, g]) => JSON.stringify(g.guess.emojiCombo) === JSON.stringify(emojis)).map(([pid]) => pid);
        const authorGuessers = guesses.filter(([pid, g]) => JSON.stringify(g.guess.emojiCombo) === JSON.stringify(emojis) && g.guess.playerId === author.id).map(([pid]) => pid);
        // chat message
        results.push({
            author: author.name,
            authorId: author.id,
            emojis,
            story,
            emojiGuessers: emojiGuessers.map(pid => getPlayerName(lobby, pid)),
            authorGuessers: authorGuessers.map(pid => getPlayerName(lobby, pid)),
            guesses: guesses.map(([pid, g]) => ({ playerId: pid, guess: g.guess }))
        });
        // Leaderboard details
        leaderboardDetails[author.id] = {
            personal: [],
            earned: []
        };
        // 1. If your emojis were guessed by nobody — 1 point
        if (emojiGuessers.length === 0) {
            lobby.leaderboard[author.id] = (lobby.leaderboard[author.id] || 0) + 1;
            leaderboardDetails[author.id].personal.push({ reason: "Nobody guessed your emoji (+1)", value: 1 });
        }
        // 2. If nobody guessed you as author — 1 point
        if (authorGuessers.length === 0) {
            lobby.leaderboard[author.id] = (lobby.leaderboard[author.id] || 0) + 1;
            leaderboardDetails[author.id].personal.push({ reason: "Nobody guessed you as author (+1)", value: 1 });
        }
        // 3. For each person who guessed your emoji correctly — 2 points
        if (emojiGuessers.length > 0) {
            const pts = emojiGuessers.length * 2;
            lobby.leaderboard[author.id] = (lobby.leaderboard[author.id] || 0) + pts;
            leaderboardDetails[author.id].personal.push({ reason: `Your emoji guessed correctly by ${emojiGuessers.length} (${pts > 0 ? "+2" : ""})`, value: pts });
        }
        // 4. For each person who guessed you as author correctly — 2 points
        if (authorGuessers.length > 0) {
            const pts = authorGuessers.length * 2;
            lobby.leaderboard[author.id] = (lobby.leaderboard[author.id] || 0) + pts;
            leaderboardDetails[author.id].personal.push({ reason: `You guessed as author by ${authorGuessers.length} (${pts > 0 ? "+2" : ""})`, value: pts });
        }
    });
    // 5. For each correct guess of someone else's emoji — 0.5 points
    // 6. For each correct guess of someone else as author — 0.5 points
    lobby.players.forEach(player => {
        let earned = 0;
        let details = [];
        Object.entries(lobby.guesses).forEach(([pid, g]) => {
            if (pid !== player.id && g.guess) {
                // someone else's guess
                const guess = g.guess;
                // Find the author of the story and their emojis
                const author = lobby.players.find(a => a.id === guess.playerId);
                if (!author) return;
                const correctEmojis = lobby.emojis[author.id];
                // If the player guessed someone else's emoji correctly
                if (JSON.stringify(guess.emojiCombo) === JSON.stringify(correctEmojis)) {
                    lobby.leaderboard[player.id] = (lobby.leaderboard[player.id] || 0) + 0.5;
                    earned += 0.5;
                    details.push({ reason: `You guessed someone's emoji (+0.5)`, value: 0.5 });
                }
                // If the player guessed someone else as author correctly
                if (JSON.stringify(guess.emojiCombo) === JSON.stringify(correctEmojis) && guess.playerId === author.id) {
                    lobby.leaderboard[player.id] = (lobby.leaderboard[player.id] || 0) + 0.5;
                    earned += 0.5;
                    details.push({ reason: `You guessed the author (+0.5)`, value: 0.5 });
                }
            }
        });
        if (!leaderboardDetails[player.id]) leaderboardDetails[player.id] = { personal: [], earned: [] };
        leaderboardDetails[player.id].earned = details;
    });
    io.to(roomCode).emit('results-phase', {
        results,
        leaderboard: lobby.leaderboard,
        players: lobby.players.map(p => ({ id: p.id, name: p.name, emoji: p.emoji })),
        resultsState: { currentChatIdx: 0, currentMsgStep: 0 }
    });
    lobby.resultsState = { currentChatIdx: 0, currentMsgStep: 0 };
    // After completing results-phase ADM calls leaderboard-phase
    lobby.leaderboardDetails = leaderboardDetails;
}

function getPlayerName(lobby, pid) {
    const player = lobby.players.find(p => p.id === pid);
    return player ? player.name : 'Unknown';
}

// start server
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`server running on port ${PORT}`);
}); 