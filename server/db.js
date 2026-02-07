import initSqlJs from "sql.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, "..", "ranked-leetcode.db");

let dbPromise;

function persist(db) {
  try {
    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
  } catch (err) {
    console.error("db persist error:", err.message);
  }
}

export async function getDb() {
  if (!dbPromise) {
    const SQL = await initSqlJs({
      locateFile: (file) =>
        path.join(__dirname, "..", "node_modules", "sql.js", "dist", file)
    });
    let data = null;
    try {
      data = fs.readFileSync(dbPath);
    } catch (_) {
      /* new db */
    }
    const db = new SQL.Database(data || undefined);
    db.run("PRAGMA foreign_keys = ON");

    const schema = `
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        elo INTEGER NOT NULL DEFAULT 1200,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS matches (
        id TEXT PRIMARY KEY,
        problem_slug TEXT NOT NULL,
        problem_title TEXT NOT NULL,
        difficulty TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        ranked INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS match_players (
        id TEXT PRIMARY KEY,
        match_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        elo_before INTEGER NOT NULL,
        elo_after INTEGER,
        runtime_ms INTEGER,
        submitted_at TEXT,
        is_winner INTEGER,
        UNIQUE(match_id, user_id),
        FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS matchmaking_queue (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE,
        desired_difficulty TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `;
    db.run(schema);
    try {
      db.run("ALTER TABLE matches ADD COLUMN ranked INTEGER NOT NULL DEFAULT 1");
    } catch (_) {
      /* column may already exist */
    }
    persist(db);

    const wrap = {
      run(sql, ...params) {
        if (params.length > 0) {
          db.run(sql, params);
        } else {
          db.run(sql);
        }
        persist(db);
        return Promise.resolve({ changes: db.getRowsModified() });
      },
      get(sql, ...params) {
        const stmt = db.prepare(sql);
        if (params.length > 0) stmt.bind(params);
        const row = stmt.step() ? stmt.getAsObject() : undefined;
        stmt.free();
        return Promise.resolve(row);
      },
      all(sql, ...params) {
        const stmt = db.prepare(sql);
        if (params.length > 0) stmt.bind(params);
        const rows = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        stmt.free();
        return Promise.resolve(rows);
      },
      exec(sql) {
        db.exec(sql);
        persist(db);
        return Promise.resolve();
      }
    };
    dbPromise = Promise.resolve(wrap);
  }
  return dbPromise;
}
