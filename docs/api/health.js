// GET /api/health -> which pieces of the wishlist backend are in place (no secrets, never cached).
const { json, why, hasDb, ensure } = require("./_lib");

module.exports = async (req, res) => {
  const out = { functions: true, database_url: hasDb(), vote_salt: !!process.env.VOTE_SALT, database: false };
  try { await ensure(); out.database = true; } catch (e) { out.error = why(e); }
  return json(res, out.database ? 200 : 503, out);
};
