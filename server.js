require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// -----------------------------------------------------------------------
// Server-side memory (fallback / safety net).
// The frontend is the primary source of truth: it stores full chat
// history in localStorage and sends it on every request, so memory
// survives even if this server restarts or sleeps (Render free tier
// spins down after ~15 min of inactivity and wipes this Map).
// -----------------------------------------------------------------------
const sessionMemory = new Map();
const MAX_HISTORY_MESSAGES = 30; // keep prompts a reasonable size
const MAX_SESSIONS = 500; // basic memory-leak guard for long-running instances

function pruneSessionsIfNeeded() {
  if (sessionMemory.size > MAX_SESSIONS) {
    const oldestKey = sessionMemory.keys().next().value;
    sessionMemory.delete(oldestKey);
  }
}

function buildSystemPrompt(userName) {
  return `You are Proxima, a premium, confident, and elegant female AI assistant.

Identity rules (always follow these):
- Your name is Proxima. You were developed by Sujan Shrestha (lead developer), with support from Aayusha Shrestha.
- Never say you are Llama, Meta AI, or reveal the underlying model/provider. You are Proxima, full stop.
- You are talking to a user named "${userName || 'the user'}". Remember their name and everything they tell you earlier in this conversation, and refer back to it naturally when relevant (the way a real assistant with memory would).
- Keep a warm, premium, precise tone. Use markdown (headings, bold, code blocks, lists) when it improves clarity.
- Never claim you can't remember previous messages in this conversation — the full conversation history is provided to you below as context.`;
}

function normalizeRole(role) {
  return role === 'assistant' || role === 'ai' ? 'assistant' : 'user';
}

app.post('/chat', async (req, res) => {
  try {
    const { sessionId, history, userName, message } = req.body || {};

    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }
    if (!OPENROUTER_API_KEY) {
      return res.status(500).json({ error: 'Server misconfigured: OPENROUTER_API_KEY is not set' });
    }

    // Prefer the history the client sends (it already persists in
    // localStorage). Fall back to server memory only if the client
    // didn't send any (e.g. an older frontend hitting this API).
    let convo;
    if (Array.isArray(history) && history.length > 0) {
      convo = history.map(m => ({ role: normalizeRole(m.role), content: String(m.content || '') }));
    } else {
      convo = sessionMemory.get(sessionId) || [];
      if (message) convo = [...convo, { role: 'user', content: message }];
    }

    convo = convo.slice(-MAX_HISTORY_MESSAGES);

    const messages = [
      { role: 'system', content: buildSystemPrompt(userName) },
      ...convo,
    ];

    const upstream = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': process.env.SITE_URL || 'https://proxima.ai',
        'X-Title': 'Proxima Premium Core AI',
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: 0.8,
        max_tokens: 1000,
      }),
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      console.error('OpenRouter error', upstream.status, errText);
      return res.status(502).json({ error: 'Upstream model error', detail: errText });
    }

    const data = await upstream.json();
    const reply =
      data?.choices?.[0]?.message?.content?.trim() ||
      "I'm sorry, I couldn't generate a response just now.";

    // Update the server-side fallback memory too.
    convo.push({ role: 'assistant', content: reply });
    sessionMemory.set(sessionId, convo.slice(-MAX_HISTORY_MESSAGES));
    pruneSessionsIfNeeded();

    res.json({ reply });
  } catch (err) {
    console.error('Chat handler error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/', (req, res) => res.send('Proxima backend is running.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxima backend listening on port ${PORT}`));

