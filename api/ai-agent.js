const BASE = 'https://fire.chilipiper.com/api/fire-edge';
const ROUTER_SLUG = 'inbound-override-router---marketo';

const SYSTEM = `You are Aria, a friendly and efficient meeting booking assistant for Apex — a B2B revenue acceleration platform powered by Chili Piper.

Your sole job: book a product demo for the visitor.

Rules:
- Be warm but brief. Each reply ≤ 2 sentences.
- Collect firstName, lastName, and email naturally through conversation.
- The moment you have all three, call route_lead immediately — do NOT ask for anything else first.
- Never ask for info you already have. Never repeat what the user just said.
- Never mention "routing", "API calls", or internal processes to the user.
- Do not list available time slots in text — they will be shown automatically in the UI.`;

const TOOLS = [
  {
    name: 'route_lead',
    description: 'Find available demo meeting times for this lead via Chili Piper Concierge. Call this as soon as firstName, lastName, and email are known.',
    input_schema: {
      type: 'object',
      properties: {
        firstName:   { type: 'string', description: 'Lead first name' },
        lastName:    { type: 'string', description: 'Lead last name' },
        email:       { type: 'string', description: 'Lead work email address' },
        company:     { type: 'string', description: 'Lead company name (optional)' },
        companySize: { type: 'string', description: 'Company employee count (optional)' },
        timezone:    { type: 'string', description: 'Lead timezone, e.g. America/New_York' }
      },
      required: ['firstName', 'lastName', 'email']
    }
  }
];

async function callClaude(messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':    'application/json',
      'x-api-key':       process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-6',
      max_tokens: 256,
      system:     SYSTEM,
      tools:      TOOLS,
      messages
    })
  });
  return res.json();
}

async function routeLead(input, tz) {
  const form = {
    email:     input.email,
    firstname: input.firstName,
    lastname:  input.lastName,
  };
  if (input.company)     form.Company      = input.company;
  if (input.companySize) form.EmployeeSize = input.companySize;

  const body = {
    form,
    options:  { timezone: tz },
    interval: { startsAt: new Date().toISOString(), duration: '7 days' }
  };

  const res = await fetch(
    `${BASE}/v1/org/concierge/routers/${ROUTER_SLUG}/rest`,
    {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${process.env.CHILI_PIPER_API_KEY}`
      },
      body: JSON.stringify(body)
    }
  );
  return res.json();
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).end('Method Not Allowed');

  const body = req.body;

  // ── Direct booking mode (no Claude needed) ──────────────────────────────────
  if (body.mode === 'book') {
    const { routingId, startTime, tz, lead } = body;
    try {
      const upstream = await fetch(
        `${BASE}/v1/org/concierge/routing/${routingId}/schedule-simple`,
        {
          method:  'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${process.env.CHILI_PIPER_API_KEY}`
          },
          body: JSON.stringify({ startTime, timezone: tz, lead })
        }
      );
      const data = await upstream.json();
      if (!upstream.ok) throw new Error(data?.message || JSON.stringify(data));
      return res.json({
        confirmed: {
          startTime,
          tz,
          lead,
          id: data?.id || data?.meetingId || '—'
        }
      });
    } catch (err) {
      return res.status(502).json({ error: err.message });
    }
  }

  // ── Chat mode — Claude agentic loop ─────────────────────────────────────────
  const { messages, tz = 'America/New_York' } = body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }

  try {
    let msgs      = [...messages];
    let routeData = null;
    let formData  = null;

    for (let i = 0; i < 4; i++) {
      const response = await callClaude(msgs);

      if (response.stop_reason === 'tool_use') {
        const toolUse = response.content.find(b => b.type === 'tool_use');

        if (toolUse?.name === 'route_lead') {
          formData = toolUse.input;
          const result = await routeLead(formData, tz);

          if (!result.routeId) {
            msgs = [
              ...msgs,
              { role: 'assistant', content: response.content },
              {
                role: 'user',
                content: [{
                  type:        'tool_result',
                  tool_use_id: toolUse.id,
                  content:     'Routing failed — no routeId returned. Apologize briefly and ask the user to try again.'
                }]
              }
            ];
            continue;
          }

          const slots = result?.schedulingData?.startTimes || result?.startTimes || [];
          routeData   = { routeId: result.routeId, slots };

          msgs = [
            ...msgs,
            { role: 'assistant', content: response.content },
            {
              role: 'user',
              content: [{
                type:        'tool_result',
                tool_use_id: toolUse.id,
                content:     `Success. Found ${slots.length} open slots. Tell the user that the available times are showing now and to pick whichever works best. Keep it to one sentence.`
              }]
            }
          ];
          continue;
        }
      }

      // Text response — return to frontend
      const text = response.content?.find(b => b.type === 'text')?.text || '';
      return res.json({
        reply:     text,
        messages:  [...msgs, { role: 'assistant', content: response.content }],
        routeData,
        formData
      });
    }

    return res.json({
      reply:    "I ran into a problem. Please refresh and try again.",
      messages: msgs
    });

  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
};
