import { calculateSha1 } from "./cryptoUtils";

describe("cryptoUtils", () => {
  it("should calculate SHA1 hash correctly", () => {
    const content = "hello world";
    const result = calculateSha1(content);
    // sha1sum of "hello world" is 2aae6c35c94fcfb415dbe95f408b9ce91ee846ed
    expect(result).toBe("2aae6c35c94fcfb415dbe95f408b9ce91ee846ed");
  });

  it("should return different hashes for different content", () => {
    const h1 = calculateSha1("a");
    const h2 = calculateSha1("b");
    expect(h1).not.toBe(h2);
  });
});
