/** Cosine similarity reads as `0.98`; a keyword relevance above 1 keeps one decimal. */
export const formatScore = (score: number) => (score <= 1 ? score.toFixed(2) : score.toFixed(1))
