const express = require('express');
const path = require('path');
const app = express();
app.use(express.json({ limit: '10mb' }));

const OPENWIRE_URL = process.env.OPENWIRE_URL || 'http://localhost:3030';
const MODEL = process.env.INVOICER_MODEL || 'claude-sonnet-4.6';
const PORT = process.env.PORT || 3001;

// Serve static files (index.html, pdfs/, expected/, manifest.json)
app.use(express.static(path.join(__dirname)));

// Health
app.get('/health', (req, res) => res.json({ status: 'ok', backend: OPENWIRE_URL, model: MODEL }));

app.options('/api/claude', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.sendStatus(204);
});

app.post('/api/claude', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const userPrompt = req.body.prompt || '';

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

    const content = data.choices?.[0]?.message?.content || '';
    res.json({ content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Invoicer running on http://localhost:${PORT}`);
  console.log(`  → OpenWire: ${OPENWIRE_URL}`);
  console.log(`  → Model: ${MODEL}`);
});
