import { frameLoop, prefersReducedMotion, Spring } from "@opencode/ui/motion"
import { motionTuning } from "@opencode/ui/motion-tuning"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createSignal, onCleanup, onMount, Show } from "solid-js"

const choice = motionTuning.choice("sidebar.hover", {
  label: "Sidebar hover",
  group: "Experiments",
  value: "today",
  labels: { today: "Today", glide: "Glide" },
})

const tuning = motionTuning.spring("sidebar.hover.glide", {
  label: "Sidebar hover glide",
  group: "Experiments",
  presets: {
    snappy: { duration: 0.14, bounce: 0 },
    smooth: { duration: 0.2, bounce: 0 },
    calm: { duration: 0.28, bounce: 0 },
  },
})

const [mode, setMode] = createSignal(choice())

motionTuning.subscribe(() => setMode(choice()))

const rows = "[data-titlebar-tab], [data-titlebar-tab-action]"

// The pill's corner radius, matching the rows'.
const radius = 6

const grid = (value: number) => Math.round(value * 64) / 64

/**
 * Experiment: one hover pill glides behind the sidebar's rows, instead of each row lighting its own background. It
 * targets the row nearest the pointer, so crossing a gap between rows holds it rather than dropping it.
 */
export function SidebarHover() {
  return (
    <Show when={mode() === "glide"}>
      <Pill />
    </Show>
  )
}

function Pill() {
  let pill!: HTMLDivElement
  let top!: HTMLDivElement
  let fill!: HTMLDivElement
  let bottom!: HTMLDivElement
  let pointer: { x: number; y: number } | undefined
  // The hovered row's edges relative to the sidebar, from the last frame's read phase.
  let hit: { top: number; bottom: number } | undefined
  let frame: (() => void) | undefined

  const motion = {
    top: Spring.fromDuration(0, tuning()),
    bottom: Spring.fromDuration(0, tuning()),
    opacity: Spring.fromDuration(0, { duration: 0.15, bounce: 0 }),
  }

  onMount(() => {
    // SAFETY: the pill renders inside the sidebar's portal root.
    const root = pill.parentElement!
    root.dataset.sidebarHover = "glide"
    onCleanup(() => delete root.dataset.sidebarHover)

    const read = () => {
      hit = pointer && !root.querySelector('[data-dragging="true"]') ? nearest(root, pointer) : undefined
    }

    const write = (dt: number) => {
      const spring = tuning()
      const reduced = prefersReducedMotion()

      if (hit) {
        // Appearing from hidden starts on the row rather than sweeping in from where it left.
        if (motion.opacity.value === 0 || reduced) {
          motion.top.snap(hit.top)
          motion.bottom.snap(hit.bottom)
        }

        motion.top.set(hit.top)
        motion.bottom.set(hit.bottom)
      }

      motion.opacity.set(hit ? 1 : 0)

      ;[motion.top, motion.bottom].forEach((edge) => {
        edge.omega = (2 * Math.PI) / spring.duration
        edge.zeta = 1 - spring.bounce
      })

      const y0 = grid(motion.top.step(dt))
      const y1 = grid(motion.bottom.step(dt))
      top.style.transform = `translateY(${y0}px)`
      bottom.style.transform = `translateY(${y1 - radius * 2}px)`
      fill.style.transform = `translateY(${y0 + radius}px) scaleY(${Math.max(0, y1 - y0 - radius * 2)})`
      pill.style.opacity = String(motion.opacity.step(dt))

      if (Object.values(motion).some((item) => !item.resting)) return true
      frame = undefined

      return false
    }

    const wake = () => {
      frame ??= frameLoop.addMeasured(read, write)
    }

    makeEventListener(root, "pointermove", (event) => {
      if (event.pointerType === "touch") return
      pointer = { x: event.clientX, y: event.clientY }
      wake()
    })
    makeEventListener(root, "pointerleave", () => {
      pointer = undefined
      wake()
    })
    // Rows that scroll under a resting pointer move the pill with them.
    makeEventListener(root, "scroll", wake, { capture: true, passive: true })
    onCleanup(() => frame?.())
  })

  // Opaque slices, so the caps can overlap the middle without darkening it; the group fades as one.
  return (
    <div
      ref={pill}
      data-slot="sidebar-hover-pill"
      aria-hidden="true"
      class="pointer-events-none absolute inset-x-0 top-0 -z-10 opacity-0"
    >
      <div ref={top} class="absolute inset-x-0 top-0 h-3 rounded-[6px]" />
      <div ref={fill} class="absolute inset-x-0 top-0 h-px origin-top" />
      <div ref={bottom} class="absolute inset-x-0 top-0 h-3 rounded-[6px]" />
    </div>
  )
}

// The row nearest the pointer, clipped to the scrolling list, or none once the pointer leaves the rows' span.
function nearest(root: HTMLElement, pointer: { x: number; y: number }) {
  const box = root.getBoundingClientRect()
  const scroll = root.querySelector('[data-slot="vertical-tabs-scroll"]')
  const view = scroll?.getBoundingClientRect()

  const boxes = [...root.querySelectorAll(rows)].flatMap((element) => {
    const rect = element.getBoundingClientRect()
    const clip = view && scroll?.contains(element)
    const top = clip ? Math.max(rect.top, view.top) : rect.top
    const bottom = clip ? Math.min(rect.bottom, view.bottom) : rect.bottom

    return bottom - top > 0 ? [{ top, bottom, left: rect.left, right: rect.right }] : []
  })

  const first = boxes[0]

  const last = boxes.at(-1)

  if (!first || !last || pointer.y < first.top || pointer.y > last.bottom) return

  if (pointer.x < first.left || pointer.x > first.right) return

  const distance = (row: { top: number; bottom: number }) => Math.max(row.top - pointer.y, pointer.y - row.bottom, 0)
  // A tie in a gap goes to the lower row, as clicks do.
  const row = boxes.reduce((best, item) => (distance(item) <= distance(best) ? item : best))

  return { top: row.top - box.top, bottom: row.bottom - box.top }
}
