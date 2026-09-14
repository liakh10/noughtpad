import * as A from '../lib/api.js';
import * as E from '../lib/engine.js';
import { redis } from '../lib/store.js';
import { prices } from '../lib/prices.js';
export default async function handler(req, res) {
  try {
    await A.seed();
    const R = redis(), t = A.now(), q = req.query || {};
    const ids = await R.lrange('nt:ts', 0, 199);
    let sums = ids.length ? (await R.mget(...ids.map(i => 'nt:s:' + i))).filter(Boolean).map(E.unpack) : [];
    const due = sums.filter(s => E.isDue({ lastCheck: s.lastCheck, lastRoundAt: s.lastRoundAt, vault: s.vault }, t)).map(s => s.id);
    if (q.t && !due.includes(String(q.t))) due.unshift(String(q.t));
    let ran = false;
    for (const id of due.slice(0, 3)) { try { if (await A.tick(id, t)) ran = true; } catch {} }
    if (ran) sums = (await R.mget(...ids.map(i => 'nt:s:' + i))).filter(Boolean).map(E.unpack);
    let pid = null, player = null, rewards = [];
    if (q.key) {
      pid = A.pidOf(q.key); player = await A.loadPlayer(pid, false);
      rewards = (await R.lrange('nt:rw:' + pid, 0, 99)).map(E.unpack);
    }
    const out = { now: t, pid, player: A.playerView(player), rewards, prices: await prices(), tokens: sums };
    if (q.t) out.token = A.tokenView(await A.loadToken(String(q.t)), pid, t);
    A.json(res, 200, out);
  } catch (e) { A.json(res, 400, { error: e.message }); }
}
