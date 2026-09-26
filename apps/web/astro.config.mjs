// @ts-check
import { defineConfig, passthroughImageService } from 'astro/config';
import tailwind from "@astrojs/tailwind";
import starlight from '@astrojs/starlight';

// Static site built to public/ by Astro (see scripts/copy-docs.mjs).
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
						{ label: 'End-to-end setup', slug: 'docs/onboarding' },
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
						{ label: 'Devin CLI', slug: 'docs/agents/devin' },
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
						{ label: 'Automations & Cron', slug: 'docs/automations' },
						{ label: 'Use from Claude Code', slug: 'docs/mcp' },
					],
				},
				{
					label: 'Operate',
					items: [
						{ label: 'Tasks & Runs Dashboard', slug: 'docs/dashboard' },
						{ label: 'Configuration & Secrets', slug: 'docs/configuration' },
						{ label: 'Local development', slug: 'docs/local-development' },
						{ label: 'Deployment', slug: 'docs/deployment' },
					{ label: 'Readiness checklist', slug: 'docs/readiness' },
					{ label: 'Waitlist operations', slug: 'docs/waitlist' },
						{ label: 'Troubleshooting', slug: 'docs/troubleshooting' },
					],
				},
				{
					label: 'Reference',
					items: [
						{ label: 'API reference', slug: 'docs/api' },
						{ label: 'Contributing', slug: 'docs/contributing' },
					],
				},
			],
		}),
	],
});
