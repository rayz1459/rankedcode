import sqlite3 from "sqlite3";
import { open } from "sqlite";

let dbPromise;

export async function getDb() {
  if (!dbPromise) {
    dbPromise = open({
      filename: new URL("../ranked-leetcode.db", import.meta.url).pathname,
      driver: sqlite3.Database
    });
    const db = await dbPromise;
    await db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
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
        created_at TEXT NOT NULL
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
    `);
  }
  return dbPromise;
}
