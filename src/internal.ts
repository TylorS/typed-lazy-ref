import * as Cause from 'effect/Cause'
import * as Chunk from 'effect/Chunk'
import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Effectable from 'effect/Effectable'
import * as Equal from 'effect/Equal'
import * as Equivalence from 'effect/Equivalence'
import * as ExecutionStrategy from 'effect/ExecutionStrategy'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import type * as FiberId from 'effect/FiberId'
import { constVoid } from 'effect/Function'
import * as MutableRef from 'effect/MutableRef'
import * as Option from 'effect/Option'
import { pipeArguments } from 'effect/Pipeable'
import * as Predicate from 'effect/Predicate'
import * as PubSub from 'effect/PubSub'
import * as Queue from 'effect/Queue'
import * as Record from 'effect/Record'
import type * as Runtime from 'effect/Runtime'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import type * as Types from 'effect/Types'
import type { GetSetDelete, LazyRefOptions } from './LazyRef.js'

const toDeepEquals = (u: unknown): unknown => {
  switch (typeof u) {
    case 'object': {
      if (Predicate.isNullable(u)) {
        return u
      } else if (Equal.symbol in u) {
        return u
      } else if (Array.isArray(u)) {
        return Data.tuple(u.map(toDeepEquals))
      } else if (u instanceof Set) {
        return Data.tuple(Array.from(u, toDeepEquals))
      } else if (u instanceof Map) {
        return Data.tuple(Array.from(u, ([k, v]) => Data.tuple([toDeepEquals(k), toDeepEquals(v)])))
      } else if (u instanceof URLSearchParams) {
        return Data.tuple(
          Array.from(u.keys()).map((key) => Data.tuple([key, toDeepEquals(u.getAll(key))])),
        )
      } else if (Symbol.iterator in u) {
        return Data.tuple(Array.from(u as any, toDeepEquals))
      } else {
        return Data.struct(Record.map(u, toDeepEquals))
      }
    }
    default:
      return u
  }
}

/**
 * @internal
 */
export const deepEquals = (a: unknown, b: unknown) => {
  // Attempt reference equality first for performance
  if (Object.is(a, b)) return true
  return Equal.equals(toDeepEquals(a), toDeepEquals(b))
}

export abstract class EffectBase<A, E, R>
  extends Effectable.StructuralClass<A, E, R>
  implements Effect.Effect<A, E, R>
{
  abstract toEffect(): Effect.Effect<A, E, R>

  private _effect: Effect.Effect<A, E, R> | undefined

  commit(): Effect.Effect<A, E, R> {
    return (this._effect ??= this.toEffect())
  }
}

export class SubscriptionRefCore<A, E, R, R2> {
  constructor(
    readonly initial: Effect.Effect<A, E, R>,
    readonly pubsub: PubsubWithReplay<A, E>,
    readonly runtime: Runtime.Runtime<R2>,
    readonly scope: Scope.CloseableScope,
    readonly deferredRef: DeferredRef<A, E>,
    readonly semaphore: Effect.Semaphore,
  ) {}

  public _fiber: Fiber.Fiber<A, E> | undefined = undefined
}

export function makeCore<A, E, R>(initial: Effect.Effect<A, E, R>, options?: LazyRefOptions<A>) {
  return Effect.runtime<R | Scope.Scope>().pipe(
    Effect.bindTo('runtime'),
    Effect.bind('scope', ({ runtime }) =>
      Scope.fork(Context.get(runtime.context, Scope.Scope), ExecutionStrategy.parallel),
    ),
    Effect.bind('id', () => Effect.fiberId),
    Effect.map(({ id, runtime, scope }) => unsafeMakeCore(initial, id, runtime, scope, options)),
    Effect.tap((core) =>
      Scope.addFinalizer(core.scope, Effect.provide(interruptCore(core), core.runtime)),
    ),
  )
}

export function unsafeMakeCore<A, E, R, R2>(
  initial: Effect.Effect<A, E, R>,
  id: FiberId.FiberId,
  runtime: Runtime.Runtime<R2>,
  scope: Scope.CloseableScope,
  options?: LazyRefOptions<A>,
): SubscriptionRefCore<A, E, R, R2> {
  const pubsub = pubsubWithReplay<A, E>()
  const core = new SubscriptionRefCore(
    initial,
    pubsub,
    runtime,
    scope,
    unsafeMakeDeferredRef(id, getExitEquivalence(options?.eq ?? deepEquals), pubsub.lastValue),
    Effect.unsafeMakeSemaphore(1),
  )

  // Initialize the deferred ref with the initial value if it's already available
  matchEffectPrimitive(initial, {
    Success: (a) => core.deferredRef.done(Exit.succeed(a)),
    Failure: (cause) => core.deferredRef.done(Exit.failCause(cause)),
    Left: (e) => core.deferredRef.done(Exit.fail(e)),
    Right: (a) => core.deferredRef.done(Exit.succeed(a)),
    Some: (a) => core.deferredRef.done(Exit.succeed(a)),
    Sync: (f) => core.deferredRef.done(Exit.succeed(f())),
    None: (e) => core.deferredRef.done(Exit.fail(e)),
    Otherwise: constVoid,
  })

  return core
}

export function matchEffectPrimitive<A, E, R, Z>(
  effect: Effect.Effect<A, E, R>,
  matchers: {
    Success: (a: A) => Z
    Failure: (e: Cause.Cause<E>) => Z
    Sync: (f: () => A) => Z
    Left: (e: E) => Z
    Right: (a: A) => Z
    Some: (a: A) => Z
    None: (e: E) => Z
    Otherwise: (effect: Effect.Effect<A, E, R>) => Z
  },
): Z {
  const eff = effect as any

  switch (eff._op) {
    case 'Success':
      return matchers.Success(eff.value)
    case 'Failure':
      return matchers.Failure(eff.cause)
    case 'Sync':
      return matchers.Sync(eff.effect_instruction_i0)
    case 'Left':
      return matchers.Left(eff.left)
    case 'Right':
      return matchers.Right(eff.right)
    case 'Some':
      return matchers.Some(eff.value)
    case 'None':
      return matchers.None(new Cause.NoSuchElementException() as E)
    case 'Commit':
      return matchEffectPrimitive(eff.commit(), matchers)
    default:
      return matchers.Otherwise(effect)
  }
}

export const getExitEquivalence = <A, E = never>(A: Equivalence.Equivalence<A>) =>
  Equivalence.make<Exit.Exit<A, E>>((a, b) => {
    if (a._tag === 'Failure') {
      return b._tag === 'Failure' && Equal.equals(a.cause, b.cause)
    } else {
      return b._tag === 'Success' && A(a.value, b.value)
    }
  })

// Here to wrap the pubsub with a last value ref which can be shared with the DeferredRef
class PubsubWithReplay<A, E> implements PubSub.PubSub<Exit.Exit<A, E>> {
  [Queue.EnqueueTypeId]: {
    _In: Types.Contravariant<Exit.Exit<A, E>>
  } = {
    _In: (_) => _,
  }

  readonly subscriberCount: MutableRef.MutableRef<number> = MutableRef.make(0)

  constructor(
    readonly pubsub: PubSub.PubSub<Exit.Exit<A, E>>,
    readonly lastValue: MutableRef.MutableRef<Option.Option<Exit.Exit<A, E>>>,
  ) {}

  publish(value: Exit.Exit<A, E>): Effect.Effect<boolean> {
    return this.pubsub.publish(value)
  }

  publishAll(elements: Iterable<Exit.Exit<A, E>>): Effect.Effect<boolean> {
    return this.pubsub.publishAll(elements)
  }

  subscribe: Effect.Effect<Queue.Dequeue<Exit.Exit<A, E>>, never, Scope.Scope> = Effect.suspend(
    () => {
      MutableRef.increment(this.subscriberCount)

      return this.pubsub.subscribe.pipe(
        Effect.map((dequeue) =>
          Option.match(MutableRef.get(this.lastValue), {
            onNone: () => dequeue,
            onSome: (previous) => dequeuePrepend(dequeue, previous),
          }),
        ),
        Effect.tap(
          Effect.addFinalizer(() => Effect.sync(() => MutableRef.decrement(this.subscriberCount))),
        ),
      )
    },
  )

  offer(value: Exit.Exit<A, E>): Effect.Effect<boolean> {
    return this.pubsub.offer(value)
  }

  unsafeOffer(value: Exit.Exit<A, E>) {
    return this.pubsub.unsafeOffer(value)
  }

  offerAll(elements: Iterable<Exit.Exit<A, E>>): Effect.Effect<boolean> {
    return this.pubsub.offerAll(elements)
  }

  capacity(): number {
    return this.pubsub.capacity()
  }

  isActive(): boolean {
    return this.pubsub.isActive()
  }

  get size(): Effect.Effect<number> {
    return this.pubsub.size
  }

  unsafeSize(): Option.Option<number> {
    return this.pubsub.unsafeSize()
  }

  get isFull(): Effect.Effect<boolean> {
    return this.pubsub.isFull
  }

  get isEmpty(): Effect.Effect<boolean> {
    return this.pubsub.isEmpty
  }

  get isShutdown(): Effect.Effect<boolean> {
    return this.pubsub.isShutdown
  }

  get shutdown(): Effect.Effect<void> {
    return this.pubsub.shutdown
  }

  get awaitShutdown(): Effect.Effect<void> {
    return this.pubsub.awaitShutdown
  }

  pipe() {
    // biome-ignore lint/style/noArguments: This is a pipeable
    return pipeArguments(this, arguments)
  }
}

class DequeueWithPrepend<A> extends EffectBase<A, never, never> implements Queue.Dequeue<A> {
  private previousUtilized = false;

  [Queue.DequeueTypeId]: {
    _Out: Types.Covariant<A>
  } = {
    _Out: (_) => _,
  }

  constructor(
    readonly dequeue: Queue.Dequeue<A>,
    readonly previous: A,
  ) {
    super()
  }

  toEffect(): Effect.Effect<A, never, never> {
    return this.take
  }

  take: Effect.Effect<A> = Effect.suspend(() => {
    if (this.previousUtilized) {
      return this.dequeue.take
    } else {
      this.previousUtilized = true
      return Effect.succeed(this.previous)
    }
  })

  takeAll: Effect.Effect<Chunk.Chunk<A>> = Effect.suspend(() => {
    if (this.previousUtilized) {
      return this.dequeue.takeAll
    } else {
      this.previousUtilized = true
      return this.dequeue.takeAll.pipe(Effect.map((a) => Chunk.prepend(a, this.previous)))
    }
  })

  takeUpTo(max: number): Effect.Effect<Chunk.Chunk<A>, never, never> {
    return Effect.suspend(() => {
      if (this.previousUtilized) {
        return this.dequeue.takeUpTo(max)
      } else {
        this.previousUtilized = true
        return this.dequeue
          .takeUpTo(max - 1)
          .pipe(Effect.map((a) => Chunk.prepend(a, this.previous)))
      }
    })
  }

  takeBetween(min: number, max: number): Effect.Effect<Chunk.Chunk<A>, never, never> {
    return Effect.suspend(() => {
      if (this.previousUtilized) {
        return this.dequeue.takeBetween(min, max)
      } else {
        this.previousUtilized = true

        return this.dequeue
          .takeBetween(min - 1, max - 1)
          .pipe(Effect.map((a) => Chunk.prepend(a, this.previous)))
      }
    })
  }

  capacity(): number {
    return this.dequeue.capacity()
  }

  isActive(): boolean {
    return this.dequeue.isActive()
  }

  get size(): Effect.Effect<number> {
    return Effect.suspend(() => {
      if (this.previousUtilized) {
        return this.dequeue.size
      } else {
        return this.dequeue.size.pipe(Effect.map((size) => size + 1))
      }
    })
  }

  unsafeSize(): Option.Option<number> {
    if (this.previousUtilized) {
      return this.dequeue.unsafeSize()
    } else {
      return this.dequeue.unsafeSize().pipe(Option.map((size) => size + 1))
    }
  }

  get isFull(): Effect.Effect<boolean> {
    return this.dequeue.isFull
  }

  get isEmpty(): Effect.Effect<boolean> {
    return Effect.suspend(() => {
      if (this.previousUtilized) {
        return this.dequeue.isEmpty
      } else {
        return Effect.succeed(false)
      }
    })
  }

  get isShutdown(): Effect.Effect<boolean> {
    return this.dequeue.isShutdown
  }

  get shutdown(): Effect.Effect<void> {
    return this.dequeue.shutdown
  }

  get awaitShutdown(): Effect.Effect<void> {
    return this.dequeue.awaitShutdown
  }

  pipe() {
    // biome-ignore lint/style/noArguments: This is a pipeable
    return pipeArguments(this, arguments)
  }
}

export function dequeuePrepend<A>(dequeue: Queue.Dequeue<A>, previous: A): Queue.Dequeue<A> {
  return new DequeueWithPrepend(dequeue, previous)
}

export function pubsubWithReplay<A, E>() {
  const lastValue = MutableRef.make(Option.none<Exit.Exit<A, E>>())
  const base = Effect.runSync(PubSub.unbounded<Exit.Exit<A, E>>())
  return new PubsubWithReplay(base, lastValue)
}

export function streamExit<A, E, R>(
  stream: Stream.Stream<A, E, R>,
): Stream.Stream<Exit.Exit<A, E>, never, R> {
  return stream.pipe(
    Stream.map(Exit.succeed),
    Stream.catchAllCause((cause) => Stream.succeed(Exit.failCause(cause))),
  )
}

export class DeferredRef<A, E> extends EffectBase<A, E, never> {
  // Keep track of the latest value emitted by the stream
  public version!: number
  public deferred!: Deferred.Deferred<A, E>

  constructor(
    private id: FiberId.FiberId,
    private eq: Equivalence.Equivalence<Exit.Exit<A, E>>,
    readonly current: MutableRef.MutableRef<Option.Option<Exit.Exit<A, E>>>,
  ) {
    super()
    this.reset()
  }

  toEffect() {
    return Effect.suspend(() => {
      const current = MutableRef.get(this.current)
      if (Option.isNone(current)) {
        return Deferred.await(this.deferred)
      } else {
        return current.value
      }
    })
  }

  done(exit: Exit.Exit<A, E>) {
    const current = MutableRef.get(this.current)

    MutableRef.set(this.current, Option.some(exit))

    if (Option.isSome(current) && this.eq(current.value, exit)) {
      return false
    }

    Deferred.unsafeDone(this.deferred, exit)
    this.version += 1

    return true
  }

  reset() {
    MutableRef.set(this.current, Option.none())
    this.version = -1

    if (this.deferred) {
      Deferred.unsafeDone(this.deferred, Exit.interrupt(this.id))
    }

    this.deferred = Deferred.unsafeMake(this.id)
  }
}

export function makeDeferredRef<A, E>(eq: Equivalence.Equivalence<Exit.Exit<A, E>>) {
  return Effect.map(Effect.fiberId, (id) => new DeferredRef(id, eq, MutableRef.make(Option.none())))
}

export function unsafeMakeDeferredRef<A, E>(
  id: FiberId.FiberId,
  eq: Equivalence.Equivalence<Exit.Exit<A, E>>,
  current: MutableRef.MutableRef<Option.Option<Exit.Exit<A, E>>>,
) {
  return new DeferredRef(id, eq, current)
}

export class MulticastEffect<A, E, R> extends EffectBase<A, E, R> {
  private _fiber: Fiber.Fiber<A, E> | null = null
  private _refCount = 0

  constructor(readonly effect: Effect.Effect<A, E, R>) {
    super()
  }

  toEffect(): Effect.Effect<A, E, R> {
    return Effect.suspend(() => {
      if (++this._refCount === 1) {
        return this.effect.pipe(
          Effect.forkDaemon,
          Effect.tap((fiber) => {
            this._fiber = fiber
          }),
          Effect.flatMap(Fiber.join),
          Effect.onExit(() => this.interrupt),
        )
      }

      // biome-ignore lint/style/noNonNullAssertion: fiber is set by forkDaemon
      return Effect.fromFiber(this._fiber!).pipe(Effect.onExit(() => this.interrupt))
    })
  }

  interrupt = Effect.suspend(() => {
    if (--this._refCount === 0 && this._fiber) {
      const interrupt = Fiber.interrupt(this._fiber)
      this._fiber = null
      return interrupt
    }

    return Effect.void
  })
}

export function getSetDelete<A, E, R, R2>(
  core: SubscriptionRefCore<A, E, R, R2>,
): GetSetDelete<A, E, Exclude<R, R2>> {
  return {
    get: getOrInitializeCore(core, false),
    set: (a) => setCore<A, E, R, R2>(core, a),
    delete: deleteCore(core),
    version: Effect.sync(() => core.deferredRef.version),
  }
}

export function getOrInitializeCore<A, E, R, R2>(
  core: SubscriptionRefCore<A, E, R, R2>,
  lockInitialize: boolean,
): Effect.Effect<A, E, Exclude<R, R2>> {
  return Effect.suspend(() => {
    if (core._fiber === undefined && Option.isNone(MutableRef.get(core.deferredRef.current))) {
      return initializeCoreAndTap(core, lockInitialize)
    } else {
      return core.deferredRef
    }
  })
}

function initializeCoreEffect<A, E, R, R2>(
  core: SubscriptionRefCore<A, E, R, R2>,
  lock: boolean,
): Effect.Effect<Fiber.Fiber<A, E>, never, Exclude<R, R2>> {
  const initialize = Effect.onExit(Effect.provide(core.initial, core.runtime.context), (exit) =>
    Effect.sync(() => {
      core._fiber = undefined
      core.deferredRef.done(exit)
    }),
  )

  return Effect.flatMap(
    Effect.forkIn(lock ? core.semaphore.withPermits(1)(initialize) : initialize, core.scope),
    (fiber) => Effect.sync(() => (core._fiber = fiber)),
  )
}

function initializeCore<A, E, R, R2>(
  core: SubscriptionRefCore<A, E, R, R2>,
  lock: boolean,
): Effect.Effect<Fiber.Fiber<A, E>, never, Exclude<R, R2>> {
  type Z = Effect.Effect<Fiber.Fiber<A, E>, never, Exclude<R, R2>>

  const onSuccess = (a: A): Z => {
    core.deferredRef.done(Exit.succeed(a))
    return Effect.succeed(Fiber.succeed(a))
  }

  const onCause = (cause: Cause.Cause<E>): Z => {
    core.deferredRef.done(Exit.failCause(cause))
    return Effect.succeed(Fiber.failCause(cause))
  }

  const onError = (e: E): Z => onCause(Cause.fail(e))

  return matchEffectPrimitive(core.initial, {
    Success: onSuccess,
    Failure: onCause,
    Some: onSuccess,
    None: onError,
    Left: onError,
    Right: onSuccess,
    Sync: (f) => onSuccess(f()),
    Otherwise: () => initializeCoreEffect(core, lock),
  })
}

function initializeCoreAndTap<A, E, R, R2>(
  core: SubscriptionRefCore<A, E, R, R2>,
  lock: boolean,
): Effect.Effect<A, E, Exclude<R, R2>> {
  return Effect.zipRight(initializeCore(core, lock), tapEventCore(core, core.deferredRef))
}

function setCore<A, E, R, R2>(
  core: SubscriptionRefCore<A, E, R, R2>,
  a: A,
): Effect.Effect<A, never, Exclude<R, R2>> {
  const exit = Exit.succeed(a)

  return Effect.suspend(() => {
    if (core.deferredRef.done(exit)) {
      // If the value changed, send an event
      return Effect.as(sendEvent(core, exit), a)
    } else {
      // Otherwise, just return the current value
      return Effect.succeed(a)
    }
  })
}

export function interruptCore<A, E, R, R2>(
  core: SubscriptionRefCore<A, E, R, R2>,
): Effect.Effect<void, never, R> {
  return Effect.fiberIdWith((id) => {
    core.deferredRef.reset()

    const closeScope = Effect.forkDaemon(Scope.close(core.scope, Exit.interrupt(id)))
    const interruptFiber = core._fiber ? Fiber.interruptFork(core._fiber) : Effect.void
    const interruptSubject = core.pubsub.shutdown

    return Effect.all([closeScope, interruptFiber, interruptSubject], {
      discard: true,
      concurrency: 'unbounded',
    })
  })
}

export function interruptCoreAndWait<A, E, R, R2>(
  core: SubscriptionRefCore<A, E, R, R2>,
): Effect.Effect<void, never, R> {
  return Effect.fiberIdWith((id) => {
    core.deferredRef.reset()

    const closeScope = Scope.close(core.scope, Exit.interrupt(id))
    const interruptFiber = core._fiber ? Fiber.interrupt(core._fiber) : Effect.void
    const interruptSubject = core.pubsub.awaitShutdown

    return Effect.all([closeScope, interruptFiber, interruptSubject], {
      discard: true,
      concurrency: 'unbounded',
    })
  })
}

function deleteCore<A, E, R, R2>(
  core: SubscriptionRefCore<A, E, R, R2>,
): Effect.Effect<Option.Option<A>, E, Exclude<R, R2>> {
  return Effect.suspend(() => {
    const current = MutableRef.get(core.deferredRef.current)
    core.deferredRef.reset()

    if (Option.isNone(current)) {
      return Effect.succeed(Option.none())
    }

    return Effect.sync(() => MutableRef.get(core.pubsub.subscriberCount)).pipe(
      Effect.flatMap((count: number) =>
        count > 0 && !core._fiber ? initializeCore(core, false) : Effect.void,
      ),
      Effect.zipRight(Effect.asSome(current.value)),
    )
  })
}

function tapEventCore<A, E, R, R2, R3>(
  core: SubscriptionRefCore<A, E, R, R2>,
  effect: Effect.Effect<A, E, R3>,
) {
  return effect.pipe(
    Effect.exit,
    Effect.tap((exit) => sendEvent(core, exit)),
    Effect.flatten,
  )
}

export function sendEvent<A, E, R, R2>(
  core: SubscriptionRefCore<A, E, R, R2>,
  exit: Exit.Exit<A, E>,
): Effect.Effect<void> {
  return core.pubsub.publish(exit)
}
