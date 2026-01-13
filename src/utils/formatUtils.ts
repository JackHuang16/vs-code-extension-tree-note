/**
 * Generates a formatted timestamp string for conflict file naming.
 * Format: YYYY-MM-DD HHh-MMm-SSs
 * @param date - The date to format (defaults to current date)
 * @returns Formatted timestamp string
 */
export function generateConflictTimestamp(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");

  return `${year}-${month}-${day} ${hours}h-${minutes}m-${seconds}s`;
}
