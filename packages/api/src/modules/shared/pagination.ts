/** Clamp pagination to safe bounds and compute the SQL offset. */
export function paginate(page = 1, limit = 20): { page: number; limit: number; offset: number } {
  const p = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  const l = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 100) : 20;
  return { page: p, limit: l, offset: (p - 1) * l };
}
