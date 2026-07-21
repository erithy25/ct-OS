import CornerBrackets from '../../components/CornerBrackets'

/** Placeholder for a HOMEWATCH module still being built this session. */
export default function ComingSoon({ title, note }: { title: string; note: string }) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="relative w-[440px] max-w-[82%] px-10 py-12 text-center">
        <CornerBrackets size={12} />
        <div className="font-grotesk text-[22px] font-medium tracking-[0.3em] text-faint">{title}</div>
        <div className="relative mx-auto mt-5 h-px w-48 overflow-hidden bg-line">
          <div className="absolute inset-y-0 w-16 bg-accent/70" style={{ animation: 'crt-sweep 2.4s linear infinite', transform: 'rotate(90deg)' }} />
        </div>
        <div className="lbl-faint mt-5 leading-5">{note}</div>
      </div>
    </div>
  )
}
