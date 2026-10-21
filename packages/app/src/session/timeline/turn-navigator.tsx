import type { SessionMessageAssistant, SessionMessageInfo, SessionMessageUser } from "@opencode/client/promise"
import { frameLoop, prefersReducedMotion, Spring } from "@opencode/ui/motion"
import { createEffect, createMemo, createSelector, For, onCleanup, Show, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { Schema } from "effect"
import { readPromptPresentation } from "@/composer/comment-note"
import { useLanguage } from "@/runtime/i18n/language"
import { Persistence } from "@/runtime/persistence/schema"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { useServerSDK } from "@/runtime/server/client"

const turnPageLimit = 200

// Previews clamp to a few lines; keep only enough text to fill them.
const previewLength = 400

// Keep index loading clear of session entry, tab switch rendering and the timeline's own history requests.
const railDelay = 1000

// The rail lists at most this many of the newest turns.
const indexLimit = 1000

// Messages read back from the next turn to find an unloaded turn's reply. One read also fills the replies of the
// older turns it reaches, so their previews are ready before the pointer gets there.
const replyScanLimit = 40

// Each tick keeps at least this many pixels; a rail with more turns than fit shows an even sample of them.
const tickMinPitch = 4

// Ticks within this many pixels of the pointer lengthen slightly towards it.
const waveRadius = 16

const tickWidths = { default: 8, active: 12, peak: 16 }

// The prompt's first line sits level with its tick: card padding, bubble padding, then half a 16px line.
const previewAnchor = 20

// The preview at its tallest, with every text clamped. Clamping to it keeps the card still while a reply loads.
const previewMaxHeight = 196

const HintSchema = Persistence.struct({ used: Schema.Boolean })

type TurnNavigatorProps = {
  sessionID: string
  /** Loaded messages that have timeline rows; excludes queued inbox items. */
  messages: Accessor<SessionMessageInfo[]>
  /** Whether the loaded messages reach the start of the session, making the index redundant. */
  complete: Accessor<boolean>
  /** Whether the timeline is loading its own history; the index waits until it has been idle for a while. */
  historyLoading: Accessor<boolean>
  assistantMessagesByParent: Accessor<Map<string, SessionMessageAssistant[]>>
  revertMessageID: Accessor<string | undefined>
  visibleUserMessageIDs: Accessor<ReadonlySet<string>>
  onSelect: (id: string) => void
}

/**
 * A mouse rail beside the timeline. Older turns come from the user-message index; hovering one loads only its
 * latest reply. Keyboard users already have the previous and next message commands.
 *
 * Loading is deferred, then the rail appears with every turn so it never grows under the pointer.
 */
export function TurnNavigator(props: TurnNavigatorProps) {
  const sdk = useServerSDK()
  const [state, setState] = createStore<{ engaged: boolean; index?: Map<string, string> }>({ engaged: false })
  let root: HTMLDivElement | undefined

  const abort = new AbortController()
  onCleanup(() => abort.abort())

  // Newest first, so a capped index still meets the loaded tail.
  const loadIndex = async (cursor?: string, count = 0): Promise<[string, string][]> => {
    const page = await sdk.api.message.list(
      { sessionID: props.sessionID, type: "user", limit: turnPageLimit, cursor },
      { signal: abort.signal },
    )

    const turns = page.data.flatMap((message): [string, string][] =>
      message.type === "user" ? [[message.id, promptPreview(message)]] : [],
    )

    if (page.data.length < turnPageLimit || !page.cursor.next || count + turns.length >= indexLimit) return turns

    return [...turns, ...(await loadIndex(page.cursor.next, count + turns.length))]
  }

  createEffect(() => {
    if (state.engaged || props.historyLoading()) return

    const timer = setTimeout(() => {
      // Touch-only devices never load the rail.
      if (!matchMedia("(hover: hover) and (pointer: fine)").matches) return
      setState("engaged", true)

      if (props.complete()) return
      // Plain state rather than a resource: a pending resource would suspend the timeline it decorates.
      // On failure the rail lists the loaded turns.
      void loadIndex()
        .catch(() => [])
        .then((turns) => setState("index", new Map(turns.toReversed())))
    }, railDelay)

    onCleanup(() => clearTimeout(timer))
  })

  return (
    <div
      ref={root}
      data-component="session-turn-navigator"
      aria-hidden="true"
      class="absolute start-0 top-[calc(var(--session-timeline-header-height,48px)+8px)] bottom-[calc(var(--session-timeline-inset,0px)+80px)] z-[50] flex w-8 flex-col justify-center pointer-events-none"
    >
      <Show when={state.engaged && (props.complete() || state.index)}>
        <TurnRail {...props} index={state.index} root={root!} />
      </Show>
    </div>
  )
}

function TurnRail(props: TurnNavigatorProps & { index?: Map<string, string>; root: HTMLDivElement }) {
  const sdk = useServerSDK()
  const language = useLanguage()
  // The preview explains a click until the rail has been used once.
  const [hint, setHint, , hintReady] = persisted(Persist.global("turn-navigator"), HintSchema, { used: false })

  const [state, setState] = createStore<{
    hover?: string
    // The previewed turn, kept while the preview fades out.
    shown?: string
    // Fetched replies by user message ID; null while loading or when there is no reply text.
    replies: Record<string, string | null>
    height: number
  }>({ replies: {}, height: props.root.clientHeight })

  const observer = new ResizeObserver((entries) => setState("height", entries[0]!.contentRect.height))
  observer.observe(props.root)
  onCleanup(() => observer.disconnect())

  const loaded = createMemo(
    () =>
      new Map(props.messages().flatMap((message) => (message.type === "user" ? [[message.id, message] as const] : []))),
  )

  const same = (previous: string[], next: string[]) =>
    previous.length === next.length && previous.every((id, index) => id === next[index])

  // Timeline order, as the server lists it. IDs from other clients do not sort chronologically, so neither the order
  // nor the reverted boundary may compare them. Streaming replaces the loaded messages on every delta, so the list keeps
  // its identity until the turns themselves change.
  const turns = createMemo(
    () => {
      const tail = [...loaded().keys()]
      // Turns paged in from beyond a capped index are older than all of it.
      const join = tail.findIndex((id) => props.index?.has(id))
      const ids = [...new Set([...tail.slice(0, Math.max(0, join)), ...(props.index?.keys() ?? []), ...tail])]
      const revert = props.revertMessageID()
      const reverted = revert ? ids.indexOf(revert) : -1

      return reverted === -1 ? ids : ids.slice(0, reverted)
    },
    [],
    { equals: same },
  )

  // The turns that get a tick: all of them, or an even sample that keeps the first and latest turns.
  const marks = createMemo(
    () => {
      const ids = turns()
      // The rail's vertical padding takes 48px of the column.
      const count = Math.min(ids.length, Math.max(2, Math.floor((state.height - 48) / tickMinPitch)))

      if (count >= ids.length) return ids

      return Array.from({ length: count }, (_, index) => ids[Math.round((index * (ids.length - 1)) / (count - 1))]!)
    },
    [],
    { equals: same },
  )

  // A visible turn without a tick of its own marks the nearest one.
  const activeMarks = createMemo(() => {
    const ids = turns()
    const ticks = marks()
    const visible = props.visibleUserMessageIDs()

    if (ticks.length === ids.length) return visible
    const scale = (ticks.length - 1) / Math.max(1, ids.length - 1)

    return new Set(ids.flatMap((id, index) => (visible.has(id) ? [ticks[Math.round(index * scale)]!] : [])))
  })

  const abort = new AbortController()
  onCleanup(() => abort.abort())

  // A turn's latest reply is the newest assistant text between its prompt and the next turn. The read reaches back
  // through older turns too, and every turn it covers whole gets its reply.
  const loadReply = async (id: string) => {
    setState("replies", id, null)
    const list = turns()

    const page = await sdk.api.message.list(
      {
        sessionID: props.sessionID,
        limit: replyScanLimit,
        before: list[list.indexOf(id) + 1] ?? props.revertMessageID(),
      },
      { signal: abort.signal },
    )

    const starts = page.data.flatMap((message, index) => (message.type === "user" ? [index] : []))

    // A reply longer than the read has no prompt in it; all of it belongs to this turn.
    const spans = starts.length
      ? starts.map((start) => ({ id: page.data[start]!.id, end: start }))
      : [{ id, end: page.data.length }]

    if (spans[0]!.id !== id) return

    spans.forEach((span, turn) => {
      if (span.id !== id && state.replies[span.id] !== undefined) return

      const replies = page.data
        .slice(turn === 0 ? 0 : spans[turn - 1]!.end + 1, span.end)
        .filter((message): message is SessionMessageAssistant => message.type === "assistant")

      setState("replies", span.id, replyText(replies.toReversed()) ?? null)
    })
  }

  createEffect(() => {
    const id = state.hover

    if (!id || loaded().has(id) || state.replies[id] !== undefined) return
    void loadReply(id).catch(() => undefined)
  })

  const active = createSelector(activeMarks, (id: string, visible) => visible.has(id))
  const hovered = createSelector(() => state.hover)

  // A closed preview keeps its last content for the fade-out without following a streaming reply.
  const preview = createMemo((previous?: { prompt?: string; response?: string }) => {
    const id = state.shown

    if (!id || !state.hover) return previous
    const message = loaded().get(id)

    return {
      prompt: message ? promptPreview(message) : props.index?.get(id),
      response: message ? replyText(props.assistantMessagesByParent().get(id) ?? []) : (state.replies[id] ?? undefined),
    }
  })

  let list: HTMLDivElement | undefined
  let card: HTMLDivElement | undefined
  // Each tick's element and the scale last written to it.
  const ticks = new Map<string, { element: HTMLElement; scale: number }>()
  // The pointer's clientY over the rail, and the rail's geometry from the last frame's read phase.
  let pointer: number | undefined

  const rail = { top: 0, height: 0, root: 0, rootHeight: 0 }

  // `position` follows the pointer in tick units and `wave` swells the ticks around it, so one pair drives every tick.
  const motion = {
    wave: Spring.fromDuration(0, { duration: 0.2, bounce: 0 }),
    position: Spring.fromDuration(0, { duration: 0.12, bounce: 0 }),
    top: Spring.fromDuration(0, { duration: 0.25, bounce: 0 }),
    opacity: Spring.fromDuration(0, { duration: 0.18, bounce: 0 }),
  }

  let frame: (() => void) | undefined

  // Reduced motion drops travel but keeps the preview's fade.
  const step = (spring: Spring, dt: number) =>
    spring === motion.opacity || !prefersReducedMotion() ? spring.step(dt) : spring.snap(spring.target).value

  const paint = (dt: number) => {
    const ids = marks()
    const pitch = rail.height / Math.max(1, ids.length)

    if (pointer !== undefined && pitch > 0) {
      const hit = railHit(pointer - rail.top, rail.height, ids.length)
      const id = ids[hit.index]
      const tick = rail.top - rail.root + (hit.index + 0.5) * pitch

      // Entering the rail starts the wave under the pointer rather than sweeping in from where it left.
      if (motion.wave.value === 0) motion.position.snap(hit.position)
      motion.position.set(hit.position)
      motion.wave.set(1)
      motion.top.set(Math.max(0, Math.min(rail.rootHeight - previewMaxHeight, tick - previewAnchor)))

      // Store writes re-render, so they wait until the frame's style writes are done.
      if (id && id !== state.hover) queueMicrotask(() => pointer !== undefined && setState({ hover: id, shown: id }))
    }

    const position = step(motion.position, dt)
    const wave = step(motion.wave, dt)

    ids.forEach((id, index) => {
      const distance = Math.abs(index - position) * pitch
      const swell = distance < waveRadius ? (wave * (1 + Math.cos((distance / waveRadius) * Math.PI))) / 2 : 0
      const rest = active(id) ? tickWidths.active : tickWidths.default
      const scale = (rest + (tickWidths.peak - rest) * swell) / tickWidths.peak
      const tick = ticks.get(id)

      if (!tick || tick.scale === scale) return
      tick.scale = scale
      tick.element.style.transform = `scaleX(${scale})`
    })

    // The preview appears on the pointer's first frame, in place; one already showing glides to the next turn, and a
    // closing one fades.
    if (motion.opacity.value === 0) motion.top.snap(motion.top.target)

    if (pointer !== undefined) motion.opacity.snap(1)
    motion.opacity.set(pointer === undefined ? 0 : 1)
    const opacity = step(motion.opacity, dt)

    if (card) {
      card.style.transform = `translateY(${step(motion.top, dt)}px)`
      card.style.opacity = String(opacity)
      card.style.visibility = opacity === 0 ? "hidden" : "visible"
    }

    return Object.values(motion).some((spring) => !spring.resting)
  }

  const wake = () => {
    frame ??= frameLoop.addMeasured(
      () => {
        // Only the pointer needs geometry; reading it otherwise would force a layout on every streamed frame.
        if (!list || pointer === undefined) return
        const box = list.getBoundingClientRect()
        const root = props.root.getBoundingClientRect()
        rail.top = box.top
        rail.height = box.height
        rail.root = root.top
        rail.rootHeight = root.height
      },
      (dt) => {
        if (paint(dt)) return true
        frame = undefined

        return false
      },
    )
  }

  const leave = () => {
    pointer = undefined
    motion.wave.set(0)
    setState("hover", undefined)
    wake()
  }

  // Resting widths follow the visible turns.
  createEffect(() => {
    marks().forEach((id) => active(id))
    wake()
  })

  onCleanup(() => frame?.())

  return (
    <Show when={turns().length > 1}>
      <div
        class="flex max-h-full min-h-0 w-full cursor-pointer flex-col py-6 pointer-events-auto animate-in fade-in [animation-duration:180ms] [animation-timing-function:ease-out] motion-reduce:animate-none"
        onPointerMove={(event) => {
          pointer = event.clientY
          wake()
        }}
        onPointerLeave={leave}
        // Scrolling over the rail closes the preview; the next pointer move reopens it on the turn below the pointer.
        onWheel={leave}
        onClick={(event) => {
          if (!list) return
          const box = list.getBoundingClientRect()
          const ids = marks()
          const id = ids[railHit(event.clientY - box.top, box.height, ids.length).index]

          if (!id) return

          if (hintReady() && !hint.used) setHint("used", true)
          props.onSelect(id)
        }}
      >
        <div ref={list} class="flex min-h-0 flex-col">
          <For each={marks()}>
            {(id, index) => (
              <div
                data-turn={id}
                data-index={index()}
                // Active state wins so a clicked or visible turn stays active under the pointer. The hovered tick is
                // still the brightest: it lights at once and cools off as the pointer moves on.
                data-state={active(id) ? "active" : hovered(id) ? "hovered" : "default"}
                class="flex h-2 min-h-1 w-full shrink items-center ps-2.5 [--tick-color:var(--v2-background-bg-layer-04)] [--tick-opacity:1] [[data-color-scheme=dark]_&]:data-[state=default]:[--tick-opacity:0.7] data-[state=active]:[--tick-color:var(--v2-icon-icon-muted)]"
              >
                <span
                  ref={(element) => {
                    const scale = (active(id) ? tickWidths.active : tickWidths.default) / tickWidths.peak
                    element.style.transform = `scaleX(${scale})`
                    ticks.set(id, { element, scale })
                    onCleanup(() => ticks.delete(id))
                  }}
                  class="block h-px shrink-0 origin-left bg-(--tick-color) rtl:origin-right"
                  style={{
                    width: `${tickWidths.peak}px`,
                    opacity: hovered(id) ? 1 : "var(--tick-opacity)",
                    "background-color": hovered(id) ? "var(--v2-icon-icon-base)" : undefined,
                    transition: hovered(id) ? "none" : "background-color 180ms ease-out, opacity 180ms ease-out",
                  }}
                />
              </div>
            )}
          </For>
        </div>
      </div>
      <div
        ref={card}
        data-slot="session-turn-navigator-preview"
        class="pointer-events-none invisible absolute start-12 top-0 w-[320px] max-w-[calc(100vw-5rem)] rounded-lg bg-v2-background-bg-base p-2 opacity-0"
        style={{ "box-shadow": "var(--v2-elevation-raised)" }}
      >
        <Show when={preview()}>
          {(item) => (
            <>
              <div class="rounded-md bg-v2-background-bg-layer-02 px-2 py-1">
                <p dir="auto" class="line-clamp-6 text-[13px] font-medium leading-text-compact text-v2-text-text-base">
                  {item().prompt}
                </p>
              </div>
              <Show when={item().response}>
                {(text) => (
                  <p
                    dir="auto"
                    class="mt-1.5 line-clamp-3 px-2 text-[13px] leading-text-compact text-v2-text-text-muted"
                  >
                    {text()}
                  </p>
                )}
              </Show>
              <Show when={hintReady() && !hint.used}>
                <div class="mt-1.5 px-2 text-[12px] leading-text-compact text-v2-text-text-faint">
                  {language.t("session.turnNavigator.hint")}
                </div>
              </Show>
            </>
          )}
        </Show>
      </div>
    </Show>
  )
}

function promptPreview(message: SessionMessageUser) {
  return previewText(readPromptPresentation(message.metadata)?.displayText ?? message.text)
}

function replyText(messages: SessionMessageAssistant[]) {
  const text = messages
    .flatMap((message) => message.content)
    .findLast((content) => content.type === "text" && content.text.trim())

  return text?.type === "text" ? previewText(text.text) : undefined
}

function previewText(text: string) {
  const flat = text.replace(/\s+/g, " ").trim()

  return flat.length > previewLength ? `${flat.slice(0, previewLength)}…` : flat
}

/**
 * The tick nearest a pointer `offset` px down a rail of `count` evenly spaced ticks `height` px tall, and the pointer's
 * position in tick units (0 is the first tick's centre). Offsets beyond either end clamp to that end's tick.
 */
function railHit(offset: number, height: number, count: number) {
  const position = Math.min(count - 1, Math.max(0, (offset / height) * count - 0.5))

  return { index: Math.round(position), position }
}
