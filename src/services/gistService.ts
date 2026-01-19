import * as vscode from "vscode";
import * as https from "https";

export class GistService {
  private _token: string | undefined;
  private _customToken: string | undefined;

  constructor() {}

  public setCustomToken(token: string | undefined): void {
    this._customToken = token;
    this._token = undefined; // Force re-authentication if token changes
  }

  public clearToken(): void {
    this._token = undefined;
    this._customToken = undefined;
  }

  private async ensureAuthenticated(): Promise<string> {
    // If we have a manually set custom token (e.g. from B account), use it exclusively
    if (this._customToken) {
      return this._customToken;
    }

    if (this._token) {
      return this._token;
    }

    const session = await vscode.authentication.getSession("github", ["gist"], {
      createIfNone: true,
      clearSessionPreference: true,
    });
    if (session) {
      this._token = session.accessToken;
      return this._token;
    }

    throw new Error("GitHub authentication failed or was cancelled.");
  }

  private async request(
    method: string,
    path: string,
    body?: any,
  ): Promise<any> {
    const token = await this.ensureAuthenticated();

    return new Promise((resolve, reject) => {
      const options: https.RequestOptions = {
        hostname: "api.github.com",
        path: path,
        method: method,
        headers: {
          Authorization: `token ${token}`,
          "User-Agent": "VS Code Tree Note Extension",
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
        },
      };

      const req = https.request(options, (res) => {
        let data = "";

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              // Some responses might be empty (e.g. 204)
              if (data.trim() === "") {
                resolve({});
              } else {
                resolve(JSON.parse(data));
              }
            } catch (e) {
              reject(new Error(`Failed to parse GitHub response: ${e}`));
            }
          } else {
            reject(
              new Error(
                `GitHub API request failed: ${res.statusCode} ${res.statusMessage} - ${data}`,
              ),
            );
          }
        });
      });

      req.on("error", (e) => {
        reject(e);
      });

      if (body) {
        req.write(JSON.stringify(body));
      }

      req.end();
    });
  }

  async getGist(gistId: string): Promise<any> {
    return this.request("GET", `/gists/${gistId}?ts=${Date.now()}`);
  }

  async createGist(
    description: string,
    files: Record<string, { content: string }>,
    isPublic: boolean = false,
  ): Promise<any> {
    return this.request("POST", "/gists", {
      description,
      public: isPublic,
      files,
    });
  }

  /**
   * Update a Gist.
   * @param gistId The ID of the Gist to update.
   * @param files A map of filenames to content. To delete a file, set its value to null.
   */
  async updateGist(
    gistId: string,
    files: Record<string, { content: string } | null>,
  ): Promise<any> {
    if (Object.keys(files).length === 0) {
      return Promise.resolve({});
    }

    return this.request("PATCH", `/gists/${gistId}`, {
      files,
    });
  }
}
