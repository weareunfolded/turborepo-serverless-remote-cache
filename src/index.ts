import { timingSafeEqual } from "node:crypto";
import {
	GetObjectCommand,
	HeadObjectCommand,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type {
	APIGatewayProxyEventV2,
	APIGatewayProxyResultV2,
} from "aws-lambda";
import { Resource } from "sst";

const s3 = new S3Client({
	// Prevent the SDK from adding x-amz-sdk-checksum-algorithm to presigned
	// URLs. The SDK includes it in X-Amz-SignedHeaders, but reqwest drops it
	// when following the cross-host 307 redirect to S3, which causes
	// SignatureDoesNotMatch.
	requestChecksumCalculation: "WHEN_REQUIRED",
	responseChecksumValidation: "WHEN_REQUIRED",
});
const PRESIGN_EXPIRES = 3600;

function artifactKey(hash: string) {
	return `v8/artifacts/${hash}`;
}

function verifyAuth(event: APIGatewayProxyEventV2): boolean {
	const auth = event.headers.authorization ?? "";
	const expected = `Bearer ${Resource.TurboCacheToken.value}`;
	const a = Buffer.from(auth);
	const b = Buffer.from(expected);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

function unauthorized(): APIGatewayProxyResultV2 {
	return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
}

function s3HttpStatus(err: unknown): number | undefined {
	return (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
		?.httpStatusCode;
}

export async function getStatus(
	event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
	if (!verifyAuth(event)) return unauthorized();
	return {
		statusCode: 200,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ status: "enabled" }),
	};
}

export async function postEvents(
	event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
	if (!verifyAuth(event)) return unauthorized();
	return { statusCode: 200, body: "" };
}

export async function headArtifact(
	event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
	if (!verifyAuth(event)) return unauthorized();
	const hash = event.pathParameters?.hash;
	if (!hash) return { statusCode: 400, body: "" };

	try {
		await s3.send(
			new HeadObjectCommand({
				Bucket: Resource.S3TurboCache.name,
				Key: artifactKey(hash),
			}),
		);
		return { statusCode: 200, body: "" };
	} catch (err) {
		if (s3HttpStatus(err) === 404) return { statusCode: 404, body: "" };
		throw err;
	}
}

export async function getArtifact(
	event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
	if (!verifyAuth(event)) return unauthorized();
	const hash = event.pathParameters?.hash;
	if (!hash) return { statusCode: 400, body: "missing hash" };

	try {
		await s3.send(
			new HeadObjectCommand({
				Bucket: Resource.S3TurboCache.name,
				Key: artifactKey(hash),
			}),
		);
	} catch (err) {
		if (s3HttpStatus(err) === 404)
			return { statusCode: 404, body: "not found" };
		throw err;
	}

	const qs = event.queryStringParameters ?? {};
	const teamParams: Record<string, string> = {};
	if (qs.slug) teamParams.slug = qs.slug;
	if (qs.teamId) teamParams.teamId = qs.teamId;

	const cmd = new GetObjectCommand({
		Bucket: Resource.S3TurboCache.name,
		Key: artifactKey(hash),
	});

	// Turbo appends slug/teamId to the presigned URL before sending to S3.
	// Include them at signing time so the signature covers them.
	if (Object.keys(teamParams).length > 0) {
		cmd.middlewareStack.add(
			// biome-ignore lint/suspicious/noExplicitAny: AWS SDK middleware args lack public types
			(next: any) => async (args: any) => {
				if (!args.request.query) args.request.query = {};
				Object.assign(args.request.query, teamParams);
				return next(args);
			},
			{ step: "build", priority: "high", name: "addTeamParams" },
		);
	}

	const url = await getSignedUrl(s3, cmd, { expiresIn: PRESIGN_EXPIRES });

	return { statusCode: 307, headers: { Location: url }, body: "" };
}

// Turbo sends OPTIONS before every GET and PUT when TURBO_PREFLIGHT=1.
//
// For PUT: we return a presigned S3 PUT URL in Location so Turbo uploads directly to S3,
// bypassing API Gateway entirely. Authorization is omitted from Allow-Headers so the Bearer
// token is not forwarded — the presigned URL carries its own auth.
//
// For GET/HEAD: we return no Location. Turbo's preflight code falls back to the original
// request URL when Location is absent, so GET/HEAD land on our existing Lambda handlers
// (getArtifact / headArtifact) which handle auth and issue their own presigned GET redirect.
export async function preflightArtifact(
	event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
	if (!verifyAuth(event)) return unauthorized();
	const hash = event.pathParameters?.hash;
	if (!hash) return { statusCode: 400, body: "" };

	const requestMethod = (
		event.headers["access-control-request-method"] ?? ""
	).toUpperCase();

	if (requestMethod === "PUT") {
		const url = await getSignedUrl(
			s3,
			new PutObjectCommand({
				Bucket: Resource.S3TurboCache.name,
				Key: artifactKey(hash),
				ContentType: "application/octet-stream",
				ChecksumAlgorithm: undefined,
			}),
			{ expiresIn: PRESIGN_EXPIRES },
		);
		return {
			statusCode: 200,
			headers: {
				Location: url,
				"Access-Control-Allow-Methods": "PUT",
				"Access-Control-Allow-Headers":
					"Content-Type, User-Agent, x-artifact-duration, x-artifact-tag, x-artifact-sha, x-artifact-dirty-hash",
			},
			body: "",
		};
	}

	return {
		statusCode: 200,
		headers: {
			"Access-Control-Allow-Methods": "GET, HEAD",
			"Access-Control-Allow-Headers": "Authorization, User-Agent",
		},
		body: "",
	};
}
