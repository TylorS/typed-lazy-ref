import { Effect, Stream, type Context, type Types } from 'effect'
import { hasProperty } from 'effect/Predicate'
import { VersionedImpl, type Versioned } from './Versioned.js'

export const ComputedTypeId = Symbol.for('@typed/LazyRef/Computed')
export type ComputedTypeId = typeof ComputedTypeId

export interface Computed<in out A, out E = never, out R = never> extends Versioned<A, E, R> {
  readonly [ComputedTypeId]: Computed.Variance<A, E, R>
}

export namespace Computed {
  export type Variance<out A, out E, out R> = {
    readonly _A: Types.Covariant<A>
    readonly _E: Types.Covariant<E>
    readonly _R: Types.Covariant<R>
  }

  export type Success<T> = [T] extends [
    { readonly [ComputedTypeId]: Variance<infer A, infer _, infer __> },
  ]
    ? A
    : never
  export type Error<T> = [T] extends [
    { readonly [ComputedTypeId]: Variance<infer _, infer E, infer __> },
  ]
    ? E
    : never
  export type Context<T> = [T] extends [
    { readonly [ComputedTypeId]: Variance<infer _, infer __, infer R> },
  ]
    ? R
    : never
}

/**
 * @internal
 */
export function makeComputed<A, E, R>(
  get: Effect.Effect<A, E, R>,
  changes: Stream.Stream<A, E, R>,
  version: Effect.Effect<number, never, R>,
): Computed<A, E, R> {
  return new ComputedImpl(get, changes, version)
}

/**
 * @internal
 */
export function fromVersioned<A, E, R>(versioned: Versioned<A, E, R>): Computed<A, E, R> {
  return new ComputedImpl(versioned.get, versioned.changes, versioned.version)
}

const variance: Computed.Variance<any, any, any> = {
  _A: (_) => _,
  _E: (_) => _,
  _R: (_) => _,
}

class ComputedImpl<A, E, R> extends VersionedImpl<A, E, R> implements Computed<A, E, R> {
  readonly [ComputedTypeId]: Computed.Variance<A, E, R> = variance
}

export function isComputed<A = unknown, E = unknown, R = unknown>(
  value: unknown,
): value is Computed<A, E, R> {
  return hasProperty(value, ComputedTypeId)
}

export function computedFromTag<Id, S, A, E, R>(
  tag: Context.Tag<Id, S>,
  f: (s: S) => Computed<A, E, R>,
): Computed<A, E, Id | R> {
  return new ComputedImpl(
    Effect.flatMap(tag, f),
    Stream.unwrap(Effect.map(tag, f)),
    Effect.flatMap(tag, (s) => f(s).version),
  )
}
