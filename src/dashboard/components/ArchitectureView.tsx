import { type JSX } from "react";

export function ArchitectureView(): JSX.Element {
  return (
    <div className="flex-1 flex flex-col h-full overflow-y-auto bg-[#0d1117] text-[#e6edf3] p-4 lg:p-8">
      <div className="max-w-5xl mx-auto w-full flex flex-col gap-6">
        <div className="border-b border-white/[0.08] pb-4">
          <h2 className="text-base font-semibold text-white flex items-center gap-2">
            <span>System Architecture & Isolation Boundary</span>
            <span className="text-xs font-mono px-2 py-0.5 rounded-full bg-teal-950/60 border border-teal-800/60 text-teal-400">Zero-Trust</span>
          </h2>
          <p className="text-xs text-[#8b98a9]">Deep dive into the Cloudflare Native runtime topology, durable object coordination, and egress firewalling.</p>
        </div>
        <div className="border border-white/[0.08] rounded-xl bg-[#07090e] shadow-sm p-6 flex flex-col gap-4">
          <h3 className="text-xs font-bold uppercase tracking-wider text-teal-400 font-mono">End-to-End System Topology</h3>
          <div className="flex flex-col gap-3 font-mono text-xs">
            <div className="flex flex-col md:flex-row items-stretch md:items-center gap-3">
              <div className="w-full md:w-56 bg-[#0d1117] border border-white/[0.08] p-3 rounded-lg shrink-0">
                <div className="text-teal-400 font-bold mb-0.5">1. Inbound Surfaces</div>
                <div className="text-[11px] text-[#8b98a9]">Web UI, Slack Bot, GitHub Webhook, Cron</div>
              </div>
              <div className="hidden md:flex text-teal-500 font-bold px-1">→</div>
              <div className="flex-1 bg-[#0d1117]/60 border border-white/[0.08]/80 p-3 rounded-lg text-[#8b98a9] text-[11px]">Validates Access token or HMAC webhook signatures.</div>
            </div>
            <div className="flex flex-col md:flex-row items-stretch md:items-center gap-3">
              <div className="w-full md:w-56 bg-[#0d1117] border border-white/[0.08] p-3 rounded-lg shrink-0">
                <div className="text-teal-400 font-bold mb-0.5">2. Worker Gateway</div>
                <div className="text-[11px] text-[#8b98a9]">Edge routing & proxyToSandbox</div>
              </div>
              <div className="hidden md:flex text-teal-500 font-bold px-1">→</div>
              <div className="flex-1 bg-[#0d1117]/60 border border-white/[0.08]/80 p-3 rounded-lg text-[#8b98a9] text-[11px]">Routes agent commands and proxies container preview ports.</div>
            </div>
            <div className="flex flex-col md:flex-row items-stretch md:items-center gap-3">
              <div className="w-full md:w-56 bg-[#0d1117] border border-white/[0.08] p-3 rounded-lg shrink-0">
                <div className="text-teal-400 font-bold mb-0.5">3. Coding Orchestrator</div>
                <div className="text-[11px] text-[#8b98a9]">Durable Object (@cf/think)</div>
              </div>
              <div className="hidden md:flex text-teal-500 font-bold px-1">→</div>
              <div className="flex-1 bg-[#0d1117]/60 border border-white/[0.08]/80 p-3 rounded-lg text-[#8b98a9] text-[11px]">Plans steps using Llama 3.1 8B and manages human approval gates.</div>
            </div>
            <div className="flex flex-col md:flex-row items-stretch md:items-center gap-3">
              <div className="w-full md:w-56 bg-[#0d1117] border border-teal-500/40 p-3 rounded-lg shrink-0">
                <div className="text-[#4cc38a] font-bold mb-0.5">4. Isolated Sandbox VM</div>
                <div className="text-[11px] text-[#8b98a9]">@cloudflare/sandbox Micro-VM</div>
              </div>
              <div className="hidden md:flex text-teal-500 font-bold px-1">→</div>
              <div className="flex-1 bg-[#0d1117]/60 border border-white/[0.08]/80 p-3 rounded-lg text-[#8b98a9] text-[11px]">Isolated micro-container running git, test suites, and edits.</div>
            </div>
            <div className="flex flex-col md:flex-row items-stretch md:items-center gap-3">
              <div className="w-full md:w-56 bg-[#0d1117] border border-white/[0.08] p-3 rounded-lg shrink-0">
                <div className="text-[#c9a227] font-bold mb-0.5">5. Outbound Egress Gate</div>
                <div className="text-[11px] text-[#8b98a9]">Zero-Trust Outbound Proxy</div>
              </div>
              <div className="hidden md:flex text-teal-500 font-bold px-1">→</div>
              <div className="flex-1 bg-[#0d1117]/60 border border-white/[0.08]/80 p-3 rounded-lg text-[#8b98a9] text-[11px]">Dummy credentials swapped with real keys safely on Worker wire.</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
