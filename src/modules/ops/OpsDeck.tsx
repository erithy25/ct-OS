import { getHistories, useSim } from '../../sim/store'
import StripChart from './charts/StripChart'
import ThreatBoard from './ThreatBoard'
import PredictivePanel from './PredictivePanel'
import EventLogTable from './EventLogTable'

/* stable getters / formatters (module scope keeps StripChart effect deps quiet) */
const dIncidentRate = () => getHistories().incidentRate
const dActiveUnits = () => getHistories().activeUnits
const dSensorUptime = () => getHistories().sensorUptime
const dRiskIndex = () => getHistories().riskIndex
const dDetections = () => getHistories().detectionsPerMin
const dNetLoad = () => getHistories().netLoad

const fmtInt = (v: number): string => Math.round(v).toString()
const fmt1 = (v: number): string => v.toFixed(1)
const fmtPct0 = (v: number): string => `${v.toFixed(0)}%`
const fmtPct1 = (v: number): string => `${v.toFixed(1)}%`

/* concrete accent hexes for canvas (mirror src/theme/tokens.css) */
const RED = '#FF3B47'
const GREEN = '#34D399'
const AMBER = '#F5A623'
const CYAN = '#22D3EE'

/**
 * OPS DECK — Bloomberg-dense analytics over the live simulation.
 * Row 1: six small-multiple strip charts · Row 2: threat board + predictive
 * layer · Row 3: virtualized event log. No page scroll at 1440×900.
 */
export default function OpsDeck() {
  const vitalsVersion = useSim((s) => s.vitalsVersion)

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 overflow-hidden p-1.5">
      {/* row 1 — small multiples */}
      <div className="grid shrink-0 grid-cols-6 gap-1.5">
        <StripChart className="h-[110px]" title="INCIDENT RATE" data={dIncidentRate} version={vitalsVersion} color={RED} format={fmtInt} />
        <StripChart className="h-[110px]" title="ACTIVE UNITS" data={dActiveUnits} version={vitalsVersion} color={GREEN} format={fmtInt} />
        <StripChart
          className="h-[110px]"
          title="SENSOR UPTIME %"
          data={dSensorUptime}
          version={vitalsVersion}
          color={GREEN}
          min={90}
          max={100}
          format={fmtPct1}
        />
        <StripChart className="h-[110px]" title="CITY RISK INDEX" data={dRiskIndex} version={vitalsVersion} color={AMBER} format={fmt1} />
        <StripChart className="h-[110px]" title="DETECTIONS/MIN" data={dDetections} version={vitalsVersion} color={CYAN} format={fmtInt} />
        <StripChart className="h-[110px]" title="NETWORK LOAD" data={dNetLoad} version={vitalsVersion} color={CYAN} format={fmtPct0} />
      </div>

      {/* row 2 — threat board (≈55%) + predictive layer (≈45%) */}
      <div className="grid h-[304px] shrink-0 grid-cols-[minmax(0,11fr)_minmax(0,9fr)] gap-1.5">
        <ThreatBoard />
        <PredictivePanel />
      </div>

      {/* row 3 — event log */}
      <EventLogTable className="min-h-0 flex-1" />
    </div>
  )
}
