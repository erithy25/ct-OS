/** Fixed full-screen CRT treatment: scanlines, slow sweep, vignette. */
export default function Scanlines() {
  return (
    <div className="pointer-events-none fixed inset-0 z-[90]" aria-hidden>
      <div className="scanlines-layer absolute inset-0" />
      <div className="crt-sweep absolute inset-x-0 top-0" />
      <div className="crt-vignette absolute inset-0" />
    </div>
  )
}
