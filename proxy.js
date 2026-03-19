const express = require('express');
const path = require('path');
const app = express();
app.use(express.json({ limit: '10mb' }));

const OPENWIRE_URL = process.env.OPENWIRE_URL || 'http://localhost:3030';
const MODEL = process.env.INVOICER_MODEL || 'claude-sonnet-4.6';
const PORT = process.env.PORT || 3001;
const ROOT = '/Users/aigaurav/.openclaw/workspace/invoicer';

// Root → index.html
app.get('/', (req, res) => {
  res.sendFile('index.html', { root: ROOT });
});

// Serve static assets
app.use(express.static(ROOT));

// CORS preflight
app.options('/api/claude', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.sendStatus(204);
});

// Claude proxy — streams from OpenWire to avoid Cloudflare 524 timeout
app.post('/api/claude', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const messages = [];
    if (req.body.system) {
      messages.push({ role: 'system', content: req.body.system });
    }
    messages.push({ role: 'user', content: req.body.prompt || '' });

    const response = await fetch(`${OPENWIRE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages,
        max_tokens: 16000,
        stream: true,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      res.write(`data: ${JSON.stringify({ error: err.error?.message || `HTTP ${response.status}` })}\n\n`);
      return res.end();
    }

    let fullContent = '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content || '';
          if (delta) fullContent += delta;
        } catch (_) {}
      }
    }

    // Send complete content as final SSE event
    res.write(`data: ${JSON.stringify({ content: fullContent })}\n\n`);
    res.end();
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`Invoicer running on http://localhost:${PORT}`);
  console.log(`  → OpenWire: ${OPENWIRE_URL}`);
  console.log(`  → Model: ${MODEL}`);
});
