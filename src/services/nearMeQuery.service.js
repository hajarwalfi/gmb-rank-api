/**
 * "Near me" keywords: UI keeps the human phrase; Google/SerpAPI use the service area in-query.
 * Example: "plumbing near me" + area "Bhavnagar" → "plumbing in Bhavnagar" for search backends.
 */
export function replaceNearMeWithServiceArea(keyword, serviceArea) {
  const k = String(keyword ?? '').trim();
  const area = String(serviceArea ?? '').trim();
  if (!k) return k;
  if (!/\bnear\s+me\b/i.test(k)) return k;
  if (!area) return k;
  return k.replace(/\bnear\s+me\b/gi, `in ${area}`).replace(/\s{2,}/g, ' ').trim();
}
