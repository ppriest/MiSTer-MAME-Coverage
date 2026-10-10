// GET /api/wishlist -> {titles: [...], drivers: [...]}, each [{key, votes, first_vote, last_vote, voters: [{nickname, at}]}],
// most votes first. `at` / first_vote / last_vote are ISO timestamps (the votes table keeps created_at and updated_at).
// Public and cacheable; which items the caller voted for is /api/mine.
const { why, ensure, json } = require("./_lib");

module.exports = async (req, res) => {
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return json(res, 405, { error: "method not allowed" }); }
  try {
    const sql = await ensure();
    const rows = await sql`
      SELECT kind, key, count(*)::int AS votes,
             (array_agg(nickname ORDER BY updated_at DESC))[1:5] AS voters,
             (array_agg(updated_at ORDER BY updated_at DESC))[1:5] AS voter_times,
             min(created_at) AS first_vote, max(updated_at) AS last_vote
      FROM votes GROUP BY kind, key
      ORDER BY votes DESC, last_vote DESC, key`;
    const pick = kind => rows.filter(r => r.kind === kind).map(r => ({
      key: r.key, votes: r.votes, first_vote: new Date(r.first_vote).toISOString(), last_vote: new Date(r.last_vote).toISOString(),
      voters: r.voters.map((nickname, i) => ({ nickname, at: new Date(r.voter_times[i]).toISOString() })),
    }));
    return json(res, 200, { titles: pick("title"), drivers: pick("driver") }, "public, s-maxage=20, stale-while-revalidate=60");
  } catch (e) {
    console.error("wishlist:", e);
    return json(res, 500, { error: "wishlist unavailable", detail: why(e) });
  }
};
