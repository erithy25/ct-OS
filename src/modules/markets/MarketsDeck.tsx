import { useSim } from '../../sim/store'

/** Placeholder — replaced by the full MARKET OPS board. */
export default function MarketsDeck() {
  const instruments = useSim((s) => s.instruments)
  const marketSource = useSim((s) => s.marketSource)
  return (
    <div className="h-full overflow-auto p-3">
      <div className="lbl mb-2 text-dim">
        MARKET OPS · <span className={marketSource === 'live' ? 'text-green' : 'text-amber'}>{marketSource.toUpperCase()}</span>
      </div>
      <table className="num w-full text-[12px]">
        <tbody>
          {instruments.map((i) => (
            <tr key={i.symbol} className="border-b border-line/50">
              <td className="py-1 pr-4 text-prim">{i.symbol}</td>
              <td className="py-1 pr-4 text-right text-prim/90">{i.price}</td>
              <td className="py-1 text-right" style={{ color: i.changePct >= 0 ? 'var(--accent-green)' : 'var(--accent-red)' }}>
                {i.changePct >= 0 ? '+' : ''}
                {i.changePct.toFixed(2)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
