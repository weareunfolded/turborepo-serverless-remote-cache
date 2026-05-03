/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
	app(input) {
		return {
			name: 'turborepo-serverless-remote-cache',
			removal: input?.stage === 'production' ? 'retain' : 'remove',
			home: 'aws',
			providers: { aws: { region: (process.env.AWS_REGION ?? 'eu-west-1') as string } },
		};
	},
	async run() {
		const bucket = new sst.aws.Bucket('S3TurboCache', {
			public: false,
		});

		const token = new sst.Secret('TurboCacheToken');

		// Optional custom domain. Set TURBO_DOMAIN at deploy time:
		//   TURBO_DOMAIN=turbo.mycompany.com pnpm exec sst deploy --stage production
		// Or edit this value directly. Leave undefined to use the API Gateway URL.
		const domain = process.env.TURBO_DOMAIN;

		const api = new sst.aws.ApiGatewayV2('TurboCacheApi', { domain });

		api.route('GET /v8/artifacts/status', {
			handler: 'src/index.getStatus',
			link: [token],
			runtime: 'nodejs24.x',
		});

		api.route('POST /v8/artifacts/events', {
			handler: 'src/index.postEvents',
			link: [token],
			runtime: 'nodejs24.x',
		});

		api.route('HEAD /v8/artifacts/{hash}', {
			handler: 'src/index.headArtifact',
			link: [bucket, token],
			runtime: 'nodejs24.x',
		});

		api.route('GET /v8/artifacts/{hash}', {
			handler: 'src/index.getArtifact',
			link: [bucket, token],
			memory: '512 MB',
			timeout: '30 seconds',
			runtime: 'nodejs24.x',
		});

		api.route('OPTIONS /v8/artifacts/{hash}', {
			handler: 'src/index.preflightArtifact',
			link: [bucket, token],
			runtime: 'nodejs24.x',
		});

		return {
			api: domain ? `https://${domain}` : api.url,
		};
	},
});
