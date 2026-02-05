# Ranked LeetCode

A lightweight web app for 1v1 LeetCode battles with Elo ratings based on runtime performance.

## Features
- Email/password accounts
- Quick-play ranked queue plus custom 1v1 rooms
- LeetCode problem pulls (GraphQL proxy)
- Runtime-based Elo updates
- Leaderboard, stats, and match history

## Quick start
```bash
npm install
npm run dev
```

Visit `http://localhost:3000`.

## Notes
- This is a prototype. Do not use the default JWT secret in production.
- LeetCode does not provide an official public API; the app calls the public GraphQL endpoint for problem metadata.
- Runtime submission is manual in this prototype. You can extend it to ingest actual submissions via a judge or browser extension.
