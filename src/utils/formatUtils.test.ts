import { generateConflictTimestamp } from "./formatUtils";

describe("formatUtils", () => {
  describe("generateConflictTimestamp", () => {
    it("should format a date correctly", () => {
      // 2024-05-20 15:30:45
      const date = new Date(2024, 4, 20, 15, 30, 45);
      const result = generateConflictTimestamp(date);
      expect(result).toBe("2024-05-20 15h-30m-45s");
    });

    it("should pad single digits with zeros", () => {
      // 2024-01-05 09:05:07
      const date = new Date(2024, 0, 5, 9, 5, 7);
      const result = generateConflictTimestamp(date);
      expect(result).toBe("2024-01-05 09h-05m-07s");
    });

    it("should use current date if no date is provided", () => {
      const now = new Date();
      const result = generateConflictTimestamp();

      // We check if it starts with the current year to be sure it's working
      expect(result).toContain(String(now.getFullYear()));
    });
  });
});
