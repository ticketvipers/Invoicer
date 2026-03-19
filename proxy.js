const express = require('express');
const app = express();
app.use(express.json({ limit: '10mb' }));

const OPENWIRE_URL = process.env.OPENWIRE_URL || 'http://localhost:3030';
const MODEL = process.env.INVOICER_MODEL || 'claude-sonnet-4.6';

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  next();
});

app.options('/api/claude', (req, res) => res.sendStatus(204));

// Health
app.get('/', (req, res) => res.json({ status: 'ok', backend: OPENWIRE_URL, model: MODEL }));

app.post('/api/claude', async (req, res) => {
  try {
    // Accept { prompt: "..." } from the frontend and convert to OpenAI chat format
    const userPrompt = req.body.prompt || (req.body.messages && req.body.messages[0]?.content) || '';

    const payload = {
      model: MODEL,
      messages: [{ role: 'user', content: userPrompt }],
      max_tokens: 8192,
    };

    const response = await fetch(`${OPENWIRE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    // Return the assistant message content directly for easy consumption
    const content = data.choices?.[0]?.message?.content || '';
    res.json({ content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(3001, () => {
  console.log(`Invoicer proxy listening on http://localhost:3001`);
  console.log(`  → Forwarding to OpenWire at ${OPENWIRE_URL}`);
  console.log(`  → Model: ${MODEL}`);
});
