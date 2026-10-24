// @ts-check
import { defineConfig, passthroughImageService } from 'astro/config';
import tailwind from "@astrojs/tailwind";
import starlight from '@astrojs/starlight';

// Static site built to dist/ then merged into public/ (see scripts/assemble-public.mjs).
// Static output is Astro's default; no adapter, no SSR.
export default defineConfig({
	site: 'https://tryshiba.dev',
	srcDir: './src',
	outDir: 'dist',
	output: 'static',
	// sharp's native dep is unavailable in CI; marketing images ship as authored.
	image: { service: passthroughImageService() },
	redirects: {
		'/docs': '/docs/overview/',
	},
	integrations: [
		tailwind({ applyBaseStyles: false }),
		starlight({
			title: 'Shiba',
			description:
				'Open-source, self-hosted AI software engineer for approval-gated tasks in Cloudflare Sandbox.',
			components: {
				Head: './src/components/starlight/Head.astro',
			},
			head: [
				{
					tag: 'link',
					attrs: { rel: 'sitemap', href: '/sitemap.xml' },
				},
				{
					tag: 'meta',
					attrs: { name: 'robots', content: 'index, follow, max-image-preview:large' },
				},
			],
			logo: {
				src: './src/assets/logo.png',
				alt: 'AI Coworker Logo',
			},
			favicon: '/favicon.ico',
			customCss: ['./src/styles/theme.css'],
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/princepal9120/shiba' },
			],
			editLink: {
				baseUrl: 'https://github.com/princepal9120/shiba/edit/main/apps/web/',
			},
			sidebar: [
				{
					label: 'Start here',
					items: [
						{ label: 'Overview', slug: 'docs/overview' },
						{ label: 'Quickstart', slug: 'docs/getting-started' },
						{ label: 'Self-host on Cloudflare', slug: 'docs/self-hosting' },
						{ label: 'vs hosted alternatives', slug: 'docs/hosted-alternatives' },
						{ label: 'End-to-end setup', slug: 'docs/onboarding' },
						{ label: 'Launch (one-command deploy)', slug: 'docs/launch' },
					],
				},
				{
					label: 'Understand',
					items: [
						{ label: 'Architecture', slug: 'docs/architecture' },
						{ label: 'Approval Gates', slug: 'docs/approval-gates' },
						{ label: 'Security & credential boundaries', slug: 'docs/security' },
						{ label: 'Models & costs', slug: 'docs/costs' },
					],
				},
				{
					label: 'Coding Agents',
					items: [
						{ label: 'Overview & Harnesses', slug: 'docs/claude-code' },
						{ label: 'Claude Code', slug: 'docs/agents/claude-code' },
						{ label: 'Codex', slug: 'docs/agents/codex' },
						{ label: 'OpenCode', slug: 'docs/agents/opencode' },
					],
				},
				{
					label: 'Connect',
					items: [
						{ label: 'Slack Integration', slug: 'docs/slack' },
						{ label: 'Telegram Integration', slug: 'docs/telegram' },
						{ label: 'Discord Interactions', slug: 'docs/discord' },
						{ label: 'HTTP Triggers (iPhone)', slug: 'docs/triggers' },
						{ label: 'GitHub Pull Requests', slug: 'docs/github' },
						{ label: 'Pull request review', slug: 'docs/review' },
						{ label: 'Sandbox SDK 1.0', slug: 'docs/sandbox-sdk-1' },
						{ label: 'Sandbox providers', slug: 'docs/sandbox-providers' },
						{ label: 'Sandbox cost guide', slug: 'docs/sandbox-cheapest-provider' },
						{ label: 'Custom sandbox provider', slug: 'docs/sandbox-custom-provider' },
						{ label: 'Automations & Cron', slug: 'docs/automations' },
						{ label: 'Linear agent sessions', slug: 'docs/linear-agent-session' },
						{ label: 'Use from Claude Code', slug: 'docs/mcp' },
					],
				},
				{
					label: 'Operate',
					items: [
						{ label: 'Tasks & Runs Dashboard', slug: 'docs/dashboard' },
						{ label: 'Swarm desk', slug: 'docs/swarm-desk' },
						{ label: 'Configuration & Secrets', slug: 'docs/configuration' },
						{ label: 'Local development', slug: 'docs/local-development' },
						{ label: 'Deployment', slug: 'docs/deployment' },
						{ label: 'Readiness checklist', slug: 'docs/readiness' },
						{ label: 'Product status', slug: 'docs/product-status' },
					{ label: 'Waitlist operations', slug: 'docs/waitlist' },
						{ label: 'Troubleshooting', slug: 'docs/troubleshooting' },
					],
				},
				{
					label: 'Reference',
					items: [
						{ label: 'API reference', slug: 'docs/api' },
						{ label: 'TypeScript SDK', slug: 'docs/sdk' },
						{ label: 'Contributing', slug: 'docs/contributing' },
					],
				},
			],
		}),
	],
});
