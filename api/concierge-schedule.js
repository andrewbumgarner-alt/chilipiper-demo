const BASE = 'https://fire.chilipiper.com/api/fire-edge';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).end('Method Not Allowed');

  const { routingId, ...body } = req.body;

  if (!routingId) {
    return res.status(400).json({ error: 'routingId is required' });
  }

  try {
    const upstream = await fetch(
      `${BASE}/v1/org/concierge/routing/${routingId}/schedule-simple`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.CHILI_PIPER_API_KEY}`,
        },
        body: JSON.stringify(body),
      }
    );

    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
};
