# Invoicer MVP

PDF invoice parser powered by Claude AI.

## Setup

### 1. Install proxy dependencies
```bash
cd invoicer
npm install
```

### 2. Start the CORS proxy
```bash
node proxy.js
```
Proxy runs on `http://localhost:3001`.

### 3. Serve the frontend
You need an HTTP server (not `file://`). Any of these work:
```bash
npx serve .          # simplest
python3 -m http.server 8080
npx http-server . -p 8080
```
Then open `http://localhost:8080`.

### 4. Set your API key
Click ⚙️ Settings in the UI and enter your Anthropic API key. It's saved to `localStorage` (`invoicer_api_key`).

## Test Harness

1. Add test pairs to `pdfs/` (PDF files) and `expected/` (JSON files with same base name).
2. Update `manifest.json`:
```json
{ "tests": [{ "pdf": "pdfs/invoice1.pdf", "expected": "expected/invoice1.json" }] }
```
3. Click **Run Tests** in the UI.

## Architecture

- `index.html` — single-file frontend (embedded CSS + JS)
- `proxy.js` — Express CORS proxy forwarding to Anthropic API
- `manifest.json` — test harness configuration
- `pdfs/` — test PDF files
- `expected/` — expected JSON output for tests
