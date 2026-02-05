const state = {
  token: localStorage.getItem("token"),
  user: null,
  currentMatchId: null,
  queuePoll: null,
  matchPoll: null,
  currentProblem: null,
  lastRunTimeMs: null
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
const submitSolutionBtn = document.getElementById("submitSolution");
const matchStatus = document.getElementById("matchStatus");
const matchPlayers = document.getElementById("matchPlayers");
const runtimeDisplay = document.getElementById("runtimeDisplay");
const forfeitBtn = document.getElementById("forfeitBtn");
const testCodeBtn = document.getElementById("testCode");
const problemTitleEl = document.getElementById("problemTitle");
const problemDifficultyEl = document.getElementById("problemDifficulty");
const problemContentEl = document.getElementById("problemContent");
const codeEditor = document.getElementById("codeEditor");
const languageSelect = document.getElementById("languageSelect");
const runCodeBtn = document.getElementById("runCode");
const testResultEl = document.getElementById("testResult");
const resultModal = document.getElementById("resultModal");
const resultModalTitle = document.getElementById("resultModalTitle");
const resultModalElo = document.getElementById("resultModalElo");
const resultModalLobbyBtn = document.getElementById("resultModalLobby");
const resultModalQueueBtn = document.getElementById("resultModalQueue");

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

function showResultModal({ isWinner, eloDelta, ranked }) {
  if (resultModalTitle) {
    if (isWinner === true) resultModalTitle.textContent = "You won!";
    else if (isWinner === false) resultModalTitle.textContent = "You lost";
    else resultModalTitle.textContent = "Draw";
  }
  if (resultModalElo) {
    if (ranked === false || ranked === 0) resultModalElo.textContent = "Unranked — no Elo change.";
    else if (eloDelta != null && eloDelta !== 0) resultModalElo.textContent = (eloDelta > 0 ? "+" : "") + eloDelta + " Elo";
    else resultModalElo.textContent = "No Elo change.";
  }
  if (resultModal) resultModal.classList.remove("hidden");
}

function hideResultModal() {
  if (resultModal) resultModal.classList.add("hidden");
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
    const msg = error.error || error.detail || `Request failed (${response.status})`;
    throw new Error(msg);
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

function runPayload(lang, code, stdin) {
  const payload = { language: lang, code, stdin: stdin ?? "" };
  const problem = state.currentProblem;
  if (problem?.titleSlug) payload.problemSlug = problem.titleSlug;
  if (problem?.metaData) payload.metaData = problem.metaData;
  return payload;
}

runCodeBtn?.addEventListener("click", async () => {
  const code = codeEditor?.value?.trim();
  if (!code) { if (testResultEl) testResultEl.textContent = "No code to run."; testResultEl?.classList.remove("empty"); return; }
  const lang = languageSelect?.value || "javascript";
  if (testResultEl) { testResultEl.textContent = "Running..."; testResultEl.classList.remove("empty"); }
  try {
    const result = await api("/api/run", { method: "POST", body: JSON.stringify(runPayload(lang, code, "")) });
    let text = result.stdout || ""; if (result.stderr) text += (text ? "\n" : "") + "stderr:\n" + result.stderr;
    if (!text) text = result.output || "(no output)";
    if (result.runTimeMs != null) text += `\n\n--- Run time: ${result.runTimeMs} ms ---`;
    if (testResultEl) testResultEl.textContent = text || "(no output)";
    if (result.runTimeMs != null) { state.lastRunTimeMs = result.runTimeMs; if (runtimeDisplay) runtimeDisplay.textContent = `Last run: ${result.runTimeMs} ms`; }
  } catch (err) { if (testResultEl) testResultEl.textContent = "Error: " + (err.message || "Run failed"); }
});

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s ?? "";
  return div.innerHTML;
}

function renderTestResults(payload) {
  if (!testResultEl) return;
  testResultEl.classList.remove("empty");
  if (payload.error && payload.results?.length === 0) {
    testResultEl.innerHTML = `<div class="test-summary test-summary--none">${escapeHtml(payload.error)}</div>`;
    return;
  }
  const { results = [], summary = {} } = payload;
  const { total, passed, failed } = summary;
  const allPassed = total > 0 && failed === 0;
  const summaryClass = allPassed ? "test-summary--pass" : "test-summary--fail";
  let html = `<div class="test-summary ${summaryClass}">`;
  html += `<span class="test-summary-count">${passed} / ${total}</span> test cases passed`;
  if (total > 0 && results.some((r) => r.runTimeMs != null)) {
    const maxMs = Math.max(...results.map((r) => r.runTimeMs ?? 0));
    html += ` <span class="test-summary-runtime"> · Runtime: ${maxMs} ms</span>`;
  }
  html += "</div>";
  html += '<div class="test-cases">';
  results.forEach((r) => {
    const statusClass = r.passed ? "test-case--pass" : "test-case--fail";
    const statusLabel = r.passed ? "Passed" : "Wrong Answer";
    const icon = r.passed ? "✓" : "✗";
    html += `<div class="test-case ${statusClass}" data-test-index="${r.index}">`;
    html += `<button type="button" class="test-case-header" aria-expanded="false" data-test-toggle="${r.index}">`;
    html += `<span class="test-case-icon">${icon}</span>`;
    html += `<span class="test-case-label">Test case ${r.index}</span>`;
    html += `<span class="test-case-status">${statusLabel}</span>`;
    if (r.runTimeMs != null) html += `<span class="test-case-ms">${r.runTimeMs} ms</span>`;
    html += "</button>";
    html += '<div class="test-case-details" hidden>';
    html += `<div class="test-case-row"><span class="test-case-key">Input:</span><pre class="test-case-value">${escapeHtml(r.stdin || "(none)")}</pre></div>`;
    html += `<div class="test-case-row"><span class="test-case-key">Expected:</span><pre class="test-case-value">${escapeHtml(r.expected || "(none)")}</pre></div>`;
    html += `<div class="test-case-row"><span class="test-case-key">Output:</span><pre class="test-case-value">${escapeHtml(r.actual ?? r.error ?? "(no output)")}</pre></div>`;
    if (r.stderr) html += `<div class="test-case-row"><span class="test-case-key">stderr:</span><pre class="test-case-value test-case-value--stderr">${escapeHtml(r.stderr)}</pre></div>`;
    if (r.error && !r.actual) html += `<div class="test-case-row"><span class="test-case-key">Error:</span><pre class="test-case-value test-case-value--error">${escapeHtml(r.error)}</pre></div>`;
    html += "</div></div>";
  });
  html += "</div>";
  testResultEl.innerHTML = html;
  testResultEl.querySelectorAll(".test-case-header").forEach((btn) => {
    btn.addEventListener("click", () => {
      const details = btn.closest(".test-case")?.querySelector(".test-case-details");
      if (!details) return;
      const open = details.hidden;
      details.hidden = !open;
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    });
  });
  const lastRunMs = results.length && results.some((r) => r.runTimeMs != null) ? Math.max(...results.map((r) => r.runTimeMs ?? 0)) : null;
  if (lastRunMs != null) {
    state.lastRunTimeMs = lastRunMs;
    if (runtimeDisplay) runtimeDisplay.textContent = `Last run: ${lastRunMs} ms`;
  }
}

testCodeBtn?.addEventListener("click", async () => {
  const code = codeEditor?.value?.trim();
  if (!code) { if (testResultEl) testResultEl.textContent = "No code to test."; testResultEl?.classList.remove("empty"); return; }
  const lang = languageSelect?.value || "javascript";
  const problem = state.currentProblem;
  const payload = { language: lang, code };
  if (problem?.titleSlug) payload.problemSlug = problem.titleSlug;
  if (problem?.metaData) payload.metaData = problem.metaData;
  if (problem?.exampleTestcases) payload.exampleTestcases = problem.exampleTestcases;
  if (testResultEl) { testResultEl.textContent = "Running tests..."; testResultEl.classList.remove("empty"); }
  try {
    const result = await api("/api/run-tests", { method: "POST", body: JSON.stringify(payload) });
    renderTestResults(result);
  } catch (err) {
    if (testResultEl) {
      testResultEl.textContent = "Error: " + (err.message || "Test failed");
      testResultEl.classList.remove("empty");
    }
  }
});

languageSelect?.addEventListener("change", () => {
  if (!state.currentProblem?.codeSnippets || !Array.isArray(state.currentProblem.codeSnippets)) return;
  const lang = languageSelect.value;
  const snippet = state.currentProblem.codeSnippets.find((s) => s.langSlug === lang || (s.lang && s.lang.toLowerCase() === lang.toLowerCase()));
  if (snippet?.code && codeEditor) codeEditor.value = snippet.code;
});

submitSolutionBtn?.addEventListener("click", async () => {
  const code = codeEditor?.value?.trim();
  if (!code) { alert("Write your solution first."); return; }
  const lang = languageSelect?.value || "javascript";
  if (matchStatus) matchStatus.textContent = "Running your solution...";
  let runtimeMs = state.lastRunTimeMs;
  if (runtimeMs == null || runtimeMs <= 0) {
    try {
      const runResult = await api("/api/run", { method: "POST", body: JSON.stringify(runPayload(lang, code, "")) });
      runtimeMs = runResult.runTimeMs;
      if (runtimeMs != null) { state.lastRunTimeMs = runtimeMs; if (runtimeDisplay) runtimeDisplay.textContent = `Last run: ${runtimeMs} ms`; }
    } catch (err) { if (matchStatus) matchStatus.textContent = ""; alert("Run failed. Fix your code and try again: " + (err.message || "")); return; }
  }
  if (!runtimeMs || runtimeMs <= 0) { if (matchStatus) matchStatus.textContent = ""; alert("Could not measure runtime. Run or Test your code first."); return; }
  try {
    const payload = await api(`/api/matches/${state.currentMatchId}/submit`, { method: "POST", body: JSON.stringify({ runtimeMs }) });
    if (matchStatus) {
      if (payload.status === "waiting") matchStatus.textContent = "Waiting for opponent to submit.";
      else {
        stopMatchPoll();
        state.currentMatchId = null;
        await refreshMe();
        await loadLeaderboard();
        await loadStats();
        await loadRecentMatches();
        await loadMyMatches();
        showResultModal({ isWinner: payload.isWinner, eloDelta: payload.eloDelta, ranked: payload.ranked });
      }
    }
  } catch (error) { if (matchStatus) matchStatus.textContent = ""; alert(error.message); }
});

resultModalLobbyBtn?.addEventListener("click", () => {
  hideResultModal();
  show(lobbySection);
});

resultModalQueueBtn?.addEventListener("click", async () => {
  hideResultModal();
  show(lobbySection);
  const difficulty = document.getElementById("queueDifficulty")?.value || "";
  try {
    const payload = await api("/api/queue/join", { method: "POST", body: JSON.stringify({ difficulty: difficulty || null }) });
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

forfeitBtn?.addEventListener("click", async () => {
  if (!confirm("Forfeit this match? You will lose Elo if it's a ranked match.")) return;
  try {
    const payload = await api(`/api/matches/${state.currentMatchId}/forfeit`, { method: "POST" });
    stopMatchPoll();
    state.currentMatchId = null;
    show(lobbySection);
    if (payload.status === "forfeited") {
      await refreshMe();
      await loadLeaderboard();
      await loadStats();
      await loadRecentMatches();
      await loadMyMatches();
    }
  } catch (error) { alert(error.message); }
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
  if (state.queuePoll) { clearInterval(state.queuePoll); state.queuePoll = null; }
}

function stopMatchPoll() {
  if (state.matchPoll) { clearInterval(state.matchPoll); state.matchPoll = null; }
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

function safeSetText(el, text) { if (el) el.textContent = text; }
function safeSetHtml(el, html) { if (el) el.innerHTML = html; }
function safeSetValue(el, value) { if (el) el.value = value != null ? String(value) : ""; }

function getSnippetForLang(problem, lang) {
  const snippets = problem?.codeSnippets;
  if (!Array.isArray(snippets) || snippets.length === 0) return null;
  const slug = String(lang).toLowerCase();
  return snippets.find((s) => s.langSlug === slug || (s.lang && s.lang.toLowerCase() === slug)) || snippets.find((s) => s.langSlug === "javascript") || snippets[0];
}

async function openMatch(matchId) {
  try {
    show(matchSection);
    const payload = await api(`/api/matches/${matchId}`);
    const match = payload?.match;
    if (!match) { alert("Match not found."); return; }
    const players = payload.players || [];
    const me = players.find((p) => p.user_id === state.user?.id);
    const opponent = players.find((p) => p.user_id !== state.user?.id);
    const rankedLabel = match.ranked === 0 ? " · Unranked" : "";
    if (matchMeta) matchMeta.innerHTML = `Match <strong>${match.id}</strong> · ${match.difficulty} · ${match.problem_title}${rankedLabel}`;
    if (leetcodeLink) leetcodeLink.href = `https://leetcode.com/problems/${match.problem_slug || ""}/`;
    if (matchPlayers) matchPlayers.innerHTML = `<span><strong>You:</strong> ${me ? me.email : "—"}</span><span><strong>Opponent:</strong> ${opponent ? opponent.email : "Waiting..."}</span>`;
    safeSetText(matchStatus, match.status === "waiting" ? "Waiting for opponent to join." : "Run or Test your code, then Submit to lock in your solution.");
    safeSetText(testResultEl, "Run your code to see output here.");
    if (testResultEl) testResultEl.classList.add("empty");
    state.lastRunTimeMs = null;
    safeSetText(runtimeDisplay, "");

    let problem = null;
    if (match.problem_slug) {
      try {
        const res = await api(`/api/problems/${match.problem_slug}`);
        problem = res?.problem;
        state.currentProblem = problem;
      } catch (e) { state.currentProblem = null; }
    }

    if (problem) {
      const frontendId = problem.questionFrontendId || problem.questionId || "";
      safeSetText(problemTitleEl, `${frontendId}. ${problem.title}`);
      const diff = (problem.difficulty || "").toLowerCase();
      safeSetHtml(problemDifficultyEl, `<span class="difficulty-${diff}">${problem.difficulty || ""}</span>`);
      safeSetHtml(problemContentEl, problem.content || "<p>No description available.</p>");
      const lang = languageSelect ? languageSelect.value : "javascript";
      const snippet = getSnippetForLang(problem, lang);
      safeSetValue(codeEditor, snippet?.code ?? "// Write your solution here...");
    } else {
      safeSetText(problemTitleEl, match.problem_title || "Problem");
      safeSetHtml(problemDifficultyEl, `<span class="difficulty-easy">${match.difficulty || ""}</span>`);
      safeSetHtml(problemContentEl, "<p>Loading problem description failed. Use the link above to open on LeetCode.</p>");
      safeSetValue(codeEditor, "// Write your solution here...");
    }

    stopMatchPoll();
    state.currentMatchId = matchId;
    state.matchPoll = setInterval(async () => {
      if (!state.currentMatchId) return;
      try {
        const pollPayload = await api(`/api/matches/${state.currentMatchId}`);
        const m = pollPayload?.match;
        if (!m || m.status !== "complete") return;
        stopMatchPoll();
        state.currentMatchId = null;
        const players = pollPayload.players || [];
        const myPlayer = players.find((p) => p.user_id === state.user?.id);
        const hasWinner = players.some((p) => p.is_winner === 1);
        const isWinner = hasWinner ? (myPlayer?.is_winner === 1) : null;
        const eloDelta = myPlayer && myPlayer.elo_after != null && myPlayer.elo_before != null ? myPlayer.elo_after - myPlayer.elo_before : 0;
        const ranked = m.ranked !== 0 && m.ranked != null;
        await refreshMe();
        await loadLeaderboard();
        await loadStats();
        await loadRecentMatches();
        await loadMyMatches();
        showResultModal({ isWinner, eloDelta, ranked });
      } catch (_) {}
    }, 3000);
  } catch (err) {
    console.error("openMatch error", err);
    alert(err?.message || "Failed to open match.");
  }
}

bootstrap();
