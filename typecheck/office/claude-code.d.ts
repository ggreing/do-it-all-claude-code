// The parts of Claude Code's plugin API ('claude-code') that the team office (plugin/office) uses, written by hand
// so the root `tsc -b` type-checks the office without the engine (decision 186 ④). The engine's own declarations
// are the authority: `claude plugin validate plugin/` checks the module against them, and `claude plugin test
// plugin/` runs it. When the two disagree, this file follows the engine.
//
// Kept to what the office calls, with the engine's names, so an office change that uses something new fails here
// first and is added here on purpose. Shapes are narrowed where the office does not care (an element's drawn
// form, a stream's chunks).

declare module 'claude-code' {
  // ---------------------------------------------------------------- values and state

  export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue }

  /** Per plugin, the values it keeps in `$.state`; a plugin's own contract adds itself here. */
  export interface PluginState {}

  /** A state value stored with a shape name, so a changed shape starts from its initial value. */
  export type Shaped<T> = { shape: string; value: T }
  export type ShapedValue<V> = V extends Shaped<infer T> ? T : never

  export type StateAddress = { plugin: string; key: string; id?: string }
  export type Atom<T> = { readonly ref: StateAddress; readonly initial: T; readonly shape?: string }
  export type AtomOptions = { shape: string }

  type StateName<P extends string, K extends string> = { readonly plugin: P; readonly key: K }

  export type AtomFunction = {
    <P extends keyof PluginState & string, K extends keyof PluginState[P] & string>(
      ref: StateName<P, K> & Readonly<Pick<StateAddress, 'id'>>, initial: PluginState[P][K]): Atom<PluginState[P][K]>
    <P extends keyof PluginState & string, K extends keyof PluginState[P] & string>(
      ref: StateName<P, K> & Readonly<Pick<StateAddress, 'id'>>, initial: ShapedValue<PluginState[P][K]>, options: AtomOptions): Atom<ShapedValue<PluginState[P][K]>>
  }
  export const atom: AtomFunction
  export const read: <T>($: EngineInterface, source: Atom<T>) => Promise<T>
  // As the engine has it: `T` may widen to what the change returns, so a wrong value in a change is not caught here
  // or by validate (a narrower `T` loses the literal types of a change that takes no argument).
  export const update: <T>($: EngineInterface, target: Atom<T>, change: (value: T) => T) => Promise<T>

  // ---------------------------------------------------------------- what a hook draws with

  export type RenderSurface = 'terminal' | 'desktop' | 'mobile' | 'vscode'
  /** A theme key (`success`, `inactive`, ...) or a color. */
  export type Color = string

  /** A drawn element: plain data the engine paints. The office only builds them. */
  export type RenderElement = { readonly type: string; readonly props?: unknown; readonly children?: readonly RenderNode[] }
  export type RenderNode = RenderElement | string
  export type RenderChildren = RenderNode | number | boolean | null | undefined | readonly RenderChildren[]

  type Space = number
  export type BoxProps = {
    key?: string
    flexDirection?: 'row' | 'column' | 'row-reverse' | 'column-reverse'
    flexGrow?: number
    flexWrap?: 'nowrap' | 'wrap' | 'wrap-reverse'
    alignItems?: 'flex-start' | 'center' | 'flex-end' | 'stretch'
    justifyContent?: 'flex-start' | 'center' | 'flex-end' | 'space-between' | 'space-around' | 'space-evenly'
    width?: number | string
    height?: number | string
    marginBottom?: Space
    marginRight?: Space
    paddingX?: Space
    borderStyle?: string
    borderColor?: Color
    borderDimColor?: boolean
  }
  export type TextProps = {
    key?: string
    color?: Color
    dimColor?: boolean
    bold?: boolean
    underline?: boolean
    wrap?: 'wrap' | 'end' | 'middle' | 'truncate' | 'truncate-start' | 'truncate-middle' | 'truncate-end'
  }
  export type ButtonProps = {
    key?: string
    label?: string
    hotkey?: string
    plain?: true
    dimColor?: boolean
    variant?: 'primary' | 'secondary'
    /** The site's focus ring starts here when the site takes the keyboard. */
    autoFocus?: true
    onPress: (e: unknown) => void
  }
  export type ClientProps = {
    key: string
    module: string
    props?: unknown
    width?: number | string
    height?: number | string
    flexGrow?: number
  }
  type ElementChildren = { children?: RenderChildren }
  export type ElementConstructor<P> = (props: P & ElementChildren) => RenderElement

  type BaseElements = {
    Box: ElementConstructor<BoxProps>
    Text: ElementConstructor<TextProps>
    Button: ElementConstructor<ButtonProps>
  }
  /** Each surface's element table; `Client` (a surface module) is drawn on the terminal and the desktop only. */
  export interface Elements {
    terminal: BaseElements & { Client: ElementConstructor<ClientProps> }
    desktop: BaseElements & { Client: ElementConstructor<ClientProps> }
    mobile: BaseElements
    vscode: BaseElements
  }

  // ---------------------------------------------------------------- surface modules (`Client`)

  export type ClientKeyEvent = { key: string; ctrl?: true; shift?: true; meta?: true }
  export type ClientPointerType = 'down' | 'move' | 'up' | 'enter' | 'leave'
  export type ClientPointerEvent = {
    type: ClientPointerType
    x: number
    y: number
    fine?: { x: number; y: number }
    button?: 'left' | 'middle' | 'right'
    shift?: true
    alt?: true
    ctrl?: true
  }
  export type ClientElements = BaseElements
  export type ClientSurface<S = unknown> = {
    readonly elements: ClientElements
    readonly state: S | undefined
    setState: (next: S) => void
    readonly columns: number
    readonly rows: number
    every: (ms: number, fn: () => void) => () => void
    onPointer: (fn: (event: ClientPointerEvent) => void) => () => void
    onKey: (fn: (event: ClientKeyEvent) => void) => () => void
    post: (data: JsonValue) => void
  }
  export type ClientModule<P extends JsonValue = JsonValue, S = unknown> = (props: P, surface: ClientSurface<S>) => RenderElement

  // ---------------------------------------------------------------- `$`, the engine a hook calls

  export type HookStream<C, R> = AsyncGenerator<C, R> & { readonly result: Promise<R> }

  export type AgentStatus = 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed'
  export type AgentInfo = { id: string; teammateId?: string; description: string; type: string; status: AgentStatus; parentId?: string; spawnedBy?: string; name?: string }
  export type CommandSpec = { name: string; description: string; argumentHint?: string; immediate?: true }
  export type PaneOpenArgs = { id: string; title?: string; focus?: true; closeOnEscape?: true; holdToasts?: true; rows?: number; columns?: number }
  export type UiOpenResult = { isPlaced: true } | { isPlaced: false; reason: string }
  export type SessionVersion = { version: string; base?: string; builtAt?: string }
  export type Timer = { cancel: () => void }
  export type ProcessSpawnRequest = { argv: readonly string[]; cwd?: string; env?: Record<string, string>; input?: string }
  export type ProcessSpawnChunk = { stream: 'stdout' | 'stderr'; text: string }
  export type ProcessSpawnResult = { code: number | null; signal: string | null }
  /** What `$.ui.resolve` takes: a render hook's event. */
  export type ResolveInput = { readonly surface: RenderSurface }

  export interface EngineInterface {
    plugin: { root: string }
    session: { id: () => Promise<string>; version: () => Promise<SessionVersion> }
    env: { get: (name: string) => Promise<string | undefined> }
    fs: { read: (path: string) => Promise<string> }
    clock: { now: () => Promise<number>; every: (ms: number, fn: () => void) => Timer }
    process: { spawn: (request: ProcessSpawnRequest) => HookStream<ProcessSpawnChunk, ProcessSpawnResult> }
    agent: { list: () => Promise<AgentInfo[]> }
    command: { register: (command: CommandSpec) => Promise<unknown> }
    ui: {
      open: (pane: PaneOpenArgs) => Promise<UiOpenResult>
      resolve: <E extends ResolveInput>(e: E) => Elements[E['surface']]
      view: (view: { agentId?: string }) => Promise<{ deny?: string }>
      /** Moves the focus ring of a site holding the keys onto an element drawn there, by its key. */
      focus: (args: { requestId: string; key: string }) => Promise<{ deny?: string }>
    }
  }

  // ---------------------------------------------------------------- the events the office hooks

  type ApiContentBlock = { readonly type: string; readonly text?: unknown }
  type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | number

  /** Per event: what the hook receives, and what it and `next` give back. */
  interface EventOf {
    'session.start': { args: { cwd: string; surface: RenderSurface | null; isInteractive: boolean }; result: { cwd: string } }
    'session.end': { args: { reason: string; sessionId: string; resume: unknown }; result: { sessionId: string } }
    'command.run': {
      args: { command: string; args: string; origin: { kind: string }; presentation: unknown }
      result: { text?: string; context?: readonly string[]; isTextDisplayOnly?: true; exitCode?: number }
    }
    'agent.spawn': {
      args: { tool_use_id: string; prompt: string; description: string; subagentType: string; model?: string; parentModel: string; parentAgentId?: string; background: boolean; fork: boolean; name?: string; cwd?: string }
      result: { model: string; agentId?: string; deny?: undefined } | { deny: string; model?: undefined; agentId?: undefined }
    }
    'tool.call': {
      /** The tool's own fields sit beside `tool` (`command` for Bash, `file_path` for Read, ...). */
      args: { tool: string; agentId?: string; readonly [field: string]: unknown }
      result: { deny: string } | { result: unknown; text?: string; isError?: undefined } | { isError: true; result: unknown; text?: string }
    }
    'session.append': {
      args: { message: { type: 'user' | 'assistant' | 'attachment' | 'system'; content: readonly ApiContentBlock[] }; uuid: string; agentId?: string }
      result: { message: unknown; uuid: string; deny?: undefined } | { deny: string }
    }
    'turn.start': { args: { text: string; turnId: string; agentId?: string }; result: { turnId: string } }
    'turn.complete': { args: { answer: string; durationMs: number; isAborted: boolean; turnId: string; agentId?: string }; result: { text: string } }
    'ui.close': { args: { id: string; origin: { kind: 'plugin' | 'person' | 'unload' } }; result: void }
    /** Before a site's focus ring moves: `element` the key taking it (absent on one of the engine's own stops). */
    'ui.focus': { args: { component: string; requestId: string; plugin?: string; element?: string; origin: { kind: string } }; result: { deny?: string } }
    'ui.message': { args: { surface: RenderSurface; component: string; requestId: string; element: string; module: string; data: unknown }; result: { props?: unknown } }
    'ui.render': { args: { surface: RenderSurface; component: string; requestId: string; props: unknown }; result: RenderElement }
  }
  type EventName = keyof EventOf
  type Args<N extends EventName> = Readonly<EventOf[N]['args']>
  type Result<N extends EventName> = EventOf[N]['result']
  type Next<N extends EventName> = (e: EventOf[N]['args']) => Promise<Result<N>>
  type HookOf<N extends EventName> = ($: EngineInterface, e: Args<N>, next: Next<N>) => Result<N> | Promise<Result<N>>

  /** `turn.step` streams: the hook passes the model's chunks on with `yield* next(e)`. */
  type TurnStepArgs = { turnId: string; index: number; model: string; effort?: Effort; messageCount: number; agentId?: string }
  type TurnStepResult = { turnId: string; index: number; answer: string; stopReason: string }
  type StepHook = ($: EngineInterface, e: Readonly<TurnStepArgs>, next: (e: TurnStepArgs) => HookStream<unknown, TurnStepResult>) => AsyncGenerator<unknown, TurnStepResult | void>

  /** A hook's registration; `.catch` runs when the hook throws, and passes the event on. */
  export type Registration<F> = { readonly catch: (handler: F) => void }

  export type On = {
    (event: 'turn.step', hook: StepHook): Registration<StepHook>
    <N extends EventName>(event: N, hook: HookOf<N>): Registration<HookOf<N>>
    <N extends EventName>(event: N, matcher: Partial<EventOf[N]['args']>, hook: HookOf<N>): Registration<HookOf<N>>
  }
  export type Register = (on: On, options: unknown) => unknown
}

// What JSX compiles against in a hooks or surface module: the classic runtime, `h` and `Fragment` (the engine
// supplies both), and no intrinsic tags (every element comes from `$.ui.resolve(e)` or `surface.elements`).
declare const h: (
  tag: string | ((props: never) => import('claude-code').RenderNode | null | undefined),
  props: Record<string, unknown> | null | undefined,
  ...children: unknown[]
) => import('claude-code').RenderNode | null | undefined
declare const Fragment: (props: { children?: import('claude-code').RenderNode[] }) => import('claude-code').RenderElement

declare namespace JSX {
  type Element = import('claude-code').RenderElement
  type ElementType = (props: never) => import('claude-code').RenderNode | null | undefined
  interface IntrinsicElements {}
  interface ElementChildrenAttribute { children: unknown }
  interface IntrinsicAttributes { key?: string }
}
