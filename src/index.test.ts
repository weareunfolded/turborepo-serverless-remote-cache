import { beforeEach, describe, expect, it, vi } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";

const mockSend = vi.hoisted(() => vi.fn());
const mockGetSignedUrl = vi.hoisted(() => vi.fn());

vi.mock("sst", () => ({
	Resource: {
		TurboCacheToken: { value: "secret-token" },
		S3TurboCache: { name: "test-bucket" },
	},
}));

vi.mock("@aws-sdk/client-s3", () => ({
	S3Client: vi.fn(() => ({ send: mockSend })),
	HeadObjectCommand: vi.fn((input: unknown) => input),
	GetObjectCommand: vi.fn(() => ({ middlewareStack: { add: vi.fn() } })),
	PutObjectCommand: vi.fn((input: unknown) => input),
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({
	getSignedUrl: mockGetSignedUrl,
}));

import { GetObjectCommand } from "@aws-sdk/client-s3";
import {
	getArtifact,
	getStatus,
	headArtifact,
	postEvents,
	preflightArtifact,
} from "./index.js";

const TOKEN = "secret-token";
const BUCKET = "test-bucket";
const HASH = "abc123def456";
const PRESIGNED_URL = "https://test-bucket.s3.eu-west-1.amazonaws.com/presigned";

function event(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
	return {
		version: "2.0",
		routeKey: "$default",
		rawPath: "/",
		rawQueryString: "",
		headers: { authorization: `Bearer ${TOKEN}` },
		requestContext: {} as APIGatewayProxyEventV2["requestContext"],
		isBase64Encoded: false,
		...overrides,
	} as APIGatewayProxyEventV2;
}

function artifactEvent(
	overrides: Partial<APIGatewayProxyEventV2> = {},
): APIGatewayProxyEventV2 {
	return event({ pathParameters: { hash: HASH }, ...overrides });
}

beforeEach(() => {
	vi.clearAllMocks();
	mockGetSignedUrl.mockResolvedValue(PRESIGNED_URL);
});

describe("getStatus", () => {
	it("returns 200 with enabled status", async () => {
		expect(await getStatus(event())).toEqual({
			statusCode: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "enabled" }),
		});
	});

	it("returns 401 for wrong token", async () => {
		const res = await getStatus(event({ headers: { authorization: "Bearer wrong" } }));
		expect(res.statusCode).toBe(401);
	});

	it("returns 401 for token of different length", async () => {
		const res = await getStatus(event({ headers: { authorization: "Bearer x" } }));
		expect(res.statusCode).toBe(401);
	});

	it("returns 401 when authorization header is missing", async () => {
		const res = await getStatus(event({ headers: {} }));
		expect(res.statusCode).toBe(401);
	});
});

describe("postEvents", () => {
	it("returns 200", async () => {
		const res = await postEvents(event());
		expect(res.statusCode).toBe(200);
	});

	it("returns 401 for bad token", async () => {
		const res = await postEvents(event({ headers: { authorization: "Bearer bad" } }));
		expect(res.statusCode).toBe(401);
	});
});

describe("headArtifact", () => {
	it("returns 200 when artifact exists in S3", async () => {
		mockSend.mockResolvedValueOnce({});
		const res = await headArtifact(artifactEvent());
		expect(res.statusCode).toBe(200);
		expect(mockSend).toHaveBeenCalledWith(
			expect.objectContaining({ Bucket: BUCKET, Key: `v8/artifacts/${HASH}` }),
		);
	});

	it("returns 404 when S3 returns 404", async () => {
		mockSend.mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } });
		expect((await headArtifact(artifactEvent())).statusCode).toBe(404);
	});

	it("rethrows unexpected S3 errors", async () => {
		mockSend.mockRejectedValueOnce(new Error("network error"));
		await expect(headArtifact(artifactEvent())).rejects.toThrow("network error");
	});

	it("returns 400 when hash is missing", async () => {
		const res = await headArtifact(event({ pathParameters: {} }));
		expect(res.statusCode).toBe(400);
	});

	it("returns 401 for bad token", async () => {
		const res = await headArtifact(
			artifactEvent({ headers: { authorization: "Bearer bad" } }),
		);
		expect(res.statusCode).toBe(401);
	});
});

describe("getArtifact", () => {
	it("returns 307 redirect to presigned S3 GET URL", async () => {
		mockSend.mockResolvedValueOnce({});
		const res = await getArtifact(artifactEvent());
		expect(res.statusCode).toBe(307);
		expect((res as { headers: Record<string, string> }).headers.Location).toBe(PRESIGNED_URL);
	});

	it("calls GetObjectCommand with correct bucket and key", async () => {
		mockSend.mockResolvedValueOnce({});
		await getArtifact(artifactEvent());
		expect(vi.mocked(GetObjectCommand)).toHaveBeenCalledWith({
			Bucket: BUCKET,
			Key: `v8/artifacts/${HASH}`,
		});
	});

	it("returns 404 when artifact not found", async () => {
		mockSend.mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } });
		expect((await getArtifact(artifactEvent())).statusCode).toBe(404);
	});

	it("rethrows unexpected S3 errors", async () => {
		mockSend.mockRejectedValueOnce(new Error("s3 error"));
		await expect(getArtifact(artifactEvent())).rejects.toThrow("s3 error");
	});

	it("returns 400 when hash is missing", async () => {
		const res = await getArtifact(event({ pathParameters: {} }));
		expect(res.statusCode).toBe(400);
	});

	it("returns 401 for bad token", async () => {
		const res = await getArtifact(
			artifactEvent({ headers: { authorization: "Bearer bad" } }),
		);
		expect(res.statusCode).toBe(401);
	});

	describe("team params middleware", () => {
		it("does not add middleware when no team params", async () => {
			mockSend.mockResolvedValueOnce({});
			await getArtifact(artifactEvent());
			const cmd = vi.mocked(GetObjectCommand).mock.results[0].value;
			expect(cmd.middlewareStack.add).not.toHaveBeenCalled();
		});

		it("adds middleware with correct options when slug is present", async () => {
			mockSend.mockResolvedValueOnce({});
			await getArtifact(
				artifactEvent({ queryStringParameters: { slug: "my-team" } }),
			);
			const cmd = vi.mocked(GetObjectCommand).mock.results[0].value;
			expect(cmd.middlewareStack.add).toHaveBeenCalledWith(
				expect.any(Function),
				{ step: "build", priority: "high", name: "addTeamParams" },
			);
		});

		it("adds middleware with correct options when teamId is present", async () => {
			mockSend.mockResolvedValueOnce({});
			await getArtifact(
				artifactEvent({ queryStringParameters: { teamId: "team_abc" } }),
			);
			const cmd = vi.mocked(GetObjectCommand).mock.results[0].value;
			expect(cmd.middlewareStack.add).toHaveBeenCalledWith(
				expect.any(Function),
				{ step: "build", priority: "high", name: "addTeamParams" },
			);
		});

		it("middleware injects slug into request query", async () => {
			mockSend.mockResolvedValueOnce({});
			let capturedMiddleware: ((next: unknown) => (args: unknown) => unknown) | undefined;
			vi.mocked(GetObjectCommand).mockImplementationOnce(() => ({
				middlewareStack: {
					add: vi.fn((fn) => {
						capturedMiddleware = fn;
					}),
				},
			}));
			await getArtifact(
				artifactEvent({ queryStringParameters: { slug: "my-team" } }),
			);
			expect(capturedMiddleware).toBeDefined();
			const mockNext = vi.fn().mockResolvedValue({});
			const args = { request: { query: {} as Record<string, string> } };
			// biome-ignore lint/suspicious/noExplicitAny: testing internal middleware
			await (capturedMiddleware as any)(mockNext)(args);
			expect(args.request.query.slug).toBe("my-team");
			expect(mockNext).toHaveBeenCalledWith(args);
		});

		it("middleware injects teamId into request query", async () => {
			mockSend.mockResolvedValueOnce({});
			let capturedMiddleware: ((next: unknown) => (args: unknown) => unknown) | undefined;
			vi.mocked(GetObjectCommand).mockImplementationOnce(() => ({
				middlewareStack: {
					add: vi.fn((fn) => {
						capturedMiddleware = fn;
					}),
				},
			}));
			await getArtifact(
				artifactEvent({ queryStringParameters: { teamId: "team_abc" } }),
			);
			// biome-ignore lint/suspicious/noExplicitAny: testing internal middleware
			await (capturedMiddleware as any)(vi.fn().mockResolvedValue({}))(
				{ request: { query: {} as Record<string, string> } },
			);
			// can't check after passing by value — re-run to observe mutation
			const args = { request: { query: {} as Record<string, string> } };
			// biome-ignore lint/suspicious/noExplicitAny: testing internal middleware
			await (capturedMiddleware as any)(vi.fn().mockResolvedValue({}))(args);
			expect(args.request.query.teamId).toBe("team_abc");
		});
	});
});

describe("preflightArtifact", () => {
	it("returns presigned PUT URL for PUT preflight", async () => {
		const res = await preflightArtifact(
			artifactEvent({
				headers: {
					authorization: `Bearer ${TOKEN}`,
					"access-control-request-method": "PUT",
				},
			}),
		);
		expect(res.statusCode).toBe(200);
		const headers = (res as { headers: Record<string, string> }).headers;
		expect(headers.Location).toBe(PRESIGNED_URL);
		expect(headers["Access-Control-Allow-Methods"]).toBe("PUT");
		expect(headers["Access-Control-Allow-Headers"]).not.toContain("Authorization");
	});

	it("returns no Location for GET preflight", async () => {
		const res = await preflightArtifact(
			artifactEvent({
				headers: {
					authorization: `Bearer ${TOKEN}`,
					"access-control-request-method": "GET",
				},
			}),
		);
		expect(res.statusCode).toBe(200);
		const headers = (res as { headers: Record<string, string> }).headers;
		expect(headers.Location).toBeUndefined();
		expect(headers["Access-Control-Allow-Methods"]).toBe("GET, HEAD");
	});

	it("returns no Location for HEAD preflight", async () => {
		const res = await preflightArtifact(
			artifactEvent({
				headers: {
					authorization: `Bearer ${TOKEN}`,
					"access-control-request-method": "HEAD",
				},
			}),
		);
		expect(res.statusCode).toBe(200);
		expect((res as { headers: Record<string, string> }).headers.Location).toBeUndefined();
	});

	it("returns 400 when hash is missing", async () => {
		const res = await preflightArtifact(
			event({
				headers: {
					authorization: `Bearer ${TOKEN}`,
					"access-control-request-method": "PUT",
				},
				pathParameters: {},
			}),
		);
		expect(res.statusCode).toBe(400);
	});

	it("returns 401 for bad token", async () => {
		const res = await preflightArtifact(
			artifactEvent({
				headers: {
					authorization: "Bearer bad",
					"access-control-request-method": "PUT",
				},
			}),
		);
		expect(res.statusCode).toBe(401);
	});
});
