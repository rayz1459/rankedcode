import express from "express";
import cors from "cors";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import fetch from "node-fetch";
import { v4 as uuid } from "uuid";
import vm from "vm";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { getDb } from "./db.js";
import { computeEloUpdate } from "./elo.js";
import {
  getBuiltinProblem,
  pickBuiltinQuestion,
  getBuiltinTestCases,
  BUILTIN_PREFIX
} from "./builtin-problems.js";

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

function pickQuestion({ difficulty }) {
  const builtin = pickBuiltinQuestion(difficulty);
  if (!builtin) return null;
  return { titleSlug: builtin.titleSlug, title: builtin.title, difficulty: builtin.difficulty };
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

app.get("/api/problems/random", authMiddleware, (req, res) => {
  const difficulty = req.query.difficulty;
  const pick = pickQuestion({ difficulty });
  if (!pick) return res.status(404).json({ error: "No questions found" });
  res.json({ question: pick });
});

app.get("/api/problems/:slug", authMiddleware, async (req, res) => {
  const slug = req.params.slug;
  const problem = slug && String(slug).startsWith(BUILTIN_PREFIX) ? getBuiltinProblem(slug) : null;
  if (!problem) return res.status(404).json({ error: "Problem not found" });
  res.json({ problem });
});

const PISTON_URL = "https://emkc.org/api/v2/piston";

function inferJsMethodName(code) {
  if (!code || typeof code !== "string") return null;
  const m1 = code.match(/(?:var|let|const)\s+(\w+)\s*=\s*function\s*\(([^)]*)\)/);
  if (m1) return { methodName: m1[1], numParams: (m1[2].match(/,/g) || []).length + (m1[2].trim() ? 1 : 0) };
  const m2 = code.match(/function\s+(\w+)\s*\(([^)]*)\)/);
  if (m2) return { methodName: m2[1], numParams: (m2[2].match(/,/g) || []).length + (m2[2].trim() ? 1 : 0) };
  return null;
}

function runLocalJavaScript(code, stdin, meta) {
  const stdout = [];
  const stderr = [];
  const sandbox = {
    console: {
      log(...args) { stdout.push(args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ")); },
      error(...args) { stderr.push(args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ")); },
      warn() {}, info() {}, debug() {}
    },
    __stdin: String(stdin),
    process: { env: {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Buffer, JSON, Math, Number, String, Array, Object, Map, Set, Promise, Error, RegExp, Date,
    parseInt, parseFloat, isNaN, isFinite, NaN, Infinity, Symbol, BigInt,
    undefined: undefined,
    null: null
  };
  vm.createContext(sandbox);
  const start = Date.now();
  try {
    vm.runInNewContext(code, sandbox, { timeout: 5000 });
    const hasStdin = String(stdin).trim().length > 0;
    const methodName = meta?.methodName;
    if (hasStdin && typeof methodName === "string") {
      const numParams = meta?.numParams;
      sandbox.__methodName = methodName;
      sandbox.__numParams = numParams;
      const harness = `
(function() {
  var __lines = __stdin.trim().split('\\n').filter(Boolean);
  var __args = __lines.map(function(l) { try { return JSON.parse(l); } catch(e) { return l; } });
  var __n = typeof __numParams === 'number' ? __numParams : __args.length;
  var __fn;
  try { __fn = eval(__methodName); } catch(e) {}
  if (typeof __fn === 'function') {
    var __out = __fn.apply(null, __args.slice(0, __n));
    console.log(JSON.stringify(__out !== undefined ? __out : null));
  }
})();
`;
      vm.runInNewContext(harness, sandbox, { timeout: 5000 });
    }
  } catch (e) {
    return { stdout: stdout.join("\n"), stderr: (stderr.join("\n") + (e.message ? "\n" + e.message : "")).trim(), runTimeMs: Date.now() - start };
  }
  return { stdout: stdout.join("\n"), stderr: stderr.join("\n"), runTimeMs: Date.now() - start };
}

function runWithStdin(cmd, args, stdin, cwd, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], cwd: cwd || undefined });
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", (err) => { stderr += (stderr ? "\n" : "") + String(err.message); });
    proc.on("close", (code) => resolve({ stdout, stderr, code }));
    proc.stdin.write(String(stdin), () => { proc.stdin.end(); });
    setTimeout(() => { try { proc.kill("SIGKILL"); } catch (_) {} }, timeoutMs);
  });
}

function parseMetaData(metaData) {
  if (!metaData || typeof metaData !== "string") return null;
  try {
    const o = JSON.parse(metaData);
    const name = o.name || o.methodName;
    const params = o.params || o.paramTypes || [];
    const numParams = Array.isArray(params) ? params.length : 0;
    const paramTypes = Array.isArray(params) ? params.map((p) => (p.type || "integer").toLowerCase()) : [];
    const firstParamIsArray = paramTypes[0] && paramTypes[0].includes("[]");
    return name ? { methodName: name, numParams, paramTypes, firstParamIsArray } : null;
  } catch (_) {
    return null;
  }
}

/** Extract expected output strings from problem description HTML, in example order. */
function parseExpectedFromContent(content) {
  if (!content || typeof content !== "string") return [];
  const out = [];
  const normalized = content
    .replace(/<pre[^>]*>[\s\S]*?<\/pre>/gi, (pre) => pre.replace(/<[^>]+>/g, ""))
    .replace(/<code[^>]*>[\s\S]*?<\/code>/gi, (c) => c.replace(/<[^>]+>/g, ""))
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
  const stripTags = content.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/\s+/g, " ");
  const combined = normalized + "\n" + stripTags;
  const patterns = [
    /Output\s*:\s*["']([^"']*)["']/gi,
    /Output\s*:\s*`([^`]+)`/gi,
    /(?:Output|output)\s*:\s*["']([^"']*)["']/gi,
    /Output\s*:\s*(\d+)\b/gi,
    /Output\s*:\s*(\[[^\]]*\])/gi,
    /Output\s*:\s*(\{[^}]*\})/gi,
    /Output\s*:\s*(true|false|null)/gi,
    /(?:<strong>|\\*\\*)\s*Output[^:]*:\s*["']?([^"'<\]}\s][^<\]}\n]{0,200})["']?/gi,
    /Output\s*:\s*([^<\n\[\]]+?)(?=\s*(?:Explanation|Note|Constraints|Example|Input|$))/gi
  ];
  for (const re of patterns) {
    out.length = 0;
    re.lastIndex = 0;
    let m;
    const str = re.source.includes("strong") ? content : combined;
    while ((m = re.exec(str)) !== null) {
      const val = (m[1] || "").replace(/^["'\s`]+|["'\s`]+$/g, "").trim();
      if (val && val.length < 500 && !/^Input\s*:/i.test(val)) out.push(val);
    }
    if (out.length > 0) return out;
  }
  return out;
}

/** Parse exampleTestcases into [{ stdin, expected }]. Each test = numParams input lines + 1 expected line. */
function parseTestCases(exampleTestcases, numParamsFromMeta) {
  if (!exampleTestcases || typeof exampleTestcases !== "string") return [];
  const lines = exampleTestcases.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  if (numParamsFromMeta == null || numParamsFromMeta < 0) {
    if (lines.length >= 2) return [{ stdin: lines.slice(0, -1).join("\n"), expected: lines[lines.length - 1] }];
    return [{ stdin: lines[0] || "", expected: "" }];
  }
  let numParams = numParamsFromMeta;
  if (numParams === 1 && lines.length >= 3 && lines.length % 3 === 0) {
    numParams = 2;
  }
  const blockSize = numParams + 1;
  let cases = [];
  if (lines.length === numParams * 2) {
    cases = [
      { stdin: lines.slice(0, numParams).join("\n"), expected: "" },
      { stdin: lines.slice(numParams, numParams * 2).join("\n"), expected: "" }
    ];
  } else {
    for (let i = 0; i + blockSize <= lines.length; i += blockSize) {
      const stdin = lines.slice(i, i + numParams).join("\n");
      const expected = lines[i + numParams];
      cases.push({ stdin, expected });
    }
    if (cases.length === 0 && lines.length >= numParams) {
      const stdin = lines.slice(0, numParams).join("\n");
      cases.push({ stdin, expected: "" });
    }
  }
  if (cases.length === 1 && numParams >= 3 && lines.length >= 4) {
    for (let tryParams = numParams - 1; tryParams >= 2; tryParams--) {
      const tryBlock = tryParams + 1;
      if (lines.length % tryBlock !== 0) continue;
      const tryCases = [];
      for (let i = 0; i + tryBlock <= lines.length; i += tryBlock) {
        tryCases.push({ stdin: lines.slice(i, i + tryParams).join("\n"), expected: lines[i + tryParams] });
      }
      if (tryCases.length >= 2) {
        cases = tryCases;
        break;
      }
    }
  }
  return cases;
}

/** Normalize output for comparison (trim, optional JSON). */
function normalizeOutput(s) {
  const t = String(s ?? "").trim();
  try {
    const parsed = JSON.parse(t);
    return JSON.stringify(parsed);
  } catch (_) {
    return t;
  }
}

function outputMatches(actual, expected) {
  if (normalizeOutput(actual) === normalizeOutput(expected)) return true;
  // LeetCode sometimes gives the modified-array as "expected" for in-place return-length problems; accept if actual equals array length.
  const actualStr = String(actual ?? "").trim();
  let expectedParsed = null;
  try {
    expectedParsed = JSON.parse(String(expected ?? "").trim());
  } catch (_) {}
  if (expectedParsed != null && Array.isArray(expectedParsed) && /^\d+$/.test(actualStr)) {
    if (Number(actualStr) === expectedParsed.length) return true;
  }
  return false;
}

/** For in-place "return new length" problems: when actual is a number, compute expected k from stdin (nums and val) and accept if actual === k. */
function passesReturnLengthHeuristic(actual, expected, stdin) {
  const actualStr = String(actual ?? "").trim();
  if (!/^\d+$/.test(actualStr)) return false;
  const stdinStr = String(stdin ?? "").trim();
  const lines = stdinStr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return false;
  let arr = null;
  try {
    arr = JSON.parse(lines[0]);
  } catch (_) {}
  if (!Array.isArray(arr)) return false;
  let val;
  try {
    val = JSON.parse(lines[lines.length - 1]);
  } catch (_) {
    val = lines[lines.length - 1];
  }
  const k = arr.filter((x) => x !== val).length;
  return Number(actualStr) === k;
}

function wrapPythonLeetCodeHarness(code, hasStdin, meta) {
  if (!hasStdin || !/class\s+Solution\s*[:(]/.test(code) || /if\s+__name__\s*==\s*[\'"]__main__[\'"]\s*:/m.test(code)) {
    return code;
  }
  // Ensure the last def/class has a body so we don't get IndentationError when appending __main__
  let c = code.trimEnd();
  const lines = c.split("\n");
  let lastNonBlank = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().length > 0) {
      lastNonBlank = lines[i];
      break;
    }
  }
  if (lastNonBlank && /^\s*def\s+.+\)\s*:\s*$/.test(lastNonBlank)) {
    const baseIndent = (lastNonBlank.match(/^(\s*)/) || [""])[1];
    c = c + "\n" + baseIndent + "    pass";
  }
  const methodName = meta?.methodName;
  const numParams = meta?.numParams;
  const useMeta = typeof methodName === "string";
  const getMeth = useMeta
    ? `_meth = getattr(_sol, ${JSON.stringify(methodName)}, None)`
    : `_meth = next((m for m in dir(_sol) if not m.startswith("_") and callable(getattr(_sol, m))), None)`;
  const getN = useMeta && numParams != null
    ? `_n = ${numParams}`
    : `_n = len(_args)\n      try:\n        _sig = inspect.signature(_meth)\n        _n = max(0, len(_sig.parameters) - 1)\n      except Exception: pass`;
  return (
    c +
    "\n\nif __name__ == \"__main__\":\n  import sys, json, inspect\n  try:\n    _in = sys.stdin.read().strip()\n    if _in:\n      _lines = [L.strip() for L in _in.split(\"\\n\") if L.strip()]\n      _args = []\n      for L in _lines:\n        try: _args.append(json.loads(L))\n        except Exception: _args.append(L)\n      _sol = Solution()\n      " +
    getMeth +
    "\n      if _meth:\n        " +
    getN +
    "\n        _args = _args[:_n] if _n < len(_args) else _args\n        _out = _meth(*_args)\n        print(json.dumps(_out) if _out is not None else \"\")\n  except Exception:\n    import traceback\n    traceback.print_exc()\n"
  );
}

function runLocalPython(code, stdin, meta) {
  const hasStdin = String(stdin).trim().length > 0;
  const codeToRun = wrapPythonLeetCodeHarness(code, hasStdin, meta || null);
  return new Promise((resolve) => {
    const tmpDir = path.join(os.tmpdir(), `run_${uuid().replace(/-/g, "")}`);
    const tmpFile = path.join(tmpDir, "main.py");
    const start = Date.now();
    fs.mkdir(tmpDir, { recursive: true }, (mkdirErr) => {
      if (mkdirErr) {
        resolve({ stdout: "", stderr: String(mkdirErr.message), runTimeMs: Date.now() - start });
        return;
      }
      fs.writeFile(tmpFile, codeToRun, "utf8", (writeErr) => {
        if (writeErr) {
          fs.rm(tmpDir, { recursive: true }, () => {});
          resolve({ stdout: "", stderr: String(writeErr.message), runTimeMs: Date.now() - start });
          return;
        }
        runWithStdin("python3", ["main.py"], stdin, tmpDir).then((r) => {
          fs.rm(tmpDir, { recursive: true }, () => {});
          resolve({ stdout: r.stdout, stderr: r.stderr, runTimeMs: Date.now() - start });
        });
      });
    });
  });
}

function runLocalJava(code, stdin) {
  const start = Date.now();
  const tmpDir = path.join(os.tmpdir(), `run_${uuid().replace(/-/g, "")}`);
  const srcFile = path.join(tmpDir, "Solution.java");
  return fs.promises.mkdir(tmpDir, { recursive: true })
    .then(() => fs.promises.writeFile(srcFile, code, "utf8"))
    .then(() => runWithStdin("javac", ["Solution.java"], "", tmpDir))
    .then((compile) => {
      if (compile.code !== 0 && compile.code !== null) {
        return fs.promises.rm(tmpDir, { recursive: true }).catch(() => {}).then(() => ({ stdout: "", stderr: compile.stderr || "Compilation failed", runTimeMs: Date.now() - start }));
      }
      return runWithStdin("java", ["Solution"], stdin, tmpDir).then((r) => {
        return fs.promises.rm(tmpDir, { recursive: true }).catch(() => {}).then(() => ({ stdout: r.stdout, stderr: r.stderr, runTimeMs: Date.now() - start }));
      });
    })
    .catch((err) => fs.promises.rm(tmpDir, { recursive: true }).catch(() => {}).then(() => ({ stdout: "", stderr: String(err.message), runTimeMs: Date.now() - start })));
}

function wrapCLeetCodeHarness(code, meta) {
  const methodName = meta?.methodName || "removeElement";
  const numParams = meta?.numParams != null ? meta.numParams : 2;
  const oneParam = numParams < 2;
  const readSecond = oneParam
    ? ""
    : "  if (!fgets(line, sizeof(line), stdin)) return 1;\n  val = (int)strtol(line, NULL, 10);";
  const call = oneParam
    ? `  int result = ${methodName}(nums, n);\n  printf("%d\\n", result);`
    : `  printf("%d\\n", ${methodName}(nums, n, val));`;
  return `#include <stdio.h>
#include <stdlib.h>
#include <string.h>

${code}

#define MAX_N 10000
int main(void) {
  static int nums[MAX_N];
  int n = 0, val = 0;
  char line[80000];
  if (!fgets(line, sizeof(line), stdin)) return 1;
  char *p = line;
  while (*p) {
    if (*p == '-' || (*p >= '0' && *p <= '9')) {
      nums[n++] = (int)strtol(p, &p, 10);
      if (n >= MAX_N) break;
    } else p++;
  }
${readSecond}
${call}
  return 0;
}
`;
}

/** C harness for methods that take only int params (e.g. fib(int n), uniquePaths(int m, int n)). */
function wrapCIntHarness(code, meta) {
  const methodName = meta?.methodName || "fn";
  const numParams = meta?.numParams != null ? meta.numParams : 1;
  const readSecond = numParams >= 2
    ? "  if (!fgets(line, sizeof(line), stdin)) return 1;\n  b = (int)strtol(line, NULL, 10);"
    : "";
  const call = numParams >= 2
    ? `  int result = ${methodName}(a, b);\n  printf("%d\\n", result);`
    : `  int result = ${methodName}(a);\n  printf("%d\\n", result);`;
  const isBool = /\bbool\s+\w+\s*\(/.test(code);
  const boolCall = numParams >= 2
    ? `  int r = (int)${methodName}(a, b);\n  printf("%s\\n", r ? "true" : "false");`
    : `  int r = (int)${methodName}(a);\n  printf("%s\\n", r ? "true" : "false");`;
  const printStmt = isBool ? boolCall : call;
  const stdbool = isBool ? "\n#include <stdbool.h>" : "";
  return `#include <stdio.h>
#include <stdlib.h>${stdbool}

${code}

int main(void) {
  char line[256];
  int a = 0, b = 0;
  if (!fgets(line, sizeof(line), stdin)) return 1;
  a = (int)strtol(line, NULL, 10);
${readSecond}
${printStmt}
  return 0;
}
`;
}

function runLocalC(code, stdin, meta) {
  const start = Date.now();
  const tmpDir = path.join(os.tmpdir(), `run_${uuid().replace(/-/g, "")}`);
  const srcFile = path.join(tmpDir, "main.c");
  const outFile = path.join(tmpDir, "main");
  const hasStdin = String(stdin).trim().length > 0;
  const hasMain = /\bint\s+main\s*\(/.test(code);
  const hasIntReturnAndArrayParam = /\bint\s+\w+\s*\(\s*int\s*\*/.test(code);
  const needsArrayHarness = meta?.methodName && hasIntReturnAndArrayParam && (!hasMain || hasStdin);
  const needsIntHarness = meta?.methodName && hasStdin && !hasMain && meta.firstParamIsArray === false;
  let codeToRun = code;
  if (needsArrayHarness) codeToRun = wrapCLeetCodeHarness(code, meta);
  else if (needsIntHarness) codeToRun = wrapCIntHarness(code, meta);
  else if (!hasMain) codeToRun = code + "\n\nint main(void) { return 0; }\n";
  return fs.promises.mkdir(tmpDir, { recursive: true })
    .then(() => fs.promises.writeFile(srcFile, codeToRun, "utf8"))
    .then(() => runWithStdin("gcc", ["-std=c99", "-o", "main", "main.c"], "", tmpDir))
    .then((compile) => {
      if (compile.code !== 0 && compile.code !== null) {
        return fs.promises.rm(tmpDir, { recursive: true }).catch(() => {}).then(() => ({ stdout: "", stderr: compile.stderr || "Compilation failed", runTimeMs: Date.now() - start }));
      }
      return runWithStdin(outFile, [], stdin, tmpDir).then((r) => {
        return fs.promises.rm(tmpDir, { recursive: true }).catch(() => {}).then(() => ({ stdout: r.stdout, stderr: r.stderr, runTimeMs: Date.now() - start }));
      });
    })
    .catch((err) => fs.promises.rm(tmpDir, { recursive: true }).catch(() => {}).then(() => ({ stdout: "", stderr: String(err.message), runTimeMs: Date.now() - start })));
}

function wrapCppLeetCodeHarness(code, meta) {
  const methodName = meta?.methodName || "unknown";
  const numParams = meta?.numParams != null ? meta.numParams : 2;
  const readSecond = numParams >= 2 ? "  std::getline(std::cin, line2);" : "";
  const callTwo = numParams >= 2 ? `  int val = line2.empty() ? 0 : std::stoi(line2);
  auto result = sol.${methodName}(nums, val);
  print_result(result);` : `  auto result = sol.${methodName}(nums);
  print_result(result);`;
  const harness = `
#include <iostream>
#include <vector>
#include <sstream>
#include <string>
#include <cstdlib>
using namespace std;

${code}

static void print_result(int x) { std::cout << x << std::endl; }
static void print_result(bool x) { std::cout << (x ? "true" : "false") << std::endl; }
static void print_result(double x) { std::cout << x << std::endl; }
static void print_result(const std::vector<int>& v) {
  std::cout << "[";
  for (size_t i = 0; i < v.size(); i++) { if (i) std::cout << ","; std::cout << v[i]; }
  std::cout << "]" << std::endl;
}

int main() {
  std::string line1, line2;
  if (!std::getline(std::cin, line1)) return 0;
${readSecond}
  if (line1.empty()) return 0;
  std::vector<int> nums;
  std::string s = line1;
  if (s.size() >= 2) s = s.substr(1, s.size() - 2);
  std::istringstream ss(s);
  std::string token;
  while (std::getline(ss, token, ',')) {
    if (!token.empty()) nums.push_back(std::stoi(token));
  }
  Solution sol;
${callTwo}
  return 0;
}
`;
  return harness;
}

/** C++ harness for methods that take only int params (e.g. fib(int n), uniquePaths(int m, int n)). */
function wrapCppIntHarness(code, meta) {
  const methodName = meta?.methodName || "unknown";
  const numParams = meta?.numParams != null ? meta.numParams : 1;
  const readSecond = numParams >= 2 ? "  std::getline(std::cin, line2);\n  int b = line2.empty() ? 0 : std::stoi(line2);" : "";
  const call = numParams >= 2
    ? `  auto result = sol.${methodName}(a, b);\n  print_result(result);`
    : `  auto result = sol.${methodName}(a);\n  print_result(result);`;
  return `
#include <iostream>
#include <string>
#include <cstdlib>
using namespace std;

${code}

static void print_result(int x) { std::cout << x << std::endl; }
static void print_result(bool x) { std::cout << (x ? "true" : "false") << std::endl; }
static void print_result(double x) { std::cout << x << std::endl; }

int main() {
  std::string line1, line2;
  if (!std::getline(std::cin, line1)) return 0;
${readSecond}
  int a = line1.empty() ? 0 : std::stoi(line1);
${call}
  return 0;
}
`;
}

function runLocalCpp(code, stdin, meta) {
  const start = Date.now();
  const tmpDir = path.join(os.tmpdir(), `run_${uuid().replace(/-/g, "")}`);
  const srcFile = path.join(tmpDir, "main.cpp");
  const outFile = path.join(tmpDir, "main");
  const hasStdin = String(stdin).trim().length > 0;
  const hasMain = /int\s+main\s*\(|void\s+main\s*\(/.test(code);
  const hasSolution = /\bclass\s+Solution\b/.test(code);
  const needsHarness = meta?.methodName && hasSolution && (!hasMain || hasStdin);
  let codeToRun = code;
  if (needsHarness) {
    codeToRun = meta?.firstParamIsArray === false ? wrapCppIntHarness(code, meta) : wrapCppLeetCodeHarness(code, meta);
  } else if (!hasMain) {
    codeToRun = code + "\n\nint main() { return 0; }\n";
  }
  return fs.promises.mkdir(tmpDir, { recursive: true })
    .then(() => fs.promises.writeFile(srcFile, codeToRun, "utf8"))
    .then(() => runWithStdin("g++", ["-std=c++11", "-o", "main", "main.cpp"], "", tmpDir))
    .then((compile) => {
      if (compile.code !== 0 && compile.code !== null) {
        return fs.promises.rm(tmpDir, { recursive: true }).catch(() => {}).then(() => ({ stdout: "", stderr: compile.stderr || "Compilation failed", runTimeMs: Date.now() - start }));
      }
      return runWithStdin(outFile, [], stdin, tmpDir).then((r) => {
        return fs.promises.rm(tmpDir, { recursive: true }).catch(() => {}).then(() => ({ stdout: r.stdout, stderr: r.stderr, runTimeMs: Date.now() - start }));
      });
    })
    .catch((err) => fs.promises.rm(tmpDir, { recursive: true }).catch(() => {}).then(() => ({ stdout: "", stderr: String(err.message), runTimeMs: Date.now() - start })));
}

const localRunnersMap = {
  javascript: (code, stdin, m) => Promise.resolve(runLocalJavaScript(code, stdin, m)),
  python: (code, stdin, m) => runLocalPython(code, stdin, m),
  java: runLocalJava,
  c: runLocalC,
  "c++": runLocalCpp
};

const extMap = { javascript: "js", python: "py", java: "java", cpp: "cpp", "c++": "cpp", c: "c", rust: "rs", typescript: "ts" };

async function runCodeOnce({ language, code, stdin = "", problemSlug, metaData: clientMeta }) {
  const lang = String(language).toLowerCase().replace(/[^a-z0-9]/g, "");
  const langMap = { javascript: "javascript", js: "javascript", python: "python", py: "python", java: "java", cpp: "c++", c: "c", rust: "rust", typescript: "typescript", ts: "typescript" };
  const pistonLang = langMap[lang] || language;
  let meta = parseMetaData(clientMeta);
  if (problemSlug && !meta) {
    const builtin = problemSlug && String(problemSlug).startsWith(BUILTIN_PREFIX) ? getBuiltinProblem(problemSlug) : null;
    if (builtin?.metaData) meta = parseMetaData(builtin.metaData);
  }
  const hasStdin = String(stdin).trim().length > 0;
  if (langMap[lang] === "javascript" && hasStdin && !meta) meta = inferJsMethodName(code);
  const filename = `main.${extMap[pistonLang] || "txt"}`;
  const tryPiston = async () => {
    const start = Date.now();
    const pistonRes = await fetch(`${PISTON_URL}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: pistonLang, files: [{ name: filename, content: code }], stdin: String(stdin), run_timeout: 10000 })
    });
    const elapsed = Date.now() - start;
    if (!pistonRes.ok) throw new Error(await pistonRes.text() || `HTTP ${pistonRes.status}`);
    const result = await pistonRes.json();
    return { stdout: result.run?.stdout ?? "", stderr: result.run?.stderr ?? "", runTimeMs: elapsed };
  };
  const useLocalPythonFirst = pistonLang === "python" && hasStdin && /class\s+Solution\s*[:(]/.test(code) && !/if\s+__name__\s*==\s*[\'"]__main__[\'"]\s*:/m.test(code);
  const useLocalJsFirst = pistonLang === "javascript" && hasStdin && meta?.methodName;
  const useLocalCppFirst = pistonLang === "c++" && meta?.methodName && /\bclass\s+Solution\b/.test(code);
  const useLocalCFirst = pistonLang === "c" && hasStdin && meta?.methodName && (/\bint\s+\w+\s*\(\s*int\s*\*/.test(code) || meta.firstParamIsArray === false);
  if (useLocalPythonFirst) return runLocalPython(code, stdin, meta);
  if (useLocalJsFirst) return runLocalJavaScript(code, stdin, meta);
  if (useLocalCppFirst) return runLocalCpp(code, stdin, meta);
  if (useLocalCFirst) return runLocalC(code, stdin, meta);
  try {
    return await tryPiston();
  } catch (pistonErr) {
    const runLocal = localRunnersMap[pistonLang];
    if (runLocal) return await runLocal(code, stdin, meta);
    throw pistonErr;
  }
}

app.post("/api/run", authMiddleware, async (req, res) => {
  const { language, code, stdin = "", problemSlug, metaData: clientMeta } = req.body || {};
  if (!language || !code) return res.status(400).json({ error: "language and code required" });
  try {
    const result = await runCodeOnce({ language, code, stdin, problemSlug, metaData: clientMeta });
    const output = result.stdout + (result.stderr ? "\n" + result.stderr : "");
    res.json({ stdout: result.stdout, stderr: result.stderr, output: output || "(no output)", runTimeMs: result.runTimeMs });
  } catch (err) {
    res.status(502).json({ error: "Execution failed", detail: err.message });
  }
});

app.post("/api/run-tests", authMiddleware, async (req, res) => {
  try {
    const { language, code, problemSlug, metaData: clientMeta, exampleTestcases: clientExamples } = req.body || {};
    if (!language || !code) return res.status(400).json({ error: "language and code required" });
    let meta = parseMetaData(clientMeta);
    let exampleTestcases = clientExamples;
    let problem = null;
    let testCases = [];
    if (problemSlug && String(problemSlug).startsWith(BUILTIN_PREFIX)) {
      problem = getBuiltinProblem(problemSlug);
      if (problem?.metaData) meta = parseMetaData(problem.metaData);
      testCases = getBuiltinTestCases(problemSlug);
    }
    if (testCases.length === 0 && problemSlug && String(problemSlug).startsWith(BUILTIN_PREFIX)) {
      problem = problem || getBuiltinProblem(problemSlug);
      if (problem?.metaData) meta = parseMetaData(problem.metaData);
      if (problem?.exampleTestcases != null) exampleTestcases = problem.exampleTestcases;
    }
    if (testCases.length === 0) {
      const numParams = meta?.numParams;
      testCases = parseTestCases(exampleTestcases, numParams);
      if (problem?.content && testCases.length > 0) {
        const expectedFromContent = parseExpectedFromContent(problem.content);
        if (expectedFromContent.length >= testCases.length) {
          testCases = testCases.map((tc, i) => ({ ...tc, expected: expectedFromContent[i] ?? tc.expected }));
        }
      }
    }
    if (testCases.length === 0) {
      return res.json({ results: [], summary: { total: 0, passed: 0, failed: 0 }, error: "No example test cases for this problem." });
    }
    const results = [];
    for (let i = 0; i < testCases.length; i++) {
      const { stdin, expected } = testCases[i];
      try {
        const runResult = await runCodeOnce({ language, code, stdin, problemSlug, metaData: clientMeta });
        const actual = (runResult.stdout || "").trim();
        const stderr = (runResult.stderr || "").trim();
        const expectedTrimmed = (expected || "").trim();
        const noExpected = expectedTrimmed === "";
        let passed = noExpected ? false : outputMatches(actual, expected);
        if (!passed && (actual || expected)) passed = passesReturnLengthHeuristic(actual, expected, stdin);
        results.push({
          index: i + 1,
          passed: noExpected ? false : passed,
          noExpected: noExpected || undefined,
          stdin,
          expected: expected.trim(),
          actual: actual || "(no output)",
          stderr: stderr || null,
          runTimeMs: runResult.runTimeMs,
          error: null
        });
      } catch (err) {
        results.push({
          index: i + 1,
          passed: false,
          stdin,
          expected: expected.trim(),
          actual: null,
          stderr: null,
          runTimeMs: null,
          error: err.message || String(err)
        });
      }
    }
    const passed = results.filter((r) => r.passed).length;
    res.json({
      results,
      summary: { total: results.length, passed, failed: results.length - passed }
    });
  } catch (err) {
    console.error("run-tests error:", err);
    res.status(500).json({ error: "Test run failed", detail: err.message || String(err) });
  }
});

/** Run all test cases for a problem; used for submit validation. Returns { allPassed, failedCount, total, maxRunTimeMs }. */
async function runAllTestsForSubmit(problemSlug, language, code, metaData) {
  let testCases = [];
  let meta = parseMetaData(metaData);
  let problem = null;
  if (problemSlug && String(problemSlug).startsWith(BUILTIN_PREFIX)) {
    problem = getBuiltinProblem(problemSlug);
    if (problem?.metaData) meta = parseMetaData(problem.metaData);
    testCases = getBuiltinTestCases(problemSlug);
  }
  if (testCases.length === 0) {
    problem = problem || (problemSlug && String(problemSlug).startsWith(BUILTIN_PREFIX) ? getBuiltinProblem(problemSlug) : null);
    if (problem?.metaData) meta = parseMetaData(problem.metaData);
    const exampleTestcases = problem?.exampleTestcases || "";
    testCases = parseTestCases(exampleTestcases, meta?.numParams);
    if (problem?.content && testCases.length > 0) {
      const expectedFromContent = parseExpectedFromContent(problem.content);
      if (expectedFromContent.length >= testCases.length) {
        testCases = testCases.map((tc, i) => ({ ...tc, expected: expectedFromContent[i] ?? tc.expected }));
      }
    }
  }
  if (testCases.length === 0) return { allPassed: false, failedCount: 1, total: 0, maxRunTimeMs: null };
  let maxRunTimeMs = 0;
  let failedCount = 0;
  for (const { stdin, expected } of testCases) {
    try {
      const runResult = await runCodeOnce({ language, code, stdin, problemSlug, metaData: problem?.metaData || metaData });
      const actual = (runResult.stdout || "").trim();
      const expectedTrimmed = (expected || "").trim();
      const noExpected = expectedTrimmed === "";
      let passed = !noExpected && outputMatches(actual, expected);
      if (!passed && (actual || expected)) passed = passesReturnLengthHeuristic(actual, expected, stdin);
      if (!passed) failedCount++;
      if (runResult.runTimeMs != null) maxRunTimeMs = Math.max(maxRunTimeMs, runResult.runTimeMs);
    } catch (_) {
      failedCount++;
    }
  }
  return { allPassed: failedCount === 0, failedCount, total: testCases.length, maxRunTimeMs: maxRunTimeMs || null };
}

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
      "INSERT INTO matches (id, problem_slug, problem_title, difficulty, status, created_at, ranked) VALUES (?, ?, ?, ?, ?, ?, 1)",
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
    const p = String(problemSlug).startsWith(BUILTIN_PREFIX) ? getBuiltinProblem(problemSlug) : null;
    question = p ? { titleSlug: p.titleSlug, title: p.title, difficulty: p.difficulty } : null;
  } else {
    question = pickQuestion({ difficulty });
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
    "INSERT INTO matches (id, problem_slug, problem_title, difficulty, status, created_at, ranked) VALUES (?, ?, ?, ?, ?, ?, 0)",
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
  const { code, language, runtimeMs: clientRuntimeMs } = req.body || {};
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

  let runtimeMs = clientRuntimeMs;
  const problemSlug = match.problem_slug;
  let metaData = null;
  if (problemSlug && String(problemSlug).startsWith(BUILTIN_PREFIX)) {
    const builtin = getBuiltinProblem(problemSlug);
    if (builtin) metaData = builtin.metaData;
  } else if (problemSlug && String(problemSlug).startsWith(BUILTIN_PREFIX)) {
    const problem = getBuiltinProblem(problemSlug);
    if (problem) metaData = problem.metaData;
  }

  if (code && language && problemSlug) {
    const validation = await runAllTestsForSubmit(problemSlug, language, code, metaData);
    if (validation.total > 0) {
      if (!validation.allPassed) {
        const msg = `${validation.total - validation.failedCount}/${validation.total} test cases passed. Pass all tests before submitting.`;
        return res.status(400).json({ error: msg });
      }
      if (validation.maxRunTimeMs != null) runtimeMs = validation.maxRunTimeMs;
    }
  }

  if (!runtimeMs || runtimeMs <= 0) {
    return res.status(400).json({
      error: "Run or Test your code first to get a runtime, then Submit.",
      detail: "Solution must pass all tests. Use Test to verify before submitting."
    });
  }

  await db.run(
    "UPDATE match_players SET runtime_ms = ?, submitted_at = ? WHERE match_id = ? AND user_id = ?",
    runtimeMs,
    new Date().toISOString(),
    match.id,
    req.user.sub
  );

  await db.run("BEGIN");
  let resultPayload = null;
  try {
    const matchNow = await db.get("SELECT * FROM matches WHERE id = ?", match.id);
    if (matchNow.status === "complete") {
      await db.run("ROLLBACK");
      const playersAfter = await db.all(
        "SELECT user_id, elo_before, elo_after, is_winner FROM match_players WHERE match_id = ? ORDER BY user_id",
        match.id
      );
      const meRow = playersAfter.find((p) => p.user_id === req.user.sub);
      const hasWinner = playersAfter.some((p) => p.is_winner === 1);
      const isWinner = !hasWinner ? null : (meRow && meRow.is_winner === 1);
      const eloDelta = meRow && meRow.elo_after != null && meRow.elo_before != null ? meRow.elo_after - meRow.elo_before : 0;
      return res.json({ status: "complete", ranked: matchNow.ranked !== 0 && matchNow.ranked != null, isWinner, eloDelta });
    }

    const players = await db.all(
      "SELECT user_id, elo_before, runtime_ms, submitted_at FROM match_players WHERE match_id = ? ORDER BY user_id",
      match.id
    );

    if (players.length < 2 || players.some((p) => p.runtime_ms == null)) {
      await db.run("ROLLBACK");
      return res.json({ status: "waiting" });
    }

    // Winner = whoever submitted a correct answer first (earliest submitted_at)
    const playersWithTime = players.map((p) => {
      const submittedAt = p.submitted_at ? new Date(p.submitted_at).getTime() : Infinity;
      return { ...p, submittedAt };
    });
    const [a, b] = playersWithTime;
    let scoreA = 0.5, scoreB = 0.5, winnerId = null;
    if (a.submittedAt < b.submittedAt) { scoreA = 1; scoreB = 0; winnerId = a.user_id; }
    else if (b.submittedAt < a.submittedAt) { scoreA = 0; scoreB = 1; winnerId = b.user_id; }

    const ranked = match.ranked !== 0 && match.ranked != null;
    const eloUpdate = ranked ? computeEloUpdate({ eloA: a.elo_before, eloB: b.elo_before, scoreA, scoreB, runtimeA: a.runtime_ms, runtimeB: b.runtime_ms }) : null;
    const finalEloA = ranked ? eloUpdate.newEloA : a.elo_before;
    const finalEloB = ranked ? eloUpdate.newEloB : b.elo_before;
    const k = ranked ? eloUpdate.k : 0;

    await db.run("UPDATE match_players SET elo_after = ?, is_winner = ? WHERE match_id = ? AND user_id = ?", finalEloA, a.user_id === winnerId ? 1 : 0, match.id, a.user_id);
    await db.run("UPDATE match_players SET elo_after = ?, is_winner = ? WHERE match_id = ? AND user_id = ?", finalEloB, b.user_id === winnerId ? 1 : 0, match.id, b.user_id);
    if (ranked) {
      await db.run("UPDATE users SET elo = ? WHERE id = ?", finalEloA, a.user_id);
      await db.run("UPDATE users SET elo = ? WHERE id = ?", finalEloB, b.user_id);
    }
    await db.run("UPDATE matches SET status = ? WHERE id = ?", "complete", match.id);
    await db.run("COMMIT");

    const me = playersWithTime.find((p) => p.user_id === req.user.sub);
    const isWinner = winnerId == null ? null : !!(me && winnerId === me.user_id);
    const eloDelta = ranked && me ? (me.user_id === a.user_id ? finalEloA - a.elo_before : finalEloB - b.elo_before) : 0;
    resultPayload = { status: "complete", winnerId, k, ranked, isWinner, eloDelta };
  } catch (error) {
    await db.run("ROLLBACK");
    throw error;
  }
  if (resultPayload) res.json(resultPayload);
});

app.post("/api/matches/:id/forfeit", authMiddleware, async (req, res) => {
  const db = await getDb();
  const match = await db.get("SELECT * FROM matches WHERE id = ?", req.params.id);
  if (!match) return res.status(404).json({ error: "Match not found" });
  if (match.status === "complete") return res.status(400).json({ error: "Match already complete" });
  const forfeiter = await db.get("SELECT id, user_id, elo_before FROM match_players WHERE match_id = ? AND user_id = ?", match.id, req.user.sub);
  if (!forfeiter) return res.status(403).json({ error: "Not part of this match" });
  if (match.status === "waiting") {
    await db.run("DELETE FROM match_players WHERE match_id = ? AND user_id = ?", match.id, req.user.sub);
    const remaining = await db.get("SELECT COUNT(*) as c FROM match_players WHERE match_id = ?", match.id);
    if (remaining.c === 0) await db.run("DELETE FROM matches WHERE id = ?", match.id);
    return res.json({ status: "left", message: "You left the match." });
  }
  const players = await db.all("SELECT user_id, elo_before FROM match_players WHERE match_id = ?", match.id);
  if (players.length < 2) return res.status(400).json({ error: "Cannot forfeit" });
  const opponent = players.find((p) => p.user_id !== req.user.sub);
  if (!opponent) return res.status(400).json({ error: "Cannot forfeit" });
  const ranked = match.ranked !== 0 && match.ranked != null;
  const eloUpdate = ranked ? computeEloUpdate({ eloA: forfeiter.elo_before, eloB: opponent.elo_before, scoreA: 0, scoreB: 1, runtimeA: null, runtimeB: null }) : null;
  const forfeiterNewElo = ranked ? (forfeiter.user_id === players[0].user_id ? eloUpdate.newEloA : eloUpdate.newEloB) : forfeiter.elo_before;
  const opponentNewElo = ranked ? (opponent.user_id === players[0].user_id ? eloUpdate.newEloA : eloUpdate.newEloB) : opponent.elo_before;
  await db.run("BEGIN");
  try {
    await db.run("UPDATE match_players SET elo_after = ?, is_winner = 0, runtime_ms = NULL, submitted_at = ? WHERE match_id = ? AND user_id = ?", forfeiterNewElo, new Date().toISOString(), match.id, req.user.sub);
    await db.run("UPDATE match_players SET elo_after = ?, is_winner = 1 WHERE match_id = ? AND user_id = ?", opponentNewElo, match.id, opponent.user_id);
    if (ranked) {
      await db.run("UPDATE users SET elo = ? WHERE id = ?", forfeiterNewElo, req.user.sub);
      await db.run("UPDATE users SET elo = ? WHERE id = ?", opponentNewElo, opponent.user_id);
    }
    await db.run("UPDATE matches SET status = ? WHERE id = ?", "complete", match.id);
    await db.run("COMMIT");
  } catch (error) {
    await db.run("ROLLBACK");
    throw error;
  }
  res.json({ status: "forfeited", winnerId: opponent.user_id, ranked });
});

app.listen(PORT, () => {
  console.log(`RankedLeetCode running on http://localhost:${PORT}`);
});
