# Poker Frontend

Browser frontend to play 1v1 against your poker bot API.

## Run locally

```bash
npm install
npm run start
```

Open `http://localhost:3000`.

## Environment variables

- `PORT` (default: `3000`)
- `BOT_API_BASE_URL` (default: `http://127.0.0.1:8787`)

Example:

```bash
BOT_API_BASE_URL=https://your-ngrok-url.ngrok-free.app npm run start
```

## Railway

Set Railway env vars:

- `BOT_API_BASE_URL` -> your public bot API base URL (for example ngrok URL)
- `PORT` is provided by Railway automatically

Start command:

```bash
npm run start
```
