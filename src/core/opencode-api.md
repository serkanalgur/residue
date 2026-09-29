# OpenCode V2 Plugin API — Verified Facts

## Step 0: API Citations

### 1. `ctx.event.subscribe` Signature and Return Type

**File**: `node_modules/@opencode/client/dist/promise/client.d.ts:10-12`

```typescript
event: {
  subscribe(options?: SharedEvents.SubscribeOptions): AsyncIterable<import("./index.js").V2Event>;
};
```

**File**: `node_modules/@opencode/client/dist/shared-events.d.ts:2-6`

```typescript
export type SubscribeOptions = {
  readonly signal?: AbortSignal;
  readonly onActivity?: () => void;
};
```

**Return type**: `AsyncIterable<V2Event>` — NOT a function with `.on()`. To consume events,
use `for await (const event of ctx.event.subscribe({ signal }))`. The iterable completes
when the `AbortSignal` is aborted.

**Unsubscribe mechanism**: Pass an `AbortSignal` to `subscribe()`. Call `signal.abort()` to
stop receiving events. There is no separate unsubscribe function.

**V2Event shape** (`node_modules/@opencode/client/dist/promise/generated/types.d.ts:3310`):
A large union type. Key events for residue:

- `SessionIdle` (line 1745): `{ type: "session.idle", data: { sessionID: string } }`
- `SessionTextDelta` (line 1488): `{ type: "session.text.delta", data: { sessionID, assistantMessageID, ordinal, delta } }`
- `SessionTextStarted` (line 1214): `{ type: "session.text.started", data: { sessionID, assistantMessageID } }`
- `SessionTextEnded` (line 2016): `{ type: "session.text.ended", data: { sessionID, assistantMessageID } }`

### 2. `ctx.session.hook()` Return Type

**File**: `node_modules/@opencode/plugin/dist/promise/registration.d.ts:1-11`

```typescript
export interface Registration {
  readonly dispose: () => Promise<void>;
}
export type ModelHooks<Spec> = <Name extends keyof Spec>(
  name: Name,
  callback: (input: Spec[Name]) => Promise<void> | void,
  options?: Spec[Name] extends { readonly model: unknown } ? ModelHookOptions : never,
) => Promise<Registration>;
```

**Return type**: `Promise<Registration>` — where `Registration` has a single method
`dispose: () => Promise<void>`. Not `.unregister()`, not `.off()`.

The `context` hook is the only hook that carries `model`, so `{ providerID }` is legal
as the third argument (verified by the conditional type on `ModelHookOptions`).

### 3. `ctx.tool.transform` Return Type

**File**: `node_modules/@opencode/plugin/dist/promise/registration.d.ts:12`

```typescript
export type Transform<Input> = (callback: (input: Input) => void) => Promise<Registration>;
```

Returns `Promise<Registration>` — same `dispose()` pattern.

### 4. Plugin.setup Return

**File**: `node_modules/@opencode/plugin/dist/promise/plugin.d.ts:57`

```typescript
readonly setup: (context: Context) => Promise<Cleanup | void> | Cleanup | void;
```

`Cleanup = () => Promise<void> | void` (line 54).
