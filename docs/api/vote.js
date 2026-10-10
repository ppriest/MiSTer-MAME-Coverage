// POST   /api/vote  {kind, key, nickname}  -> upsert this visitor's vote for a title or a driver
// DELETE /api/vote  {kind, key}            -> withdraw it
// One vote per (kind, key, IP hash): voting again only updates the nickname.
const { ensure, ipHash, json, sameOrigin, cleanNickname, KEY_RE, knownKeys, readBody } = require("./_lib");

const PER_HOUR = 60;

module.exports = async (req, res) => {
  if (req.method !== "POST" && req.method !== "DELETE") { res.setHeader("Allow", "POST, DELETE"); return json(res, 405, { error: "method not allowed" }); }
  if (!sameOrigin(req)) return json(res, 403, { error: "cross-origin request refused" });
  try {
    const body = await readBody(req);
    const kind = body.kind, key = String(body.key || "").toLowerCase();
    if (kind !== "title" && kind !== "driver") return json(res, 400, { error: "kind must be title or driver" });
    if (!KEY_RE[kind].test(key)) return json(res, 400, { error: "invalid key" });
    const known = await knownKeys(req);
    if (known && !known[kind].has(key)) return json(res, 404, { error: `unknown ${kind}` });

    const sql = await ensure();
    const ip = ipHash(req);
    if (req.method === "DELETE") {
      await sql`DELETE FROM votes WHERE kind = ${kind} AND key = ${key} AND ip_hash = ${ip}`;
    } else {
      const [{ n }] = await sql`SELECT count(*)::int AS n FROM votes WHERE ip_hash = ${ip} AND updated_at > now() - interval '1 hour'`;
      if (n >= PER_HOUR) return json(res, 429, { error: "too many votes, try again later" });
      await sql`INSERT INTO votes (kind, key, ip_hash, nickname) VALUES (${kind}, ${key}, ${ip}, ${cleanNickname(body.nickname)})
                ON CONFLICT (kind, key, ip_hash) DO UPDATE SET nickname = EXCLUDED.nickname, updated_at = now()`;
    }
    const [{ votes }] = await sql`SELECT count(*)::int AS votes FROM votes WHERE kind = ${kind} AND key = ${key}`;
    return json(res, 200, { kind, key, votes, voted: req.method !== "DELETE" });
  } catch (e) {
    return json(res, 500, { error: "vote failed" });
  }
};
