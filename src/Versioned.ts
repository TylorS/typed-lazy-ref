import { Effect, Readable, Record, Stream, Subscribable } from 'effect'
import { EffectBase, MulticastEffect } from './internal.js'

export interface Versioned<A, E, R>
  extends Effect.Effect<A, E, R>,
    Subscribable.Subscribable<A, E, R> {
  readonly version: Effect.Effect<number, never, R>
}

export declare namespace Versioned {
  export type Success<T> = T extends Versioned<infer A, infer E, infer R> ? A : never
  export type Error<T> = T extends Versioned<infer A, infer E, infer R> ? E : never
  export type Context<T> = T extends Versioned<infer A, infer E, infer R> ? R : never
}

export function make<A, E, R>(
  get: Effect.Effect<A, E, R>,
  changes: Stream.Stream<A, E, R>,
  version: Effect.Effect<number, never, R>,
): Versioned<A, E, R> {
  return new VersionedImpl(get, changes, version)
}

/**
 * @internal
 */
export class VersionedImpl<A, E, R> extends EffectBase<A, E, R> implements Versioned<A, E, R> {
  readonly [Subscribable.TypeId]: typeof Subscribable.TypeId = Subscribable.TypeId
  readonly [Readable.TypeId]: typeof Readable.TypeId = Readable.TypeId

  readonly get: Effect.Effect<A, E, R>
  
  constructor(
    get: Effect.Effect<A, E, R>,
    readonly changes: Stream.Stream<A, E, R>,
    readonly version: Effect.Effect<number, never, R>,
  ) {
    super()
    this.get = new MulticastEffect(get)
  }

  toEffect(): Effect.Effect<A, E, R> {
    return this.get
  }
}

export function tuple<Versioneds extends ReadonlyArray<Versioned<any, any, any>>>(
  ...versioneds: Versioneds
): Versioned<
  { readonly [K in keyof Versioneds]: Versioned.Success<Versioneds[K]> },
  Versioned.Error<Versioneds[keyof Versioneds]>,
  Versioned.Context<Versioneds[keyof Versioneds]>
> {
  return new TupleImpl(versioneds)
}

class TupleImpl<Versioneds extends ReadonlyArray<Versioned<any, any, any>>>
  extends EffectBase<
    { readonly [K in keyof Versioneds]: Versioned.Success<Versioneds[K]> },
    Versioned.Error<Versioneds[keyof Versioneds]>,
    Versioned.Context<Versioneds[keyof Versioneds]>
  >
  implements
    Versioned<
      { readonly [K in keyof Versioneds]: Versioned.Success<Versioneds[K]> },
      Versioned.Error<Versioneds[keyof Versioneds]>,
      Versioned.Context<Versioneds[keyof Versioneds]>
    >
{
  readonly [Subscribable.TypeId]: typeof Subscribable.TypeId = Subscribable.TypeId
  readonly [Readable.TypeId]: typeof Readable.TypeId = Readable.TypeId

  readonly version: Effect.Effect<number, never, Versioned.Context<Versioneds[keyof Versioneds]>>
  readonly changes: Stream.Stream<
    { readonly [K in keyof Versioneds]: Versioned.Success<Versioneds[K]> },
    Versioned.Error<Versioneds[keyof Versioneds]>,
    Versioned.Context<Versioneds[keyof Versioneds]>
  >

  constructor(readonly versioneds: Versioneds) {
    super()

    this.version = Effect.all(versioneds, { concurrency: 'unbounded' }).pipe(
      (_) => _ as Effect.Effect<number[], never, Versioned.Context<Versioneds[keyof Versioneds]>>,
      Effect.map((versions) => versions.reduce((acc, version) => acc + version, 0)),
    )

    this.changes = Stream.zipLatestAll(...versioneds.map((v) => v.changes)) as Stream.Stream<
      { readonly [K in keyof Versioneds]: Versioned.Success<Versioneds[K]> },
      Versioned.Error<Versioneds[keyof Versioneds]>,
      Versioned.Context<Versioneds[keyof Versioneds]>
    >
  }

  get get(): Effect.Effect<
    { readonly [K in keyof Versioneds]: Versioned.Success<Versioneds[K]> },
    Versioned.Error<Versioneds[keyof Versioneds]>,
    Versioned.Context<Versioneds[keyof Versioneds]>
  > {
    return this
  }

  toEffect(): Effect.Effect<
    { readonly [K in keyof Versioneds]: Versioned.Success<Versioneds[K]> },
    Versioned.Error<Versioneds[keyof Versioneds]>,
    Versioned.Context<Versioneds[keyof Versioneds]>
  > {
    return Effect.all(this.versioneds, {
      concurrency: 'unbounded',
    }) as Effect.Effect<
      { readonly [K in keyof Versioneds]: Versioned.Success<Versioneds[K]> },
      Versioned.Error<Versioneds[keyof Versioneds]>,
      Versioned.Context<Versioneds[keyof Versioneds]>
    >
  }
}

export function struct<Versioneds extends Readonly<Record<string, Versioned<any, any, any>>>>(
  refs: Versioneds,
): Versioned<
  { readonly [K in keyof Versioneds]: Versioned.Success<Versioneds[K]> },
  Versioned.Error<Versioneds[keyof Versioneds]>,
  Versioned.Context<Versioneds[keyof Versioneds]>
> {
  return new StructImpl(refs)
}

class StructImpl<Versioneds extends Readonly<Record<string, Versioned<any, any, any>>>>
  extends EffectBase<
    { readonly [K in keyof Versioneds]: Versioned.Success<Versioneds[K]> },
    Versioned.Error<Versioneds[keyof Versioneds]>,
    Versioned.Context<Versioneds[keyof Versioneds]>
  >
  implements
    Versioned<
      { readonly [K in keyof Versioneds]: Versioned.Success<Versioneds[K]> },
      Versioned.Error<Versioneds[keyof Versioneds]>,
      Versioned.Context<Versioneds[keyof Versioneds]>
    >
{
  readonly [Subscribable.TypeId]: typeof Subscribable.TypeId = Subscribable.TypeId
  readonly [Readable.TypeId]: typeof Readable.TypeId = Readable.TypeId

  readonly version: Effect.Effect<number, never, Versioned.Context<Versioneds[keyof Versioneds]>>
  readonly changes: Stream.Stream<
    { readonly [K in keyof Versioneds]: Versioned.Success<Versioneds[K]> },
    Versioned.Error<Versioneds[keyof Versioneds]>,
    Versioned.Context<Versioneds[keyof Versioneds]>
  >

  constructor(readonly versioneds: Versioneds) {
    super()

    this.version = Effect.all(Object.values(versioneds), { concurrency: 'unbounded' }).pipe(
      (_) => _ as Effect.Effect<number[], never, Versioned.Context<Versioneds[keyof Versioneds]>>,
      Effect.map((versions) => versions.reduce((acc, version) => acc + version, 0)),
    )

    this.changes = Stream.map(
      Stream.zipLatestAll(
        ...Object.entries(versioneds).map(([key, { changes }]) =>
          changes.pipe(Stream.map((value) => [key, value] as const)),
        ),
      ),
      Record.fromEntries,
    ) as Stream.Stream<
      { readonly [K in keyof Versioneds]: Versioned.Success<Versioneds[K]> },
      Versioned.Error<Versioneds[keyof Versioneds]>,
      Versioned.Context<Versioneds[keyof Versioneds]>
    >
  }

  get get(): Effect.Effect<
    { readonly [K in keyof Versioneds]: Versioned.Success<Versioneds[K]> },
    Versioned.Error<Versioneds[keyof Versioneds]>,
    Versioned.Context<Versioneds[keyof Versioneds]>
  > {
    return this
  }

  toEffect(): Effect.Effect<
    { readonly [K in keyof Versioneds]: Versioned.Success<Versioneds[K]> },
    Versioned.Error<Versioneds[keyof Versioneds]>,
    Versioned.Context<Versioneds[keyof Versioneds]>
  > {
    return Effect.all(this.versioneds, { concurrency: 'unbounded' }) as Effect.Effect<
      { readonly [K in keyof Versioneds]: Versioned.Success<Versioneds[K]> },
      Versioned.Error<Versioneds[keyof Versioneds]>,
      Versioned.Context<Versioneds[keyof Versioneds]>
    >
  }
}
