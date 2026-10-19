-- Preserve existing imports and archived rows; fresh imports retain full metric definitions/results.
ALTER TABLE wom_competitions
    ADD COLUMN metric_definitions jsonb,
    ADD COLUMN competition_results jsonb,
    ADD CONSTRAINT wom_competitions_metric_definitions_check CHECK (
        metric_definitions IS NULL OR (
            jsonb_typeof(metric_definitions) = 'array'
            AND jsonb_array_length(metric_definitions) = jsonb_array_length(metrics)
        )
    ),
    ADD CONSTRAINT wom_competitions_results_check CHECK (
        competition_results IS NULL OR (
            jsonb_typeof(competition_results) = 'array'
            AND (jsonb_array_length(competition_results) = 0 OR results_imported_at IS NOT NULL)
        )
    );
