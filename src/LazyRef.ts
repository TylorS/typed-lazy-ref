import {
  Boolean,
  type Cause,
  Context,
  Effect,
  type Equivalence,
  type ExecutionStrategy,
  Layer,
  MutableRef,
  Option,
  Readable,
  Record,
  type Runtime,
  type Scope,
  Stream,
  Subscribable,
  type Tracer,
  type Types,
} from 'effect'
import type { Channel } from 'effect/Channel'
import type { Chunk } from 'effect/Chunk'
import { dual, identity } from 'effect/Function'
import { hasProperty } from 'effect/Predicate'
import * as Computed from './Computed.js'
import {
  deepEquals,
  EffectBase,
  getExitEquivalence,
  getOrInitializeCore,
  getSetDelete,
  interruptCore,
  interruptCoreAndWait,
  makeCore,
  makeDeferredRef,
  sendEvent,
  streamExit,
  type SubscriptionRefCore,
} from './internal.js'
import * as Provide from './Provide.js'
import * as Versioned from './Versioned.js'

export const TypeId = Symbol.for('@typed/LazyRef')
export type TypeId = typeof TypeId

export interface LazyRef<in out A, out E = never, out R = never>
  extends Computed.Computed<A, E, R> {
  readonly [TypeId]: LazyRef.Variance<A, E, R>
  readonly shutdown: Effect.Effect<void, never, R>
  readonly awaitShutdown: Effect.Effect<void, never, R>
  readonly subscriberCount: Effect.Effect<number, never, R>
  readonly runUpdates: <B, E2, R2>(
    f: (getSetDelete: GetSetDelete<A, E, R>) => Effect.Effect<B, E2, R2>,
  ) => Effect.Effect<B, E2, R | R2>
}

export declare namespace LazyRef {
  export interface Variance<in out A, out E, out R> {
    readonly _A: Types.Invariant<A>
    readonly _E: Types.Covariant<E>
    readonly _R: Types.Covariant<R>
  }

  export type Success<T> = [T] extends [{ readonly [TypeId]: Variance<infer A, infer _, infer __> }]
    ? A
    : never
  export type Error<T> = [T] extends [{ readonly [TypeId]: Variance<infer _, infer E, infer __> }]
    ? E
    : never
  export type Context<T> = [T] extends [{ readonly [TypeId]: Variance<infer _, infer __, infer R> }]
    ? R
    : never
}

export interface SubscriptionRefOptions<A> {
  readonly eq?: Equivalence.Equivalence<A>
  readonly executionStrategy?: ExecutionStrategy.ExecutionStrategy
}

export interface GetSetDelete<A, E, R> {
  readonly get: Effect.Effect<A, E, R>
  readonly set: (a: A) => Effect.Effect<A, never, R>
  readonly delete: Effect.Effect<Option.Option<A>, E, R>
  readonly version: Effect.Effect<number, never, R>
}

export namespace GetSetDelete {
  export type Success<T> = [T] extends [GetSetDelete<infer A, infer E, infer R>] ? A : never
  export type Error<T> = [T] extends [GetSetDelete<infer A, infer E, infer R>] ? E : never
  export type Context<T> = [T] extends [GetSetDelete<infer A, infer E, infer R>] ? R : never
}

function tupleGetSetDelete<GSDS extends ReadonlyArray<GetSetDelete<any, any, any>>>(
  gsds: GSDS,
): GetSetDelete<
  { readonly [K in keyof GSDS]: GetSetDelete.Success<GSDS[K]> },
  GetSetDelete.Error<GSDS[keyof GSDS]>,
  GetSetDelete.Context<GSDS[keyof GSDS]>
> {
  return {
    get: Effect.all(
      gsds.map((gsd) => gsd.get),
      { concurrency: 'unbounded' },
    ),
    set: (values: { readonly [K in keyof GSDS]: GetSetDelete.Success<GSDS[K]> }) =>
      Effect.all(
        gsds.map((gsd, i) => gsd.set(values[i])),
        { concurrency: 'unbounded' },
      ),
    delete: Effect.map(
      Effect.all(
        gsds.map((gsd) => gsd.delete),
        { concurrency: 'unbounded' },
      ),
      Option.all,
    ),
    version: Effect.all(
      gsds.map((gsd) => gsd.version),
      { concurrency: 'unbounded' },
    ).pipe(Effect.map((versions) => versions.reduce(sum, 0))),
  } as any
}

function structGetSetDelete<GSDS extends Record<string, GetSetDelete<any, any, any>>>(
  gsds: GSDS,
): GetSetDelete<
  { readonly [K in keyof GSDS]: GetSetDelete.Success<GSDS[K]> },
  GetSetDelete.Error<GSDS[keyof GSDS]>,
  GetSetDelete.Context<GSDS[keyof GSDS]>
> {
  return {
    get: Effect.all(
      Record.map(gsds, (gsd) => gsd.get),
      { concurrency: 'unbounded' },
    ),
    set: (values: { readonly [K in keyof GSDS]: GetSetDelete.Success<GSDS[K]> }) =>
      Effect.all(
        Record.map(gsds, (gsd, i) => gsd.set(values[i])),
        { concurrency: 'unbounded' },
      ),
    delete: Effect.map(
      Effect.all(
        Record.map(gsds, (gsd) => gsd.delete),
        { concurrency: 'unbounded' },
      ),
      Option.all,
    ),
    version: Effect.all(
      Object.values(gsds).map((gsd) => gsd.version),
      { concurrency: 'unbounded' },
    ).pipe(Effect.map((versions) => versions.reduce(sum, 0))),
  } as any
}

const variance: LazyRef.Variance<any, any, any> = {
  _A: (_) => _,
  _E: (_) => _,
  _R: (_) => _,
}

abstract class VariancesImpl<A, E, R> extends EffectBase<A, E, R> {
  readonly [TypeId]: LazyRef.Variance<A, E, R> = variance
  readonly [Computed.ComputedTypeId]: Computed.Computed.Variance<A, E, R> = variance
  readonly [Subscribable.TypeId]: Subscribable.TypeId = Subscribable.TypeId
  readonly [Readable.TypeId]: Readable.TypeId = Readable.TypeId
}

class SubscriptionRefImpl<A, E, R, R2>
  extends VariancesImpl<A, E, Exclude<R, R2>>
  implements LazyRef<A, E, Exclude<R, R2>>
{
  readonly version: Effect.Effect<number>
  readonly shutdown: Effect.Effect<void, never, Exclude<R, R2>>
  readonly awaitShutdown: Effect.Effect<void, never, Exclude<R, R2>>
  readonly subscriberCount: Effect.Effect<number, never, Exclude<R, R2>>
  readonly getSetDelete: GetSetDelete<A, E, Exclude<R, R2>>
  readonly get: Effect.Effect<A, E, Exclude<R, R2>>
  readonly changes: Stream.Stream<A, E, Exclude<R, R2>>
  readonly channel: Channel<Chunk<A>, unknown, E, unknown, unknown, unknown, Exclude<R, R2>>

  constructor(readonly core: SubscriptionRefCore<A, E, R, R2>) {
    super()

    this.version = Effect.sync(() => core.deferredRef.version)
    this.shutdown = Effect.provide(interruptCore(core), core.runtime.context)
    this.awaitShutdown = Effect.provide(interruptCoreAndWait(core), core.runtime.context)
    this.subscriberCount = Effect.sync(() => MutableRef.get(core.pubsub.subscriberCount))
    this.get = this.toEffect()
    this.getSetDelete = getSetDelete(core)
    this.changes = Stream.flatten(Stream.fromPubSub(core.pubsub))
    this.channel = Stream.toChannel(this.changes)
  }

  toEffect(): Effect.Effect<A, E, Exclude<R, R2>> {
    return getOrInitializeCore(this.core, true)
  }

  runUpdates<R3, E3, B>(
    f: (ref: GetSetDelete<A, E, Exclude<R, R2>>) => Effect.Effect<B, E3, R3>,
  ): Effect.Effect<B, E3, Exclude<R, R2> | R3> {
    return this.core.semaphore.withPermits(1)(f(this.getSetDelete))
  }
}

export const fromEffect = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options?: SubscriptionRefOptions<A>,
): Effect.Effect<LazyRef<A, E>, never, R | Scope.Scope> =>
  Effect.map(makeCore(effect, options), (core) => new SubscriptionRefImpl(core))

export const fromStream = <A, E, R>(
  stream: Stream.Stream<A, E, R>,
  options?: SubscriptionRefOptions<A>,
): Effect.Effect<LazyRef<A, E>, never, R | Scope.Scope> =>
  makeDeferredRef<A, E>(getExitEquivalence<A, E>(options?.eq ?? deepEquals)).pipe(
    Effect.bindTo('deferredRef'),
    Effect.bind('core', ({ deferredRef }) => makeCore(deferredRef, options)),
    Effect.tap(({ core, deferredRef }) =>
      Effect.forkIn(
        stream.pipe(
          streamExit,
          Stream.runForEach((exit) =>
            deferredRef.done(exit) ? sendEvent(core, exit) : Effect.void,
          ),
        ),
        core.scope,
      ),
    ),
    Effect.map(({ core }) => new SubscriptionRefImpl(core)),
  )

export function make<A, E = never, R = never>(
  input: Effect.Effect<A, E, R> | Stream.Stream<A, E, R>,
  options?: SubscriptionRefOptions<A>,
): Effect.Effect<LazyRef<A, E>, never, R | Scope.Scope> {
  return Effect.isEffect(input) ? fromEffect(input, options) : fromStream(input, options)
}

export function of<A, E = never>(
  value: A,
  options?: SubscriptionRefOptions<A>,
): Effect.Effect<LazyRef<A, E>, never, Scope.Scope> {
  return make(Effect.succeed(value), options)
}

export function failCause<E, A = unknown>(
  cause: Cause.Cause<E>,
  options?: SubscriptionRefOptions<A>,
): Effect.Effect<LazyRef<A, E>, never, Scope.Scope> {
  return make<A, E, never>(Effect.failCause(cause), options)
}

export function fail<E, A = unknown>(
  error: E,
  options?: SubscriptionRefOptions<A>,
): Effect.Effect<LazyRef<A, E>, never, Scope.Scope> {
  return make<A, E, never>(Effect.fail(error), options)
}

export function get<A, E, R>(ref: LazyRef<A, E, R>): Effect.Effect<A, E, R> {
  return ref.get
}

export const set: {
  <const A>(value: A): <E, R>(ref: LazyRef<A, E, R>) => Effect.Effect<A, never, R>
  <A, E, R>(ref: LazyRef<A, E, R>, a: A): Effect.Effect<A, never, R>
} = dual(2, function set<A, E, R>(ref: LazyRef<A, E, R>, a: A): Effect.Effect<A, never, R> {
  return ref.runUpdates(({ set }) => set(a))
})

export function reset<A, E, R>(ref: LazyRef<A, E, R>): Effect.Effect<Option.Option<A>, E, R> {
  return ref.runUpdates((ref) => ref.delete)
}

export { reset as delete }

export const modify: {
  <A, const B>(
    f: (a: A) => readonly [B, A],
  ): <E, R>(ref: LazyRef<A, E, R>) => Effect.Effect<B, E, R>
  <A, E, R, const B>(ref: LazyRef<A, E, R>, f: (a: A) => readonly [B, A]): Effect.Effect<B, E, R>
} = dual(2, function modify<
  A,
  B,
  E,
  R,
>(ref: LazyRef<A, E, R>, f: (a: A) => readonly [B, A]): Effect.Effect<B, E, R> {
  return ref.runUpdates(({ set, get }) =>
    get.pipe(
      Effect.map(f),
      Effect.flatMap(([b, a]) => set(a).pipe(Effect.as(b))),
    ),
  )
})

export const modifyEffect: {
  <A, const B, E2, R2>(
    f: (a: A) => Effect.Effect<readonly [B, A], E2, R2>,
  ): <E, R>(ref: LazyRef<A, E, R>) => Effect.Effect<B, E | E2, R | R2>
  <A, E, R, const B, E2, R2>(
    ref: LazyRef<A, E, R>,
    f: (a: A) => Effect.Effect<readonly [B, A], E2, R2>,
  ): Effect.Effect<B, E | E2, R | R2>
} = dual(2, function modifyEffect<
  A,
  E,
  R,
  B,
  E2,
  R2,
>(ref: LazyRef<A, E, R>, f: (a: A) => Effect.Effect<readonly [B, A], E2, R2>): Effect.Effect<
  B,
  E | E2,
  R | R2
> {
  return ref.runUpdates(({ set, get }) =>
    get.pipe(
      Effect.flatMap(f),
      Effect.flatMap(([b, a]) => set(a).pipe(Effect.as(b))),
    ),
  )
})

export const update: {
  <const A>(f: (a: A) => A): <E, R>(ref: LazyRef<A, E, R>) => Effect.Effect<A, E, R>
  <const A, E, R>(ref: LazyRef<A, E, R>, f: (a: A) => A): Effect.Effect<A, E, R>
} = dual(2, function update<A, E, R>(ref: LazyRef<A, E, R>, f: (a: A) => A): Effect.Effect<
  A,
  E,
  R
> {
  return modify(ref, (a) => {
    const a2 = f(a)
    return [a2, a2]
  })
})

export const getAndUpdate: {
  <A, B>(f: (a: A) => A): <E, R>(ref: LazyRef<A, E, R>) => Effect.Effect<A, E, R>
  <A, E, R, B>(ref: LazyRef<A, E, R>, f: (a: A) => A): Effect.Effect<A, E, R>
} = dual(2, function getAndUpdate<A, E, R, B>(ref: LazyRef<A, E, R>, f: (a: A) => A): Effect.Effect<
  A,
  E,
  R
> {
  return modify(ref, (a) => {
    const a2 = f(a)
    return [a, a2]
  })
})

export const updateEffect: {
  <A, B, E2, R2>(
    f: (a: A) => Effect.Effect<B, E2, R2>,
  ): <E, R>(ref: LazyRef<A, E, R>) => Effect.Effect<B, E | E2, R | R2>
  <A, E, R, B, E2, R2>(
    ref: LazyRef<A, E, R>,
    f: (a: A) => Effect.Effect<B, E2, R2>,
  ): Effect.Effect<B, E | E2, R | R2>
} = dual(2, function updateEffect<
  A,
  E,
  R,
  E2,
  R2,
>(ref: LazyRef<A, E, R>, f: (a: A) => Effect.Effect<A, E2, R2>): Effect.Effect<A, E | E2, R | R2> {
  return modifyEffect(ref, (a) => Effect.map(f(a), (a2) => [a2, a2]))
})

export const getAndUpdateEffect: {
  <A, E2, R2>(
    f: (a: A) => Effect.Effect<A, E2, R2>,
  ): <E, R>(ref: LazyRef<A, E, R>) => Effect.Effect<A, E | E2, R | R2>
  <A, E, R, E2, R2>(
    ref: LazyRef<A, E, R>,
    f: (a: A) => Effect.Effect<A, E2, R2>,
  ): Effect.Effect<A, E | E2, R | R2>
} = dual(2, function getAndUpdateEffect<
  A,
  E,
  R,
  E2,
  R2,
>(ref: LazyRef<A, E, R>, f: (a: A) => Effect.Effect<A, E2, R2>): Effect.Effect<A, E | E2, R | R2> {
  return modifyEffect(ref, (a) => Effect.map(f(a), (a2) => [a, a2]))
})

export const getAndSet: {
  <A>(a: A): <E, R>(ref: LazyRef<A, E, R>) => Effect.Effect<A, E, R>
  <A, E, R>(ref: LazyRef<A, E, R>, a: A): Effect.Effect<A, E, R>
} = dual(2, function getAndSet<A, E, R>(ref: LazyRef<A, E, R>, a: A): Effect.Effect<A, E, R> {
  return getAndUpdate(ref, () => a)
})

export const mapEffect: {
  <A, B, E2, R2>(
    f: (a: A) => Effect.Effect<B, E2, R2>,
    options?: Parameters<typeof Stream.flatMap>[2],
  ): <E, R>(ref: Computed.Computed<A, E, R>) => Computed.Computed<B, E | E2, R | R2>

  <A, E, R, B, E2, R2>(
    ref: Computed.Computed<A, E, R>,
    f: (a: A) => Effect.Effect<B, E2, R2>,
    options?: Parameters<typeof Stream.flatMap>[2],
  ): Computed.Computed<B, E | E2, R | R2>
} = dual(
  (args) => Computed.isComputed(args[0]),
  function mapEffect<A, E, R, B, E2, R2>(
    ref: Computed.Computed<A, E, R>,
    f: (a: A) => Effect.Effect<B, E2, R2>,
    options?: Parameters<typeof Stream.flatMap>[2],
  ): Computed.Computed<B, E | E2, R | R2> {
    return Computed.makeComputed(
      Effect.flatMap(ref, f),
      Stream.flatMap(ref.changes, f, options),
      ref.version,
    )
  },
)

export const map: {
  <A, B>(f: (a: A) => B): <E, R>(ref: Computed.Computed<A, E, R>) => Computed.Computed<B, E, R>
  <A, E, R, B>(ref: Computed.Computed<A, E, R>, f: (a: A) => B): Computed.Computed<B, E, R>
} = dual(2, function map<
  A,
  E,
  R,
  B,
>(ref: Computed.Computed<A, E, R>, f: (a: A) => B): Computed.Computed<B, E, R> {
  return Computed.makeComputed(Effect.map(ref, f), Stream.map(ref.changes, f), ref.version)
})

export const proxy = <A extends Readonly<Record<PropertyKey, any>> | ReadonlyArray<any>, E, R>(
  source: Computed.Computed<A, E, R>,
): {
  readonly [K in keyof A]: Computed.Computed<A[K], E, R>
} => {
  const target: any = {}
  return new Proxy(target, {
    get(self, prop) {
      return (self[prop] ??= map(source, (a) => a[prop as keyof A]))
    },
  })
}

export function isSubscriptionRef<A = unknown, E = unknown, R = unknown>(
  value: unknown,
): value is LazyRef<A, E, R> {
  return hasProperty(value, TypeId)
}

const sum = (a: number, b: number) => a + b

class TupleImpl<Refs extends ReadonlyArray<LazyRef<any, any, any>>>
  extends VariancesImpl<
    { [K in keyof Refs]: LazyRef.Success<Refs[K]> },
    LazyRef.Error<Refs[keyof Refs]>,
    LazyRef.Context<Refs[keyof Refs]>
  >
  implements
    LazyRef<
      { [K in keyof Refs]: LazyRef.Success<Refs[K]> },
      LazyRef.Error<Refs[keyof Refs]>,
      LazyRef.Context<Refs[keyof Refs]>
    >
{
  readonly [TypeId]: LazyRef.Variance<
    { [K in keyof Refs]: LazyRef.Success<Refs[K]> },
    LazyRef.Error<Refs[keyof Refs]>,
    LazyRef.Context<Refs[keyof Refs]>
  > = variance
  readonly [Computed.ComputedTypeId]: Computed.Computed.Variance<
    { [K in keyof Refs]: LazyRef.Success<Refs[K]> },
    LazyRef.Error<Refs[keyof Refs]>,
    LazyRef.Context<Refs[keyof Refs]>
  > = variance

  readonly shutdown: Effect.Effect<void, never, LazyRef.Context<Refs[keyof Refs]>>
  readonly awaitShutdown: Effect.Effect<void, never, LazyRef.Context<Refs[keyof Refs]>>
  readonly subscriberCount: Effect.Effect<number, never, LazyRef.Context<Refs[keyof Refs]>>
  readonly version: Effect.Effect<number, never, LazyRef.Context<Refs[keyof Refs]>>
  readonly changes: Stream.Stream<
    { readonly [K in keyof Refs]: LazyRef.Success<Refs[K]> },
    LazyRef.Error<Refs[keyof Refs]>,
    LazyRef.Context<Refs[keyof Refs]>
  >

  constructor(readonly refs: Refs) {
    super()

    this.subscriberCount = Effect.all(
      refs.map((ref) => ref.subscriberCount),
      { concurrency: 'unbounded' },
    ).pipe(Effect.map((counts) => counts.reduce(sum, 0)))
    this.shutdown = Effect.all(
      refs.map((ref) => ref.shutdown),
      { concurrency: 'unbounded' },
    )
    this.awaitShutdown = Effect.all(
      refs.map((ref) => ref.awaitShutdown),
      { concurrency: 'unbounded' },
    )

    this.version = Effect.all(
      refs.map((ref) => ref.version),
      { concurrency: 'unbounded' },
    ).pipe(Effect.map((versions) => versions.reduce(sum, 0)))

    this.changes = Stream.zipLatestAll(...refs.map((ref) => ref.changes)) as any
  }

  get get(): Effect.Effect<
    { readonly [K in keyof Refs]: LazyRef.Success<Refs[K]> },
    LazyRef.Error<Refs[keyof Refs]>,
    LazyRef.Context<Refs[keyof Refs]>
  > {
    return this
  }

  toEffect(): Effect.Effect<
    { readonly [K in keyof Refs]: LazyRef.Success<Refs[K]> },
    LazyRef.Error<Refs[keyof Refs]>,
    LazyRef.Context<Refs[keyof Refs]>
  > {
    return Effect.all(this.refs, { concurrency: 'unbounded' }) as Effect.Effect<
      { readonly [K in keyof Refs]: LazyRef.Success<Refs[K]> },
      LazyRef.Error<Refs[keyof Refs]>,
      LazyRef.Context<Refs[keyof Refs]>
    >
  }

  runUpdates<B, E3, R3>(
    f: (
      getSetDelete: GetSetDelete<
        { readonly [K in keyof Refs]: LazyRef.Success<Refs[K]> },
        LazyRef.Error<Refs[keyof Refs]>,
        LazyRef.Context<Refs[keyof Refs]>
      >,
    ) => Effect.Effect<B, E3, R3>,
  ): Effect.Effect<B, E3, R3> {
    return tupleRunUpdates(this.refs, (gsds) => f(tupleGetSetDelete(gsds) as any))
  }
}

export function tuple<const Refs extends ReadonlyArray<LazyRef<any, any, any>>>(
  ...refs: Refs
): LazyRef<
  { readonly [K in keyof Refs]: LazyRef.Success<Refs[K]> },
  LazyRef.Error<Refs[keyof Refs]>,
  LazyRef.Context<Refs[keyof Refs]>
>

export function tuple<
  const Refs extends ReadonlyArray<LazyRef<any, any, any> | Computed.Computed<any, any, any>>,
>(
  ...refs: Refs
): Computed.Computed<
  { readonly [K in keyof Refs]: Computed.Computed.Success<Refs[K]> },
  LazyRef.Error<Refs[keyof Refs]>,
  LazyRef.Context<Refs[keyof Refs]>
>

export function tuple<const Refs extends ReadonlyArray<LazyRef<any, any, any>>>(...refs: Refs) {
  const hasNonSubscriptionRefs = refs.some((ref) => !isSubscriptionRef(ref))
  if (hasNonSubscriptionRefs) {
    return Computed.fromVersioned(Versioned.tuple(...refs))
  }

  return new TupleImpl(refs)
}

export function struct<const Refs extends Readonly<Record<string, LazyRef<any, any, any>>>>(
  refs: Refs,
): LazyRef<
  { readonly [K in keyof Refs]: LazyRef.Success<Refs[K]> },
  LazyRef.Error<Refs[keyof Refs]>,
  LazyRef.Context<Refs[keyof Refs]>
>

export function struct<
  const Refs extends Readonly<
    Record<string, LazyRef<any, any, any> | Computed.Computed<any, any, any>>
  >,
>(
  refs: Refs,
): Computed.Computed<
  { readonly [K in keyof Refs]: Computed.Computed.Success<Refs[K]> },
  LazyRef.Error<Refs[keyof Refs]>,
  LazyRef.Context<Refs[keyof Refs]>
>

export function struct<const Refs extends Readonly<Record<string, LazyRef<any, any, any>>>>(
  refs: Refs,
) {
  const hasNonSubscriptionRefs = Object.values(refs).some((ref) => !isSubscriptionRef(ref))
  if (hasNonSubscriptionRefs) {
    return Computed.fromVersioned(Versioned.struct(refs))
  }

  return new StructImpl(refs)
}

class StructImpl<Refs extends Readonly<Record<string, LazyRef<any, any, any>>>>
  extends VariancesImpl<
    { readonly [K in keyof Refs]: LazyRef.Success<Refs[K]> },
    LazyRef.Error<Refs[keyof Refs]>,
    LazyRef.Context<Refs[keyof Refs]>
  >
  implements
    LazyRef<
      { readonly [K in keyof Refs]: LazyRef.Success<Refs[K]> },
      LazyRef.Error<Refs[keyof Refs]>,
      LazyRef.Context<Refs[keyof Refs]>
    >
{
  readonly shutdown: Effect.Effect<void, never, LazyRef.Context<Refs[keyof Refs]>>
  readonly awaitShutdown: Effect.Effect<void, never, LazyRef.Context<Refs[keyof Refs]>>
  readonly subscriberCount: Effect.Effect<number, never, LazyRef.Context<Refs[keyof Refs]>>
  readonly version: Effect.Effect<number, never, LazyRef.Context<Refs[keyof Refs]>>
  readonly changes: Stream.Stream<
    { readonly [K in keyof Refs]: LazyRef.Success<Refs[K]> },
    LazyRef.Error<Refs[keyof Refs]>,
    LazyRef.Context<Refs[keyof Refs]>
  >

  constructor(readonly refs: Refs) {
    super()

    const refValues = Object.values(refs)

    this.shutdown = Effect.all(
      refValues.map((ref) => ref.shutdown),
      { concurrency: 'unbounded' },
    )

    this.awaitShutdown = Effect.all(
      refValues.map((ref) => ref.awaitShutdown),
      { concurrency: 'unbounded' },
    )

    this.subscriberCount = Effect.all(
      refValues.map((ref) => ref.subscriberCount),
      { concurrency: 'unbounded' },
    ).pipe(Effect.map((counts) => counts.reduce(sum, 0)))

    this.version = Effect.all(
      refValues.map((ref) => ref.version),
      { concurrency: 'unbounded' },
    ).pipe(Effect.map((versions) => versions.reduce(sum, 0)))

    this.changes = Stream.zipLatestAll(...refValues.map((ref) => ref.changes)) as any
  }

  get get(): Effect.Effect<
    { readonly [K in keyof Refs]: LazyRef.Success<Refs[K]> },
    LazyRef.Error<Refs[keyof Refs]>,
    LazyRef.Context<Refs[keyof Refs]>
  > {
    return this
  }

  toEffect(): Effect.Effect<
    { readonly [K in keyof Refs]: LazyRef.Success<Refs[K]> },
    LazyRef.Error<Refs[keyof Refs]>,
    LazyRef.Context<Refs[keyof Refs]>
  > {
    return Effect.all(this.refs, { concurrency: 'unbounded' }) as any
  }

  runUpdates<B, E3, R3>(
    f: (
      getSetDelete: GetSetDelete<
        { readonly [K in keyof Refs]: LazyRef.Success<Refs[K]> },
        LazyRef.Error<Refs[keyof Refs]>,
        LazyRef.Context<Refs[keyof Refs]>
      >,
    ) => Effect.Effect<B, E3, R3>,
  ): Effect.Effect<B, E3, R3> {
    return structRunUpdates(this.refs, (gsds) => f(structGetSetDelete(gsds) as any))
  }
}

function tupleRunUpdates<Refs extends ReadonlyArray<LazyRef<any, any, any>>, B, E2, R2>(
  refs: Refs,
  accumulated: (
    gsds: {
      readonly [K in keyof Refs]: GetSetDelete<
        Refs[K],
        LazyRef.Error<Refs[K]>,
        LazyRef.Context<Refs[K]>
      >
    },
  ) => Effect.Effect<B, E2, R2>,
): Effect.Effect<B, E2, R2> {
  if (refs.length === 0) {
    return accumulated([] as any)
  }

  const [first, ...rest] = refs
  return first.runUpdates((firstGsd) =>
    tupleRunUpdates(rest, (restGsds) => accumulated([firstGsd, ...restGsds] as any)),
  )
}

function structRunUpdates<Refs extends Readonly<Record<string, LazyRef<any, any, any>>>, B, E2, R2>(
  refs: Refs,
  accumulated: (
    gsds: {
      readonly [K in keyof Refs]: GetSetDelete<
        Refs[K],
        LazyRef.Error<Refs[K]>,
        LazyRef.Context<Refs[K]>
      >
    },
  ) => Effect.Effect<B, E2, R2>,
) {
  const entries = Object.entries(refs)
  return tupleRunUpdates(
    entries.map(([_, ref]) => ref),
    (gsds) => accumulated(Object.fromEntries(entries.map(([key], i) => [key, gsds[i]])) as any),
  )
}

export interface Tagged<Self, Id extends string, A, E = never> extends LazyRef<A, E, Self> {
  readonly id: Id
  readonly tag: Context.Tag<Self, LazyRef<A, E>>

  readonly of: (value: A) => Layer.Layer<Self>

  readonly make: <R>(
    fxOrEffect: Stream.Stream<A, E, R | Scope.Scope> | Effect.Effect<A, E, R | Scope.Scope>,
    options?: SubscriptionRefOptions<A> & { readonly drop?: number; readonly take?: number },
  ) => Layer.Layer<Self, never, R>

  readonly layer: <E2, R2>(
    make: Effect.Effect<LazyRef<A, E>, E2, R2 | Scope.Scope>,
  ) => Layer.Layer<Self, E2, R2>
}

export interface TaggedClass<Self, Id extends string, A, E> extends Tagged<Self, Id, A, E> {
  new (): Tagged<Self, Id, A, E>
}

class TaggedImpl<Self, Id extends string, A, E>
  extends VariancesImpl<A, E, Self>
  implements Tagged<Self, Id, A, E>
{
  readonly tag: Context.Tag<Self, LazyRef<A, E>>
  readonly shutdown: Effect.Effect<void, never, Self>
  readonly awaitShutdown: Effect.Effect<void, never, Self>
  readonly subscriberCount: Effect.Effect<number, never, Self>
  readonly version: Effect.Effect<number, never, Self>
  readonly changes: Stream.Stream<A, E, Self>
  readonly runUpdates: <B, E2, R2>(
    f: (getSetDelete: GetSetDelete<A, E, Self>) => Effect.Effect<B, E2, R2>,
  ) => Effect.Effect<B, E2, Self | R2>

  constructor(readonly id: Id) {
    super()

    this.id = id
    this.tag = Context.GenericTag<Self, LazyRef<A, E>>(id)
    this.shutdown = Effect.flatMap(this.tag, (ref) => ref.shutdown)
    this.awaitShutdown = Effect.flatMap(this.tag, (ref) => ref.awaitShutdown)
    this.subscriberCount = Effect.flatMap(this.tag, (ref) => ref.subscriberCount)
    this.version = Effect.flatMap(this.tag, (ref) => ref.version)
    this.changes = Stream.unwrap(Effect.map(this.tag, (ref) => ref.changes))
    this.runUpdates = <B, E2, R2>(
      f: (getSetDelete: GetSetDelete<A, E, Self>) => Effect.Effect<B, E2, R2>,
    ) => Effect.flatMap(this.tag, (ref) => ref.runUpdates(f))
  }

  get get(): Effect.Effect<A, E, Self> {
    return this
  }

  toEffect(): Effect.Effect<A, E, Self> {
    return Effect.flatten(this.tag)
  }

  of(value: A): Layer.Layer<Self> {
    return this.make(Effect.succeed(value))
  }

  make<R>(
    fxOrEffect: Stream.Stream<A, E, R | Scope.Scope> | Effect.Effect<A, E, R | Scope.Scope>,
    options?: SubscriptionRefOptions<A> & { readonly drop?: number; readonly take?: number },
  ) {
    return Layer.scoped(
      this.tag,
      make(fxOrEffect, options).pipe(
        Effect.map((x) => (options?.drop ? drop(x, options.drop) : x)),
        Effect.map((x) => (options?.take ? take(x, options.take) : x)),
      ),
    )
  }

  layer<E2, R2>(make: Effect.Effect<LazyRef<A, E>, E2, R2 | Scope.Scope>) {
    return Layer.scoped(this.tag, make)
  }
}

export function Tag<Id extends string>(id: Id) {
  return <Self, A, E = never>(): TaggedClass<Self, Id, A, E> => {
    const base = new TaggedImpl(id)

    function klass() {
      return base
    }

    Object.setPrototypeOf(klass, base)

    return klass as any
  }
}

class FromTag<Id, S, A, E, R> extends VariancesImpl<A, E, Id | R> implements LazyRef<A, E, Id | R> {
  readonly shutdown: Effect.Effect<void, never, Id | R>
  readonly awaitShutdown: Effect.Effect<void, never, Id | R>
  readonly subscriberCount: Effect.Effect<number, never, Id | R>
  readonly version: Effect.Effect<number, never, Id | R>
  readonly changes: Stream.Stream<A, E, Id | R>
  readonly runUpdates: <B, E2, R2>(
    f: (getSetDelete: GetSetDelete<A, E, Id | R>) => Effect.Effect<B, E2, R2>,
  ) => Effect.Effect<B, E2, Id | R | R2>
  readonly channel: Channel<Chunk<A>, unknown, E, unknown, unknown, unknown, Id | R>

  constructor(
    readonly tag: Context.Tag<Id, S>,
    readonly f: (s: S) => LazyRef<A, E, R>,
  ) {
    super()

    this.shutdown = Effect.flatMap(this.tag, (s) => this.f(s).shutdown)
    this.awaitShutdown = Effect.flatMap(this.tag, (s) => this.f(s).awaitShutdown)
    this.subscriberCount = Effect.flatMap(this.tag, (s) => this.f(s).subscriberCount)
    this.version = Effect.flatMap(this.tag, (s) => this.f(s).version)
    this.changes = Stream.unwrap(Effect.map(this.tag, (s) => this.f(s).changes))
    this.runUpdates = <B, E2, R2>(
      f: (getSetDelete: GetSetDelete<A, E, Id | R>) => Effect.Effect<B, E2, R2>,
    ) => Effect.flatMap(this.tag, (s) => this.f(s).runUpdates(f))
    this.channel = Stream.toChannel(this.changes)
  }

  toEffect(): Effect.Effect<A, E, Id | R> {
    return Effect.flatMap(this.tag, this.f)
  }

  get get(): Effect.Effect<A, E, Id | R> {
    return this
  }
}

export function fromTag<Id, S, A, E, R>(
  tag: Context.Tag<Id, S>,
  f: (s: S) => LazyRef<A, E, R>,
): LazyRef<A, E, Id | R> {
  return new FromTag(tag, f)
}

export const when: {
  <B, C>(matchers: {
    onFalse: () => B
    onTrue: () => C
  }): <E, R>(ref: Computed.Computed<boolean, E, R>) => Computed.Computed<B | C, E, R>

  <E, R, B, C>(
    ref: Computed.Computed<boolean, E, R>,
    matchers: {
      onFalse: () => B
      onTrue: () => C
    },
  ): Computed.Computed<B | C, E, R>
} = dual(
  2,
  function when<E, R, B, C>(
    ref: Computed.Computed<boolean, E, R>,
    matchers: {
      onFalse: () => B
      onTrue: () => C
    },
  ) {
    return Computed.makeComputed(
      Effect.map(ref, Boolean.match(matchers)),
      Stream.map(ref.changes, Boolean.match(matchers)),
      ref.version,
    )
  },
)

class SubscriptionRefProvide<A, E, R, S, R2>
  extends VariancesImpl<A, E, Exclude<R, S> | R2>
  implements LazyRef<A, E, Exclude<R, S> | R2>
{
  readonly shutdown: Effect.Effect<void, never, Exclude<R, S> | R2>
  readonly awaitShutdown: Effect.Effect<void, never, Exclude<R, S> | R2>
  readonly subscriberCount: Effect.Effect<number, never, Exclude<R, S> | R2>
  readonly version: Effect.Effect<number, never, Exclude<R, S> | R2>
  readonly changes: Stream.Stream<A, E, Exclude<R, S> | R2>
  readonly runUpdates: <B, E3, R3>(
    f: (getSetDelete: GetSetDelete<A, E, Exclude<R, S> | R2>) => Effect.Effect<B, E3, R3>,
  ) => Effect.Effect<B, E3, Exclude<R, S> | R2 | R3>
  readonly channel: Channel<Chunk<A>, unknown, E, unknown, unknown, unknown, Exclude<R, S> | R2>

  constructor(
    readonly ref: LazyRef<A, E, R>,
    readonly provide: Provide.Provide<S, never, R2>,
  ) {
    super()

    this.shutdown = Provide.provideToEffect(ref.shutdown, provide)
    this.awaitShutdown = Provide.provideToEffect(ref.awaitShutdown, provide)
    this.subscriberCount = Provide.provideToEffect(ref.subscriberCount, provide)
    this.version = Provide.provideToEffect(ref.version, provide)
    this.changes = Provide.provideToStream(ref.changes, provide)
    this.runUpdates = <B, E3, R3>(
      f: (getSetDelete: GetSetDelete<A, E, Exclude<R, S> | R2>) => Effect.Effect<B, E3, R3>,
    ) =>
      Provide.provideToEffect(
        ref.runUpdates((gsd) => f(gsd as any)),
        provide,
      ) as any
    this.channel = Stream.toChannel(this.changes)
  }

  toEffect(): Effect.Effect<A, E, Exclude<R, S> | R2> {
    return Provide.provideToEffect(this.ref, this.provide)
  }

  get get(): Effect.Effect<A, E, Exclude<R, S> | R2> {
    return this
  }
}

function provide_<A, E, R, S, R2>(
  ref: LazyRef<A, E, R>,
  provide: Provide.Provide<S, never, R2>,
): LazyRef<A, E, Exclude<R, S> | R2> {
  if (ref instanceof SubscriptionRefProvide) {
    return new SubscriptionRefProvide(ref.ref, Provide.merge(ref.provide, provide))
  }

  return new SubscriptionRefProvide(ref, provide)
}

export const provide: {
  <S, R2 = never>(
    contextOrLayerOrRuntime: Context.Context<S> | Layer.Layer<S, never, R2> | Runtime.Runtime<S>,
  ): {
    <A, E, R>(ref: LazyRef<A, E, R>): LazyRef<A, E, Exclude<R, S> | R2>
    <A, E, R>(ref: Computed.Computed<A, E, R>): Computed.Computed<A, E, Exclude<R, S> | R2>
  }

  <A, E, R, S, R2 = never>(
    ref: LazyRef<A, E, R>,
    contextOrLayerOrRuntime: Context.Context<S> | Layer.Layer<S, never, R2> | Runtime.Runtime<S>,
  ): LazyRef<A, E, Exclude<R, S> | R2>

  <A, E, R, S, R2 = never>(
    ref: Computed.Computed<A, E, R>,
    contextOrLayerOrRuntime: Context.Context<S> | Layer.Layer<S, never, R2> | Runtime.Runtime<S>,
  ): LazyRef<A, E, Exclude<R, S> | R2>
} = dual(2, function provide<
  A,
  E,
  R,
  S,
  R2 = never,
>(ref: LazyRef<A, E, R>, contextOrLayerOrRuntime: Context.Context<S> | Layer.Layer<S, never, R2> | Runtime.Runtime<S>) {
  const provide: Provide.Provide<S, never, R2> = Context.isContext(contextOrLayerOrRuntime)
    ? Provide.ProvideContext(contextOrLayerOrRuntime)
    : Layer.isLayer(contextOrLayerOrRuntime)
      ? Provide.ProvideLayer(contextOrLayerOrRuntime as Layer.Layer<S, never, R2>)
      : Provide.ProvideRuntime(contextOrLayerOrRuntime as Runtime.Runtime<S>)

  if (isSubscriptionRef(ref)) {
    return provide_(ref, provide)
  }

  return Computed.makeComputed(
    Provide.provideToEffect(ref, provide),
    Provide.provideToStream(ref, provide),
    Provide.provideToEffect(ref.version, provide),
  )
})

export const provideService: {
  <Id, S>(
    tag: Context.Tag<Id, S>,
    services: S,
  ): {
    <A, E, R>(ref: LazyRef<A, E, R>): LazyRef<A, E, Exclude<R, Id>>
    <A, E, R>(ref: Computed.Computed<A, E, R>): Computed.Computed<A, E, Exclude<R, Id>>
  }

  <A, E, R, Id, S>(
    ref: LazyRef<A, E, R>,
    tag: Context.Tag<Id, S>,
    services: S,
  ): LazyRef<A, E, Exclude<R, Id>>

  <A, E, R, Id, S>(
    ref: Computed.Computed<A, E, R>,
    tag: Context.Tag<Id, S>,
    services: S,
  ): Computed.Computed<A, E, Exclude<R, Id>>
} = dual(3, function provideService<
  A,
  E,
  R,
  Id,
  S,
>(ref: LazyRef<A, E, R>, tag: Context.Tag<Id, S>, services: S): LazyRef<A, E, Exclude<R, Id>> {
  return provide_(ref, Provide.ProvideService(tag, services))
})

export const provideServiceEffect: {
  <Id, S, R2>(
    tag: Context.Tag<Id, S>,
    service: Effect.Effect<S, never, R2>,
  ): {
    <A, E, R>(ref: LazyRef<A, E, R>): LazyRef<A, E, Exclude<R, Id> | R2>
    <A, E, R>(ref: Computed.Computed<A, E, R>): Computed.Computed<A, E, Exclude<R, Id> | R2>
  }

  <A, E, R, Id, S, R2>(
    ref: LazyRef<A, E, R>,
    tag: Context.Tag<Id, S>,
    service: Effect.Effect<S, never, R2>,
  ): LazyRef<A, E, Exclude<R, Id> | R2>

  <A, E, R, Id, S, R2>(
    ref: Computed.Computed<A, E, R>,
    tag: Context.Tag<Id, S>,
    service: Effect.Effect<S, never, R2>,
  ): Computed.Computed<A, E, Exclude<R, Id> | R2>
} = dual(3, function provideServiceEffect<
  A,
  E,
  R,
  Id,
  S,
  R2,
>(ref: LazyRef<A, E, R>, tag: Context.Tag<Id, S>, service: Effect.Effect<S, never, R2>): LazyRef<
  A,
  E,
  Exclude<R, Id> | R2
> {
  return provide_(ref, Provide.ProvideServiceEffect(tag, service))
})

class SimpleTransform<A, E, R, R2>
  extends VariancesImpl<A, E, R | R2>
  implements LazyRef<A, E, R | R2>
{
  readonly shutdown: Effect.Effect<void, never, R | R2>
  readonly awaitShutdown: Effect.Effect<void, never, R | R2>
  readonly subscriberCount: Effect.Effect<number, never, R | R2>
  readonly version: Effect.Effect<number, never, R | R2>
  readonly changes: Stream.Stream<A, E, R | R2>
  readonly runUpdates: <B2, E3, R3>(
    f: (getSetDelete: GetSetDelete<A, E, R>) => Effect.Effect<B2, E3, R3>,
  ) => Effect.Effect<B2, E3, R | R2 | R3>
  readonly channel: Channel<Chunk<A>, unknown, E, unknown, unknown, unknown, R | R2>

  constructor(
    readonly ref: LazyRef<A, E, R>,
    readonly transformEffect: (effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R2>,
    readonly transformStream: (stream: Stream.Stream<A, E, R>) => Stream.Stream<A, E, R2>,
  ) {
    super()

    this.shutdown = ref.shutdown
    this.awaitShutdown = ref.awaitShutdown
    this.subscriberCount = ref.subscriberCount
    this.version = ref.version
    this.changes = transformStream(ref.changes)
    this.runUpdates = ref.runUpdates
    this.channel = Stream.toChannel(this.changes)
  }

  toEffect(): Effect.Effect<A, E, R | R2> {
    return this.transformEffect(this.ref)
  }

  get get(): Effect.Effect<A, E, R | R2> {
    return this
  }
}

export const withSpan: {
  (
    name: string,
    options?: {
      readonly attributes?: Record<string, unknown>
      readonly links?: ReadonlyArray<Tracer.SpanLink>
      readonly parent?: Tracer.ParentSpan
      readonly root?: boolean
      readonly context?: Context.Context<never>
    },
  ): <A, E, R>(self: LazyRef<A, E, R>) => LazyRef<A, E, R>

  <A, E, R>(
    self: LazyRef<A, E, R>,
    name: string,
    options?: {
      readonly attributes?: Record<string, unknown>
      readonly links?: ReadonlyArray<Tracer.SpanLink>
      readonly parent?: Tracer.ParentSpan
      readonly root?: boolean
      readonly context?: Context.Context<never>
    },
  ): LazyRef<A, E, R>
} = dual(
  (args) => isSubscriptionRef(args[0]),
  (ref, name, options) =>
    new SimpleTransform(ref, Effect.withSpan(name, options), Stream.withSpan(name, options)),
)

export const drop: {
  (
    n: number,
  ): {
    <A, E, R>(ref: LazyRef<A, E, R>): LazyRef<A, E, R>
    <A, E, R>(ref: Computed.Computed<A, E, R>): Computed.Computed<A, E, R>
  }

  <A, E, R>(ref: LazyRef<A, E, R>, n: number): LazyRef<A, E, R>
  <A, E, R>(ref: Computed.Computed<A, E, R>, n: number): Computed.Computed<A, E, R>
} = dual(2, function drop<A, E, R>(ref: LazyRef<A, E, R>, n: number) {
  return isSubscriptionRef(ref)
    ? new SimpleTransform(ref, identity, Stream.drop(n))
    : Computed.makeComputed(ref.get, Stream.drop(ref.changes, n), ref.version)
})

export const take: {
  (
    n: number,
  ): {
    <A, E, R>(ref: LazyRef<A, E, R>): LazyRef<A, E, R>
    <A, E, R>(ref: Computed.Computed<A, E, R>): Computed.Computed<A, E, R>
  }

  <A, E, R>(ref: LazyRef<A, E, R>, n: number): LazyRef<A, E, R>
  <A, E, R>(ref: Computed.Computed<A, E, R>, n: number): Computed.Computed<A, E, R>
} = dual(2, function take<A, E, R>(ref: LazyRef<A, E, R> | Computed.Computed<A, E, R>, n: number) {
  return isSubscriptionRef<A, E, R>(ref)
    ? new SimpleTransform(ref, identity, Stream.take(n))
    : Computed.makeComputed(ref.get, Stream.take(ref.changes, n), ref.version)
})
