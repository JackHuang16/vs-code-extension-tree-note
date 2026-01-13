import * as vscode from "vscode";
import * as https from "https";
import { EventEmitter } from "events";
import { GistService } from "./gistService";

// Mock vscode
const mockedVscode = vscode as any;

// Mock https
jest.mock("https");
const mockedHttps = https as jest.Mocked<typeof https>;

describe("GistService", () => {
  let service: GistService;
  let mockRequest: any;
  let mockResponse: any;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new GistService();

    // Setup mock response
    mockResponse = new EventEmitter();
    mockResponse.statusCode = 200;
    mockResponse.statusMessage = "OK";

    // Setup mock request
    mockRequest = new EventEmitter();
    mockRequest.write = jest.fn();
    mockRequest.end = jest.fn();

    mockedHttps.request.mockImplementation((options: any, callback: any) => {
      callback(mockResponse);
      return mockRequest;
    });
  });

  describe("ensureAuthenticated", () => {
    it("should get session from vscode if not authenticated", async () => {
      const mockSession = { accessToken: "fake-token" };
      mockedVscode.authentication.getSession.mockResolvedValue(mockSession);

      // We trigger a request to force authentication
      const promise = service.getGist("123");

      // Simulate successful response
      setImmediate(() => {
        mockResponse.emit("data", JSON.stringify({ id: "123" }));
        mockResponse.emit("end");
      });

      await promise;

      expect(mockedVscode.authentication.getSession).toHaveBeenCalledWith(
        "github",
        ["gist"],
        { createIfNone: true }
      );
    });

    it("should throw error if authentication fails", async () => {
      mockedVscode.authentication.getSession.mockResolvedValue(null);

      await expect(service.getGist("123")).rejects.toThrow(
        "GitHub authentication failed or was cancelled."
      );
    });
  });

  describe("API Methods", () => {
    beforeEach(() => {
      mockedVscode.authentication.getSession.mockResolvedValue({
        accessToken: "fake-token",
      });
    });

    it("getGist should make a GET request", async () => {
      const promise = service.getGist("gist-id");

      setImmediate(() => {
        mockResponse.emit("data", JSON.stringify({ id: "gist-id" }));
        mockResponse.emit("end");
      });

      const result = await promise;

      expect(result.id).toBe("gist-id");
      expect(mockedHttps.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "GET",
          path: expect.stringContaining("/gists/gist-id"),
          hostname: "api.github.com",
        }),
        expect.any(Function)
      );
    });

    it("createGist should make a POST request with body", async () => {
      const files = { "test.md": { content: "hello" } };
      const promise = service.createGist("desc", files, true);

      setImmediate(() => {
        mockResponse.emit("data", JSON.stringify({ id: "new-id" }));
        mockResponse.emit("end");
      });

      const result = await promise;

      expect(result.id).toBe("new-id");
      expect(mockedHttps.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "POST",
          path: "/gists",
        }),
        expect.any(Function)
      );
      expect(mockRequest.write).toHaveBeenCalledWith(
        JSON.stringify({
          description: "desc",
          public: true,
          files,
        })
      );
    });

    it("updateGist should make a PATCH request", async () => {
      const files = { "test.md": { content: "updated" } };
      const promise = service.updateGist("gist-id", files);

      setImmediate(() => {
        mockResponse.emit("data", JSON.stringify({ id: "gist-id" }));
        mockResponse.emit("end");
      });

      await promise;

      expect(mockedHttps.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "PATCH",
          path: "/gists/gist-id",
        }),
        expect.any(Function)
      );
    });

    it("should handle API errors", async () => {
      mockResponse.statusCode = 404;
      mockResponse.statusMessage = "Not Found";

      const promise = service.getGist("non-existent");

      setImmediate(() => {
        mockResponse.emit("data", "File not found");
        mockResponse.emit("end");
      });

      await expect(promise).rejects.toThrow(
        "GitHub API request failed: 404 Not Found - File not found"
      );
    });

    it("should handle empty responses (204 No Content)", async () => {
      mockResponse.statusCode = 204;
      const promise = service.getGist("gist-id");

      setImmediate(() => {
        mockResponse.emit("data", "");
        mockResponse.emit("end");
      });

      const result = await promise;
      expect(result).toEqual({});
    });
  });
});
