// GET /api/mine -> {titles: [keys], drivers: [keys]} this visitor (by IP hash) has voted for. Never cached.
const { ensure, ipHash, json } = require("./_lib");

module.exports = async (req, res) => {
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return json(res, 405, { error: "method not allowed" }); }
  try {
    const sql = await ensure();
    const rows = await sql`SELECT kind, key FROM votes WHERE ip_hash = ${ipHash(req)}`;
    return json(res, 200, { titles: rows.filter(r => r.kind === "title").map(r => r.key), drivers: rows.filter(r => r.kind === "driver").map(r => r.key) });
  } catch (e) {
    return json(res, 500, { error: "unavailable" });
  }
};
