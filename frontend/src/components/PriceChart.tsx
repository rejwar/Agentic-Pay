import React, { useState } from "react"
import {
  Area,
  AreaChart,
  CartesianGrid,
  XAxis,
  YAxis,
} from "recharts"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { usePythProxy } from "@/hooks/usePythProxy"
import { PYTH_FEED_SYMBOLS, PythSymbol } from "@/lib/constants"
import { Activity, TrendingUp, Zap } from "lucide-react"

const chartConfig = {
  price: {
    label: "Pyth Oracle Price",
    color: "var(--chart-1)",
  },
} satisfies ChartConfig

export function PriceChart() {
  const [selectedSymbol, setSelectedSymbol] = useState<PythSymbol>("SOL")
  const { price, history, loading } = usePythProxy(selectedSymbol)

  // Determine chart bounds to display crisp micro-fluctuations
  const prices = history.map((d) => d.price)
  const minPrice = prices.length ? Math.floor(Math.min(...prices) * 0.998) : 140
  const maxPrice = prices.length ? Math.ceil(Math.max(...prices) * 1.002) : 155

  return (
    <Card className="border-border">
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <Activity className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              Pyth Hermes Price Oracle
            </CardTitle>
            <Badge variant="outline" className="text-[10px] text-muted-foreground font-mono">
              x402 Micropay Gated
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            Sub-second deterministic price feeds with confidence bands
          </p>
        </div>

        {/* Asset Selector Tabs */}
        <Tabs
          value={selectedSymbol}
          onValueChange={(val) => setSelectedSymbol(val as PythSymbol)}
        >
          <TabsList className="h-8">
            {PYTH_FEED_SYMBOLS.map((sym) => (
              <TabsTrigger key={sym} value={sym} className="text-xs px-2.5 py-1">
                {sym}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </CardHeader>

      <CardContent>
        {/* Live Ticker Bar */}
        <div className="flex items-baseline justify-between mb-4 pb-3 border-b border-border">
          <div className="flex items-baseline gap-3">
            <span className="text-3xl font-extrabold font-mono text-foreground tracking-tight">
              {price ? `$${price.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "OFFLINE"}
            </span>
            {price ? (
              <span className="text-xs text-emerald-600 dark:text-emerald-400 font-mono flex items-center gap-1 font-semibold">
                <TrendingUp className="h-3 w-3" />
                ±${price.confidence.toFixed(3)} ({price.confidenceBps} bps)
              </span>
            ) : (
              <span className="text-xs text-muted-foreground font-mono">
                Awaiting oracle feed
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono">
            <Zap className="h-3.5 w-3.5 text-amber-500 dark:text-amber-400" />
            <span>Feed: <strong className="text-foreground">{price ? "Hermes L2" : "Offline"}</strong></span>
            <span className={`h-1.5 w-1.5 rounded-full ${price ? "bg-emerald-500 animate-pulse" : "bg-muted-foreground"}`} />
          </div>
        </div>

        {/* Recharts Area Chart */}
        <div className="h-[280px] w-full">
          {history.length === 0 || loading ? (
            <div className="h-full flex items-center justify-center text-xs text-muted-foreground font-mono">
              Synchronizing Pyth oracle ticks...
            </div>
          ) : (
            <ChartContainer config={chartConfig} className="h-full w-full">
              <AreaChart data={history} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="priceGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--chart-1)" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="var(--chart-1)" stopOpacity={0.0} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} strokeDasharray="3 3" className="stroke-border" />
                <XAxis
                  dataKey="time"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  minTickGap={30}
                  tick={{ fill: "#64748b", fontSize: 11, fontFamily: "monospace" }}
                />
                <YAxis
                  domain={[minPrice, maxPrice]}
                  tickLine={false}
                  axisLine={false}
                  tick={{ fill: "#64748b", fontSize: 11, fontFamily: "monospace" }}
                  tickFormatter={(val) => `$${val}`}
                />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Area
                  type="monotone"
                  dataKey="price"
                  stroke="var(--chart-1)"
                  strokeWidth={2.5}
                  fill="url(#priceGradient)"
                  isAnimationActive={false}
                />
              </AreaChart>
            </ChartContainer>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
