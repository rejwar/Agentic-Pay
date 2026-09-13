import React from "react"
import { StatCard } from "@/components/StatCard"
import { PriceChart } from "@/components/PriceChart"
import { AgentStatus } from "@/components/AgentStatus"
import { DecisionPanel } from "@/components/DecisionPanel"
import { PaymentLog } from "@/components/PaymentLog"
import { LiveFeed } from "@/components/LiveFeed"
import { useAgentRpc } from "@/hooks/useAgentRpc"
import { usePythProxy } from "@/hooks/usePythProxy"
import { Wallet, Receipt, Activity, BrainCircuit } from "lucide-react"

export default function Dashboard() {
  const { data, loading, error, setPaused, simulatePayment } = useAgentRpc()
  const { price: solPrice } = usePythProxy("SOL")

  if (loading && !data) {
    return (
      <div className="h-[60vh] flex flex-col items-center justify-center space-y-3 font-mono text-sm">
        <div className="h-8 w-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
        <span className="text-muted-foreground">Connecting to AgenticPay Core Daemon...</span>
      </div>
    )
  }

  if (error && !data) {
    return (
      <div className="h-[60vh] flex flex-col items-center justify-center space-y-3 font-mono text-sm text-destructive">
        <div className="p-4 rounded-xl bg-destructive/10 border border-destructive/20 text-center space-y-2">
          <p className="font-semibold">Failed to establish RPC connection</p>
          <p className="text-xs text-muted-foreground">{error}</p>
        </div>
      </div>
    )
  }

  const totalBalance = data?.balances.reduce(
    (sum, item) => sum + item.usdValue,
    0
  ) ?? 0

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          Autonomous Mission Control
        </h1>
        <p className="text-xs text-muted-foreground font-mono mt-1">
          Real-time telemetry for x402 data micropayments & Anchor on-chain guardrails
        </p>
      </div>

      {/* The 4 Core Panels (Stat Cards) */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title="Treasury Balance"
          value={`$${totalBalance.toFixed(2)}`}
          subtitle="Includes Escrow Reserve & SOL"
          icon={<Wallet className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />}
          trend={{ value: "+2.4%", isPositive: true }}
          badge="Solana"
        />
        <StatCard
          title="Signed Vouchers"
          value={data?.vouchers.length ?? 0}
          subtitle="Off-chain signed Ed25519 vouchers"
          icon={<Receipt className="h-3.5 w-3.5 text-amber-500 dark:text-amber-400" />}
          badge="105-Byte"
        />
        <StatCard
          title="Pyth SOL Oracle"
          value={solPrice ? `$${solPrice.price.toFixed(2)}` : "OFFLINE"}
          subtitle={solPrice ? `±$${solPrice.confidence.toFixed(3)} confidence` : "No oracle feed"}
          icon={<Activity className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />}
          badge={solPrice ? "Hermes L2" : "Offline"}
        />
        <StatCard
          title="Engine Decisions"
          value={data?.decisions.length ?? 0}
          subtitle="Fixed-point EV evaluations"
          icon={<BrainCircuit className="h-3.5 w-3.5 text-purple-600 dark:text-purple-400" />}
          badge="Edge > Fee"
        />
      </div>

      {/* Row 2: Price Chart & Agent Core Status */}
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <PriceChart />
        </div>
        {data && (
          <AgentStatus agent={data.agent} onTogglePause={setPaused} />
        )}
      </div>

      {/* Row 3: Decision Engine & x402 Voucher Log */}
      <div className="grid gap-6 xl:grid-cols-2">
        <DecisionPanel decisions={data?.decisions ?? []} />
        <PaymentLog
          vouchers={data?.vouchers ?? []}
          onSimulateVoucher={simulatePayment}
        />
      </div>

      {/* Row 4: Live Event Streaming Feed */}
      <LiveFeed events={data?.events ?? []} />
    </div>
  )
}
