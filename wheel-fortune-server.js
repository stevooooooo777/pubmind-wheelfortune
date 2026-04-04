/**
 * 🎡 WHEEL OF FORTUNE — BOSHD Game Server
 * Node.js + WebSocket + Express
 * Plugs into existing BOSHD game ping routing system
 *
 * Install: npm install express ws node-fetch
 */

const express = require("express");
const { WebSocketServer } = require("ws");
const http = require("http");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3008;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ─────────────────────────────────────────
// WHEEL SEGMENTS
// ─────────────────────────────────────────

const WHEEL_SEGMENTS = [
  { label: "100",      value: 100,  type: "points", color: "#ff2d6b" },
  { label: "200",      value: 200,  type: "points", color: "#ffd93d" },
  { label: "300",      value: 300,  type: "points", color: "#00e5ff" },
  { label: "500",      value: 500,  type: "points", color: "#ff6b35" },
  { label: "750",      value: 750,  type: "points", color: "#a855f7" },
  { label: "BANKRUPT", value: 0,    type: "bankrupt", color: "#1a1a1a" },
  { label: "150",      value: 150,  type: "points", color: "#ff2d6b" },
  { label: "250",      value: 250,  type: "points", color: "#00ff87" },
  { label: "400",      value: 400,  type: "points", color: "#ffd93d" },
  { label: "FREE SPIN",value: 0,    type: "freespin", color: "#ff2d6b" },
  { label: "600",      value: 600,  type: "points", color: "#00e5ff" },
  { label: "BANKRUPT", value: 0,    type: "bankrupt", color: "#1a1a1a" },
  { label: "350",      value: 350,  type: "points", color: "#ff6b35" },
  { label: "450",      value: 450,  type: "points", color: "#a855f7" },
  { label: "1000",     value: 1000, type: "points", color: "#ffd93d" },
  { label: "200",      value: 200,  type: "points", color: "#00ff87" },
];

const VOWELS = ["A", "E", "I", "O", "U"];
const VOWEL_COST = 250;

// ─────────────────────────────────────────
// GAME STATE
// ─────────────────────────────────────────

const games = {};

function createGame(gameCode, theme = "mixed") {
  return {
    gameCode,
    theme,
    phase: "lobby",       // lobby | spinning | guessing | solving | reveal | scoreboard | end
    round: 0,
    totalRounds: 4,
    teams: {},            // teamId → { name, score, roundScore, members[] }
    teamOrder: [],        // turn order
    currentTeamIndex: 0,
    tvSocket: null,
    hostSocket: null,
    currentPuzzle: null,  // { phrase, category, revealed[], usedLetters[] }
    lastSpin: null,       // current spin result
    freeSpin: false,
    guessedLetters: [],
    timer: null,
  };
}

// ─────────────────────────────────────────
// PING — BOSHD routing
// ─────────────────────────────────────────

app.get("/ping", (req, res) => {
  res.json({ game: "wheel-of-fortune", status: "ready", label: "🎡 Wheel of Fortune" });
});

app.get("/game/:code", (req, res) => {
  const g = games[req.params.code];
  if (!g) return res.status(404).json({ error: "Game not found" });
  res.json({ game: "wheel-of-fortune", phase: g.phase, theme: g.theme });
});

// ─────────────────────────────────────────
// CLAUDE — Generate puzzle phrase
// ─────────────────────────────────────────

const CATEGORIES = {
  mixed:    ["Pub Phrases", "Things You Say After 3 Pints", "Movie Quotes", "Famous People", "Song Titles", "Things in a Pub"],
  music:    ["Song Titles", "Band Names", "Album Names", "Famous Lyrics", "Music Venues"],
  movies:   ["Movie Titles", "Famous Movie Quotes", "Actor Names", "Film Characters"],
  sports:   ["Sports Phrases", "Famous Sportspeople", "Sports Teams", "Stadium Chants"],
  halloween:["Spooky Phrases", "Horror Movie Titles", "Things That Go Bump", "Halloween Sayings"],
  christmas:["Christmas Songs", "Festive Phrases", "Christmas Movies", "Yuletide Sayings"],
};

async function generatePuzzle(theme, round, usedPhrases = []) {
  const categories = CATEGORIES[theme] || CATEGORIES.mixed;
  const category = categories[round % categories.length];

  const prompt = `You are generating a Wheel of Fortune puzzle phrase for a pub game called BOSHD.
Category: ${category}
Round: ${round}
Already used phrases (do NOT repeat): ${usedPhrases.join(", ") || "none"}

Rules:
- Phrase must be 10-30 characters (letters and spaces only, NO punctuation)
- Must be well known and recognisable in a UK pub setting
- Should be fun, surprising, or slightly cheeky
- ALL CAPS

Respond ONLY with valid JSON, no markdown:
{
  "phrase": "THE PHRASE HERE",
  "category": "${category}",
  "hint": "A very subtle one-word hint if needed, or empty string"
}`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await res.json();
    const text = data.content[0].text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(text);
    // Sanitise — letters and spaces only
    parsed.phrase = parsed.phrase.replace(/[^A-Z ]/g, "").trim();
    return parsed;
  } catch (e) {
    console.error("Claude puzzle gen failed:", e);
    return { phrase: "ROUND THE WORLD IN EIGHTY DAYS", category, hint: "" };
  }
}

async function generateBankruptComment() {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 60,
        messages: [{
          role: "user",
          content: "Write ONE short funny/sarcastic pub game BANKRUPT comment. Max 8 words. No quotes. Examples: 'Absolutely skint. Buy everyone a round.' or 'The wheel has no mercy tonight.'"
        }],
      }),
    });
    const data = await res.json();
    return data.content[0].text.trim();
  } catch {
    return "Ouch. The wheel is ruthless.";
  }
}

// ─────────────────────────────────────────
// WEBSOCKET
// ─────────────────────────────────────────

wss.on("connection", (ws) => {
  ws.id = Math.random().toString(36).slice(2);

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const { type, gameCode, payload } = msg;
    const g = games[gameCode];

    // ── CREATE ────────────────────────────
    if (type === "create") {
      const code = payload.code || Math.random().toString(36).slice(2, 6).toUpperCase();
      const theme = payload.theme || "mixed";
      games[code] = createGame(code, theme);
      ws.gameCode = code;
      ws.role = "host";
      games[code].hostSocket = ws;
      ws.send(json({ type: "created", gameCode: code }));
      return;
    }

    // ── JOIN ──────────────────────────────
    if (type === "join") {
      if (!g) return ws.send(err("Game not found"));

      if (payload.role === "tv") {
        g.tvSocket = ws;
        ws.gameCode = gameCode;
        ws.role = "tv";
        ws.send(json({ type: "tv-ready", segments: WHEEL_SEGMENTS }));
        return;
      }

      // Team join
      const teamId = payload.teamId;
      if (!g.teams[teamId]) {
        g.teams[teamId] = { name: payload.teamName, score: 0, roundScore: 0, members: [] };
        g.teamOrder.push(teamId);
      }
      g.teams[teamId].members.push({ id: ws.id, name: payload.playerName });

      ws.gameCode = gameCode;
      ws.role = "player";
      ws.teamId = teamId;
      ws.playerName = payload.playerName;

      ws.send(json({ type: "joined", teamId, teamName: g.teams[teamId].name }));
      broadcastAll(g, { type: "teams-update", teams: g.teams });
    }

    // ── START ─────────────────────────────
    if (type === "start" && g) {
      await startNextRound(g);
    }

    // ── SPIN ──────────────────────────────
    if (type === "spin" && g) {
      if (g.phase !== "spinning") return;
      const currentTeam = g.teamOrder[g.currentTeamIndex];
      if (ws.teamId !== currentTeam) return; // not your turn

      // Pick random segment
      const segIndex = Math.floor(Math.random() * WHEEL_SEGMENTS.length);
      const segment = WHEEL_SEGMENTS[segIndex];
      g.lastSpin = segment;

      broadcastAll(g, {
        type: "wheel-spin",
        segmentIndex: segIndex,
        segment,
        teamId: currentTeam,
        teamName: g.teams[currentTeam].name,
      });

      // Handle result after animation (3s)
      setTimeout(async () => {
        if (segment.type === "bankrupt") {
          g.teams[currentTeam].roundScore = 0;
          const comment = await generateBankruptComment();
          broadcastAll(g, {
            type: "bankrupt",
            teamId: currentTeam,
            comment,
            teams: g.teams,
          });
          nextTeamTurn(g);

        } else if (segment.type === "freespin") {
          g.freeSpin = true;
          broadcastAll(g, { type: "free-spin", teamId: currentTeam });
          g.phase = "guessing";
          broadcastAll(g, {
            type: "your-turn-guess",
            teamId: currentTeam,
            value: 0,
            puzzle: sanitisePuzzle(g.currentPuzzle),
          });

        } else {
          g.phase = "guessing";
          broadcastAll(g, {
            type: "your-turn-guess",
            teamId: currentTeam,
            value: segment.value,
            puzzle: sanitisePuzzle(g.currentPuzzle),
          });
        }
      }, 3200);
    }

    // ── GUESS LETTER ──────────────────────
    if (type === "guess" && g) {
      if (g.phase !== "guessing") return;
      const currentTeam = g.teamOrder[g.currentTeamIndex];
      if (ws.teamId !== currentTeam) return;

      const letter = payload.letter?.toUpperCase();
      if (!letter || g.currentPuzzle.usedLetters.includes(letter)) return;

      g.currentPuzzle.usedLetters.push(letter);

      const isVowel = VOWELS.includes(letter);
      const occurrences = [...g.currentPuzzle.phrase].filter(c => c === letter).length;

      if (isVowel && payload.buying) {
        // Buying a vowel
        if (g.teams[currentTeam].roundScore < VOWEL_COST) {
          ws.send(json({ type: "error", message: "Not enough points to buy a vowel!" }));
          return;
        }
        g.teams[currentTeam].roundScore -= VOWEL_COST;
      }

      if (occurrences > 0) {
        // Reveal letter in puzzle
        g.currentPuzzle.phrase.split("").forEach((c, i) => {
          if (c === letter) g.currentPuzzle.revealed[i] = true;
        });

        if (!isVowel || payload.buying) {
          const points = isVowel ? 0 : (g.lastSpin?.value || 0) * occurrences;
          g.teams[currentTeam].roundScore += points;
        }

        const solved = g.currentPuzzle.revealed.every((r, i) => r || g.currentPuzzle.phrase[i] === " ");

        broadcastAll(g, {
          type: "letter-correct",
          letter,
          occurrences,
          revealed: g.currentPuzzle.revealed,
          teamId: currentTeam,
          teams: g.teams,
          puzzle: sanitisePuzzle(g.currentPuzzle),
        });

        if (solved) {
          await solvePuzzle(g, currentTeam, true);
        } else {
          // Stay on guessing — team can guess again, buy vowel, or solve
          g.phase = "guessing";
        }
      } else {
        // Letter not in puzzle
        broadcastAll(g, {
          type: "letter-wrong",
          letter,
          teamId: currentTeam,
          puzzle: sanitisePuzzle(g.currentPuzzle),
        });
        nextTeamTurn(g);
      }
    }

    // ── SOLVE ATTEMPT ─────────────────────
    if (type === "solve" && g) {
      if (g.phase !== "guessing") return;
      const currentTeam = g.teamOrder[g.currentTeamIndex];
      if (ws.teamId !== currentTeam) return;

      const attempt = payload.answer?.toUpperCase().trim();
      const correct = attempt === g.currentPuzzle.phrase.trim();

      if (correct) {
        await solvePuzzle(g, currentTeam, false);
      } else {
        broadcastAll(g, {
          type: "solve-wrong",
          teamId: currentTeam,
          attempt,
        });
        nextTeamTurn(g);
      }
    }

    // ── NEXT ROUND (host) ─────────────────
    if (type === "next" && g) {
      await startNextRound(g);
    }
  });

  ws.on("close", () => {
    const g = games[ws.gameCode];
    if (!g || ws.role !== "player") return;
    // Remove from team members
    const team = g.teams[ws.teamId];
    if (team) {
      team.members = team.members.filter(m => m.id !== ws.id);
    }
  });
});

// ─────────────────────────────────────────
// GAME FLOW
// ─────────────────────────────────────────

async function startNextRound(g) {
  g.round++;
  if (g.round > g.totalRounds) return endGame(g);

  // Reset round scores
  Object.values(g.teams).forEach(t => t.roundScore = 0);
  g.guessedLetters = [];
  g.lastSpin = null;
  g.freeSpin = false;

  // Generate puzzle
  const usedPhrases = g.usedPhrases || [];
  const puzzle = await generatePuzzle(g.theme, g.round, usedPhrases);
  g.usedPhrases = [...usedPhrases, puzzle.phrase];

  g.currentPuzzle = {
    phrase: puzzle.phrase,
    category: puzzle.category,
    hint: puzzle.hint,
    revealed: puzzle.phrase.split("").map(c => c === " "), // spaces always revealed
    usedLetters: [],
  };

  g.phase = "spinning";
  g.currentTeamIndex = (g.round - 1) % g.teamOrder.length;

  broadcastAll(g, {
    type: "round-start",
    round: g.round,
    total: g.totalRounds,
    category: puzzle.category,
    hint: puzzle.hint,
    puzzleLength: puzzle.phrase.length,
    puzzle: sanitisePuzzle(g.currentPuzzle),
    activeTeam: g.teamOrder[g.currentTeamIndex],
    teams: g.teams,
    segments: WHEEL_SEGMENTS,
  });
}

function nextTeamTurn(g) {
  if (g.freeSpin) {
    g.freeSpin = false;
    g.phase = "spinning";
    const currentTeam = g.teamOrder[g.currentTeamIndex];
    broadcastAll(g, {
      type: "your-turn-spin",
      teamId: currentTeam,
      teamName: g.teams[currentTeam].name,
    });
    return;
  }

  g.currentTeamIndex = (g.currentTeamIndex + 1) % g.teamOrder.length;
  g.phase = "spinning";
  const nextTeam = g.teamOrder[g.currentTeamIndex];

  broadcastAll(g, {
    type: "your-turn-spin",
    teamId: nextTeam,
    teamName: g.teams[nextTeam].name,
    teams: g.teams,
  });
}

async function solvePuzzle(g, teamId, autoSolved) {
  const bonus = autoSolved ? 500 : 1000; // bonus for solving vs letters filling in
  g.teams[teamId].score += g.teams[teamId].roundScore + bonus;
  g.phase = "reveal";

  // Reveal full puzzle
  g.currentPuzzle.revealed = g.currentPuzzle.revealed.map(() => true);

  broadcastAll(g, {
    type: "puzzle-solved",
    teamId,
    teamName: g.teams[teamId].name,
    phrase: g.currentPuzzle.phrase,
    bonus,
    teams: g.teams,
  });

  // Auto next round after 8s
  setTimeout(() => startNextRound(g), 8000);
}

function endGame(g) {
  g.phase = "end";
  const sorted = Object.entries(g.teams)
    .map(([id, t]) => ({ id, name: t.name, score: t.score }))
    .sort((a, b) => b.score - a.score);

  broadcastAll(g, { type: "game-over", leaderboard: sorted });
}

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────

function sanitisePuzzle(p) {
  // Send revealed state but NOT the full phrase
  return {
    category: p.category,
    hint: p.hint,
    usedLetters: p.usedLetters,
    tiles: p.phrase.split("").map((c, i) => ({
      char: p.revealed[i] ? c : (c === " " ? " " : "_"),
      revealed: p.revealed[i],
      isSpace: c === " ",
    })),
  };
}

function broadcastAll(g, data) {
  if (g.tvSocket?.readyState === 1) g.tvSocket.send(json(data));
  wss.clients.forEach(ws => {
    if (ws.gameCode === g.gameCode && ws.role === "player" && ws.readyState === 1) {
      ws.send(json(data));
    }
  });
}

function json(data) { return JSON.stringify(data); }
function err(msg) { return json({ type: "error", message: msg }); }

// ─────────────────────────────────────────
server.listen(PORT, () => console.log(`🎡 Wheel of Fortune server on port ${PORT}`));
