import express from "express";
import cors from "cors";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import fetch from "node-fetch";
import { v4 as uuid } from "uuid";
import { getDb } from "./db.js";
import { computeEloUpdate } from "./elo.js";

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_change_me";

app.use(cors());
app.use(express.json());
app.use(express.static(new URL("../public", import.meta.url).pathname));

function createToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, {
    expiresIn: "7d"
  });
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: "Missing token" });
  }
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch (error) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/api/auth/register", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password required" });
  }
  const db = await getDb();
  const existing = await db.get("SELECT id FROM users WHERE email = ?", email);
  if (existing) {
    return res.status(409).json({ error: "Email already registered" });
  }
  const password_hash = await bcrypt.hash(password, 10);
  const user = {
    id: uuid(),
    email,
    password_hash,
    created_at: new Date().toISOString()
  };
  await db.run(
    "INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)",
    user.id,
    user.email,
    user.password_hash,
    user.created_at
  );
  const token = createToken(user);
  res.json({ token, user: { id: user.id, email: user.email, elo: 1200 } });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password required" });
  }
  const db = await getDb();
  const user = await db.get(
    "SELECT id, email, password_hash, elo FROM users WHERE email = ?",
    email
  );
  if (!user) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  const token = createToken(user);
  res.json({ token, user: { id: user.id, email: user.email, elo: user.elo } });
});

app.get("/api/me", authMiddleware, async (req, res) => {
  const db = await getDb();
  const user = await db.get(
    "SELECT id, email, elo, created_at FROM users WHERE id = ?",
    req.user.sub
  );
  res.json({ user });
});

const leetCodeCache = {
  timestamp: 0,
  questions: []
};

async function fetchLeetCodeQuestions() {
  const now = Date.now();
  if (leetCodeCache.questions.length > 0 && now - leetCodeCache.timestamp < 1000 * 60 * 10) {
    return leetCodeCache.questions;
  }
  const query = `
    query problemsetQuestionList($categorySlug: String, $limit: Int, $skip: Int, $filters: QuestionListFilterInput) {
      problemsetQuestionList: questionList(
        categorySlug: $categorySlug
        limit: $limit
        skip: $skip
        filters: $filters
      ) {
        total: totalNum
        questions: data {
          title
          titleSlug
          difficulty
        }
      }
    }
  `;
  const response = await fetch("https://leetcode.com/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "RankedLeetCode/0.1"
    },
    body: JSON.stringify({
      query,
      variables: {
        categorySlug: "all-code-essentials",
        skip: 0,
        limit: 50,
        filters: {}
      }
    })
  });
  if (!response.ok) {
    throw new Error("Failed to fetch from LeetCode");
  }
  const payload = await response.json();
  const questions = payload?.data?.problemsetQuestionList?.questions || [];
  leetCodeCache.questions = questions;
  leetCodeCache.timestamp = now;
  return questions;
}

async function pickQuestion({ difficulty }) {
  const questions = await fetchLeetCodeQuestions();
  const filtered = difficulty
    ? questions.filter((q) => q.difficulty.toLowerCase() === String(difficulty).toLowerCase())
    : questions;
  if (!filtered.length) {
    return null;
  }
  return filtered[Math.floor(Math.random() * filtered.length)];
}

async function findActiveMatchForUser(db, userId) {
  return db.get(
    `SELECT m.id FROM matches m
     JOIN match_players mp ON mp.match_id = m.id
     WHERE mp.user_id = ? AND m.status IN ('waiting', 'active')
     LIMIT 1`,
    userId
  );
}

app.get("/api/problems/random", authMiddleware, async (req, res) => {
  try {
    const difficulty = req.query.difficulty;
    const pick = await pickQuestion({ difficulty });
    if (!pick) {
      return res.status(404).json({ error: "No questions found" });
    }
    res.json({ question: pick });
  } catch (error) {
    res.status(502).json({ error: "LeetCode API error" });
  }
});

app.get("/api/leaderboard", async (req, res) => {
  const db = await getDb();
  const users = await db.all(
    "SELECT id, email, elo, created_at FROM users ORDER BY elo DESC LIMIT 50"
  );
  res.json({ users });
});

app.get("/api/me/stats", authMiddleware, async (req, res) => {
  const db = await getDb();
  const stats = await db.get(
    `
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN mp.is_winner = 1 THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN mp.is_winner = 0 THEN 1 ELSE 0 END) AS losses,
      AVG(mp.runtime_ms) AS avg_runtime
    FROM match_players mp
    JOIN matches m ON m.id = mp.match_id
    WHERE mp.user_id = ? AND m.status = 'complete'
    `,
    req.user.sub
  );
  res.json({ stats: stats || { total: 0, wins: 0, losses: 0, avg_runtime: null } });
});

app.get("/api/me/active-match", authMiddleware, async (req, res) => {
  const db = await getDb();
  const match = await db.get(
    `
    SELECT m.*
    FROM matches m
    JOIN match_players mp ON mp.match_id = m.id
    WHERE mp.user_id = ? AND m.status IN ('waiting', 'active')
    ORDER BY m.created_at DESC
    LIMIT 1
    `,
    req.user.sub
  );
  res.json({ match: match || null });
});

app.get("/api/me/matches", authMiddleware, async (req, res) => {
  const db = await getDb();
  const matches = await db.all(
    `
    SELECT
      m.id,
      m.problem_slug,
      m.problem_title,
      m.difficulty,
      m.status,
      m.created_at,
      mp.elo_before,
      mp.elo_after,
      mp.runtime_ms,
      mp.is_winner
    FROM matches m
    JOIN match_players mp ON mp.match_id = m.id
    WHERE mp.user_id = ?
    ORDER BY m.created_at DESC
    LIMIT 20
    `,
    req.user.sub
  );
  res.json({ matches });
});

app.get("/api/matches/recent", authMiddleware, async (req, res) => {
  const db = await getDb();
  const matches = await db.all(
    `
    SELECT
      m.id,
      m.problem_slug,
      m.problem_title,
      m.difficulty,
      m.status,
      m.created_at
    FROM matches m
    ORDER BY m.created_at DESC
    LIMIT 10
    `
  );
  res.json({ matches });
});

app.post("/api/queue/join", authMiddleware, async (req, res) => {
  const { difficulty } = req.body || {};
  const db = await getDb();

  const activeMatch = await findActiveMatchForUser(db, req.user.sub);
  if (activeMatch) {
    return res.status(409).json({ error: "Finish your current match before queueing." });
  }

  const existing = await db.get(
    "SELECT id, desired_difficulty FROM matchmaking_queue WHERE user_id = ?",
    req.user.sub
  );
  if (existing) {
    return res.json({ status: "queued", queueId: existing.id, difficulty: existing.desired_difficulty });
  }

  let opponent = null;
  if (difficulty) {
    opponent = await db.get(
      `
      SELECT id, user_id, desired_difficulty
      FROM matchmaking_queue
      WHERE user_id != ? AND (desired_difficulty = ? OR desired_difficulty IS NULL)
      ORDER BY created_at ASC
      LIMIT 1
      `,
      req.user.sub,
      difficulty
    );
  } else {
    opponent = await db.get(
      `
      SELECT id, user_id, desired_difficulty
      FROM matchmaking_queue
      WHERE user_id != ?
      ORDER BY created_at ASC
      LIMIT 1
      `,
      req.user.sub
    );
  }

  if (!opponent) {
    const queueId = uuid();
    await db.run(
      "INSERT INTO matchmaking_queue (id, user_id, desired_difficulty, created_at) VALUES (?, ?, ?, ?)",
      queueId,
      req.user.sub,
      difficulty || null,
      new Date().toISOString()
    );
    return res.json({ status: "queued", queueId, difficulty: difficulty || null });
  }

  const opponentActive = await findActiveMatchForUser(db, opponent.user_id);
  if (opponentActive) {
    await db.run("DELETE FROM matchmaking_queue WHERE id = ?", opponent.id);
    const queueId = uuid();
    await db.run(
      "INSERT INTO matchmaking_queue (id, user_id, desired_difficulty, created_at) VALUES (?, ?, ?, ?)",
      queueId,
      req.user.sub,
      difficulty || null,
      new Date().toISOString()
    );
    return res.json({ status: "queued", queueId, difficulty: difficulty || null });
  }

  const chosenDifficulty = difficulty || opponent.desired_difficulty || null;
  const question = await pickQuestion({ difficulty: chosenDifficulty });
  if (!question) {
    return res.status(404).json({ error: "Problem not found" });
  }

  const match = {
    id: uuid(),
    problem_slug: question.titleSlug,
    problem_title: question.title,
    difficulty: question.difficulty,
    status: "active",
    created_at: new Date().toISOString()
  };

  const [userA, userB] = await Promise.all([
    db.get("SELECT id, elo FROM users WHERE id = ?", req.user.sub),
    db.get("SELECT id, elo FROM users WHERE id = ?", opponent.user_id)
  ]);

  await db.run("BEGIN");
  try {
    await db.run(
      "INSERT INTO matches (id, problem_slug, problem_title, difficulty, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      match.id,
      match.problem_slug,
      match.problem_title,
      match.difficulty,
      match.status,
      match.created_at
    );
    await db.run(
      "INSERT INTO match_players (id, match_id, user_id, elo_before) VALUES (?, ?, ?, ?)",
      uuid(),
      match.id,
      userA.id,
      userA.elo
    );
    await db.run(
      "INSERT INTO match_players (id, match_id, user_id, elo_before) VALUES (?, ?, ?, ?)",
      uuid(),
      match.id,
      userB.id,
      userB.elo
    );
    await db.run(
      "DELETE FROM matchmaking_queue WHERE id = ? OR user_id = ?",
      opponent.id,
      req.user.sub
    );
    await db.run("COMMIT");
  } catch (error) {
    await db.run("ROLLBACK");
    throw error;
  }

  res.json({ status: "matched", match });
});

app.post("/api/queue/leave", authMiddleware, async (req, res) => {
  const db = await getDb();
  await db.run("DELETE FROM matchmaking_queue WHERE user_id = ?", req.user.sub);
  res.json({ status: "left" });
});

app.get("/api/queue/status", authMiddleware, async (req, res) => {
  const db = await getDb();
  const queue = await db.get(
    "SELECT id, desired_difficulty, created_at FROM matchmaking_queue WHERE user_id = ?",
    req.user.sub
  );
  res.json({ queue });
});

app.post("/api/matches", authMiddleware, async (req, res) => {
  const { problemSlug, difficulty } = req.body || {};
  const db = await getDb();
  let question = null;

  if (problemSlug) {
    const questions = await fetchLeetCodeQuestions();
    question = questions.find((q) => q.titleSlug === problemSlug);
  } else {
    question = await pickQuestion({ difficulty });
  }

  if (!question) {
    return res.status(404).json({ error: "Problem not found" });
  }

  const match = {
    id: uuid(),
    problem_slug: question.titleSlug,
    problem_title: question.title,
    difficulty: question.difficulty,
    status: "waiting",
    created_at: new Date().toISOString()
  };

  const user = await db.get("SELECT id, elo FROM users WHERE id = ?", req.user.sub);
  await db.run("DELETE FROM matchmaking_queue WHERE user_id = ?", req.user.sub);
  await db.run(
    "INSERT INTO matches (id, problem_slug, problem_title, difficulty, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    match.id,
    match.problem_slug,
    match.problem_title,
    match.difficulty,
    match.status,
    match.created_at
  );
  await db.run(
    "INSERT INTO match_players (id, match_id, user_id, elo_before) VALUES (?, ?, ?, ?)",
    uuid(),
    match.id,
    user.id,
    user.elo
  );

  res.json({ match });
});

app.post("/api/matches/:id/join", authMiddleware, async (req, res) => {
  const db = await getDb();
  const match = await db.get("SELECT * FROM matches WHERE id = ?", req.params.id);
  if (!match) {
    return res.status(404).json({ error: "Match not found" });
  }
  if (match.status !== "waiting") {
    return res.status(400).json({ error: "Match already started" });
  }
  const existing = await db.get(
    "SELECT id FROM match_players WHERE match_id = ? AND user_id = ?",
    match.id,
    req.user.sub
  );
  if (existing) {
    return res.json({ match });
  }
  const count = await db.get(
    "SELECT COUNT(*) as count FROM match_players WHERE match_id = ?",
    match.id
  );
  if (count.count >= 2) {
    return res.status(400).json({ error: "Match full" });
  }
  const user = await db.get("SELECT id, elo FROM users WHERE id = ?", req.user.sub);
  await db.run(
    "INSERT INTO match_players (id, match_id, user_id, elo_before) VALUES (?, ?, ?, ?)",
    uuid(),
    match.id,
    user.id,
    user.elo
  );
  await db.run("UPDATE matches SET status = ? WHERE id = ?", "active", match.id);
  res.json({ match: { ...match, status: "active" } });
});

app.get("/api/matches/:id", authMiddleware, async (req, res) => {
  const db = await getDb();
  const match = await db.get("SELECT * FROM matches WHERE id = ?", req.params.id);
  if (!match) {
    return res.status(404).json({ error: "Match not found" });
  }
  const players = await db.all(
    `
    SELECT mp.user_id, u.email, mp.elo_before, mp.elo_after, mp.runtime_ms, mp.submitted_at, mp.is_winner
    FROM match_players mp
    JOIN users u ON u.id = mp.user_id
    WHERE mp.match_id = ?
    `,
    match.id
  );
  res.json({ match, players });
});

app.post("/api/matches/:id/submit", authMiddleware, async (req, res) => {
  const { runtimeMs } = req.body || {};
  if (!runtimeMs || runtimeMs <= 0) {
    return res.status(400).json({ error: "runtimeMs must be positive" });
  }
  const db = await getDb();
  const match = await db.get("SELECT * FROM matches WHERE id = ?", req.params.id);
  if (!match) {
    return res.status(404).json({ error: "Match not found" });
  }
  if (match.status === "complete") {
    return res.status(400).json({ error: "Match already complete" });
  }

  const player = await db.get(
    "SELECT id FROM match_players WHERE match_id = ? AND user_id = ?",
    match.id,
    req.user.sub
  );
  if (!player) {
    return res.status(403).json({ error: "Not part of this match" });
  }

  await db.run(
    "UPDATE match_players SET runtime_ms = ?, submitted_at = ? WHERE match_id = ? AND user_id = ?",
    runtimeMs,
    new Date().toISOString(),
    match.id,
    req.user.sub
  );

  const players = await db.all(
    "SELECT user_id, elo_before, runtime_ms FROM match_players WHERE match_id = ?",
    match.id
  );

  if (players.length < 2 || players.some((p) => p.runtime_ms == null)) {
    return res.json({ status: "waiting" });
  }

  const [a, b] = players;
  let scoreA = 0.5;
  let scoreB = 0.5;
  let winnerId = null;

  if (a.runtime_ms < b.runtime_ms) {
    scoreA = 1;
    scoreB = 0;
    winnerId = a.user_id;
  } else if (b.runtime_ms < a.runtime_ms) {
    scoreA = 0;
    scoreB = 1;
    winnerId = b.user_id;
  }

  const { newEloA, newEloB, k } = computeEloUpdate({
    eloA: a.elo_before,
    eloB: b.elo_before,
    scoreA,
    scoreB,
    runtimeA: a.runtime_ms,
    runtimeB: b.runtime_ms
  });

  await db.run("BEGIN");
  try {
    await db.run(
      "UPDATE match_players SET elo_after = ?, is_winner = ? WHERE match_id = ? AND user_id = ?",
      newEloA,
      a.user_id === winnerId ? 1 : 0,
      match.id,
      a.user_id
    );
    await db.run(
      "UPDATE match_players SET elo_after = ?, is_winner = ? WHERE match_id = ? AND user_id = ?",
      newEloB,
      b.user_id === winnerId ? 1 : 0,
      match.id,
      b.user_id
    );
    await db.run("UPDATE users SET elo = ? WHERE id = ?", newEloA, a.user_id);
    await db.run("UPDATE users SET elo = ? WHERE id = ?", newEloB, b.user_id);
    await db.run("UPDATE matches SET status = ? WHERE id = ?", "complete", match.id);
    await db.run("COMMIT");
  } catch (error) {
    await db.run("ROLLBACK");
    throw error;
  }

  res.json({ status: "complete", winnerId, k });
});

app.listen(PORT, () => {
  console.log(`RankedLeetCode running on http://localhost:${PORT}`);
});
