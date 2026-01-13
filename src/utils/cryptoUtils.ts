import * as crypto from "crypto";

export function calculateSha1(content: string): string {
  return crypto.createHash("sha1").update(content).digest("hex");
}
