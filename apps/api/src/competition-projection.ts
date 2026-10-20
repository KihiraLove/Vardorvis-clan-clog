/** Public XP competition standings use exact combined scores and WOM's tie order. */
export const competitionPublicColumns =
  'metric_definitions AS "metricDefinitions",' +
  "(SELECT COALESCE(jsonb_agg(p.value),'[]'::jsonb) FROM (" +
  "SELECT value FROM jsonb_array_elements(COALESCE(competition_results,activity_results,'[]'::jsonb)) " +
  "ORDER BY (value->>'gained')::numeric DESC,(value->>'rank')::int NULLS LAST,(value->>'playerId')::bigint LIMIT 3" +
  ') p) AS standings';
