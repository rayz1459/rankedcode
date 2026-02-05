const state = {
  token: localStorage.getItem("token"),
  user: null,
  currentMatchId: null,
  queuePoll: null
};

const authSection = document.getElementById("auth");
const lobbySection = document.getElementById("lobby");
const matchSection = document.getElementById("match");
const session = document.getElementById("session");

const registerForm = document.getElementById("registerForm");
const loginForm = document.getElementById("loginForm");
const createMatchBtn = document.getElementById("createMatch");
const joinMatchBtn = document.getElementById("joinMatch");
const joinQueueBtn = document.getElementById("joinQueue");
const leaveQueueBtn = document.getElementById("leaveQueue");
const queueStatus = document.getElementById("queueStatus");
const leaderboard = document.getElementById("leaderboard");
const recentMatches = document.getElementById("recentMatches");
const myMatches = document.getElementById("myMatches");
const statsSummary = document.getElementById("statsSummary");
const matchMeta = document.getElementById("matchMeta");
const leetcodeLink = document.getElementById("leetcodeLink");
const runtimeInput = document.getElementById("runtimeInput");
const submitRuntime = document.getElementById("submitRuntime");
const matchStatus = document.getElementById("matchStatus");
const matchPlayers = document.getElementById("matchPlayers");

function setToken(token) {
  state.token = token;
  if (token) {
    localStorage.setItem("token", token);
  } else {
    localStorage.removeItem("token");
  }
}

function show(section) {
  [authSection, lobbySection, matchSection].forEach((el) => el.classList.add("hidden"));
  section.classList.remove("hidden");
}

function updateSession() {
  if (state.user) {
    session.innerHTML = `Signed in as <strong>${state.user.email}</strong> · Elo ${state.user.elo} <button id="logout">Logout</button>`;
    document.getElementById("logout").addEventListener("click", () => {
      state.user = null;
      setToken(null);
      stopQueuePoll();
      show(authSection);
      session.textContent = "";
    });
  } else {
    session.textContent = "";
  }
}

async function api(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };
  if (state.token) {
    headers.Authorization = `Bearer ${state.token}`;
  }
  const response = await fetch(path, { ...options, headers });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || "Request failed");
  }
  return response.json();
}

async function bootstrap() {
  if (state.token) {
    try {
      const { user } = await api("/api/me");
      state.user = user;
      show(lobbySection);
      updateSession();
      await loadLeaderboard();
      await loadStats();
      await loadRecentMatches();
      await loadMyMatches();
      await resumeQueueState();
      return;
    } catch (error) {
      setToken(null);
    }
  }
  show(authSection);
}

registerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(registerForm);
  try {
    const payload = await api("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        email: formData.get("email"),
        password: formData.get("password")
      })
    });
    setToken(payload.token);
    state.user = payload.user;
    show(lobbySection);
    updateSession();
    await loadLeaderboard();
    await loadStats();
    await loadRecentMatches();
    await loadMyMatches();
    await resumeQueueState();
  } catch (error) {
    alert(error.message);
  }
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(loginForm);
  try {
    const payload = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: formData.get("email"),
        password: formData.get("password")
      })
    });
    setToken(payload.token);
    state.user = payload.user;
    show(lobbySection);
    updateSession();
    await loadLeaderboard();
    await loadStats();
    await loadRecentMatches();
    await loadMyMatches();
    await resumeQueueState();
  } catch (error) {
    alert(error.message);
  }
});

joinQueueBtn.addEventListener("click", async () => {
  try {
    const difficulty = document.getElementById("queueDifficulty").value;
    const payload = await api("/api/queue/join", {
      method: "POST",
      body: JSON.stringify({ difficulty: difficulty || null })
    });
    if (payload.status === "matched") {
      stopQueuePoll();
      state.currentMatchId = payload.match.id;
      await openMatch(payload.match.id);
      return;
    }
    queueStatus.textContent = `Searching for ${payload.difficulty || "Any"} opponents...`;
    setQueueControls(true);
    startQueuePoll();
  } catch (error) {
    alert(error.message);
  }
});

leaveQueueBtn.addEventListener("click", async () => {
  try {
    await api("/api/queue/leave", { method: "POST" });
    stopQueuePoll();
    queueStatus.textContent = "Not in queue.";
    setQueueControls(false);
  } catch (error) {
    alert(error.message);
  }
});

createMatchBtn.addEventListener("click", async () => {
  try {
    const difficulty = document.getElementById("difficulty").value;
    const payload = await api("/api/matches", {
      method: "POST",
      body: JSON.stringify({ difficulty: difficulty || null })
    });
    state.currentMatchId = payload.match.id;
    await openMatch(state.currentMatchId);
  } catch (error) {
    alert(error.message);
  }
});

joinMatchBtn.addEventListener("click", async () => {
  const matchId = document.getElementById("joinMatchId").value.trim();
  if (!matchId) return;
  try {
    await api(`/api/matches/${matchId}/join`, { method: "POST" });
    state.currentMatchId = matchId;
    await openMatch(matchId);
  } catch (error) {
    alert(error.message);
  }
});

submitRuntime.addEventListener("click", async () => {
  const runtime = Number(runtimeInput.value);
  if (!runtime || runtime <= 0) {
    alert("Enter a runtime in ms.");
    return;
  }
  try {
    const payload = await api(`/api/matches/${state.currentMatchId}/submit`, {
      method: "POST",
      body: JSON.stringify({ runtimeMs: runtime })
    });
    if (payload.status === "waiting") {
      matchStatus.textContent = "Waiting for opponent to submit.";
    } else {
      matchStatus.textContent = `Match complete. Winner: ${payload.winnerId || "draw"}. K=${payload.k}`;
      await refreshMe();
      await loadLeaderboard();
      await loadStats();
      await loadRecentMatches();
      await loadMyMatches();
    }
  } catch (error) {
    alert(error.message);
  }
});

async function refreshMe() {
  const { user } = await api("/api/me");
  state.user = user;
  updateSession();
}

function setQueueControls(queued) {
  joinQueueBtn.disabled = queued;
  leaveQueueBtn.disabled = !queued;
}

function startQueuePoll() {
  if (state.queuePoll) return;
  state.queuePoll = setInterval(async () => {
    try {
      const { match } = await api("/api/me/active-match");
      if (match) {
        stopQueuePoll();
        state.currentMatchId = match.id;
        await openMatch(match.id);
        return;
      }
      const { queue } = await api("/api/queue/status");
      if (!queue) {
        stopQueuePoll();
        queueStatus.textContent = "Not in queue.";
        setQueueControls(false);
        return;
      }
      queueStatus.textContent = `Searching for ${queue.desired_difficulty || "Any"} opponents...`;
      setQueueControls(true);
    } catch (error) {
      stopQueuePoll();
    }
  }, 3000);
}

function stopQueuePoll() {
  if (state.queuePoll) {
    clearInterval(state.queuePoll);
    state.queuePoll = null;
  }
}

async function loadLeaderboard() {
  const payload = await api("/api/leaderboard");
  leaderboard.innerHTML = payload.users
    .map((u, index) => `<li>#${index + 1} ${u.email} · Elo ${u.elo}</li>`)
    .join("");
}

async function loadStats() {
  const payload = await api("/api/me/stats");
  const stats = payload.stats || {};
  const winRate = stats.total ? Math.round((stats.wins / stats.total) * 100) : 0;
  const avgRuntime = stats.avg_runtime ? `${Math.round(stats.avg_runtime)} ms` : "—";
  statsSummary.innerHTML = `
    <div><strong>${stats.total || 0}</strong> games</div>
    <div><strong>${stats.wins || 0}</strong> wins · <strong>${stats.losses || 0}</strong> losses</div>
    <div><strong>${winRate}%</strong> win rate</div>
    <div><strong>${avgRuntime}</strong> avg runtime</div>
  `;
}

async function loadRecentMatches() {
  const payload = await api("/api/matches/recent");
  recentMatches.innerHTML = payload.matches
    .map(
      (m) =>
        `<li><strong>${m.difficulty}</strong> · ${m.problem_title} · ${m.status} · ${new Date(m.created_at).toLocaleString()}</li>`
    )
    .join("");
}

async function loadMyMatches() {
  const payload = await api("/api/me/matches");
  myMatches.innerHTML = payload.matches
    .map((m) => {
      const delta = m.elo_after != null ? m.elo_after - m.elo_before : 0;
      const deltaLabel = m.elo_after != null ? `${delta >= 0 ? "+" : ""}${delta}` : "—";
      const result = m.is_winner == null ? "pending" : m.is_winner ? "win" : "loss";
      return `<li>${result} · ${m.problem_title} · ${m.difficulty} · Δ${deltaLabel}</li>`;
    })
    .join("");
}

async function resumeQueueState() {
  try {
    const { match } = await api("/api/me/active-match");
    if (match) {
      state.currentMatchId = match.id;
      await openMatch(match.id);
      return;
    }
    const { queue } = await api("/api/queue/status");
    if (queue) {
      queueStatus.textContent = `Searching for ${queue.desired_difficulty || "Any"} opponents...`;
      setQueueControls(true);
      startQueuePoll();
    } else {
      queueStatus.textContent = "Not in queue.";
      setQueueControls(false);
    }
  } catch (error) {
    queueStatus.textContent = "Not in queue.";
    setQueueControls(false);
  }
}

async function openMatch(matchId) {
  show(matchSection);
  const payload = await api(`/api/matches/${matchId}`);
  const match = payload.match;
  const players = payload.players || [];
  const me = players.find((p) => p.user_id === state.user?.id);
  const opponent = players.find((p) => p.user_id !== state.user?.id);
  matchMeta.innerHTML = `Match <strong>${match.id}</strong> · ${match.difficulty} · ${match.problem_title}`;
  leetcodeLink.href = `https://leetcode.com/problems/${match.problem_slug}/`;
  matchPlayers.innerHTML = `
    <div><strong>You:</strong> ${me ? me.email : "—"}</div>
    <div><strong>Opponent:</strong> ${opponent ? opponent.email : "Waiting..."}</div>
  `;
  matchStatus.textContent = match.status === "waiting"
    ? "Waiting for opponent to join."
    : "Solve the problem and submit your runtime.";
}

bootstrap();
